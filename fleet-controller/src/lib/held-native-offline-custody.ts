import { isDeepStrictEqual } from "node:util";
import type { NativeReturnBackupScope, NativeReturnOwnerHold } from "./held-native-return-backup.js";

export interface GceBoot {
  projectId: string;
  zone: string;
  instanceName: string;
  instanceId: string;
  bootDiskId: string;
}

export interface OfflineNativeReturnCustody {
  scope: NativeReturnBackupScope;
  original: GceBoot & { homeDiskId: string };
  maintenance: GceBoot & { imageId: string; bootId: string; lastStartedAt: number; serviceAccountEmail: string | null; readOnlyCloneDiskId: string };
  immutableHomeSnapshotId: string;
}

export interface OfflineVmObservation extends GceBoot {
  status: string;
  lastStoppedAt: number | null;
  lastStartedAt: number | null;
  bootImageId: string;
  publicAccess: boolean;
  serviceAccounts: string[];
  attachedDisks: { id: string; mode: "READ_ONLY" | "READ_WRITE" }[];
}

export interface OfflineDiskObservation {
  id: string;
  projectId: string;
  users: string[];
  sourceSnapshotId: string | null;
}

export interface OfflineSnapshotObservation {
  id: string;
  projectId: string;
  sourceDiskId: string;
  createdAt: number;
  status: string;
}

export type ReadOfflineReturnCompute = {
  instance(expected: GceBoot): Promise<OfflineVmObservation | null>;
  disk(projectId: string, zone: string, id: string): Promise<OfflineDiskObservation | null>;
  snapshot(projectId: string, id: string): Promise<OfflineSnapshotObservation | null>;
};

function exactBoot(vm: OfflineVmObservation | null, expected: GceBoot): vm is OfflineVmObservation {
  return Boolean(vm && vm.projectId === expected.projectId && vm.zone === expected.zone &&
    vm.instanceName === expected.instanceName && vm.instanceId === expected.instanceId && vm.bootDiskId === expected.bootDiskId);
}

function instanceResource(vm: GceBoot): string {
  return `projects/${vm.projectId}/zones/${vm.zone}/instances/${vm.instanceName}`;
}

function expectedDisk(
  disk: OfflineDiskObservation | null, id: string, vm: GceBoot,
): disk is OfflineDiskObservation {
  return Boolean(disk && disk.id === id && disk.projectId === vm.projectId &&
    isDeepStrictEqual(disk.users, [instanceResource(vm)]));
}

function verifyStoppedOriginal(
  source: OfflineVmObservation | null,
  disks: { originalHome: OfflineDiskObservation | null; originalBoot: OfflineDiskObservation | null },
  original: OfflineNativeReturnCustody["original"],
): asserts source is OfflineVmObservation {
  if (!exactBoot(source, original) || source.status !== "TERMINATED" ||
      !source.attachedDisks.some(disk => disk.id === original.homeDiskId) ||
      !expectedDisk(disks.originalHome, original.homeDiskId, original) ||
      !expectedDisk(disks.originalBoot, original.bootDiskId, original)) {
    throw new Error("Held Native offline recovery lost the stopped original and original-home custody");
  }
}

function verifyIsolatedMaintenance(
  worker: OfflineVmObservation | null, clone: OfflineDiskObservation | null, expected: OfflineNativeReturnCustody,
) {
  const { maintenance, immutableHomeSnapshotId } = expected;
  const validStartedBoot = Number.isSafeInteger(maintenance.lastStartedAt) && maintenance.lastStartedAt > 0 &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(maintenance.bootId);
  if (!validStartedBoot || !exactBoot(worker, maintenance) || worker.status !== "RUNNING" || worker.publicAccess ||
      worker.bootImageId !== maintenance.imageId || worker.lastStartedAt !== maintenance.lastStartedAt ||
      !isDeepStrictEqual(worker.serviceAccounts, maintenance.serviceAccountEmail ? [maintenance.serviceAccountEmail] : [])) {
    throw new Error("Held Native offline recovery lost the isolated maintenance boot or immutable clone");
  }
  const requiredDisks = [{ id: maintenance.bootDiskId, mode: "READ_WRITE" }, { id: maintenance.readOnlyCloneDiskId, mode: "READ_ONLY" }];
  const byId = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
  if (!isDeepStrictEqual([...worker.attachedDisks].sort(byId), requiredDisks.sort(byId)) ||
      !expectedDisk(clone, maintenance.readOnlyCloneDiskId, maintenance) || clone.sourceSnapshotId !== immutableHomeSnapshotId) {
    throw new Error("Held Native offline recovery lost the isolated maintenance boot or immutable clone");
  }
}

function verifyHomeSnapshot(
  snapshot: OfflineSnapshotObservation | null, source: OfflineVmObservation, expected: OfflineNativeReturnCustody,
) {
  const { original, immutableHomeSnapshotId } = expected;
  if (!snapshot || snapshot.status !== "READY" || snapshot.id !== immutableHomeSnapshotId || snapshot.projectId !== original.projectId ||
      snapshot.sourceDiskId !== original.homeDiskId || source.lastStoppedAt === null || !Number.isSafeInteger(source.lastStoppedAt) ||
      source.lastStoppedAt <= 0 || !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt < source.lastStoppedAt) {
    throw new Error("Held Native offline recovery snapshot is not from the exact original home");
  }
}

export async function assertHeldNativeOfflineCustody(input: {
  expected: OfflineNativeReturnCustody;
  compute: ReadOfflineReturnCompute;
  assertCanonicalSourceAndDestinationHold(scope: NativeReturnBackupScope): Promise<void>;
  assertOwnerStoreBarrier(scope: NativeReturnBackupScope): Promise<void>;
  assertMaintenanceNetworkIsolation(expected: OfflineNativeReturnCustody): Promise<void>;
}) {
  const { expected: { scope, original, maintenance, immutableHomeSnapshotId }, compute } = input;
  const diskIds = new Set([original.bootDiskId, original.homeDiskId, maintenance.bootDiskId, maintenance.readOnlyCloneDiskId]);
  if (original.instanceId === maintenance.instanceId || diskIds.size !== 4 || original.projectId !== maintenance.projectId) {
    throw new Error("Held Native offline recovery requires distinct maintenance compute and a copied home");
  }
  await input.assertCanonicalSourceAndDestinationHold(scope);
  await input.assertOwnerStoreBarrier(scope);
  const [source, worker, originalHome, originalBoot, clone, snapshot] = await Promise.all([
    compute.instance(original), compute.instance(maintenance),
    compute.disk(original.projectId, original.zone, original.homeDiskId),
    compute.disk(original.projectId, original.zone, original.bootDiskId),
    compute.disk(maintenance.projectId, maintenance.zone, maintenance.readOnlyCloneDiskId),
    compute.snapshot(original.projectId, immutableHomeSnapshotId),
  ]);
  verifyStoppedOriginal(source, { originalHome, originalBoot }, original);
  verifyIsolatedMaintenance(worker, clone, input.expected);
  verifyHomeSnapshot(snapshot, source, input.expected);
  await input.assertMaintenanceNetworkIsolation(input.expected);
  await input.assertOwnerStoreBarrier(scope);
  await input.assertCanonicalSourceAndDestinationHold(scope);
}

export interface AuthorizedOfflineNativeSourceHold {
  hold: NativeReturnOwnerHold;
  custody: OfflineNativeReturnCustody;
}

export type ReadHeldNativeOfflineSourceHold = (scope: NativeReturnBackupScope) => Promise<NativeReturnOwnerHold | null>;

export function createHeldNativeOfflineSourceHoldReader(input: {
  readAuthorizedHold(scope: NativeReturnBackupScope): Promise<AuthorizedOfflineNativeSourceHold | null>;
  verifyCustody: (arg: Parameters<typeof assertHeldNativeOfflineCustody>[0]["expected"]) => Promise<void>;
}): ReadHeldNativeOfflineSourceHold {
  return async scope => {
    const current = await input.readAuthorizedHold(scope);
    if (!current) return null;
    const { hold, custody } = current;
    if (!isDeepStrictEqual(hold.scope, scope) || !isDeepStrictEqual(custody.scope, scope) ||
        hold.source.vmId !== custody.original.instanceId || hold.source.bootDiskId !== custody.original.bootDiskId ||
        hold.source.homeDiskId !== custody.original.homeDiskId) {
      throw new Error("Held Native offline backup does not bind the original owner and disks");
    }
    await input.verifyCustody(custody);
    if (!isDeepStrictEqual(await input.readAuthorizedHold(scope), current)) {
      throw new Error("Held Native offline authorized hold changed during provider verification");
    }
    return hold;
  };
}
