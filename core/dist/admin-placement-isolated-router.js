import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { isSizingTier } from "@octogee/shared/types/sizing";
import { GatewayRetirementConflictError } from "./gateway-retirement-claim.js";
import { IsolatedGatewayFenceError, PLACEMENT_RETIREMENT_REASONS, advanceActivationLease, allocateIsolatedGateway, checkUnreachableRecoveryFence, completeActivationLease, failActivationLease, recoverUnreachableIsolatedGateway, refreshRequestedAllocation, requestSizingKeyTransition, unauditedLifecycleMutations, retireOwnedIsolatedGateway, } from "./isolated-gateway-lifecycle/index.js";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { assertClientOwnsPlacementAutomation, placementOwnerRefusalBody } from "./placement-automation-owner.js";
import { FenceMismatchError } from "./platform-state/errors.js";
import { InitialGatewayReleaseConflictError } from "./gateway-live-release.js";
import { SizingKeyChangedError, accountSizingKeyReader } from "./sizing-key.js";
class PreconditionFailed extends Error {
}
const requireClientOwner = async (transaction) => {
    await assertClientOwnsPlacementAutomation(transaction);
};
function isPrecondition(error) {
    return error instanceof PreconditionFailed ||
        error instanceof IsolatedGatewayFenceError ||
        error instanceof GatewayRetirementConflictError ||
        error instanceof FenceMismatchError ||
        error instanceof SizingKeyChangedError ||
        error instanceof InitialGatewayReleaseConflictError;
}
export function isolatedVerbRefusalBody(error) {
    const owner = placementOwnerRefusalBody(error);
    if (owner !== null)
        return owner;
    if (error instanceof FleetMutationRefusedError)
        return isolatedVerbRefusalBody(error.refusal);
    if (isPrecondition(error))
        return { code: "precondition-failed", reason: error.message, error: error.message };
    return null;
}
function refusalsBelowError(journal) {
    return (input) => journal({
        ...input,
        action: async (claim) => {
            try {
                return await input.action(claim);
            }
            catch (error) {
                if (error instanceof Error && isolatedVerbRefusalBody(error) !== null)
                    throw new FleetMutationRefusedError(error);
                throw error;
            }
        },
    });
}
async function settle(res, run) {
    try {
        res.json(await run());
    }
    catch (error) {
        const body = isolatedVerbRefusalBody(error);
        if (body === null)
            throw error;
        res.status(409).json(body);
    }
}
function bodyOf(req) {
    const body = req.body;
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
}
function text(body, key) {
    const value = body[key];
    return typeof value === "string" && value.length > 0 ? value : null;
}
function positiveInteger(body, key) {
    const value = body[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}
function invalid(parsed) {
    return typeof parsed === "object" && parsed !== null && "invalid" in parsed;
}
function leaseIdentity(req) {
    const body = bodyOf(req);
    const leaseId = text(body, "leaseId");
    const generation = positiveInteger(body, "generation");
    if (!leaseId)
        return { invalid: "leaseId is required" };
    if (generation === null)
        return { invalid: "generation must be a positive integer" };
    return { uid: req.params.uid, leaseId, generation };
}
const ADVANCES = [
    ["provisioning", "activating"],
    ["activating", "active"],
    ["active", "returning"],
];
function parseAdvance(req) {
    const identity = leaseIdentity(req);
    if (invalid(identity))
        return identity;
    const body = bodyOf(req);
    const step = ADVANCES.find(([from, to]) => body.fromStatus === from && body.toStatus === to);
    if (!step)
        return { invalid: "fromStatus and toStatus must be provisioning->activating, activating->active or active->returning" };
    if (body.operationId !== undefined)
        return { invalid: "operationId is derived from the lease; omit it" };
    return { ...identity, fromStatus: step[0], toStatus: step[1] };
}
function parseComplete(req) {
    const identity = leaseIdentity(req);
    if (invalid(identity))
        return identity;
    const body = bodyOf(req);
    const targetGatewayId = text(body, "targetGatewayId");
    if (!targetGatewayId)
        return { invalid: "targetGatewayId is required" };
    if (body.parked !== undefined && body.parked !== true)
        return { invalid: "parked must be true when given" };
    return { ...identity, targetGatewayId, ...(body.parked === true ? { parked: true } : {}) };
}
function parseFail(req) {
    const identity = leaseIdentity(req);
    if (invalid(identity))
        return identity;
    const body = bodyOf(req);
    const targetGatewayId = text(body, "targetGatewayId");
    const message = text(body, "message");
    if (!targetGatewayId)
        return { invalid: "targetGatewayId is required" };
    if (body.operationId !== undefined)
        return { invalid: "operationId is derived from the lease; omit it" };
    if (!message)
        return { invalid: "message is required" };
    return { ...identity, targetGatewayId, operationId: builderActivateOperationId(targetGatewayId, identity.generation), message };
}
function parseSizingTransition(req) {
    const identity = leaseIdentity(req);
    if (invalid(identity))
        return identity;
    const body = bodyOf(req);
    const targetGatewayId = text(body, "targetGatewayId");
    const sizingKey = text(body, "sizingKey");
    if (!targetGatewayId)
        return { invalid: "targetGatewayId is required" };
    if (!sizingKey)
        return { invalid: "sizingKey is required" };
    return { ...identity, targetGatewayId, sizingKey };
}
const AUTHORITATIVE_STATUSES = ["provisioning", "activating", "returning"];
function parseRetire(req) {
    const body = bodyOf(req);
    const uid = text(body, "ownerUid");
    const generation = positiveInteger(body, "generation");
    const reason = body.reason;
    if (!uid)
        return { invalid: "ownerUid is required" };
    if (generation === null)
        return { invalid: "generation must be a positive integer" };
    if (!PLACEMENT_RETIREMENT_REASONS.includes(reason)) {
        return { invalid: `reason must be one of ${PLACEMENT_RETIREMENT_REASONS.join(", ")}` };
    }
    const optional = {};
    for (const key of ["leaseId", "telemetryFenceOperationId", "authoritativeGatewayId", "zeroWorkloadRecoveryOperationId"]) {
        if (body[key] === undefined)
            continue;
        const value = text(body, key);
        if (!value)
            return { invalid: `${key} must be a non-empty string when given` };
        optional[key] = value;
    }
    if (body.telemetryFenceStatus !== undefined) {
        if (body.telemetryFenceStatus !== "succeeded" && body.telemetryFenceStatus !== "terminal-failure") {
            return { invalid: "telemetryFenceStatus must be succeeded or terminal-failure" };
        }
        if (optional.telemetryFenceOperationId === undefined)
            return { invalid: "telemetryFenceStatus needs telemetryFenceOperationId" };
        optional.telemetryFenceStatus = body.telemetryFenceStatus;
    }
    if (body.authoritativeLeaseStatus !== undefined) {
        if (!AUTHORITATIVE_STATUSES.includes(body.authoritativeLeaseStatus)) {
            return { invalid: "authoritativeLeaseStatus must be provisioning, activating or returning" };
        }
        if (optional.authoritativeGatewayId === undefined)
            return { invalid: "authoritativeLeaseStatus needs authoritativeGatewayId" };
        optional.authoritativeLeaseStatus = body.authoritativeLeaseStatus;
    }
    return {
        uid,
        gatewayId: req.params.id,
        generation,
        reason: reason,
        ...optional,
    };
}
function nonNegativeInteger(body, key) {
    const value = body[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function parseAllocate(req) {
    const identity = leaseIdentity(req);
    if (invalid(identity))
        return identity;
    const body = bodyOf(req);
    const sourceGatewayId = text(body, "sourceGatewayId");
    const sourceAssignmentEpoch = nonNegativeInteger(body, "sourceAssignmentEpoch");
    const sizingKey = text(body, "sizingKey");
    if (!sourceGatewayId)
        return { invalid: "sourceGatewayId is required" };
    if (sourceAssignmentEpoch === null)
        return { invalid: "sourceAssignmentEpoch must be a non-negative integer" };
    if (!sizingKey)
        return { invalid: "sizingKey is required" };
    if (!isSizingTier(body.sizingTier))
        return { invalid: "sizingTier must be s, m or l" };
    const request = { ...identity, sourceGatewayId, sourceAssignmentEpoch, sizingKey, sizingTier: body.sizingTier };
    if (body.parkedGateway === undefined)
        return request;
    const parked = body.parkedGateway !== null && typeof body.parkedGateway === "object" ? body.parkedGateway : {};
    const gatewayId = text(parked, "gatewayId");
    const generation = positiveInteger(parked, "generation");
    if (!gatewayId || generation === null)
        return { invalid: "parkedGateway needs gatewayId and a positive integer generation" };
    return { ...request, parkedGateway: { gatewayId, generation } };
}
function parseRecover(req) {
    const body = bodyOf(req);
    const uid = text(body, "ownerUid");
    const leaseId = text(body, "leaseId");
    const generation = positiveInteger(body, "generation");
    const authoritativeGatewayId = text(body, "authoritativeGatewayId");
    if (!uid)
        return { invalid: "ownerUid is required" };
    if (!leaseId)
        return { invalid: "leaseId is required" };
    if (generation === null)
        return { invalid: "generation must be a positive integer" };
    if (!authoritativeGatewayId)
        return { invalid: "authoritativeGatewayId is required" };
    if (body.sourceUnavailable !== undefined && body.sourceUnavailable !== true)
        return { invalid: "sourceUnavailable must be true when given" };
    return {
        uid,
        gatewayId: req.params.id,
        leaseId,
        generation,
        authoritativeGatewayId,
        ...(body.sourceUnavailable === true ? { sourceUnavailable: true } : {}),
    };
}
async function readOwner(store, uid) {
    const user = await store.users.records.get(uid);
    if (!user)
        throw new PreconditionFailed(`user ${uid} is missing`);
    return user;
}
function leaseOf(user) {
    if (!user.activationLease)
        throw new PreconditionFailed(`activation lease for ${user.uid} is missing`);
    return user.activationLease;
}
export function addAdminPlacementIsolatedRoutes(router, deps) {
    const journal = refusalsBelowError(deps.journal);
    const now = deps.now ?? Date.now;
    const readSizingKey = accountSizingKeyReader(deps.accounts);
    const lifecycle = {
        store: deps.store,
        readSizingKey,
        requireOwner: requireClientOwner,
        mutations: unauditedLifecycleMutations,
        now,
        log: deps.log,
    };
    const ownerCheck = () => deps.store.transaction({ label: "admin.placement.isolated.owner", readOnly: true }, async (transaction) => { await requireClientOwner(transaction); });
    function verb(path, parse, run) {
        router.post(path, async (req, res, next) => {
            try {
                const input = parse(req);
                if (invalid(input)) {
                    res.status(400).json({ error: input.invalid });
                    return;
                }
                try {
                    await ownerCheck();
                }
                catch (error) {
                    const refusal = placementOwnerRefusalBody(error);
                    if (refusal === null)
                        throw error;
                    deps.warn(`[placement] ${req.method} ${req.path} refused before journaling: ${error.message}`);
                    res.status(409).json(refusal);
                    return;
                }
                await settle(res, () => run(req, input));
            }
            catch (error) {
                next(error);
            }
        });
    }
    verb("/users/:uid/activation-lease/advance", parseAdvance, (req, input) => journal({
        req,
        what: "advance user activation lease",
        why: "placement automation advanced the lease",
        target: { uid: input.uid },
        preActionStatus: { leaseId: input.leaseId, generation: input.generation, status: input.fromStatus },
        mutation: { kind: "advance-activation-lease", toStatus: input.toStatus },
        dryRunRefusal: async () => {
            await advanceActivationLease(lifecycle, input, "plan");
            return null;
        },
        action: async () => {
            await advanceActivationLease(lifecycle, input);
            return { uid: input.uid, leaseId: input.leaseId, generation: input.generation, status: input.toStatus };
        },
    }));
    verb("/users/:uid/activation-lease/complete", parseComplete, (req, input) => journal({
        req,
        what: "complete user activation lease",
        why: "the user returned from the isolated gateway",
        target: { uid: input.uid, gatewayId: input.targetGatewayId },
        preActionStatus: { leaseId: input.leaseId, generation: input.generation, status: "returning" },
        mutation: { kind: "complete-activation-lease", parked: input.parked === true },
        dryRunRefusal: async () => {
            await completeActivationLease(lifecycle, input, "plan");
            return null;
        },
        action: async () => {
            await completeActivationLease(lifecycle, input);
            const lease = leaseOf(await readOwner(deps.store, input.uid));
            return { uid: input.uid, lease: { leaseId: lease.leaseId, generation: lease.generation, status: lease.status } };
        },
    }));
    verb("/users/:uid/activation-lease/fail", parseFail, (req, input) => journal({
        req,
        what: "fail user activation lease",
        why: "the activation migration failed",
        target: { uid: input.uid, gatewayId: input.targetGatewayId },
        preActionStatus: { leaseId: input.leaseId, generation: input.generation },
        mutation: { kind: "fail-activation-lease", operationId: input.operationId },
        dryRunRefusal: async () => {
            await failActivationLease(lifecycle, input, "plan");
            return null;
        },
        action: async () => {
            await failActivationLease(lifecycle, input);
            return { uid: input.uid, leaseId: input.leaseId, generation: input.generation, status: "failed" };
        },
    }));
    verb("/users/:uid/activation-lease/sizing-transition", parseSizingTransition, (req, input) => journal({
        req,
        what: "request user sizing transition",
        why: "the user's sizing profile changed while active",
        target: { uid: input.uid, gatewayId: input.targetGatewayId },
        preActionStatus: { leaseId: input.leaseId, generation: input.generation, status: "active" },
        mutation: { kind: "request-sizing-transition", sizingKey: input.sizingKey },
        dryRunRefusal: async () => {
            await requestSizingKeyTransition(lifecycle, input, "plan");
            return null;
        },
        action: async () => {
            await requestSizingKeyTransition(lifecycle, input);
            return { uid: input.uid, leaseId: input.leaseId, generation: input.generation, returnRequested: true };
        },
    }));
    verb("/isolated-gateways/:id/retire-owned", parseRetire, async (req, input) => {
        const root = projectGatewayDesiredRootForGateway(await deps.store.gateways.roots.get(input.gatewayId), input.gatewayId);
        if (root === null || root.ownerUid !== input.uid || !root.builderSlug) {
            throw new PreconditionFailed(`gateway ${input.gatewayId} is not owned by ${input.uid}`);
        }
        const request = { ...input, builderSlug: root.builderSlug };
        return journal({
            req,
            what: "retire owned isolated gateway",
            why: `placement automation retires it: ${input.reason}`,
            target: { gatewayId: input.gatewayId, uid: input.uid },
            preActionStatus: { generation: input.generation, desiredStatus: root.desiredStatus },
            mutation: { kind: "retire-owned-isolated-gateway", reason: input.reason, leaseId: input.leaseId ?? null },
            dryRunRefusal: async () => {
                const plan = await retireOwnedIsolatedGateway(lifecycle, request, "plan");
                if (!plan.retired)
                    throw new PreconditionFailed(plan.reason);
                return null;
            },
            action: async () => {
                const retirement = await retireOwnedIsolatedGateway(lifecycle, request);
                if (!retirement.retired)
                    throw new PreconditionFailed(retirement.reason);
                return { gatewayId: input.gatewayId, operationId: retirement.operationId, retired: true };
            },
        });
    });
    const allocationDeps = {
        ...lifecycle,
        namespace: deps.capabilities.namespace,
        ensureAuthSecret: deps.capabilities.ensureAuthSecret,
    };
    verb("/users/:uid/isolated-gateway/allocate", parseAllocate, async (req, input) => {
        const builderSlug = (await readOwner(deps.store, input.uid)).slug;
        if (!builderSlug)
            throw new PreconditionFailed(`user ${input.uid} has no slug`);
        const request = { ...input, builderSlug };
        return journal({
            req,
            what: "allocate isolated gateway",
            why: "placement automation activates the user on an isolated gateway",
            target: { uid: input.uid, gatewayId: input.parkedGateway?.gatewayId ?? null },
            preActionStatus: { leaseId: input.leaseId, generation: input.generation, status: "requested" },
            mutation: { kind: "allocate-isolated-gateway", sizingKey: input.sizingKey, sizingTier: input.sizingTier, sourceGatewayId: input.sourceGatewayId },
            dryRunRefusal: async () => {
                if (!await refreshRequestedAllocation(lifecycle, request, "plan"))
                    await allocateIsolatedGateway(allocationDeps, request, "plan");
                return null;
            },
            action: async () => {
                if (await refreshRequestedAllocation(lifecycle, request)) {
                    return { uid: input.uid, gatewayId: null, outcome: "refreshed" };
                }
                const allocation = await allocateIsolatedGateway(allocationDeps, request);
                return { uid: input.uid, ...allocation };
            },
        });
    });
    verb("/isolated-gateways/:id/recover-unreachable", parseRecover, async (req, input) => {
        const root = projectGatewayDesiredRootForGateway(await deps.store.gateways.roots.get(input.gatewayId), input.gatewayId);
        if (root === null || root.ownerUid !== input.uid || !root.builderSlug) {
            throw new PreconditionFailed(`gateway ${input.gatewayId} is not owned by ${input.uid}`);
        }
        const request = { ...input, builderSlug: root.builderSlug };
        return journal({
            req,
            what: "recover unreachable isolated gateway",
            why: "placement automation found the isolated gateway unreachable",
            target: { gatewayId: input.gatewayId, uid: input.uid },
            preActionStatus: { generation: input.generation, desiredStatus: root.desiredStatus },
            mutation: { kind: "recover-unreachable-isolated-gateway", authoritativeGatewayId: input.authoritativeGatewayId },
            dryRunRefusal: async () => {
                await checkUnreachableRecoveryFence(lifecycle, request);
                return null;
            },
            action: async () => ({
                gatewayId: input.gatewayId,
                ...await recoverUnreachableIsolatedGateway({
                    ...lifecycle,
                    readGatewayPodDiagnostics: deps.capabilities.readGatewayPodDiagnostics,
                }, request),
            }),
        });
    });
}
