import { isDeepStrictEqual } from "node:util";
import type { NativeReturnBackupScope } from "./held-native-return-backup.js";

interface GceBoot {
  projectId: string;
  zone: string;
  instanceName: string;
  instanceId: string;
  bootDiskId: string;
}

interface OfflineNativeReturnCustody {
  scope: NativeReturnBackupScope;
  original: GceBoot & { homeDiskId: string };
  maintenance: GceBoot & { imageId: string; serviceAccountEmail: string; readOnlyCloneDiskId: string };
  immutableHomeSnapshotId: string;
}

interface OfflineVmObservation extends GceBoot {
  status: string;
  lastStoppedAt: number | null;
  bootImageId: string;
  publicAccess: boolean;
  serviceAccounts: string[];
  attachedDisks: { id: string; mode: "READ_ONLY" | "READ_WRITE" }[];
}

interface OfflineDiskObservation {
  id: string;
  projectId: string;
  users: string[];
  sourceSnapshotId: string | null;
}

interface OfflineSnapshotObservation {
  id: string;
  projectId: string;
  sourceDiskId: string;
  createdAt: number;
  status: string;
}

type ReadOfflineReturnCompute = {
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

export async function assertHeldNativeOfflineCustody(input: {
  expected: OfflineNativeReturnCustody;
  compute: ReadOfflineReturnCompute;
  assertCanonicalSourceAndDestinationHold(scope: NativeReturnBackupScope): Promise<void>;
  assertOwnerStoreBarrier(scope: NativeReturnBackupScope): Promise<void>;
}) {
  const { expected: { scope, original, maintenance, immutableHomeSnapshotId }, compute } = input;
  if (original.instanceId === maintenance.instanceId || original.bootDiskId === maintenance.bootDiskId ||
      original.homeDiskId === maintenance.readOnlyCloneDiskId || original.projectId !== maintenance.projectId) {
    throw new Error("Held Native offline recovery requires distinct maintenance compute and a copied home");
  }
  await input.assertCanonicalSourceAndDestinationHold(scope);
  await input.assertOwnerStoreBarrier(scope);
  const [source, worker, originalDisk, clone, snapshot] = await Promise.all([
    compute.instance(original), compute.instance(maintenance),
    compute.disk(original.projectId, original.zone, original.homeDiskId),
    compute.disk(maintenance.projectId, maintenance.zone, maintenance.readOnlyCloneDiskId),
    compute.snapshot(original.projectId, immutableHomeSnapshotId),
  ]);
  if (!exactBoot(source, original) || source.status !== "TERMINATED" ||
      !source.attachedDisks.some(disk => disk.id === original.homeDiskId) ||
      !expectedDisk(originalDisk, original.homeDiskId, original)) {
    throw new Error("Held Native offline recovery lost the stopped original and original-home custody");
  }
  if (!exactBoot(worker, maintenance) || worker.status !== "RUNNING" || worker.publicAccess ||
      worker.bootImageId !== maintenance.imageId ||
      !isDeepStrictEqual(worker.serviceAccounts, maintenance.serviceAccountEmail ? [maintenance.serviceAccountEmail] : []) ||
      worker.attachedDisks.some(disk => disk.id === original.homeDiskId || disk.id === original.bootDiskId) ||
      !worker.attachedDisks.some(disk => disk.id === maintenance.readOnlyCloneDiskId && disk.mode === "READ_ONLY") ||
      !expectedDisk(clone, maintenance.readOnlyCloneDiskId, maintenance) || clone.sourceSnapshotId !== immutableHomeSnapshotId) {
    throw new Error("Held Native offline recovery lost the isolated maintenance boot or immutable clone");
  }
  if (!snapshot || snapshot.status !== "READY" || snapshot.id !== immutableHomeSnapshotId || snapshot.projectId !== original.projectId ||
      snapshot.sourceDiskId !== original.homeDiskId || source.lastStoppedAt === null || !Number.isSafeInteger(snapshot.createdAt) ||
      snapshot.createdAt < source.lastStoppedAt) {
    throw new Error("Held Native offline recovery snapshot is not from the exact original home");
  }
  await input.assertOwnerStoreBarrier(scope);
  await input.assertCanonicalSourceAndDestinationHold(scope);
}
