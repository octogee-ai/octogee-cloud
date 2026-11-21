import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import type { Operation } from "@octogee/shared/types/glm";
import { createHomeArchiveHandler } from "./home-archive.js";

const uid = "owner";
const gatewayId = "owner-gateway";
const operationId = "archive-one";
const home = { projectId: "test", zone: "us-central1-b", name: "old-home", id: "102", sizeGb: 10,
  diskType: "pd-balanced", source: "projects/test/zones/us-central1-b/disks/old-home" };
const source = { gatewayId, instanceId: "101", name: "owner-computer", zone: home.zone, status: "TERMINATED", metadata: { "octogee-owner-uid": uid } };
const snapshot = { projectId: "test", sourceDisk: home.source, sourceDiskId: home.id, sizeGb: 10, id: "103", name: "archive-102-archive-one" };
const bootDisk = { id: "104", source: "projects/test/zones/us-central1-b/disks/old-boot" };
const operation = { id: operationId, kind: "gateway-vm", status: "running", origin: "operator", inputUid: uid, gatewayId,
  createdBy: "operator", createdAt: 1, startedAt: 2, completedAt: null, steps: [],
  input: { action: "archive", ownerUid: uid, uid, expectedGatewayId: gatewayId, expectedInstanceId: source.instanceId },
} as Operation;

function fixture() {
  const store = createDocumentFixtureStore(new Map([
    ["users/owner", { provisioning: {
      computer: { gatewayId, instanceId: source.instanceId, instanceName: source.name, zone: source.zone,
        parkedAt: 10, checkpoint: { outcome: "stale", requestedAt: null, completedAt: null }, vmSpec: { desktop: "x11" } },
      homeDisk: home, homeArchive: { phase: "preparing", operationId, gatewayId, instanceId: source.instanceId },
      computerRecovery: { operationId, gatewayId, instanceId: source.instanceId, sharedGatewayId: "shared-a", assignmentEpoch: 3 },
      openclaw: { gatewayId: "shared-a", activationLease: { leaseId: "one", generation: 1, status: "parked", targetGatewayId: gatewayId } },
    } }],
    [`glmGateways/${gatewayId}`, { docKind: "runtime", gatewayId, release: 1, lifecycle: "serving", runtime: "gce-vm",
      vm: { instanceId: source.instanceId, instanceName: source.name, zone: source.zone, status: source.status } }],
    [`gateways/${gatewayId}`, { gatewayClass: "isolated", gatewayId, ownerUid: uid, sizingProfile: "desktop-small",
      desiredStatus: "paused", liveRelease: 1, desiredRelease: 1, latestRelease: 1 }],
    ["gateways/shared-a", { gatewayClass: "shared", gatewayId: "shared-a", desiredStatus: "running", liveRelease: 1, desiredRelease: 1, latestRelease: 1 }],
    ["gateways/shared-a/assignments/owner", { uid, gatewayId: "shared-a", state: "serving", source: "onboarding", slug: "owner", epoch: 3 }],
  ] as [string, Record<string, unknown>][]));
  const vm = {
    describe: vi.fn<() => Promise<typeof source | null>>().mockResolvedValueOnce(source).mockResolvedValue(null), stop: vi.fn(), readArchiveBootDisk: vi.fn(async () => bootDisk),
    readBootImage: vi.fn(), readImage: vi.fn(),
    snapshotStoppedHome: vi.fn(async () => snapshot), verifyHomeSnapshot: vi.fn(), deleteRetainingHome: vi.fn(),
    deleteRetainedHome: vi.fn(), archiveDisksAbsent: vi.fn(async () => true),
  };
  const ctx = { assertActiveClaim: vi.fn(), cancellationRequested: vi.fn(), reportStep: vi.fn() };
  return { store, vm, ctx };
}

describe("real archive custody transition", () => {
  it("persists snapshot and boot identity before any removal and keeps original disk provenance", async () => {
    const { store, vm, ctx } = fixture();
    vm.deleteRetainingHome.mockImplementation(async () => {
      expect((await store.users.records.get(uid))?.home.homeArchive).toMatchObject({ phase: "snapshot-ready", snapshot, bootDisk });
    });
    const run = createHomeArchiveHandler({ store, vm: vm as never, grant: { ownerUid: uid, sizingProfile: "desktop-small" } });
    const result = await run(operation, ctx);
    expect(result.success, result.error).toBe(true);
    const owner = await store.users.records.get(uid);
    expect(owner?.home).toMatchObject({ homeArchive: { phase: "archived", snapshot }, homeDisk: home });
    expect(owner?.home.computer).toBeUndefined();
    expect(owner?.fences.computerRecovery).toBeUndefined();
  });

  it.each([true, false])("archives only a replacement with proof it retained the scheduler disk (same=%s)", async same => {
    const { store, vm, ctx } = fixture();
    const nativeSchedulerRetirement = { instanceId: "99", instanceName: source.name, zone: source.zone, homeDiskId: home.id };
    const image = { id: "30", name: "qualified", project: "test", homeAdmission: true, homeId: home.id, operationId: "boot-replace",
      sourceComputer: { instanceId: "99", gatewayId, name: source.name, zone: source.zone } };
    await store.users.records.patch(uid, { home: {
      computer: { clear: true }, projectStorageNativeBoot: true, homeDisk: { ...home, bootImage: image },
      homeArchive: { phase: "preparing", operationId, gatewayId, instanceId: source.instanceId,
        source: { instanceName: source.name, zone: source.zone, homeDiskId: home.id }, nativeSchedulerRetirement },
    } });
    await store.users.records.setFence(uid, "pendingNativeSchedulerRetirement", nativeSchedulerRetirement, "absent");
    vm.readBootImage.mockResolvedValue({ ...image, id: same ? image.id : "31" });
    vm.readImage.mockResolvedValue(image);

    const run = createHomeArchiveHandler({ store, vm: vm as never, grant: { ownerUid: uid, sizingProfile: "desktop-small" } });
    const result = await run(operation, ctx);
    expect(result.success, result.error).toBe(same);
    if (same) {
      expect((await store.users.records.get(uid))?.home.homeArchive).toMatchObject({ phase: "archived", nativeSchedulerRetirement });
    } else {
      expect(vm.stop).not.toHaveBeenCalled();
      expect(vm.snapshotStoppedHome).not.toHaveBeenCalled();
      expect(vm.deleteRetainingHome).not.toHaveBeenCalled();
    }
  });

  it("preserves both disks when the exact snapshot cannot be verified", async () => {
    const { store, vm, ctx } = fixture();
    vm.verifyHomeSnapshot.mockRejectedValue(new Error("Snapshot provenance differs"));
    const run = createHomeArchiveHandler({ store, vm: vm as never, grant: { ownerUid: uid, sizingProfile: "desktop-small" } });
    await expect(run(operation, ctx)).resolves.toMatchObject({ success: false, error: "Snapshot provenance differs" });
    expect(vm.deleteRetainingHome).not.toHaveBeenCalled();
    expect(vm.deleteRetainedHome).not.toHaveBeenCalled();
    expect((await store.users.records.get(uid))?.fences.computerRecovery?.operationId).toBe(operationId);
  });

  it("keeps custody fenced while either charged disk remains", async () => {
    const { store, vm, ctx } = fixture();
    vm.archiveDisksAbsent.mockResolvedValue(false);
    const run = createHomeArchiveHandler({ store, vm: vm as never, grant: { ownerUid: uid, sizingProfile: "desktop-small" } });
    const result = await run(operation, ctx);
    expect(result.error).toMatch(/provisioned disks/);
    expect(result).toMatchObject({ success: false, retryAfterMs: expect.any(Number) });
    expect((await store.users.records.get(uid))?.home.homeArchive?.phase).toEqual("snapshot-ready");
    expect((await store.users.records.get(uid))?.fences.computerRecovery?.operationId).toEqual(operationId);
  });
});
