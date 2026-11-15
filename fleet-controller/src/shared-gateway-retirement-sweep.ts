import { isSharedPoolSlotId } from "@octogee/shared/types/shared-gateway-pool";
import {
  FenceMismatchError,
  type GatewayRoot,
  type OperationRecord,
  type PlatformStateStore,
} from "@octogee/core/platform-state";
import { isRetryableUninstallFailure } from "./helm-runner.js";
import { isAgentStoreRetirementSessionDrain } from "./operation-retry.js";
import { isReapedOperationError, REARMED_RETIRE_OPERATION } from "./stuck-op-reaper.js";

export interface SharedGatewayRetirementSweepDeps {
  store: PlatformStateStore;
  log(message: string): void;
}

type RetiredSlotVerdict = "delete" | "rearm" | "skip";

function isClaimingRetirement(root: GatewayRoot | null, operation: OperationRecord | null): boolean {
  return root?.desiredStatus === "retired" && root.gatewayClass === "shared" &&
    root.retirementClaim?.version === operation?.input.retirementClaimVersion &&
    operation?.kind === "retire-gateway";
}

function isRetryableRetirementFailure(error: unknown, gatewayId: string): boolean {
  return isReapedOperationError(error) ||
    (typeof error === "string" && isRetryableUninstallFailure(error)) ||
    isAgentStoreRetirementSessionDrain(error, gatewayId);
}

function retiredSlotVerdict(input: {
  gatewayId: string;
  root: GatewayRoot | null;
  operation: OperationRecord | null;
  runtimeExists: boolean;
  unreferenced: boolean;
}): RetiredSlotVerdict {
  const { root, operation } = input;
  if (!isClaimingRetirement(root, operation)) return "skip";
  if (operation?.status === "failed" && isRetryableRetirementFailure(operation.error, input.gatewayId)) return "rearm";
  return operation?.status === "succeeded" && !input.runtimeExists && input.unreferenced ? "delete" : "skip";
}

export async function sweepRetiredSharedGateways(deps: SharedGatewayRetirementSweepDeps): Promise<void> {
  const roots = await deps.store.gateways.roots.list({ gatewayClass: "shared" });
  for (const candidate of roots) {
    if (candidate.desiredStatus !== "retired" || !isSharedPoolSlotId(candidate.gatewayId)) continue;
    let claimOperationId = "";
    let retirementVersion: number | null = null;
    const verdict = await deps.store.transaction({ label: "shared-pool-scaler.retired-slot" }, async (transaction): Promise<RetiredSlotVerdict> => {
      const root = await transaction.gateways.roots.get(candidate.gatewayId);
      claimOperationId = root?.retirementClaim?.operationId ?? "";
      retirementVersion = root?.retirementVersion ?? null;
      if (claimOperationId.length === 0) return "skip";
      const [operation, runtime, assignmentsEmpty, users] = await Promise.all([
        transaction.journal.operations.get(claimOperationId),
        transaction.fleetRegistry.get(candidate.gatewayId),
        transaction.gateways.assignments.isEmpty(candidate.gatewayId),
        transaction.users.records.listByGateway(candidate.gatewayId, { limit: 1 }),
      ]);
      const slotVerdict = retiredSlotVerdict({
        gatewayId: candidate.gatewayId,
        root,
        operation,
        runtimeExists: runtime !== null,
        unreferenced: assignmentsEmpty && users.length === 0,
      });
      if (slotVerdict === "rearm") {
        await transaction.journal.operations.patch(claimOperationId, REARMED_RETIRE_OPERATION, { status: ["failed"] });
      }
      return slotVerdict;
    });
    if (verdict === "rearm") {
      deps.log(
        `[shared-pool-scaler] re-armed retirement ${claimOperationId} for ${candidate.gatewayId}: it failed retryably (terminating workload or reaped after a controller restart)`,
      );
      continue;
    }
    if (verdict !== "delete") continue;
    try {
      await deps.store.gateways.roots.delete(candidate.gatewayId, { desiredStatus: ["retired"], retirementVersion });
    } catch (error) {
      if (!(error instanceof FenceMismatchError)) throw error;
      deps.log(`[shared-pool-scaler] retired slot ${candidate.gatewayId} changed before deletion; kept for the next sweep`);
      continue;
    }
    deps.log(`[shared-pool-scaler] deleted retired slot ${candidate.gatewayId}; retirement journal retained`);
  }
}
