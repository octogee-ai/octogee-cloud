import { assertFailedHomeRestoreReleased } from "@octogee/core/isolated-gateway-lifecycle";
import type { OperationRecord, UserDeletionJob, PlatformStateRepositories, PlatformStateStore, PlatformStateTransaction, UserHomeArchive } from "@octogee/core/platform-state";
import type { GatewayVmClient, GatewayVmDescription } from "./compute-vm.js";

type Restoring = Extract<UserHomeArchive, { phase: "restoring" }>;
type RestoreCleanupCompute = Pick<GatewayVmClient, "describe" | "verifyHomeSnapshot" | "stop" | "readArchiveBootDisk" |
  "deleteRetainingHome" | "deleteRetainedHome" | "archiveDisksAbsent">;

async function readErasingOwner(store: PlatformStateRepositories, uid: string, deletionId?: string) {
  const owner = await store.users.records.get(uid);
  const lifecycle = owner?.accountLifecycle;
  if (!owner || lifecycle?.status !== "erasing" || !lifecycle.deletionId ||
      deletionId !== undefined && lifecycle.deletionId !== deletionId) {
    throw new Error("Interrupted home archive requires the current account erasure authority");
  }
  return { owner, deletionId: lifecycle.deletionId };
}

function isOriginalArchiveJournal(operation: Awaited<ReturnType<PlatformStateRepositories["journal"]["operations"]["get"]>>,
  archive: UserHomeArchive, uid: string): boolean {
  return operation?.origin === "operator" && operation.inputUid === uid && operation.input.action === "archive" &&
    operation.input.expectedInstanceId === archive.instanceId && operation.input.expectedGatewayId === archive.gatewayId;
}

function rearmableArchiveLifecycle(owner: NonNullable<Awaited<ReturnType<PlatformStateRepositories["users"]["records"]["get"]>>>,
  deletionId: string) {
  const lifecycle = owner.accountLifecycle;
  if (!lifecycle || lifecycle.deletionId !== deletionId ||
      (lifecycle.status !== "erasing" && lifecycle.status !== "deletion_scheduled")) {
    throw new Error("Preparing archive no longer holds the requested account erasure");
  }
  return lifecycle;
}

function retainsArchiveFence(owner: NonNullable<Awaited<ReturnType<PlatformStateRepositories["users"]["records"]["get"]>>>,
  archive: UserHomeArchive): boolean {
  const fence = owner.fences.computerRecovery;
  return fence?.operationId === archive.operationId && fence.instanceId === archive.instanceId && fence.gatewayId === archive.gatewayId;
}

async function rearmPreparingArchive(tx: PlatformStateTransaction, uid: string, deletionId: string, markErasing: boolean): Promise<string | null> {
  const owner = await tx.users.records.get(uid);
  const archive = owner?.home.homeArchive;
  if (!owner || (archive?.phase !== "preparing" && archive?.phase !== "snapshot-ready")) return null;
  const lifecycle = rearmableArchiveLifecycle(owner, deletionId);
  const operation = await tx.journal.operations.get(archive.operationId);
  if (!retainsArchiveFence(owner, archive) || !operation || !isOriginalArchiveJournal(operation, archive, uid)) {
    throw new Error("Cannot rearm home archive with changed erasure custody");
  }
  if (operation.status === "failed") await tx.journal.operations.patch(operation.id, {
    status: "pending", startedAt: null, completedAt: null, error: { clear: true }, nextAttemptAt: { clear: true }, expireAt: { clear: true },
  });
  else if (operation.status !== "pending" && operation.status !== "running") throw new Error("Existing archive has an unresolved terminal outcome");
  if (markErasing && lifecycle.status === "deletion_scheduled") await tx.users.records.patch(uid, {
    accountLifecycle: { ...lifecycle, status: "erasing" },
  }, { revision: owner.revision });
  return archive.operationId;
}

export function rearmPreparingHomeArchiveForErasure(
  store: PlatformStateStore, input: { uid: string; deletionId: string },
): Promise<boolean> {
  return store.transaction({ label: "home-archive.rearm-for-erasure" },
    async tx => (await rearmPreparingArchive(tx, input.uid, input.deletionId, true)) !== null);
}

function runnableDeletionJob(job: UserDeletionJob, operation: OperationRecord, now: number): boolean {
  if (operation.kind === "suspend-user") {
    return job.suspensionOperationId === operation.id && ["suspension_pending", "suspending"].includes(job.status);
  }
  return job.erasureOperationId === operation.id && job.status === "hibernating" && now >= job.eraseAfter;
}

export async function rearmArchiveBeforeAccountOperation(
  tx: PlatformStateTransaction, operation: OperationRecord, now = Date.now(),
): Promise<string | null> {
  if (operation.status !== "pending" && operation.status !== "running") return null;
  if (operation.kind !== "suspend-user" && operation.kind !== "erase-user") return null;
  const { uid, deletionId } = operation.input;
  if (typeof uid !== "string" || typeof deletionId !== "string" || operation.inputUid !== uid) return null;
  const job = await tx.jobs.deletions.get(deletionId);
  if (!job || job.uid !== uid || !runnableDeletionJob(job, operation, now)) return null;
  return rearmPreparingArchive(tx, uid, deletionId, operation.kind === "erase-user");
}

async function verifyErasureRestore(store: PlatformStateRepositories, uid: string, deletionId: string, expected: Restoring) {
  const { owner } = await readErasingOwner(store, uid, deletionId);
  const current = owner.home.homeArchive;
  if (current?.phase !== "restoring" || current.operationId !== expected.operationId || current.snapshot.id !== expected.snapshot.id ||
      current.leaseId !== expected.leaseId || current.generation !== expected.generation || current.targetGatewayId !== expected.targetGatewayId ||
      current.restoredDisk?.id !== expected.restoredDisk?.id || owner.fences.computerRecovery !== undefined) {
    throw new Error("Home restore changed while preparing account erasure");
  }
  await assertFailedHomeRestoreReleased(store, { ...current, ownerUid: uid });
  return { owner, archive: current };
}

function verifyRestoreVm(source: GatewayVmDescription, archive: Restoring, uid: string): string {
  if (!source.instanceId || source.name !== archive.targetInstanceName || source.zone !== archive.zone ||
      source.metadata["octogee-owner-uid"] !== uid ||
      (source.gatewayId !== archive.targetGatewayId && source.gatewayId !== archive.previousTargetGatewayId) ||
      (archive.targetInstanceId !== undefined && source.instanceId !== archive.targetInstanceId)) {
    throw new Error("Interrupted restore VM does not match the owner and recorded generation");
  }
  return source.instanceId;
}

async function removeInterruptedRestoreVm(deps: { store: PlatformStateStore; vm: RestoreCleanupCompute },
  uid: string, deletionId: string, archive: Restoring, name: string): Promise<Restoring["eraseRestore"]> {
  const { store, vm } = deps;
  const disk = archive.restoredDisk;
  const source = await vm.describe(name, archive.zone);
  let erase = archive.eraseRestore;
  if (source) {
    if (!disk) throw new Error("Interrupted restore VM has no exact disk receipt");
    const instanceId = verifyRestoreVm(source, archive, uid);
    if (source.status !== "TERMINATED" && source.status !== "STOPPED") {
      await verifyErasureRestore(store, uid, deletionId, archive);
      await vm.stop(name, archive.zone);
      throw new Error("Account erasure is waiting for the exact interrupted restore VM to stop");
    }
    const bootDisk = await vm.readArchiveBootDisk({ home: disk, ownerUid: uid, instanceId, instanceName: name, snapshotName: archive.snapshot.name });
    if (erase && (erase.deletionId !== deletionId || erase.instanceId !== instanceId || erase.bootDisk.id !== bootDisk.id ||
        erase.bootDisk.source !== bootDisk.source)) throw new Error("Interrupted restore cleanup receipts changed");
    if (!erase) {
      erase = { deletionId, instanceId, bootDisk };
      const eraseRestore = erase;
      await store.transaction({ label: "home-archive.pin-interrupted-erasure" }, async tx => {
        const current = await verifyErasureRestore(tx, uid, deletionId, archive);
        await tx.users.records.patch(uid, { home: { homeArchive: { ...current.archive, eraseRestore } } },
          { revision: current.owner.revision });
      });
    }
    await verifyErasureRestore(store, uid, deletionId, archive);
    await vm.deleteRetainingHome(name, archive.zone, uid, disk, instanceId);
    if (await vm.describe(name, archive.zone)) throw new Error("Interrupted restore VM deletion has not converged");
  } else if (archive.vmInsertRequested && !erase) {
    throw new Error("Interrupted restore VM insert is unresolved; snapshot retained for erasure retry");
  }
  return erase;
}

export async function settleInterruptedHomeArchiveForErasure(
  deps: { store: PlatformStateStore; vm: RestoreCleanupCompute }, uid: string,
): Promise<void> {
  const initial = (await deps.store.users.records.get(uid))?.home.homeArchive;
  if (!initial || initial.phase === "archived" || initial.phase === "restored") return;
  const { deletionId } = await readErasingOwner(deps.store, uid);
  if (initial.phase === "preparing" || initial.phase === "snapshot-ready") {
    await rearmPreparingHomeArchiveForErasure(deps.store, { uid, deletionId });
    throw new Error("Account erasure is waiting for the exact parked home archive to finish");
  }
  const { archive } = await verifyErasureRestore(deps.store, uid, deletionId, initial);
  await deps.vm.verifyHomeSnapshot(archive.snapshot, uid);
  const name = archive.targetInstanceName;
  const disk = archive.restoredDisk;
  if (!name || (!disk && archive.diskInsertRequested)) {
    throw new Error("Interrupted restore insert outcome is unresolved; snapshot retained for erasure retry");
  }
  const { store, vm } = deps;
  const erase = await removeInterruptedRestoreVm(deps, uid, deletionId, archive, name);
  if (disk) {
    await verifyErasureRestore(store, uid, deletionId, archive);
    await vm.deleteRetainedHome(disk, uid);
    if (erase && !await vm.archiveDisksAbsent(disk, erase.bootDisk)) throw new Error("Interrupted restore disks still exist");
  }
  await store.transaction({ label: "home-archive.finish-interrupted-erasure" }, async tx => {
    const current = await verifyErasureRestore(tx, uid, deletionId, archive);
    const { operationId, gatewayId, instanceId, snapshot, bootDisk } = current.archive;
    await tx.users.records.patch(uid, { home: { homeArchive: {
      phase: "archived", operationId, gatewayId, instanceId, snapshot, bootDisk,
    } } }, { revision: current.owner.revision });
  });
}
