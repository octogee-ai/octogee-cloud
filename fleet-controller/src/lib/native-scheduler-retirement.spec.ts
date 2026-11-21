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

function fixture(options: { snapshotSource?: string; generation?: number; attachedDisk?: string; schedulerDrained?: boolean; retainedBoot?: "legacy" | "multiple" | "wrong-custody" } = {}) {
  const archive = { phase: "restored", operationId: "home-archive", gatewayId: source, instanceId: "200",
    nativeSchedulerRetirement: retirement,
    snapshot: { sourceDisk: oldDisk, sourceDiskId: options.snapshotSource ?? "101", projectId: "test", id: "301", name: "home-snapshot", sizeGb: 10 },
    bootDisk: { source: "projects/test/zones/us-central1-b/disks/old-boot", id: "302" },
    targetGatewayId: gatewayId, leaseId: "restored-demand", generation: 2, restoredInstanceId: "201", restoredDisk: disk };
  const { retainedBoot } = options;
  const oldDiskRecord = { ...disk, id: retirement.homeDiskId, source: oldDisk };
  const boot = { homeAdmission: true as const, homeId: retirement.homeDiskId, name: "qualified-builder", id: "409", project: "test",
    operationId: "replaced-boot", sourceComputer: {
      name: retirement.instanceName, zone, gatewayId: source, instanceId: retainedBoot === "legacy" ? retirement.instanceId : "200",
    },
    ...(retainedBoot && retainedBoot !== "legacy" ? { nativeSchedulerRetirement: retainedBoot === "multiple"
      ? retirement : { ...retirement, migrationId: "other-migration" } } : {}),
  };
  const describedName = retainedBoot ? retirement.instanceName : "restored-vm";
  const store = createDocumentFixtureStore(new Map<string, Record<string, unknown>>([
    [`users/${uid}`, { provisioning: {
      ...(retainedBoot ? { homeDisk: { ...oldDiskRecord, bootImage: boot } } : { homeDisk: disk, homeArchive: archive }),
      pendingNativeSchedulerRetirement: retirement,
      openclaw: { slug, gatewayId, activationLease: { status: "activating", leaseId: "restored-demand", generation: options.generation ?? 2, targetGatewayId: gatewayId } },
    } }],
    [`gateways/${gatewayId}`, { gatewayId, ownerUid: uid, builderSlug: slug, gatewayClass: "isolated", desiredStatus: "running", desiredRelease: 1, latestRelease: 1 }],
    [`glmGateways/${gatewayId}`, { docKind: "runtime", release: 1, lifecycle: "serving", gatewayId, runtime: "gce-vm", vm: { instanceId: "201", instanceName: describedName, zone } }],
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
  const description: GatewayVmDescription = { name: describedName, instanceId: "201", gatewayId, zone, status: "RUNNING",
    metadata: { "octogee-owner-uid": uid }, labels: {}, machineType: "e2-medium", internalIp: null, provisioningModel: "STANDARD",
    serviceAccounts: [], lastStartedAt: 10 };
  const attached = retainedBoot ? oldDiskRecord : disk;
  const vm = { describe: vi.fn(async () => description), retainHome: vi.fn(async () => ({ ...attached, id: options.attachedDisk ?? attached.id })),
    readBootImage: vi.fn(async () => ({ id: boot.id, name: boot.name })), readImage: vi.fn(async () => boot) };
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

describe("serve retained scheduler custody across boot image replacement", () => {
  it.each(["legacy", "multiple"] as const)("accepts the exact attached home and boot identity through %s lineage", async retainedBoot => {
    const h = fixture({ retainedBoot });
    await h.run();
    expect(h.scheduler).toHaveBeenCalledExactlyOnceWith({ migrationId, gatewayId, slug, phase: "retire" });
    expect((await h.store.users.records.get(uid))?.fences.pendingNativeSchedulerRetirement).toBeUndefined();
  });

  it("refuses boot metadata carrying another scheduler migration receipt", async () => {
    const h = fixture({ retainedBoot: "wrong-custody" });
    await expect(h.run()).rejects.toThrow(/retirement authority changed/);
    expect(h.scheduler).not.toHaveBeenCalled();
    expect((await h.store.users.records.get(uid))?.fences.pendingNativeSchedulerRetirement).toEqual(retirement);
  });
});
