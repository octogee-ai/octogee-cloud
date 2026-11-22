import { isDeepStrictEqual } from "node:util";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { hasFreshReadyKubernetesObservation, releasePayloadHash, type GatewayHelmObservation, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { gatewayHeartbeatMatchesImageTag, isGatewayImageTag } from "@octogee/shared/types/image-tag";
import { appendRetainedSharedMaintenanceReleaseInStore } from "./gateway-release-append.js";
import {
  readHeldNativeReturnForTargetMaintenance, type HeldNativeReturnSelection,
} from "./held-native-return-repair.js";
import { schedulerReturnMatches } from "./parked-home-archive.js";
import { buildOperationAuditIntent, operationAuditDocumentId } from "./operation-audit.js";
import { CONTINUOUS_PLACEMENT_SOURCE, PLACEMENT_MIGRATION_ACTOR, sharedDrainMoveNeverClaimed } from "./placement-migrations.js";
import type {
  GatewayRuntimeRestartFenceValue, OpaqueMap, OperationRecord, PlatformStateRepositories, PlatformStateStore, PlatformStateTransaction, PlatformUserRecord, Stored,
} from "./platform-state/index.js";

export class SharedHeldReturnMaintenanceConflict extends Error {}

export const SHARED_HELD_RETURN_MAINTENANCE = "shared-held-return-maintenance";
const AUDIT_IN_PROGRESS = "in-progress";
const SHARED_INERT_EMPTY_PEER = "shared-inert-empty-peer";

type Workload = { podName: string; podUid: string; replicaSetUid: string; deploymentUid: string };
export type SharedInertEmptyPeerScope = { gatewayId: string; workload: Workload };
type SharedInertEmptyPeerFence = GatewayRuntimeRestartFenceValue & {
  kind: typeof SHARED_INERT_EMPTY_PEER;
  retainedGatewayId: string;
  workload: Workload;
};
type EmptyPeerJournal = { scope: SharedInertEmptyPeerScope; acquiredAt: number; restoredAt?: number };

type RoleImages = { gateway: string; "gateway-edge": string };
type RetainedBoot = { gatewayImageTag: string; completedInitImageId: string };
type RetainedOwner = { uid: string; slug: string; epoch: number; homeIdentitySha256: string };

export interface SharedHeldReturnMaintenancePlan {
  selection: HeldNativeReturnSelection;
  targetRelease: number;
  workload: Workload;
  retainedBoot: RetainedBoot;
  originalImages: RoleImages;
  maintenanceImages: RoleImages;
  acceptedMaintenanceSource: string;
  acceptedNativeSource: string;
  originalNativeSource: string;
  installedChartFingerprint: string;
  owners: RetainedOwner[];
}

export type SharedHeldReturnMaintenanceAdmission = SharedHeldReturnMaintenancePlan & {
  exactWorkloadObserved: true;
  noInFlightTasks: true;
  noPreparedImports: true;
  rollbackVerified: true;
  observedAt: number;
};

export interface SharedHeldReturnMaintenanceResult {
  attemptId: string;
  outcome: "installed" | "rolled-back";
  workload: Workload;
  images: RoleImages;
  runningImageIds: RoleImages;
  retainedBoot: RetainedBoot;
  nativeSource: string;
  owners: RetainedOwner[];
  noInFlightTasks: true;
  noPreparedImports: true;
  exclusiveReady: true;
  verifiedAt: number;
}

export interface ObservedSharedMaintenanceHelm {
  installed: GatewayHelmObservation;
  chartFingerprint: string;
  edgeImage: string;
  verifiedAt: number;
}

export interface SharedHeldReturnMaintenanceWithdrawal extends Omit<SharedHeldReturnMaintenanceResult, "outcome"> {
  migrationPolicyRestored: true;
  installed: ObservedSharedMaintenanceHelm;
}

type StagedRelease = { release: number; payloadHash: string; phase: "dispatched" | "rollback" };

export interface SharedHeldReturnMaintenanceClaim {
  gatewayId: string;
  auditId: string;
  attemptId: string;
  plan: SharedHeldReturnMaintenancePlan;
}

export type SharedHeldReturnMaintenanceDispatch = {
  phase: "dispatched" | "rollback";
  release: number;
};

type ScopedMaintenance = { operationId: string; gatewayId: string; attemptId: string };
export type SharedHeldReturnMaintenanceCommand =
  | { action: "acquire"; attemptId: string; selection: HeldNativeReturnSelection }
  | ({ action: "status" | "hold-migration-policy" | "dispatch" | "stage" | "apply" | "rollback" | "withdraw" | "complete" } & ScopedMaintenance);

export type SharedHeldReturnMaintenanceAdmin = (
  actor: string, command: SharedHeldReturnMaintenanceCommand, dryRun: boolean,
) => Promise<unknown>;

export interface SharedInertMaintenancePriorProof {
  attemptId: string;
  podUid: string;
  artifactSetId: string;
  originalContainerIds: RoleImages;
  ownerBackups: (RetainedOwner & { restoredArchiveSha256: string })[];
}

export interface SharedInertMaintenanceCommonProof {
  attemptId: string;
  podUid: string;
  artifactSetId: string;
  originalContainerIds: RoleImages;
  heldContainerIds: RoleImages;
  observedImageIds: RoleImages;
  ownerHomes: RetainedOwner[];
  custodyGeneration: string;
  restoredArchiveSha256: string;
  writersHeldAt: number;
  capturedAt: number;
  restoredAt: number;
}

type InertStartup = {
  prior: SharedInertMaintenancePriorProof;
  preparedAt: number;
  common?: SharedInertMaintenanceCommonProof;
  rollingBackAt?: number;
};

type Phase = "reserved" | "withdrawing" | "dispatched" | "rollback";
type Guard = GatewayRuntimeRestartFenceValue & {
  phase: Phase; phaseStartedAt: number; maintenance: SharedHeldReturnMaintenancePlan;
  stagedRelease?: StagedRelease; restoringMigrationPolicy?: true; inertStartup?: InertStartup; emptyPeer?: EmptyPeerJournal;
};

function requireMaintenance(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SharedHeldReturnMaintenanceConflict(message);
}

function sortedOwners<T extends { uid: string }>(owners: T[]): T[] {
  return [...owners].sort((a, b) => a.uid.localeCompare(b.uid));
}

function matchesWorkload(workload: Workload): boolean {
  return /^[a-z0-9][a-z0-9.-]*$/.test(workload.podName) &&
    [workload.podUid, workload.replicaSetUid, workload.deploymentUid].every(uid => /^[0-9a-f-]{36}$/.test(uid));
}

function validImages(images: RoleImages): boolean {
  return Object.keys(images).length === 2 &&
    [images.gateway, images["gateway-edge"]].every(image => /^\S+@sha256:[a-f0-9]{64}$/.test(image));
}

function normalizePlan(admission: SharedHeldReturnMaintenanceAdmission, now: number): SharedHeldReturnMaintenancePlan {
  const { noInFlightTasks, noPreparedImports, rollbackVerified, exactWorkloadObserved, observedAt, ...plan } = admission;
  requireMaintenance(Number.isSafeInteger(observedAt) && observedAt <= now && now - observedAt <= 60_000,
    "Shared held return maintenance requires a fresh verified observation");
  requireMaintenance([noInFlightTasks, noPreparedImports, rollbackVerified, exactWorkloadObserved].every(value => value === true),
    "Shared held return maintenance requires observed quiet custody and verified rollback");
  requireMaintenance(matchesWorkload(plan.workload) && validImages(plan.originalImages) && validImages(plan.maintenanceImages) &&
    [plan.acceptedMaintenanceSource, plan.acceptedNativeSource, plan.originalNativeSource].every(sha => /^[a-f0-9]{40}$/.test(sha)) &&
    /^[a-f0-9]{64}$/.test(plan.installedChartFingerprint) && isGatewayImageTag(plan.retainedBoot.gatewayImageTag) &&
    /sha256:[a-f0-9]{64}$/.test(plan.retainedBoot.completedInitImageId),
    "Shared held return maintenance release or workload identity is invalid");
  requireMaintenance(plan.owners.length === 6 &&
    new Set(plan.owners.map(owner => owner.uid)).size === 6 &&
    new Set(plan.owners.map(owner => owner.slug)).size === 6 &&
    plan.owners.every(owner => /^[a-f0-9]{64}$/.test(owner.homeIdentitySha256)),
  "Shared held return maintenance requires the six individually verified owner homes");
  return { ...plan, owners: sortedOwners(plan.owners) };
}

function ownerScope(owners: RetainedOwner[]) {
  return owners.map(({ uid, slug, epoch }) => ({ uid, slug, epoch }));
}

function canLeaveQueued(op: Stored<OperationRecord>, targetGatewayId: string, owners: RetainedOwner[]): boolean {
  return [
    op.kind === "migrate-user", op.origin === "automatic", op.createdBy === PLACEMENT_MIGRATION_ACTOR,
    sharedDrainMoveNeverClaimed({ ...op }), op.completedAt === null, op.restoreAttempt === undefined,
    op.input.source === CONTINUOUS_PLACEMENT_SOURCE, op.input.fromGatewayId === targetGatewayId,
    typeof op.input.toGatewayId === "string", op.input.toGatewayId !== targetGatewayId,
    owners.some(owner => owner.uid === op.inputUid && owner.uid === op.input.uid && owner.slug === op.input.userSlug),
  ].every(Boolean);
}

function touchesScope(op: Stored<OperationRecord>, gatewayId: string, owners: RetainedOwner[]): boolean {
  return [op.gatewayId, op.input.gatewayId, op.input.fromGatewayId, op.input.toGatewayId, op.input.sourceGatewayId,
    op.input.targetGatewayId].includes(gatewayId) || owners.some(owner =>
    [op.inputUid, op.input.uid, op.input.ownerUid, op.input.userId].includes(owner.uid));
}

async function assertMountedCrew(state: PlatformStateRepositories, plan: SharedHeldReturnMaintenancePlan) {
  const runtime = await state.fleetRegistry.get(plan.selection.targetGatewayId);
  requireMaintenance(runtime?.heartbeat.status === "ready" && !runtime.heartbeat.migratingIn?.length &&
    isDeepStrictEqual([...runtime.heartbeat.mountedCustomers].sort(), plan.owners.map(owner => owner.slug).sort()),
  "Shared maintenance mounted roster or target readiness changed");
  return runtime;
}

export async function assertSharedHeldReturnMaintenanceUnfenced(
  state: PlatformStateRepositories, operation: Pick<OperationRecord, "input" | "inputUid" | "gatewayId" | "schedulerHandoff">,
): Promise<void> {
  const { input } = operation;
  const ownerUid = operation.inputUid ?? input.uid ?? input.ownerUid ?? input.userId;
  const owner = typeof ownerUid === "string" && ownerUid && !ownerUid.includes("/") ? await state.users.records.get(ownerUid) : null;
  const gateways = [...new Set([operation.gatewayId, input.gatewayId, input.fromGatewayId, input.toGatewayId,
    input.sourceGatewayId, input.targetGatewayId, owner?.gateway?.gatewayId]
    .filter((id): id is string => typeof id === "string" && id !== "" && !id.includes("/")))];
  if (gateways.length) {
    const roots = await state.gateways.roots.getMany(gateways);
    requireMaintenance(![...roots.values()].some(root => {
      const kind = root.runtimeRestartFence?.kind;
      return kind === SHARED_HELD_RETURN_MAINTENANCE || kind === SHARED_INERT_EMPTY_PEER;
    }),
      "Shared held return maintenance blocks this operation");
  }
  const forward = operation.schedulerHandoff?.forwardRecovery;
  requireMaintenance(!forward?.sharedTargetImportHold || forward.offlineSourceRecovery?.phase === "stopped-original",
    "Shared maintenance holds the original return for offline source custody");
}

function isDocumentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("/");
}

function referencesOwnedHome(owner: PlatformUserRecord, reference: OpaqueMap): boolean {
  const home = owner.home.homeDisk;
  return Boolean(home?.id && home.id === reference.homeDiskId && home.source === reference.homeDiskSource &&
    typeof reference.instanceId === "string" && /^[1-9]\d{0,19}$/.test(reference.instanceId));
}

function hasTerminalReturn(
  owner: PlatformUserRecord, returned: OperationRecord, reference: OpaqueMap,
  ids: { returnOperationId: string; sourceGatewayId: string; sharedGatewayId: string },
): boolean {
  const { returnOperationId, sourceGatewayId, sharedGatewayId } = ids;
  const park = returned.output?.nativeSourcePark as { parked?: unknown } | undefined;
  const input = { gatewayId: sourceGatewayId, sharedId: sharedGatewayId, returnOperationId };
  return [returned.kind === "migrate-user", returned.status === "succeeded", returned.input?.uid === owner.uid,
    returned.input?.fromGatewayId === sourceGatewayId, returned.input?.toGatewayId === sharedGatewayId,
    schedulerReturnMatches(owner, input, returned, reference),
    park?.parked === "stopped" || park?.parked === "suspended"].every(Boolean);
}

async function sourceIsDormant(
  state: PlatformStateRepositories, owner: PlatformUserRecord, sourceGatewayId: string,
): Promise<boolean> {
  const source = await state.gateways.roots.get(sourceGatewayId);
  const observation = await state.fleetRegistry.get(sourceGatewayId);
  if (!(await state.gateways.assignments.isEmpty(sourceGatewayId))) return false;
  if (source === null && observation === null) return true;
  if (!source || !observation) return false;
  return [source.gatewayClass === "isolated", source.ownerUid === owner.uid, source.builderSlug === owner.slug,
    source.desiredStatus === "paused", source.runtimeRestartFence === undefined, source.retirementClaim == null,
    observation.runtime === "gce-vm", ["SUSPENDED", "TERMINATED", "STOPPED"].includes(observation.vm?.status ?? "")].every(Boolean);
}

async function dormantSchedulerReferenceDoesNotHoldShared(
  state: PlatformStateRepositories, owner: PlatformUserRecord,
): Promise<boolean> {
  const { pendingNativeSchedulerRetirement: reference, ...active } = owner.fences;
  if (Object.keys(active).length !== 0) return false;
  if (reference === undefined) return true;
  const { returnOperationId, sourceGatewayId, sharedGatewayId } = reference;
  if (!isDocumentId(returnOperationId) || !isDocumentId(sourceGatewayId) || !isDocumentId(sharedGatewayId) ||
    !referencesOwnedHome(owner, reference)) return false;
  const returned = await state.journal.operations.get(returnOperationId);
  if (!returned || !hasTerminalReturn(owner, returned, reference, { returnOperationId, sourceGatewayId, sharedGatewayId })) return false;
  return sourceIsDormant(state, owner, sourceGatewayId);
}

async function assertRetainedCrewOwner(state: PlatformStateRepositories, gatewayId: string, owner: RetainedOwner): Promise<void> {
  const user = await state.users.records.get(owner.uid);
  const assignments = await state.gateways.assignments.listForUid(owner.uid);
  const [assigned] = assignments;
  requireMaintenance(user && assigned, "Shared maintenance owner custody changed");
  const lease = user.activationLease;
  requireMaintenance([user.gateway?.gatewayId === gatewayId, user.slug === owner.slug, user.admitted,
    user.accountLifecycle == null || user.accountLifecycle.status === "active",
    !lease || lease.status === "parked" || lease.status === "failed",
    assigned.gatewayId === gatewayId, assigned.epoch === owner.epoch, assignments.length === 1].every(Boolean) &&
    await dormantSchedulerReferenceDoesNotHoldShared(state, user), "Shared maintenance owner custody changed");
}

async function assertCrew(state: PlatformStateRepositories, plan: SharedHeldReturnMaintenancePlan, guard?: Guard): Promise<void> {
  const { selection, targetRelease, owners } = plan;
  const gatewayId = selection.targetGatewayId;
  const [held, assignments, active, root] = await Promise.all([
    readHeldNativeReturnForTargetMaintenance(state, selection, guard, guard?.stagedRelease
      ? { original: targetRelease, desired: guard.stagedRelease.release } : undefined),
    state.gateways.assignments.list(gatewayId),
    state.journal.operations.listByStatus(["pending", "running"]),
    state.gateways.roots.get(gatewayId),
  ]);
  requireMaintenance(held.targetRelease === targetRelease && root && root.latestRelease === root.desiredRelease,
    "Shared maintenance desired release changed");
  const actual = sortedOwners(assignments.map(({ uid, slug, epoch }) => ({ uid, slug, epoch })));
  requireMaintenance(isDeepStrictEqual(actual, ownerScope(owners)) && assignments.every(row => row.state === "serving"),
    "Shared maintenance assignment roster or epoch changed");
  for (const owner of owners) await assertRetainedCrewOwner(state, gatewayId, owner);
  const conflict = active.some(op => op.id !== selection.operationId && touchesScope(op, gatewayId, owners) && !canLeaveQueued(op, gatewayId, owners));
  requireMaintenance(!conflict, "Another operation holds the Shared maintenance gateway or an owner");
}

async function readEmptyPeerRoot(tx: PlatformStateTransaction, claim: SharedHeldReturnMaintenanceClaim,
  peer: SharedInertEmptyPeerScope, clock: number) {
  requireMaintenance(/^shared-[a-z0-9]+$/.test(peer.gatewayId) && peer.gatewayId !== claim.gatewayId && matchesWorkload(peer.workload),
    "Shared maintenance requires an exact distinct empty peer");
  const [root, runtime, assignments, active, tasks] = await Promise.all([
    tx.gateways.roots.get(peer.gatewayId), tx.fleetRegistry.get(peer.gatewayId), tx.gateways.assignments.list(peer.gatewayId),
    tx.journal.operations.listByStatus(["pending", "running"]), tx.migrationTasks.listByStatus(["running"]),
  ]);
  requireMaintenance(root, "Shared maintenance empty peer root is unavailable");
  requireMaintenance([
    root.gatewayClass === "shared", root.desiredStatus === "running", root.retirementClaim == null,
    root.liveRelease === root.desiredRelease, root.latestRelease === root.liveRelease,
  ].every(Boolean), "Shared maintenance empty peer desired state changed");
  requireMaintenance(runtime && hasFreshReadyKubernetesObservation(runtime, clock, GATEWAY_UNREACHABLE_AFTER_MS),
    "Shared maintenance empty peer lacks a fresh Kubernetes observation");
  const pods = runtime.kubernetes?.pods;
  const pod = pods?.[0];
  requireMaintenance([
    runtime.runtime === "cluster", runtime.release === root.liveRelease, runtime.heartbeat.status === "ready",
    runtime.heartbeat.mountedCustomers.length === 0, !runtime.heartbeat.migratingIn?.length, assignments.length === 0,
    runtime.kubernetes?.totalPods === 1, runtime.kubernetes?.readyPods === 1, pods?.length === 1,
    pod?.uid === peer.workload.podUid, pod?.name === peer.workload.podName, pod?.replicaSetUid === peer.workload.replicaSetUid,
    !tasks.some(task => task.sourceGatewayId === peer.gatewayId || task.targetGatewayId === peer.gatewayId),
    !active.some(op => touchesScope(op, peer.gatewayId, []) && !canLeaveQueued(op, claim.gatewayId, claim.plan.owners)),
  ].every(Boolean), "Shared maintenance empty peer has changed workload or active custody");
  return root;
}

function emptyPeerFence(claim: SharedHeldReturnMaintenanceClaim, saved: EmptyPeerJournal): SharedInertEmptyPeerFence {
  return { kind: SHARED_INERT_EMPTY_PEER, phase: "held", gatewayId: saved.scope.gatewayId, attemptId: claim.attemptId,
    auditId: claim.auditId, startedAt: saved.acquiredAt, retainedGatewayId: claim.gatewayId, workload: saved.scope.workload };
}

async function readHeldEmptyPeer(tx: PlatformStateTransaction, claim: SharedHeldReturnMaintenanceClaim,
  peer: SharedInertEmptyPeerScope, clock: number) {
  const guard = await readClaim(tx, claim);
  const saved = guard.emptyPeer;
  requireMaintenance(saved && saved.restoredAt === undefined && isDeepStrictEqual(saved.scope, peer),
    "Shared maintenance empty peer does not belong to this active attempt");
  const root = await readEmptyPeerRoot(tx, claim, peer, clock);
  const fence = emptyPeerFence(claim, saved);
  requireMaintenance(isDeepStrictEqual(root.runtimeRestartFence, fence), "Shared maintenance empty peer fence changed");
  return { guard, saved, fence };
}

export async function assertSharedInertEmptyPeerHeld(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, peer: SharedInertEmptyPeerScope, now: () => number,
): Promise<void> {
  await store.transaction({ label: "shared-held-return-maintenance.assert-empty-peer", readOnly: true },
    async tx => { await readHeldEmptyPeer(tx, claim, peer, now()); });
}

export async function holdSharedInertEmptyPeer(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, peer: SharedInertEmptyPeerScope,
  verifyExactEmptyWorkload: () => Promise<void>, now: () => number,
): Promise<void> {
  await verifyExactEmptyWorkload();
  await store.transaction({ label: "shared-held-return-maintenance.hold-empty-peer" }, async tx => {
    const guard = await readClaim(tx, claim);
    readInertHold(guard);
    const clock = now();
    if (guard.emptyPeer) {
      await readHeldEmptyPeer(tx, claim, peer, clock);
      return;
    }
    const root = await readEmptyPeerRoot(tx, claim, peer, clock);
    requireMaintenance(!root.runtimeRestartFence, "Shared maintenance empty peer is fenced by another action");
    const saved = { scope: peer, acquiredAt: clock };
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(peer.gatewayId, null, emptyPeerFence(claim, saved));
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, { ...guard, emptyPeer: saved });
  });
  await verifyExactEmptyWorkload();
  await assertSharedInertEmptyPeerHeld(store, claim, peer, now);
}

export async function releaseSharedInertEmptyPeer(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, peer: SharedInertEmptyPeerScope,
  restoreAndVerifySql: (assertHeld: () => Promise<void>) => Promise<void>, now: () => number,
): Promise<void> {
  const readReleased = async (tx: PlatformStateTransaction) => {
    const guard = await readClaim(tx, claim);
    const saved = guard.emptyPeer;
    requireMaintenance(saved && isDeepStrictEqual(saved.scope, peer), "Shared maintenance empty peer does not belong to this attempt");
    return saved.restoredAt !== undefined;
  };
  if (await store.transaction({ label: "shared-held-return-maintenance.empty-peer-status", readOnly: true }, readReleased)) return;
  const assertHeld = () => assertSharedInertEmptyPeerHeld(store, claim, peer, now);
  await assertHeld();
  await restoreAndVerifySql(assertHeld);
  await store.transaction({ label: "shared-held-return-maintenance.release-empty-peer" }, async tx => {
    const clock = now();
    if (await readReleased(tx)) return;
    const { guard, saved, fence } = await readHeldEmptyPeer(tx, claim, peer, clock);
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(peer.gatewayId, fence, null);
    const restored = { ...saved, restoredAt: clock };
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, { ...guard, emptyPeer: restored });
    const audit = await tx.journal.audits.get(claim.auditId);
    requireMaintenance(audit, "Shared maintenance empty peer lost its audit");
    await tx.journal.audits.patch(claim.auditId, { target: { ...audit.target, emptyPeer: restored } },
      { status: [AUDIT_IN_PROGRESS], actionClaimId: claim.attemptId });
  });
}

async function changeTargetImportHold(
  tx: import("./platform-state/index.js").PlatformStateTransaction,
  claim: SharedHeldReturnMaintenanceClaim,
  action: "hold" | "restore",
) {
  const { selection } = claim.plan;
  const op = await tx.journal.operations.get(selection.operationId);
  const handoff = op?.schedulerHandoff;
  const forward = handoff?.forwardRecovery;
  const hold = { gatewayId: selection.targetGatewayId, maintenanceAttemptId: claim.attemptId };
  requireMaintenance(op && forward && handoff.toGatewayId === hold.gatewayId &&
    (action === "hold" ? forward.sharedTargetImportHold === undefined : isDeepStrictEqual(forward.sharedTargetImportHold, hold)),
    "Shared maintenance cannot change a different target import hold");
  const { sharedTargetImportHold: _hold, ...checkpoint } = forward;
  await tx.journal.operations.patch(selection.operationId, {
    schedulerHandoff: { ...handoff, forwardRecovery: {
      ...checkpoint, ...(action === "hold" && { sharedTargetImportHold: hold }),
    } },
  }, { revision: op.revision, status: ["pending"] });
}

export async function acquireSharedHeldReturnMaintenance(
  store: PlatformStateStore,
  deps: {
    environment: "test" | "prod";
    actor: string;
    attemptId: string;
    now: () => number;
    readVerifiedAdmission(): Promise<SharedHeldReturnMaintenanceAdmission>;
  },
): Promise<SharedHeldReturnMaintenanceClaim> {
  requireMaintenance(deps.environment === "test" && deps.actor && /^[a-f0-9-]{36}$/.test(deps.attemptId),
    "Shared held return maintenance requires protected TEST operator authority");
  const admission = await deps.readVerifiedAdmission();
  const now = deps.now();
  const plan = normalizePlan(admission, now);
  const gatewayId = plan.selection.targetGatewayId;
  const audit = buildOperationAuditIntent({
    actor: deps.actor, forced: false, what: "Qualify retained Shared gateway maintenance",
    why: "An original Native return is held on this exact Shared target",
    target: { gatewayId, operationId: plan.selection.operationId }, preActionStatus: { liveRelease: plan.targetRelease },
    mutation: { attemptId: deps.attemptId, plan }, idempotencyKey: `${SHARED_HELD_RETURN_MAINTENANCE}:${deps.attemptId}`, now: () => now,
  });
  const claim = { gatewayId, auditId: audit.id, attemptId: deps.attemptId, plan };
  return store.transaction({ label: "shared-held-return-maintenance.acquire" }, async tx => {
    const root = await tx.gateways.roots.get(gatewayId);
    requireMaintenance(root, "Shared maintenance target is unavailable");
    const existing = root.runtimeRestartFence;
    if (existing) {
      await readClaim(tx, claim);
      requireMaintenance((await tx.journal.audits.get(claim.auditId))?.actor === deps.actor,
        "Shared maintenance reservation belongs to another operator");
      return claim;
    }
    await assertCrew(tx, plan);
    await assertMountedCrew(tx, plan);
    const guard: Guard = { attemptId: claim.attemptId, auditId: claim.auditId, gatewayId, kind: SHARED_HELD_RETURN_MAINTENANCE,
      startedAt: now, phase: "reserved", phaseStartedAt: now, maintenance: plan };
    await tx.journal.audits.create({ ...audit.document, id: audit.id, status: AUDIT_IN_PROGRESS, lifecycleStage: "action-started",
      actionClaimId: claim.attemptId, actionStartedAt: now, actionRecoveryCount: 0 });
    await changeTargetImportHold(tx, claim, "hold");
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(gatewayId, null, guard);
    return claim;
  });
}

async function readClaim(state: PlatformStateRepositories, claim: SharedHeldReturnMaintenanceClaim): Promise<Guard> {
  const root = await state.gateways.roots.get(claim.gatewayId);
  const audit = await state.journal.audits.get(claim.auditId);
  const guard = root?.runtimeRestartFence as Guard | undefined;
  requireMaintenance(guard && guard.kind === SHARED_HELD_RETURN_MAINTENANCE && guard.attemptId === claim.attemptId &&
    guard.auditId === claim.auditId && guard.gatewayId === claim.gatewayId && isDeepStrictEqual(guard.maintenance, claim.plan) &&
    audit?.status === AUDIT_IN_PROGRESS && audit.actionClaimId === claim.attemptId,
  "Shared held return maintenance claim changed");
  await assertCrew(state, claim.plan, guard);
  return guard;
}

export async function readSharedHeldReturnMaintenanceTerminal(
  store: PlatformStateStore, operator: ScopedMaintenance & { actor: string },
): Promise<{ gatewayId: string; auditId: string; attemptId: string; phase: "withdrawn" | "completed" } | null> {
  const { gatewayId, operationId, actor, attemptId } = operator;
  const id = operationAuditDocumentId(`${SHARED_HELD_RETURN_MAINTENANCE}:${attemptId}`);
  const audit = await store.journal.audits.get(id);
  if (audit?.status !== "completed") return null;
  requireMaintenance([audit.actor === actor, audit.actionClaimId === attemptId,
    audit.target.gatewayId === gatewayId, audit.target.operationId === operationId].every(Boolean),
  "Shared maintenance terminal audit belongs to a different operation or operator");
  return { gatewayId, auditId: id, attemptId, phase: audit.target.withdrawnBeforeDispatch === true ? "withdrawn" : "completed" };
}

export async function resumeSharedHeldReturnMaintenance(
  store: PlatformStateStore, gatewayId: string, attemptId: string,
): Promise<SharedHeldReturnMaintenanceClaim> {
  return store.transaction({ label: "shared-held-return-maintenance.resume", readOnly: true }, async tx => {
    const saved = (await tx.gateways.roots.get(gatewayId))?.runtimeRestartFence as Guard | undefined;
    requireMaintenance(saved?.kind === SHARED_HELD_RETURN_MAINTENANCE && saved.auditId && saved.attemptId === attemptId,
      "Shared held return maintenance recovery has different authority");
    const claim = { gatewayId, attemptId, auditId: saved.auditId, plan: saved.maintenance };
    await readClaim(tx, claim);
    return claim;
  });
}

export async function assertSharedHeldReturnMaintenance(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim): Promise<Phase> {
  return store.transaction({ label: "shared-held-return-maintenance.assert", readOnly: true }, async tx => (await readClaim(tx, claim)).phase);
}

export async function readSharedHeldReturnMaintenanceDispatch(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim,
): Promise<SharedHeldReturnMaintenanceDispatch> {
  return store.transaction({ label: "shared-held-return-maintenance.read-dispatch", readOnly: true }, async tx => {
    const guard = await readClaim(tx, claim);
    const staged = guard.stagedRelease;
    requireMaintenance(!guard.restoringMigrationPolicy, "Shared maintenance is completing");
    requireMaintenance(staged && staged.phase === guard.phase, "Shared maintenance physical dispatch requires a matching staged release");
    return { phase: staged.phase, release: staged.release };
  });
}

export async function assertSharedHeldReturnMaintenanceReserved(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim,
): Promise<void> {
  await store.transaction({ label: "shared-held-return-maintenance.assert-reserved", readOnly: true }, async tx => {
    const current = await readClaim(tx, claim);
    requireMaintenance(current.phase === "reserved" && !current.stagedRelease && !current.inertStartup,
      "Shared maintenance reservation has dispatched or withdrawn");
  });
}

export async function advanceSharedHeldReturnMaintenance(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, phase: "dispatched" | "rollback", now: () => number = Date.now,
  verifyDispatch?: () => Promise<void>,
): Promise<void> {
  if (phase === "dispatched" && await assertSharedHeldReturnMaintenance(store, claim) !== "dispatched") {
    requireMaintenance(verifyDispatch, "Shared maintenance dispatch requires a verified held migration policy and rollback backup");
    await assertSharedHeldReturnMaintenanceReserved(store, claim);
    await verifyDispatch();
  }
  await store.transaction({ label: "shared-held-return-maintenance.advance" }, async tx => {
    const current = await readClaim(tx, claim);
    requireMaintenance(!current.restoringMigrationPolicy, "Shared maintenance is completing");
    if (current.phase === phase) return;
    requireMaintenance(!current.inertStartup, "Shared maintenance has a distinct inert launch authority");
    requireMaintenance(phase === "dispatched" ? current.phase === "reserved" && !current.stagedRelease : current.phase === "dispatched",
      "Shared held return maintenance transition is invalid");
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, current, { ...current, phase, phaseStartedAt: now() });
  });
}

const heldProofSha256 = /^[a-f0-9]{64}$/;

function matchesInertPrior(claim: SharedHeldReturnMaintenanceClaim, proof: SharedInertMaintenancePriorProof) {
  const expected = sortedOwners(claim.plan.owners);
  const backups = sortedOwners(proof.ownerBackups);
  return proof.attemptId === claim.attemptId && proof.podUid === claim.plan.workload.podUid &&
    heldProofSha256.test(proof.artifactSetId) &&
    Boolean(proof.originalContainerIds.gateway && proof.originalContainerIds["gateway-edge"]) &&
    proof.originalContainerIds.gateway !== proof.originalContainerIds["gateway-edge"] &&
    backups.every(owner => heldProofSha256.test(owner.restoredArchiveSha256)) &&
    new Set(backups.map(owner => owner.restoredArchiveSha256)).size === backups.length &&
    isDeepStrictEqual(backups.map(({ restoredArchiveSha256: _digest, ...owner }) => owner), expected);
}

export async function authorizeSharedInertMaintenance(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim,
  readVerifiedPrior: (assertCurrent: () => Promise<void>) => Promise<SharedInertMaintenancePriorProof>,
  now: () => number = Date.now,
): Promise<void> {
  const assertCurrent = () => assertSharedHeldReturnMaintenanceReserved(store, claim);
  await assertCurrent();
  const prior = await readVerifiedPrior(assertCurrent);
  requireMaintenance(matchesInertPrior(claim, prior), "Shared inert startup requires all six independently verified owner backups");
  await store.transaction({ label: "shared-held-return-maintenance.authorize-inert", readOnly: false }, async tx => {
    const guard = await readClaim(tx, claim);
    requireMaintenance(guard.phase === "reserved" && !guard.stagedRelease && !guard.inertStartup,
      "Shared inert startup changed before reservation");
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, {
      ...guard, inertStartup: { prior, preparedAt: now() },
    });
  });
}

function readInertHold(guard: Guard) {
  requireMaintenance(guard.phase === "reserved" && !guard.stagedRelease && guard.inertStartup && !guard.inertStartup.common &&
    guard.inertStartup.rollingBackAt === undefined,
    "Shared inert startup no longer permits pre-launch work");
  return guard.inertStartup;
}

export async function assertSharedInertPreLaunch(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim,
): Promise<SharedInertMaintenancePriorProof> {
  return store.transaction({ label: "shared-held-return-maintenance.assert-inert", readOnly: true },
    async tx => readInertHold(await readClaim(tx, claim)).prior);
}

function matchesInertCommon(claim: SharedHeldReturnMaintenanceClaim, inert: InertStartup, proof: SharedInertMaintenanceCommonProof, clock: number) {
  const { prior } = inert;
  const ids = [proof.heldContainerIds.gateway, proof.heldContainerIds["gateway-edge"],
    prior.originalContainerIds.gateway, prior.originalContainerIds["gateway-edge"]];
  const times = [inert.preparedAt, proof.writersHeldAt, proof.capturedAt, proof.restoredAt, clock];
  return [proof.attemptId === claim.attemptId, proof.podUid === prior.podUid, proof.artifactSetId === prior.artifactSetId,
    isDeepStrictEqual(proof.originalContainerIds, prior.originalContainerIds),
    ids.every(Boolean), new Set(ids).size === 4,
    runningImagesMatch(proof.observedImageIds, claim.plan.maintenanceImages),
    isDeepStrictEqual(sortedOwners(proof.ownerHomes), sortedOwners(claim.plan.owners)),
    heldProofSha256.test(proof.custodyGeneration), heldProofSha256.test(proof.restoredArchiveSha256),
    times.every((at, index) => Number.isSafeInteger(at) && (index === 0 || at >= times[index - 1]!)),
    clock - proof.restoredAt <= 60_000,
  ].every(Boolean);
}

export async function authorizeSharedInertStockLaunch(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim,
  readVerifiedCommon: (assertCurrent: () => Promise<void>) => Promise<SharedInertMaintenanceCommonProof>,
  now: () => number = Date.now,
): Promise<void> {
  const prior = await assertSharedInertPreLaunch(store, claim);
  const assertCurrent = async () => {
    requireMaintenance(isDeepStrictEqual(await assertSharedInertPreLaunch(store, claim), prior),
      "Shared inert startup prior custody changed");
  };
  const common = await readVerifiedCommon(assertCurrent);
  await assertCurrent();
  await store.transaction({ label: "shared-held-return-maintenance.authorize-inert-stock" }, async tx => {
    const guard = await readClaim(tx, claim);
    const inert = readInertHold(guard);
    const clock = now();
    requireMaintenance(isDeepStrictEqual(inert.prior, prior) && matchesInertCommon(claim, inert, common, clock),
      "Shared inert startup lacks a verified common restore under the current writer hold");
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, {
      ...guard, phase: "dispatched", phaseStartedAt: clock, inertStartup: { ...inert, common },
    });
  });
}

export async function readAuthorizedSharedInertStock(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim,
): Promise<SharedInertMaintenanceCommonProof> {
  return store.transaction({ label: "shared-held-return-maintenance.read-inert-stock", readOnly: true }, async tx => {
    const guard = await readClaim(tx, claim);
    requireMaintenance(guard.phase === "dispatched" && guard.inertStartup?.common && !guard.restoringMigrationPolicy &&
      (!guard.emptyPeer || guard.emptyPeer.restoredAt !== undefined),
      "Shared inert startup has no launch-authorized common restore");
    return guard.inertStartup.common;
  });
}

function readInertRollback(guard: Guard) {
  const inert = guard.inertStartup;
  requireMaintenance(guard.phase === "reserved" && !guard.stagedRelease && inert && !inert.common &&
    inert.rollingBackAt !== undefined, "Shared inert startup rollback lost authority");
  return { inert, startedAt: inert.rollingBackAt };
}

export async function rollbackSharedInertBeforeStock(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim,
  restoreAndVerifyOriginal: (assertCurrent: () => Promise<void>) => Promise<SharedHeldReturnMaintenanceResult>,
  now: () => number = Date.now,
): Promise<void> {
  await store.transaction({ label: "shared-held-return-maintenance.begin-inert-rollback" }, async tx => {
    const guard = await readClaim(tx, claim);
    if (guard.inertStartup?.rollingBackAt !== undefined) {
      readInertRollback(guard);
      return;
    }
    const inert = readInertHold(guard);
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, {
      ...guard, inertStartup: { ...inert, rollingBackAt: now() },
    });
  });
  const assertCurrent = async () => {
    await store.transaction({ label: "shared-held-return-maintenance.assert-inert-rollback", readOnly: true }, async tx => {
      readInertRollback(await readClaim(tx, claim));
    });
  };
  const restored = await restoreAndVerifyOriginal(assertCurrent);
  await store.transaction({ label: "shared-held-return-maintenance.finish-inert-rollback" }, async tx => {
    const guard = await readClaim(tx, claim);
    const { startedAt } = readInertRollback(guard);
    requireMaintenance(!guard.emptyPeer || guard.emptyPeer.restoredAt !== undefined, "Shared maintenance empty peer still holds writer custody");
    assertResult({ ...guard, phase: "rollback", phaseStartedAt: startedAt }, restored, now());
    const { inertStartup: _inert, ...remaining } = guard;
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, remaining);
  });
}

function artifactFromReference(image: string): { imageRepository: string; imageTag: string } {
  const tagSeparator = image.slice(0, image.indexOf("@")).lastIndexOf(":");
  requireMaintenance(tagSeparator > 0, "Shared maintenance requires an immutable tagged image subject");
  return { imageRepository: image.slice(0, tagSeparator), imageTag: image.slice(tagSeparator + 1) };
}

function sharedImageTuple(payload: ReleasePayload): RoleImages {
  requireMaintenance(payload.gatewayEdgeImage, "Shared maintenance release lacks an edge artifact");
  return { gateway: `${payload.imageRepository}:${payload.imageTag}`,
    "gateway-edge": `${payload.gatewayEdgeImage.imageRepository}:${payload.gatewayEdgeImage.imageTag}` };
}

async function stagedReleasePayload(state: PlatformStateRepositories, guard: Guard): Promise<ReleasePayload> {
  const original = await state.gateways.releases.get(guard.gatewayId, guard.maintenance.targetRelease);
  requireMaintenance(original && isDeepStrictEqual(sharedImageTuple(original.payload), guard.maintenance.originalImages),
    "Shared maintenance original immutable release differs from its observed rollback tuple");
  if (guard.phase === "rollback") return original.payload;
  const images = guard.maintenance.maintenanceImages;
  const gateway = artifactFromReference(images.gateway);
  const gatewayEdgeImage = artifactFromReference(images["gateway-edge"]);
  requireMaintenance(gateway.imageRepository === original.payload.imageRepository &&
    gatewayEdgeImage.imageRepository === original.payload.gatewayEdgeImage?.imageRepository,
  "Shared maintenance replacement must use the original protected registry repositories");
  return { ...original.payload, ...gateway, gatewayEdgeImage, openclawSourceSha: guard.maintenance.acceptedNativeSource };
}

export async function stageSharedHeldReturnMaintenanceRelease(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, now: () => number,
): Promise<number> {
  return store.transaction({ label: "shared-held-return-maintenance.stage-release" }, async tx => {
    const guard = await readClaim(tx, claim);
    const { phase, stagedRelease } = guard;
    requireMaintenance(!guard.restoringMigrationPolicy, "Shared maintenance is completing");
    requireMaintenance(phase === "dispatched" || phase === "rollback", "Shared maintenance release cannot stage before dispatch");
    if (stagedRelease?.phase === phase) return stagedRelease.release;
    const payload = await stagedReleasePayload(tx, guard);
    const release = phase === "rollback" && !stagedRelease ? claim.plan.targetRelease :
      await appendRetainedSharedMaintenanceReleaseInStore(tx, {
        gatewayId: claim.gatewayId, attemptId: claim.attemptId, phase, originalRelease: claim.plan.targetRelease, payload, now: now(),
      });
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, {
      ...guard, stagedRelease: { release, payloadHash: releasePayloadHash(payload), phase },
    });
    return release;
  });
}

function runningImagesMatch(actual: RoleImages, expected: RoleImages): boolean {
  return (["gateway", "gateway-edge"] as const).every(role => {
    const digest = actual[role].split("@").at(-1);
    return digest !== undefined && expected[role].endsWith(`@${digest}`);
  });
}

function assertResult(guard: Guard, result: SharedHeldReturnMaintenanceResult, now: number): void {
  const { phase, maintenance } = guard;
  const expected = phase === "rollback" ? maintenance.originalImages : maintenance.maintenanceImages;
  const outcomeMatches = phase === "rollback"
    ? result.outcome === "rolled-back" : phase === "dispatched" && result.outcome === "installed";
  const nativeSource = phase === "rollback" ? maintenance.originalNativeSource : maintenance.acceptedNativeSource;
  requireMaintenance([
    outcomeMatches, result.attemptId === guard.attemptId, result.noInFlightTasks === true,
    result.noPreparedImports === true, result.exclusiveReady === true, result.nativeSource === nativeSource,
    isDeepStrictEqual(result.workload, maintenance.workload), isDeepStrictEqual(result.retainedBoot, maintenance.retainedBoot),
    isDeepStrictEqual(result.images, expected), runningImagesMatch(result.runningImageIds, expected),
    isDeepStrictEqual(sortedOwners(result.owners), maintenance.owners), Number.isSafeInteger(result.verifiedAt),
    result.verifiedAt >= guard.phaseStartedAt, result.verifiedAt <= now,
  ].every(Boolean), "Shared held return maintenance lacks exact verified completion");
}

function assertRetainedRuntimeReadiness(
  runtime: import("./platform-state/index.js").FleetRegistryRecord, guard: Guard, imageTag: string, physicalVerifiedAt: number, now: number,
): void {
  const kube = runtime.kubernetes;
  const pod = kube?.pods?.[0];
  requireMaintenance(kube && pod, "Shared maintenance lacks a canonical retained Pod observation");
  requireMaintenance([
    hasFreshReadyKubernetesObservation(runtime, now, GATEWAY_UNREACHABLE_AFTER_MS),
    kube.observedAt >= physicalVerifiedAt, kube.totalPods === 1, kube.readyPods === 1, kube.pods?.length === 1,
    pod.uid === guard.maintenance.workload.podUid, pod.replicaSetUid === guard.maintenance.workload.replicaSetUid,
    pod.name === guard.maintenance.workload.podName,
  ].every(Boolean), "Shared maintenance lacks a fresh canonical Kubernetes readiness observation for the retained Pod");
  const heartbeat = runtime.heartbeat;
  requireMaintenance(heartbeat.lastHeartbeatAt !== null && heartbeat.lastHeartbeatAt >= physicalVerifiedAt &&
    heartbeat.lastHeartbeatAt <= now && now - heartbeat.lastHeartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS &&
    [imageTag, guard.maintenance.retainedBoot.gatewayImageTag]
      .some(tag => gatewayHeartbeatMatchesImageTag(heartbeat.version, tag)),
  "Shared maintenance lacks a fresh canonical heartbeat for the staged release");
}

function assertRetainedHelm(
  guard: Guard, observed: ObservedSharedMaintenanceHelm, payload: ReleasePayload, originalHelm: GatewayHelmObservation, now: number,
): void {
  const { installed } = observed;
  requireMaintenance([
    observed.chartFingerprint === guard.maintenance.installedChartFingerprint,
    observed.edgeImage === sharedImageTuple(payload)["gateway-edge"],
    installed.imageRepository === payload.imageRepository, installed.imageTag === payload.imageTag,
    installed.releaseName === originalHelm.releaseName, installed.deploymentName === originalHelm.deploymentName,
    installed.gatewayServiceName === originalHelm.gatewayServiceName, installed.gatewayEdgeServiceName === originalHelm.gatewayEdgeServiceName,
    installed.serviceAccountName === originalHelm.serviceAccountName, installed.replicas === 1, installed.availableReplicas === 1,
    observed.verifiedAt >= guard.phaseStartedAt, observed.verifiedAt <= now,
  ].every(Boolean), "Shared maintenance has no canonical retained Helm observation for the verified release");
}

async function readVerifiedRetainedRelease(
  tx: PlatformStateRepositories,
  guard: Guard, observed: ObservedSharedMaintenanceHelm, physicalVerifiedAt: number, now: number,
) {
  const staged = guard.stagedRelease;
  requireMaintenance(staged?.phase === guard.phase, "Shared maintenance has no staged release for the observed outcome");
  const row = await tx.gateways.releases.get(guard.gatewayId, staged.release);
  requireMaintenance(row && row.payloadHash === staged.payloadHash, "Shared maintenance staged immutable release changed");
  const runtime = await assertMountedCrew(tx, guard.maintenance);
  assertRetainedRuntimeReadiness(runtime, guard, row.payload.imageTag, physicalVerifiedAt, now);
  assertRetainedHelm(guard, observed, row.payload, runtime.helm, now);
  return { staged, runtime };
}

export async function completeSharedHeldReturnMaintenance(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim,
  deps: {
    readVerifiedResult(): Promise<SharedHeldReturnMaintenanceResult>;
    readInstalledHelm(): Promise<ObservedSharedMaintenanceHelm>;
    restoreMigrationPolicy(assertCurrent: () => Promise<void>): Promise<void>;
    now(): number;
  },
): Promise<void> {
  const [result, installed] = await Promise.all([deps.readVerifiedResult(), deps.readInstalledHelm()]);
  await store.transaction({ label: "shared-held-return-maintenance.begin-completion" }, async tx => {
    const guard = await readClaim(tx, claim);
    const clock = deps.now();
    assertResult(guard, result, clock);
    await readVerifiedRetainedRelease(tx, guard, installed, result.verifiedAt, clock);
    if (!guard.restoringMigrationPolicy) {
      await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, {
        ...guard, restoringMigrationPolicy: true,
      });
    }
  });
  await deps.restoreMigrationPolicy(() => store.transaction({
    label: "shared-held-return-maintenance.assert-completing", readOnly: true,
  }, async tx => {
    requireMaintenance((await readClaim(tx, claim)).restoringMigrationPolicy,
      "Shared maintenance lost authority to restore migration ingress");
  }));
  await store.transaction({ label: "shared-held-return-maintenance.complete" }, async tx => {
    const guard = await readClaim(tx, claim);
    const clock = deps.now();
    requireMaintenance(guard.restoringMigrationPolicy, "Shared maintenance completion lost its policy restoration claim");
    requireMaintenance(!guard.emptyPeer || guard.emptyPeer.restoredAt !== undefined, "Shared maintenance empty peer still holds writer custody");
    assertResult(guard, result, clock);
    const { staged, runtime } = await readVerifiedRetainedRelease(tx, guard, installed, result.verifiedAt, clock);
    await tx.fleetRegistry.patch(claim.gatewayId, {
      release: staged.release, lifecycle: "serving", helm: installed.installed,
    }, { revision: runtime.revision });
    await tx.gateways.roots.patch(claim.gatewayId, {
      liveRelease: staged.release, updatedAt: clock, updatedBy: claim.attemptId,
    });
    const rolledBack = result.outcome === "rolled-back";
    if (rolledBack) await changeTargetImportHold(tx, claim, "restore");
    await tx.journal.audits.patch(claim.auditId, {
      status: "completed", lifecycleStage: rolledBack ? "action-partial" : "action-completed", completedAt: result.verifiedAt,
      outcome: rolledBack ? "partial" : "completed",
      ...(rolledBack && { partialOutcome: { summary: "The original Shared runtime was restored and verified" } }),
    }, { status: [AUDIT_IN_PROGRESS], actionClaimId: claim.attemptId });
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, null);
  });
}

function alreadyWithdrawn(audit: Awaited<ReturnType<PlatformStateRepositories["journal"]["audits"]["get"]>>, claim: SharedHeldReturnMaintenanceClaim): boolean {
  return [audit?.status === "completed", audit?.outcome === "partial", audit?.actionClaimId === claim.attemptId,
    audit?.target.withdrawnBeforeDispatch === true, audit?.target.gatewayId === claim.gatewayId, isDeepStrictEqual(audit?.mutation.plan, claim.plan)].every(Boolean);
}

async function beginWithdrawal(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, now: () => number): Promise<boolean> {
  return store.transaction({ label: "shared-held-return-maintenance.begin-withdrawal" }, async tx => {
    if (alreadyWithdrawn(await tx.journal.audits.get(claim.auditId), claim)) return false;
    const guard = await readClaim(tx, claim);
    requireMaintenance(!guard.stagedRelease && !guard.inertStartup && (!guard.emptyPeer || guard.emptyPeer.restoredAt !== undefined) &&
      ["reserved", "withdrawing"].includes(guard.phase),
      "Shared maintenance can withdraw only before image dispatch or release staging");
    if (guard.phase === "reserved") {
      await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, { ...guard, phase: "withdrawing", phaseStartedAt: now() });
    }
    return true;
  });
}

export async function withdrawSharedHeldReturnMaintenance(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim,
  deps: { restoreMigrationPolicy(): Promise<void>; readVerifiedWithdrawal(): Promise<SharedHeldReturnMaintenanceWithdrawal>; now(): number },
): Promise<void> {
  if (!await beginWithdrawal(store, claim, deps.now)) return;
  await deps.restoreMigrationPolicy();
  const original = await deps.readVerifiedWithdrawal();
  await store.transaction({ label: "shared-held-return-maintenance.withdraw" }, async tx => {
    if (alreadyWithdrawn(await tx.journal.audits.get(claim.auditId), claim)) return;
    const guard = await readClaim(tx, claim);
    requireMaintenance(guard.phase === "withdrawing" && !guard.stagedRelease && original.migrationPolicyRestored === true,
      "Shared maintenance withdrawal has no exact restored migration policy");
    const now = deps.now();
    assertResult({ ...guard, phase: "rollback" }, { ...original, outcome: "rolled-back" }, now);
    const runtime = await assertMountedCrew(tx, claim.plan);
    const payload = await stagedReleasePayload(tx, { ...guard, phase: "rollback" });
    requireMaintenance(runtime.release === claim.plan.targetRelease, "Shared maintenance withdrawal requires the original live release");
    assertRetainedRuntimeReadiness(runtime, guard, payload.imageTag, original.verifiedAt, now);
    assertRetainedHelm(guard, original.installed, payload, runtime.helm, now);
    const audit = await tx.journal.audits.get(claim.auditId);
    requireMaintenance(audit, "Shared maintenance withdrawal lost its audit");
    await changeTargetImportHold(tx, claim, "restore");
    await tx.journal.audits.patch(claim.auditId, {
      status: "completed", lifecycleStage: "action-partial", completedAt: now, outcome: "partial",
      partialOutcome: { summary: "Shared maintenance withdrawn before image dispatch; original custody and migration policy verified" },
      target: { ...audit.target, withdrawnBeforeDispatch: true },
    }, { status: [AUDIT_IN_PROGRESS], actionClaimId: claim.attemptId });
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, null);
  });
}
