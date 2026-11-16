import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { runNormalFleetMutation } from "../normal-fleet-mutation.js";
import { SourceRecoveryPendingError } from "../placement-refusal.js";
export const ISOLATED_GATEWAY_LIFECYCLE_ACTOR = "glm-controller-disposable-gateway";
export const PLACEMENT_AUTOMATION_ACTOR = "glm-controller-placement-policy";
export const ISOLATED_GATEWAY_ALLOCATION_KIND = "disposable-builder";
export const ROLLED_BACK_STATUS = "rolled-back";
export class IsolatedGatewayFenceError extends Error {
    constructor(message) {
        super(message);
        this.name = "IsolatedGatewayFenceError";
    }
}
export function auditedLifecycleMutations(store) {
    return (mutation) => runNormalFleetMutation(store, { ...mutation, action: () => mutation.action() });
}
export const unauditedLifecycleMutations = (mutation) => mutation.action();
export async function checkPlacementOwner(input) {
    await input.store.transaction({ label: "isolated-gateway.owner-check", readOnly: true }, input.requireOwner);
}
export async function assertActivationSourceRecoveryReleased(input, transaction, fence) {
    const operationId = builderActivateOperationId(fence.targetGatewayId, fence.generation);
    const operation = await transaction.journal.operations.get(operationId);
    if (operation === null || !input.sourceRecoveryPending(operation))
        return;
    const recoveringFailedActivation = operation.status === "failed" || operation.input?.recoverSourceOnly === true;
    if (fence.failedActivationCleanup || recoveringFailedActivation)
        throw new SourceRecoveryPendingError(operationId);
}
export const PLACEMENT_RETIREMENT_REASONS = [
    "provisioning-timeout",
    "provisioning-target-paused",
    "builder-authorization-ended",
    "activation-failed",
    "builder-returned",
    "operator-terminated",
    "parked-computer-replaced",
    "owned-gateway-not-kept",
];
export function fieldMap(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
export function readMillis(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (value instanceof Date)
        return value.getTime();
    if (value &&
        typeof value === "object" &&
        typeof value.toMillis === "function") {
        const result = value.toMillis();
        return typeof result === "number" && Number.isFinite(result) ? result : null;
    }
    return null;
}
