import {
  assertHeldNativeReturnRepairClaim, completeHeldNativeReturnRepair,
  type HeldNativeReturnAuthority, type HeldNativeReturnSourceProof,
} from "@octogee/core/fleet-state";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { Operation, SchedulerHandoffState } from "@octogee/shared/types/glm";
import type { OperationContext } from "../operation-router.js";

export type ReconcileHeldNativeReturnSource<Backup extends object> = (
  authority: HeldNativeReturnAuthority & { claimStartedAt: number },
  assertCurrent: () => Promise<void>,
  backup: Backup,
) => Promise<HeldNativeReturnSourceProof>;

export type VerifyHeldNativeReturnCustody = (
  authority: HeldNativeReturnAuthority & { claimStartedAt: number },
  assertCurrent: () => Promise<void>,
) => Promise<void>;

export function createHeldNativeReturnWorker<Backup extends object>(deps: {
  store: PlatformStateStore;
  reconcile: ReconcileHeldNativeReturnSource<Backup>;
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
}) {
  return async (op: Operation, ctx: OperationContext): Promise<SchedulerHandoffState> => {
    const handoff = op.schedulerHandoff;
    const checkpoint = handoff?.forwardRecovery;
    const marker = checkpoint?.sourceReconcile;
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
      await assertHeldNativeReturnRepairClaim(deps.store, claim);
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
    return completeHeldNativeReturnRepair(deps.store, claim, proof, deps.now());
  };
}
