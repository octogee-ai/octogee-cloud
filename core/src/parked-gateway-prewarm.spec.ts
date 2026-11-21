import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { seedServingGateway, sharedPayload } from "@octogee/core-testing/admin-fleet-releases-app";
import { enqueueParkedGatewayPrewarm } from "./parked-gateway-prewarm.js";

const request = { gatewayId: "isolated", uid: "alice", sourceSha: "a".repeat(40), bootImageId: "123", payload: sharedPayload(), createdBy: "ship-test" };

function fixture(status = "paused") {
  const docs = seedServingGateway("isolated", request.payload, undefined, {
    desiredStatus: status, liveRelease: 1, gatewayClass: "isolated", ownerUid: "alice",
    allocation: { kind: "disposable-builder", schemaVersion: 1, generation: 2, claimedByUid: "alice", leaseId: "one" },
  });
  docs["glmGateways/isolated"].vm = { status: "SUSPENDED", instanceId: "456" };
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
