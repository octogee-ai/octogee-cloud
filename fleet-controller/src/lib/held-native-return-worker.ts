import {
  assertHeldNativeOfflineSourceClaim, assertHeldNativeReturnRepairClaim, completeHeldNativeReturnRepair, recordHeldNativeOfflineStage,
  type HeldNativeReturnAuthority, type HeldNativeReturnSourceProof,
} from "@octogee/core/fleet-state";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { HeldNativeOfflineStageReceipt, Operation, SchedulerHandoffState } from "@octogee/shared/types/glm";
import type { OperationContext } from "../operation-router.js";

export type ReconcileHeldNativeReturnSource<Backup extends object> = (
  authority: HeldNativeReturnAuthority & { claimStartedAt: number },
  assertCurrent: () => Promise<void>,
  backup: Backup,
) => Promise<HeldNativeReturnSourceProof>;

export type VerifyHeldNativeReturnCustody = (
  authority: HeldNativeReturnAuthority,
  assertCurrent: () => Promise<void>,
) => Promise<void>;

type HeldNativeWorkerDeps<Backup extends object, Proof> = {
  store: PlatformStateStore;
  reconcile: (authority: HeldNativeReturnAuthority & { claimStartedAt: number }, assertCurrent: () => Promise<void>, backup: Backup) => Promise<Proof>;
  verifyBackup: (
    authority: HeldNativeReturnAuthority & { claimStartedAt: number },
    assertCurrent: () => Promise<void>,
  ) => Promise<Backup>;
  assertBackupCurrent: (
    backup: Backup,
    authority: HeldNativeReturnAuthority & { claimStartedAt: number },
    assertCurrent: () => Promise<void>,
  ) => Promise<void>;
  verifyDestination: VerifyHeldNativeReturnCustody;
  now: () => number;
};

type Claim = Parameters<typeof assertHeldNativeReturnRepairClaim>[1];

function createHeldNativeWorker<Backup extends object, Proof>(deps: HeldNativeWorkerDeps<Backup, Proof>, policy: {
  offline: boolean;
  assertClaim(store: PlatformStateStore, claim: Claim): Promise<void>;
  complete(store: PlatformStateStore, claim: Claim, proof: Proof, now: number): Promise<SchedulerHandoffState>;
}) {
  return async (op: Operation, ctx: OperationContext): Promise<SchedulerHandoffState> => {
    const handoff = op.schedulerHandoff;
    const checkpoint = handoff?.forwardRecovery;
    const marker = policy.offline ? checkpoint?.offlineSourceRecovery : checkpoint?.sourceReconcile;
    const claimStartedAt = op.startedAt;
    if (!handoff || !checkpoint || !marker || !ctx.assertActiveClaim || typeof claimStartedAt !== "number") {
      throw new Error("Held Native return has no active source reconciliation claim");
    }
    const authority = {
      operationId: op.id, uid: handoff.uid, slug: handoff.slug, sourceGatewayId: handoff.fromGatewayId,
      targetGatewayId: handoff.toGatewayId, schedulerMigrationId: handoff.migrationId,
      sourceEpoch: checkpoint.sourceEpoch, requestId: marker.requestId,
    };
    const claim = { authority, claimStartedAt };
    const scoped = { ...authority, claimStartedAt };
    const assertActiveClaim = ctx.assertActiveClaim;
    const assertCurrent = async () => {
      await assertActiveClaim(true);
      await policy.assertClaim(deps.store, claim);
    };
    await assertCurrent();
    await deps.verifyDestination(scoped, assertCurrent);
    const backup = await deps.verifyBackup(scoped, assertCurrent);
    const assertBackedSource = async () => {
      await assertCurrent();
      await deps.assertBackupCurrent(backup, scoped, assertCurrent);
    };
    await deps.verifyDestination(scoped, assertCurrent);
    await assertBackedSource();
    const proof = await deps.reconcile(scoped, assertBackedSource, backup);
    await deps.verifyDestination(scoped, assertCurrent);
    await assertBackedSource();
    return policy.complete(deps.store, claim, proof, deps.now());
  };
}


export function createHeldNativeReturnWorker<Backup extends object>(deps: HeldNativeWorkerDeps<Backup, HeldNativeReturnSourceProof>) {
  return createHeldNativeWorker(deps, { offline: false, assertClaim: assertHeldNativeReturnRepairClaim, complete: completeHeldNativeReturnRepair });
}

export function createHeldNativeOfflineReturnWorker<Backup extends object>(deps: HeldNativeWorkerDeps<Backup, HeldNativeOfflineStageReceipt>) {
  return createHeldNativeWorker(deps, { offline: true, assertClaim: assertHeldNativeOfflineSourceClaim, complete: recordHeldNativeOfflineStage });
}

export type ReconcileHeldNativeOfflineSource<Backup extends object> = HeldNativeWorkerDeps<Backup, HeldNativeOfflineStageReceipt>["reconcile"];
