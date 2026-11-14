import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { hasFreshReadyKubernetesObservation, isReleasePayload, projectGatewayDesiredRootForGateway, releasePayloadHash, } from "@octogee/shared/types/gateway-releases";
import { gatewayArtifactFromReleasePayload } from "./gateway-live-release.js";
import { readSharedGatewayPoolConfigInStore } from "./shared-gateway-pool-read.js";
import { FleetMutationIdempotencyError, runNormalFleetMutation, } from "./normal-fleet-mutation.js";
const ACTOR = "glm-controller-placement-policy";
function recoveryOperationId(input) {
    return `recover-shared-roll-${input.sourceGatewayId}-to-${input.targetGatewayId}-r${input.expectedDesiredRelease}-to-r${input.expectedLiveRelease}`;
}
function recoveryIdempotencyKey(input) {
    return [
        "shared-peer-roll-recovery",
        input.sourceGatewayId,
        input.targetGatewayId,
        input.expectedDesiredRelease,
        input.expectedLiveRelease,
    ].join(":");
}
function isPositiveRelease(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function gatewayRootOf(root, gatewayId) {
    return projectGatewayDesiredRootForGateway(root, gatewayId);
}
function gatewayRuntimeOf(record) {
    return record === undefined ? null : { ...record, docKind: "runtime" };
}
function runtimeIsServingLiveRelease(runtime, input, now) {
    if (!runtime)
        return false;
    return [
        runtime.gatewayId === input.targetGatewayId,
        runtime.release === input.expectedLiveRelease,
        runtime.lifecycle === "serving",
        runtime.heartbeat.status === "ready",
        hasFreshReadyKubernetesObservation(runtime, now, input.targetHeartbeatMaxAgeMs ?? GATEWAY_UNREACHABLE_AFTER_MS),
    ].every(Boolean);
}
function sourceHasFreshMissingKubernetesObservation(runtime, input, now) {
    const observedAt = runtime?.kubernetes?.observedAt;
    const maxAge = input.targetHeartbeatMaxAgeMs ?? GATEWAY_UNREACHABLE_AFTER_MS;
    return runtime?.gatewayId === input.sourceGatewayId &&
        runtime.kubernetes?.status === "missing" &&
        typeof observedAt === "number" &&
        now >= observedAt &&
        now - observedAt <= maxAge;
}
function targetRosterIsServing(assignments, runtime) {
    const mounted = new Set(runtime?.heartbeat.mountedCustomers ?? []);
    return assignments.every((assignment) => assignment.state === "serving" &&
        typeof assignment.slug === "string" &&
        mounted.has(assignment.slug));
}
function activeMigrationTargetsGateway(operations, gatewayId) {
    return operations.some((operation) => {
        if (operation.kind !== "migrate-user")
            return false;
        const input = operation.input;
        const migration = operation.userMigrationV2;
        const fields = [
            input && typeof input === "object" && !Array.isArray(input)
                ? input
                : null,
            migration && typeof migration === "object" && !Array.isArray(migration)
                ? migration
                : null,
        ];
        return fields.some((field) => field?.fromGatewayId === gatewayId ||
            field?.toGatewayId === gatewayId ||
            field?.sourceGatewayId === gatewayId ||
            field?.targetGatewayId === gatewayId);
    });
}
function matchingRecoveryOperation(value, input, release) {
    const operationInput = value.input;
    if (!operationInput || typeof operationInput !== "object" || Array.isArray(operationInput)) {
        return false;
    }
    const record = operationInput;
    const recovery = record.sharedPeerRollRecovery;
    if (!recovery || typeof recovery !== "object" || Array.isArray(recovery))
        return false;
    const detail = recovery;
    return [
        value.kind === "rollout",
        record.gatewayId === input.targetGatewayId,
        record.targetRelease === release,
        detail.sourceGatewayId === input.sourceGatewayId,
        detail.targetGatewayId === input.targetGatewayId,
        detail.supersededRelease === input.expectedDesiredRelease,
        detail.sourceRelease === input.expectedLiveRelease,
    ].every(Boolean);
}
function recoveryRollIsEligible(state, input) {
    const { target, source, pool } = state;
    if (!target || !source || !pool)
        return false;
    return [
        pool.sharedGatewayIds.includes(input.sourceGatewayId),
        pool.sharedGatewayIds.includes(input.targetGatewayId),
        source.gatewayClass === "shared",
        target.gatewayClass === "shared",
        source.desiredStatus === "running",
        target.desiredStatus === "running",
        target.liveRelease === input.expectedLiveRelease,
        target.desiredRelease === input.expectedDesiredRelease,
        target.latestRelease === input.expectedDesiredRelease,
        runtimeIsServingLiveRelease(state.runtime, input, state.now),
        sourceHasFreshMissingKubernetesObservation(state.sourceRuntime, input, state.now),
        targetRosterIsServing(state.assignments, state.runtime),
        !activeMigrationTargetsGateway(state.operations, input.targetGatewayId),
    ].every(Boolean);
}
function validReleasePayload(release) {
    const payload = release?.payload;
    if (!payload || !isReleasePayload(payload))
        return null;
    return release.payloadHash === releasePayloadHash(payload) ? payload : null;
}
function recoveryRolloutOperation(input, operationId, release, payload, now) {
    const artifact = gatewayArtifactFromReleasePayload(payload);
    return {
        id: operationId,
        kind: "rollout",
        status: "pending",
        origin: "automatic",
        createdBy: ACTOR,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        input: {
            gatewayId: input.targetGatewayId,
            targetRelease: release,
            imageTag: artifact.imageTag,
            imageRepository: artifact.imageRepository,
            sharedPeerRollRecovery: {
                sourceGatewayId: input.sourceGatewayId,
                targetGatewayId: input.targetGatewayId,
                supersededRelease: input.expectedDesiredRelease,
                sourceRelease: input.expectedLiveRelease,
            },
        },
        steps: [],
        gatewayId: input.targetGatewayId,
    };
}
async function appendRecoveryRollback(deps, input) {
    const operationId = recoveryOperationId(input);
    return deps.store.transaction({ label: "shared-gateway-roll-recovery.append" }, async (transaction) => {
        const gatewayIds = [input.targetGatewayId, input.sourceGatewayId];
        const [roots, runtimes, pool, operation, assignments, operations] = await Promise.all([
            transaction.gateways.roots.getMany(gatewayIds),
            transaction.fleetRegistry.getMany(gatewayIds),
            readSharedGatewayPoolConfigInStore(transaction),
            transaction.journal.operations.get(operationId),
            transaction.gateways.assignments.list(input.targetGatewayId),
            transaction.journal.operations.listByStatus(["pending", "running"]),
        ]);
        const state = {
            target: gatewayRootOf(roots.get(input.targetGatewayId), input.targetGatewayId),
            source: gatewayRootOf(roots.get(input.sourceGatewayId), input.sourceGatewayId),
            pool,
            runtime: gatewayRuntimeOf(runtimes.get(input.targetGatewayId)),
            sourceRuntime: gatewayRuntimeOf(runtimes.get(input.sourceGatewayId)),
            assignments,
            operations,
            now: deps.now(),
        };
        if (!state.target || !recoveryRollIsEligible(state, input)) {
            return { kind: "not-eligible" };
        }
        const release = state.target.latestRelease + 1;
        if (!isPositiveRelease(release)) {
            throw new Error(`shared peer recovery release is invalid for ${input.targetGatewayId}`);
        }
        if (operation !== null) {
            return matchingRecoveryOperation(operation, input, release)
                ? { kind: "already-scheduled", release, operationId }
                : { kind: "not-eligible" };
        }
        const [sourceRelease, replacementRelease] = await Promise.all([
            transaction.gateways.releases.get(input.targetGatewayId, input.expectedLiveRelease),
            transaction.gateways.releases.get(input.targetGatewayId, release),
        ]);
        if (replacementRelease !== null) {
            throw new Error(`shared peer recovery release ${input.targetGatewayId}/r${release} already exists`);
        }
        const payload = validReleasePayload(sourceRelease);
        if (!payload) {
            throw new Error(`shared peer recovery source release ${input.targetGatewayId}/r${input.expectedLiveRelease} is invalid`);
        }
        await transaction.gateways.releases.append({
            gatewayId: input.targetGatewayId,
            expectedLatestRelease: state.target.latestRelease,
            createdAt: state.now,
            createdBy: ACTOR,
            sourceRelease: input.expectedLiveRelease,
            note: `shared peer recovery from ${input.sourceGatewayId}`,
            payload,
            payloadHash: releasePayloadHash(payload),
            activate: false,
            updatedBy: ACTOR,
        });
        await transaction.journal.operations.create(recoveryRolloutOperation(input, operationId, release, payload, state.now));
        return { kind: "scheduled", release, operationId };
    });
}
export async function supersedeRollingSharedGatewayRoll(deps, input) {
    try {
        return await runNormalFleetMutation(deps.store, {
            actor: ACTOR,
            forced: false,
            what: "supersede rolling shared gateway",
            why: "shared gateway recovery",
            target: { gatewayId: input.targetGatewayId },
            preActionStatus: {
                sourceGatewayId: input.sourceGatewayId,
                expectedLiveRelease: input.expectedLiveRelease,
                expectedDesiredRelease: input.expectedDesiredRelease,
            },
            mutation: {
                kind: "supersede-rolling-shared-gateway",
                sourceGatewayId: input.sourceGatewayId,
                targetGatewayId: input.targetGatewayId,
                expectedLiveRelease: input.expectedLiveRelease,
                expectedDesiredRelease: input.expectedDesiredRelease,
            },
            idempotencyKey: recoveryIdempotencyKey(input),
            now: deps.now,
            action: () => appendRecoveryRollback(deps, input),
            classifyResult: (result) => result.kind === "scheduled"
                ? {
                    outcome: "completed",
                    releaseRollout: {
                        releaseId: `${input.targetGatewayId}/${result.release}`,
                        rolloutOperationId: result.operationId,
                    },
                }
                : {
                    outcome: "partial",
                    partialOutcome: {
                        summary: "shared peer recovery no longer eligible",
                        details: { targetGatewayId: input.targetGatewayId },
                    },
                },
        });
    }
    catch (error) {
        if (!(error instanceof FleetMutationIdempotencyError))
            throw error;
        const audit = await deps.store.journal.audits.get(error.auditId);
        const linkage = audit?.releaseRollout;
        if (audit?.status === "completed" &&
            linkage &&
            typeof linkage === "object" &&
            typeof linkage.rolloutOperationId === "string" &&
            typeof linkage.releaseId === "string") {
            const releaseId = linkage.releaseId;
            const release = Number(releaseId.split("/").at(-1));
            if (Number.isSafeInteger(release) && release >= 1) {
                return {
                    kind: "already-scheduled",
                    release,
                    operationId: linkage.rolloutOperationId,
                };
            }
        }
        throw error;
    }
}
