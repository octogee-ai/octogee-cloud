import { resolveParkedHomeArchiveGrant } from "./parked-home-archive.js";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { isSizingTier } from "@octogee/shared/types/sizing";
import { GatewayRetirementConflictError } from "./gateway-retirement-claim.js";
import { IsolatedGatewayFenceError, PLACEMENT_RETIREMENT_REASONS, advanceActivationLease, allocateIsolatedGateway, checkUnreachableRecoveryFence, completeActivationLease, failActivationLease, tryFailActivationLeaseAndPark, leaseOperationIdBelongs, recoverUnreachableIsolatedGateway, refreshRequestedAllocation, prepareIsolatedHome, requestSizingKeyTransition, requireStoredHomeReadiness, unauditedLifecycleMutations, retireOwnedIsolatedGateway, reparkOwnedGateway, } from "./isolated-gateway-lifecycle/index.js";
import { FleetMutationPartialError, FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { assertClientOwnsPlacementAutomation, placementOwnerRefusalBody } from "./placement-automation-owner.js";
import { PlacementPreconditionFailed } from "./placement-refusal.js";
import { FenceMismatchError } from "./platform-state/errors.js";
import { InitialGatewayReleaseConflictError } from "./gateway-live-release.js";
import { SizingKeyChangedError, accountSizingKeyReader } from "./sizing-key.js";
class InvalidRequest extends Error {
}
const requireClientOwner = async (transaction) => {
    await assertClientOwnsPlacementAutomation(transaction);
};
const REFUSAL_REASONS = [
    [IsolatedGatewayFenceError, "isolated-fence"],
    [GatewayRetirementConflictError, "retirement-conflict"],
    [FenceMismatchError, "fence-mismatch"],
    [SizingKeyChangedError, "sizing-key-changed"],
    [InitialGatewayReleaseConflictError, "initial-release-conflict"],
];
function refusalReason(error) {
    if (error instanceof PlacementPreconditionFailed)
        return error.reasonCode;
    return REFUSAL_REASONS.find(([type]) => error instanceof type)?.[1] ?? null;
}
export function isolatedVerbRefusalBody(error) {
    const owner = placementOwnerRefusalBody(error);
    if (owner !== null)
        return owner;
    if (error instanceof FleetMutationRefusedError)
        return isolatedVerbRefusalBody(error.refusal);
    const reasonCode = refusalReason(error);
    if (reasonCode === null)
        return null;
    const message = error.message;
    return { code: "precondition-failed", reason: message, error: message, reasonCode };
}
function refusalsBelowError(journal) {
    return (input) => journal({
        ...input,
        action: async (claim) => {
            try {
                return await input.action(claim);
            }
            catch (error) {
                if (error instanceof FleetMutationRefusedError)
                    throw error;
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
    ["provisioning", "active"],
    ["activating", "active"],
    ["active", "returning"],
];
function optionalOperationId(body) {
    if (body.operationId === undefined)
        return {};
    const operationId = text(body, "operationId");
    return operationId ? { operationId } : { invalid: "operationId must be a non-empty string when given" };
}
function parseAdvance(req) {
    const identity = leaseIdentity(req);
    if (invalid(identity))
        return identity;
    const body = bodyOf(req);
    const step = ADVANCES.find(([from, to]) => body.fromStatus === from && body.toStatus === to);
    if (!step) {
        return { invalid: "fromStatus and toStatus must be provisioning->activating, provisioning->active, activating->active or active->returning" };
    }
    const given = optionalOperationId(body);
    if (invalid(given))
        return given;
    return { ...identity, fromStatus: step[0], toStatus: step[1], ...given };
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
    if (!message)
        return { invalid: "message is required" };
    const given = optionalOperationId(body);
    if (invalid(given))
        return given;
    const operationId = given.operationId ?? builderActivateOperationId(targetGatewayId, identity.generation);
    return { ...identity, targetGatewayId, operationId, message };
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
function parseRepark(req) {
    const body = bodyOf(req);
    const builderSlug = text(body, "builderSlug");
    const gatewayId = text(body, "gatewayId");
    const generation = positiveInteger(body, "generation");
    if (!builderSlug || !gatewayId || generation === null)
        return { invalid: "builderSlug, gatewayId and a positive generation are required" };
    return { uid: req.params.uid, builderSlug, gatewayId, generation };
}
function parseIdleRetirementObservation(body) {
    if (body.reason !== "owned-gateway-not-kept")
        return {};
    const { expectedDesiredStatus } = body;
    const expectedUpdatedAt = nonNegativeInteger(body, "expectedUpdatedAt");
    if (expectedDesiredStatus !== "running" && expectedDesiredStatus !== "paused" && expectedDesiredStatus !== "draining") {
        return { invalid: "expectedDesiredStatus must describe the observed running, paused or draining gateway" };
    }
    if (expectedUpdatedAt === null)
        return { invalid: "expectedUpdatedAt must describe the observed gateway revision timestamp" };
    return { expectedDesiredStatus, expectedUpdatedAt };
}
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
    const observation = parseIdleRetirementObservation(body);
    if (invalid(observation))
        return observation;
    const optional = { ...observation };
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
function parseHomePreparation(req) {
    const parsed = parseAllocate(req);
    if (invalid(parsed))
        return parsed;
    if (bodyOf(req).parkedGateway !== undefined)
        return { invalid: "parkedGateway is not part of home preparation" };
    const { uid, leaseId, generation, sourceGatewayId, sourceAssignmentEpoch, sizingKey, sizingTier } = parsed;
    return { uid, leaseId, generation, sourceGatewayId, sourceAssignmentEpoch, sizingKey, sizingTier };
}
function classifyHomePreparation(result) {
    const { effects, ...preparation } = result;
    if (preparation.state === "ready" && effects.length === 0)
        return { outcome: "completed" };
    const details = { ...preparation, effects };
    if (preparation.state === "blocked") {
        return { outcome: "failed", error: preparation.reason, partialOutcome: { summary: "blocked", details } };
    }
    if (preparation.state === "in-progress" && preparation.lastError) {
        return { outcome: "failed", error: `compute unavailable at ${preparation.step}: ${preparation.lastError.code}`, partialOutcome: { summary: `in-progress: ${preparation.step}`, details } };
    }
    const summary = preparation.state === "ready" ? "ready" : `in-progress: ${preparation.step}`;
    return { outcome: "partial", partialOutcome: { summary, details } };
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
        throw new PlacementPreconditionFailed("user-missing", `user ${uid} is missing`);
    return user;
}
async function assertLeaseOperationId(store, claim) {
    const { gatewayId } = claim;
    if (gatewayId === null)
        throw new InvalidRequest(`operationId ${claim.operationId} needs the lease's target gateway`);
    if (await leaseOperationIdBelongs(store.journal.operations, { ...claim, gatewayId }))
        return;
    throw new InvalidRequest(`operationId ${claim.operationId} is not an operation of ${claim.uid} on ${gatewayId} generation ${claim.generation}`);
}
function leaseOf(user) {
    if (!user.activationLease)
        throw new PlacementPreconditionFailed("lease-missing", `activation lease for ${user.uid} is missing`);
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
        sourceRecoveryPending: deps.capabilities.sourceRecoveryPending,
    };
    const ownerCheck = () => deps.store.transaction({ label: "admin.placement.isolated.owner", readOnly: true }, async (transaction) => { await requireClientOwner(transaction); });
    const verb = (path, parse, run) => {
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
                if (error instanceof InvalidRequest) {
                    res.status(400).json({ error: error.message });
                    return;
                }
                next(error);
            }
        });
    };
    const routes = { deps, journal, lifecycle, verb };
    addLeaseVerbs(routes);
    addIsolatedGatewayVerbs(routes);
    addHomeVerbs(routes);
}
function addLeaseVerbs({ deps, journal, lifecycle, verb }) {
    verb("/users/:uid/activation-lease/advance", parseAdvance, async (req, input) => {
        if (input.operationId !== undefined) {
            const stored = await deps.store.users.records.get(input.uid);
            const gatewayId = stored?.activationLease?.targetGatewayId;
            await assertLeaseOperationId(deps.store, { ...input, operationId: input.operationId, gatewayId: typeof gatewayId === "string" ? gatewayId : null });
        }
        return journal({
            req,
            what: "advance user activation lease",
            why: "placement automation advanced the lease",
            target: { uid: input.uid },
            preActionStatus: { leaseId: input.leaseId, generation: input.generation, status: input.fromStatus },
            mutation: { kind: "advance-activation-lease", toStatus: input.toStatus, operationId: input.operationId ?? null },
            dryRunRefusal: async () => {
                await advanceActivationLease(lifecycle, input, "plan");
                return null;
            },
            action: async () => {
                await advanceActivationLease(lifecycle, input);
                return { uid: input.uid, leaseId: input.leaseId, generation: input.generation, status: input.toStatus };
            },
        });
    });
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
            const archiveGrant = resolveParkedHomeArchiveGrant(deps.releaseEnvironment, process.env.GATEWAY_TEST_HOME_ARCHIVE_GRANT);
            await completeActivationLease({ ...lifecycle, archiveGrant }, input);
            const lease = leaseOf(await readOwner(deps.store, input.uid));
            return { uid: input.uid, lease: { leaseId: lease.leaseId, generation: lease.generation, status: lease.status } };
        },
    }));
    verb("/users/:uid/activation-lease/fail", parseFail, async (req, input) => {
        await assertLeaseOperationId(deps.store, { ...input, gatewayId: input.targetGatewayId });
        return journal({
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
        });
    });
    verb("/users/:uid/activation-lease/fail-and-park", parseFail, (req, input) => journal({
        req,
        what: "park isolated computer after activation rollback",
        why: "the Shared source recovered from a failed activation before cutover",
        target: { uid: input.uid, gatewayId: input.targetGatewayId },
        preActionStatus: { leaseId: input.leaseId, generation: input.generation },
        mutation: { kind: "fail-activation-lease-and-park", operationId: input.operationId },
        dryRunRefusal: async () => await tryFailActivationLeaseAndPark(lifecycle, input, "plan") ? null : { parked: false },
        action: async () => ({ parked: await tryFailActivationLeaseAndPark(lifecycle, input) }),
        classifyResult: ({ parked }) => parked
            ? { outcome: "completed" }
            : { outcome: "failed", error: "isolated target does not have completed rollback custody" },
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
}
function addIsolatedGatewayVerbs({ deps, journal, lifecycle, verb }) {
    verb("/users/:uid/isolated-gateway/repark", parseRepark, (req, input) => journal({
        req,
        what: "repark returned isolated gateway",
        why: "the returned owner computer resumed without an activation",
        target: { uid: input.uid, gatewayId: input.gatewayId },
        preActionStatus: { generation: input.generation },
        mutation: { kind: "repark-owned-isolated-gateway" },
        dryRunRefusal: async () => await reparkOwnedGateway(lifecycle, input, "plan") ? null : { parked: false },
        action: async () => ({ parked: await reparkOwnedGateway(lifecycle, input) }),
    }));
    verb("/isolated-gateways/:id/retire-owned", parseRetire, async (req, input) => {
        const root = projectGatewayDesiredRootForGateway(await deps.store.gateways.roots.get(input.gatewayId), input.gatewayId);
        if (root === null || root.ownerUid !== input.uid || !root.builderSlug) {
            throw new PlacementPreconditionFailed("gateway-not-owned", `gateway ${input.gatewayId} is not owned by ${input.uid}`);
        }
        if (input.telemetryFenceOperationId !== undefined) {
            await assertLeaseOperationId(deps.store, { ...input, operationId: input.telemetryFenceOperationId });
        }
        const request = { ...input, builderSlug: root.builderSlug };
        return journal({
            req,
            what: "retire owned isolated gateway",
            why: `placement automation retires it: ${input.reason}`,
            target: { gatewayId: input.gatewayId, uid: input.uid },
            preActionStatus: { generation: input.generation, desiredStatus: input.expectedDesiredStatus ?? root.desiredStatus,
                ...(input.expectedUpdatedAt === undefined ? {} : { updatedAt: input.expectedUpdatedAt }) },
            mutation: { kind: "retire-owned-isolated-gateway", reason: input.reason, leaseId: input.leaseId ?? null },
            dryRunRefusal: async () => {
                const plan = await retireOwnedIsolatedGateway(lifecycle, request, "plan");
                if (!plan.retired)
                    throw new PlacementPreconditionFailed("retirement-blocked", plan.reason);
                return null;
            },
            action: async () => {
                const retirement = await retireOwnedIsolatedGateway(lifecycle, request);
                if (!retirement.retired)
                    throw new PlacementPreconditionFailed("retirement-blocked", retirement.reason);
                return { gatewayId: input.gatewayId, operationId: retirement.operationId, retired: true };
            },
        });
    });
    const allocationDeps = {
        ...lifecycle,
        requireHomeReady: requireStoredHomeReadiness,
        namespace: deps.capabilities.namespace,
        ensureAuthSecret: deps.capabilities.ensureAuthSecret,
    };
    verb("/users/:uid/isolated-gateway/allocate", parseAllocate, async (req, input) => {
        const builderSlug = (await readOwner(deps.store, input.uid)).slug;
        if (!builderSlug)
            throw new PlacementPreconditionFailed("user-slug-missing", `user ${input.uid} has no slug`);
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
            throw new PlacementPreconditionFailed("gateway-not-owned", `gateway ${input.gatewayId} is not owned by ${input.uid}`);
        }
        const request = { ...input, builderSlug: root.builderSlug };
        return journal({
            req,
            what: "recover unreachable isolated gateway",
            why: "placement automation found the isolated gateway unreachable",
            target: { gatewayId: input.gatewayId, uid: input.uid },
            preActionStatus: { generation: input.generation, desiredStatus: root.desiredStatus },
            mutation: { kind: "recover-unreachable-isolated-gateway", authoritativeGatewayId: input.authoritativeGatewayId },
            classifyResult: (result) => result.state === "waiting"
                ? { outcome: "partial", partialOutcome: { summary: `waiting: ${result.reason}`, details: { state: "waiting", reason: result.reason, operationId: result.operationId } } }
                : { outcome: "completed" },
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
function addHomeVerbs({ deps, journal, lifecycle, verb }) {
    const homeCapabilities = deps.capabilities.home;
    if (!homeCapabilities)
        return;
    verb("/users/:uid/home/prepare", parseHomePreparation, (req, input) => journal({
        req,
        what: "prepare user home",
        why: "placement automation prepares the user's home before an isolated activation",
        target: { uid: input.uid },
        preActionStatus: { leaseId: input.leaseId, generation: input.generation, status: "requested" },
        mutation: { kind: "prepare-user-home", sizingKey: input.sizingKey, sizingTier: input.sizingTier, sourceGatewayId: input.sourceGatewayId },
        classifyResult: classifyHomePreparation,
        dryRunRefusal: async () => {
            await prepareIsolatedHome({ ...lifecycle, home: homeCapabilities(() => undefined) }, input, "plan");
            return null;
        },
        action: async () => {
            const effects = [];
            try {
                const preparation = await prepareIsolatedHome({ ...lifecycle, home: homeCapabilities((effect) => effects.push(effect)) }, input);
                return { uid: input.uid, ...preparation, effects };
            }
            catch (error) {
                if (!(error instanceof Error) || effects.length === 0)
                    throw error;
                if (isolatedVerbRefusalBody(error) !== null) {
                    throw new FleetMutationRefusedError(error, { summary: "refused after compute effects", details: { effects } });
                }
                throw new FleetMutationPartialError(error.message, { summary: "failed after compute effects", details: { effects } });
            }
        },
    }));
}
