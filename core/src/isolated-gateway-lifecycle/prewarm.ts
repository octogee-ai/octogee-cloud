import { isDeepStrictEqual } from "node:util";
import { releasePayloadHash, isReleasePayload, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { isGatewayVmBootRecoverySample, type Operation } from "@octogee/shared/types/glm";
import { assertGatewayRuntimeMutationUnfencedInStore, isolatedRuntimeMutationFenced } from "../gateway-retirement-claim.js";
import { readGatewayArtifactInStore } from "../gateway-live-release.js";
import { readSharedGatewayPoolConfigInStore } from "../shared-gateway-pool-read.js";
import type { OperationRecord } from "../platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction } from "../platform-state/store.js";
import { userAllowsInteractiveAccess } from "./lease.js";

export const PARKED_PREWARM_KIND = "prewarm-gateway";

export interface ParkedPrewarmInput {
  uid: string;
  gatewayId: string;
  generation: number;
  sourceSha: string;
  bootImageId: string;
  payload: ReleasePayload;
}

export function parkedPrewarmInput(operation: Pick<Operation, "input">): ParkedPrewarmInput {
  const { uid, gatewayId, generation, sourceSha, bootImageId, payload } = operation.input;
  if (typeof uid !== "string" || !uid || typeof gatewayId !== "string" || !gatewayId ||
      typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 ||
      typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/.test(sourceSha) ||
      typeof bootImageId !== "string" || !/^[1-9]\d{0,19}$/.test(bootImageId) ||
      !isReleasePayload(payload)) {
    throw new Error("Invalid parked computer prewarm operation input");
  }
  return { uid, gatewayId, generation, sourceSha, bootImageId, payload };
}

export async function readActiveParkedPrewarm(
  state: Pick<PlatformStateTransaction, "journal">,
  uid: string,
): Promise<OperationRecord | null> {
  const operations = await state.journal.operations.listForUid(uid, { kind: PARKED_PREWARM_KIND, statuses: ["pending", "running"] });
  return operations.find((operation) => isPrewarmClaimActive(operation.output?.prewarmState)) ?? null;
}

type PrewarmClaim = {
  release: number;
  previousRelease: number;
  previousInstanceId: string;
  sourceGatewayId: string;
  sourceAssignmentEpoch: number;
};
const PREWARM_CLAIM_STATES = ["booting", "handoff", "repairing", "repair-parking"] as const;
type PrewarmClaimState = typeof PREWARM_CLAIM_STATES[number];

function isPrewarmClaimActive(state: unknown): state is PrewarmClaimState {
  return PREWARM_CLAIM_STATES.some((phase) => phase === state);
}

type PrewarmStart = { state: PrewarmClaimState | "parked"; claim: PrewarmClaim } |
  { state: "demand-won" | "ineligible" };

function prewarmClaim(operation: Operation): PrewarmClaim {
  const { release, previousRelease, previousInstanceId, sourceGatewayId, sourceAssignmentEpoch } = operation.output ?? {};
  if (typeof release !== "number" || typeof previousRelease !== "number" || typeof previousInstanceId !== "string" ||
      typeof sourceGatewayId !== "string" || typeof sourceAssignmentEpoch !== "number") {
    throw new Error("Parked computer prewarm claim is missing its original VM or release");
  }
  return { release, previousRelease, previousInstanceId, sourceGatewayId, sourceAssignmentEpoch };
}

function assertPrewarmWorker(operation: Operation, current: OperationRecord | null): asserts current is OperationRecord {
  if (current?.kind !== PARKED_PREWARM_KIND || current.status !== "running" || current.startedAt !== operation.startedAt) {
    throw new Error("Parked computer prewarm worker claim changed");
  }
}

function hasCustomerDemand(status: string | undefined): boolean {
  return status !== undefined && status !== "parked" && status !== "failed";
}

export async function startParkedGatewayPrewarm(
  store: PlatformStateStore,
  operation: Operation,
  now: number,
  sourceVm?: { instanceId: string; bootImageId: string; needsRepair: boolean },
): Promise<PrewarmStart> {
  const { uid, gatewayId, generation, payload } = parkedPrewarmInput(operation);
  return store.transaction({ label: "isolated-gateway.prewarm-start" }, async (tx) => {
    const [current, root, runtime, owner, pool, empty, conflicts] = await Promise.all([
      tx.journal.operations.get(operation.id), tx.gateways.roots.get(gatewayId),
      tx.fleetRegistry.get(gatewayId), tx.users.records.get(uid), readSharedGatewayPoolConfigInStore(tx),
      tx.gateways.assignments.isEmpty(gatewayId), tx.journal.operations.listForUid(uid, { statuses: ["pending", "running"] }),
    ]);
    assertPrewarmWorker(operation, current);
    const phase = current.output?.prewarmState;
    if (phase === "parked" || isPrewarmClaimActive(phase)) return { state: phase, claim: prewarmClaim(current) };
    if (current.output?.prewarmState === "demand-won") return { state: "demand-won" };
    if (hasCustomerDemand(owner?.activationLease?.status)) return { state: "demand-won" };
    const sharedId = owner?.gateway?.gatewayId;
    const vm = runtime?.vm;
    if (!sharedId || !pool?.sharedGatewayIds.includes(sharedId) || !empty || !owner || !userAllowsInteractiveAccess(owner) ||
        isolatedRuntimeMutationFenced(owner) || root?.desiredStatus !== "paused" || root.gatewayClass !== "isolated" ||
        root.ownerUid !== uid || root.allocation?.claimedByUid !== uid || root.allocation.generation !== generation ||
        root.allocation.kind !== "disposable-builder" || root.liveRelease === null || root.liveRelease !== root.desiredRelease ||
        runtime?.runtime !== "gce-vm" || !vm?.instanceId || vm.status !== "SUSPENDED" ||
        (sourceVm && sourceVm.instanceId !== vm.instanceId) ||
        conflicts.some((entry) => entry.id !== operation.id && (entry.kind !== PARKED_PREWARM_KIND || isPrewarmClaimActive(entry.output?.prewarmState)))) {
      return { state: "ineligible" };
    }
    const [assignment, release] = await Promise.all([
      tx.gateways.assignments.get(sharedId, uid), tx.gateways.releases.get(gatewayId, root.liveRelease),
      assertGatewayRuntimeMutationUnfencedInStore(tx, gatewayId),
    ]);
    if (assignment?.state !== "serving" || assignment.slug !== root.builderSlug || !release) return { state: "ineligible" };
    const repairing = sourceVm?.needsRepair === true;
    const sameRelease = release.payloadHash === releasePayloadHash(payload);
    const targetRelease = sameRelease ? root.liveRelease : root.latestRelease + 1;
    const claim = {
      release: targetRelease, previousRelease: root.liveRelease, previousInstanceId: vm.instanceId,
      sourceGatewayId: sharedId, sourceAssignmentEpoch: assignment.epoch,
    };
    if (!sameRelease) {
      await tx.gateways.releases.append({
        gatewayId, expectedLatestRelease: root.latestRelease, createdAt: now, createdBy: operation.id,
        sourceRelease: root.liveRelease, note: "Parked computer prewarm", payload,
        payloadHash: releasePayloadHash(payload), activate: !repairing, updatedBy: operation.id,
      });
    }
    await tx.gateways.roots.patch(gatewayId, { desiredStatus: "running", updatedAt: now, updatedBy: operation.id });
    const state = repairing ? "repairing" : "booting";
    await tx.journal.operations.patch(operation.id, { output: {
      prewarmState: state, ...claim, ...(repairing ? { repairStartedAt: now, previousBootImageId: sourceVm.bootImageId } : {}),
    } });
    return { state, claim };
  });
}

export function isFreshParkedPrewarmRecovery(value: unknown, instanceId: string, notBefore: unknown): boolean {
  if (!isGatewayVmBootRecoverySample(value) || typeof notBefore !== "number") return false;
  const recovery = value as typeof value & { instanceId?: string; observedAt?: number };
  return recovery.ready && recovery.retainedPoints <= 1 && recovery.freeBytes >= 2 * 1024 ** 3 &&
    recovery.instanceId === instanceId && typeof recovery.observedAt === "number" && recovery.observedAt >= notBefore &&
    (recovery.retainedPoints === 0) === (recovery.currentPointId === null);
}

export async function finishParkedGatewayPrewarm(
  store: PlatformStateStore,
  operation: Operation,
  now: number,
  mode: "ready" | "rollback" | "repaired",
): Promise<"parked" | "handoff" | "demand-won" | "repair-parking"> {
  const { uid, gatewayId, generation } = parkedPrewarmInput(operation);
  return store.transaction({ label: "isolated-gateway.prewarm-finish" }, async (tx) => {
    const [current, root, owner, empty, runtime] = await Promise.all([
      tx.journal.operations.get(operation.id), tx.gateways.roots.get(gatewayId), tx.users.records.get(uid),
      tx.gateways.assignments.isEmpty(gatewayId), tx.fleetRegistry.get(gatewayId),
    ]);
    assertPrewarmWorker(operation, current);
    if (current.output?.prewarmState === "parked" || current.output?.prewarmState === "demand-won") return current.output.prewarmState;
    if (current.output?.prewarmState === "handoff" && mode === "ready") return "handoff";
    if (current.output?.prewarmState === "handoff" && root?.ownerUid === uid &&
        root.allocation?.generation !== generation && owner?.activationLease?.targetGatewayId === gatewayId) return "demand-won";
    const claim = prewarmClaim(current);
    const phase = current.output?.prewarmState;
    const repairing = phase === "repairing" || phase === "repair-parking";
    const liveRelease = repairing ? claim.previousRelease : claim.release;
    if (!root || root.desiredStatus !== (phase === "repair-parking" ? "paused" : "running") || root.ownerUid !== uid ||
        root.allocation?.claimedByUid !== uid || root.allocation.generation !== generation ||
        root.desiredRelease !== liveRelease || !empty || owner?.gateway?.gatewayId === gatewayId) {
      throw new Error("Parked computer prewarm no longer owns the unassigned gateway");
    }
    if (mode !== "rollback" && root.liveRelease !== liveRelease) throw new Error("Prewarmed release is not live");
    const recovery = runtime?.vmBootRecovery;
    if (mode === "repaired" && (phase !== "repairing" || runtime?.vm?.instanceId !== claim.previousInstanceId ||
        runtime.vm.status !== "RUNNING" || !isFreshParkedPrewarmRecovery(recovery, claim.previousInstanceId, current.output?.repairStartedAt))) {
      throw new Error("Original VM has not published fresh healthy boot recovery");
    }
    const lease = owner?.activationLease;
    const requestedSource = lease?.sourceGatewayId;
    if (mode !== "rollback" && lease?.status === "requested" && requestedSource &&
        owner?.gateway?.gatewayId === requestedSource && lease.entitlementTier === root.sizingProfile) {
      const source = await tx.gateways.roots.get(requestedSource);
      const sourceArtifact = source?.gatewayClass === "shared" && source.liveRelease === source.desiredRelease
        ? await readGatewayArtifactInStore(tx, requestedSource, source.liveRelease) : null;
      const destinationArtifact = await readGatewayArtifactInStore(tx, gatewayId, liveRelease);
      if (destinationArtifact && isDeepStrictEqual(sourceArtifact, destinationArtifact)) {
        await tx.journal.operations.patch(operation.id, { output: { ...claim, prewarmState: "handoff", release: liveRelease } });
        return "handoff";
      }
    }
    const demand = hasCustomerDemand(lease?.status);
    const state = demand ? "demand-won" : mode === "repaired" ? "repair-parking" : "parked";
    await tx.gateways.roots.patch(gatewayId, {
      desiredStatus: "paused",
      ...(mode === "rollback" && root.liveRelease !== claim.release ? { desiredRelease: claim.previousRelease } : {}),
      updatedAt: now, updatedBy: operation.id,
    }, { revision: root.revision });
    await tx.journal.operations.patch(operation.id, { output: {
      ...current.output, ...claim, prewarmState: state,
      ...(state === "repair-parking" ? { repairedBootRecovery: recovery } : {}),
    } });
    return state;
  });
}

export async function bootRepairedParkedGateway(
  store: PlatformStateStore,
  operation: Operation,
  now: number,
): Promise<"booting" | "demand-won"> {
  const { uid, gatewayId, generation } = parkedPrewarmInput(operation);
  return store.transaction({ label: "isolated-gateway.prewarm-repaired-boot" }, async (tx) => {
    const [current, root, runtime, user, empty] = await Promise.all([
      tx.journal.operations.get(operation.id), tx.gateways.roots.get(gatewayId), tx.fleetRegistry.get(gatewayId),
      tx.users.records.get(uid), tx.gateways.assignments.isEmpty(gatewayId),
    ]);
    assertPrewarmWorker(operation, current);
    if (current.output?.prewarmState !== "repair-parking") throw new Error("Original VM recovery park claim changed");
    const claim = prewarmClaim(current);
    if (hasCustomerDemand(user?.activationLease?.status)) {
      await tx.journal.operations.patch(operation.id, { output: { ...current.output, prewarmState: "demand-won" } });
      return "demand-won";
    }
    if (!root || root.ownerUid !== uid || root.desiredStatus !== "paused" || root.liveRelease !== claim.previousRelease ||
        root.desiredRelease !== claim.previousRelease || root.allocation?.generation !== generation ||
        runtime?.vm?.status !== "SUSPENDED" || runtime.vm.instanceId !== claim.previousInstanceId ||
        !empty || !user || isolatedRuntimeMutationFenced(user) || user.gateway?.gatewayId === gatewayId) {
      throw new Error("Claimed original VM was not safely parked after recovery");
    }
    await assertGatewayRuntimeMutationUnfencedInStore(tx, gatewayId);
    await tx.gateways.roots.patch(gatewayId, {
      desiredStatus: "running", desiredRelease: claim.release, updatedAt: now, updatedBy: operation.id,
    }, { revision: root.revision });
    await tx.journal.operations.patch(operation.id, { output: { ...current.output, prewarmState: "booting" } });
    return "booting";
  });
}
