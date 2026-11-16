import type { AdminPlacementCapabilities } from "@octogee/core/admin-placement-router";
import { isAgentStoreRetirementSessionDrain } from "./operation-retry.js";
import { schedulerHandoffAwaitingRelease } from "./scheduler-handoff-release.js";
import { isReapedOperationError, REARMED_RETIRE_OPERATION } from "./stuck-op-reaper.js";

export const adminPlacementCapabilities: Omit<AdminPlacementCapabilities, "gatewayGitKeys"> = {
  retirementFailedRetryably: (operation, gatewayId) =>
    operation.status === "failed" &&
    (isReapedOperationError(operation.error) || isAgentStoreRetirementSessionDrain(operation.error, gatewayId)),
  schedulerHandoffAwaitingRelease: (operation) => schedulerHandoffAwaitingRelease(operation as unknown as Record<string, unknown>),
  rearmedRetirementPatch: REARMED_RETIRE_OPERATION,
};
