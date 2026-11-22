import { isDeepStrictEqual } from "node:util";
import { releasePayloadHash, isReleasePayload, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { isGatewayVmBootRecoverySample, type Operation } from "@octogee/shared/types/glm";
import { assertGatewayRuntimeMutationUnfencedInStore, isolatedRuntimeMutationFenced } from "../gateway-retirement-claim.js";
import { readGatewayArtifactInStore } from "../gateway-live-release.js";
import { readSharedGatewayPoolConfigInStore } from "../shared-gateway-pool-read.js";
import type { FleetRegistryRecord } from "../platform-state/fleet-registry.js";
import type { GatewayRoot } from "../platform-state/gateways.js";
import type { PlatformUserRecord } from "../platform-state/users.js";
import type { OperationRecord } from "../platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction, Stored } from "../platform-state/store.js";
import { GUEST_RELEASE_MODE, guestReleaseImagesMatch, guestReleaseInstalled, hasCompleteGuestRelease } from "./guest-release.js";
import { userAllowsInteractiveAccess } from "./lease.js";

export const PARKED_PREWARM_KIND = "prewarm-gateway";
export const ACTIVE_PARKED_PREWARM_STATUSES = ["pending", "running"] as const;

interface ParkedPrewarmCommon {
  uid: string;
  gatewayId: string;
  generation: number;
  payload: ReleasePayload;
}

export interface DemandGuestSource {
  gatewayId: string;
  release: number;
}

type GuestReleaseOrigin = { sourceSha: string; demandSource?: undefined } | { sourceSha?: undefined; demandSource: DemandGuestSource };

export type ParkedPrewarmInput = ParkedPrewarmCommon & (
  { mode?: undefined; bootImageId: string; sourceSha: string } |
  ({ mode: typeof GUEST_RELEASE_MODE; bootImageId?: undefined } & GuestReleaseOrigin)
);

function readDemandGuestSource(value: unknown): DemandGuestSource | undefined {
  if (!value || typeof value !== "object") return;
  const source = value as Partial<DemandGuestSource>;
  if (typeof source.gatewayId !== "string" || !source.gatewayId ||
      typeof source.release !== "number" || !Number.isSafeInteger(source.release) || source.release < 1) return;
  return { gatewayId: source.gatewayId, release: source.release };
}

function readPrewarmCommon(input: Operation["input"]): ParkedPrewarmCommon {
  const { uid, gatewayId, generation, payload } = input;
  if (typeof uid !== "string" || !uid || typeof gatewayId !== "string" || !gatewayId ||
      typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 || !isReleasePayload(payload)) {
    throw new Error("Invalid parked computer prewarm operation input");
  }
  return { uid, gatewayId, generation, payload };
}

export function parkedPrewarmInput(operation: Pick<Operation, "input">): ParkedPrewarmInput {
  const { sourceSha, bootImageId, mode, demandSource } = operation.input;
  const common = readPrewarmCommon(operation.input);
  const exactSha = typeof sourceSha === "string" && /^[0-9a-f]{40}$/.test(sourceSha) ? sourceSha : null;
  if (mode === GUEST_RELEASE_MODE && bootImageId === undefined && hasCompleteGuestRelease(common.payload)) {
    if (exactSha && demandSource === undefined) return { ...common, mode, sourceSha: exactSha };
    const source = readDemandGuestSource(demandSource);
    if (sourceSha === undefined && source) return { ...common, mode, demandSource: source };
  }
  if (exactSha && mode === undefined && demandSource === undefined && typeof bootImageId === "string" &&
      /^[1-9]\d{0,19}$/.test(bootImageId)) return { ...common, sourceSha: exactSha, bootImageId };
  throw new Error("Invalid parked computer prewarm image intent");
}

export interface RetainedGuestDisks {
  bootImageId: string;
  bootDiskId: string;
  homeDiskId: string;
}

export function readRetainedGuestDisks(value: unknown): RetainedGuestDisks | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Partial<RetainedGuestDisks>;
  if ([row.bootImageId, row.bootDiskId, row.homeDiskId].every(id => typeof id === "string" && /^[1-9]\d{0,19}$/.test(id))) {
    return { bootImageId: row.bootImageId!, bootDiskId: row.bootDiskId!, homeDiskId: row.homeDiskId! };
  }
}

export async function readActiveParkedPrewarm(
  state: Pick<PlatformStateTransaction, "journal">,
  uid: string,
): Promise<OperationRecord | null> {
  const operations = await state.journal.operations.listForUid(uid, { kind: PARKED_PREWARM_KIND, statuses: ACTIVE_PARKED_PREWARM_STATUSES });
  return operations.find((operation) => parkedPrewarmPlacementHold(operation) !== undefined) ?? null;
}

type PrewarmClaim = {
  release: number;
  previousRelease: number;
  previousInstanceId: string;
  sourceGatewayId: string;
  sourceAssignmentEpoch: number;
  guestDisks?: RetainedGuestDisks;
  guestVerifiedAt?: number;
};
const BOOTING = "booting";
const HANDOFF = "handoff";
const REPAIRING = "repairing";
const REPAIR_PARKING = "repair-parking";
const DEMAND_WON = "demand-won";
const PREWARM_CLAIM_STATES = [BOOTING, HANDOFF, REPAIRING, REPAIR_PARKING] as const;
type PrewarmClaimState = typeof PREWARM_CLAIM_STATES[number];

function isPrewarmClaimActive(state: unknown): state is PrewarmClaimState {
  return PREWARM_CLAIM_STATES.some((phase) => phase === state);
}

export function parkedPrewarmPlacementHold(operation: OperationRecord): "blocking" | typeof HANDOFF | undefined {
  const phase = operation.output?.prewarmState;
  if (operation.kind !== PARKED_PREWARM_KIND ||
      !ACTIVE_PARKED_PREWARM_STATUSES.some(status => status === operation.status) ||
      !isPrewarmClaimActive(phase)) return undefined;
  return phase === HANDOFF ? HANDOFF : "blocking";
}

export function activeParkedPrewarmGatewayIds(operations: readonly OperationRecord[]): ReadonlySet<string> {
  return new Set(operations.flatMap(operation =>
    operation.gatewayId && parkedPrewarmPlacementHold(operation) !== undefined ? [operation.gatewayId] : []));
}

type PrewarmStart = { state: PrewarmClaimState | "parked"; claim: PrewarmClaim } |
  { state: "demand-won" | "ineligible" };

function prewarmClaim(operation: Operation): PrewarmClaim {
  const { release, previousRelease, previousInstanceId, sourceGatewayId, sourceAssignmentEpoch } = operation.output ?? {};
  if (typeof release !== "number" || typeof previousRelease !== "number" || typeof previousInstanceId !== "string" ||
      typeof sourceGatewayId !== "string" || typeof sourceAssignmentEpoch !== "number") {
    throw new Error("Parked computer prewarm claim is missing its original VM or release");
  }
  const guestDisks = readRetainedGuestDisks(operation.output?.guestDisks);
  if (operation.input.mode === GUEST_RELEASE_MODE && !guestDisks) throw new Error("Parked guest release is missing original disk identity");
  const guestVerifiedAt = operation.output?.guestVerifiedAt;
  return { release, previousRelease, previousInstanceId, sourceGatewayId, sourceAssignmentEpoch,
    ...(guestDisks ? { guestDisks } : {}), ...(typeof guestVerifiedAt === "number" ? { guestVerifiedAt } : {}) };
}

function assertPrewarmWorker(operation: Operation, current: OperationRecord | null): asserts current is OperationRecord {
  if (current?.kind !== PARKED_PREWARM_KIND || current.status !== "running" || current.startedAt !== operation.startedAt) {
    throw new Error("Parked computer prewarm worker claim changed");
  }
}

function hasCustomerDemand(status: string | undefined): boolean {
  return status !== undefined && status !== "parked" && status !== "failed";
}

type OriginalVm = { instanceId: string; bootImageId: string; needsRepair: boolean; guestDisks?: RetainedGuestDisks };

function parkedRootEligible(
  root: GatewayRoot | null,
  uid: string,
  generation: number,
): root is GatewayRoot & { liveRelease: number } {
  return root?.desiredStatus === "paused" && root.gatewayClass === "isolated" && root.retirementClaim == null &&
    root.ownerUid === uid && root.allocation?.claimedByUid === uid && root.allocation.generation === generation &&
    root.allocation.kind === "disposable-builder" && root.liveRelease !== null && root.liveRelease === root.desiredRelease;
}

function eligibleSharedSource(owner: Stored<PlatformUserRecord> | null, sharedGatewayIds: readonly string[]): string | null {
  const shared = owner?.gateway?.gatewayId;
  return owner && shared && sharedGatewayIds.includes(shared) &&
    userAllowsInteractiveAccess(owner) && !isolatedRuntimeMutationFenced(owner) ? shared : null;
}

function parkedInstanceId(runtime: FleetRegistryRecord | null, sourceVm: OriginalVm | undefined): string | null {
  const vm = runtime?.vm;
  if (runtime?.runtime !== "gce-vm" || !vm ||
      (sourceVm && sourceVm.instanceId !== vm.instanceId)) return null;
  if (sourceVm && (vm.status === "RUNNING" || vm.status === "SUSPENDING")) {
    throw new Error("Parked computer is waiting for VM suspension to be recorded");
  }
  return vm.status === "SUSPENDED" ? vm.instanceId : null;
}

function conflictingPrewarmOwnerOperation(conflicts: readonly OperationRecord[], id: string): boolean {
  return conflicts.some((entry) => entry.id !== id &&
    (entry.kind !== PARKED_PREWARM_KIND || isPrewarmClaimActive(entry.output?.prewarmState)));
}

function existingOrDemandOperation(current: OperationRecord, owner: PlatformUserRecord | null): PrewarmStart | null {
  const phase = current.output?.prewarmState;
  if (phase === "parked" || isPrewarmClaimActive(phase)) return { state: phase, claim: prewarmClaim(current) };
  const lease = owner?.activationLease;
  const mayServeDemand = current.input.mode === GUEST_RELEASE_MODE && lease?.status === "requested";
  if (phase === DEMAND_WON || (!mayServeDemand && hasCustomerDemand(lease?.status))) return { state: DEMAND_WON };
  return null;
}

async function writePrewarmStart(tx: PlatformStateTransaction, input: {
  operation: Operation;
  request: ParkedPrewarmInput;
  root: GatewayRoot & { liveRelease: number };
  claim: PrewarmClaim;
  now: number;
  sourceVm?: OriginalVm;
}): Promise<PrewarmStart> {
  const { operation, request, root, claim, now, sourceVm } = input;
  const { gatewayId, payload } = request;
  const repairing = sourceVm?.needsRepair === true;
  if (claim.release !== root.liveRelease) {
    await tx.gateways.releases.append({
      gatewayId, expectedLatestRelease: root.latestRelease, createdAt: now, createdBy: operation.id,
      sourceRelease: root.liveRelease, note: "Parked computer prewarm", payload,
      payloadHash: releasePayloadHash(payload), activate: !repairing, updatedBy: operation.id,
    });
  }
  await tx.gateways.roots.patch(gatewayId, { desiredStatus: "running", updatedAt: now, updatedBy: operation.id });
  const state = repairing ? REPAIRING : BOOTING;
  await tx.journal.operations.patch(operation.id, { output: {
    prewarmState: state, ...claim, ...(repairing ? { repairStartedAt: now, previousBootImageId: sourceVm.bootImageId } : {}),
  } });
  return { state, claim };
}

async function demandSourceHasGuestRelease(
  tx: PlatformStateTransaction, sharedId: string, request: Extract<ParkedPrewarmInput, { mode: typeof GUEST_RELEASE_MODE }>,
): Promise<boolean> {
  const source = await tx.gateways.roots.get(sharedId);
  if (request.demandSource && ![
    request.demandSource.gatewayId === sharedId, source?.liveRelease === request.demandSource.release,
  ].every(Boolean)) return false;
  const artifact = await readGatewayArtifactInStore(tx, sharedId, source?.liveRelease ?? null);
  return artifact !== null && guestReleaseImagesMatch(artifact, request.payload);
}

async function readGuestDisksForPrewarm(tx: PlatformStateTransaction, input: {
  request: ParkedPrewarmInput; root: GatewayRoot; owner: PlatformUserRecord | null;
  sharedId: string; epoch: number; sourceVm?: OriginalVm;
}): Promise<RetainedGuestDisks | undefined> {
  const { request, root, owner, sharedId, epoch, sourceVm } = input;
  if (request.mode !== GUEST_RELEASE_MODE) return;
  const disks = readRetainedGuestDisks(sourceVm?.guestDisks);
  if (!disks || owner?.home.homeDisk?.id !== disks.homeDiskId) return;
  const lease = owner.activationLease;
  if (lease?.status !== "requested") return request.demandSource ? undefined : disks;
  if (![lease.generation === request.generation + 1, lease.targetGatewayId == null,
    lease.sourceGatewayId === sharedId, lease.sourceAssignmentEpoch === epoch,
    lease.entitlementTier === root.sizingProfile, lease.sizingTier === root.sizingTier].every(Boolean)) return;
  if (await demandSourceHasGuestRelease(tx, sharedId, request)) return disks;
}

export async function startParkedGatewayPrewarm(
  store: PlatformStateStore,
  operation: Operation,
  now: number,
  sourceVm?: OriginalVm,
): Promise<PrewarmStart> {
  const request = parkedPrewarmInput(operation);
  const { uid, gatewayId, generation, payload } = request;
  return store.transaction({ label: "isolated-gateway.prewarm-start" }, async (tx) => {
    const [current, root, runtime, owner, pool, empty, conflicts] = await Promise.all([
      tx.journal.operations.get(operation.id), tx.gateways.roots.get(gatewayId),
      tx.fleetRegistry.get(gatewayId), tx.users.records.get(uid), readSharedGatewayPoolConfigInStore(tx),
      tx.gateways.assignments.isEmpty(gatewayId), tx.journal.operations.listForUid(uid, { statuses: ["pending", "running"] }),
    ]);
    assertPrewarmWorker(operation, current);
    if (parkedHomeUnderSnapshotCustody(owner)) return { state: "ineligible" };
    const result = existingOrDemandOperation(current, owner);
    if (result) return result;
    const sharedId = eligibleSharedSource(owner, pool?.sharedGatewayIds ?? []);
    if (!sharedId || !parkedRootEligible(root, uid, generation)) return { state: "ineligible" };
    if (![empty, !conflictingPrewarmOwnerOperation(conflicts, operation.id)].every(Boolean)) return { state: "ineligible" };
    const instanceId = parkedInstanceId(runtime, sourceVm);
    if (!instanceId) return { state: "ineligible" };
    const [assignment, release] = await Promise.all([
      tx.gateways.assignments.get(sharedId, uid), tx.gateways.releases.get(gatewayId, root.liveRelease),
      assertGatewayRuntimeMutationUnfencedInStore(tx, gatewayId),
    ]);
    if (!assignment || ![assignment.state === "serving", assignment.slug === root.builderSlug, release].every(Boolean)) return { state: "ineligible" };
    const guestDisks = await readGuestDisksForPrewarm(tx, { request, root, owner, sharedId, epoch: assignment.epoch, sourceVm });
    if (request.mode === GUEST_RELEASE_MODE && !guestDisks) return { state: "ineligible" };
    const sameRelease = release!.payloadHash === releasePayloadHash(payload);
    const claim = {
      release: sameRelease ? root.liveRelease : root.latestRelease + 1,
      previousRelease: root.liveRelease, previousInstanceId: instanceId,
      sourceGatewayId: sharedId, sourceAssignmentEpoch: assignment.epoch,
      ...(guestDisks ? { guestDisks } : {}),
    };
    return writePrewarmStart(tx, { operation, request, root, claim, now, sourceVm });
  });
}

export function isFreshParkedPrewarmRecovery(value: unknown, instanceId: string, notBefore: unknown): boolean {
  if (!isGatewayVmBootRecoverySample(value) || typeof notBefore !== "number") return false;
  const recovery = value as typeof value & { instanceId?: string; observedAt?: number };
  return recovery.ready && recovery.retainedPoints <= 1 && recovery.freeBytes >= 2 * 1024 ** 3 &&
    recovery.instanceId === instanceId && typeof recovery.observedAt === "number" && recovery.observedAt >= notBefore &&
    (recovery.retainedPoints === 0) === (recovery.currentPointId === null);
}

type PrewarmFinishMode = "ready" | "rollback" | "repaired";

function finishAlreadyResolved(
  operation: OperationRecord,
  root: GatewayRoot | null,
  owner: PlatformUserRecord | null,
  request: ParkedPrewarmInput,
  mode: PrewarmFinishMode,
): "parked" | typeof HANDOFF | typeof DEMAND_WON | null {
  const phase = operation.output?.prewarmState;
  if (phase === "parked" || phase === DEMAND_WON) return phase;
  if (phase !== HANDOFF) return null;
  if (mode === "ready") return HANDOFF;
  return root?.ownerUid === request.uid && root.allocation?.generation !== request.generation &&
    owner?.activationLease?.targetGatewayId === request.gatewayId ? DEMAND_WON : null;
}

function assertOwnedPrewarmRoot(
  root: GatewayRoot | null,
  request: ParkedPrewarmInput,
  expected: { status: "running" | "paused"; release: number },
): asserts root is GatewayRoot {
  if (!root || root.desiredStatus !== expected.status || root.ownerUid !== request.uid || root.retirementClaim != null ||
      root.allocation?.claimedByUid !== request.uid || root.allocation.generation !== request.generation ||
      root.desiredRelease !== expected.release) {
    throw new Error("Parked computer prewarm no longer owns the unassigned gateway");
  }
}

function assertOriginalVmRecovery(
  operation: OperationRecord,
  originalInstanceId: string,
  runtime: FleetRegistryRecord | null,
): void {
  if (operation.output?.prewarmState !== REPAIRING || runtime?.vm?.instanceId !== originalInstanceId ||
      runtime.vm.status !== "RUNNING" || !isFreshParkedPrewarmRecovery(runtime.vmBootRecovery, originalInstanceId, operation.output.repairStartedAt)) {
    throw new Error("Original VM has not published fresh healthy boot recovery");
  }
}

async function sameDemandArtifact(
  tx: PlatformStateTransaction,
  root: GatewayRoot,
  owner: PlatformUserRecord | null,
  liveRelease: number,
  guestRelease: boolean,
): Promise<boolean> {
  const lease = owner?.activationLease;
  const requestedSource = lease?.sourceGatewayId;
  if (!requestedSource || ![lease.status === "requested", owner?.gateway?.gatewayId === requestedSource,
    lease.entitlementTier === root.sizingProfile].every(Boolean)) return false;
  const source = await tx.gateways.roots.get(requestedSource);
  if (source?.gatewayClass !== "shared" || source.liveRelease !== source.desiredRelease) return false;
  const [sourceArtifact, destinationArtifact] = await Promise.all([
    readGatewayArtifactInStore(tx, requestedSource, source.liveRelease),
    readGatewayArtifactInStore(tx, root.gatewayId, liveRelease),
  ]);
  return sourceArtifact !== null && destinationArtifact !== null && (guestRelease
    ? guestReleaseImagesMatch(sourceArtifact, destinationArtifact) : isDeepStrictEqual(sourceArtifact, destinationArtifact));
}

function finishedParkPhase(owner: PlatformUserRecord | null, mode: PrewarmFinishMode) {
  if (hasCustomerDemand(owner?.activationLease?.status)) return DEMAND_WON;
  return mode === "repaired" ? REPAIR_PARKING : "parked";
}

function prewarmFinishWindow(claim: PrewarmClaim, phase: unknown) {
  const recovering = phase === REPAIRING || phase === REPAIR_PARKING;
  return {
    status: phase === REPAIR_PARKING ? "paused" as const : "running" as const,
    release: recovering ? claim.previousRelease : claim.release,
  };
}

interface ParkedBootRejection {
  instanceId: string;
  bootImageId: string;
  reason: string;
}

async function writePrewarmPark(tx: PlatformStateTransaction, input: {
  current: OperationRecord;
  root: Stored<GatewayRoot>;
  owner: PlatformUserRecord | null;
  runtime: FleetRegistryRecord | null;
  claim: PrewarmClaim;
  now: number;
  mode: PrewarmFinishMode;
  bootRejection?: ParkedBootRejection;
}) {
  const { current, root, owner, runtime, claim, now, mode, bootRejection } = input;
  const state = finishedParkPhase(owner, mode);
  await tx.gateways.roots.patch(root.gatewayId, {
    desiredStatus: "paused",
    ...(mode === "rollback" && root.liveRelease !== claim.release ? { desiredRelease: claim.previousRelease } : {}),
    updatedAt: now, updatedBy: current.id,
  }, { revision: root.revision });
  await tx.journal.operations.patch(current.id, { output: {
    ...current.output, ...claim, prewarmState: state,
    ...(bootRejection ? { prewarmBootRejection: bootRejection.reason } : {}),
    ...(state === REPAIR_PARKING ? { repairedBootRecovery: runtime?.vmBootRecovery } : {}),
  } });
  return state;
}

function assertParkedBootRejection(input: {
  current: OperationRecord; root: GatewayRoot | null; runtime: FleetRegistryRecord | null;
  request: ParkedPrewarmInput; claim: PrewarmClaim; mode: PrewarmFinishMode; bootRejection: ParkedBootRejection;
}): void {
  const { current, root, runtime, request, claim, mode, bootRejection } = input;
  if (mode !== "rollback" || current.output?.prewarmState !== BOOTING || root?.updatedBy !== current.id ||
      bootRejection.bootImageId !== request.bootImageId || bootRejection.instanceId !== claim.previousInstanceId ||
      runtime?.vm?.instanceId !== bootRejection.instanceId) throw new Error("Parked computer boot rejection authority changed");
}

function verifyGuestReleaseLive(request: ParkedPrewarmInput, claim: PrewarmClaim, runtime: FleetRegistryRecord | null, after: number): number | undefined {
  if (request.mode !== GUEST_RELEASE_MODE) return;
  const observedAt = runtime?.vmImages?.observedAt;
  if (runtime?.vm?.status !== "RUNNING" || runtime.vm.instanceId !== claim.previousInstanceId ||
      typeof observedAt !== "number" || !guestReleaseInstalled(request.payload, claim.previousInstanceId, runtime.vmImages, after)) {
    throw new Error("Retained guest release has no exact installed image receipt");
  }
  return observedAt;
}

export async function finishParkedGatewayPrewarm(
  store: PlatformStateStore,
  operation: Operation,
  now: number,
  mode: PrewarmFinishMode,
  bootRejection?: ParkedBootRejection,
): Promise<"parked" | typeof HANDOFF | typeof DEMAND_WON | typeof REPAIR_PARKING> {
  const request = parkedPrewarmInput(operation);
  const { uid, gatewayId } = request;
  return store.transaction({ label: "isolated-gateway.prewarm-finish" }, async (tx) => {
    const [current, root, owner, empty, runtime] = await Promise.all([
      tx.journal.operations.get(operation.id), tx.gateways.roots.get(gatewayId), tx.users.records.get(uid),
      tx.gateways.assignments.isEmpty(gatewayId), tx.fleetRegistry.get(gatewayId),
    ]);
    assertPrewarmWorker(operation, current);
    const resolved = finishAlreadyResolved(current, root, owner, request, mode);
    if (resolved) return resolved;
    const claim = prewarmClaim(current);
    if (bootRejection) assertParkedBootRejection({ current, root, runtime, request, claim, mode, bootRejection });
    const window = prewarmFinishWindow(claim, current.output?.prewarmState);
    const liveRelease = window.release;
    assertOwnedPrewarmRoot(root, request, window);
    if (!empty || owner?.gateway?.gatewayId === gatewayId) throw new Error("Parked computer prewarm no longer owns the unassigned gateway");
    if (mode !== "rollback") {
      if (root.liveRelease !== liveRelease) throw new Error("Prewarmed release is not live");
      const verified = verifyGuestReleaseLive(request, claim, runtime, current.startedAt ?? current.createdAt);
      if (verified !== undefined) claim.guestVerifiedAt = verified;
    }
    if (mode === "repaired") assertOriginalVmRecovery(current, claim.previousInstanceId, runtime);
    if (mode !== "rollback" && await sameDemandArtifact(tx, root, owner, liveRelease, request.mode === GUEST_RELEASE_MODE)) {
      await tx.journal.operations.patch(operation.id, { output: { ...claim, prewarmState: HANDOFF, release: liveRelease } });
      return HANDOFF;
    }
    return writePrewarmPark(tx, { current, root, owner, runtime, claim, now, mode, bootRejection });
  });
}

export async function bootRepairedParkedGateway(
  store: PlatformStateStore,
  operation: Operation,
  now: number,
): Promise<typeof BOOTING | typeof DEMAND_WON> {
  const request = parkedPrewarmInput(operation);
  const { uid, gatewayId } = request;
  return store.transaction({ label: "isolated-gateway.prewarm-repaired-boot" }, async (tx) => {
    const [current, root, runtime, user, empty] = await Promise.all([
      tx.journal.operations.get(operation.id), tx.gateways.roots.get(gatewayId), tx.fleetRegistry.get(gatewayId),
      tx.users.records.get(uid), tx.gateways.assignments.isEmpty(gatewayId),
    ]);
    assertPrewarmWorker(operation, current);
    if (current.output?.prewarmState !== REPAIR_PARKING) throw new Error("Original VM recovery park claim changed");
    const claim = prewarmClaim(current);
    if (hasCustomerDemand(user?.activationLease?.status)) {
      await tx.journal.operations.patch(operation.id, { output: { ...current.output, prewarmState: DEMAND_WON } });
      return DEMAND_WON;
    }
    assertOwnedPrewarmRoot(root, request, { status: "paused", release: claim.previousRelease });
    if (root.liveRelease !== claim.previousRelease || parkedInstanceId(runtime, undefined) !== claim.previousInstanceId ||
        !empty || !user || isolatedRuntimeMutationFenced(user) || user.gateway?.gatewayId === gatewayId) {
      throw new Error("Claimed original VM was not safely parked after recovery");
    }
    await assertGatewayRuntimeMutationUnfencedInStore(tx, gatewayId);
    await tx.gateways.roots.patch(gatewayId, {
      desiredStatus: "running", desiredRelease: claim.release, updatedAt: now, updatedBy: operation.id,
    }, { revision: root.revision });
    await tx.journal.operations.patch(operation.id, { output: { ...current.output, prewarmState: BOOTING } });
    return BOOTING;
  });
}
import { parkedHomeUnderSnapshotCustody } from "../parked-home-archive.js";
