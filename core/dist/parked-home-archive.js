import { randomUUID } from "node:crypto";
import { isUserParkedVm } from "@octogee/shared/types/glm";
export function parkedHomeUnderSnapshotCustody(owner) {
    const archive = owner?.home.homeArchive;
    return archive !== undefined && archive.phase !== "restored";
}
class IneligibleHomeArchiveError extends Error {
}
const RETURN_ARCHIVE_ACTOR = "glm-controller-return-home-archive";
export function isAuthorizedHomeArchiveOrigin(operation) {
    return operation.origin === "operator" || (operation.origin === "automatic" && operation.createdBy === RETURN_ARCHIVE_ACTOR);
}
export function resolveParkedHomeArchiveGrant(environment, value) {
    if (environment !== "test" || !value)
        return undefined;
    const match = /^([A-Za-z0-9_-]{1,63}):([a-z][a-z0-9-]{0,62})$/u.exec(value);
    if (!match)
        throw new Error("Invalid TEST home archive grant; expected owner UID and sizing profile");
    return { ownerUid: match[1], sizingProfile: match[2] };
}
function hasVerifiedReturn(operation, ownerUid, isolated, shared) {
    const park = operation?.output?.nativeSourcePark;
    return operation?.status === "succeeded" && operation.kind === "migrate-user" &&
        operation.inputUid === ownerUid && operation.input.fromGatewayId === isolated &&
        operation.input.toGatewayId === shared && (park?.parked === "stopped" || park?.parked === "suspended");
}
export function simpleHomePreparation(value) {
    return value === undefined || (value.phase === "complete" &&
        value.id === undefined && value.source === undefined && value.target === undefined && value.copy === undefined);
}
function pilotHomeEligible(owner) {
    const { home, fences } = owner;
    return home.projectStorageNativeBoot !== true && home.homeStorage === undefined && simpleHomePreparation(home.homeMigration) && home.homeErasure === undefined &&
        fences.sourceTransferFence === undefined && fences.restoreFence === undefined && fences.migration === undefined &&
        fences.pendingNativeSchedulerRetirement === undefined &&
        (owner.accountLifecycle === null || owner.accountLifecycle.status === "active");
}
function numericIdentity(value) {
    return typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value);
}
function matchesArchiveFence(owner, archive) {
    const fence = owner.fences.computerRecovery;
    return fence?.operationId === archive.operationId && fence.gatewayId === archive.gatewayId &&
        fence.instanceId === archive.instanceId && owner.activationLease?.status === "parked";
}
async function retryArchive(tx, owner, existing, dryRun) {
    const ownerUid = owner.uid;
    const operation = await tx.journal.operations.get(existing.operationId);
    if (!operation || !isAuthorizedHomeArchiveOrigin(operation) || operation.inputUid !== ownerUid || operation.input.action !== "archive" ||
        operation.input.expectedGatewayId !== existing.gatewayId || operation.input.expectedInstanceId !== existing.instanceId) {
        throw new Error("Home archive journal identity changed");
    }
    if (operation.status === "failed" && (existing.phase === "preparing" || existing.phase === "snapshot-ready")) {
        if (!matchesArchiveFence(owner, existing)) {
            throw new Error("Failed home archive no longer holds its original fence");
        }
        if (!dryRun)
            await tx.journal.operations.patch(operation.id, {
                status: "pending", startedAt: null, completedAt: null, error: { clear: true }, nextAttemptAt: { clear: true }, expireAt: { clear: true },
            });
    }
    return { operationId: existing.operationId };
}
function hasAttachedArchiveHome(owner) {
    return numericIdentity(owner.home.homeDisk?.id) && owner.home.computer?.vmSpec?.desktop === "x11" &&
        owner.fences.computerRecovery === undefined;
}
function parkedArchiveInputs(owner) {
    const lease = owner.activationLease;
    const parked = owner.home.computer;
    const sharedId = owner.gateway?.gatewayId;
    const returnOperationId = lease?.returnOperationId;
    if (lease?.status !== "parked" || !sharedId || !isUserParkedVm(parked) || parked.disposable || !numericIdentity(parked.instanceId) ||
        lease.targetGatewayId !== parked.gatewayId ||
        typeof returnOperationId !== "string" || !returnOperationId || returnOperationId.includes("/") ||
        !hasAttachedArchiveHome(owner)) {
        throw new IneligibleHomeArchiveError("Home archive requires an idle owner and a verified parked VM");
    }
    return { gatewayId: parked.gatewayId, instanceId: parked.instanceId, sharedId, returnOperationId };
}
function parkedArchiveRoot(root, grant) {
    return root?.gatewayClass === "isolated" && root.ownerUid === grant.ownerUid && root.desiredStatus === "paused" &&
        root.liveRelease != null && root.desiredRelease === root.liveRelease && root.retirementClaim == null &&
        root.sizingProfile === grant.sizingProfile;
}
async function verifyArchiveInputs(tx, input, grant) {
    const { gatewayId, sharedId, returnOperationId } = input;
    const { ownerUid } = grant;
    const [root, shared, assignment, returned, pending] = await Promise.all([
        tx.gateways.roots.get(gatewayId), tx.gateways.roots.get(sharedId), tx.gateways.assignments.get(sharedId, ownerUid),
        tx.journal.operations.get(returnOperationId), tx.journal.operations.listForUid(ownerUid, { statuses: ["pending", "running"] }),
    ]);
    if (!parkedArchiveRoot(root, grant) || shared?.gatewayClass !== "shared" ||
        assignment?.uid !== ownerUid || assignment.gatewayId !== sharedId || assignment.state !== "serving" ||
        !Number.isSafeInteger(assignment.epoch) || assignment.epoch < 0 ||
        !hasVerifiedReturn(returned, ownerUid, gatewayId, sharedId) || pending.length > 0) {
        throw new IneligibleHomeArchiveError("Home archive requires a settled native return to the serving Shared assignment");
    }
    return assignment.epoch;
}
export async function writeParkedHomeArchive(tx, owner, target, operation) {
    const ownerUid = owner.uid;
    const { gatewayId, instanceId, sharedId, assignmentEpoch } = target;
    const { operationId, createdBy, origin, now } = operation;
    const homeArchive = { phase: "preparing", operationId, gatewayId, instanceId };
    await tx.users.records.patch(ownerUid, { home: { homeArchive } }, { revision: owner.revision });
    await tx.users.records.setFence(ownerUid, "computerRecovery", {
        operationId, gatewayId, instanceId, sharedGatewayId: sharedId, assignmentEpoch,
    }, "absent");
    await tx.journal.operations.create({
        id: operationId, kind: "gateway-vm", status: "pending", origin, createdBy, createdAt: now,
        startedAt: null, completedAt: null, steps: [], gatewayId, inputUid: ownerUid,
        input: { action: "archive", uid: ownerUid, ownerUid, expectedGatewayId: gatewayId, expectedInstanceId: instanceId },
    });
}
export async function planReturnedHomeArchive(tx, owner, next, grant, now) {
    if (!grant || grant.ownerUid !== owner.uid || next.status !== "parked" ||
        owner.home.homeArchive !== undefined || !pilotHomeEligible(owner))
        return;
    try {
        const { gatewayId, instanceId, sharedId, returnOperationId } = parkedArchiveInputs({ ...owner, activationLease: next });
        const assignmentEpoch = await verifyArchiveInputs(tx, { gatewayId, sharedId, returnOperationId }, grant);
        const operationId = randomUUID();
        return () => writeParkedHomeArchive(tx, owner, { gatewayId, instanceId, sharedId, assignmentEpoch }, {
            operationId, createdBy: RETURN_ARCHIVE_ACTOR, origin: "automatic", now,
        });
    }
    catch (error) {
        if (!(error instanceof IneligibleHomeArchiveError))
            throw error;
        return undefined;
    }
}
export async function enqueueParkedHomeArchive(store, input) {
    const { ownerUid, grant, createdBy } = input;
    if (!grant || grant.ownerUid !== ownerUid || !grant.sizingProfile)
        throw new Error("No exact parked home archive grant");
    return store.transaction({ label: "parked-home.archive", readOnly: input.dryRun === true }, async (tx) => {
        const owner = await tx.users.records.get(ownerUid);
        if (!owner || !pilotHomeEligible(owner))
            throw new Error("User home is outside the archive pilot");
        const existing = owner.home.homeArchive;
        if (existing)
            return retryArchive(tx, owner, existing, input.dryRun);
        const { gatewayId, instanceId, sharedId, returnOperationId } = parkedArchiveInputs(owner);
        const assignmentEpoch = await verifyArchiveInputs(tx, { gatewayId, sharedId, returnOperationId }, grant);
        const operationId = randomUUID();
        if (input.dryRun)
            return { operationId };
        await writeParkedHomeArchive(tx, owner, { gatewayId, instanceId, sharedId, assignmentEpoch }, {
            operationId, createdBy, origin: "operator", now: Date.now(),
        });
        return { operationId };
    });
}
