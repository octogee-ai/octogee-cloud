import { readSchedulerMigrationIdentity } from "@octogee/shared/types/glm";
import { GATEWAY_HEARTBEAT_INTERVAL_MS, GATEWAY_UNREACHABLE_AFTER_MS, } from "@octogee/shared/types/fleet-controller";
import { isGatewayRuntimeDoc, projectGatewayDesiredRootForGateway, } from "@octogee/shared/types/gateway-releases";
import { findActiveGatewayMigration } from "./fleet-operation-lock.js";
import { readNativeReturnTargetDrain, sharedDrainPodMatches } from "./native-return-target-deny.js";
// Retirement under the simple-roll model (GATEWAY-SIMPLE-ROLL-SPEC): claim the
// gateway atomically (guarding mounted users + in-flight migrations), flip
// desiredStatus to retired, and let the reconciler tear the realization down.
// Durable config lives in Gitea the whole time — nothing is captured at
// retirement, so there is no wake phase and no config checkpoint ceremony.
export class GatewayRetirementConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = "GatewayRetirementConflictError";
    }
}
export class GatewayRetirementTelemetryUnavailableError extends GatewayRetirementConflictError {
    constructor(message) {
        super(message);
        this.name = "GatewayRetirementTelemetryUnavailableError";
    }
}
export class GatewayRetirementReleaseUnconvergedError extends GatewayRetirementConflictError {
    constructor(message) {
        super(message);
        this.name = "GatewayRetirementReleaseUnconvergedError";
    }
}
function isPlainRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function millis(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (value instanceof Date)
        return value.getTime();
    if (value &&
        typeof value === "object" &&
        typeof value.toMillis === "function") {
        try {
            const result = value.toMillis();
            return typeof result === "number" && Number.isFinite(result) ? result : null;
        }
        catch {
            return null;
        }
    }
    return null;
}
function freshObservation(value, now) {
    const observedAt = millis(value);
    return observedAt !== null &&
        observedAt <= now + GATEWAY_HEARTBEAT_INTERVAL_MS &&
        now - observedAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}
function retirementHeartbeat(value) {
    if (!isPlainRecord(value) ||
        !Array.isArray(value.mountedCustomers) ||
        !value.mountedCustomers.every((user) => typeof user === "string" && user.length > 0)) {
        return null;
    }
    return {
        heartbeat: value,
        mountedCustomers: value.mountedCustomers,
    };
}
function liveRuntimeIdentity(heartbeat) {
    if (typeof heartbeat.startedAt !== "number" ||
        !Number.isFinite(heartbeat.startedAt) ||
        !nonEmptyString(heartbeat.version) ||
        !nonEmptyString(heartbeat.openclawVersion)) {
        return null;
    }
    return {
        startedAt: heartbeat.startedAt,
        version: heartbeat.version,
        openclawVersion: heartbeat.openclawVersion,
    };
}
// A RUNNING gateway may retire only on fresh telemetry proving zero mounted
// users. A PAUSED gateway (replicas 0) has no pod, no mounts, and nothing
// unflushed (the watcher + preStop flush committed durable config at pause) —
// it retires directly, with no wake.
function runningRetirementError(gatewayId, runtime, now, expectedRelease, telemetryObservedAfter) {
    if (!isGatewayRuntimeDoc(runtime) || runtime.gatewayId !== gatewayId) {
        return {
            error: `gateway ${gatewayId} runtime telemetry is unavailable`,
            telemetryUnavailable: true,
            liveRuntimeIdentity: null,
        };
    }
    if (runtime.release !== expectedRelease) {
        return {
            error: `gateway ${gatewayId} runtime release ${runtime.release} does not match live release ${expectedRelease}`,
            liveRuntimeIdentity: null,
        };
    }
    const telemetry = retirementHeartbeat(runtime.heartbeat);
    if (!telemetry) {
        return {
            error: `gateway ${gatewayId} mount telemetry is unavailable`,
            telemetryUnavailable: true,
            liveRuntimeIdentity: null,
        };
    }
    if (telemetry.mountedCustomers.length > 0) {
        return {
            error: `gateway ${gatewayId} still has mounted users: ${telemetry.mountedCustomers.join(", ")}`,
            liveRuntimeIdentity: null,
        };
    }
    const { heartbeat } = telemetry;
    if (!freshObservation(heartbeat.lastHeartbeatAt, now)) {
        return {
            error: `gateway ${gatewayId} telemetry is stale or unavailable`,
            telemetryUnavailable: true,
            liveRuntimeIdentity: null,
        };
    }
    const observedAt = millis(heartbeat.lastHeartbeatAt);
    if (telemetryObservedAfter !== undefined &&
        observedAt <= telemetryObservedAfter) {
        return {
            error: `gateway ${gatewayId} telemetry predates retirement fence`,
            liveRuntimeIdentity: null,
        };
    }
    return { error: null, liveRuntimeIdentity: liveRuntimeIdentity(heartbeat) };
}
function unconvergedRetirementError(gatewayId, runtime) {
    const mountedCustomers = isGatewayRuntimeDoc(runtime) && runtime.gatewayId === gatewayId
        ? retirementHeartbeat(runtime.heartbeat)?.mountedCustomers ?? []
        : [];
    return mountedCustomers.length > 0
        ? new GatewayRetirementConflictError(`gateway ${gatewayId} still has mounted users: ${mountedCustomers.join(", ")}`)
        : new GatewayRetirementReleaseUnconvergedError(`gateway ${gatewayId} desired release is not converged to live`);
}
function readClaim(value) {
    if (!isPlainRecord(value))
        return null;
    const valid = [
        typeof value.operationId === "string",
        Number.isInteger(value.version),
        value.version > 0,
        typeof value.claimedAt === "number",
        Number.isFinite(value.claimedAt),
        value.previousDesiredStatus === "running" || value.previousDesiredStatus === "draining" || value.previousDesiredStatus === "paused",
        value.phase === "claimed",
    ].every(Boolean);
    if (!valid)
        return null;
    return value;
}
function nextRetirementVersion(value) {
    if (value === undefined || value === null)
        return 1;
    if (!Number.isInteger(value) || value < 0) {
        throw new GatewayRetirementConflictError("gateway retirement version is invalid");
    }
    return value + 1;
}
function claimableGatewayRetirementRoot(gatewayId, value) {
    const projected = projectGatewayDesiredRootForGateway(value, gatewayId);
    if (projected === null) {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} durable root is unavailable`);
    }
    const root = projected;
    if (projected.desiredStatus === "retired") {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} is already retired`);
    }
    if (root.retirementClaim != null) {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} already has a retirement claim`);
    }
    return {
        rootData: projected,
        root,
    };
}
export function isolatedRuntimeMutationFenced(user) {
    return user.fences.restoreFence !== undefined || user.fences.sourceTransferFence !== undefined;
}
export async function gatewayRetiredInStore(transaction, gatewayId) {
    const root = await transaction.gateways.roots.get(gatewayId);
    if (root === null)
        return true;
    const operationId = root.retirementClaim?.operationId;
    if (root.desiredStatus !== "retired" || typeof operationId !== "string")
        return false;
    const retirement = await transaction.journal.operations.get(operationId);
    return retirement?.kind === "retire-gateway" && retirement.status === "succeeded" && retirement.input?.gatewayId === gatewayId;
}
export async function assertGatewayRuntimeMutationUnfencedInStore(transaction, gatewayId, allowedVmRecoveryOperationId) {
    const root = await transaction.gateways.roots.get(gatewayId);
    if (root?.runtimeRestartFence !== undefined) {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} runtime restart outcome is unresolved`);
    }
    const holders = await transaction.users.records.listGatewayFenceHolders(gatewayId);
    if (holders.computerRecovery.some(user => !allowedVmRecoveryOperationId || user.fences.computerRecovery?.operationId !== allowedVmRecoveryOperationId)) {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} VM recovery is in progress`);
    }
    if (holders.sourceTransferSource.length > 0 || holders.sourceTransferTarget.length > 0 || holders.assigned.some(isolatedRuntimeMutationFenced)) {
        throw new GatewayRetirementConflictError(`gateway ${gatewayId} source transfer outcome is unresolved`);
    }
}
export function moveHasNotBegun(operation, gatewayId) {
    return operation.kind === "migrate-user" && operation.status === "pending" && operation.startedAt === null &&
        operation.input?.toGatewayId === gatewayId && !operation.attempts && operation.steps.length === 0 &&
        operation.userMigrationV2 === undefined && operation.schedulerHandoff === undefined &&
        operation.cutoverCommittedAt === undefined && operation.sourceTransferExecution === undefined;
}
function activeMigrationConflict(gatewayId, operations) {
    return findActiveGatewayMigration(gatewayId, operations.map((operation) => ({
        id: operation.id,
        kind: operation.kind,
        status: operation.status,
        input: operation.input,
        userMigrationV2: operation.userMigrationV2,
    }))) !== null;
}
function doneStepTime(steps, name) {
    const matches = steps.filter(step => step.name === name);
    const step = matches[0];
    return matches.length === 1 && step?.status === "done" &&
        typeof step.startedAt === "number" && Number.isSafeInteger(step.startedAt) &&
        typeof step.completedAt === "number" && Number.isSafeInteger(step.completedAt) &&
        step.startedAt <= step.completedAt ? { start: step.startedAt, end: step.completedAt } : null;
}
function matchesLegacyDepartureScope(op, old, destination, owner) {
    const handoff = op.schedulerHandoff;
    const forward = handoff?.forwardRecovery;
    const claim = readSchedulerMigrationIdentity(op.id, handoff?.migrationId);
    return [op.status === "succeeded", op.origin === "automatic", op.createdBy === "glm-controller-placement-policy",
        op.input.source === "continuous-placement-policy", op.userMigrationV2 === undefined, op.rolledBack !== true,
        op.inputUid === owner.uid, op.input.uid === owner.uid, op.input.userSlug === owner.slug,
        op.input.fromGatewayId === old, op.input.toGatewayId === destination,
        handoff?.uid === owner.uid, handoff?.slug === owner.slug, handoff?.fromGatewayId === old, handoff?.toGatewayId === destination,
        forward?.schemaVersion === 1, forward?.phase === "source-flushed", forward?.sourceEpoch === owner.epoch, claim !== null,
        claim?.attempt === op.attempts, claim?.claimStartedAt === op.startedAt].every(Boolean);
}
function legacyDepartureRecordedCutover(op, assignmentAt, holdStartedAt) {
    const { startedAt, completedAt, cutoverCommittedAt: committed, steps } = op;
    if (typeof startedAt !== "number" || typeof completedAt !== "number" ||
        typeof committed !== "number" || ![startedAt, completedAt, committed].every(Number.isSafeInteger))
        return false;
    const verify = doneStepTime(steps, "verify-target");
    const cutover = doneStepTime(steps, "cutover-firestore");
    const cleanup = doneStepTime(steps, "unmount-source");
    return !!verify && !!cutover && !!cleanup && [holdStartedAt <= startedAt, startedAt <= verify.start,
        verify.end <= cutover.start, cutover.start <= assignmentAt, assignmentAt <= committed, committed <= cutover.end,
        cutover.end <= cleanup.start, cleanup.end <= completedAt].every(Boolean);
}
async function drainedOwnerMoved(transaction, old, drain, owner) {
    const destination = drain.replacementGatewayId;
    const [ownerRecord, assignments] = await Promise.all([
        transaction.users.records.get(owner.uid), transaction.gateways.assignments.listForUid(owner.uid),
    ]);
    const assignment = assignments[0];
    if (!assignment || ![assignments.length === 1, assignment.gatewayId === destination,
        assignment.slug === owner.slug, assignment.epoch === owner.epoch + 1, assignment.state === "serving",
        ownerRecord?.gateway?.gatewayId === destination].every(Boolean))
        return false;
    if (assignment.updatedByOperationId) {
        const departure = await transaction.journal.operations.get(assignment.updatedByOperationId);
        return !!departure && [departure.kind === "migrate-user", departure.status === "succeeded", typeof departure.cutoverCommittedAt === "number",
            departure.input.uid === owner.uid, departure.input.fromGatewayId === old, departure.input.toGatewayId === destination].every(Boolean);
    }
    if (![assignment.updatedByOperationId === null, assignment.uid === owner.uid, ownerRecord?.slug === owner.slug,
        assignment.source === "migrate-user", assignment.createdAt === assignment.updatedAt].every(Boolean))
        return false;
    return readLegacyDrainDeparture(transaction, owner, { old, destination, at: assignment.updatedAt, holdStartedAt: drain.holdStartedAt });
}
async function readLegacyDrainDeparture(transaction, owner, scope) {
    const { old, destination, at, holdStartedAt } = scope;
    if (!Number.isSafeInteger(at) || typeof holdStartedAt !== "number" || !Number.isSafeInteger(holdStartedAt))
        return false;
    const history = await transaction.journal.operations.listForUid(owner.uid, { kind: "migrate-user" });
    const matching = history.filter(op => matchesLegacyDepartureScope(op, old, destination, owner));
    const departure = matching[0];
    return matching.length === 1 && !!departure && legacyDepartureRecordedCutover(departure, at, holdStartedAt) &&
        !history.some(op => op.id !== departure.id && typeof op.cutoverCommittedAt === "number" && op.cutoverCommittedAt >= at);
}
async function nativeReturnRetirementHolds(transaction, old, active, now) {
    for (const operation of active) {
        if (![operation.status === "pending", operation.startedAt === null, operation.input.toGatewayId === old,
            operation.schedulerHandoff?.forwardRecovery?.phase === "source-flushed", operation.cutoverCommittedAt === undefined].every(Boolean))
            continue;
        const drain = await readNativeReturnTargetDrain(transaction, operation);
        if (!drain || !await transaction.gateways.assignments.isEmpty(old))
            continue;
        const [left, tasks, oldRuntime, replacement, departed] = await Promise.all([
            transaction.users.records.listByGateway(old, { limit: 1 }), transaction.migrationTasks.listByStatus(["running"]),
            transaction.fleetRegistry.get(old), transaction.fleetRegistry.get(drain.replacementGatewayId),
            Promise.all(drain.owners.map(owner => drainedOwnerMoved(transaction, old, drain, owner))),
        ]);
        if (!sharedDrainPodMatches(oldRuntime, drain.oldPodUid, now) || !sharedDrainPodMatches(replacement, drain.replacementPodUid, now))
            continue;
        if (![left.length === 0, !oldRuntime.heartbeat.migratingIn?.length, replacement.heartbeat.status === "ready",
            drain.owners.every(owner => replacement.heartbeat.mountedCustomers.includes(owner.slug)),
            !tasks.some(task => task.targetGatewayId === old || task.sourceGatewayId === old), departed.every(Boolean)].every(Boolean))
            continue;
        return { operationId: operation.id, dormantInboundOperationIds: drain.dormantInboundOperationIds };
    }
    return null;
}
async function supersededRetirementMigrations(transaction, input, active, shared) {
    const nativeHold = shared && input.operation.input.source === "shared-pool-scaler"
        ? await nativeReturnRetirementHolds(transaction, input.gatewayId, active, input.now) : null;
    const reasons = new Map(input.supersededMoves?.operationIds.map(id => [id, input.supersededMoves.cancelledBecause]));
    for (const operation of active) {
        if (nativeHold?.dormantInboundOperationIds.includes(operation.id) && moveHasNotBegun(operation, input.gatewayId) && !reasons.has(operation.id)) {
            reasons.set(operation.id, "Shared destination retired before the move started");
        }
    }
    const stillWaiting = active.filter(operation => reasons.has(operation.id) && moveHasNotBegun(operation, input.gatewayId));
    if (stillWaiting.length !== reasons.size || activeMigrationConflict(input.gatewayId, active.filter(operation => !reasons.has(operation.id) && operation.id !== nativeHold?.operationId))) {
        throw new GatewayRetirementConflictError(`user migration is in flight for gateway ${input.gatewayId}`);
    }
    return stillWaiting.map(operation => ({ id: operation.id, reason: reasons.get(operation.id) }));
}
function inspectRetirementRuntime(input, root, runtime) {
    if (root.desiredRelease !== root.liveRelease) {
        throw unconvergedRetirementError(input.gatewayId, runtime);
    }
    const inspection = runningRetirementError(input.gatewayId, runtime, input.now, root.liveRelease, input.telemetryObservedAfter);
    if (inspection.error) {
        throw inspection.telemetryUnavailable
            ? new GatewayRetirementTelemetryUnavailableError(inspection.error)
            : new GatewayRetirementConflictError(inspection.error);
    }
    return inspection.liveRuntimeIdentity;
}
export async function claimGatewayRetirementInStore(input) {
    return input.store.transaction({ label: "gateway-retirement.claim", readOnly: input.plan === true }, async (transaction) => {
        await input.ownerGuard?.(transaction);
        const [stored, activeOperations] = await Promise.all([
            transaction.gateways.roots.get(input.gatewayId),
            transaction.journal.operations.listByStatus(["pending", "running"]),
        ]);
        const { rootData } = claimableGatewayRetirementRoot(input.gatewayId, stored ?? undefined);
        const stillWaiting = await supersededRetirementMigrations(transaction, input, activeOperations, stored?.gatewayClass === "shared");
        await assertGatewayRuntimeMutationUnfencedInStore(transaction, input.gatewayId);
        let liveRuntimeIdentity = null;
        if (rootData.desiredStatus !== "paused" && rootData.liveRelease != null) {
            const registry = await transaction.fleetRegistry.get(input.gatewayId);
            liveRuntimeIdentity = inspectRetirementRuntime(input, rootData, registry === null ? undefined : { ...registry, docKind: "runtime" });
        }
        await input.claimGuard?.({ transaction, root: rootData });
        const version = nextRetirementVersion(rootData.retirementVersion);
        if (input.plan === true)
            return { version };
        const claim = {
            operationId: input.operationId,
            version,
            claimedAt: input.now,
            phase: "claimed",
            liveRelease: rootData.liveRelease,
            liveRuntimeIdentity,
            previousDesiredStatus: rootData.desiredStatus,
        };
        await transaction.gateways.roots.patch(input.gatewayId, {
            desiredStatus: "retired",
            retirementVersion: version,
            retirementClaim: claim,
            updatedAt: input.now,
            updatedBy: input.updatedBy,
        }, { retirementVersion: rootData.retirementVersion ?? null, updatedAt: rootData.updatedAt });
        for (const { id, reason } of stillWaiting) {
            await transaction.journal.operations.patch(id, {
                status: "failed",
                completedAt: input.now,
                error: reason,
                nextAttemptAt: { clear: true },
            }, { status: ["pending"], startedAt: null });
        }
        await transaction.journal.operations.put({
            ...input.operation,
            id: input.operationId,
            input: { ...input.operation.input, retirementClaimVersion: version },
        });
        return { version };
    });
}
function matchingRetirementClaim(root, operationId, version) {
    const claim = readClaim(root.retirementClaim);
    return claim?.operationId === operationId && claim.version === version ? claim : null;
}
export async function verifyGatewayRetirementClaimAtomic(input) {
    return input.store.transaction({ label: "gateway-retirement.verify", readOnly: true }, async (transaction) => {
        const root = await transaction.gateways.roots.get(input.gatewayId);
        if (root === null) {
            return { ok: false, error: `gateway ${input.gatewayId} durable root is unavailable` };
        }
        const claim = matchingRetirementClaim(root, input.operationId, input.version);
        if (!claim) {
            return {
                ok: false,
                error: `gateway ${input.gatewayId} retirement claim does not match this operation`,
            };
        }
        if (root.desiredStatus !== "retired") {
            return {
                ok: false,
                error: `gateway ${input.gatewayId} desiredStatus left retired during retirement`,
            };
        }
        try {
            await assertGatewayRuntimeMutationUnfencedInStore(transaction, input.gatewayId);
        }
        catch (error) {
            if (!(error instanceof GatewayRetirementConflictError))
                throw error;
            return { ok: false, error: error.message };
        }
        return { ok: true };
    });
}
