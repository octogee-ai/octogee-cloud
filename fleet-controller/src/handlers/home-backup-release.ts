import { isDeepStrictEqual } from "node:util";
import { planArchiveAfterBackupRelease } from "@octogee/core/admin-fleet-router";
import { RELEASE_RESTORED_HOME_BACKUP, restoredHomeBackupReleaseId } from "@octogee/core/isolated-gateway-lifecycle";
import type { OperationRecord, PlatformStateRepositories, PlatformStateStore, UserHomeArchive } from "@octogee/core/platform-state";
import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import type { Operation } from "@octogee/shared/types/glm";
import type { GatewayVmClient } from "../lib/compute-vm.js";
import type { OperationHandler, OperationResult } from "../operation-router.js";

type Restored = Extract<UserHomeArchive, { phase: "restored" }>;
interface ReleaseIdentity {
  uid: string;
  gatewayId: string;
  archiveOperationId: string;
  activationOperationId: string;
  snapshotId: string;
}

function operationIdentity(operation: Operation): ReleaseIdentity {
  const { action, ownerUid, gatewayId, archiveOperationId, activationOperationId, snapshotId } = operation.input;
  if (operation.kind !== "gateway-vm" || operation.origin !== "automatic" || operation.createdBy !== "glm-controller-placement-policy" ||
      action !== RELEASE_RESTORED_HOME_BACKUP || typeof ownerUid !== "string" || operation.input.uid !== ownerUid ||
      typeof gatewayId !== "string" || typeof archiveOperationId !== "string" ||
      typeof activationOperationId !== "string" || typeof snapshotId !== "string" ||
      operation.id !== restoredHomeBackupReleaseId(archiveOperationId)) {
    throw new Error("Restored home backup release operation identity differs");
  }
  return { uid: ownerUid, gatewayId, archiveOperationId, activationOperationId, snapshotId };
}

async function readRestoredBackup(state: PlatformStateRepositories, identity: ReleaseIdentity) {
  const owner = await state.users.records.get(identity.uid);
  const archive = owner?.home.homeArchive;
  if (!owner || !archive || archive.operationId !== identity.archiveOperationId || owner.accountLifecycle?.status === "erasing") return null;
  if (archive.phase !== "restored" || archive.targetGatewayId !== identity.gatewayId || archive.snapshot.id !== identity.snapshotId ||
      builderActivateOperationId(archive.targetGatewayId, archive.generation) !== identity.activationOperationId ||
      owner.home.homeDisk?.id !== archive.restoredDisk.id || owner.home.homeDisk?.source !== archive.restoredDisk.source) {
    throw new Error("Restored home backup or current disk identity changed");
  }
  return { owner, archive };
}

type ActivationRoute = { uid: string; gatewayId: string; source: string };
function schedulerV2Committed(migration: OperationRecord, where: ActivationRoute): boolean {
  const state = migration.userMigrationV2;
  return state?.phase === "complete" && state.uid === where.uid && state.operationId === migration.id &&
    state.targetGatewayId === where.gatewayId && state.sourceGatewayId === where.source &&
    typeof state.cutoverAt === "number" && typeof state.schedulerStagedAt === "number" && typeof state.sourceRetiredAt === "number";
}

function schedulerCommitted(migration: OperationRecord, where: ActivationRoute): boolean {
  if (migration.output?.scheduleRestoreFailures !== undefined || migration.output?.unreleasedSchedulerFences !== undefined) return false;
  if (migration.userMigrationV2 !== undefined) return schedulerV2Committed(migration, where);
  const handoff = migration.schedulerHandoff;
  return handoff?.scheduleTransfer === true && handoff.stageAfterCutover === true &&
    handoff.uid === where.uid && handoff.toGatewayId === where.gatewayId && handoff.fromGatewayId === where.source &&
    typeof migration.cutoverCommittedAt === "number";
}

function successfulActivation(migration: OperationRecord, where: ActivationRoute): boolean {
  const input = migration.input;
  return migration.kind === "migrate-user" && migration.status === "succeeded" &&
    migration.origin === "automatic" && migration.createdBy === "glm-controller-placement-policy" &&
    migration.inputUid === where.uid && input?.uid === where.uid && input.source === "builder-activation-lease" &&
    input.toGatewayId === where.gatewayId && input.fromGatewayId === where.source;
}

async function committedCutover(state: PlatformStateRepositories, id: ReleaseIdentity, archive: Restored): Promise<number | null> {
  const [receipt, migration] = await Promise.all([
    state.users.placementReceipts.get(id.uid, archive.leaseId, archive.generation, "activated"),
    state.journal.operations.get(id.activationOperationId),
  ]);
  if (!receipt || !migration || migration.status === "pending" || migration.status === "running") return null;
  const source = receipt.sharedGatewayId;
  const where = { uid: id.uid, gatewayId: id.gatewayId, source };
  if (source === null || receipt.gatewayId !== id.gatewayId || receipt.operationId !== migration.id ||
      !successfulActivation(migration, { uid: where.uid, gatewayId: where.gatewayId, source }) || !schedulerCommitted(migration, { uid: where.uid, gatewayId: where.gatewayId, source })) {
    throw new Error("Restored home backup retained because activation did not prove scheduler custody and cutover");
  }
  return (migration.userMigrationV2?.cutoverAt ?? migration.cutoverCommittedAt)!;
}

function retry(error: string): OperationResult {
  return { steps: [], success: false, retryAfterMs: 30_000, error, output: { homeBackupReleasePending: true } };
}

function transientSnapshotError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status !== undefined) return [403, 408, 429].includes(status) || status >= 500;
  return /\bHTTP (403|408|429|5\d\d)\b|ECONNRESET|ETIMEDOUT/u.test(String(error));
}

async function nativeReadyAfterCutover(state: PlatformStateRepositories, archive: Restored, cutoverAt: number): Promise<boolean> {
  const runtime = await state.fleetRegistry.get(archive.targetGatewayId);
  const ready = runtime?.vmBootRecovery;
  return ready?.ready === true && ready.instanceId === archive.restoredInstanceId &&
    typeof ready.observedAt === "number" && ready.observedAt >= cutoverAt;
}

export function createHomeBackupReleaseHandler(deps: {
  store: PlatformStateStore;
  vm: Pick<GatewayVmClient, "eraseHomeSnapshot">;
  archiveGrant?: { ownerUid: string; sizingProfile: string };
}): OperationHandler {
  return async (operation, ctx) => {
    const id = operationIdentity(operation);
    if (!ctx.assertActiveClaim) throw new Error("Restored home backup release requires the active operation claim");
    await ctx.assertActiveClaim();
    const proof = await deps.store.transaction({ label: "builder-home.backup-release-proof" }, async tx => {
      const current = await readRestoredBackup(tx, id);
      if (!current) return { archive: null, ready: false };
      const { archive, owner } = current;
      const pending = owner.fences.pendingNativeSchedulerRetirement;
      if (pending && (pending.homeDiskId !== archive.restoredDisk.id || pending.homeDiskSource !== archive.restoredDisk.source)) {
        return { archive, ready: false };
      }
      if (archive.releaseProvenForActivation === id.activationOperationId) return { archive, ready: true };
      const cutoverAt = await committedCutover(tx, id, archive);
      if (cutoverAt === null || !await nativeReadyAfterCutover(tx, archive, cutoverAt)) return { archive, ready: false };
      const authorized = { ...archive, releaseProvenForActivation: id.activationOperationId };
      await tx.users.records.patch(id.uid, { home: { homeArchive: authorized } }, { revision: owner.revision });
      return { archive: authorized, ready: true };
    });
    if (!proof.archive) return { steps: [], success: true };
    if (!proof.ready) return retry("Restored home backup still awaits committed activation and native readiness");
    await ctx.assertActiveClaim();
    try {
      if (!await deps.vm.eraseHomeSnapshot(proof.archive.snapshot, id.uid)) {
        return {
          steps: [], success: false, waitingForHomeArchiveProvider: true,
          error: "Restored home backup erasure is still converging",
        };
      }
    } catch (error) {
      if (transientSnapshotError(error)) return retry("Restored home backup erasure temporarily failed; snapshot custody retained");
      throw error;
    }
    await ctx.assertActiveClaim();
    await deps.store.transaction({ label: "builder-home.clear-backup-receipt" }, async tx => {
      const current = await readRestoredBackup(tx, id);
      if (!current) return;
      if (!isDeepStrictEqual(current.archive, proof.archive)) throw new Error("Restored home backup custody changed during release");
      const archive = await planArchiveAfterBackupRelease(tx, current.owner, operation.id, deps.archiveGrant, Date.now());
      if (archive) await archive();
      else await tx.users.records.patch(id.uid, { home: { homeArchive: { clear: true } } }, { revision: current.owner.revision });
    });
    return { steps: [], success: true, output: { homeBackupReleased: true } };
  };
}
