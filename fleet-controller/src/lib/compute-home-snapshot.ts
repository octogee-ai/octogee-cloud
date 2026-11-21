import { createHash } from "node:crypto";
import type { RetainedUserHome, RetainedUserHomeSnapshot } from "@octogee/shared/types/glm";
import type { ComputeRequest } from "./compute-vm.js";
import {
  assertRetainedHomeDisk,
  assertStoppedHomeOwner,
  VM_HOME_DISK_DEVICE_NAME,
  type HomeInstance,
} from "./compute-home.js";

export interface SnapshotStoppedHomeInput {
  home: RetainedUserHome;
  ownerUid: string;
  instanceName: string;
  instanceId: string;
  snapshotName: string;
}

export interface RestoreHomeFromSnapshotInput {
  snapshot: RetainedUserHomeSnapshot;
  ownerUid: string;
  zone: string;
  diskName: string;
  minimumSizeGb: number;
}

interface Snapshot {
  id?: string;
  name?: string;
  status?: string;
  selfLink?: string;
  diskSizeGb?: string;
  sourceDisk?: string;
  sourceDiskId?: string;
  snapshotType?: string;
  storageLocations?: string[];
  labels?: Record<string, string>;
}

interface Disk {
  id?: string;
  name?: string;
  status?: string;
  type?: string;
  sizeGb?: string;
  labels?: Record<string, string>;
  users?: string[];
  sourceSnapshot?: string;
  sourceSnapshotId?: string;
}

interface RecoverableSnapshot {
  id?: string;
  name?: string;
  originalResource?: Snapshot;
}

interface RecoverableSnapshotPage {
  items?: RecoverableSnapshot[];
  nextPageToken?: string;
}

const COMPUTE_PREFIX = "https://compute.googleapis.com/compute/v1/";
const COMPUTE_BETA_PREFIX = "https://compute.googleapis.com/compute/beta/";
const RESOURCE_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const NUMERIC_ID = /^[1-9]\d{0,19}$/u;
const ZONE = /^[a-z]+(?:-[a-z0-9]+)+\d-[a-z]$/u;

function computePath(url: string | undefined): string | undefined {
  return url?.replace(/^https:\/\/(?:www|compute)\.googleapis\.com\/compute\/(?:v1|beta)\//u, "");
}

function storageLabels(ownerUid: string, storage: string): Record<string, string> {
  if (!/^[A-Za-z0-9_-]{1,63}$/u.test(ownerUid)) throw new Error("Invalid home snapshot owner");
  return { "octogee-owner-uid": ownerUid.toLowerCase(), "octogee-storage": storage };
}

function labelsMatch(labels: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => labels?.[key] === value);
}

function snapshotLabels(ownerUid: string): Record<string, string> {
  const binding = createHash("sha256").update(ownerUid).digest("hex").slice(0, 40);
  return { ...storageLabels(ownerUid, "customer-home-snapshot"), "octogee-owner-binding": binding };
}

function requestId(...identity: string[]): string {
  const hash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function responseStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

function validSize(sizeGb: number): boolean {
  return Number.isSafeInteger(sizeGb) && sizeGb >= 10;
}

function snapshotInSourceRegion(resource: Snapshot, sourceDisk: string): boolean {
  const sourceRegion = sourceDisk.split("/")[3].slice(0, -2);
  return resource.storageLocations?.length === 1 && resource.storageLocations[0] === sourceRegion;
}

function snapshotReceipt(
  resource: Snapshot,
  expected: Omit<RetainedUserHomeSnapshot, "id">,
  snapshotPath: string,
  labels: Record<string, string>,
): RetainedUserHomeSnapshot | null {
  if (resource.name !== expected.name || computePath(resource.selfLink) !== snapshotPath ||
      !NUMERIC_ID.test(resource.id ?? "") || resource.sourceDiskId !== expected.sourceDiskId ||
      computePath(resource.sourceDisk) !== expected.sourceDisk || !labelsMatch(resource.labels, labels) ||
      resource.snapshotType !== "STANDARD" || Number(resource.diskSizeGb) !== expected.sizeGb) {
    throw new Error("Home snapshot identity, source disk or owner differs");
  }
  if (resource.status === "CREATING" || resource.status === "UPLOADING") return null;
  if (resource.status !== "READY") throw new Error(`Home snapshot is not usable (${resource.status ?? "unknown"})`);
  if (!snapshotInSourceRegion(resource, expected.sourceDisk)) throw new Error("Home snapshot is outside the source region");
  return { ...expected, id: resource.id! };
}

function detached(users: Disk["users"]): boolean {
  return users === undefined || (Array.isArray(users) && users.length === 0);
}

function validateRestoreScope(input: RestoreHomeFromSnapshotInput, projectId: string): void {
  const { snapshot, zone, diskName, minimumSizeGb } = input;
  const source = /^projects\/([^/]+)\/zones\/([^/]+)\/disks\/([^/]+)$/u.exec(snapshot.sourceDisk);
  if (snapshot.projectId !== projectId || source?.[1] !== projectId || !ZONE.test(source[2]) ||
      !RESOURCE_NAME.test(source[3]) || !ZONE.test(zone) || !RESOURCE_NAME.test(diskName) ||
      !RESOURCE_NAME.test(snapshot.name) || !NUMERIC_ID.test(snapshot.id) || !NUMERIC_ID.test(snapshot.sourceDiskId) ||
      !validSize(snapshot.sizeGb) || !validSize(minimumSizeGb)) throw new Error("Home restore snapshot identity or target scope is invalid");
}

function restoredHome(
  resource: Disk,
  expected: Omit<RetainedUserHome, "id">,
  snapshot: RetainedUserHomeSnapshot,
  snapshotPath: string,
  labels: Record<string, string>,
): RetainedUserHome | null {
  if (resource.name !== expected.name || !NUMERIC_ID.test(resource.id ?? "") || resource.sourceSnapshotId !== snapshot.id ||
      computePath(resource.sourceSnapshot) !== snapshotPath || resource.type?.split("/").at(-1) !== expected.diskType ||
      Number(resource.sizeGb) !== expected.sizeGb || !labelsMatch(resource.labels, labels) ||
      !detached(resource.users)) {
    throw new Error("Restored home disk identity, snapshot or attachment differs");
  }
  if (resource.status === "CREATING" || resource.status === "RESTORING") return null;
  if (resource.status !== "READY") throw new Error(`Restored home disk is not usable (${resource.status ?? "unknown"})`);
  return { ...expected, id: resource.id! };
}

export function createVmHomeSnapshotClient(deps: {
  request: ComputeRequest;
  projectId: string;
  readInstance: (name: string, zone: string) => Promise<HomeInstance | null>;
  waitForOperation: (zone: string, operation: unknown, what: string) => Promise<void>;
  waitForGlobalOperation: (operation: unknown, what: string) => Promise<void>;
}) {
  const project = `projects/${deps.projectId}`;

  async function read<T>(path: string): Promise<T | null> {
    try {
      const response = await deps.request({ method: "GET", url: `${COMPUTE_PREFIX}${path}` });
      if (response.status === 404) return null;
      if (response.status >= 400 || !response.data) throw new Error(`Read home snapshot resource: HTTP ${response.status}`);
      return response.data as T;
    } catch (error) {
      if (responseStatus(error) === 404) return null;
      throw error;
    }
  }

  async function create(zone: string, path: string, description: string, body: unknown): Promise<boolean> {
    let response: Awaited<ReturnType<ComputeRequest>>;
    try {
      response = await deps.request({ method: "POST", url: `${COMPUTE_PREFIX}${path}`, body });
    } catch (error) {
      if (responseStatus(error) === 409) return false;
      throw error;
    }
    if (response.status === 409) return false;
    if (response.status >= 400 || !response.data) throw new Error(`${description}: HTTP ${response.status}`);
    await deps.waitForOperation(zone, response.data, description);
    return true;
  }

  async function verifyStoppedSource(input: SnapshotStoppedHomeInput): Promise<void> {
    const { home, instanceName, instanceId, ownerUid } = input;
    const instancePath = `${project}/zones/${home.zone}/instances/${instanceName}`;
    const instance = await deps.readInstance(instanceName, home.zone);
    assertStoppedHomeOwner(instance, instanceId, ownerUid, "home snapshot");
    const attachments = instance.disks?.filter(disk => disk.deviceName === VM_HOME_DISK_DEVICE_NAME && disk.boot === false);
    if (attachments?.length !== 1 || attachments[0].autoDelete !== false || computePath(attachments[0].source) !== home.source) {
      throw new Error("Home snapshot source is not the protected VM home");
    }
    const disk = await read<Disk>(home.source);
    if (!disk || disk.name !== home.name || disk.status !== "READY" ||
        Number(disk.sizeGb) !== home.sizeGb || disk.type?.split("/").at(-1) !== home.diskType ||
        !Array.isArray(disk.users) || disk.users.length !== 1 || computePath(disk.users[0]) !== instancePath) {
      throw new Error("Home snapshot source disk identity or attachment differs");
    }
    assertRetainedHomeDisk(disk, home, ownerUid, "snapshot");
  }

  async function snapshotStoppedHome(input: SnapshotStoppedHomeInput): Promise<RetainedUserHomeSnapshot | null> {
    const { home, ownerUid, instanceName, instanceId, snapshotName } = input;
    const labels = snapshotLabels(ownerUid);
    if (home.projectId !== deps.projectId || !ZONE.test(home.zone) || !RESOURCE_NAME.test(home.name) ||
        !RESOURCE_NAME.test(instanceName) || !RESOURCE_NAME.test(snapshotName) || !NUMERIC_ID.test(instanceId) ||
        !NUMERIC_ID.test(home.id) || !validSize(home.sizeGb) || home.source !== `${project}/zones/${home.zone}/disks/${home.name}`) {
      throw new Error("Home snapshot source escaped the configured project or has invalid identity");
    }
    await verifyStoppedSource(input);
    const path = `${project}/global/snapshots/${snapshotName}`;
    const expected = { projectId: deps.projectId, name: snapshotName, sourceDisk: home.source, sourceDiskId: home.id, sizeGb: home.sizeGb };
    let resource = await read<Snapshot>(path);
    if (!resource) {
      const id = requestId("snapshot", path, home.id, instanceId, ownerUid);
      const created = await create(home.zone, `${home.source}/createSnapshot?requestId=${id}`, "Snapshot stopped builder home", {
        name: snapshotName, labels, snapshotType: "STANDARD", storageLocations: [home.zone.slice(0, -2)],
      });
      if (created) return null;
      resource = await read<Snapshot>(path);
      if (!resource) throw new Error("Home snapshot creation conflicted without an identifiable snapshot");
    }
    return snapshotReceipt(resource, expected, path, labels);
  }

  async function restoreHomeFromSnapshot(input: RestoreHomeFromSnapshotInput): Promise<RetainedUserHome | null> {
    const { snapshot, ownerUid, zone, diskName, minimumSizeGb } = input;
    validateRestoreScope(input, deps.projectId);
    const snapshotPath = `${project}/global/snapshots/${snapshot.name}`;
    const source = await read<Snapshot>(snapshotPath);
    if (!source || snapshotReceipt(source, snapshot, snapshotPath, snapshotLabels(ownerUid))?.id !== snapshot.id) {
      throw new Error("Home restore requires the exact READY snapshot");
    }
    const zonePath = `${project}/zones/${zone}`;
    const expected: Omit<RetainedUserHome, "id"> = {
      projectId: deps.projectId, zone, name: diskName, diskType: "pd-balanced",
      sizeGb: Math.max(snapshot.sizeGb, minimumSizeGb), source: `${zonePath}/disks/${diskName}`,
    };
    const labels = storageLabels(ownerUid, "customer-home");
    let disk = await read<Disk>(expected.source);
    if (!disk) {
      const id = requestId("restore", expected.source, snapshot.id, ownerUid, String(expected.sizeGb));
      const created = await create(zone, `${zonePath}/disks?requestId=${id}`, "Restore builder home snapshot", {
        name: diskName, labels, type: `${COMPUTE_PREFIX}${zonePath}/diskTypes/pd-balanced`,
        sizeGb: String(expected.sizeGb), sourceSnapshot: `${COMPUTE_PREFIX}${snapshotPath}`,
      });
      if (created) return null;
      disk = await read<Disk>(expected.source);
      if (!disk) throw new Error("Home restore conflicted without an identifiable disk");
    }
    return restoredHome(disk, expected, snapshot, snapshotPath, labels);
  }

  async function deleteSnapshotResource(url: string, identity: string): Promise<void> {
    const id = requestId("erase", url, identity);
    try {
      const response = await deps.request({ method: "DELETE", url: `${url}?requestId=${id}` });
      if (response.status === 404) return;
      if (response.status >= 400 || !response.data) throw new Error(`Delete home snapshot: HTTP ${response.status}`);
      await deps.waitForGlobalOperation(response.data, "Delete owned home snapshot");
    } catch (error) {
      if (responseStatus(error) !== 404) throw error;
    }
  }

  async function findRecoverableSnapshot(directory: string, snapshot: RetainedUserHomeSnapshot): Promise<RecoverableSnapshot | null> {
    let pageToken: string | undefined;
    const seenTokens = new Set<string>();
    let match: RecoverableSnapshot | null = null;
    do {
      const query = new URLSearchParams({ filter: `originalResource.name = "${snapshot.name}"` });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await deps.request({ method: "GET", url: `${directory}?${query}` });
      if (response.status >= 400 || !response.data) throw new Error(`List recoverable home snapshots: HTTP ${response.status}`);
      const page = response.data as RecoverableSnapshotPage;
      if ((page.items !== undefined && !Array.isArray(page.items)) ||
          (page.nextPageToken !== undefined && (typeof page.nextPageToken !== "string" || seenTokens.has(page.nextPageToken)))) {
        throw new Error("Malformed recoverable home snapshot listing");
      }
      for (const copy of page.items ?? []) {
        if (copy.originalResource?.id !== snapshot.id) continue;
        if (match) throw new Error("Multiple recoverable copies of the exact home snapshot");
        match = copy;
      }
      pageToken = page.nextPageToken;
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return match;
  }

  async function eraseHomeSnapshot(snapshot: RetainedUserHomeSnapshot, ownerUid: string): Promise<boolean> {
    const sourceZone = snapshot.sourceDisk.split("/")[3] ?? "";
    validateRestoreScope({ snapshot, ownerUid, zone: sourceZone, diskName: snapshot.name, minimumSizeGb: snapshot.sizeGb }, deps.projectId);
    const path = `${project}/global/snapshots/${snapshot.name}`;
    const labels = snapshotLabels(ownerUid);
    const resource = await read<Snapshot>(path);
    if (resource) {
      if (snapshotReceipt(resource, snapshot, path, labels)?.id !== snapshot.id) throw new Error("Erase requires the exact READY snapshot");
      await deleteSnapshotResource(`${COMPUTE_PREFIX}${path}`, snapshot.id);
      return false;
    }

    const directory = `${COMPUTE_BETA_PREFIX}${project}/global/recoverableSnapshots`;
    const copy = await findRecoverableSnapshot(directory, snapshot);
    if (!copy) return true;
    const original = copy.originalResource!;
    if (!RESOURCE_NAME.test(copy.name ?? "") || !NUMERIC_ID.test(copy.id ?? "") ||
        original.name !== snapshot.name || original.sourceDiskId !== snapshot.sourceDiskId ||
        computePath(original.sourceDisk) !== snapshot.sourceDisk || !labelsMatch(original.labels, labels) ||
        original.snapshotType !== "STANDARD" || Number(original.diskSizeGb) !== snapshot.sizeGb ||
        !snapshotInSourceRegion(original, snapshot.sourceDisk)) {
      throw new Error("Home recoverable snapshot identity, source disk or owner differs");
    }
    await deleteSnapshotResource(`${directory}/${copy.name}`, copy.id!);
    return false;
  }

  return { snapshotStoppedHome, restoreHomeFromSnapshot, eraseHomeSnapshot };
}
