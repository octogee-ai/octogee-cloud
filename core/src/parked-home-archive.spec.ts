import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { enqueueParkedHomeArchive } from "./parked-home-archive.js";

const fence = { ownerUid: "UidA", sizingProfile: "desktop-small" };
const parked = { instanceName: "owner-computer", zone: "us-central1-b", instanceId: "200",
  gatewayId: "owner-gateway", parkedAt: 10, checkpoint: { outcome: "stale", requestedAt: null, completedAt: null },
  vmSpec: { desktop: "x11" } };
const homeDisk = { id: "201", zone: "us-central1-b", projectId: "test-project", name: "owner-home",
  source: "projects/test-project/zones/us-central1-b/disks/owner-home", sizeGb: 10, diskType: "pd-balanced" };
const operation = { id: "return-1", status: "succeeded", kind: "migrate-user", createdAt: 1, startedAt: 2, completedAt: 11,
  inputUid: fence.ownerUid, input: { uid: fence.ownerUid, fromGatewayId: parked.gatewayId, toGatewayId: "shared-a" },
  output: { nativeSourcePark: { parked: "stopped" } }, steps: [] };

function fixture(options: { status?: string; leaseStatus?: string; homeStorage?: boolean } = {}) {
  const documents = new Map<string, Record<string, unknown>>([
    ["users/UidA", { provisioning: {
      computer: parked, homeDisk, ...(options.homeStorage ? { homeStorage: { runtime: "gce-vm" } } : {}),
      openclaw: { gatewayId: "shared-a", activationLease: { status: options.leaseStatus ?? "parked", leaseId: "lease-1",
        generation: 1, targetGatewayId: parked.gatewayId, sourceGatewayId: "shared-a", returnOperationId: "return-1" } },
    } }],
    ["gateways/owner-gateway", { gatewayId: parked.gatewayId, gatewayClass: "isolated", ownerUid: fence.ownerUid,
      sizingProfile: fence.sizingProfile, desiredStatus: "paused", desiredRelease: 1, liveRelease: 1, latestRelease: 1 }],
    ["gateways/shared-a", { gatewayId: "shared-a", gatewayClass: "shared", desiredStatus: "running", desiredRelease: 1, latestRelease: 1 }],
    ["gateways/shared-a/assignments/UidA", { uid: "UidA", slug: "alice", gatewayId: "shared-a", source: "onboarding", state: "serving", epoch: 3 }],
    ["glmOperations/return-1", { ...operation, status: options.status ?? "succeeded" }],
  ]);
  return createDocumentFixtureStore(documents);
}

describe("enroll a parked home archive", () => {
  it("records the owner fence, durable intent, and journal before any provider action", async () => {
    const store = fixture();
    const input = { ownerUid: fence.ownerUid, grant: fence, createdBy: "operator" };
    const { operationId } = await enqueueParkedHomeArchive(store, input);
    expect(await store.users.records.get(fence.ownerUid)).toMatchObject({
      home: { homeDisk, homeArchive: { phase: "preparing", operationId, gatewayId: parked.gatewayId, instanceId: "200" } },
      fences: { computerRecovery: { operationId, gatewayId: parked.gatewayId, instanceId: "200", sharedGatewayId: "shared-a", assignmentEpoch: 3 } },
    });
    expect(await store.journal.operations.get(operationId)).toMatchObject({
      kind: "gateway-vm", origin: "operator", status: "pending", inputUid: fence.ownerUid,
      input: { action: "archive", uid: fence.ownerUid },
    });
    await expect(enqueueParkedHomeArchive(store, input)).resolves.toEqual({ operationId });
  });

  it("validates a dry run without writing any archive custody or journal operation", async () => {
    const store = fixture();
    await enqueueParkedHomeArchive(store, { ownerUid: fence.ownerUid, grant: fence, createdBy: "operator", dryRun: true });
    const owner = await store.users.records.get(fence.ownerUid);
    expect(owner?.home.homeArchive).toBeUndefined();
    expect(owner?.fences.computerRecovery).toBeUndefined();
    expect(await store.journal.operations.listForUid(fence.ownerUid, { statuses: ["pending", "running"] })).toEqual([]);
  });

  it.each([{ status: "running" }, { leaseStatus: "requested" }, { homeStorage: true }])(
    "leaves custody untouched without exact settled return and simple native home (%j)", async options => {
      const store = fixture(options);
      await expect(enqueueParkedHomeArchive(store, { ownerUid: fence.ownerUid, grant: fence, createdBy: "operator" })).rejects.toThrow();
      const owner = await store.users.records.get(fence.ownerUid);
      expect(owner?.home.homeArchive).toBeUndefined();
      expect(owner?.fences.computerRecovery).toBeUndefined();
    },
  );

  it("rearms the same persisted archive after a retryable terminal failure", async () => {
    const store = fixture();
    const input = { ownerUid: fence.ownerUid, grant: fence, createdBy: "operator" };
    const { operationId } = await enqueueParkedHomeArchive(store, input);
    await store.journal.operations.patch(operationId, { status: "failed", completedAt: 20, error: "Compute unavailable" });

    await expect(enqueueParkedHomeArchive(store, input)).resolves.toEqual({ operationId });
    expect(await store.journal.operations.get(operationId)).toMatchObject({ status: "pending", completedAt: null });
  });

  it("requires the exact case-sensitive owner grant", async () => {
    await expect(enqueueParkedHomeArchive(fixture(), {
      ownerUid: fence.ownerUid.toLowerCase(), grant: fence, createdBy: "operator",
    })).rejects.toThrow(/grant/);
  });
});
