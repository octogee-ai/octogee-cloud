import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import { builderReturnOperationId, isolatedRecoverOperationId, placementRetireOperationId, } from "@octogee/shared/types/isolated-operation-ids";
import { GatewayRetirementConflictError, claimGatewayRetirementInStore, } from "../gateway-retirement-claim.js";
import { withCurrentSizingKey } from "../sizing-key.js";
import { FenceMismatchError } from "../platform-state/errors.js";
import { ISOLATED_GATEWAY_ALLOCATION_KIND, PLACEMENT_AUTOMATION_ACTOR, ROLLED_BACK_STATUS, checkPlacementOwner, fieldMap, readMillis, assertActivationSourceRecoveryReleased, } from "./inputs.js";
import { readActiveParkedPrewarm } from "./prewarm.js";
import { retainsEntitledParkedCohort } from "./repark.js";
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
function leaseView(value) {
    const raw = fieldMap(value);
    const leaseId = nonEmptyString(raw?.leaseId);
    const generation = Number.isSafeInteger(raw?.generation) && raw.generation > 0 ? raw.generation : null;
    const status = nonEmptyString(raw?.status);
    if (!raw || !leaseId || !generation || !status)
        return null;
    return { raw, leaseId, generation, status, targetGatewayId: nonEmptyString(raw.targetGatewayId) };
}
function userGatewayId(userRecord) {
    return nonEmptyString(userRecord?.gateway?.gatewayId);
}
function recoveryTargetMatchesRequest(root, request) {
    const allocation = root?.allocation;
    return root !== null &&
        root.ownerUid === request.uid &&
        root.gatewayClass !== "shared" &&
        root.desiredStatus !== "retired" &&
        allocation?.kind === ISOLATED_GATEWAY_ALLOCATION_KIND &&
        allocation.claimedByUid === request.uid &&
        allocation.leaseId === request.leaseId &&
        allocation.generation === request.generation;
}
function recoveryTargetBecameReady(input) {
    const { root, runtime, request, now } = input;
    const heartbeatAt = runtime === null ? null : readMillis(runtime.heartbeat.lastHeartbeatAt);
    return root.desiredStatus === "running" &&
        runtime !== null &&
        runtime.gatewayId === request.gatewayId &&
        root.liveRelease !== null &&
        runtime.release === root.liveRelease &&
        runtime.lifecycle === "serving" &&
        runtime.heartbeat.status === "ready" &&
        heartbeatAt !== null &&
        now() - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS;
}
function recoveryAuthorityMatches(input) {
    const { userRecord, assignment, request } = input;
    const lease = leaseView(userRecord?.activationLease);
    return (!request.sourceUnavailable || (lease?.leaseId === request.leaseId &&
        lease.generation === request.generation &&
        lease.status === "returning" &&
        lease.raw.returnReason === "source-unavailable")) &&
        userGatewayId(userRecord) === request.authoritativeGatewayId &&
        assignment?.uid === request.uid &&
        assignment.gatewayId === request.authoritativeGatewayId &&
        assignment.state === "serving";
}
async function exactRecoveryState(now, transaction, request) {
    const [stored, userRecord, assignment, runtime] = await Promise.all([
        transaction.gateways.roots.get(request.gatewayId),
        transaction.users.records.get(request.uid),
        transaction.gateways.assignments.get(request.authoritativeGatewayId, request.uid),
        transaction.fleetRegistry.get(request.gatewayId),
    ]);
    const root = projectGatewayDesiredRootForGateway(stored, request.gatewayId);
    if (stored === null || !recoveryTargetMatchesRequest(root, request)) {
        throw new GatewayRetirementConflictError(`gateway ${request.gatewayId} no longer matches unreachable recovery demand`);
    }
    if (!request.sourceUnavailable && recoveryTargetBecameReady({ root, runtime, request, now })) {
        throw new GatewayRetirementConflictError(`gateway ${request.gatewayId} became ready before recovery`);
    }
    if (!recoveryAuthorityMatches({ userRecord, assignment, request })) {
        throw new GatewayRetirementConflictError(`User ${request.uid} is no longer authoritative on ${request.authoritativeGatewayId}`);
    }
    return stored;
}
function assertPendingRecoveryReceiptMatches(receipt, request) {
    const receiptInput = receipt.input;
    if (receipt.kind !== "recover-unreachable-disposable" ||
        receiptInput.uid !== request.uid ||
        receiptInput.gatewayId !== request.gatewayId ||
        receiptInput.leaseId !== request.leaseId ||
        receiptInput.generation !== request.generation) {
        throw new GatewayRetirementConflictError(`recovery operation ${receipt.id} does not match unreachable demand`);
    }
}
function newRecoveryReceipt(operationId, request, startedAt) {
    return {
        id: operationId,
        kind: "recover-unreachable-disposable",
        status: "pending",
        origin: "automatic",
        createdBy: PLACEMENT_AUTOMATION_ACTOR,
        createdAt: startedAt,
        startedAt,
        firstStartedAt: startedAt,
        completedAt: null,
        input: {
            uid: request.uid,
            userSlug: request.builderSlug,
            gatewayId: request.gatewayId,
            leaseId: request.leaseId,
            generation: request.generation,
            authoritativeGatewayId: request.authoritativeGatewayId,
        },
        steps: [],
        gatewayId: request.gatewayId,
        inputUid: request.uid,
    };
}
function unreachableRecoveryFence(request) {
    return { targetGatewayId: request.gatewayId, generation: request.generation, failedActivationCleanup: false };
}
export async function checkUnreachableRecoveryFence(input, request) {
    const operationId = isolatedRecoverOperationId(request.gatewayId, request.generation);
    await reserveUnreachableRecovery(input, request, operationId, "plan");
    return operationId;
}
export async function reserveUnreachableRecovery(input, request, operationId, mode = "apply") {
    await input.store.transaction({ label: "placement-policy.recovery-reserve", readOnly: mode === "plan" }, async (transaction) => {
        await input.requireOwner(transaction);
        const root = await exactRecoveryState(input.now, transaction, request);
        await assertActivationSourceRecoveryReleased(input, transaction, unreachableRecoveryFence(request));
        const receipt = await transaction.journal.recoveryReceipts.get(operationId);
        if (receipt !== null) {
            assertPendingRecoveryReceiptMatches(receipt, request);
            if (receipt.status === "succeeded")
                return;
            if (receipt.status !== "pending") {
                throw new GatewayRetirementConflictError(`recovery operation ${operationId} ended with ${receipt.status}`);
            }
            if (mode === "plan")
                return;
        }
        else if (mode === "plan") {
            return;
        }
        else {
            await transaction.journal.recoveryReceipts.create(newRecoveryReceipt(operationId, request, input.now()));
        }
        await transaction.gateways.roots.patch(request.gatewayId, {
            desiredStatus: "paused",
            updatedAt: input.now(),
            updatedBy: `${PLACEMENT_AUTOMATION_ACTOR}:${operationId}`,
        }, { updatedAt: root.updatedAt, allocationGeneration: root.allocation?.generation ?? null });
    });
}
export async function completeUnreachableRecovery(input, request, operationId) {
    await input.store.transaction({ label: "placement-policy.recovery-complete" }, async (transaction) => {
        await input.requireOwner(transaction);
        await exactRecoveryState(input.now, transaction, request);
        await assertActivationSourceRecoveryReleased(input, transaction, unreachableRecoveryFence(request));
        const receipt = await transaction.journal.recoveryReceipts.get(operationId);
        if (receipt?.status !== "pending") {
            if (receipt?.status === "succeeded")
                return;
            throw new GatewayRetirementConflictError(`recovery operation ${operationId} is unavailable`);
        }
        await transaction.journal.recoveryReceipts.patch(operationId, {
            status: "succeeded",
            completedAt: input.now(),
            recoveryReceipt: {
                schemaVersion: 1,
                observedAt: input.now(),
                pods: 0,
            },
        }, { revision: receipt.revision });
    });
}
function observationUnknown(diagnostics) {
    return Boolean(diagnostics.error) || diagnostics.status === "unknown";
}
export async function recoverUnreachableIsolatedGateway(input, request) {
    const operationId = isolatedRecoverOperationId(request.gatewayId, request.generation);
    await reserveUnreachableRecovery(input, request, operationId);
    let diagnostics;
    try {
        diagnostics = await input.readGatewayPodDiagnostics(request.gatewayId);
    }
    catch (error) {
        diagnostics = { status: "unknown", totalPods: 0, error: error instanceof Error ? error.message : String(error) };
    }
    if (observationUnknown(diagnostics) || diagnostics.status !== "missing" || diagnostics.totalPods !== 0) {
        const diagnosticError = diagnostics.error ? ` error=${diagnostics.error}` : "";
        input.log(`[placement-policy] recovery ${operationId} waiting for pod absence; status=${diagnostics.status} pods=${diagnostics.totalPods}${diagnosticError}`);
        return { state: "waiting", reason: observationUnknown(diagnostics) ? "observation-unknown" : "pods-present", operationId };
    }
    await completeUnreachableRecovery(input, request, operationId);
    return { state: "recovered", operationId };
}
function retirementAllocationMatches(root, request) {
    const allocation = fieldMap(root.allocation);
    const allocationIdentityMatches = request.leaseId === undefined ||
        (allocation?.kind === ISOLATED_GATEWAY_ALLOCATION_KIND &&
            allocation.claimedByUid === request.uid &&
            allocation.leaseId === request.leaseId &&
            allocation.generation === request.generation);
    return root.ownerUid === request.uid &&
        root.gatewayClass !== "shared" &&
        allocation?.kind === ISOLATED_GATEWAY_ALLOCATION_KIND &&
        allocation.generation === request.generation &&
        allocationIdentityMatches;
}
function retirementLeaseFenceAllows(input) {
    const lease = input.userRecord?.activationLease;
    return input.userRecord !== null &&
        input.userRecord.gateway?.gatewayId === input.authoritativeGatewayId &&
        lease?.leaseId === input.leaseId &&
        lease?.generation === input.generation &&
        lease?.status === input.expectedLeaseStatus &&
        lease?.targetGatewayId === input.targetGatewayId;
}
function retirementAssignmentFenceAllows(input) {
    return input.assignment?.uid === input.uid &&
        input.assignment.gatewayId === input.authoritativeGatewayId &&
        input.assignment.state === "serving";
}
export function retirementAuthorityFenceAllows(input) {
    return retirementLeaseFenceAllows(input) && retirementAssignmentFenceAllows(input);
}
async function assertRetirementAuthorityFence(transaction, request) {
    if (!request.authoritativeGatewayId)
        return;
    const [userRecord, assignment] = await Promise.all([
        transaction.users.records.get(request.uid),
        transaction.gateways.assignments.get(request.authoritativeGatewayId, request.uid),
    ]);
    if (!retirementAuthorityFenceAllows({
        uid: request.uid,
        authoritativeGatewayId: request.authoritativeGatewayId,
        targetGatewayId: request.gatewayId,
        leaseId: request.leaseId,
        generation: request.generation,
        expectedLeaseStatus: request.authoritativeLeaseStatus ?? "returning",
        userRecord,
        assignment,
    })) {
        throw new GatewayRetirementConflictError(`User ${request.uid} is no longer authoritatively returned to ${request.authoritativeGatewayId}`);
    }
}
function zeroWorkloadRecoveryReceiptMatches(recovery, request) {
    const recoveryInput = recovery?.input;
    const receipt = fieldMap(recovery?.recoveryReceipt);
    return recovery?.kind === "recover-unreachable-disposable" &&
        recovery.status === "succeeded" &&
        recoveryInput?.uid === request.uid &&
        recoveryInput.gatewayId === request.gatewayId &&
        recoveryInput.leaseId === request.leaseId &&
        recoveryInput.generation === request.generation &&
        receipt?.schemaVersion === 1 &&
        receipt.pods === 0;
}
async function assertZeroWorkloadRecoveryReceipt(transaction, request) {
    if (!request.zeroWorkloadRecoveryOperationId)
        return;
    const recovery = await transaction.journal.recoveryReceipts.get(request.zeroWorkloadRecoveryOperationId);
    if (!zeroWorkloadRecoveryReceiptMatches(recovery, request)) {
        throw new GatewayRetirementConflictError(`gateway ${request.gatewayId} zero-workload recovery receipt is unavailable`);
    }
}
function hasVerifiedReturnSteps(operation) {
    const steps = operation.steps ?? [];
    const carriedSteps = (operation.attemptHistory ?? []).flatMap(attempt => attempt.steps);
    if (operation.input.durableRecovery === true) {
        const required = ["exclude-old-writer", "restore-target", "stage-durable-scheduler", "verify-target", "activate-scheduler", "cutover-firestore"];
        return required.every(name => [...steps, ...carriedSteps].some(step => step.name === name && step.status === "done"));
    }
    return ["flush-source", "final-sync-state", "verify-target", "cutover-firestore"]
        .every(name => steps.some(step => step.name === name && step.status === "done"));
}
async function assertEphemeralReturnVerified(tx, request) {
    if (!["builder-returned", "operator-terminated"].includes(request.reason))
        return;
    if ((await tx.gateways.roots.get(request.gatewayId))?.allocation?.ephemeralHomeGiB === undefined)
        return;
    const refusal = () => new GatewayRetirementConflictError("ephemeral home requires a verified Shared return");
    if (request.generation === undefined || !request.authoritativeGatewayId)
        throw refusal();
    const operation = await tx.journal.operations.get(builderReturnOperationId(request.gatewayId, request.generation));
    if (operation?.status !== "succeeded" || operation.input.uid !== request.uid || operation.input.fromGatewayId !== request.gatewayId ||
        operation.input.toGatewayId !== request.authoritativeGatewayId || !hasVerifiedReturnSteps(operation))
        throw refusal();
}
async function readRetirementTelemetryFence(input, request) {
    if (request.telemetryFenceOperationId === undefined)
        return { blocked: null };
    const returnOperationId = request.telemetryFenceOperationId;
    const returnOperation = await input.store.journal.operations.get(returnOperationId);
    const completedAt = readMillis(returnOperation?.completedAt);
    const terminalStatus = returnOperation?.status;
    const expectedStatusMatches = request.telemetryFenceStatus === "terminal-failure"
        ? terminalStatus === "failed" || terminalStatus === ROLLED_BACK_STATUS
        : terminalStatus === "succeeded";
    if (returnOperation === null || !expectedStatusMatches || completedAt === null) {
        return { blocked: `return operation ${returnOperationId} is incomplete` };
    }
    return { blocked: null, observedAfter: completedAt };
}
async function assertIdleRetirementObservation(tx, root, request, sizing) {
    if (root.desiredStatus !== request.expectedDesiredStatus || root.updatedAt !== request.expectedUpdatedAt) {
        throw new GatewayRetirementConflictError("idle retirement gateway observation changed");
    }
    if (await retainsEntitledParkedCohort(tx, request, sizing)) {
        throw new GatewayRetirementConflictError("the owner remains entitled to the returned computer");
    }
}
export async function retireOwnedIsolatedGateway(input, request, mode = "apply") {
    const operationId = placementRetireOperationId(request.uid, request.gatewayId, request.generation);
    const blocked = (reason) => {
        if (mode === "apply")
            input.log(`[placement-policy] retirement blocked for ${request.gatewayId}: ${reason}`);
        return { retired: false, operationId, reason };
    };
    await checkPlacementOwner(input);
    const now = input.now();
    const telemetry = await readRetirementTelemetryFence(input, request);
    if (telemetry.blocked !== null)
        return blocked(telemetry.blocked);
    try {
        const claim = (sizing) => claimGatewayRetirementInStore({
            store: input.store,
            gatewayId: request.gatewayId,
            operationId,
            operation: {
                kind: "retire-gateway",
                status: "pending",
                origin: "automatic",
                createdBy: PLACEMENT_AUTOMATION_ACTOR,
                createdAt: now,
                startedAt: null,
                completedAt: null,
                input: {
                    gatewayId: request.gatewayId,
                    uid: request.uid,
                    userSlug: request.builderSlug,
                    reason: request.reason,
                },
                steps: [],
                gatewayId: request.gatewayId,
            },
            now,
            updatedBy: PLACEMENT_AUTOMATION_ACTOR,
            ...(telemetry.observedAfter === undefined ? {} : { telemetryObservedAfter: telemetry.observedAfter }),
            ownerGuard: input.requireOwner,
            plan: mode === "plan",
            claimGuard: async ({ transaction, root }) => {
                const prewarm = await readActiveParkedPrewarm(transaction, request.uid);
                if (prewarm?.gatewayId === request.gatewayId)
                    throw new GatewayRetirementConflictError("Owner computer prewarm has not released the allocation");
                const rootRecord = root;
                if (!retirementAllocationMatches(rootRecord, request)) {
                    throw new GatewayRetirementConflictError(`gateway ${request.gatewayId} no longer matches isolated allocation for ${request.uid}`);
                }
                if (sizing)
                    await assertIdleRetirementObservation(transaction, root, request, sizing);
                await assertRetirementAuthorityFence(transaction, request);
                await assertEphemeralReturnVerified(transaction, request);
                await assertZeroWorkloadRecoveryReceipt(transaction, request);
                await assertActivationSourceRecoveryReleased(input, transaction, {
                    targetGatewayId: request.gatewayId,
                    generation: request.generation,
                    failedActivationCleanup: request.reason === "activation-failed",
                });
            },
        });
        if (request.reason === "owned-gateway-not-kept") {
            await withCurrentSizingKey({ store: input.store, readSizingKey: input.readSizingKey, uid: request.uid, now }, claim);
        }
        else {
            await claim();
        }
        return { retired: true, operationId };
    }
    catch (error) {
        if (!(error instanceof GatewayRetirementConflictError) && !(error instanceof FenceMismatchError))
            throw error;
        return blocked(error.message);
    }
}
