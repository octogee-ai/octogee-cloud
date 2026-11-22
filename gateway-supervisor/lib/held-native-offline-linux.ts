import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const deviceName = /^\/dev\/disk\/by-id\/google-[a-z0-9-]+$/;
const deviceId = /^\d+:\d+$/;
const gcpInstanceId = /^[1-9]\d*$/;
const metadataUrl = "http://169.254.169.254/computeMetadata/v1/instance/id";

interface MountIdentity {
  target: string;
  source: string;
  options: string;
  "maj:min": string;
  children?: unknown[];
}

export function readEligibleOfflineMount(value: unknown, expectedTarget: string): MountIdentity {
  const rows = (value as { filesystems?: MountIdentity[] } | null)?.filesystems;
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Held Native clone mount is ambiguous");
  const mount = rows[0]!;
  if (mount.target !== expectedTarget || typeof mount.source !== "string" || !mount.source.startsWith("/dev/") ||
      typeof mount.options !== "string" || !deviceId.test(mount["maj:min"]) || mount.children?.length) {
    throw new Error("Held Native clone mount is not the exact enrolled volume");
  }
  const flags = new Set(mount.options.split(","));
  if (!["ro", "nosuid", "nodev", "noexec"].every(flag => flags.has(flag)) ||
      !(flags.has("norecovery") || flags.has("noload"))) {
    throw new Error("Held Native clone is not mounted read-only without journal replay");
  }
  return mount;
}

export function assertOfflineListenSockets(contents: string): void {
  for (const line of contents.trim().split("\n").slice(1)) {
    const [, local, , state] = line.trim().split(/\s+/);
    if (state !== "0A") continue;
    const [address, port] = (local ?? "").split(":");
    const loopbackDns = port === "0035" && (address?.endsWith("7F") && address.length === 8 ||
      address === "00000000000000000000000001000000");
    if (port !== "0016" && !loopbackDns) throw new Error("Held Native maintenance has an unexpected TCP listener");
  }
}

async function readInstanceId() {
  const response = await fetch(metadataUrl, { method: "GET", headers: { "metadata-flavor": "Google" },
    redirect: "error", signal: AbortSignal.timeout(2500) });
  if (!response.ok || response.headers.get("metadata-flavor") !== "Google") {
    throw new Error("Held Native maintenance could not identify its GCE instance");
  }
  const id = (await response.text()).trim();
  if (!gcpInstanceId.test(id)) throw new Error("Held Native maintenance instance identity is malformed");
  return id;
}

export function createOfflineLinuxWitness(config: {
  cloneRoot: string; cloneDevice: string; instanceId: string; bootId: string;
}) {
  if (!deviceName.test(config.cloneDevice)) throw new Error("Invalid enrolled Held Native clone device");
  return {
    async assertReadOnlyOriginal() {
      const { stdout } = await exec("/usr/bin/findmnt", ["--json", "--submounts", "--mountpoint", config.cloneRoot,
        "--output", "TARGET,SOURCE,OPTIONS,MAJ:MIN"], { timeout: 2500, maxBuffer: 16 * 1024 });
      const mount = readEligibleOfflineMount(JSON.parse(stdout), config.cloneRoot);
      const [source, configured, readOnly] = await Promise.all([
        realpath(mount.source), realpath(config.cloneDevice),
        readFile(`/sys/dev/block/${mount["maj:min"]}/ro`, "utf8"),
      ]);
      if (source !== configured || !(await stat(source)).isBlockDevice() || readOnly.trim() !== "1") {
        throw new Error("Held Native clone block device no longer matches the read-only enrollment");
      }
    },
    async assertIsolatedRuntime() {
      const [bootId, instanceId, tcp, tcp6] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readInstanceId(),
        readFile("/proc/net/tcp", "utf8"),
        readFile("/proc/net/tcp6", "utf8"),
      ]);
      if (bootId.trim() !== config.bootId || instanceId !== config.instanceId) {
        throw new Error("Held Native maintenance VM or kernel boot differs from enrollment");
      }
      assertOfflineListenSockets(tcp);
      assertOfflineListenSockets(tcp6);
    },
  };
}
