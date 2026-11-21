import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import type { GatewayVmClient } from "./compute-vm.js";
import { rearmArchiveBeforeAccountOperation, settleInterruptedHomeArchiveForErasure } from "./recover-home-archive.js";

const uid = "account";
const oldGateway = "old-gateway";
const targetGatewayId = "new-gateway";
const snapshot = { id: "105", projectId: "fixture", name: "owned-snapshot", sourceDiskId: "101",
  sourceDisk: "projects/fixture/zones/us-central1-b/disks/old-home", sizeGb: 10 };
const bootDisk = { id: "102", source: "projects/fixture/zones/us-central1-b/disks/old-boot" };
const disk = { id: "106", name: "new-home", source: "projects/fixture/zones/us-central1-b/disks/new-home",
  projectId: "fixture", zone: "us-central1-b", sizeGb: 10, diskType: "pd-balanced" };
const claimedRestore = { phase: "restoring", snapshot, bootDisk, operationId: "archive-op",
  gatewayId: oldGateway, instanceId: "100", leaseId: "failed-lease", generation: 2, targetGatewayId,
  targetInstanceName: "restoring-vm", zone: "us-central1-b", restoredDisk: disk };
const newVm = { instanceId: "107", name: claimedRestore.targetInstanceName, zone: claimedRestore.zone,
  gatewayId: targetGatewayId, status: "TERMINATED", metadata: { "octogee-owner-uid": uid } };
const newBoot = { id: "108", source: "projects/fixture/zones/us-central1-b/disks/new-boot" };

function fixture(archive: Record<string, unknown>, failed = true) {
  const store = createDocumentFixtureStore(new Map<string, Record<string, unknown>>([
    [`users/${uid}`, { accountLifecycle: { status: "erasing", deletionId: "delete-one" },
      provisioning: { homeArchive: archive, homeDisk: { id: snapshot.sourceDiskId, source: snapshot.sourceDisk } } }],
    ["glmOperations/activate-old", { id: "activate-old", kind: "migrate-user", status: failed ? "failed" : "running",
      inputUid: uid, input: { uid, toGatewayId: targetGatewayId }, createdAt: 1, startedAt: 2, completedAt: 3, steps: [] }],
  ]));
  const vm = { describe: vi.fn(), verifyHomeSnapshot: vi.fn(), stop: vi.fn(), readArchiveBootDisk: vi.fn(async () => newBoot),
    deleteRetainingHome: vi.fn(), deleteRetainedHome: vi.fn(), archiveDisksAbsent: vi.fn(async () => true) };
  const start = async () => {
    await store.users.placementReceipts.create(uid, {
      schemaVersion: 1, kind: "activation-failed", at: 3, builderSlug: null, leaseId: "failed-lease", generation: 2,
      cause: null, sizingTier: null, entitlementTier: null, gatewayId: targetGatewayId, sharedGatewayId: "shared-a",
      requestedAt: null, wakeDurationMs: null, activeDurationMs: null, operationId: "activate-old",
      retirementOperationId: null, operatorTerminated: false, error: "synthetic failure",
    });
    return settleInterruptedHomeArchiveForErasure({ store, vm: vm as unknown as GatewayVmClient }, uid);
  };
  return { store, vm, start };
}

describe("erase an interrupted restore without losing snapshot custody", () => {
  it("removes only the exact pinned detached disk before VM insert", async () => {
    const { store, vm, start } = fixture(claimedRestore);
    vm.describe.mockResolvedValue(null);
    await start();
    expect(vm.deleteRetainingHome).not.toHaveBeenCalled();
    expect(vm.deleteRetainedHome).toHaveBeenCalledWith(disk, uid);
    expect((await store.users.records.get(uid))?.home.homeArchive).toMatchObject({ phase: "archived", snapshot, bootDisk });
  });

  it("records and verifies the recovered VM and its boot disk before deletion", async () => {
    const { store, vm, start } = fixture({ ...claimedRestore, vmInsertRequested: true });
    vm.describe.mockResolvedValueOnce(newVm).mockResolvedValue(null);
    vm.deleteRetainingHome.mockImplementation(async () => {
      expect((await store.users.records.get(uid))?.home.homeArchive).toMatchObject({ eraseRestore: {
        deletionId: "delete-one", instanceId: newVm.instanceId, bootDisk: newBoot,
      } });
    });
    await start();
    expect(vm.deleteRetainingHome).toHaveBeenCalledWith(newVm.name, newVm.zone, uid, disk, newVm.instanceId);
    expect(vm.archiveDisksAbsent).toHaveBeenCalledWith(disk, newBoot);
    expect((await store.users.records.get(uid))?.home.homeArchive).toMatchObject({ phase: "archived", snapshot });
  });

  it("preserves custody if the provider may still finish a requested VM insert", async () => {
    const { store, vm, start } = fixture({ ...claimedRestore, vmInsertRequested: true });
    vm.describe.mockResolvedValue(null);
    await expect(start()).rejects.toThrow(/VM insert is unresolved/);
    expect(vm.deleteRetainedHome).not.toHaveBeenCalled();
    expect((await store.users.records.get(uid))?.home.homeArchive).toMatchObject({ phase: "restoring", snapshot });
  });

  it("does not remove a competing or unverified generation", async () => {
    const { vm, start } = fixture(claimedRestore, false);
    await expect(start()).rejects.toThrow(/dispatched claim/);
    expect(vm.describe).not.toHaveBeenCalled();
    expect(vm.deleteRetainedHome).not.toHaveBeenCalled();
  });
});


describe("rearm a preparing archive before an exact account job", () => {
  it("rearms a failed archive for an authorized suspension without marking the account erasing", async () => {
    const { store } = fixture({ phase: "preparing", operationId: "archive-op", gatewayId: oldGateway, instanceId: "100" });
    await store.users.records.patch(uid, { accountLifecycle: { status: "deletion_scheduled", deletionId: "delete-one" } });
    await store.users.records.setFence(uid, "computerRecovery", { operationId: "archive-op", gatewayId: oldGateway, instanceId: "100" });
    await store.jobs.deletions.create({ deletionId: "delete-one", uid, version: 1, requestedAt: 1, eraseAfter: 100,
      status: "suspension_pending", suspensionOperationId: "suspend-one", erasureOperationId: "erase-one" });
    await store.journal.operations.create({ id: "archive-op", inputUid: uid, kind: "gateway-vm", status: "failed", origin: "operator",
      createdBy: "operator", createdAt: 1, startedAt: 2, completedAt: 3, steps: [],
      input: { uid, action: "archive", expectedInstanceId: "100", expectedGatewayId: oldGateway } });
    const suspension = { id: "suspend-one", inputUid: uid, kind: "suspend-user", status: "pending", createdBy: "operator",
      createdAt: 1, startedAt: null, completedAt: null, steps: [], input: { uid, deletionId: "delete-one" } } as const;
    await expect(store.transaction({ label: "foreign-deletion-preclaim" }, tx => rearmArchiveBeforeAccountOperation(
      tx, { ...suspension, id: "not-the-job", steps: [] }, 2,
    ))).resolves.toBeNull();
    await expect(store.transaction({ label: "suspension-preclaim" }, tx => rearmArchiveBeforeAccountOperation(
      tx, { ...suspension, steps: [] }, 2,
    ))).resolves.toBe("archive-op");
    expect(await store.journal.operations.get("archive-op")).toMatchObject({ status: "pending" });
    expect((await store.users.records.get(uid))?.accountLifecycle?.status).toBe("deletion_scheduled");
  });
});
