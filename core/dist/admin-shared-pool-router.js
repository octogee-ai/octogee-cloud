import { randomUUID } from "node:crypto";
import { isReleasePayload, releasePayloadHash, } from "@octogee/shared/types/gateway-releases";
import { gatewayHeartbeatMatchesImageTag, isGatewayImageTag } from "@octogee/shared/types/image-tag";
import { SHARED_POOL_SCALER_CREATOR, isSharedPoolMemberRoot, isSharedPoolSlotId, parseSharedPoolReplacements, sharedGatewayAddedBy, } from "@octogee/shared/types/shared-gateway-pool";
import { GATEWAY_CONFIG_SCHEMA_VERSION, InitialGatewayReleaseConflictError, writeInitialGatewayReleaseInTransaction, } from "./gateway-live-release.js";
import { claimGatewayRetirementInStore, GatewayRetirementConflictError } from "./gateway-retirement-claim.js";
import { InvalidSharedGatewayAutoscalingConfigError, readSharedGatewayAutoscalingConfigInStore } from "./shared-gateway-pool-read.js";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { timestampMillis } from "./timestamps.js";
import { FenceMismatchError } from "./platform-state/errors.js";
export const SHARED_POOL_AUTOMATION_SOURCE = "shared-pool-scaler";
const OPERATION_STATUSES = ["pending", "running", "succeeded", "failed", "rolled-back"];
class PreconditionFailed extends Error {
}
const STATUS_TRANSITIONS = {
    "begin-drain": { from: ["running"], to: "draining" },
    "resume-member": { from: ["draining"], to: "running" },
    "supersede-replacement": { from: ["running", "draining"], to: "running" },
};
function isStatusDecision(value) {
    return typeof value === "string" && Object.hasOwn(STATUS_TRANSITIONS, value);
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function sharedSlotMutableConfig() {
    return {
        configSchemaVersion: GATEWAY_CONFIG_SCHEMA_VERSION,
        profile: null,
        gatewayClass: "shared",
        imageProfile: "standard",
        sizingTier: null,
        gcpProject: null,
        gatewayContainerSecurityContext: null,
        serviceAccountName: null,
        serviceAccount: null,
        builderAccess: null,
        ownerUid: null,
        builderSlug: null,
        modelBrokerLimits: null,
    };
}
function parseAutomationState(value) {
    if (!isRecord(value))
        return "automationState is required";
    const { expectedSequence, replacements } = value;
    if (expectedSequence !== null && !isNonNegativeInteger(expectedSequence)) {
        return "automationState.expectedSequence must be null or a non-negative integer";
    }
    try {
        return { expectedSequence, replacements: parseSharedPoolReplacements(replacements) };
    }
    catch (error) {
        return `automationState.replacements is invalid: ${error instanceof Error ? error.message : String(error)}`;
    }
}
async function assertAutomationSequence(transaction, expected) {
    const state = await transaction.controllerState.sharedPoolScaler.get();
    const actual = state?.actionSequence ?? null;
    if (actual !== expected) {
        throw new PreconditionFailed(`shared gateway automation sequence is ${actual ?? "absent"}, expected ${expected ?? "absent"}`);
    }
}
async function writeAutomationState(transaction, write, now, lastAction) {
    const sequence = nextAutomationSequence(write);
    if (lastAction === null && write.expectedSequence !== null) {
        await transaction.controllerState.sharedPoolScaler.patch({
            actionSequence: sequence,
            lastActionAt: now,
            replacements: write.replacements,
        }, { actionSequence: write.expectedSequence });
        return;
    }
    await transaction.controllerState.sharedPoolScaler.put({
        schemaVersion: 1,
        actionSequence: sequence,
        lastActionAt: now,
        replacements: write.replacements,
        ...(lastAction ? { lastAction } : {}),
        updatedAt: now,
    }, write.expectedSequence === null ? "absent" : { actionSequence: write.expectedSequence });
}
function nextAutomationSequence(write) {
    return (write.expectedSequence ?? 0) + 1;
}
function automationMember(root, gatewayId) {
    if (root === null)
        throw new PreconditionFailed(`gateway ${gatewayId} does not exist`);
    if (!isSharedPoolMemberRoot(root) || sharedGatewayAddedBy(root) !== "automation") {
        throw new PreconditionFailed(`gateway ${gatewayId} is not a shared gateway added by automation`);
    }
    return root;
}
async function assertAssignmentCount(transaction, gatewayId, expected) {
    if (expected === undefined)
        return;
    if (!isNonNegativeInteger(expected))
        throw new PreconditionFailed("expectedAssignmentCount must be a non-negative integer");
    const actual = (await transaction.gateways.assignments.list(gatewayId)).length;
    if (actual !== expected) {
        throw new PreconditionFailed(`gateway ${gatewayId} has ${actual} assignments, expected ${expected}`);
    }
}
function preconditionBody(error) {
    if (error instanceof FleetMutationRefusedError)
        return preconditionBody(error.refusal);
    if (error instanceof PreconditionFailed || error instanceof FenceMismatchError || error instanceof InitialGatewayReleaseConflictError) {
        return { code: "precondition-failed", error: error.message };
    }
    if (error instanceof GatewayRetirementConflictError)
        return { code: "retirement-conflict", error: error.message };
    return null;
}
async function settle(res, run, status) {
    try {
        res.status(status).json(await run());
    }
    catch (error) {
        const body = preconditionBody(error);
        if (body === null)
            throw error;
        res.status(409).json(body);
    }
}
function outcomeResult(outcome) {
    return outcome.ok ? { outcome: "completed" } : { outcome: "failed", error: String(outcome.body.error) };
}
function parseStatuses(raw) {
    if (raw === undefined)
        return ["pending", "running"];
    if (typeof raw !== "string")
        return null;
    const statuses = raw.split(",").map((status) => status.trim()).filter((status) => status !== "");
    return statuses.length > 0 && statuses.every((status) => OPERATION_STATUSES.includes(status))
        ? statuses
        : null;
}
async function latestReleasePayloadHash(transaction, root) {
    if (!isNonNegativeInteger(root.latestRelease))
        return null;
    const release = await transaction.gateways.releases.get(root.gatewayId, root.latestRelease);
    return release !== null && isReleasePayload(release.payload) ? releasePayloadHash(release.payload) : null;
}
function fleetStateUser(user, provisioningReadiness) {
    const { restoreFence, sourceTransferFence } = user.fences;
    return {
        uid: user.uid,
        slug: user.slug,
        admitted: user.admitted,
        accountLifecycle: user.accountLifecycle,
        provisioning: user.provisioning.status === undefined ? {} : { status: user.provisioning.status },
        gateway: user.gateway === null ? null : { gatewayId: user.gateway.gatewayId },
        openclaw: user.openclaw.managedBy === undefined ? {} : { managedBy: user.openclaw.managedBy },
        fences: {
            ...(restoreFence === undefined ? {} : { restoreFence }),
            ...(sourceTransferFence === undefined ? {} : { sourceTransferFence }),
        },
        ...(provisioningReadiness === undefined ? {} : { provisioningReady: provisioningReadiness(user.uid) }),
    };
}
export async function readFleetState(store, input) {
    return store.transaction({ label: "admin.fleet.state", readOnly: true }, async (transaction) => {
        const [config, automation, users, gateways, assignments, runtimes, operations, sharedGatewayAutoscaling] = await Promise.all([
            transaction.config.orchestrator.get(),
            transaction.controllerState.sharedPoolScaler.get(),
            transaction.users.records.listAll(),
            transaction.gateways.roots.list(),
            transaction.gateways.assignments.listAll(),
            transaction.fleetRegistry.list(),
            transaction.journal.operations.listByStatus(input.operationStatuses),
            readSharedGatewayAutoscalingConfigInStore(transaction).catch((error) => {
                if (error instanceof InvalidSharedGatewayAutoscalingConfigError)
                    return null;
                throw error;
            }),
        ]);
        const sharedGateways = gateways.filter(isSharedPoolMemberRoot);
        const hashes = await Promise.all(sharedGateways.map((root) => latestReleasePayloadHash(transaction, root)));
        return {
            generatedAt: input.now,
            fleetControllerStartedAt: input.controllerStartedAt ?? null,
            platformArtifactHash: input.platformArtifact ? releasePayloadHash({ ...input.platformArtifact }) : null,
            config: {
                sharedGatewayAutoscaling,
                sizingProfiles: config?.sizingProfiles ?? {},
                disposableGatewayIdleMs: config?.disposableGatewayIdleMs ?? null,
            },
            sharedPoolAutomation: automation,
            users: users.map((user) => fleetStateUser(user, input.provisioningReadiness)),
            gateways,
            latestReleasePayloadHashes: Object.fromEntries(sharedGateways.map((root, index) => [root.gatewayId, hashes[index] ?? null])),
            assignments,
            runtimes,
            operations,
        };
    });
}
function isAutomationAddOperation(value) {
    if (value === null || !isRecord(value.input))
        return false;
    return value.kind === "add-gateway" &&
        value.status === "running" &&
        value.createdBy === SHARED_POOL_SCALER_CREATOR &&
        isSharedPoolSlotId(value.gatewayId) &&
        value.input.gatewayId === value.gatewayId &&
        value.input.source === SHARED_POOL_AUTOMATION_SOURCE &&
        typeof value.input.imageTag === "string" &&
        isGatewayImageTag(value.input.imageTag);
}
async function slotServingBlocker(transaction, gatewayId, addedImageTag) {
    const [root, runtime] = await Promise.all([
        transaction.gateways.roots.get(gatewayId),
        transaction.fleetRegistry.get(gatewayId),
    ]);
    if (root === null || root.desiredStatus !== "running" || root.liveRelease === null || root.liveRelease !== root.desiredRelease) {
        return "shared gateway is not running its desired release";
    }
    if (runtime === null || runtime.release !== root.liveRelease || runtime.lifecycle !== "serving") {
        return "shared gateway runtime is not serving its live release";
    }
    const [liveRelease, firstRelease] = await Promise.all([
        transaction.gateways.releases.get(gatewayId, root.liveRelease),
        transaction.gateways.releases.get(gatewayId, 1),
    ]);
    return runtimeReadyOnAddedImage(runtime, liveRelease?.payload, firstRelease?.payload, addedImageTag)
        ? null
        : "shared gateway runtime is not ready on the image it was added with";
}
function runtimeReadyOnAddedImage(runtime, payload, firstPayload, addedImageTag) {
    return isReleasePayload(payload) &&
        isReleasePayload(firstPayload) &&
        firstPayload.imageTag === addedImageTag &&
        runtime.helm.imageTag === payload.imageTag &&
        runtime.heartbeat.status === "ready" &&
        gatewayHeartbeatMatchesImageTag(runtime.heartbeat.version, payload.imageTag);
}
async function completeHealthyAdd(transaction, input) {
    const { gatewayId, operationId, now } = input;
    const refused = (error) => ({ ok: false, status: 409, body: { code: "precondition-failed", error, operationId, gatewayId } });
    const operation = await transaction.journal.operations.get(operationId);
    if (!isAutomationAddOperation(operation) || operation.gatewayId !== gatewayId) {
        return refused("operation is not a running automation add of this shared gateway");
    }
    const claimedAt = timestampMillis(operation.startedAt);
    if (claimedAt == null || claimedAt >= input.controllerStartedAt) {
        return refused("operation was not claimed by a previous fleet controller");
    }
    const blocker = await slotServingBlocker(transaction, gatewayId, operation.input.imageTag);
    if (blocker !== null)
        return refused(blocker);
    await transaction.journal.operations.patch(operation.id, {
        status: "succeeded",
        completedAt: now,
        lastProgressAt: now,
        output: { ...(isRecord(operation.output) ? operation.output : {}), mintRecovery: "healthy-slot-runtime" },
        steps: operation.steps.map((step) => step.status === "running" ? { ...step, status: "done", completedAt: now } : step),
    }, { status: ["running"], startedAt: operation.startedAt });
    return { ok: true, value: { operationId, gatewayId } };
}
async function finishReplacement(transaction, input) {
    const { sourceGatewayId, departedGatewayId, expectedAutomationSequence } = input;
    const state = await transaction.controllerState.sharedPoolScaler.get();
    if (state === null || state.actionSequence !== expectedAutomationSequence) {
        throw new PreconditionFailed(`shared gateway automation sequence is ${state?.actionSequence ?? "absent"}, expected ${expectedAutomationSequence}`);
    }
    const replacement = state.replacements.find((candidate) => candidate.sourceGatewayId === sourceGatewayId);
    if (!replacement || (replacement.sourceGatewayId !== departedGatewayId && replacement.targetGatewayId !== departedGatewayId)) {
        throw new PreconditionFailed(`no replacement of ${sourceGatewayId} involves ${departedGatewayId}`);
    }
    if ((await transaction.gateways.roots.get(departedGatewayId)) !== null) {
        throw new PreconditionFailed(`gateway ${departedGatewayId} still exists`);
    }
    await transaction.controllerState.sharedPoolScaler.patch({
        replacements: state.replacements.filter((candidate) => candidate.sourceGatewayId !== sourceGatewayId),
        actionSequence: expectedAutomationSequence + 1,
        lastActionAt: input.now,
    }, { actionSequence: expectedAutomationSequence });
    return { sourceGatewayId, automationSequence: expectedAutomationSequence + 1 };
}
function refusalsBelowError(journal) {
    return (input) => journal({
        ...input,
        action: async (claim) => {
            try {
                return await input.action(claim);
            }
            catch (error) {
                if (error instanceof Error && preconditionBody(error) !== null)
                    throw new FleetMutationRefusedError(error);
                throw error;
            }
        },
    });
}
function newSharedGatewayId() {
    return `shared-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
// eslint-disable-next-line max-lines-per-function -- one mount point for the shared gateway automation verbs
export function addAdminSharedPoolRoutes(router, deps) {
    const { store } = deps;
    const journal = refusalsBelowError(deps.journal);
    const now = deps.now ?? Date.now;
    router.get("/fleet/state", async (req, res, next) => {
        try {
            const operationStatuses = parseStatuses(req.query.operationStatus);
            if (operationStatuses === null) {
                res.status(400).json({ error: `operationStatus must be a comma-separated list of ${OPERATION_STATUSES.join(", ")}` });
                return;
            }
            res.json(await readFleetState(store, {
                operationStatuses,
                platformArtifact: deps.platformArtifact,
                controllerStartedAt: deps.controllerStartedAt,
                now: now(),
                provisioningReadiness: deps.provisioningReadiness,
            }));
        }
        catch (error) {
            next(error);
        }
    });
    router.post("/shared-gateways", async (req, res, next) => {
        try {
            const body = (req.body ?? {});
            const automationState = parseAutomationState(body.automationState);
            if (typeof automationState === "string") {
                res.status(400).json({ error: automationState });
                return;
            }
            const { reason, replacesGatewayId } = body;
            if (reason !== "minimum-replicas" && reason !== "scale-out" && reason !== "platform-replacement") {
                res.status(400).json({ error: "reason must be minimum-replicas, scale-out or platform-replacement" });
                return;
            }
            if ((reason === "platform-replacement") !== (typeof replacesGatewayId === "string" && replacesGatewayId !== "")) {
                res.status(400).json({ error: "replacesGatewayId is required for, and only for, a platform replacement" });
                return;
            }
            const gatewayId = body.gatewayId === undefined ? newSharedGatewayId() : body.gatewayId;
            if (typeof gatewayId !== "string" || !/^shared-[a-f0-9]{12}$/.test(gatewayId)) {
                res.status(400).json({ error: "gatewayId must be shared- followed by 12 lowercase hex digits" });
                return;
            }
            const artifact = deps.platformArtifact;
            if (!artifact) {
                res.status(501).json({ error: "this fleet controller has no platform gateway build configured" });
                return;
            }
            const replacement = reason === "platform-replacement" ? { replacesGatewayId } : {};
            await settle(res, () => journal({
                req,
                what: "add shared gateway for automation",
                why: `shared gateway automation: ${reason}`,
                target: { gatewayId },
                preActionStatus: { exists: false, automationSequence: automationState.expectedSequence },
                mutation: { kind: "add-gateway", gatewayId, gatewayClass: "shared", addedBy: "automation", reason, ...replacement, imageTag: artifact.imageTag },
                action: async () => store.transaction({ label: "admin.shared-pool.add" }, async (transaction) => {
                    const at = now();
                    await assertAutomationSequence(transaction, automationState.expectedSequence);
                    if (typeof replacesGatewayId === "string") {
                        automationMember(await transaction.gateways.roots.get(replacesGatewayId), replacesGatewayId);
                    }
                    await writeInitialGatewayReleaseInTransaction(transaction, {
                        gatewayId,
                        createdBy: SHARED_POOL_SCALER_CREATOR,
                        now: at,
                        desiredStatus: "running",
                        config: sharedSlotMutableConfig(),
                        artifact,
                    });
                    await writeAutomationState(transaction, automationState, at, null);
                    const sequence = nextAutomationSequence(automationState);
                    const operationId = await transaction.journal.operations.enqueue({
                        kind: "add-gateway",
                        status: "pending",
                        origin: "automatic",
                        createdBy: SHARED_POOL_SCALER_CREATOR,
                        createdAt: at,
                        startedAt: null,
                        completedAt: null,
                        gatewayId,
                        input: {
                            gatewayId,
                            imageTag: artifact.imageTag,
                            gatewayClass: "shared",
                            source: SHARED_POOL_AUTOMATION_SOURCE,
                            reason,
                            ...replacement,
                        },
                        steps: [],
                    });
                    return { gatewayId, operationId, automationSequence: sequence };
                }),
            }), 202);
        }
        catch (error) {
            next(error);
        }
    });
    router.post("/shared-gateways/:id/desired-status", async (req, res, next) => {
        try {
            const gatewayId = req.params.id;
            const body = (req.body ?? {});
            const automationState = parseAutomationState(body.automationState);
            if (typeof automationState === "string") {
                res.status(400).json({ error: automationState });
                return;
            }
            const { decision, expectedUpdatedAt } = body;
            if (!isStatusDecision(decision)) {
                res.status(400).json({ error: `decision must be one of ${Object.keys(STATUS_TRANSITIONS).join(", ")}` });
                return;
            }
            if (!isNonNegativeInteger(expectedUpdatedAt)) {
                res.status(400).json({ error: "expectedUpdatedAt is required" });
                return;
            }
            const transition = STATUS_TRANSITIONS[decision];
            await settle(res, () => journal({
                req,
                what: "change shared gateway desired status for automation",
                why: `shared gateway automation: ${decision}`,
                target: { gatewayId },
                preActionStatus: { updatedAt: expectedUpdatedAt, automationSequence: automationState.expectedSequence },
                mutation: { kind: "scale-shared-member", gatewayId, decision, toDesiredStatus: transition.to },
                action: async () => store.transaction({ label: "admin.shared-pool.desired-status" }, async (transaction) => {
                    const at = now();
                    await assertAutomationSequence(transaction, automationState.expectedSequence);
                    const root = automationMember(await transaction.gateways.roots.get(gatewayId), gatewayId);
                    if (root.updatedAt !== expectedUpdatedAt)
                        throw new PreconditionFailed(`gateway ${gatewayId} changed since it was read`);
                    const fromDesiredStatus = root.desiredStatus;
                    if (!transition.from.includes(fromDesiredStatus)) {
                        throw new PreconditionFailed(`gateway ${gatewayId} is ${fromDesiredStatus}; ${decision} needs ${transition.from.join(" or ")}`);
                    }
                    await assertAssignmentCount(transaction, gatewayId, body.expectedAssignmentCount);
                    const sequence = (automationState.expectedSequence ?? 0) + 1;
                    const operationId = `shared-pool-scale-${String(sequence).padStart(8, "0")}`;
                    if ((await transaction.journal.operations.get(operationId)) !== null) {
                        throw new Error(`shared pool scaler operation ${operationId} already exists`);
                    }
                    await transaction.gateways.roots.patch(gatewayId, {
                        desiredStatus: transition.to,
                        updatedAt: at,
                        updatedBy: SHARED_POOL_SCALER_CREATOR,
                    }, { updatedAt: root.updatedAt });
                    await transaction.journal.operations.create({
                        id: operationId,
                        kind: "scale-shared-member",
                        status: "succeeded",
                        origin: "automatic",
                        createdBy: SHARED_POOL_SCALER_CREATOR,
                        createdAt: at,
                        startedAt: at,
                        completedAt: at,
                        lastProgressAt: at,
                        gatewayId,
                        input: { gatewayId, fromDesiredStatus, toDesiredStatus: transition.to, source: SHARED_POOL_AUTOMATION_SOURCE, decision },
                        output: { desiredStatus: transition.to },
                        steps: [],
                    });
                    await writeAutomationState(transaction, automationState, at, {
                        operationId,
                        gatewayId,
                        fromDesiredStatus,
                        toDesiredStatus: transition.to,
                        decision,
                    });
                    return { gatewayId, fromDesiredStatus, toDesiredStatus: transition.to, operationId, automationSequence: sequence };
                }),
            }), 200);
        }
        catch (error) {
            next(error);
        }
    });
    router.post("/shared-gateways/:id/retire", async (req, res, next) => {
        try {
            const gatewayId = req.params.id;
            const body = (req.body ?? {});
            const { expectedAutomationSequence, expectedUpdatedAt } = body;
            if (expectedAutomationSequence !== null && !isNonNegativeInteger(expectedAutomationSequence)) {
                res.status(400).json({ error: "expectedAutomationSequence must be null or a non-negative integer" });
                return;
            }
            if (!isNonNegativeInteger(expectedUpdatedAt)) {
                res.status(400).json({ error: "expectedUpdatedAt is required" });
                return;
            }
            const operationId = `shared-pool-retire-${gatewayId}`;
            await settle(res, () => journal({
                req,
                what: "retire shared gateway for automation",
                why: "shared gateway automation: retire-member",
                target: { gatewayId },
                preActionStatus: { updatedAt: expectedUpdatedAt, automationSequence: expectedAutomationSequence },
                mutation: { kind: "retire-gateway", gatewayId, addedBy: "automation" },
                action: async () => {
                    const at = now();
                    let fromDesiredStatus = null;
                    await claimGatewayRetirementInStore({
                        store,
                        gatewayId,
                        operationId,
                        now: at,
                        updatedBy: SHARED_POOL_SCALER_CREATOR,
                        operation: {
                            kind: "retire-gateway",
                            status: "pending",
                            origin: "automatic",
                            createdBy: SHARED_POOL_SCALER_CREATOR,
                            createdAt: at,
                            startedAt: null,
                            completedAt: null,
                            gatewayId,
                            steps: [],
                            input: { gatewayId, source: SHARED_POOL_AUTOMATION_SOURCE },
                        },
                        claimGuard: async ({ transaction, root }) => {
                            await assertAutomationSequence(transaction, expectedAutomationSequence);
                            automationMember(await transaction.gateways.roots.get(gatewayId), gatewayId);
                            if (root.updatedAt !== expectedUpdatedAt)
                                throw new PreconditionFailed(`gateway ${gatewayId} changed since it was read`);
                            await assertAssignmentCount(transaction, gatewayId, body.expectedAssignmentCount);
                            fromDesiredStatus = root.desiredStatus;
                        },
                    });
                    return { gatewayId, fromDesiredStatus, toDesiredStatus: "retired", operationId };
                },
            }), 202);
        }
        catch (error) {
            next(error);
        }
    });
    router.post("/shared-gateways/replacements/:sourceGatewayId/finish", async (req, res, next) => {
        try {
            const sourceGatewayId = req.params.sourceGatewayId;
            const body = (req.body ?? {});
            const { departedGatewayId, expectedAutomationSequence } = body;
            if (typeof departedGatewayId !== "string" || departedGatewayId === "" || !isNonNegativeInteger(expectedAutomationSequence)) {
                res.status(400).json({ error: "departedGatewayId and expectedAutomationSequence are required" });
                return;
            }
            await settle(res, () => journal({
                req,
                what: "finish shared gateway replacement for automation",
                why: "shared gateway automation: finish-replacement",
                target: { gatewayId: sourceGatewayId },
                preActionStatus: { automationSequence: expectedAutomationSequence },
                mutation: { kind: "finish-shared-gateway-replacement", sourceGatewayId, departedGatewayId },
                action: async () => store.transaction({ label: "admin.shared-pool.finish-replacement" }, (transaction) => finishReplacement(transaction, { sourceGatewayId, departedGatewayId, expectedAutomationSequence, now: now() })),
            }), 200);
        }
        catch (error) {
            next(error);
        }
    });
    router.post("/shared-gateways/:id/add-operations/:operationId/complete", async (req, res, next) => {
        try {
            const gatewayId = req.params.id;
            const operationId = req.params.operationId;
            const controllerStartedAt = deps.controllerStartedAt;
            if (controllerStartedAt === undefined) {
                res.status(501).json({ error: "this fleet controller does not report its start time" });
                return;
            }
            const outcome = await journal({
                req,
                what: "complete interrupted shared gateway add",
                why: "shared gateway runtime is serving and ready on the image it was added with",
                target: { gatewayId, operationId },
                preActionStatus: { status: "running" },
                mutation: { kind: "complete-shared-gateway-add", gatewayId, operationId },
                classifyResult: outcomeResult,
                action: () => store.transaction({ label: "admin.shared-pool.complete-add" }, (transaction) => completeHealthyAdd(transaction, { gatewayId, operationId, controllerStartedAt, now: now() })),
            });
            if (outcome.ok)
                res.json(outcome.value);
            else
                res.status(outcome.status).json(outcome.body);
        }
        catch (error) {
            next(error);
        }
    });
}
