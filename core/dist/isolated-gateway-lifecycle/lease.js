import { randomUUID } from "node:crypto";
import { planRestoredHomeBackupRelease } from "./home-backup-release.js";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { builderActivateOperationId, builderReturnOperationId, placementRetireOperationId, } from "@octogee/shared/types/isolated-operation-ids";
import { isolatedSizingTier } from "@octogee/shared/types/sizing-profile";
import { withCurrentSizingKey } from "../sizing-key.js";
import { ISOLATED_GATEWAY_LIFECYCLE_ACTOR, IsolatedGatewayFenceError, checkPlacementOwner, fieldMap, readMillis, assertActivationSourceRecoveryReleased, } from "./inputs.js";
export function userAllowsInteractiveAccess(user) {
    return accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle ?? undefined });
}
export function exactLeaseFence(lease, status) {
    return { leaseId: lease.leaseId, generation: lease.generation, status };
}
function activationLeaseTransitionPatch(request, now) {
    if (request.toStatus === "activating") {
        return {
            activationOperationId: request.operationId,
            activatingAt: now,
        };
    }
    if (request.toStatus === "returning") {
        return {
            returnOperationId: request.operationId,
            returningAt: now,
        };
    }
    return { activeAt: now };
}
export function canonicalAdvanceOperationId(lease, toStatus) {
    if (toStatus === "active" || typeof lease.targetGatewayId !== "string")
        return undefined;
    return toStatus === "activating"
        ? builderActivateOperationId(lease.targetGatewayId, lease.generation)
        : builderReturnOperationId(lease.targetGatewayId, lease.generation);
}
function withCanonicalOperationId(lease, request) {
    if (request.operationId !== undefined)
        return request;
    const operationId = canonicalAdvanceOperationId(lease, request.toStatus);
    return operationId === undefined ? request : { ...request, operationId };
}
export function nextActivationLease(lease, request, now) {
    if (lease.leaseId !== request.leaseId ||
        lease.generation !== request.generation ||
        lease.status !== request.fromStatus) {
        return null;
    }
    if (request.toStatus === "activating" && !request.operationId)
        return null;
    if (request.toStatus === "returning" && !request.operationId)
        return null;
    return {
        ...lease,
        status: request.toStatus,
        ...activationLeaseTransitionPatch(request, now),
    };
}
export function activationLeaseAdvanceAlreadyApplied(lease, request) {
    if (lease.leaseId !== request.leaseId ||
        lease.generation !== request.generation ||
        lease.status !== request.toStatus) {
        return false;
    }
    if (request.toStatus === "activating") {
        return lease.activationOperationId === request.operationId;
    }
    if (request.toStatus === "returning") {
        return lease.returnOperationId === request.operationId;
    }
    return true;
}
const ISOLATED_RUNTIME_DEMAND_CAUSES = new Set([
    "run-start",
    "chat",
    "scheduled",
    "manual",
]);
function parkedActivationLease(lease, now, error) {
    return {
        ...lease,
        status: "parked",
        parkedAt: now,
        ...(error
            ? {
                lastError: {
                    at: now,
                    ...error,
                },
            }
            : {}),
    };
}
function returningLeaseCanComplete(lease) {
    return [
        lease.status === "returning",
        typeof lease.leaseId === "string",
        Number.isSafeInteger(lease.generation),
    ].every(Boolean);
}
function pendingDemandIdentity(pending) {
    let eventKey = null;
    if (typeof pending.eventKey === "string" && pending.eventKey.length > 0) {
        eventKey = pending.eventKey;
    }
    let cause = null;
    if (typeof pending.cause === "string" && ISOLATED_RUNTIME_DEMAND_CAUSES.has(pending.cause)) {
        cause = pending.cause;
    }
    return {
        eventKey,
        cause,
        observedAt: readMillis(pending.observedAt),
    };
}
export function nextCompletedActivationLease(input) {
    if (!returningLeaseCanComplete(input.lease))
        return null;
    const pending = fieldMap(input.lease.pendingDemand);
    if (!pending) {
        return parkedActivationLease(input.lease, input.now);
    }
    const { eventKey, cause, observedAt } = pendingDemandIdentity(pending);
    const slug = input.user.slug;
    const sizingKey = input.sizingKey;
    const sizingTier = isolatedSizingTier(input.sizingProfile);
    if (!eventKey || !cause || observedAt === null || !slug) {
        return parkedActivationLease(input.lease, input.now, {
            code: "pending-demand-invalid",
            message: "pending return demand was malformed",
        });
    }
    if (!userAllowsInteractiveAccess(input.user)) {
        return parkedActivationLease(input.lease, input.now, {
            code: "pending-demand-not-authorized",
            message: "pending demand was parked because interactive access ended",
        });
    }
    if (!sizingKey) {
        return parkedActivationLease(input.lease, input.now, {
            code: "pending-demand-not-entitled",
            message: "pending demand was parked because user entitlement ended",
        });
    }
    if (!sizingTier) {
        return parkedActivationLease(input.lease, input.now, {
            code: "pending-demand-manual-size-required",
            message: "pending demand requires an operator-selected instance size",
        });
    }
    return {
        leaseId: input.nextLeaseId,
        generation: input.lease.generation + 1,
        status: "requested",
        cause,
        eventKey,
        requestedAt: input.now,
        lastActiveAt: observedAt,
        requestedBy: "pending-return-demand",
        builderSlug: slug,
        sourceGatewayId: input.sourceGatewayId,
        sourceAssignmentEpoch: input.sourceAssignmentEpoch,
        entitlementTier: sizingKey,
        sizingTier,
    };
}
export function nextFailedActivationLease(lease, request, now) {
    if (lease.leaseId !== request.leaseId ||
        lease.generation !== request.generation ||
        lease.targetGatewayId !== request.targetGatewayId ||
        (lease.status !== "provisioning" && lease.status !== "activating")) {
        return null;
    }
    return {
        ...lease,
        status: "failed",
        failedAt: now,
        lastError: {
            at: now,
            code: "activation-migration-failed",
            message: request.message,
            operationId: request.operationId,
        },
    };
}
function leaseString(lease, key) {
    const value = lease[key];
    return typeof value === "string" && value.length > 0 ? value : null;
}
function buildPlacementReceipt(input) {
    const gatewayId = leaseString(input.lease, "targetGatewayId");
    if (!gatewayId) {
        throw new IsolatedGatewayFenceError(`activation lease for ${input.uid} has no runtime gateway for its placement receipt`);
    }
    return {
        schemaVersion: 1,
        kind: input.kind,
        at: input.now,
        builderSlug: leaseString(input.lease, "builderSlug"),
        leaseId: input.leaseId,
        generation: input.generation,
        cause: leaseString(input.lease, "cause"),
        sizingTier: leaseString(input.lease, "sizingTier"),
        entitlementTier: leaseString(input.lease, "entitlementTier"),
        gatewayId,
        sharedGatewayId: leaseString(input.lease, "sourceGatewayId"),
        requestedAt: readMillis(input.lease.requestedAt),
        wakeDurationMs: null,
        activeDurationMs: null,
        operationId: null,
        retirementOperationId: null,
        operatorTerminated: false,
        error: null,
        ...input.overrides,
    };
}
function durationSince(startedAt, now) {
    return startedAt === null ? null : Math.max(0, now - startedAt);
}
function returningActivationLeaseMatches(lease, request) {
    return [
        lease !== null,
        lease?.leaseId === request.leaseId,
        lease?.generation === request.generation,
        lease?.status === "returning",
        lease?.targetGatewayId === request.targetGatewayId,
    ].every(Boolean);
}
function servingAssignmentEpoch(assignment, uid, gatewayId) {
    return assignment !== null && assignment.uid === uid && assignment.gatewayId === gatewayId &&
        assignment.state === "serving" && Number.isSafeInteger(assignment.epoch)
        ? assignment.epoch
        : null;
}
function newHomeAdmitted(user, lease) {
    const home = fieldMap(user.home.homeStorage);
    const migration = fieldMap(user.home.homeMigration);
    return Boolean(home && home.admittedAt === undefined && migration?.phase === "complete" &&
        fieldMap(migration.proof)?.status === "ready" && fieldMap(migration.target)?.id === fieldMap(home.disk)?.id &&
        user.gateway?.gatewayId === lease.targetGatewayId);
}
export async function advanceActivationLease(input, given, mode = "apply") {
    await input.store.transaction({ label: "disposable-gateway.advance-lease", readOnly: mode === "plan" }, async (transaction) => {
        await input.requireOwner(transaction);
        const user = await transaction.users.records.get(given.uid);
        const lease = user?.activationLease ?? null;
        if (!user || !lease) {
            throw new IsolatedGatewayFenceError(`activation lease for ${given.uid} is missing`);
        }
        const request = withCanonicalOperationId(lease, given);
        const now = input.now();
        const next = nextActivationLease(lease, request, now);
        if (!next) {
            if (activationLeaseAdvanceAlreadyApplied(lease, request)) {
                return;
            }
            throw new IsolatedGatewayFenceError(`activation lease for ${request.uid} changed`);
        }
        if (mode === "plan")
            return;
        const admitHome = request.toStatus === "active" && newHomeAdmitted(user, lease);
        const backupRelease = request.toStatus === "active" ? await planRestoredHomeBackupRelease(transaction, user, lease, now) : null;
        if (request.toStatus === "active") {
            await transaction.users.placementReceipts.create(request.uid, buildPlacementReceipt({
                kind: "activated",
                uid: request.uid,
                lease,
                leaseId: request.leaseId,
                generation: request.generation,
                now,
                overrides: {
                    wakeDurationMs: durationSince(readMillis(lease.requestedAt), now),
                    operationId: leaseString(lease, "activationOperationId"),
                },
            }));
        }
        await transaction.users.records.setActivationLease(request.uid, next, exactLeaseFence(lease, [request.fromStatus]));
        if (backupRelease)
            await transaction.journal.operations.create(backupRelease);
        if (admitHome) {
            await transaction.users.records.patch(request.uid, { home: { homeStorage: { ...user.home.homeStorage, admittedAt: now } } });
        }
    });
}
export async function completeActivationLease(input, request, mode = "apply") {
    const nextLeaseId = (input.leaseIdFactory ?? randomUUID)();
    await checkPlacementOwner(input);
    const sizingKeyRead = { store: input.store, readSizingKey: input.readSizingKey, uid: request.uid, now: input.now() };
    await withCurrentSizingKey(sizingKeyRead, ({ sizingKey, profile: sizingProfile, assertCurrent }) => input.store.transaction({ label: "disposable-gateway.complete-lease", readOnly: mode === "plan" }, async (transaction) => {
        await input.requireOwner(transaction);
        const user = await transaction.users.records.get(request.uid);
        assertCurrent(user);
        const lease = user?.activationLease ?? null;
        if (!user || !returningActivationLeaseMatches(lease, request)) {
            throw new IsolatedGatewayFenceError(`returning activation lease for ${request.uid} changed`);
        }
        const sourceGatewayId = user.gateway?.gatewayId ?? null;
        if (!sourceGatewayId || sourceGatewayId === request.targetGatewayId) {
            throw new IsolatedGatewayFenceError(`User ${request.uid} has not returned from ${request.targetGatewayId}`);
        }
        const completed = (sourceAssignmentEpoch) => nextCompletedActivationLease({
            lease,
            user,
            sizingKey,
            sizingProfile,
            sourceGatewayId,
            sourceAssignmentEpoch,
            nextLeaseId,
            now: input.now(),
        });
        let next = completed(0);
        if (!next) {
            throw new IsolatedGatewayFenceError(`returning activation lease for ${request.uid} is invalid`);
        }
        if (next.status === "requested") {
            const assignmentEpoch = servingAssignmentEpoch(await transaction.gateways.assignments.get(sourceGatewayId, request.uid), request.uid, sourceGatewayId);
            next = assignmentEpoch === null
                ? parkedActivationLease(lease, input.now(), {
                    code: "pending-demand-assignment-unavailable",
                    message: "pending demand was parked because the shared assignment fence was unavailable",
                })
                : completed(assignmentEpoch);
        }
        if (!next) {
            throw new IsolatedGatewayFenceError(`returning activation lease for ${request.uid} is invalid`);
        }
        if (mode === "plan")
            return;
        const now = input.now();
        await transaction.users.placementReceipts.create(request.uid, buildPlacementReceipt({
            kind: "returned",
            uid: request.uid,
            lease,
            leaseId: request.leaseId,
            generation: request.generation,
            now,
            overrides: {
                sharedGatewayId: sourceGatewayId,
                activeDurationMs: durationSince(readMillis(lease.activeAt), now),
                operationId: leaseString(lease, "returnOperationId"),
                retirementOperationId: request.parked
                    ? null
                    : placementRetireOperationId(request.uid, request.targetGatewayId, request.generation),
                operatorTerminated: readMillis(lease.operatorTerminateRequestedAt) !== null,
            },
        }));
        await transaction.users.records.setActivationLease(request.uid, next, exactLeaseFence(lease, ["returning"]));
    }));
}
export async function failActivationLease(input, request, mode = "apply") {
    await input.store.transaction({ label: "disposable-gateway.fail-lease", readOnly: mode === "plan" }, async (transaction) => {
        await input.requireOwner(transaction);
        const user = await transaction.users.records.get(request.uid);
        const lease = user?.activationLease ?? null;
        if (!user || !lease) {
            throw new IsolatedGatewayFenceError(`activation lease for ${request.uid} is missing`);
        }
        const now = input.now();
        const next = nextFailedActivationLease(lease, request, now);
        if (!next) {
            if (lease.leaseId === request.leaseId &&
                lease.generation === request.generation &&
                lease.status === "failed") {
                return;
            }
            throw new IsolatedGatewayFenceError(`activation lease for ${request.uid} changed before failure cleanup`);
        }
        await assertActivationSourceRecoveryReleased(input, transaction, {
            targetGatewayId: request.targetGatewayId,
            generation: request.generation,
            failedActivationCleanup: request.operationId === builderActivateOperationId(request.targetGatewayId, request.generation),
        });
        if (mode === "plan")
            return;
        await transaction.users.placementReceipts.create(request.uid, buildPlacementReceipt({
            kind: "activation-failed",
            uid: request.uid,
            lease,
            leaseId: request.leaseId,
            generation: request.generation,
            now,
            overrides: {
                wakeDurationMs: durationSince(readMillis(lease.requestedAt), now),
                operationId: request.operationId,
                retirementOperationId: placementRetireOperationId(request.uid, request.targetGatewayId, request.generation),
                error: request.message,
            },
        }));
        await transaction.users.records.setActivationLease(request.uid, next, exactLeaseFence(lease, ["provisioning", "activating"]));
    });
}
export function nextSizingKeyTransitionLease(user, sizingKey, request, now) {
    const lease = user.activationLease;
    if (!lease || lease.status !== "active" || lease.leaseId !== request.leaseId || lease.generation !== request.generation ||
        lease.targetGatewayId !== request.targetGatewayId || user.gateway?.gatewayId !== request.targetGatewayId ||
        !userAllowsInteractiveAccess(user) || sizingKey !== request.sizingKey) {
        throw new IsolatedGatewayFenceError("User tier transition authority changed");
    }
    return { ...lease, returnRequestedAt: now, returnReason: "tier-change", pendingDemand: {
            cause: "manual", eventKey: `tier:${request.leaseId}:${request.generation}:${request.sizingKey}`, observedAt: now,
        } };
}
export async function requestSizingKeyTransition(input, request, mode = "apply") {
    await checkPlacementOwner(input);
    const sizingProfile = await input.store.config.orchestrator.getSizingProfile(request.sizingKey);
    if (sizingProfile.isolation !== "isolated")
        throw new IsolatedGatewayFenceError("User tier requires an operator-selected VM policy");
    const vmProfile = sizingProfile.computer;
    const transition = async () => {
        const now = input.now();
        const sizingKeyRead = { store: input.store, readSizingKey: input.readSizingKey, uid: request.uid, now };
        await withCurrentSizingKey(sizingKeyRead, ({ sizingKey, assertCurrent }) => input.store.transaction({ label: "disposable-gateway.tier-transition", readOnly: mode === "plan" }, async (transaction) => {
            await input.requireOwner(transaction);
            const user = await transaction.users.records.get(request.uid);
            assertCurrent(user);
            if (!user)
                throw new IsolatedGatewayFenceError("User owner disappeared");
            const lease = nextSizingKeyTransitionLease(user, sizingKey, request, now);
            if (mode === "plan")
                return;
            await transaction.users.records.setActivationLease(request.uid, lease, exactLeaseFence(lease, ["active"]));
        }));
    };
    if (mode === "plan") {
        await transition();
        return;
    }
    await input.mutations({
        actor: ISOLATED_GATEWAY_LIFECYCLE_ACTOR, forced: false, what: "change-builder-tier", why: "Apply the current sizing profile while preserving home data",
        target: { uid: request.uid, gatewayId: request.targetGatewayId }, preActionStatus: { leaseId: request.leaseId, generation: request.generation },
        mutation: { tier: request.sizingKey, desiredHomeGiB: vmProfile.homeSizeGiB },
        action: transition,
    });
}
