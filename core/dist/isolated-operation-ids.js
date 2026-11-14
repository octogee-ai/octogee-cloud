function runtimeOperationSuffix(gatewayId, generation) {
    if (gatewayId.length === 0)
        throw new Error("Isolated runtime operation needs a gateway id");
    if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error(`Isolated runtime operation needs a positive generation, got ${generation}`);
    }
    return `${gatewayId}-g${generation}`;
}
export function builderActivateOperationId(gatewayId, generation) {
    return `builder-activate-${runtimeOperationSuffix(gatewayId, generation)}`;
}
export function builderReturnOperationId(gatewayId, generation) {
    return `builder-return-${runtimeOperationSuffix(gatewayId, generation)}`;
}
export function isolatedRecoverOperationId(gatewayId, generation) {
    return `builder-recover-${runtimeOperationSuffix(gatewayId, generation)}`;
}
export function placementRetireOperationId(uid, gatewayId, generation) {
    if (uid.length === 0)
        throw new Error("placement retirement needs an owner uid");
    return `placement-retire-${uid}-${runtimeOperationSuffix(gatewayId, generation)}`;
}
function runtimeOperationIdMatches(prefix, operationId, gatewayId) {
    if (typeof operationId !== "string" || typeof gatewayId !== "string" || gatewayId.length === 0)
        return false;
    const head = `${prefix}${gatewayId}-g`;
    return operationId.startsWith(head) && /^[1-9]\d*$/.test(operationId.slice(head.length));
}
export function isUserActivateOperationIdFor(operationId, gatewayId) {
    return runtimeOperationIdMatches("builder-activate-", operationId, gatewayId);
}
export function isUserReturnOperationIdFor(operationId, gatewayId) {
    return runtimeOperationIdMatches("builder-return-", operationId, gatewayId);
}
