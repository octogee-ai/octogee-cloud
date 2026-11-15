import { posix } from "node:path";
import { createHash } from "node:crypto";
import { createContainer, removeContainer, startContainer, waitContainer, DockerEngineError, type DockerEngine } from "./docker-engine.js";

export function scratchVolumeName(vmId: string, name: string): string {
  if (!vmId) throw new Error("missing VM scratch identity");
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(name)) throw new Error("invalid scratch volume name");
  return `octogee-scratch-${createHash("sha256").update(vmId).digest("hex").slice(0, 16)}-${name}`;
}

function assertResponse(status: number, what: string): void {
  if (status < 200 || status >= 300) throw new DockerEngineError(status, `${what}: HTTP ${status}`);
}

async function scratchRoot(engine: DockerEngine, stateRoot: string): Promise<string> {
  const response = await engine.request<{ DockerRootDir?: string }>("GET", "/info");
  assertResponse(response.status, "inspect Docker scratch storage");
  const root = response.body.DockerRootDir;
  if (!root?.startsWith("/") || root === stateRoot || root.startsWith(`${stateRoot}/`) || (root === "/home" || root.startsWith("/home/")) || posix.normalize(root) !== root) {
    throw new Error("Docker scratch storage must be on platform storage outside retained home");
  }
  return root;
}

async function prepareVolume(input: { engine: DockerEngine; name: string; vmId: string; root: string; beforeCreate: () => Promise<void> }): Promise<void> {
  const labels = { "ai.octogee.computer-id": input.vmId, "ai.octogee.storage": "ephemeral" };
  let inspected = await input.engine.request<ScratchVolume>("GET", `/volumes/${input.name}`);
  if (inspected.status === 404) {
    await input.beforeCreate();
    const created = await input.engine.request("POST", "/volumes/create", { Name: input.name, Driver: "local", Labels: labels });
    assertResponse(created.status, "create Docker scratch volume");
    inspected = await input.engine.request<ScratchVolume>("GET", `/volumes/${input.name}`);
  }
  assertResponse(inspected.status, "inspect Docker scratch volume");
  const volume = inspected.body;
  if (volume.Driver !== "local" || volume.Mountpoint !== `${input.root}/volumes/${input.name}/_data`
    || Object.entries(labels).some(([key, value]) => volume.Labels?.[key] !== value) || Object.keys(volume.Options ?? {}).length) {
    throw new Error("scratch volume has unverified owner or backing storage");
  }
}

export async function prepareScratchVolumes(input: {
  engine: DockerEngine; image: string; vmId: string; stateRoot: string; names: string[];
  beforeCreate: () => Promise<void>;
}): Promise<void> {
  if (!input.names.length) return;
  const root = await scratchRoot(input.engine, input.stateRoot);
  const names = input.names.map(name => scratchVolumeName(input.vmId, name));
  for (const name of names) await prepareVolume({ engine: input.engine, name, root, vmId: input.vmId, beforeCreate: input.beforeCreate });
  const helper = `octogee-scratch-permissions-${createHash("sha256").update(input.vmId).digest("hex").slice(0, 16)}`;
  await removeContainer(input.engine, helper);
  try {
    await createContainer(input.engine, helper, { Image: input.image, User: "0:0", NetworkDisabled: true,
      Entrypoint: ["sh", "-ec", names.map((_name, index) => `chown 1000:1000 /scratch-${index}; chmod 0755 /scratch-${index}`).join("; ")],
      HostConfig: { Binds: names.map((name, index) => `${name}:/scratch-${index}`), ReadonlyRootfs: true,
        CapDrop: ["ALL"], CapAdd: ["CHOWN", "FOWNER"], SecurityOpt: ["no-new-privileges"], RestartPolicy: { Name: "no" } } });
    await startContainer(input.engine, helper);
    if (await waitContainer(input.engine, helper) !== 0) throw new Error("Docker scratch permissions did not converge");
  } finally {
    await removeContainer(input.engine, helper);
  }
}

type ScratchVolume = {
  Name?: string;
  Driver?: string;
  Mountpoint?: string;
  Labels?: Record<string, string> | null;
  Options?: Record<string, string> | null;
};
type ContainerMount = { Type: string; Name?: string; Source?: string };

function verifiedScratch(volume: ScratchVolume, root: string): string | null {
  const owner = volume.Labels?.["ai.octogee.computer-id"];
  const match = /^octogee-scratch-[a-f0-9]{16}-([a-z][a-z0-9-]{0,62})$/u.exec(volume.Name ?? "");
  if (!owner || !match || volume.Name !== scratchVolumeName(owner, match[1])
    || volume.Labels?.["ai.octogee.storage"] !== "ephemeral" || volume.Driver !== "local"
    || volume.Mountpoint !== `${root}/volumes/${volume.Name}/_data`
    || Object.keys(volume.Options ?? {}).length) return null;
  return owner;
}

function relatedPath(left: string, right: string): boolean {
  return left === right || left.startsWith(right === "/" ? "/" : `${right}/`) || right.startsWith(left === "/" ? "/" : `${left}/`);
}

async function scratchConsumers(engine: DockerEngine): Promise<ContainerMount[]> {
  const containers = await engine.request<Array<{ Mounts?: ContainerMount[] }>>("GET", "/containers/json?all=true");
  assertResponse(containers.status, "list Docker scratch consumers");
  if (!Array.isArray(containers.body) || containers.body.some(container => !Array.isArray(container.Mounts))) {
    throw new Error("cannot verify complete container mounts for scratch inspection");
  }
  const mounts = containers.body.flatMap(container => container.Mounts!);
  if (mounts.some(mount => !["bind", "volume", "tmpfs"].includes(mount.Type)
    || mount.Type === "volume" && !mount.Name
    || mount.Type !== "tmpfs" && (!mount.Source?.startsWith("/") || posix.normalize(mount.Source) !== mount.Source))) {
    throw new Error("cannot verify complete container mounts for scratch inspection");
  }
  return mounts;
}

export async function inspectInactiveScratchVolumes(input: {
  engine: DockerEngine; vmId: string; stateRoot: string; log: (message: string) => void;
}): Promise<string[]> {
  const root = await scratchRoot(input.engine, input.stateRoot);
  const filters = encodeURIComponent(JSON.stringify({ label: ["ai.octogee.storage=ephemeral"] }));
  const inventory = await input.engine.request<{ Volumes?: ScratchVolume[] | null }>("GET", `/volumes?filters=${filters}`);
  assertResponse(inventory.status, "list disposable Docker scratch");
  const candidates = inventory.body.Volumes ?? [];
  if (!Array.isArray(candidates)) throw new Error("invalid Docker scratch inventory");
  const obsolete: Array<{ volume: ScratchVolume; owner: string }> = [];
  for (const volume of candidates) {
    const owner = verifiedScratch(volume, root);
    if (!owner) { input.log(`[vm-agent] retaining unverified scratch ${volume.Name ?? "unknown"}`); continue; }
    if (owner !== input.vmId) obsolete.push({ volume, owner });
  }
  if (!obsolete.length) return [];
  const mounts = await scratchConsumers(input.engine);
  const retained: string[] = [];
  for (const { volume, owner } of obsolete) {
    if (mounts.some(mount => mount.Name === volume.Name || mount.Source && relatedPath(mount.Source, volume.Mountpoint!))) continue;
    const path = `/volumes/${encodeURIComponent(volume.Name!)}`;
    const inspected = await input.engine.request<ScratchVolume>("GET", path);
    if (inspected.status === 404) continue;
    assertResponse(inspected.status, "recheck disposable Docker scratch");
    if (inspected.body.Name !== volume.Name || verifiedScratch(inspected.body, root) !== owner) {
      input.log(`[vm-agent] retaining unverified scratch ${volume.Name}`);
      continue;
    }
    input.log(`[vm-agent] retaining inactive scratch ${volume.Name}: exclusive writer custody unavailable`);
    retained.push(volume.Name!);
  }
  return retained;
}
