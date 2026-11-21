import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { describe, expect, it, vi } from "vitest";
import type { GatewayVmDescription } from "./compute-vm.js";
import { retireNativeSchedulerBeforeStage } from "./native-scheduler-retirement.js";

const uid = "owner";
const slug = "alice";
const gatewayId = "restored-isolated";
const source = "old-isolated";
const shared = "shared-a";
const zone = "us-central1-b";
const migrationId = "returned-scheduler";
const returnOperationId = "completed-return";
const operationId = "activate-restored";
const oldDisk = "projects/test/zones/us-central1-b/disks/old-home";
const disk = { id: "102", source: "projects/test/zones/us-central1-b/disks/new-home", projectId: "test",
  zone, name: "new-home", sizeGb: 10, diskType: "pd-balanced" as const };
const retirement = { uid, slug, sourceGatewayId: source, sharedGatewayId: shared, migrationId, returnOperationId,
  instanceId: "100", instanceName: "old-vm", zone, homeDiskId: "101", homeDiskSource: oldDisk, cutoverCommittedAt: 9, completedAt: 10 };

function fixture(options: { snapshotSource?: string; generation?: number; attachedDisk?: string; schedulerDrained?: boolean } = {}) {
  const archive = { phase: "restored", operationId: "home-archive", gatewayId: source, instanceId: "200",
    nativeSchedulerRetirement: retirement,
    snapshot: { sourceDisk: oldDisk, sourceDiskId: options.snapshotSource ?? "101", projectId: "test", id: "301", name: "home-snapshot", sizeGb: 10 },
    bootDisk: { source: "projects/test/zones/us-central1-b/disks/old-boot", id: "302" },
    targetGatewayId: gatewayId, leaseId: "restored-demand", generation: 2, restoredInstanceId: "201", restoredDisk: disk };
  const store = createDocumentFixtureStore(new Map<string, Record<string, unknown>>([
    [`users/${uid}`, { provisioning: {
      homeDisk: disk, homeArchive: archive, pendingNativeSchedulerRetirement: retirement,
      openclaw: { slug, gatewayId, activationLease: { status: "activating", leaseId: "restored-demand", generation: options.generation ?? 2, targetGatewayId: gatewayId } },
    } }],
    [`gateways/${gatewayId}`, { gatewayId, ownerUid: uid, builderSlug: slug, gatewayClass: "isolated", desiredStatus: "running", desiredRelease: 1, latestRelease: 1 }],
    [`glmGateways/${gatewayId}`, { docKind: "runtime", release: 1, lifecycle: "serving", gatewayId, runtime: "gce-vm", vm: { instanceId: "201", instanceName: "restored-vm", zone } }],
    [`glmOperations/${returnOperationId}`, {
      id: returnOperationId, kind: "migrate-user", status: "succeeded", cutoverCommittedAt: 9, completedAt: 11,
      input: { uid, fromGatewayId: source, toGatewayId: shared },
      schedulerHandoff: { migrationId, uid, slug, fromGatewayId: source, toGatewayId: shared },
    }],
    [`glmOperations/${operationId}`, {
      id: operationId, kind: "migrate-user", status: "running", startedAt: 20, cutoverCommittedAt: 22,
      input: { uid, fromGatewayId: shared, toGatewayId: gatewayId },
    }],
  ]));
  const description: GatewayVmDescription = { name: "restored-vm", instanceId: "201", gatewayId, zone, status: "RUNNING",
    metadata: { "octogee-owner-uid": uid }, labels: {}, machineType: "e2-medium", internalIp: null, provisioningModel: "STANDARD",
    serviceAccounts: [], lastStartedAt: 10 };
  const vm = { describe: vi.fn(async () => description), retainHome: vi.fn(async () => ({ ...disk, id: options.attachedDisk ?? disk.id })),
    readBootImage: vi.fn(), readImage: vi.fn() };
  const scheduler = vi.fn(async () => ({ operationId: migrationId, phase: "retire" as const, agentIds: ["alice"], drained: options.schedulerDrained ?? true }));
  const run = () => retireNativeSchedulerBeforeStage({ store, vm, log: vi.fn() }, {
    uid, slug, gatewayId, operationId, claimedStartedAt: 20,
  }, scheduler);
  return { run, store, vm, scheduler };
}

describe("retire the original scheduler handoff on a snapshot-backed home", () => {
  it("requires the prior native migration receipt from the attached restored home before clearing authority", async () => {
    const h = fixture();
    await h.run();
    expect(h.scheduler).toHaveBeenCalledExactlyOnceWith({ migrationId, gatewayId, slug, phase: "retire" });
    expect(h.vm.retainHome).toHaveBeenCalledWith("restored-vm", zone, uid);
    expect((await h.store.users.records.get(uid))?.fences.pendingNativeSchedulerRetirement).toBeUndefined();
  });

  it.each([{ snapshotSource: "999" }, { generation: 3 }, { attachedDisk: "999" }])("keeps the scheduler closed when restored custody differs (%j)", async options => {
    const h = fixture(options);
    await expect(h.run()).rejects.toThrow(/authority changed|disk identity changed/);
    expect(h.scheduler).not.toHaveBeenCalled();
    expect((await h.store.users.records.get(uid))?.fences.pendingNativeSchedulerRetirement).toEqual(retirement);
  });

  it("keeps the receipt until native retirement acknowledges the original migration", async () => {
    const h = fixture({ schedulerDrained: false });
    await expect(h.run()).rejects.toThrow(/acknowledgement changed/);
    expect((await h.store.users.records.get(uid))?.fences.pendingNativeSchedulerRetirement).toEqual(retirement);
  });
});
