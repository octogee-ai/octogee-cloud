import { operationAuditDocumentId } from "./operation-audit.js";
export const NATIVE_RETURN_TARGET_EXCLUSION = "native-return-target-exclusion";
export function nativeReturnTargetExclusionId(uid) {
    return operationAuditDocumentId(`${NATIVE_RETURN_TARGET_EXCLUSION}:${uid}`);
}
export async function nativeReturnTargetDenied(store, uid, gatewayId) {
    const record = await store.journal.audits.get(nativeReturnTargetExclusionId(uid));
    if (!record)
        return false;
    const target = record.target;
    if (record.mutation.kind !== NATIVE_RETURN_TARGET_EXCLUSION || target.uid !== uid ||
        typeof target.targetGatewayId !== "string")
        return true;
    if (target.targetGatewayId === gatewayId)
        return true;
    const root = await store.gateways.roots.get(gatewayId);
    return root?.gatewayClass !== "isolated";
}
export async function nativeReturnSharedStoreHandoffDenied(store, uid) {
    return (await store.journal.audits.get(nativeReturnTargetExclusionId(uid))) !== null;
}
