import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isUserParkedVm, type GatewayVmDesktop } from "@octogee/shared/types/glm";
import { idleSnapshotDesktop } from "@octogee/shared/types/sizing-profile";
import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { builderReturnOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { restoredHomeBackupReleaseId } from "./isolated-gateway-lifecycle/home-backup-release.js";
import type { OperationRecord } from "./platform-state/operations.js";
import type { FleetRegistryRecord } from "./platform-state/fleet-registry.js";
import type { OpaqueMap, PlatformStateRepositories, PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";
import type { PlatformUserRecord, UserActivationLease, UserHomeArchive } from "./platform-state/users.js";

export interface ParkedHomeArchiveGrant {
  ownerUid: string;
  sizingProfile: string;
  desktop?: GatewayVmDesktop;
}

export const logger = createServiceLogger("idle-storage");

const OPERATOR_GRANT_DESKTOP: GatewayVmDesktop = "x11";

function grantedArchiveDesktop(grant: ParkedHomeArchiveGrant): GatewayVmDesktop {
  return grant.desktop ?? OPERATOR_GRANT_DESKTOP;
}

export async function readParkedHomeArchiveGrant(
  state: Pick<PlatformStateRepositories, "config" | "gateways">,
  target: { ownerUid: string; gatewayId: string },
  operatorGrant: ParkedHomeArchiveGrant | undefined,
): Promise<ParkedHomeArchiveGrant | undefined> {
  const root = await state.gateways.roots.get(target.gatewayId);
  const sizingProfile = root?.sizingProfile;
  if (root?.ownerUid === target.ownerUid && sizingProfile) {
    const profiles = (await state.config.orchestrator.get())?.sizingProfiles ?? {};
    const desktop = idleSnapshotDesktop(Object.hasOwn(profiles, sizingProfile) ? profiles[sizingProfile] : undefined);
    if (desktop) return { ownerUid: target.ownerUid, sizingProfile, desktop };
  }
  return operatorGrant?.ownerUid === target.ownerUid ? operatorGrant : undefined;
}

export async function readOwnerHomeArchiveGrant(
  state: Pick<PlatformStateRepositories, "config" | "gateways" | "users">,
  ownerUid: string,
  operatorGrant: ParkedHomeArchiveGrant | undefined,
): Promise<ParkedHomeArchiveGrant | undefined> {
  const owner = await state.users.records.get(ownerUid);
  const gatewayId = owner?.home.homeArchive?.gatewayId ?? owner?.activationLease?.targetGatewayId;
  if (typeof gatewayId !== "string") return operatorGrant?.ownerUid === ownerUid ? operatorGrant : undefined;
  return readParkedHomeArchiveGrant(state, { ownerUid, gatewayId }, operatorGrant);
}

export function parkedHomeUnderSnapshotCustody(owner: PlatformUserRecord | null): boolean {
  const archive = owner?.home.homeArchive;
  return archive !== undefined && archive.phase !== "restored";
}

class IneligibleHomeArchiveError extends Error {}

const RETURN_ARCHIVE_ACTOR = "glm-controller-return-home-archive";

export function isAuthorizedHomeArchiveOrigin(operation: { origin?: unknown; createdBy?: unknown }): boolean {
  return operation.origin === "operator" || (operation.origin === "automatic" && operation.createdBy === RETURN_ARCHIVE_ACTOR);
}

export function resolveParkedHomeArchiveGrant(environment: string | null | undefined, value: string | undefined): ParkedHomeArchiveGrant | undefined {
  if (environment !== "test" || !value) return undefined;
  const match = /^([A-Za-z0-9_-]{1,63}):([a-z][a-z0-9-]{0,62})$/u.exec(value);
  if (!match) throw new Error("Invalid TEST home archive grant; expected owner UID and sizing profile");
  return { ownerUid: match[1], sizingProfile: match[2] };
}

function hasVerifiedReturn(operation: OperationRecord | null, ownerUid: string, isolated: string, shared: string): boolean {
  const park = operation?.output?.nativeSourcePark as { parked?: unknown } | undefined;
  return operation?.status === "succeeded" && operation.kind === "migrate-user" &&
    operation.inputUid === ownerUid && operation.input.fromGatewayId === isolated &&
    operation.input.toGatewayId === shared && (park?.parked === "stopped" || park?.parked === "suspended");
}

export function simpleHomePreparation(value: PlatformUserRecord["home"]["homeMigration"]): boolean {
  return value === undefined || (value.phase === "complete" &&
    value.id === undefined && value.source === undefined && value.target === undefined && value.copy === undefined);
}

function pilotHomeEligible(owner: PlatformUserRecord): boolean {
  const { home, fences } = owner;
  return home.homeStorage === undefined && simpleHomePreparation(home.homeMigration) && home.homeErasure === undefined &&
    fences.sourceTransferFence === undefined && fences.restoreFence === undefined && fences.migration === undefined &&
    (owner.accountLifecycle === null || owner.accountLifecycle.status === "active");
}

function numericIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,19}$/u.test(value);
}

function matchesArchiveFence(owner: PlatformUserRecord, archive: UserHomeArchive): boolean {
  const fence = owner.fences.computerRecovery;
  return fence?.operationId === archive.operationId && fence.gatewayId === archive.gatewayId &&
    fence.instanceId === archive.instanceId && owner.activationLease?.status === "parked";
}

async function retryArchive(tx: PlatformStateTransaction, owner: Stored<PlatformUserRecord>, existing: UserHomeArchive, dryRun?: boolean) {
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
    if (!dryRun) await tx.journal.operations.patch(operation.id, {
      status: "pending", startedAt: null, completedAt: null, error: { clear: true }, nextAttemptAt: { clear: true }, expireAt: { clear: true },
    });
  }
  return { operationId: existing.operationId };
}

function parkedArchiveInputs(owner: Stored<PlatformUserRecord>) {
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

type ParkedInput = ReturnType<typeof parkedArchiveInputs>;
type ArchiveSource = NonNullable<UserHomeArchive["source"]>;

function observedArchiveVm(runtime: FleetRegistryRecord | null, homeZone: unknown, desktop: GatewayVmDesktop) {
  const observed = runtime?.vm;
  return runtime?.runtime === "gce-vm" && runtime.vmSpec?.desktop === desktop && observed &&
    ["SUSPENDED", "TERMINATED", "STOPPED"].includes(observed.status ?? "") &&
    numericIdentity(observed.instanceId) && observed.zone === homeZone ? observed : null;
}

function observedArchiveSource(owner: PlatformUserRecord, input: ParkedInput, runtime: FleetRegistryRecord | null, desktop: GatewayVmDesktop) {
  const homeZone = owner.home.homeDisk?.zone;
  if (runtime !== null) return observedArchiveVm(runtime, homeZone, desktop);
  if (owner.home.projectStorageNativeBoot === true || owner.fences.pendingNativeSchedulerRetirement !== undefined) return null;
  const parked = owner.home.computer;
  return isUserParkedVm(parked) && !parked.disposable && parked.vmSpec?.desktop === desktop &&
    parked.gatewayId === input.gatewayId && parked.zone === homeZone && numericIdentity(parked.instanceId) ? parked : null;
}

function schedulerReturnCompleted(returned: OperationRecord, custody: OpaqueMap): boolean {
  return typeof custody.completedAt === "number" && typeof custody.cutoverCommittedAt === "number" &&
    custody.cutoverCommittedAt > 0 && custody.cutoverCommittedAt === returned.cutoverCommittedAt &&
    custody.completedAt >= custody.cutoverCommittedAt &&
    typeof returned.completedAt === "number" && returned.completedAt >= custody.completedAt;
}

export function schedulerReturnMatches(owner: PlatformUserRecord, input: ParkedInput, returned: OperationRecord, custody: OpaqueMap): boolean {
  const handoff = returned.schedulerHandoff;
  return handoff !== undefined && custody.uid === owner.uid && custody.slug === owner.slug && custody.slug === handoff.slug &&
    custody.returnOperationId === input.returnOperationId && typeof custody.migrationId === "string" &&
    custody.migrationId === handoff.migrationId && custody.uid === handoff.uid &&
    custody.sourceGatewayId === input.gatewayId && custody.sourceGatewayId === handoff.fromGatewayId &&
    custody.sharedGatewayId === input.sharedId && custody.sharedGatewayId === handoff.toGatewayId &&
    schedulerReturnCompleted(returned, custody);
}

function schedulerHomeMatches(owner: PlatformUserRecord, source: ArchiveSource, custody: OpaqueMap): boolean {
  return custody.homeDiskId === source.homeDiskId && custody.homeDiskSource === owner.home.homeDisk?.source &&
    custody.zone === source.zone && custody.instanceName === source.instanceName && numericIdentity(custody.instanceId);
}

export function retainedBootPreservesScheduler(image: OpaqueMap, custody: OpaqueMap, gateways: readonly string[]): boolean {
  const predecessor = image.sourceComputer as OpaqueMap | undefined;
  return image.homeAdmission === true && image.homeId === custody.homeDiskId && predecessor != null &&
    predecessor.name === custody.instanceName && predecessor.zone === custody.zone &&
    typeof predecessor.gatewayId === "string" && gateways.includes(predecessor.gatewayId) &&
    numericIdentity(predecessor.instanceId) && (predecessor.instanceId === custody.instanceId ||
      isDeepStrictEqual(image.nativeSchedulerRetirement, custody));
}

export function archivedSchedulerSourceImage(owner: PlatformUserRecord, gatewayId: string, instanceId: string, custody: OpaqueMap) {
  if (custody.instanceId === instanceId) return null;
  const image = owner.home.homeDisk?.bootImage as OpaqueMap | undefined;
  if (!image || !retainedBootPreservesScheduler(image, custody, [gatewayId]) ||
      typeof image.operationId !== "string" || !image.operationId ||
      !numericIdentity(image.id) || typeof image.name !== "string" || typeof image.project !== "string") {
    throw new IneligibleHomeArchiveError("Home archive lacks exact parked scheduler replacement lineage");
  }
  return { id: image.id, name: image.name, project: image.project };
}

export function archiveSchedulerCustodyMatches(owner: PlatformUserRecord, archive: UserHomeArchive): boolean {
  if (archive.nativeSchedulerRetirement === undefined) return owner.fences.pendingNativeSchedulerRetirement === undefined;
  return isDeepStrictEqual(archive.nativeSchedulerRetirement, owner.fences.pendingNativeSchedulerRetirement);
}

function archiveNativeScheduler(owner: PlatformUserRecord, input: ParkedInput, returned: OperationRecord, source: ArchiveSource, instanceId: string) {
  const custody = owner.fences.pendingNativeSchedulerRetirement;
  if (!custody && !returned.schedulerHandoff) return undefined;
  if (!custody || !schedulerReturnMatches(owner, input, returned, custody) || !schedulerHomeMatches(owner, source, custody)) {
    throw new IneligibleHomeArchiveError("Home archive requires the terminal native scheduler receipt for this home");
  }
  archivedSchedulerSourceImage(owner, input.gatewayId, instanceId, custody);
  return custody;
}

function parkedArchiveRoot(root: Awaited<ReturnType<PlatformStateTransaction["gateways"]["roots"]["get"]>>, grant: ParkedHomeArchiveGrant): boolean {
  return root?.gatewayClass === "isolated" && root.ownerUid === grant.ownerUid && root.desiredStatus === "paused" &&
    root.liveRelease != null && root.desiredRelease === root.liveRelease && root.retirementClaim == null &&
    root.sizingProfile === grant.sizingProfile;
}

interface ReleasedHomeBackup {
  operationId: string;
  instanceId: string;
}

function archiveHasPendingConflict(pending: readonly OperationRecord[], backup?: ReleasedHomeBackup): boolean {
  return pending.some(operation => operation.id !== backup?.operationId || operation.status !== "running");
}

function requireParkedArchiveVm(observed: ReturnType<typeof observedArchiveSource>, backup?: ReleasedHomeBackup) {
  const instanceId = observed?.instanceId;
  if (!observed || !numericIdentity(instanceId) || (backup && instanceId !== backup.instanceId)) {
    throw new IneligibleHomeArchiveError("Home archive lacks the parked VM observation");
  }
  return { ...observed, instanceId };
}

async function verifyArchiveInputs(tx: PlatformStateTransaction, owner: Stored<PlatformUserRecord>, input: ParkedInput,
  grant: ParkedHomeArchiveGrant, backup?: ReleasedHomeBackup): Promise<ArchiveTarget> {
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
      !returned || !hasVerifiedReturn(returned, ownerUid, gatewayId, sharedId) || archiveHasPendingConflict(pending, backup)) {
    throw new IneligibleHomeArchiveError("Home archive requires a settled native return to the serving Shared assignment");
  }
  const desktop = grantedArchiveDesktop(grant);
  const observed = requireParkedArchiveVm(observedArchiveSource(owner, input, runtime, desktop), backup);
  const source = { instanceName: observed.instanceName, zone: observed.zone, homeDiskId: owner.home.homeDisk!.id as string };
  const nativeSchedulerRetirement = archiveNativeScheduler(owner, input, returned, source, observed.instanceId);
  return { gatewayId, sharedId, instanceId: observed.instanceId, assignmentEpoch: assignment.epoch, source, desktop, nativeSchedulerRetirement };
}

interface ArchiveTarget {
  gatewayId: string;
  instanceId: string;
  sharedId: string;
  assignmentEpoch: number;
  source: ArchiveSource;
  desktop: GatewayVmDesktop;
  nativeSchedulerRetirement?: OpaqueMap;
}

export async function writeParkedHomeArchive(tx: PlatformStateTransaction, owner: Stored<PlatformUserRecord>,
  target: ArchiveTarget, operation: { operationId: string; createdBy: string; origin: "operator" | "automatic"; now: number }): Promise<void> {
  const ownerUid = owner.uid;
  const { gatewayId, instanceId, sharedId, assignmentEpoch } = target;
  const { operationId, createdBy, origin, now } = operation;
  const homeArchive: UserHomeArchive = { phase: "preparing", operationId, gatewayId, instanceId, source: target.source, desktop: target.desktop,
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

export async function planReturnedHomeArchive(tx: PlatformStateTransaction, owner: Stored<PlatformUserRecord>, next: UserActivationLease,
  operatorGrant: ParkedHomeArchiveGrant | undefined, now: number): Promise<(() => Promise<void>) | undefined> {
  if (owner.home.homeArchive !== undefined) return;
  return planEligibleReturnedArchive(tx, owner, next, operatorGrant, { now });
}

function matchesReturnedBackup(owner: Stored<PlatformUserRecord>, releaseOperationId: string, next: UserActivationLease) {
  const archive = owner.home.homeArchive;
  return archive?.phase === "restored" && restoredHomeBackupReleaseId(archive.operationId) === releaseOperationId &&
    typeof archive.releaseProvenForActivation === "string" && archive.releaseProvenForActivation === next.activationOperationId && archive.targetGatewayId === next.targetGatewayId &&
    archive.leaseId === next.leaseId && archive.generation === next.generation &&
    next.returnOperationId === builderReturnOperationId(archive.targetGatewayId, archive.generation) &&
    archive.restoredDisk.id === owner.home.homeDisk?.id && archive.restoredDisk.source === owner.home.homeDisk.source
    ? { operationId: releaseOperationId, instanceId: archive.restoredInstanceId } : undefined;
}

export async function planArchiveAfterBackupRelease(tx: PlatformStateTransaction, owner: Stored<PlatformUserRecord>,
  releaseOperationId: string, operatorGrant: ParkedHomeArchiveGrant | undefined, now: number): Promise<(() => Promise<void>) | undefined> {
  const next = owner.activationLease;
  if (!next) return;
  const backup = matchesReturnedBackup(owner, releaseOperationId, next);
  if (backup) return planEligibleReturnedArchive(tx, owner, next, operatorGrant, { now, backup });
}

async function planEligibleReturnedArchive(tx: PlatformStateTransaction, owner: Stored<PlatformUserRecord>, next: UserActivationLease,
  operatorGrant: ParkedHomeArchiveGrant | undefined, { now, backup }: { now: number; backup?: ReleasedHomeBackup }): Promise<(() => Promise<void>) | undefined> {
  if (next.status !== "parked" || typeof next.targetGatewayId !== "string") return;
  const grant = await readParkedHomeArchiveGrant(tx, { ownerUid: owner.uid, gatewayId: next.targetGatewayId }, operatorGrant);
  if (!grant) return;
  try {
    if (!pilotHomeEligible(owner)) {
      throw new IneligibleHomeArchiveError("Home archive requires a simple retained home with no migration, erasure or transfer in progress");
    }
    const target = await verifyArchiveInputs(tx, owner, parkedArchiveInputs({ ...owner, activationLease: next }), grant, backup);
    const operationId = randomUUID();
    return () => writeParkedHomeArchive(tx, owner, target, {
      operationId, createdBy: RETURN_ARCHIVE_ACTOR, origin: "automatic", now,
    });
  } catch (error) {
    if (!(error instanceof IneligibleHomeArchiveError)) throw error;
    logger.warn("keeping the parked VM and its disks while idle", {
      uid: owner.uid, gatewayId: next.targetGatewayId, sizingProfile: grant.sizingProfile, reason: error.message,
    });
    return undefined;
  }
}

export async function enqueueParkedHomeArchive(store: PlatformStateStore, input: {
  ownerUid: string; grant: ParkedHomeArchiveGrant | undefined; createdBy: string; dryRun?: boolean;
}): Promise<{ operationId: string }> {
  const { ownerUid, grant, createdBy } = input;
  if (!grant || grant.ownerUid !== ownerUid || !grant.sizingProfile) throw new Error("No exact parked home archive grant");
  return store.transaction({ label: "parked-home.archive", readOnly: input.dryRun === true }, async tx => {
    const owner = await tx.users.records.get(ownerUid);
    if (!owner || !pilotHomeEligible(owner)) throw new Error("User home is outside the archive pilot");
    const existing = owner.home.homeArchive;
    if (existing) return retryArchive(tx, owner, existing, input.dryRun);
    const target = await verifyArchiveInputs(tx, owner, parkedArchiveInputs(owner), grant);
    const operationId = randomUUID();
    if (input.dryRun) return { operationId };
    await writeParkedHomeArchive(tx, owner, target, {
      operationId, createdBy, origin: "operator", now: Date.now(),
    });
    return { operationId };
  });
}
