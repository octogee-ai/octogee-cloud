import { isDeepStrictEqual } from "node:util";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { hasFreshReadyKubernetesObservation, releasePayloadHash, type GatewayHelmObservation, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { gatewayHeartbeatMatchesImageTag, isGatewayImageTag } from "@octogee/shared/types/image-tag";
import { appendRetainedSharedMaintenanceReleaseInStore } from "./gateway-release-append.js";
import {
  readHeldNativeReturnForTargetMaintenance, type HeldNativeReturnSelection,
} from "./held-native-return-repair.js";
import { buildOperationAuditIntent } from "./operation-audit.js";
import { CONTINUOUS_PLACEMENT_SOURCE, PLACEMENT_MIGRATION_ACTOR, sharedDrainMoveNeverClaimed } from "./placement-migrations.js";
import type {
  GatewayRuntimeRestartFenceValue, OperationRecord, PlatformStateRepositories, PlatformStateStore, Stored,
} from "./platform-state/index.js";

export const SHARED_HELD_RETURN_MAINTENANCE = "shared-held-return-maintenance";

type Workload = { podName: string; podUid: string; replicaSetUid: string; deploymentUid: string };
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

type StagedRelease = { release: number; payloadHash: string; phase: "dispatched" | "rollback" };

export interface SharedHeldReturnMaintenanceClaim {
  gatewayId: string;
  auditId: string;
  attemptId: string;
  plan: SharedHeldReturnMaintenancePlan;
}

type Phase = "reserved" | "dispatched" | "rollback";
type Guard = GatewayRuntimeRestartFenceValue & { phase: Phase; phaseStartedAt: number; maintenance: SharedHeldReturnMaintenancePlan; stagedRelease?: StagedRelease };

function requireMaintenance(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
  state: PlatformStateRepositories, operation: Pick<OperationRecord, "input" | "inputUid" | "gatewayId">,
): Promise<void> {
  const { input } = operation;
  const ownerUid = operation.inputUid ?? input.uid ?? input.ownerUid ?? input.userId;
  const owner = typeof ownerUid === "string" && ownerUid && !ownerUid.includes("/") ? await state.users.records.get(ownerUid) : null;
  const gateways = [...new Set([operation.gatewayId, input.gatewayId, input.fromGatewayId, input.toGatewayId,
    input.sourceGatewayId, input.targetGatewayId, owner?.gateway?.gatewayId]
    .filter((id): id is string => typeof id === "string" && id !== "" && !id.includes("/")))];
  if (!gateways.length) return;
  const roots = await state.gateways.roots.getMany(gateways);
  requireMaintenance(![...roots.values()].some(root => root.runtimeRestartFence?.kind === SHARED_HELD_RETURN_MAINTENANCE),
    "Shared held return maintenance blocks this operation");
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
  for (const { uid, slug, epoch } of owners) {
    const user = await state.users.records.get(uid);
    const [assigned, ...rest] = await state.gateways.assignments.listForUid(uid);
    requireMaintenance(user?.gateway?.gatewayId === gatewayId && user.slug === slug &&
      Object.keys(user.fences).length === 0 && assigned?.gatewayId === gatewayId && assigned.epoch === epoch && rest.length === 0,
    "Shared maintenance owner custody changed");
  }
  const conflict = active.some(op => op.id !== selection.operationId && touchesScope(op, gatewayId, owners) && !canLeaveQueued(op, gatewayId, owners));
  requireMaintenance(!conflict, "Another operation holds the Shared maintenance gateway or an owner");
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
      return claim;
    }
    await assertCrew(tx, plan);
    await assertMountedCrew(tx, plan);
    const guard: Guard = { attemptId: claim.attemptId, auditId: claim.auditId, gatewayId, kind: SHARED_HELD_RETURN_MAINTENANCE,
      startedAt: now, phase: "reserved", phaseStartedAt: now, maintenance: plan };
    await tx.journal.audits.create({ ...audit.document, id: audit.id, status: "in-progress", lifecycleStage: "action-started",
      actionClaimId: claim.attemptId, actionStartedAt: now, actionRecoveryCount: 0 });
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
    audit?.status === "in-progress" && audit.actionClaimId === claim.attemptId,
  "Shared held return maintenance claim changed");
  await assertCrew(state, claim.plan, guard);
  return guard;
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

export async function advanceSharedHeldReturnMaintenance(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, phase: "dispatched" | "rollback", now: () => number = Date.now,
): Promise<void> {
  await store.transaction({ label: "shared-held-return-maintenance.advance" }, async tx => {
    const current = await readClaim(tx, claim);
    if (current.phase === phase) return;
    requireMaintenance(phase === "dispatched" ? current.phase === "reserved" : current.phase === "dispatched",
      "Shared held return maintenance transition is invalid");
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, current, { ...current, phase, phaseStartedAt: now() });
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
  return { ...original.payload, ...gateway, gatewayEdgeImage };
}

export async function stageSharedHeldReturnMaintenanceRelease(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, now: () => number,
): Promise<number> {
  return store.transaction({ label: "shared-held-return-maintenance.stage-release" }, async tx => {
    const guard = await readClaim(tx, claim);
    const { phase, stagedRelease } = guard;
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

async function publishObservedRetainedRelease(
  tx: import("./platform-state/index.js").PlatformStateTransaction,
  guard: Guard, observed: ObservedSharedMaintenanceHelm, physicalVerifiedAt: number, now: number,
): Promise<void> {
  const staged = guard.stagedRelease;
  requireMaintenance(staged?.phase === guard.phase, "Shared maintenance has no staged release for the observed outcome");
  const row = await tx.gateways.releases.get(guard.gatewayId, staged.release);
  requireMaintenance(row && row.payloadHash === staged.payloadHash, "Shared maintenance staged immutable release changed");
  const runtime = await assertMountedCrew(tx, guard.maintenance);
  assertRetainedRuntimeReadiness(runtime, guard, row.payload.imageTag, physicalVerifiedAt, now);
  const installed = observed.installed;
  requireMaintenance([
    observed.chartFingerprint === guard.maintenance.installedChartFingerprint,
    observed.edgeImage === sharedImageTuple(row.payload)["gateway-edge"],
    installed.imageRepository === row.payload.imageRepository, installed.imageTag === row.payload.imageTag,
    installed.releaseName === runtime.helm.releaseName, installed.deploymentName === runtime.helm.deploymentName,
    installed.gatewayServiceName === runtime.helm.gatewayServiceName, installed.gatewayEdgeServiceName === runtime.helm.gatewayEdgeServiceName,
    installed.serviceAccountName === runtime.helm.serviceAccountName, installed.replicas === 1, installed.availableReplicas === 1,
    observed.verifiedAt >= guard.phaseStartedAt, observed.verifiedAt <= now,
  ].every(Boolean), "Shared maintenance has no canonical retained Helm observation for the staged release");
  await tx.fleetRegistry.patch(guard.gatewayId, { release: staged.release, lifecycle: "serving", helm: installed }, { revision: runtime.revision });
  await tx.gateways.roots.patch(guard.gatewayId, { liveRelease: staged.release, updatedAt: now, updatedBy: guard.attemptId });
}

export async function completeSharedHeldReturnMaintenance(
  store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim,
  deps: { readVerifiedResult(): Promise<SharedHeldReturnMaintenanceResult>; readInstalledHelm(): Promise<ObservedSharedMaintenanceHelm>; now(): number },
): Promise<void> {
  const [result, installed] = await Promise.all([deps.readVerifiedResult(), deps.readInstalledHelm()]);
  await store.transaction({ label: "shared-held-return-maintenance.complete" }, async tx => {
    const guard = await readClaim(tx, claim);
    const clock = deps.now();
    assertResult(guard, result, clock);
    await publishObservedRetainedRelease(tx, guard, installed, result.verifiedAt, clock);
    const rolledBack = result.outcome === "rolled-back";
    await tx.journal.audits.patch(claim.auditId, {
      status: "completed", lifecycleStage: rolledBack ? "action-partial" : "action-completed", completedAt: result.verifiedAt,
      outcome: rolledBack ? "partial" : "completed",
      ...(rolledBack && { partialOutcome: { summary: "The original Shared runtime was restored and verified" } }),
    }, { status: ["in-progress"], actionClaimId: claim.attemptId });
    await tx.gateways.roots.compareAndSetRuntimeRestartFence(claim.gatewayId, guard, null);
  });
}
