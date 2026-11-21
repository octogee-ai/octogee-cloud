import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { archivedSchedulerSourceImage, enqueueParkedHomeArchive, planReturnedHomeArchive } from "./parked-home-archive.js";

const fence = { ownerUid: "UidA", sizingProfile: "desktop-small" };
const parked = { instanceName: "owner-computer", zone: "us-central1-b", instanceId: "200",
  gatewayId: "owner-gateway", parkedAt: 10, checkpoint: { outcome: "stale", requestedAt: null, completedAt: null },
  vmSpec: { desktop: "x11" } };
const homeDisk = { id: "201", zone: "us-central1-b", projectId: "test-project", name: "owner-home",
  source: "projects/test-project/zones/us-central1-b/disks/owner-home", sizeGb: 10, diskType: "pd-balanced" };
const operation = { id: "return-1", status: "succeeded", kind: "migrate-user", createdAt: 1, startedAt: 2, completedAt: 11,
  inputUid: fence.ownerUid, input: { uid: fence.ownerUid, fromGatewayId: parked.gatewayId, toGatewayId: "shared-a" },
  output: { nativeSourcePark: { parked: "stopped" } }, steps: [] };

function fixture(options: { status?: string; leaseStatus?: string; homeStorage?: boolean; native?: boolean; schedulerDiskId?: string } = {}) {
  const documents = new Map<string, Record<string, unknown>>([
    ["users/UidA", { provisioning: {
      ...(options.native ? { projectStorage: { nativeBoot: true }, pendingNativeSchedulerRetirement: {
        uid: fence.ownerUid, slug: "alice", returnOperationId: operation.id, migrationId: "scheduler-return-1",
        sourceGatewayId: parked.gatewayId, sharedGatewayId: "shared-a", instanceName: parked.instanceName,
        instanceId: parked.instanceId, zone: parked.zone, homeDiskId: options.schedulerDiskId ?? homeDisk.id,
        homeDiskSource: homeDisk.source, completedAt: 10, cutoverCommittedAt: 5,
      } } : { computer: parked }), homeDisk, ...(options.homeStorage ? { homeStorage: { runtime: "gce-vm" } } : {}),
      openclaw: { slug: "alice", gatewayId: "shared-a", activationLease: { status: options.leaseStatus ?? "parked", leaseId: "lease-1",
        generation: 1, targetGatewayId: parked.gatewayId, sourceGatewayId: "shared-a", returnOperationId: "return-1" } },
    } }],
    ["gateways/owner-gateway", { gatewayId: parked.gatewayId, gatewayClass: "isolated", ownerUid: fence.ownerUid,
      sizingProfile: fence.sizingProfile, desiredStatus: "paused", desiredRelease: 1, liveRelease: 1, latestRelease: 1 }],
    ["gateways/shared-a", { gatewayId: "shared-a", gatewayClass: "shared", desiredStatus: "running", desiredRelease: 1, latestRelease: 1 }],
    ["gateways/shared-a/assignments/UidA", { uid: "UidA", slug: "alice", gatewayId: "shared-a", source: "onboarding", state: "serving", epoch: 3 }],
    ["glmGateways/owner-gateway", { docKind: "runtime", release: 1, lifecycle: "serving", gatewayId: parked.gatewayId, runtime: "gce-vm", vmSpec: parked.vmSpec,
      vm: { ...parked, status: "SUSPENDED", updatedAt: 10 } }],
    ["glmOperations/return-1", { ...operation, status: options.status ?? "succeeded", ...(options.native ? {
      cutoverCommittedAt: 5, schedulerHandoff: {
        uid: fence.ownerUid, slug: "alice", migrationId: "scheduler-return-1",
        fromGatewayId: parked.gatewayId, toGatewayId: "shared-a",
      },
    } : {}) }],
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

  it("uses the observed native parked VM without a generic idle receipt and retains exact scheduler authority", async () => {
    const store = fixture({ native: true });
    const { operationId } = await enqueueParkedHomeArchive(store, { ownerUid: fence.ownerUid, grant: fence, createdBy: "operator" });
    expect(await store.users.records.get(fence.ownerUid)).toMatchObject({
      home: { homeArchive: { operationId, source: { instanceName: parked.instanceName, zone: parked.zone, homeDiskId: homeDisk.id },
        nativeSchedulerRetirement: { migrationId: "scheduler-return-1", instanceId: parked.instanceId, homeDiskId: homeDisk.id } } },
      fences: { pendingNativeSchedulerRetirement: { migrationId: "scheduler-return-1" } },
    });
  });

  it("retains the original machine when parked scheduler authority points to another home", async () => {
    const store = fixture({ native: true, schedulerDiskId: "999" });
    await expect(enqueueParkedHomeArchive(store, { ownerUid: fence.ownerUid, grant: fence, createdBy: "operator" })).rejects.toThrow();
    expect((await store.users.records.get(fence.ownerUid))?.home.homeArchive).toBeUndefined();
  });

  it.each([true, false])("requires exact scheduler retirement metadata on a multi-hop archive image (same=%s)", async same => {
    const store = fixture({ native: true });
    const owner = (await store.users.records.get(fence.ownerUid))!;
    const custody = owner.fences.pendingNativeSchedulerRetirement!;
    const bootImage = { id: "900", name: "qualified-image", project: "test-project", homeId: homeDisk.id, homeAdmission: true,
      operationId: "boot-302", sourceComputer: { instanceId: "302", name: parked.instanceName, zone: parked.zone, gatewayId: parked.gatewayId },
      nativeSchedulerRetirement: same ? custody : { ...custody, migrationId: "unrelated-return" } };
    const current = { ...owner, home: { ...owner.home, homeDisk: { ...homeDisk, bootImage } } };
    const read = () => archivedSchedulerSourceImage(current, parked.gatewayId, "303", custody);
    if (same) expect(read()).toEqual({ id: "900", name: "qualified-image", project: "test-project" });
    else expect(read).toThrow(/scheduler replacement lineage/);
  });

  it("requires the exact case-sensitive owner grant", async () => {
    await expect(enqueueParkedHomeArchive(fixture(), {
      ownerUid: fence.ownerUid.toLowerCase(), grant: fence, createdBy: "operator",
    })).rejects.toThrow(/grant/);
  });
});


describe("archive after a durably settled return", () => {
  async function complete(store: ReturnType<typeof fixture>, grant = fence, pendingDemand = false) {
    return store.transaction({ label: "fixture.complete-return" }, async tx => {
      const owner = (await tx.users.records.get(fence.ownerUid))!;
      const lease = { ...owner.activationLease!, status: pendingDemand ? "requested" as const : "parked" as const };
      const applyArchive = await planReturnedHomeArchive(tx, owner, lease, grant, 12);
      await applyArchive?.();
      await tx.users.records.setActivationLease(owner.uid, lease, { leaseId: lease.leaseId, generation: lease.generation });
    });
  }

  it("enqueues exactly once for the opted-in normal parked return", async () => {
    const store = fixture();
    await complete(store);
    await complete(store);
    const ops = await store.journal.operations.listForUid(fence.ownerUid, { statuses: ["pending"] });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ origin: "automatic", kind: "gateway-vm", input: { uid: fence.ownerUid, action: "archive" } });
    expect((await store.users.records.get(fence.ownerUid))?.home.homeArchive?.operationId).toBe(ops[0].id);
  });

  it.each(["another user", "ineligible home", "unfinished return", "new demand"])(
    "leaves ordinary placement alone for %s", async reason => {
      const store = fixture({ ...(reason === "ineligible home" ? { homeStorage: true } : {}),
        ...(reason === "unfinished return" ? { status: "running" } : {}) });
      await complete(store, reason === "another user" ? { ...fence, ownerUid: "foreign" } : fence, reason === "new demand");
      const owner = await store.users.records.get(fence.ownerUid);
      expect(owner?.home.homeArchive).toBeUndefined();
      expect(owner?.fences.computerRecovery).toBeUndefined();
    },
  );
});
