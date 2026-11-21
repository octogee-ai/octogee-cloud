import { releasePayloadHash, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { PARKED_PREWARM_KIND, parkedPrewarmInput } from "./isolated-gateway-lifecycle/prewarm.js";
import type { PlatformStateStore } from "./platform-state/store.js";

export interface ParkedGatewayPrewarmRequest {
  gatewayId: string;
  uid: string;
  sourceSha: string;
  bootImageId: string;
  payload: ReleasePayload;
  createdBy: string;
}

type Admission = { status: "queued"; operationId: string } | { status: "ineligible"; reason: string };

export function enqueueParkedGatewayPrewarm(store: PlatformStateStore, request: ParkedGatewayPrewarmRequest): Promise<Admission> {
  const { gatewayId, uid, sourceSha, bootImageId, payload, createdBy } = request;
  return store.transaction({ label: "isolated-gateway.enqueue-prewarm" }, async (tx) => {
    const root = await tx.gateways.roots.get(gatewayId);
    const allocation = root?.allocation;
    if (root?.gatewayClass !== "isolated" || root.ownerUid !== uid || allocation?.kind !== "disposable-builder" || allocation.claimedByUid !== uid) {
      return { status: "ineligible", reason: "parked owner or allocation has changed" };
    }
    const input = { uid, gatewayId, generation: allocation.generation, sourceSha, bootImageId, payload };
    parkedPrewarmInput({ input });
    const history = await tx.journal.operations.listForUid(uid, { kind: PARKED_PREWARM_KIND, statuses: ["pending", "running", "succeeded"] });
    const matches = history.filter(op => op.gatewayId === gatewayId && op.input.generation === input.generation &&
      op.input.sourceSha === sourceSha && op.input.bootImageId === bootImageId);
    const active = matches.find(op => op.status === "pending" || op.status === "running");
    if (active) return { status: "queued", operationId: active.id };
    if (root.desiredStatus !== "paused") return { status: "ineligible", reason: "gateway is no longer parked" };
    if (history.some(op => op.status === "pending" || op.status === "running")) {
      throw new Error(`Another parked computer upgrade is active for ${gatewayId}`);
    }
    if (root.liveRelease !== null && root.desiredRelease === root.liveRelease) {
      const [runtime, release] = await Promise.all([
        tx.fleetRegistry.get(gatewayId), tx.gateways.releases.get(gatewayId, root.liveRelease),
      ]);
      const previous = matches.find(op => op.output?.prewarmState === "parked" && op.output.bootImageId === bootImageId &&
        op.output.release === root.liveRelease && runtime?.vm?.status === "SUSPENDED" && runtime.vm.instanceId === op.output.instanceId);
      if (previous && release?.payloadHash === releasePayloadHash(payload)) return { status: "queued", operationId: previous.id };
    }
    const operationId = await tx.journal.operations.enqueue({
      kind: PARKED_PREWARM_KIND, status: "pending", createdBy, createdAt: Date.now(), startedAt: null, completedAt: null,
      input, inputUid: uid, gatewayId, steps: [],
    });
    return { status: "queued", operationId };
  });
}
