import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import type { GatewayVmSpec } from "@octogee/shared/types/glm";
import type { CreateGatewayVmInput, GatewayVmClient } from "./compute-vm.js";
import { restoreArchivedHome } from "./archived-home-restore.js";

const uid = "owner";
const gatewayId = "target-gateway";
const zone = "us-central1-b";
const oldHome = { source: "projects/test/zones/us-central1-b/disks/old-home", id: "102" };
const archive = { phase: "archived", operationId: "archive-one", gatewayId: "old-gateway", instanceId: "101",
  snapshot: { projectId: "test", name: "home-archive", id: "103", sizeGb: 10, sourceDisk: oldHome.source, sourceDiskId: oldHome.id },
  bootDisk: { source: "projects/test/zones/us-central1-b/disks/old-boot", id: "104" } };
const newDisk = { projectId: "test", zone, name: "snapshot-backed", id: "105", sizeGb: 10, diskType: "pd-balanced" as const,
  source: "projects/test/zones/us-central1-b/disks/snapshot-backed" };
const instance = { name: "test-owner", instanceId: "106", gatewayId, zone, status: "RUNNING",
  metadata: { "octogee-owner-uid": uid } };
const spec = { zones: [zone], desktop: "x11", homeDiskSizeGb: 10 } as GatewayVmSpec;
const input = { instanceName: instance.name, zones: spec.zones } as CreateGatewayVmInput;

function fixture(generation = 2) {
  const store = createDocumentFixtureStore(new Map<string, Record<string, unknown>>([
    [`users/${uid}`, { provisioning: { homeArchive: archive, homeDisk: oldHome, homeMigration: { phase: "complete", preparedFor: {} },
      openclaw: { activationLease: { status: "provisioning", leaseId: "demand-two", generation, targetGatewayId: gatewayId } } } }],
    [`gateways/${gatewayId}`, { gatewayClass: "isolated", gatewayId, ownerUid: uid, desiredStatus: "running",
      liveRelease: 1, desiredRelease: 1, latestRelease: 1,
      allocation: { kind: "disposable-builder", schemaVersion: 1, generation: 2, claimedByUid: uid, leaseId: "demand-two" } }],
  ]));
  const vm = {
    describe: vi.fn(), restoreHomeFromSnapshot: vi.fn(async () => newDisk), verifyDetachedHome: vi.fn(),
    create: vi.fn(async () => ({ description: instance })), retainHome: vi.fn(async () => newDisk),
  };
  const run = () => restoreArchivedHome({ store, vm: vm as unknown as GatewayVmClient }, { ownerUid: uid, gatewayId }, spec, input);
  return { store, vm, run };
}

describe("attach a snapshot-backed home through normal demand", () => {
  it("pins snapshot-backed disk before VM insertion and commits it after checking attachment", async () => {
    const { store, vm, run } = fixture();
    vm.create.mockImplementation(async () => {
      expect((await store.users.records.get(uid))?.home.homeArchive).toMatchObject({
        phase: "restoring", targetGatewayId: gatewayId, leaseId: "demand-two", generation: 2, restoredDisk: newDisk,
      });
      return { description: instance };
    });
    await expect(run()).resolves.toEqual(instance);
    expect(vm.create).toHaveBeenCalledWith(expect.objectContaining({ retainedHome: newDisk, zones: [zone] }));
    expect((await store.users.records.get(uid))?.home).toMatchObject({ homeArchive: { phase: "restored", snapshot: archive.snapshot },
      homeDisk: newDisk });
  });

  it("refuses an unrelated lease generation before calling the provider", async () => {
    const { vm, run } = fixture(3);
    await expect(run()).rejects.toThrow(/exact active restore demand/);
    expect(vm.restoreHomeFromSnapshot).not.toHaveBeenCalled();
    expect(vm.create).not.toHaveBeenCalled();
  });

  it("retains the certified snapshot and reuses its pinned disk on retry of VM attach", async () => {
    const { vm, run } = fixture();
    vm.create.mockRejectedValueOnce(new Error("create receipt unavailable"));
    await expect(run()).rejects.toThrow(/receipt unavailable/);
    vm.describe.mockResolvedValueOnce(instance);
    await expect(run()).resolves.toEqual(instance);
    expect(vm.restoreHomeFromSnapshot).toHaveBeenCalledTimes(1);
    expect(vm.create).toHaveBeenCalledTimes(1);
  });
});
