import { builderActivateOperationId, builderReturnOperationId, isolatedRecoverOperationId, placementRetireOperationId, } from "@octogee/shared/types/isolated-operation-ids";
export function authorizationEndedOperationId(gatewayId) {
    return `builder-authorization-ended-${gatewayId}`;
}
function canonicalLeaseOperationIds(claim) {
    return [
        builderActivateOperationId(claim.gatewayId, claim.generation),
        builderReturnOperationId(claim.gatewayId, claim.generation),
        isolatedRecoverOperationId(claim.gatewayId, claim.generation),
        placementRetireOperationId(claim.uid, claim.gatewayId, claim.generation),
        authorizationEndedOperationId(claim.gatewayId),
    ];
}
function operationReferences(operation, claim) {
    const input = operation.input;
    return [operation.inputUid, input.uid, input.ownerUid].includes(claim.uid) &&
        [operation.gatewayId, input.gatewayId, input.fromGatewayId, input.toGatewayId].includes(claim.gatewayId);
}
export async function leaseOperationIdBelongs(operations, claim) {
    if (canonicalLeaseOperationIds(claim).includes(claim.operationId))
        return true;
    const operation = await operations.get(claim.operationId);
    return operation !== null && operationReferences(operation, claim);
}
