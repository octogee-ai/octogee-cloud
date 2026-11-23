import { isDeepStrictEqual } from "node:util";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { hasFreshReadyKubernetesObservation } from "@octogee/shared/types/gateway-releases";
import { operationAuditDocumentId } from "./operation-audit.js";
export const NATIVE_RETURN_TARGET_EXCLUSION = "native-return-target-exclusion";
export function nativeReturnTargetExclusionId(uid) {
    return operationAuditDocumentId(`${NATIVE_RETURN_TARGET_EXCLUSION}:${uid}`);
}
export async function readNativeReturnTargetDrain(store, operation) {
    const { uid, toGatewayId } = operation.input;
    if (typeof uid !== "string" || typeof toGatewayId !== "string")
        return null;
    const audit = await store.journal.audits.get(nativeReturnTargetExclusionId(uid));
    const drain = audit?.target.drain;
    if (!audit || !drain || audit.status !== "in-progress" || audit.mutation.kind !== NATIVE_RETURN_TARGET_EXCLUSION ||
        audit.target.uid !== uid || audit.target.targetGatewayId !== toGatewayId || drain.operationId !== operation.id)
        return null;
    return { ...drain, holdStartedAt: audit.actionStartedAt };
}
export function sharedDrainPodMatches(runtime, podUid, now) {
    return !!runtime && hasFreshReadyKubernetesObservation(runtime, now, GATEWAY_UNREACHABLE_AFTER_MS) &&
        runtime.kubernetes?.totalPods === 1 && runtime.kubernetes.readyPods === 1 && runtime.kubernetes.pods?.length === 1 &&
        runtime.kubernetes.pods[0]?.uid === podUid;
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
    if (!root)
        return true;
    return root.gatewayClass !== "isolated" && !await sharedHandoffReleaseCurrent(store, uid, record);
}
export async function nativeReturnSharedStoreHandoffDenied(store, uid) {
    const record = await store.journal.audits.get(nativeReturnTargetExclusionId(uid));
    return record !== null && !await sharedHandoffReleaseCurrent(store, uid, record);
}
async function sharedHandoffReleaseCurrent(store, uid, record) {
    const target = record.target;
    const release = target.sharedHandoffRelease;
    if (record.mutation.kind !== NATIVE_RETURN_TARGET_EXCLUSION || target.uid !== uid || typeof target.targetGatewayId !== "string" ||
        record.status !== "completed" || record.outcome !== "completed" || !release?.retirement ||
        typeof release.verifiedAt !== "number" || !Number.isSafeInteger(release.verifiedAt) || release.verifiedAt < release.retirement.completedAt || !release.actor)
        return false;
    const current = await readNativeOldTargetRetirement(store, target.targetGatewayId);
    return current !== null && isDeepStrictEqual(current, release.retirement);
}
export async function readNativeOldTargetRetirement(store, gatewayId) {
    if (!/^shared-[a-z0-9]+$/.test(gatewayId))
        return null;
    const operationId = `shared-pool-retire-${gatewayId}`;
    const [root, runtime, operation, empty, owners, history] = await Promise.all([
        store.gateways.roots.get(gatewayId), store.fleetRegistry.get(gatewayId), store.journal.operations.get(operationId),
        store.gateways.assignments.isEmpty(gatewayId), store.users.records.listByGateway(gatewayId, { limit: 1 }),
        store.journal.operations.listByGateway(gatewayId),
    ]);
    if (!operation || runtime || !empty || owners.length || !qualifiedRetirement(operation, gatewayId))
        return null;
    const identity = qualifiedRetirementIdentity(operation, operationId);
    if (!identity || (root && !retiredRootMatches(root, operationId, identity.version)) ||
        targetRecreationAppeared(history, identity.createdAt))
        return null;
    return identity;
}
function qualifiedRetirementIdentity(operation, operationId) {
    const { retirementClaimVersion: version } = operation.input;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version <= 0 ||
        typeof operation.completedAt !== "number" || !Number.isSafeInteger(operation.completedAt) ||
        !Number.isSafeInteger(operation.createdAt) || operation.completedAt < operation.createdAt)
        return null;
    return { operationId, version, createdAt: operation.createdAt, completedAt: operation.completedAt };
}
function retiredRootMatches(root, operationId, version) {
    return [root.gatewayClass === "shared", root.ownerUid == null, root.desiredStatus === "retired",
        root.retirementVersion === version, root.retirementClaim?.version === version,
        root.retirementClaim?.operationId === operationId, root.retirementClaim?.phase === "claimed"].every(Boolean);
}
function targetRecreationAppeared(history, retiredAt) {
    return history.some(candidate => candidate.kind === "add-gateway" &&
        (!["succeeded", "failed"].includes(candidate.status) || !Number.isSafeInteger(candidate.createdAt) || candidate.createdAt >= retiredAt));
}
function qualifiedRetirement(operation, gatewayId) {
    return [operation.kind === "retire-gateway", operation.status === "succeeded", operation.gatewayId === gatewayId,
        operation.input.gatewayId === gatewayId, operation.input.source === "shared-pool-scaler",
        operation.input.retainData !== true, operation.input.retainServiceAccount !== true,
        ["helm-uninstall", "revoke-agent-store-credentials"].every(name => operation.steps.some(step => step.name === name && step.status === "done"))].every(Boolean);
}
