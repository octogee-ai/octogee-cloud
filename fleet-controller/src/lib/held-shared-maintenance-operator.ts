import { isDeepStrictEqual } from "node:util";
import {
  acquireSharedHeldReturnMaintenance, advanceSharedHeldReturnMaintenance, assertSharedHeldReturnMaintenance, assertSharedHeldReturnMaintenanceReserved,
  completeSharedHeldReturnMaintenance, readSharedHeldReturnMaintenanceDispatch, readSharedHeldReturnMaintenanceTerminal, resumeSharedHeldReturnMaintenance,
  stageSharedHeldReturnMaintenanceRelease, withdrawSharedHeldReturnMaintenance, SharedHeldReturnMaintenanceConflict,
  type HeldNativeReturnSelection, type ObservedSharedMaintenanceHelm, type SharedHeldReturnMaintenanceAdmin,
  type SharedHeldReturnMaintenanceAdmission, type SharedHeldReturnMaintenanceClaim, type SharedHeldReturnMaintenanceDispatch,
  type SharedHeldReturnMaintenanceResult, type SharedHeldReturnMaintenanceWithdrawal,
} from "@octogee/core/fleet-state";
import type { PlatformStateStore } from "@octogee/core/platform-state";

type CheckCurrent = () => Promise<void>;

export interface SharedHeldReturnMaintenancePhysical {
  readVerifiedAdmission(selection: HeldNativeReturnSelection): Promise<SharedHeldReturnMaintenanceAdmission>;
  holdMigrationPolicy(claim: SharedHeldReturnMaintenanceClaim, assertReserved: CheckCurrent): Promise<void>;
  verifyReadyToDispatch(claim: SharedHeldReturnMaintenanceClaim, assertReserved: CheckCurrent): Promise<void>;
  applyStagedRelease(claim: SharedHeldReturnMaintenanceClaim, staged: SharedHeldReturnMaintenanceDispatch, assertCurrent: CheckCurrent): Promise<void>;
  restoreMigrationPolicy(claim: SharedHeldReturnMaintenanceClaim, assertCurrent: CheckCurrent): Promise<void>;
  readVerifiedWithdrawal(claim: SharedHeldReturnMaintenanceClaim): Promise<SharedHeldReturnMaintenanceWithdrawal>;
  readVerifiedResult(claim: SharedHeldReturnMaintenanceClaim): Promise<SharedHeldReturnMaintenanceResult>;
  readInstalledHelm(claim: SharedHeldReturnMaintenanceClaim): Promise<ObservedSharedMaintenanceHelm>;
}

function requireOperator(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SharedHeldReturnMaintenanceConflict(message);
}

export function createSharedHeldReturnMaintenanceOperator(deps: {
  store: PlatformStateStore; physical: SharedHeldReturnMaintenancePhysical; now: () => number;
}): SharedHeldReturnMaintenanceAdmin {
  const { store } = deps;
  const active = new Set<string>();
  return async (actor, command, dryRun) => {
    requireOperator(actor, "Authenticated Shared maintenance operator is required");
    if (command.action === "acquire") {
      return acquireMaintenanceForOperator(deps, actor, command.selection, command.attemptId, dryRun);
    }
    const terminal = await readSharedHeldReturnMaintenanceTerminal(store, { ...command, actor });
    if (terminal) {
      requireOperator(command.action === "status" || dryRun ||
        command.action === "withdraw" && terminal.phase === "withdrawn" ||
        command.action === "complete" && terminal.phase === "completed",
      "Shared maintenance operation is already terminal");
      return { ...terminal, ...(dryRun && { dryRun }) };
    }
    const claim = await resumeSharedHeldReturnMaintenance(store, command.gatewayId, command.attemptId);
    requireOperator(claim.plan.selection.operationId === command.operationId &&
      (await store.journal.audits.get(claim.auditId))?.actor === actor, "Shared maintenance belongs to another operation or operator");
    const status = { gatewayId: claim.gatewayId, attemptId: claim.attemptId, auditId: claim.auditId };
    if (dryRun || command.action === "status") return { ...status, dryRun, phase: await assertSharedHeldReturnMaintenance(store, claim) };
    requireOperator(!active.has(claim.attemptId), "Shared maintenance request is still running");
    active.add(claim.attemptId);
    try {
      return await runMaintenanceStep(deps, claim, command.action);
    } finally {
      active.delete(claim.attemptId);
    }
  };
}

async function runMaintenanceStep(
  deps: { store: PlatformStateStore; physical: SharedHeldReturnMaintenancePhysical; now: () => number },
  claim: SharedHeldReturnMaintenanceClaim, action: "hold-migration-policy" | "dispatch" | "stage" | "apply" | "rollback" | "withdraw" | "complete",
): Promise<unknown> {
  const { store, physical, now } = deps;
  const status = { gatewayId: claim.gatewayId, attemptId: claim.attemptId, auditId: claim.auditId };
  const assertReserved = () => assertSharedHeldReturnMaintenanceReserved(store, claim);
  switch (action) {
    case "hold-migration-policy":
      await assertReserved();
      await physical.holdMigrationPolicy(claim, assertReserved);
      await assertReserved();
      return { ...status, phase: "reserved" };
    case "dispatch":
    case "rollback": {
      const phase = action === "dispatch" ? "dispatched" : "rollback";
      await advanceSharedHeldReturnMaintenance(store, claim, phase, now, () => physical.verifyReadyToDispatch(claim, assertReserved));
      return { ...status, phase };
    }
    case "stage":
      return { ...status, release: await stageSharedHeldReturnMaintenanceRelease(store, claim, now) };
    case "apply":
      return { ...status, ...await applyStagedMaintenance({ store, physical, claim }) };
    case "withdraw":
      await withdrawSharedHeldReturnMaintenance(store, claim, {
        restoreMigrationPolicy: () => physical.restoreMigrationPolicy(claim, async () => {
          requireOperator(await assertSharedHeldReturnMaintenance(store, claim) === "withdrawing", "Shared maintenance withdrawal lost authority");
        }),
        readVerifiedWithdrawal: () => physical.readVerifiedWithdrawal(claim), now,
      });
      return { ...status, phase: "withdrawn" };
    case "complete":
      await completeSharedHeldReturnMaintenance(store, claim, {
        readVerifiedResult: () => physical.readVerifiedResult(claim),
        restoreMigrationPolicy: assertCurrent => physical.restoreMigrationPolicy(claim, assertCurrent),
        readInstalledHelm: () => physical.readInstalledHelm(claim), now,
      });
      return { ...status, phase: "completed" };
  }
}

async function acquireMaintenanceForOperator(
  deps: { store: PlatformStateStore; physical: SharedHeldReturnMaintenancePhysical; now: () => number },
  actor: string, selection: HeldNativeReturnSelection, attemptId: string, dryRun: boolean,
): Promise<unknown> {
  const { store, physical, now } = deps;
  const gatewayId = selection.targetGatewayId;
  const scope = { gatewayId, operationId: selection.operationId, attemptId };
  if (dryRun) return { ...scope, dryRun };
  const terminal = await readSharedHeldReturnMaintenanceTerminal(store, { ...scope, actor });
  if (terminal) return terminal;
  const existing = (await store.gateways.roots.get(gatewayId))?.runtimeRestartFence;
  if (existing?.attemptId === attemptId) {
    const claim = await resumeSharedHeldReturnMaintenance(store, gatewayId, attemptId);
    requireOperator(isDeepStrictEqual(claim.plan.selection, selection) &&
      (await store.journal.audits.get(claim.auditId))?.actor === actor, "Shared maintenance reservation has different authority");
    return { ...scope, auditId: claim.auditId, phase: await assertSharedHeldReturnMaintenance(store, claim) };
  }
  const claim = await acquireSharedHeldReturnMaintenance(store, {
    environment: "test", actor, attemptId, now,
    readVerifiedAdmission: async () => {
      const admission = await physical.readVerifiedAdmission(selection);
      requireOperator(isDeepStrictEqual(admission.selection, selection), "Shared maintenance admission has different scope");
      return admission;
    },
  });
  return { ...scope, auditId: claim.auditId, phase: "reserved" };
}

async function applyStagedMaintenance(deps: {
  store: PlatformStateStore;
  physical: SharedHeldReturnMaintenancePhysical;
  claim: SharedHeldReturnMaintenanceClaim;
}): Promise<SharedHeldReturnMaintenanceDispatch> {
  const { store, physical, claim } = deps;
  const dispatch = await readSharedHeldReturnMaintenanceDispatch(store, claim);
  const assertCurrent = async () => {
    const current = await readSharedHeldReturnMaintenanceDispatch(store, claim);
    requireOperator(current.phase === dispatch.phase && current.release === dispatch.release, "Shared maintenance physical authority changed");
  };
  await physical.applyStagedRelease(claim, dispatch, assertCurrent);
  await assertCurrent();
  return dispatch;
}
