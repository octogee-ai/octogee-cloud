import { IsolatedGatewayFenceError } from "./inputs.js";
function validRecoveryIdentity(identity) {
    return [identity.ownerUid, identity.targetGatewayId, identity.leaseId].every(id => typeof id === "string" && id.length > 0 && !id.includes("/")) &&
        Number.isSafeInteger(identity.generation) && identity.generation > 0;
}
function failedReceiptMatches(receipt, identity) {
    return receipt?.kind === "activation-failed" && receipt.gatewayId === identity.targetGatewayId &&
        receipt.leaseId === identity.leaseId && receipt.generation === identity.generation;
}
export async function assertFailedHomeRestoreReleased(state, identity) {
    const { ownerUid, targetGatewayId, leaseId, generation } = identity;
    if (!validRecoveryIdentity(identity))
        throw new IsolatedGatewayFenceError("Home archive restore receipt identity is incomplete");
    const receipt = await state.users.placementReceipts.get(ownerUid, leaseId, generation, "activation-failed");
    if (!failedReceiptMatches(receipt, identity)) {
        throw new IsolatedGatewayFenceError("Failed home restore receipt does not match the original demand");
    }
    const [operation, active, assignment] = await Promise.all([
        receipt.operationId ? state.journal.operations.get(receipt.operationId) : null,
        state.journal.operations.listForUid(ownerUid, { statuses: ["pending", "running"] }),
        state.gateways.assignments.get(targetGatewayId, ownerUid),
    ]);
    if (receipt.operationId && (operation?.status !== "failed" || operation.kind !== "migrate-user" ||
        operation.inputUid !== ownerUid || operation.input.toGatewayId !== targetGatewayId)) {
        throw new IsolatedGatewayFenceError("Failed home restore still has an unresolved dispatched claim");
    }
    if (assignment || active.some(entry => entry.gatewayId === targetGatewayId || entry.input.toGatewayId === targetGatewayId)) {
        throw new IsolatedGatewayFenceError("Failed home restore still has an assignment or active claim");
    }
}
