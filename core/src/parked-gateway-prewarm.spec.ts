import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { seedServingGateway, sharedPayload } from "@octogee/core-testing/admin-fleet-releases-app";
import { placedUser } from "@octogee/core-testing/admin-dry-run-app";
import { enqueueDemandGuestRelease, enqueueParkedGatewayPrewarm, enqueueParkedGuestRelease } from "./parked-gateway-prewarm.js";

const request = { gatewayId: "isolated", uid: "alice", sourceSha: "a".repeat(40), bootImageId: "123", payload: sharedPayload(), createdBy: "ship-test" };

function fixture(status = "paused", payload = request.payload, vmImages?: Record<string, unknown>, sharedGatewayId?: string) {
  const docs = seedServingGateway("isolated", payload, undefined, {
    desiredStatus: status, liveRelease: 1, gatewayClass: "isolated", ownerUid: "alice",
    allocation: { kind: "disposable-builder", schemaVersion: 1, generation: 2, claimedByUid: "alice", leaseId: "one" },
  });
  docs["glmGateways/isolated"].vm = { status: "SUSPENDED", instanceId: "456" };
  if (vmImages) docs["glmGateways/isolated"].vmImages = vmImages;
  if (sharedGatewayId) Object.assign(docs, placedUser("alice", "alice", sharedGatewayId));
  return createDocumentFixtureStore(new Map(Object.entries(docs)));
}

describe("Ship parked computer admission", () => {
  it("reuses a pending immutable upgrade and associates the operation with its owner", async () => {
    const store = fixture();
    const first = await enqueueParkedGatewayPrewarm(store, request);
    expect(first.status).toBe("queued");
    expect(await enqueueParkedGatewayPrewarm(store, request)).toEqual(first);
    if (first.status !== "queued") throw new Error(first.reason);
    expect(await store.journal.operations.get(first.operationId)).toMatchObject({
      kind: "prewarm-gateway", inputUid: "alice", createdBy: "ship-test",
      input: { gatewayId: "isolated", uid: "alice", generation: 2, sourceSha: request.sourceSha, bootImageId: "123" },
    });
  });
  it("reuses physical suspension proof only for the same live image and instance", async () => {
    const store = fixture();
    const first = await enqueueParkedGatewayPrewarm(store, request);
    if (first.status !== "queued") throw new Error(first.reason);
    await store.journal.operations.patch(first.operationId, {
      status: "succeeded", completedAt: Date.now(),
      output: { prewarmState: "parked", release: 1, instanceId: "456", bootImageId: request.bootImageId },
    });
    expect(await enqueueParkedGatewayPrewarm(store, request)).toEqual(first);
    await store.journal.operations.patch(first.operationId, {
      output: { prewarmState: "parked", release: 1, instanceId: "999", bootImageId: request.bootImageId },
    });
    const replacement = await enqueueParkedGatewayPrewarm(store, request);
    expect(replacement.status).toBe("queued");
    expect(replacement).not.toEqual(first);
  });
  it("skips an archived owner even while the old physical VM is still observed", async () => {
    const store = fixture();
    await store.users.records.create({ uid: request.uid, createdAt: 1 });
    const homeArchive = { phase: "preparing" as const, operationId: "archive-1", gatewayId: request.gatewayId, instanceId: "456" };
    await store.users.records.patch(request.uid, { home: { homeArchive } });

    expect((await store.users.records.get(request.uid))?.home.homeArchive).toEqual(homeArchive);
    await expect(enqueueParkedGatewayPrewarm(store, request)).resolves.toMatchObject({ status: "ineligible" });
    expect(await store.journal.operations.listForUid(request.uid, { statuses: ["pending"] })).toEqual([]);
  });
  it("skips ownership changes and running roots", async () => {
    expect((await enqueueParkedGatewayPrewarm(fixture(), { ...request, uid: "bob" })).status).toBe("ineligible");
    expect((await enqueueParkedGatewayPrewarm(fixture("running"), request)).status).toBe("ineligible");
  });

  it("records a newer upgrade behind an active upgrade of the same owner-bound computer", async () => {
    const store = fixture();
    const active = await enqueueParkedGatewayPrewarm(store, request);
    if (active.status !== "queued") throw new Error(active.reason);
    await store.journal.operations.patch(active.operationId, { status: "running", output: { prewarmState: "repairing" } });
    await store.gateways.roots.patch(request.gatewayId, { desiredStatus: "running" });

    const newer = { ...request, sourceSha: "b".repeat(40), bootImageId: "999" };
    const queued = await enqueueParkedGatewayPrewarm(store, newer);
    expect(queued.status).toBe("queued");
    expect(queued).not.toEqual(active);
    expect(await enqueueParkedGatewayPrewarm(store, newer)).toEqual(queued);
    expect((await store.journal.operations.get(active.operationId))?.status).toBe("running");
  });
});

describe("Ship retained guest release admission", () => {
  const tag = "abcdef1";
  const gatewayDigest = `sha256:${"a".repeat(64)}`;
  const edgeDigest = `sha256:${"b".repeat(64)}`;
  const gateway = request.payload.imageRepository;
  const edge = gateway.replace(/octogee-gateway$/u, "gateway-edge");
  const live = { imageRepository: gateway, imageTag: `${tag}@${gatewayDigest}`, openclawSourceSha: "d".repeat(40),
    gatewayEdgeImage: { imageRepository: edge, imageTag: `${tag}@${edgeDigest}` } };
  const candidate = { ...live, imageTag: `abcdef2@${gatewayDigest}`, gatewayEdgeImage: { ...live.gatewayEdgeImage, imageTag: `abcdef2@${edgeDigest}` } };
  const queued = { gatewayId: request.gatewayId, uid: request.uid, sourceSha: request.sourceSha, createdBy: request.createdBy, payload: candidate };
  const images = { instanceId: "456", observedAt: 1_000, containers: [
    { name: "gateway", running: true, imageReference: `${gateway}:${tag}@${gatewayDigest}`, digests: [`${gateway}@${gatewayDigest}`] },
    { name: "gateway-edge", running: true, imageReference: `${edge}:${tag}@${edgeDigest}`, digests: [`${edge}@${edgeDigest}`] },
  ] };

  const sourceGatewayId = "shared-aaaaaaaaaaaa";
  const targetGatewayId = "shared-bbbbbbbbbbbb";
  async function replacing() {
    const store = fixture("paused", live, undefined, sourceGatewayId);
    await store.controllerState.sharedPoolScaler.put({
      schemaVersion: 1, actionSequence: 1, lastActionAt: 1,
      replacements: [{ sourceGatewayId, targetGatewayId, updatedAt: 1 }],
    }, "absent");
    return store;
  }

  it("leaves a background guest upgrade for the post-cutover pass when the owner's Shared gateway is being replaced", async () => {
    const store = await replacing();
    await expect(enqueueParkedGuestRelease(store, queued)).resolves.toMatchObject({ status: "ineligible", reason: expect.stringContaining("Shared") });
    expect(await store.journal.operations.listForUid(request.uid, { statuses: ["pending"] })).toHaveLength(0);
    await store.users.records.setGatewayMirror("alice", { gatewayId: targetGatewayId }, { gatewayId: sourceGatewayId });
    await expect(enqueueParkedGuestRelease(store, queued)).resolves.toMatchObject({ status: "queued" });
  });

  it("continues to queue owner demand while a Shared replacement is pending", async () => {
    const store = await replacing();
    const demand = { gatewayId: queued.gatewayId, uid: queued.uid, createdBy: "placement", payload: queued.payload,
      demandSource: { gatewayId: sourceGatewayId, release: 1 } };
    await expect(enqueueDemandGuestRelease(store, demand)).resolves.toMatchObject({ status: "queued" });
  });

  it("does not queue a wake or write a release when both installed digests already match", async () => {
    const store = fixture("paused", live, images);
    await expect(enqueueParkedGuestRelease(store, queued)).resolves.toEqual({ status: "already-current" });
    expect(await store.journal.operations.listForUid(request.uid, { statuses: ["pending"] })).toEqual([]);
    expect((await store.gateways.roots.get(request.gatewayId))?.desiredStatus).toBe("paused");
  });

  it("queues one guest update when installed custody is unproven, irrespective of generated tags", async () => {
    const store = fixture("paused", live, { ...images, instanceId: "different" });
    const first = await enqueueParkedGuestRelease(store, queued);
    expect(first.status).toBe("queued");
    await expect(enqueueParkedGuestRelease(store, { ...queued, payload: live })).resolves.toEqual(first);
    const pending = await store.journal.operations.listForUid(request.uid, { statuses: ["pending"] });
    expect(pending).toHaveLength(1);
    expect(pending[0].input).toMatchObject({ mode: "guest-release", sourceSha: request.sourceSha });
    expect(pending[0].input).not.toHaveProperty("bootImageId");
  });
});
