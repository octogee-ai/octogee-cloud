import { createHash } from "node:crypto";
import { projectGatewayDesiredRootForGateway, } from "@octogee/shared/types/gateway-releases";
import { isDefinitiveConfigRpcRejection, MigrationDrainPendingError, MigrationTransportError, } from "./fleet-migration-client.js";
import { callReleasedTargetScheduler } from "./fleet-migration-runner.js";
const SYSTEM_CONFIG_COMMIT = /^[0-9a-f]{40,64}$/;
function acceptedSystemConfigCommit(value) {
    if (typeof value !== "string" || !SYSTEM_CONFIG_COMMIT.test(value)) {
        throw new Error("user migration V2 source flush did not prove an accepted system-config commit");
    }
    return value;
}
function canonicalJsonValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalJsonValue);
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]));
}
function mutableConfigHash(config) {
    const canonical = canonicalJsonValue({
        configSchemaVersion: config.configSchemaVersion,
        profile: config.profile,
        gatewayClass: config.gatewayClass,
        imageProfile: config.imageProfile,
        sizingTier: config.sizingTier,
        gcpProject: config.gcpProject,
        gatewayContainerSecurityContext: config.gatewayContainerSecurityContext,
        serviceAccountName: config.serviceAccountName,
        serviceAccount: config.serviceAccount,
        builderAccess: config.builderAccess,
        ownerUid: config.ownerUid,
        builderSlug: config.builderSlug,
        modelBrokerLimits: config.modelBrokerLimits,
    });
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
export function userMigrationV2GatewayRootFence(value, gatewayId) {
    const root = projectGatewayDesiredRootForGateway(value, gatewayId);
    if (root === null)
        return null;
    const valid = [
        root.desiredStatus === "running",
        root.retireAfter == null,
        root.retirementClaim == null,
        typeof root.liveRelease === "number",
        root.desiredRelease === root.liveRelease,
        typeof root.updatedAt === "number" && Number.isFinite(root.updatedAt),
        root.gatewayClass === "isolated",
        typeof root.ownerUid === "string" && root.ownerUid.length > 0,
        typeof root.builderSlug === "string" && root.builderSlug.length > 0,
    ].every(Boolean);
    if (!valid)
        return null;
    const fenced = root;
    return {
        gatewayId,
        updatedAt: fenced.updatedAt,
        latestRelease: fenced.latestRelease,
        desiredRelease: fenced.desiredRelease,
        liveRelease: fenced.liveRelease,
        gatewayClass: fenced.gatewayClass,
        ownerUid: fenced.ownerUid,
        builderSlug: fenced.builderSlug,
        configHash: mutableConfigHash(fenced),
    };
}
export function userMigrationV2GatewayRootFenceEqual(left, right) {
    return !!left && !!right &&
        left.gatewayId === right.gatewayId &&
        left.updatedAt === right.updatedAt &&
        left.latestRelease === right.latestRelease &&
        left.desiredRelease === right.desiredRelease &&
        left.liveRelease === right.liveRelease &&
        left.gatewayClass === right.gatewayClass &&
        left.ownerUid === right.ownerUid &&
        left.builderSlug === right.builderSlug &&
        left.configHash === right.configHash;
}
export function userMigrationV2GatewayRootFenceMatches(value, fence) {
    const current = userMigrationV2GatewayRootFence(value, fence.gatewayId);
    return current !== null && userMigrationV2GatewayRootFenceEqual(current, fence);
}
export async function advanceUserMigrationV2(state, deps) {
    return ADVANCE_HANDLERS[state.phase](state, deps);
}
async function advancePreparation(state, deps) {
    switch (state.phase) {
        case "initialized":
            await deps.setMigrationPhase?.("preparing");
            await deps.client.transferState({
                migrationId: state.migrationId,
                fromGatewayId: state.sourceGatewayId,
                fromTransportId: state.sourceGatewayId,
                toGatewayId: state.targetGatewayId,
                toTransportId: state.targetGatewayId,
                slug: state.slug,
                mode: "keys",
                includeActivationManifest: false,
            });
            return { ...state, phase: "keysSynced" };
        case "keysSynced":
            await deps.client.transferState({
                migrationId: state.migrationId,
                fromGatewayId: state.sourceGatewayId,
                fromTransportId: state.sourceGatewayId,
                toGatewayId: state.targetGatewayId,
                toTransportId: state.targetGatewayId,
                slug: state.slug,
                mode: "pre",
                includeActivationManifest: true,
            });
            return { ...state, phase: "preSynced" };
        default:
            throw new Error(`user migration V2 preparation cannot advance ${state.phase}`);
    }
}
async function advanceSourceQuiescence(state, deps) {
    await deps.setMigrationPhase?.("waiting");
    let fenced = false;
    try {
        await deps.client.quiesce({ migrationId: state.migrationId, gatewayId: state.sourceGatewayId, transportId: state.sourceGatewayId, slug: state.slug, timeoutMs: 30_000, stopMattermost: false });
        await deps.setMigrationPhase?.("transferring");
        await deps.setSourceAssignmentState("quiescing");
        fenced = true;
        await deps.client.quiesce({ migrationId: state.migrationId, gatewayId: state.sourceGatewayId, transportId: state.sourceGatewayId, slug: state.slug, schedulerHandoff: true, timeoutMs: 30_000 });
    }
    catch (error) {
        if (error instanceof MigrationDrainPendingError) {
            if (fenced)
                await deps.client.scheduler({ migrationId: state.migrationId, slug: state.slug, gatewayId: state.sourceGatewayId, phase: "resume" });
            await deps.client.resume({ migrationId: state.migrationId, gatewayId: state.sourceGatewayId, slug: state.slug });
            if (fenced)
                await deps.setSourceAssignmentState("serving");
            await deps.setMigrationPhase?.("waiting");
        }
        throw error;
    }
    const flush = await deps.client.flushGateway({
        migrationId: state.migrationId,
        gatewayId: state.sourceGatewayId,
        transportId: state.sourceGatewayId,
        slug: state.slug,
        reason: "migration-final",
    });
    return {
        ...state,
        phase: "sourceQuiesced",
        sourceSystemConfigCommit: acceptedSystemConfigCommit(flush.systemConfigCommit),
    };
}
async function advanceForward(state, deps) {
    switch (state.phase) {
        case "preSynced":
            return advanceSourceQuiescence(state, deps);
        case "sourceQuiesced": {
            await deps.client.scheduler({ migrationId: state.migrationId, slug: state.slug, gatewayId: state.sourceGatewayId, phase: "export" });
            const expectedSystemConfigCommit = acceptedSystemConfigCommit(state.sourceSystemConfigCommit);
            await deps.client.transferState({
                migrationId: state.migrationId,
                fromGatewayId: state.sourceGatewayId,
                toGatewayId: state.targetGatewayId,
                fromTransportId: state.sourceGatewayId,
                toTransportId: state.targetGatewayId,
                slug: state.slug,
                mode: "final",
                includeActivationManifest: true,
            });
            await deps.setMigrationPhase?.("activating");
            await deps.client.flushGateway({
                migrationId: state.migrationId,
                gatewayId: state.targetGatewayId,
                transportId: state.targetGatewayId,
                slug: state.slug,
                reason: "migration-converge",
                expectedSystemConfigCommit,
            });
            return { ...state, phase: "finalSynced" };
        }
        case "finalSynced":
            await deps.setMigrationPhase?.("connecting");
            await deps.client.verifyTarget({
                migrationId: state.migrationId,
                gatewayId: state.targetGatewayId,
                transportId: state.targetGatewayId,
                slug: state.slug,
            });
            return { ...state, phase: "targetVerified" };
        case "targetVerified":
            await deps.commitCutover({
                operationId: state.operationId,
                migrationId: state.migrationId,
                sourceGatewayId: state.sourceGatewayId,
                sourceEpoch: state.sourceEpoch,
                sourceRelease: state.sourceRelease,
                sourceAssignmentMode: state.sourceAssignmentMode,
                sourceRootFence: state.sourceRootFence,
                targetGatewayId: state.targetGatewayId,
                targetRelease: state.targetRelease,
                targetRootFence: state.targetRootFence,
            });
            return { ...state, phase: "cutover", cutoverAt: deps.now() };
        case "cutover":
            if (state.schedulerStagedAt === undefined)
                return stageSchedulesOnReleasedTarget(state, deps);
            await deps.client.scheduler({ migrationId: state.migrationId, slug: state.slug, gatewayId: state.sourceGatewayId, phase: "retire" });
            await deps.client.scheduler({ migrationId: state.migrationId, slug: state.slug, gatewayId: state.targetGatewayId, phase: "activate" });
            await deps.client.unmount({
                migrationId: state.migrationId,
                gatewayId: state.sourceGatewayId,
                transportId: state.sourceGatewayId,
                slug: state.slug,
            });
            return { ...state, phase: "sourceRetired", sourceRetiredAt: deps.now() };
        case "sourceRetired":
            return { ...state, phase: "complete", completedAt: deps.now() };
        default:
            throw new Error(`user migration V2 forward path cannot advance ${state.phase}`);
    }
}
async function stageSchedulesOnReleasedTarget(state, deps) {
    const request = { migrationId: state.migrationId, slug: state.slug };
    const exported = await deps.client.scheduler({ ...request, gatewayId: state.sourceGatewayId, phase: "export" });
    await callReleasedTargetScheduler(deps, {
        ...request, gatewayId: state.targetGatewayId, phase: "stage", agentIds: exported.agentIds, snapshot: exported.snapshot,
    });
    return { ...state, schedulerStagedAt: deps.now() };
}
async function advanceAbort(state, deps) {
    switch (state.phase) {
        case "abortIntent":
            await deps.setSourceAssignmentState("serving");
            await deps.client.scheduler({ migrationId: state.migrationId, slug: state.slug, gatewayId: state.sourceGatewayId, phase: "resume" });
            await deps.client.resume({ migrationId: state.migrationId, gatewayId: state.sourceGatewayId, slug: state.slug });
            await deps.client.unmount({
                migrationId: state.migrationId,
                gatewayId: state.targetGatewayId,
                transportId: state.targetGatewayId,
                slug: state.slug,
            });
            return { ...state, phase: "abortTargetUnmounted" };
        case "abortTargetUnmounted":
            return { ...state, phase: "aborted", abortedAt: deps.now() };
        default:
            throw new Error(`user migration V2 abort path cannot advance ${state.phase}`);
    }
}
async function terminalState(state) {
    return state;
}
const ADVANCE_HANDLERS = {
    initialized: advancePreparation,
    keysSynced: advancePreparation,
    preSynced: advanceForward,
    sourceQuiesced: advanceForward,
    finalSynced: advanceForward,
    targetVerified: advanceForward,
    cutover: advanceForward,
    sourceRetired: advanceForward,
    abortIntent: advanceAbort,
    abortTargetUnmounted: advanceAbort,
    complete: terminalState,
    aborted: terminalState,
};
const POST_INTENT_PHASES = new Set([
    "cutover",
    "sourceRetired",
    "complete",
]);
export function isUserMigrationV2ForwardOnly(state) {
    return ["sourceQuiesced", "finalSynced", "targetVerified"].includes(state.phase) || POST_INTENT_PHASES.has(state.phase);
}
export function isUserMigrationV2PostIntent(state) {
    return POST_INTENT_PHASES.has(state.phase);
}
const NEXT_PHASES = {
    initialized: ["keysSynced", "aborted"],
    keysSynced: ["preSynced"],
    preSynced: ["sourceQuiesced"],
    sourceQuiesced: ["finalSynced"],
    finalSynced: ["targetVerified"],
    targetVerified: ["cutover"],
    cutover: ["sourceRetired"],
    sourceRetired: ["complete"],
    abortIntent: ["abortTargetUnmounted"],
    abortTargetUnmounted: ["aborted"],
};
export function isUserMigrationV2Transition(from, to) {
    if (from === to)
        return true;
    if (NEXT_PHASES[from]?.includes(to))
        return true;
    return to === "abortIntent" &&
        from !== "initialized" &&
        !["sourceQuiesced", "finalSynced", "targetVerified"].includes(from) &&
        !POST_INTENT_PHASES.has(from) &&
        !isAbortPhaseName(from);
}
function isAbortPhaseName(phase) {
    return phase === "abortIntent" ||
        phase === "abortTargetUnmounted" ||
        phase === "aborted";
}
export function beginUserMigrationV2Abort(state, reason, now) {
    if (isUserMigrationV2ForwardOnly(state)) {
        throw new Error(`user migration V2 phase ${state.phase} crossed the final transfer boundary and must roll forward`);
    }
    if (state.phase === "initialized") {
        throw new Error("user migration V2 has no durable target footprint to abort");
    }
    if (isAbortPhaseName(state.phase)) {
        return state;
    }
    return {
        ...state,
        phase: "abortIntent",
        abortFromPhase: state.phase,
        abortReason: reason,
        abortIntentAt: now,
    };
}
const RETRYABLE_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);
const RETRYABLE_ERROR_CODES = new Set([
    4,
    8,
    10,
    14,
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
]);
function userMigrationErrorRecord(error) {
    if (!error || typeof error !== "object")
        return {};
    return error;
}
function statusErrorClass(status) {
    if (typeof status !== "number")
        return null;
    return status === 408 || status === 429 || status >= 500 ? "retry" : "terminal";
}
function errorMessageIsRetryable(error, record) {
    const message = error instanceof Error ? error.message : String(record.message ?? error);
    return /response lost|fetch failed|terminated|premature close|unexpected end|truncated|network|socket|ECONN|timed? out|timeout|unavailable|temporar|stale|restarted/i.test(message);
}
export function classifyUserMigrationV2Error(error) {
    if (isDefinitiveConfigRpcRejection(error))
        return "terminal";
    if (error instanceof MigrationTransportError)
        return "retry";
    const record = userMigrationErrorRecord(error);
    if (record.retryable === true)
        return "retry";
    if (RETRYABLE_ERROR_NAMES.has(record.name))
        return "retry";
    if (RETRYABLE_ERROR_CODES.has(record.code))
        return "retry";
    const statusClass = statusErrorClass(record.status);
    if (statusClass)
        return statusClass;
    return errorMessageIsRetryable(error, record) ? "retry" : "terminal";
}
