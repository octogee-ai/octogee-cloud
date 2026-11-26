import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { archivedSchedulerSourceImage, enqueueParkedHomeArchive, logger, planReturnedHomeArchive } from "./parked-home-archive.js";

const fence = { ownerUid: "UidA", sizingProfile: "desktop-small" };
const parked = { instanceName: "owner-computer", zone: "us-central1-b", instanceId: "200",
  gatewayId: "owner-gateway", parkedAt: 10, checkpoint: { outcome: "stale", requestedAt: null, completedAt: null },
  vmSpec: { desktop: "x11" } };
const homeDisk = { id: "201", zone: "us-central1-b", projectId: "test-project", name: "owner-home",
  source: "projects/test-project/zones/us-central1-b/disks/owner-home", sizeGb: 10, diskType: "pd-balanced" };
const operation = { id: "return-1", status: "succeeded", kind: "migrate-user", createdAt: 1, startedAt: 2, completedAt: 11,
  inputUid: fence.ownerUid, input: { uid: fence.ownerUid, fromGatewayId: parked.gatewayId, toGatewayId: "shared-a" },
  output: { nativeSourcePark: { parked: "stopped" } }, steps: [] };

interface FixtureOptions {
  status?: string; leaseStatus?: string; homeStorage?: boolean; native?: boolean; schedulerDiskId?: string;
  desktop?: "omarchy" | "x11"; idleStorage?: "snapshot"; vmStatus?: string;
}

function fixture(options: FixtureOptions = {}) {
  const vmSpec = { desktop: options.desktop ?? parked.vmSpec.desktop };
  const profile = { isolation: "isolated", sizingTier: "s", fallbackStorageGb: null, computer: {
    runtime: "gce-vm", desktop: "omarchy", machineType: "e2-standard-2", provisioningModel: "SPOT",
    bootDisk: { sizeGb: 80, type: "pd-ssd" }, homeSizeGiB: 10, ...(options.idleStorage ? { idleStorage: options.idleStorage } : {}),
  } };
  const documents = new Map<string, Record<string, unknown>>([
    ["config/orchestrator", { sizingProfiles: { [fence.sizingProfile]: profile } }],
    ["users/UidA", { provisioning: {
      ...(options.native ? { projectStorage: { nativeBoot: true }, pendingNativeSchedulerRetirement: {
        uid: fence.ownerUid, slug: "alice", returnOperationId: operation.id, migrationId: "scheduler-return-1",
        sourceGatewayId: parked.gatewayId, sharedGatewayId: "shared-a", instanceName: parked.instanceName,
        instanceId: parked.instanceId, zone: parked.zone, homeDiskId: options.schedulerDiskId ?? homeDisk.id,
        homeDiskSource: homeDisk.source, completedAt: 10, cutoverCommittedAt: 5,
      } } : { computer: { ...parked, vmSpec } }), homeDisk, ...(options.homeStorage ? { homeStorage: { runtime: "gce-vm" } } : {}),
      openclaw: { slug: "alice", gatewayId: "shared-a", activationLease: { status: options.leaseStatus ?? "parked", leaseId: "lease-1",
        generation: 1, targetGatewayId: parked.gatewayId, sourceGatewayId: "shared-a", returnOperationId: "return-1" } },
    } }],
    ["gateways/owner-gateway", { gatewayId: parked.gatewayId, gatewayClass: "isolated", ownerUid: fence.ownerUid,
      sizingProfile: fence.sizingProfile, desiredStatus: "paused", desiredRelease: 1, liveRelease: 1, latestRelease: 1 }],
    ["gateways/shared-a", { gatewayId: "shared-a", gatewayClass: "shared", desiredStatus: "running", desiredRelease: 1, latestRelease: 1 }],
    ["gateways/shared-a/assignments/UidA", { uid: "UidA", slug: "alice", gatewayId: "shared-a", source: "onboarding", state: "serving", epoch: 3 }],
    ["glmGateways/owner-gateway", { docKind: "runtime", release: 1, lifecycle: "serving", gatewayId: parked.gatewayId, runtime: "gce-vm", vmSpec,
      vm: { ...parked, vmSpec, status: options.vmStatus ?? "SUSPENDED", updatedAt: 10 } }],
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
  async function complete(store: ReturnType<typeof fixture>, grant: typeof fence | undefined = fence, pendingDemand = false) {
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

describe("idle storage policy of the sizing profile", () => {
  afterEach(() => vi.restoreAllMocks());

  async function settleReturn(store: ReturnType<typeof fixture>) {
    const retained = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await store.transaction({ label: "fixture.complete-return" }, async tx => {
      const owner = (await tx.users.records.get(fence.ownerUid))!;
      const lease = { ...owner.activationLease!, status: "parked" as const };
      const applyArchive = await planReturnedHomeArchive(tx, owner, lease, undefined, 12);
      await applyArchive?.();
    });
    return retained.mock.calls.map(([, context]) => context);
  }

  it("queues the snapshot archive of a parked VM without any operator grant", async () => {
    const store = fixture({ desktop: "omarchy", idleStorage: "snapshot" });
    const retained = await settleReturn(store);
    const owner = await store.users.records.get(fence.ownerUid);
    const operationId = owner?.home.homeArchive?.operationId;
    expect(owner?.home.homeArchive).toMatchObject({ phase: "preparing", gatewayId: parked.gatewayId, instanceId: "200", desktop: "omarchy" });
    expect(owner?.fences.computerRecovery).toMatchObject({ operationId, gatewayId: parked.gatewayId, instanceId: "200" });
    expect(await store.journal.operations.get(operationId!)).toMatchObject({
      kind: "gateway-vm", origin: "automatic", status: "pending", input: { action: "archive", expectedInstanceId: "200" },
    });
    expect(retained).toEqual([]);
  });

  it("retains both disks of a parked VM whose profile does not ask for a snapshot", async () => {
    const store = fixture({ desktop: "omarchy" });
    const retained = await settleReturn(store);
    const owner = await store.users.records.get(fence.ownerUid);
    expect(owner?.home.homeArchive).toBeUndefined();
    expect(owner?.fences.computerRecovery).toBeUndefined();
    expect(await store.journal.operations.listForUid(fence.ownerUid, { statuses: ["pending", "running"] })).toEqual([]);
    expect(retained).toEqual([]);
  });

  it.each([
    ["the VM is not verifiably parked", { vmStatus: "RUNNING" }, /parked VM observation/],
    ["the return has not settled", { status: "running" }, /settled native return/],
    ["the VM still runs another desktop", { desktop: "x11" as const }, /parked VM observation/],
    ["the home is mid-migration", { homeStorage: true }, /simple retained home/],
  ])("retains both disks and says why when %s", async (_name, options, why) => {
    const store = fixture({ desktop: "omarchy", idleStorage: "snapshot", ...options });
    const retained = await settleReturn(store);
    const owner = await store.users.records.get(fence.ownerUid);
    expect(owner?.home.homeArchive).toBeUndefined();
    expect(owner?.fences.computerRecovery).toBeUndefined();
    expect(retained).toEqual([{ uid: fence.ownerUid, gatewayId: parked.gatewayId, sizingProfile: fence.sizingProfile, reason: expect.stringMatching(why) }]);
  });

  it("follows the profile's policy for an owner who also holds an operator grant", async () => {
    const store = fixture({ desktop: "omarchy", idleStorage: "snapshot" });
    await store.transaction({ label: "fixture.complete-return" }, async tx => {
      const owner = (await tx.users.records.get(fence.ownerUid))!;
      await (await planReturnedHomeArchive(tx, owner, { ...owner.activationLease!, status: "parked" }, fence, 12))?.();
    });
    expect((await store.users.records.get(fence.ownerUid))?.home.homeArchive).toMatchObject({ phase: "preparing", desktop: "omarchy" });
  });

  it("records the desktop of an operator-granted archive", async () => {
    const store = fixture();
    await enqueueParkedHomeArchive(store, { ownerUid: fence.ownerUid, grant: fence, createdBy: "operator" });
    expect((await store.users.records.get(fence.ownerUid))?.home.homeArchive).toMatchObject({ phase: "preparing", desktop: "x11" });
  });
});
