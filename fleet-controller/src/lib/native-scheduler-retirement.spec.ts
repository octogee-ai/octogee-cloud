import { archivedSchedulerSourceImage } from "@octogee/core/admin-fleet-router";
import type { OperationRecord } from "@octogee/core/platform-state";
import type { GatewayVmSpec } from "@octogee/shared/types/glm";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { describe, expect, it, vi } from "vitest";
import type { GatewayVmDescription } from "./compute-vm.js";
import { selectRetainedBootImage } from "./retained-boot-image.js";
import { retireNativeSchedulerBeforeStage } from "./native-scheduler-retirement.js";

const uid = "owner";
const slug = "alice";
const gatewayId = "restored-isolated";
const source = "old-isolated";
const shared = "shared-a";
const zone = "us-central1-b";
const migrationId = "returned-scheduler";
const returnOperationId = `builder-return-${source}-g1`;
const operationId = "activate-restored";
const oldDisk = "projects/test/zones/us-central1-b/disks/old-home";
const disk = { id: "102", source: "projects/test/zones/us-central1-b/disks/new-home", projectId: "test",
  zone, name: "new-home", sizeGb: 10, diskType: "pd-balanced" as const };
const retirement = { uid, slug, sourceGatewayId: source, sharedGatewayId: shared, migrationId, returnOperationId,
  instanceId: "100", instanceName: "old-vm", zone, homeDiskId: "101", homeDiskSource: oldDisk, cutoverCommittedAt: 9, completedAt: 10 };

function fixture(options: { snapshotSource?: string; generation?: number; attachedDisk?: string; schedulerDrained?: boolean; retainedBoot?: "legacy" | "multiple" | "wrong-custody" | "historical" } = {}) {
  const archive = { phase: "restored", operationId: "home-archive", gatewayId: source, instanceId: "200",
    nativeSchedulerRetirement: retirement,
    snapshot: { sourceDisk: oldDisk, sourceDiskId: options.snapshotSource ?? "101", projectId: "test", id: "301", name: "home-snapshot", sizeGb: 10 },
    bootDisk: { source: "projects/test/zones/us-central1-b/disks/old-boot", id: "302" },
    targetGatewayId: gatewayId, leaseId: "restored-demand", generation: 2, restoredInstanceId: "201", restoredDisk: disk };
  const { retainedBoot } = options;
  const oldDiskRecord = { ...disk, id: retirement.homeDiskId, source: oldDisk };
  const boot = { homeAdmission: true as const, homeId: retirement.homeDiskId, name: "qualified-builder", id: "409", project: "test",
    operationId: retainedBoot === "historical" ? `boot-${source}-200-409` : "replaced-boot",
    previous: { id: "408", name: "previous-qualified" }, sourceComputer: {
      name: retirement.instanceName, zone, gatewayId: source, instanceId: retainedBoot === "legacy" ? retirement.instanceId : "200",
    },
    ...(retainedBoot && retainedBoot !== "legacy" && retainedBoot !== "historical" ? { nativeSchedulerRetirement: retainedBoot === "multiple"
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
      id: returnOperationId, kind: "migrate-user", status: "succeeded", cutoverCommittedAt: 9, completedAt: 11, inputUid: uid,
      output: { nativeSourcePark: { parked: "suspended" } },
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
    readBootImage: vi.fn(async () => ({ id: boot.id, name: boot.name })), readImage: vi.fn(async () => boot), verifyBootReplacement: vi.fn(async () => true) };
  const scheduler = vi.fn(async () => ({ operationId: migrationId, phase: "retire" as const, agentIds: ["alice"], drained: options.schedulerDrained ?? true }));
  const run = () => retireNativeSchedulerBeforeStage({ store, vm, log: vi.fn() }, {
    uid, slug, gatewayId, operationId, claimedStartedAt: 20,
  }, scheduler);
  return { run, store, vm, scheduler, boot, oldDiskRecord };
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

function completedPrewarm(from: string, to: string, bootImageId: string, startedAt: number): OperationRecord {
  const verifiedAt = startedAt + 1;
  return {
    id: `ship-${from}-${to}`, kind: "prewarm-gateway", status: "succeeded", gatewayId: source, inputUid: uid,
    createdBy: "operator", createdAt: startedAt - 1, startedAt, firstStartedAt: startedAt, completedAt: startedAt + 2,
    input: { uid, gatewayId: source, generation: 1, bootImageId, sourceSha: "a".repeat(40) },
    steps: [{ name: "verify-prewarmed-computer", status: "done", completedAt: verifiedAt, detail: `instance=${to} bootImage=${bootImageId}` }],
    output: { prewarmState: "parked", previousInstanceId: from, instanceId: to, bootImageId },
  };
}

async function historicalFixture(mismatch?: string, attachedDisk?: string) {
  const h = fixture({ retainedBoot: "historical", attachedDisk });
  const first = completedPrewarm("100", "200", "408", 12);
  const last = completedPrewarm("200", "201", "409", 16);
  if (mismatch !== "missing") await h.store.journal.operations.create(first);
  if (mismatch === "ambiguous") await h.store.journal.operations.create(completedPrewarm("100", "400", "419", 12));
  if (mismatch === "foreign") last.input.uid = "other-owner";
  if (mismatch === "generation") last.input.generation = 2;
  if (mismatch === "time") last.startedAt = 10;
  if (mismatch === "image") last.input.bootImageId = "123";
  if (mismatch === "unfinished") last.status = "running";
  if (mismatch !== "empty") await h.store.journal.operations.create(last);
  else await h.store.journal.operations.patch(first.id, { status: "failed" });
  return h;
}

describe("adopt independently verified historical scheduler lineage", () => {
  it("uses the untouched home only after verifying the full parked chain and prior native receipt", async () => {
    const h = await historicalFixture();
    await h.run();
    expect(h.scheduler).toHaveBeenCalledExactlyOnceWith({ migrationId, gatewayId, slug, phase: "retire" });
    expect((await h.store.users.records.get(uid))?.fences.pendingNativeSchedulerRetirement).toBeUndefined();
  });

  it("uses provider-confirmed replacement after a prewarm retry loses its parked receipt", async () => {
    const h = await historicalFixture();
    await h.store.journal.operations.patch("ship-200-201", {
      startedAt: 19, completedAt: 20,
      steps: [], output: { prewarmState: "ineligible" },
    });
    await h.run();
    expect(h.vm.verifyBootReplacement).toHaveBeenCalledTimes(2);
    expect(h.vm.verifyBootReplacement).toHaveBeenCalledWith({
      instanceName: retirement.instanceName, zone, previousInstanceId: "200", instanceId: "201",
      startedAt: 16, endedAt: 19,
    });
    expect(h.scheduler).toHaveBeenCalledOnce();
  });

  it("preserves the original scheduler hold if provider replacement is absent", async () => {
    const h = await historicalFixture();
    await h.store.journal.operations.patch("ship-200-201", {
      startedAt: 19, completedAt: 20,
      steps: [], output: { prewarmState: "ineligible" },
    });
    h.vm.verifyBootReplacement.mockResolvedValue(false);
    await expect(h.run()).rejects.toThrow(/authority changed/);
    expect(h.scheduler).not.toHaveBeenCalled();
    expect((await h.store.users.records.get(uid))?.fences.pendingNativeSchedulerRetirement).toEqual(retirement);
  });

  it.each(["missing", "ambiguous", "foreign", "generation", "time", "image", "unfinished", "empty"])(
    "refuses %s historical evidence before native authority changes", async mismatch => {
      const h = await historicalFixture(mismatch);
      await expect(h.run()).rejects.toThrow(/authority changed/);
      expect(h.scheduler).not.toHaveBeenCalled();
      expect((await h.store.users.records.get(uid))?.fences.pendingNativeSchedulerRetirement).toEqual(retirement);
    },
  );

  it("does not call native retirement when a proven history leads to another attached disk", async () => {
    const h = await historicalFixture(undefined, "808");
    await expect(h.run()).rejects.toThrow(/home\/image identity changed/);
    expect(h.scheduler).not.toHaveBeenCalled();
  });

  it("refuses when the current physical boot does not use the proven immutable image", async () => {
    const h = await historicalFixture();
    h.vm.readBootImage.mockResolvedValueOnce({ id: "502", name: "foreign-builder" });
    await expect(h.run()).rejects.toThrow(/home\/image identity changed/);
    expect(h.scheduler).not.toHaveBeenCalled();
  });

  it("keeps the pending historical receipt when the original native migration will not acknowledge retirement", async () => {
    const h = await historicalFixture();
    h.scheduler.mockResolvedValueOnce({ operationId: migrationId, phase: "retire", agentIds: ["alice"], drained: false });
    await expect(h.run()).rejects.toThrow(/acknowledgement changed/);
    expect((await h.store.users.records.get(uid))?.fences.pendingNativeSchedulerRetirement).toEqual(retirement);
  });

  it("carries a proven historical receipt into a new selection without granting archive authority", async () => {
    const h = await historicalFixture();
    await h.store.users.records.setActivationLease(uid, { status: "provisioning", generation: 2,
      leaseId: "restored-demand", targetGatewayId: gatewayId }, { leaseId: "restored-demand", generation: 2 });
    const next = { id: "410", name: "next-qualified", homeAdmission: true } as const;
    const spec: GatewayVmSpec = { zones: [zone], desktop: "x11", imageFamily: "boot-family", imageProject: "test",
      diskSizeGb: 80, bootDiskType: "pd-balanced", homeDiskSizeGb: 10, machineType: "e2-medium", provisioningModel: "STANDARD",
      serviceAccountEmail: "fixture@example.invalid", subnetwork: "fixture" };
    const result = await selectRetainedBootImage({ store: h.store,
      vm: { ...h.vm, readFamilyImage: vi.fn(async () => next) }, ownerUid: uid, home: h.oldDiskRecord, spec,
      previous: { id: h.boot.id, name: h.boot.name }, operationId: `boot-${gatewayId}-201-410`,
      sourceComputer: { instanceId: "201", zone, name: retirement.instanceName, gatewayId },
    });
    expect(result).toMatchObject({ legacySchedulerRetirement: retirement, sourceComputer: { instanceId: "201" } });
    const owner = (await h.store.users.records.get(uid))!;
    expect(() => archivedSchedulerSourceImage(owner, gatewayId, "202", retirement)).toThrow(/scheduler replacement lineage/);

    const runtime = (await h.store.fleetRegistry.get(gatewayId))!;
    await h.store.fleetRegistry.patch(gatewayId, { vm: { ...runtime.vm!, instanceId: "202" } });
    const current = await h.vm.describe();
    h.vm.describe.mockResolvedValue({ ...current, instanceId: "202" });
    h.vm.readBootImage.mockResolvedValue({ id: next.id, name: next.name });
    h.vm.readImage.mockResolvedValue({ ...h.boot, id: next.id, name: next.name });
    await h.run();
    expect(h.scheduler).toHaveBeenCalledExactlyOnceWith({ migrationId, gatewayId, slug, phase: "retire" });
  });
});
