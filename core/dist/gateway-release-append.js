import { isDeepStrictEqual } from "node:util";
import { isGatewayDesiredDoc, isReleasePayload, releasePayloadHash, } from "@octogee/shared/types/gateway-releases";
import { projectGatewayMutableConfigForGateway, } from "@octogee/shared/types/gateway-mutable-config";
import { gatewayArtifactFromReleasePayload } from "./gateway-live-release.js";
import { assertGatewayRuntimeMutationUnfencedInStore, GatewayRetirementConflictError } from "./gateway-retirement-claim.js";
export function asDurableGatewayRoot(data, gatewayId) {
    if (!isGatewayDesiredDoc(data) || data.gatewayId !== gatewayId)
        return null;
    return projectGatewayMutableConfigForGateway(data, gatewayId);
}
export class StaleGatewayReleaseError extends Error {
    gatewayId;
    expectedRelease;
    actualRelease;
    constructor(gatewayId, expectedRelease, actualRelease) {
        super(`gateway ${gatewayId} changed while this release was being cut ` +
            `(expected ${expectedRelease}, found ${actualRelease})`);
        this.gatewayId = gatewayId;
        this.expectedRelease = expectedRelease;
        this.actualRelease = actualRelease;
    }
}
export class InvalidGatewayRootError extends Error {
    gatewayId;
    constructor(gatewayId) {
        super(`gateway ${gatewayId} durable root is invalid`);
        this.gatewayId = gatewayId;
    }
}
export class GatewayOwnerChangeError extends Error {
    gatewayId;
    field;
    constructor(gatewayId, field) {
        super(`gateway ${gatewayId} ${field} is already bound; a release cannot change it`);
        this.gatewayId = gatewayId;
        this.field = field;
    }
}
function assertOwnerUnchanged(current, caller) {
    for (const field of ["ownerUid", "builderSlug"]) {
        if (current[field] !== null && caller[field] !== current[field]) {
            throw new GatewayOwnerChangeError(current.gatewayId, field);
        }
    }
}
export function rolloutOperationInput(gatewayId, targetRelease, artifact) {
    return {
        gatewayId,
        targetRelease,
        imageTag: artifact.imageTag,
        imageRepository: artifact.imageRepository,
    };
}
function currentRootForAppend(stored, args) {
    const current = asDurableGatewayRoot(stored, args.gateway.gatewayId);
    if (!current)
        throw new InvalidGatewayRootError(args.gateway.gatewayId);
    assertOwnerUnchanged(current, args.gateway);
    if (current.desiredStatus === "retired" || current.retirementClaim != null) {
        throw new GatewayRetirementConflictError(`gateway ${args.gateway.gatewayId} has a current retirement claim`);
    }
    if (current.latestRelease !== args.gateway.latestRelease) {
        throw new StaleGatewayReleaseError(args.gateway.gatewayId, args.gateway.latestRelease, current.latestRelease);
    }
    return current;
}
function immutableHistoryError(gatewayId, release) {
    return new Error(`appendGatewayRelease: gateways/${gatewayId}/releases/${release} already exists — refusing to overwrite immutable history`);
}
async function assertStoredReleaseIsNew(transaction, gatewayId, release) {
    if (await transaction.gateways.releases.get(gatewayId, release) !== null) {
        throw immutableHistoryError(gatewayId, release);
    }
}
function releasePayloadFor(args) {
    const payload = args.payload ?? { ...args.artifact };
    if (!isReleasePayload(payload)) {
        throw new Error("appendGatewayRelease requires a valid immutable release payload");
    }
    return payload;
}
export async function appendGatewayRelease(store, args) {
    return store.transaction({ label: "gateway-release.append" }, async (transaction) => {
        const current = currentRootForAppend(await transaction.gateways.roots.get(args.gateway.gatewayId), args);
        await assertGatewayRuntimeMutationUnfencedInStore(transaction, args.gateway.gatewayId);
        const release = current.latestRelease + 1;
        await assertStoredReleaseIsNew(transaction, args.gateway.gatewayId, release);
        const payload = releasePayloadFor(args);
        const operationId = await appendStoredGatewayRelease(transaction, args, { release, payload });
        return { release, operationId };
    });
}
function rolloutOperation(args, release, payload) {
    return {
        kind: "rollout",
        status: "pending",
        createdBy: args.createdBy,
        ...(args.origin ? { origin: args.origin } : {}),
        createdAt: args.now,
        startedAt: null,
        completedAt: null,
        input: rolloutOperationInput(args.gateway.gatewayId, release, gatewayArtifactFromReleasePayload(payload)),
        steps: [],
        gatewayId: args.gateway.gatewayId,
    };
}
async function appendStoredGatewayRelease(transaction, args, record) {
    await appendImmutableGatewayRelease(transaction, args, record);
    return transaction.journal.operations.enqueue(rolloutOperation(args, record.release, record.payload));
}
async function appendImmutableGatewayRelease(transaction, args, record) {
    const { release, payload, activate = false } = record;
    await transaction.gateways.releases.append({
        gatewayId: args.gateway.gatewayId,
        expectedLatestRelease: release - 1,
        createdAt: args.now,
        createdBy: args.createdBy,
        sourceRelease: args.sourceRelease,
        note: args.note,
        payload,
        payloadHash: releasePayloadHash(payload),
        activate,
        updatedBy: args.createdBy,
    });
}
export async function appendRetainedSharedMaintenanceReleaseInStore(transaction, input) {
    const root = await transaction.gateways.roots.get(input.gatewayId);
    const current = asDurableGatewayRoot(root, input.gatewayId);
    const guard = root?.runtimeRestartFence;
    const maintenance = guard?.maintenance;
    const images = input.phase === "rollback" ? maintenance?.originalImages : maintenance?.maintenanceImages;
    if (!recoveredSharedRoot(current) || guard?.kind !== "shared-held-return-maintenance" ||
        guard.attemptId !== input.attemptId || guard.phase !== input.phase || maintenance?.targetRelease !== input.originalRelease ||
        !isDeepStrictEqual(images, recoveredReleaseImages(input.payload))) {
        throw new Error("Shared maintenance release authorization changed");
    }
    const release = current.latestRelease + 1;
    await assertStoredReleaseIsNew(transaction, input.gatewayId, release);
    const args = { gateway: current, artifact: gatewayArtifactFromReleasePayload(input.payload),
        payload: input.payload, createdBy: input.attemptId, now: input.now, sourceRelease: input.originalRelease,
        note: input.phase === "rollback" ? "Retained Shared maintenance reversal" : "Retained Shared maintenance", origin: "operator" };
    await appendImmutableGatewayRelease(transaction, args, { release, payload: releasePayloadFor(args), activate: true });
    return release;
}
function recoveredSharedRoot(current) {
    return current !== null && current.gatewayClass === "shared" && current.ownerUid === null && current.builderSlug === null &&
        ["running", "draining"].includes(current.desiredStatus) && current.retirementClaim == null;
}
function recoveredReleaseOperation(op, input) {
    return op?.kind === "restart-gateway" && op.status === "running" && op.startedAt === input.claimedStartedAt &&
        typeof input.claimedStartedAt === "number" && op.cancellationRequestedAt === undefined && op.input?.gatewayId === input.gatewayId &&
        Array.isArray(op.input?.sourceRecovery?.postgresAgentStores) && op.input.sourceRecovery.postgresAgentStores.length > 0;
}
function recoveredReleasePayload(recovery, payload, images) {
    return isReleasePayload(payload) && payload.gatewayEdgeImage !== undefined && isDeepStrictEqual(recovery?.payload, payload) &&
        isDeepStrictEqual(recovery?.images, images);
}
function recoveredReleaseDoctor(fence, operationId, images) {
    const doctor = fence?.doctor;
    return fence?.kind === "source-recovery" && fence.attemptId === operationId && fence.phase === "dispatched" &&
        doctor?.requestId === operationId && doctor?.error === undefined && recoveredDoctorTiming(doctor) && isDeepStrictEqual(fence.target?.images, images);
}
function recoveredDoctorTiming(doctor) {
    return doctor !== undefined && Number.isSafeInteger(doctor.startedAt) && Number.isSafeInteger(doctor.completedAt) && doctor.completedAt >= doctor.startedAt;
}
function recoveredReleaseImages(payload) {
    return { gateway: `${payload.imageRepository}:${payload.imageTag}`,
        "gateway-edge": `${payload.gatewayEdgeImage?.imageRepository}:${payload.gatewayEdgeImage?.imageTag}` };
}
function recoveredReleaseRoot(root, op, input) {
    const current = asDurableGatewayRoot(root, input.gatewayId), images = recoveredReleaseImages(input.payload);
    if (!recoveredSharedRoot(current) || !recoveredReleaseOperation(op, input) ||
        !recoveredReleasePayload(op?.input?.sourceRecovery, input.payload, images) ||
        !recoveredReleaseDoctor(root?.runtimeRestartFence, input.operationId, images)) {
        throw new Error("recovered Shared release authority changed");
    }
    return current;
}
function recoveredReleaseArgs(current, input) {
    return {
        gateway: current, artifact: gatewayArtifactFromReleasePayload(input.payload), payload: input.payload,
        createdBy: input.operationId, now: input.now, sourceRelease: current.liveRelease,
        note: "Stopped-source PostgreSQL repair", origin: "operator",
    };
}
export async function recordRecoveredGatewayReleaseInStore(transaction, input) {
    const [root, operation] = await Promise.all([transaction.gateways.roots.get(input.gatewayId),
        transaction.journal.operations.get(input.operationId)]);
    const current = recoveredReleaseRoot(root ?? undefined, operation ?? undefined, input);
    const release = current.latestRelease + 1;
    await assertStoredReleaseIsNew(transaction, input.gatewayId, release);
    const operationId = await appendStoredGatewayRelease(transaction, recoveredReleaseArgs(current, input), { release, payload: input.payload, activate: true });
    return { release, operationId };
}
