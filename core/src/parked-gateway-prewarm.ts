import { releasePayloadHash, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { activeParkedPrewarmGatewayIds, PARKED_PREWARM_KIND, parkedPrewarmInput, type DemandGuestSource } from "./isolated-gateway-lifecycle/prewarm.js";
import { GUEST_RELEASE_MODE, guestReleaseImagesMatch, guestReleaseInstalled } from "./isolated-gateway-lifecycle/guest-release.js";
import type { FleetRegistryRecord } from "./platform-state/fleet-registry.js";
import type { GatewayRoot } from "./platform-state/gateways.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { OperationRecord } from "./platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/store.js";

export interface ParkedGatewayPrewarmRequest {
  gatewayId: string;
  uid: string;
  sourceSha: string;
  bootImageId: string;
  payload: ReleasePayload;
  createdBy: string;
}

type Admission = { status: "queued"; operationId: string } | { status: "ineligible"; reason: string };

function inProgress(operation: OperationRecord): boolean {
  return operation.status === "running" || operation.status === "pending";
}

async function verifiedParkedOperation(
  state: PlatformStateTransaction,
  root: { liveRelease: number | null; desiredRelease: number },
  matches: readonly OperationRecord[],
  request: ParkedGatewayPrewarmRequest,
) {
  if (!matches.length || root.liveRelease === null || root.desiredRelease !== root.liveRelease) return;
  const [runtime, release] = await Promise.all([
    state.fleetRegistry.get(request.gatewayId), state.gateways.releases.get(request.gatewayId, root.liveRelease),
  ]);
  if (runtime?.vm?.status !== "SUSPENDED" || release?.payloadHash !== releasePayloadHash(request.payload)) return;
  const instanceId = runtime.vm.instanceId;
  return matches.find(op => op.output?.prewarmState === "parked" && op.output.bootImageId === request.bootImageId &&
    op.output.release === root.liveRelease && op.output.instanceId === instanceId);
}

export function enqueueParkedGatewayPrewarm(store: PlatformStateStore, request: ParkedGatewayPrewarmRequest): Promise<Admission> {
  const { gatewayId, uid, sourceSha, bootImageId, payload, createdBy } = request;
  return store.transaction({ label: "isolated-gateway.enqueue-prewarm" }, async (tx) => {
    const [root, owner] = await Promise.all([tx.gateways.roots.get(gatewayId), tx.users.records.get(uid)]);
    if (parkedHomeUnderSnapshotCustody(owner)) return { status: "ineligible", reason: "user home archive is under snapshot custody" };
    const allocation = root?.allocation;
    if (root?.gatewayClass !== "isolated" || root.ownerUid !== uid || allocation?.kind !== "disposable-builder" || allocation.claimedByUid !== uid) {
      return { status: "ineligible", reason: "parked owner or allocation has changed" };
    }
    const input = { uid, gatewayId, generation: allocation.generation, sourceSha, bootImageId, payload };
    parkedPrewarmInput({ input });
    const history = await tx.journal.operations.listForUid(uid, { kind: PARKED_PREWARM_KIND, statuses: ["pending", "running", "succeeded"] });
    const matches = history.filter(op => op.gatewayId === gatewayId && op.input.generation === input.generation &&
      op.input.sourceSha === sourceSha && op.input.bootImageId === bootImageId);
    const active = matches.find(inProgress);
    if (active) return { status: "queued", operationId: active.id };
    const prewarming = activeParkedPrewarmGatewayIds(history.filter(op => op.input.generation === allocation.generation));
    if (root.desiredStatus !== "paused" && (root.desiredStatus !== "running" || !prewarming.has(gatewayId))) {
      return { status: "ineligible", reason: "gateway is no longer parked" };
    }
    const previous = await verifiedParkedOperation(tx, root, matches, request);
    if (previous) return { status: "queued", operationId: previous.id };
    const operationId = await tx.journal.operations.enqueue({
      kind: PARKED_PREWARM_KIND, status: "pending", createdBy, createdAt: Date.now(), startedAt: null, completedAt: null,
      input, inputUid: uid, gatewayId, steps: [],
    });
    return { status: "queued", operationId };
  });
}
type GuestReleaseRequest = Omit<ParkedGatewayPrewarmRequest, "bootImageId" | "sourceSha">;
export type ParkedGuestReleaseRequest = GuestReleaseRequest & { sourceSha: string };
type DemandGuestReleaseRequest = GuestReleaseRequest & { demandSource: DemandGuestSource };
export type ParkedGuestReleaseAdmission = Admission | { status: "already-current" };

export function enqueueParkedGuestRelease(store: PlatformStateStore, request: ParkedGuestReleaseRequest): Promise<ParkedGuestReleaseAdmission> {
  return enqueueGuestRelease(store, request);
}

export function enqueueDemandGuestRelease(store: PlatformStateStore, request: DemandGuestReleaseRequest): Promise<ParkedGuestReleaseAdmission> {
  return enqueueGuestRelease(store, request);
}

function guestReleaseRootMatches(root: GatewayRoot | null, owner: PlatformUserRecord | null, uid: string): root is GatewayRoot & { allocation: NonNullable<GatewayRoot["allocation"]> } {
  return root?.gatewayClass === "isolated" && root.ownerUid === uid && root.retirementClaim == null &&
    root.allocation?.kind === "disposable-builder" && root.allocation.claimedByUid === uid && !parkedHomeUnderSnapshotCustody(owner);
}

async function parkedGuestAlreadyInstalled(
  tx: PlatformStateTransaction, root: GatewayRoot, runtime: FleetRegistryRecord | null, payload: ReleasePayload,
): Promise<boolean> {
  if (root.desiredStatus !== "paused" || root.liveRelease === null || root.liveRelease !== root.desiredRelease ||
    runtime?.vm?.status !== "SUSPENDED" || !runtime.vm.instanceId) return false;
  const release = await tx.gateways.releases.get(root.gatewayId, root.liveRelease);
  return release !== null && guestReleaseImagesMatch(release.payload, payload) &&
    guestReleaseInstalled(payload, runtime.vm.instanceId, runtime.vmImages);
}

function enqueueGuestRelease(store: PlatformStateStore, request: ParkedGuestReleaseRequest | DemandGuestReleaseRequest): Promise<ParkedGuestReleaseAdmission> {
  const { gatewayId, uid, payload, createdBy } = request;
  const origin = "sourceSha" in request ? { sourceSha: request.sourceSha } : { demandSource: request.demandSource };
  return store.transaction({ label: "isolated-gateway.enqueue-guest-release" }, async tx => {
    const [root, owner, runtime] = await Promise.all([
      tx.gateways.roots.get(gatewayId), tx.users.records.get(uid), tx.fleetRegistry.get(gatewayId),
    ]);
    if (!guestReleaseRootMatches(root, owner, uid)) {
      return { status: "ineligible", reason: "parked owner, allocation or home custody changed" };
    }
    const input = { uid, gatewayId, generation: root.allocation.generation, ...origin, mode: GUEST_RELEASE_MODE, payload } as const;
    parkedPrewarmInput({ input });
    const history = await tx.journal.operations.listForUid(uid, { kind: PARKED_PREWARM_KIND, statuses: ["pending", "running"] });
    const relevant = history.filter(op => op.gatewayId === gatewayId && op.input.generation === input.generation);
    const existing = relevant.find(op => {
      if (op.input.mode !== input.mode) return false;
      const candidate = parkedPrewarmInput(op);
      return guestReleaseImagesMatch(candidate.payload, payload);
    });
    if (existing) return { status: "queued", operationId: existing.id };
    const prewarming = activeParkedPrewarmGatewayIds(relevant).has(gatewayId);
    if (root.desiredStatus !== "paused" && (root.desiredStatus !== "running" || !prewarming)) {
      return { status: "ineligible", reason: "gateway is no longer parked" };
    }
    if (await parkedGuestAlreadyInstalled(tx, root, runtime, payload)) return { status: "already-current" };
    const operationId = await tx.journal.operations.enqueue({
      kind: PARKED_PREWARM_KIND, status: "pending", createdBy, createdAt: Date.now(), startedAt: null, completedAt: null,
      input, inputUid: uid, gatewayId, steps: [],
    });
    return { status: "queued", operationId };
  });
}
import { parkedHomeUnderSnapshotCustody } from "./parked-home-archive.js";
