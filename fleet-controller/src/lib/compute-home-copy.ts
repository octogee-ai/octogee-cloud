import type { ComputeRequest } from "./compute-vm.js";
import { homeCopyStartupScript } from "./home-copy-worker.js";

export interface CopyHomeDisk {
  projectId: string; zone: string; name: string; id: string; sizeGb: number;
  source: string; diskType: "pd-balanced" | "pd-ssd";
}
export interface HomeCopyInput {
  operationId: string;
  ownerUid: string;
  source: CopyHomeDisk;
  sourceLayout: "flat" | "portable";
  targetZone: string;
  desiredGiB: number;
  subnetwork: string;
}
export type HomeCopyProgress = { status: "pending" } | { status: "copying"; usedBytes: number } |
  { status: "ready"; usedBytes: number; filesystem: "btrfs"; proof: Record<string, string> };
export class HomeCopyFailure extends Error {}

export function homeCopyCapacity(input: { desiredGiB: number; sourceGiB: number; usedBytes: number }): number {
  if (![10, 50, 100].includes(input.desiredGiB) || !Number.isSafeInteger(input.sourceGiB) || input.sourceGiB < 10 || !Number.isSafeInteger(input.usedBytes) || input.usedBytes < 0) throw new Error("invalid home copy capacity");
  const needed = Math.ceil((input.usedBytes * 1.1 + 2 * 1024 ** 3) / 1024 ** 3);
  const allocation = needed <= input.desiredGiB ? input.desiredGiB : Math.max(input.sourceGiB, input.desiredGiB);
  if (needed > allocation) throw new Error("home copy needs more space than the retained allocation; source retained");
  return allocation;
}

export function readHomeCopyProgress(serial: string, operationId: string): HomeCopyProgress {
  let progress: HomeCopyProgress = { status: "pending" };
  for (const line of serial.split("\n")) {
    const match = /(?:^|startup-script: |command\("\/bin\/bash"\): )OCTOGEE_HOME_COPY_(PROBE|READY|FAILED):(.*)$/u.exec(line.trim());
    if (!match) continue;
    const data = JSON.parse(match[2]);
    if (data.operationId !== operationId) continue;
    if (match[1] === "FAILED") throw new HomeCopyFailure(`home copy failed: ${String(data.error)}`);
    if (!Number.isSafeInteger(data.usedBytes) || data.usedBytes < 0) throw new Error("invalid home copy usage proof");
    if (match[1] === "PROBE") { progress = { status: "copying", usedBytes: data.usedBytes }; continue; }
    if (data.filesystem !== "btrfs" || !data.proof || !["volumes/data", "desktop-home"].every(key => typeof data.proof[key] === "string" && /^[a-f0-9]{64}$/u.test(data.proof[key]))) throw new Error("invalid home copy verification proof");
    progress = { status: "ready", usedBytes: data.usedBytes, filesystem: data.filesystem, proof: data.proof };
  }
  return progress;
}

interface ComputeResource {
  id?: string; name?: string; status?: string; selfLink?: string; sizeGb?: string;
  sourceDiskId?: string; sourceSnapshotId?: string;
  labels?: Record<string, string>; users?: string[];
  metadata?: { items?: Array<{ key: string; value: string }> };
  disks?: Array<{ boot?: boolean; source?: string; deviceName?: string; autoDelete?: boolean }>;
}

interface HomeCopyDeps {
  request: ComputeRequest;
  projectId: string;
  journal: <T>(what: string, input: HomeCopyInput, action: () => Promise<T>) => Promise<T>;
}
class HomeCopyClient {
  constructor(private readonly deps: HomeCopyDeps) {}
  private get base() { return `https://compute.googleapis.com/compute/v1/projects/${this.deps.projectId}`; }
  async read(url: string): Promise<ComputeResource | null> {
    try {
      const result = await this.deps.request({ url, method: "GET" });
      if (result.status === 404) return null;
      if (result.status >= 400) throw new Error(`home copy inventory HTTP ${result.status}`);
      return result.data as ComputeResource;
    } catch (error) {
      if ((error as { response?: { status?: number } }).response?.status === 404) return null;
      throw error;
    }
  }
  labels(input: HomeCopyInput) { return ({ "octogee-owner-uid": input.ownerUid.toLowerCase(), "octogee-operation": input.operationId, purpose: "octogee-home-copy" }); }
  verify(resource: ComputeResource, input: HomeCopyInput): void {
    if (!/^\d+$/u.test(resource.id ?? "") || Object.entries(this.labels(input)).some(([key, value]) => resource.labels?.[key] !== value)) throw new Error("home copy resource identity or owner differs");
  }
  async mutate(what: string, input: HomeCopyInput, url: string, body?: unknown, method: "POST" | "DELETE" = "POST"): Promise<void> {
    await this.deps.journal(what, input, async () => {
      const result = await this.deps.request({ url, method, ...(body === undefined ? {} : { body }) });
      if (result.status >= 400) throw new Error(`${what}: HTTP ${result.status}`);
    });
  }
  validate(input: HomeCopyInput): void {
    if (input.source.projectId !== this.deps.projectId || !/^[a-z][a-z0-9-]{0,62}$/u.test(input.targetZone) || input.targetZone.slice(0, -2) !== input.source.zone.slice(0, -2) || !/^[a-z][a-z0-9-]{0,47}$/u.test(input.operationId) || !/^[a-z][a-z0-9-]{0,62}$/u.test(input.source.zone) || !/^[a-z][a-z0-9-]{0,62}$/u.test(input.source.name) ||
      input.source.source !== `projects/${this.deps.projectId}/zones/${input.source.zone}/disks/${input.source.name}` || !/^\d+$/u.test(input.source.id)) throw new Error("home copy source escaped configured scope");
    homeCopyCapacity({ desiredGiB: input.desiredGiB, sourceGiB: input.source.sizeGb, usedBytes: 0 });
  }
  async snapshot(input: HomeCopyInput): Promise<ComputeResource | null> {
    const sourceUrl = `${this.base}/zones/${input.source.zone}/disks/${input.source.name}`;
    const source = await this.read(sourceUrl);
    if (!source || source.id !== input.source.id) throw new Error("home copy source disk changed");
    const snapshotName = `${input.operationId}-source`;
    const snapshotUrl = `${this.base}/global/snapshots/${snapshotName}`;
    const snapshot = await this.read(snapshotUrl);
    if (!snapshot) {
      await this.mutate("snapshot-builder-home", input, `${sourceUrl}/createSnapshot`, { name: snapshotName, labels: this.labels(input) });
      return null;
    }
    this.verify(snapshot, input);
    if (snapshot.sourceDiskId !== input.source.id) throw new Error("home copy snapshot belongs to another disk");
    if (snapshot.status !== "READY") return null;
    return snapshot;
  }
  async clone(input: HomeCopyInput, snapshot: ComputeResource): Promise<ComputeResource | null> {
    const zone = `${this.base}/zones/${input.targetZone}`;
    const cloneName = `${input.operationId}-source`;
    const clone = await this.read(`${zone}/disks/${cloneName}`);
    if (!clone) {
      await this.mutate("clone-builder-home-snapshot", input, `${zone}/disks`, { name: cloneName, sourceSnapshot: snapshot.selfLink, type: `${zone}/diskTypes/pd-balanced`, labels: this.labels(input) });
      return null;
    }
    this.verify(clone, input);
    if (clone.sourceSnapshotId !== snapshot.id) throw new Error("home copy source clone changed");
    if (clone.status !== "READY") return null;
    return clone;
  }
  async helper(input: HomeCopyInput, clone: ComputeResource): Promise<ComputeResource | null> {
    const zone = `${this.base}/zones/${input.targetZone}`;
    const helperUrl = `${zone}/instances/${input.operationId}`;
    const helper = await this.read(helperUrl);
    const startup = homeCopyStartupScript(input);
    if (!helper) {
      const image = await this.read("https://compute.googleapis.com/compute/v1/projects/debian-cloud/global/images/family/debian-12");
      if (!image?.selfLink || !image.id) throw new Error("home copy helper image is unavailable");
      await this.mutate("start-builder-home-copy", input, `${zone}/instances`, {
        name: input.operationId, machineType: `${zone}/machineTypes/e2-standard-2`, labels: this.labels(input),
        networkInterfaces: [{ subnetwork: input.subnetwork }], serviceAccounts: [],
        scheduling: { provisioningModel: "STANDARD", automaticRestart: false, maxRunDuration: { seconds: "3600" }, instanceTerminationAction: "STOP" },
        metadata: { items: [{ key: "startup-script", value: startup }, { key: "block-project-ssh-keys", value: "true" }, { key: "enable-oslogin", value: "true" }] },
        disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage: image.selfLink, diskSizeGb: "10", diskType: `${zone}/diskTypes/pd-balanced` } },
          { source: clone.selfLink, deviceName: "octogee-source", mode: "READ_WRITE", autoDelete: false }],
      });
      return null;
    }
    this.verify(helper, input);
    if (helper.disks?.find(disk => disk.deviceName === "octogee-source")?.source !== clone.selfLink) throw new Error("home copy helper configuration changed");
    if (helper.metadata?.items?.find(item => item.key === "startup-script")?.value !== startup) throw new HomeCopyFailure("home copy helper runs an outdated worker script; source retained");
    return helper;
  }
  async progress(input: HomeCopyInput, helper: ComputeResource): Promise<HomeCopyProgress> {
    const helperUrl = `${this.base}/zones/${input.targetZone}/instances/${input.operationId}`;
    if (["PROVISIONING", "STAGING"].includes(helper.status ?? "")) return { status: "pending" };
    const serial = await this.deps.request({ url: `${helperUrl}/serialPort?port=1`, method: "GET" });
    if (serial.status >= 400) throw new Error("home copy serial output unavailable");
    const progress = readHomeCopyProgress((serial.data as { contents?: string }).contents ?? "", input.operationId);
    if (progress.status !== "ready" && ["STOPPED", "TERMINATED"].includes(helper.status ?? "")) throw new HomeCopyFailure("home copy helper stopped before verification; source retained");
    return progress;
  }
  async readTarget(input: HomeCopyInput): Promise<CopyHomeDisk | null> {
    const name = `${input.operationId}-home`;
    const target = await this.read(`${this.base}/zones/${input.targetZone}/disks/${name}`);
    if (!target) return null;
    this.verify(target, input);
    if (target.labels?.["octogee-storage"] !== "customer-home") throw new Error("home copy target ownership differs");
    return { projectId: this.deps.projectId, zone: input.targetZone, name, id: target.id!, sizeGb: Number(target.sizeGb), diskType: "pd-balanced", source: `projects/${this.deps.projectId}/zones/${input.targetZone}/disks/${name}` };
  }
  async ensureTarget(input: HomeCopyInput, sizeGb: number): Promise<CopyHomeDisk | null> {
    const target = await this.readTarget(input);
    if (target) return target;
    const zone = `${this.base}/zones/${input.targetZone}`;
    await this.mutate("create-builder-home-target", input, `${zone}/disks`, { name: `${input.operationId}-home`, sizeGb: String(sizeGb), type: `${zone}/diskTypes/pd-balanced`, labels: { ...this.labels(input), "octogee-storage": "customer-home" } });
    return null;
  }
  async target(input: HomeCopyInput, helper: ComputeResource, progress: Exclude<HomeCopyProgress, { status: "pending" }>): Promise<{ progress: HomeCopyProgress; target?: CopyHomeDisk }> {
    const helperUrl = `${this.base}/zones/${input.targetZone}/instances/${input.operationId}`;
    const sizeGb = homeCopyCapacity({ desiredGiB: input.desiredGiB, sourceGiB: input.source.sizeGb, usedBytes: progress.usedBytes });
    const target = await this.ensureTarget(input, sizeGb);
    if (!target) return { progress: { status: "copying", usedBytes: progress.usedBytes } };
    const observed = await this.read(`https://compute.googleapis.com/compute/v1/${target.source}`);
    if (!observed || observed.id !== target.id || target.sizeGb !== sizeGb || Number(observed.sizeGb) !== sizeGb) throw new Error("home copy target identity/capacity differs");
    if (observed.status !== "READY") return { progress: { status: "copying", usedBytes: progress.usedBytes } };
    const attached = helper.disks?.find(disk => disk.deviceName === "octogee-target");
    if (!attached) {
      if (observed.users?.length) throw new Error("home copy target is attached elsewhere");
      await this.mutate("attach-builder-home-target", input, `${helperUrl}/attachDisk`, { source: target.source, deviceName: "octogee-target", mode: "READ_WRITE", autoDelete: false });
      return { progress: { status: "copying", usedBytes: progress.usedBytes } };
    }
    if (relativeComputeSource(attached.source) !== target.source || attached.autoDelete !== false) throw new Error("home copy target attachment differs");
    return { progress, target };
  }
  async advance(input: HomeCopyInput): Promise<{ progress: HomeCopyProgress; target?: CopyHomeDisk }> {
    this.validate(input);
    const snapshot = await this.snapshot(input);
    if (!snapshot) return { progress: { status: "pending" } };
    const clone = await this.clone(input, snapshot);
    if (!clone) return { progress: { status: "pending" } };
    const helper = await this.helper(input, clone);
    if (!helper) return { progress: { status: "pending" } };
    const progress = await this.progress(input, helper);
    return progress.status === "pending" ? { progress } : this.target(input, helper, progress);
  }
  async assertHelperDisks(resource: ComputeResource, input: HomeCopyInput): Promise<void> {
    const boot = resource.disks?.filter(disk => disk.boot) ?? [];
    if (boot.length !== 1 || boot[0].autoDelete !== true) throw new Error("home copy helper boot attachment changed");
    for (const disk of resource.disks ?? []) {
      if (disk.boot) continue;
      let expected: string | undefined;
      if (disk.deviceName === "octogee-source") expected = `projects/${this.deps.projectId}/zones/${input.targetZone}/disks/${input.operationId}-source`;
      if (disk.deviceName === "octogee-target") expected = (await this.readTarget(input))?.source;
      if (!expected || disk.autoDelete !== false || relativeComputeSource(disk.source) !== expected) throw new Error("home copy helper storage attachment changed");
    }
  }
  async cleanup(input: HomeCopyInput): Promise<boolean> {
    this.validate(input);
    const zone = `${this.base}/zones/${input.targetZone}`;
    for (const [suffix, what] of [[`/instances/${input.operationId}`, "remove-home-copy-helper"], [`/disks/${input.operationId}-source`, "remove-home-copy-clone"]]) {
      const resource = await this.read(zone + suffix);
      if (!resource) continue;
      this.verify(resource, input);
      if (suffix.startsWith("/instances/")) {
        await this.assertHelperDisks(resource, input);
      } else if (resource.users?.length) throw new Error("home copy clone remains attached");
      await this.mutate(what, input, zone + suffix, undefined, "DELETE");
      return false;
    }
    const snapshotUrl = `${this.base}/global/snapshots/${input.operationId}-source`;
    const snapshot = await this.read(snapshotUrl);
    if (snapshot) { this.verify(snapshot, input); await this.mutate("remove-home-copy-snapshot", input, snapshotUrl, undefined, "DELETE"); return false; }
    return true;
  }
  async release(input: HomeCopyInput): Promise<boolean> {
    if (!await this.cleanup(input)) return false;
    const target = await this.readTarget(input);
    const observed = target && await this.read(`https://compute.googleapis.com/compute/v1/${target.source}`);
    if (!target || !observed || observed.id !== target.id || observed.users?.length) throw new Error("verified home target is not detached or identity changed");
    return true;
  }
  async abort(input: HomeCopyInput): Promise<boolean> {
    if (!await this.cleanup(input)) return false;
    const target = await this.readTarget(input);
    if (!target) return true;
    const url = `https://compute.googleapis.com/compute/v1/${target.source}`;
    const observed = await this.read(url);
    if (!observed || observed.id !== target.id || observed.users?.length) throw new Error("unadopted home copy identity changed or is attached elsewhere");
    await this.mutate("remove-unadopted-home-copy", input, url, undefined, "DELETE");
    return false;
  }

}

function relativeComputeSource(source?: string): string | undefined {
  return source?.replace(/^https:\/\/(?:www|compute)\.googleapis\.com\/compute\/v1\//u, "");
}

export function createHomeCopyClient(deps: HomeCopyDeps) {
  const client = new HomeCopyClient(deps);
  return { advance: client.advance.bind(client), release: client.release.bind(client), abort: client.abort.bind(client), sweep: client.cleanup.bind(client) };
}
