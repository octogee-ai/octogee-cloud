import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
    return home.homeStorage === undefined && simpleHomePreparation(home.homeMigration) && home.homeErasure === undefined &&
        fences.sourceTransferFence === undefined && fences.restoreFence === undefined && fences.migration === undefined &&
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
function parkedArchiveInputs(owner) {
    const lease = owner.activationLease;
    const sharedId = owner.gateway?.gatewayId;
    const returnOperationId = lease?.returnOperationId;
    if (lease?.status !== "parked" || !sharedId || typeof lease.targetGatewayId !== "string" ||
        typeof returnOperationId !== "string" || !returnOperationId || returnOperationId.includes("/") ||
        !numericIdentity(owner.home.homeDisk?.id) || owner.fences.computerRecovery !== undefined) {
        throw new IneligibleHomeArchiveError("Home archive requires an idle owner and a verified parked VM");
    }
    return { gatewayId: lease.targetGatewayId, sharedId, returnOperationId };
}
function observedArchiveVm(runtime, homeZone) {
    const observed = runtime?.vm;
    return runtime?.runtime === "gce-vm" && runtime.vmSpec?.desktop === "x11" && observed &&
        ["SUSPENDED", "TERMINATED", "STOPPED"].includes(observed.status ?? "") &&
        numericIdentity(observed.instanceId) && observed.zone === homeZone ? observed : null;
}
function observedArchiveSource(owner, input, runtime) {
    const homeZone = owner.home.homeDisk?.zone;
    if (runtime !== null)
        return observedArchiveVm(runtime, homeZone);
    if (owner.home.projectStorageNativeBoot === true || owner.fences.pendingNativeSchedulerRetirement !== undefined)
        return null;
    const parked = owner.home.computer;
    return isUserParkedVm(parked) && !parked.disposable && parked.vmSpec?.desktop === "x11" &&
        parked.gatewayId === input.gatewayId && parked.zone === homeZone && numericIdentity(parked.instanceId) ? parked : null;
}
function schedulerReturnCompleted(returned, custody) {
    return typeof custody.completedAt === "number" && typeof custody.cutoverCommittedAt === "number" &&
        custody.cutoverCommittedAt > 0 && custody.cutoverCommittedAt === returned.cutoverCommittedAt &&
        custody.completedAt >= custody.cutoverCommittedAt &&
        typeof returned.completedAt === "number" && returned.completedAt >= custody.completedAt;
}
function schedulerReturnMatches(owner, input, returned, custody) {
    const handoff = returned.schedulerHandoff;
    return handoff !== undefined && custody.uid === owner.uid && custody.slug === owner.slug && custody.slug === handoff.slug &&
        custody.returnOperationId === input.returnOperationId && typeof custody.migrationId === "string" &&
        custody.migrationId === handoff.migrationId && custody.uid === handoff.uid &&
        custody.sourceGatewayId === input.gatewayId && custody.sourceGatewayId === handoff.fromGatewayId &&
        custody.sharedGatewayId === input.sharedId && custody.sharedGatewayId === handoff.toGatewayId &&
        schedulerReturnCompleted(returned, custody);
}
function schedulerHomeMatches(owner, source, custody) {
    return custody.homeDiskId === source.homeDiskId && custody.homeDiskSource === owner.home.homeDisk?.source &&
        custody.zone === source.zone && custody.instanceName === source.instanceName && numericIdentity(custody.instanceId);
}
export function retainedBootPreservesScheduler(image, custody, gateways) {
    const predecessor = image.sourceComputer;
    return image.homeAdmission === true && image.homeId === custody.homeDiskId && predecessor != null &&
        predecessor.name === custody.instanceName && predecessor.zone === custody.zone &&
        typeof predecessor.gatewayId === "string" && gateways.includes(predecessor.gatewayId) &&
        numericIdentity(predecessor.instanceId) && (predecessor.instanceId === custody.instanceId ||
        isDeepStrictEqual(image.nativeSchedulerRetirement, custody));
}
export function archivedSchedulerSourceImage(owner, gatewayId, instanceId, custody) {
    if (custody.instanceId === instanceId)
        return null;
    const image = owner.home.homeDisk?.bootImage;
    if (!image || !retainedBootPreservesScheduler(image, custody, [gatewayId]) ||
        typeof image.operationId !== "string" || !image.operationId ||
        !numericIdentity(image.id) || typeof image.name !== "string" || typeof image.project !== "string") {
        throw new IneligibleHomeArchiveError("Home archive lacks exact parked scheduler replacement lineage");
    }
    return { id: image.id, name: image.name, project: image.project };
}
export function archiveSchedulerCustodyMatches(owner, archive) {
    if (archive.nativeSchedulerRetirement === undefined)
        return owner.fences.pendingNativeSchedulerRetirement === undefined;
    return isDeepStrictEqual(archive.nativeSchedulerRetirement, owner.fences.pendingNativeSchedulerRetirement);
}
function archiveNativeScheduler(owner, input, returned, source, instanceId) {
    const custody = owner.fences.pendingNativeSchedulerRetirement;
    if (!custody && !returned.schedulerHandoff)
        return undefined;
    if (!custody || !schedulerReturnMatches(owner, input, returned, custody) || !schedulerHomeMatches(owner, source, custody)) {
        throw new IneligibleHomeArchiveError("Home archive requires the terminal native scheduler receipt for this home");
    }
    archivedSchedulerSourceImage(owner, input.gatewayId, instanceId, custody);
    return custody;
}
function parkedArchiveRoot(root, grant) {
    return root?.gatewayClass === "isolated" && root.ownerUid === grant.ownerUid && root.desiredStatus === "paused" &&
        root.liveRelease != null && root.desiredRelease === root.liveRelease && root.retirementClaim == null &&
        root.sizingProfile === grant.sizingProfile;
}
async function verifyArchiveInputs(tx, owner, input, grant) {
    const { gatewayId, sharedId, returnOperationId } = input;
    const { ownerUid } = grant;
    const [root, shared, assignment, returned, pending, runtime] = await Promise.all([
        tx.gateways.roots.get(gatewayId), tx.gateways.roots.get(sharedId), tx.gateways.assignments.get(sharedId, ownerUid),
        tx.journal.operations.get(returnOperationId), tx.journal.operations.listForUid(ownerUid, { statuses: ["pending", "running"] }),
        tx.fleetRegistry.get(gatewayId),
    ]);
    if (!parkedArchiveRoot(root, grant) || shared?.gatewayClass !== "shared" ||
        assignment?.uid !== ownerUid || assignment.gatewayId !== sharedId || assignment.state !== "serving" ||
        !Number.isSafeInteger(assignment.epoch) || assignment.epoch < 0 ||
        !returned || !hasVerifiedReturn(returned, ownerUid, gatewayId, sharedId) || pending.length > 0) {
        throw new IneligibleHomeArchiveError("Home archive requires a settled native return to the serving Shared assignment");
    }
    const observed = observedArchiveSource(owner, input, runtime);
    if (!numericIdentity(observed?.instanceId))
        throw new IneligibleHomeArchiveError("Home archive lacks the parked VM observation");
    const source = { instanceName: observed.instanceName, zone: observed.zone, homeDiskId: owner.home.homeDisk.id };
    const nativeSchedulerRetirement = archiveNativeScheduler(owner, input, returned, source, observed.instanceId);
    return { gatewayId, sharedId, instanceId: observed.instanceId, assignmentEpoch: assignment.epoch, source, nativeSchedulerRetirement };
}
export async function writeParkedHomeArchive(tx, owner, target, operation) {
    const ownerUid = owner.uid;
    const { gatewayId, instanceId, sharedId, assignmentEpoch } = target;
    const { operationId, createdBy, origin, now } = operation;
    const homeArchive = { phase: "preparing", operationId, gatewayId, instanceId, source: target.source,
        ...(target.nativeSchedulerRetirement ? { nativeSchedulerRetirement: target.nativeSchedulerRetirement } : {}) };
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
        const target = await verifyArchiveInputs(tx, owner, parkedArchiveInputs({ ...owner, activationLease: next }), grant);
        const operationId = randomUUID();
        return () => writeParkedHomeArchive(tx, owner, target, {
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
        const target = await verifyArchiveInputs(tx, owner, parkedArchiveInputs(owner), grant);
        const operationId = randomUUID();
        if (input.dryRun)
            return { operationId };
        await writeParkedHomeArchive(tx, owner, target, {
            operationId, createdBy, origin: "operator", now: Date.now(),
        });
        return { operationId };
    });
}
