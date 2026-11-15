import { describe, it, expect, vi } from "vitest";
import type { UserParkedVm, Operation, GatewayVmState } from "@octogee/shared/types/glm";
import { createGatewayVmHandler, type GatewayVmRecord, type GatewayVmDeps } from "../handlers/gateway-vm";
import type { GatewayVmClient, GatewayVmDescription } from "../lib/compute-vm";

const description: GatewayVmDescription = {
  machineType: "n2-standard-4",
  serviceAccounts: [],
  name: "octogee-computer-test-uida",
  zone: "us-west1-b",
  status: "RUNNING",
  instanceId: "42",
  internalIp: "10.138.0.9",
  provisioningModel: "SPOT",
  gatewayId: "b-mama-3-abc-hobby",
  labels: {},
  metadata: { "gateway-id": "b-mama-3-abc-hobby" },
  lastStartedAt: 7,
};

const vmState: GatewayVmState = {
  instanceName: description.name,
  zone: "us-west1-b",
  instanceId: "42",
  internalIp: "10.138.0.9",
  status: "RUNNING",
  startedAt: 7,
  provisioningModel: "SPOT",
  stopReason: null,
  updatedAt: 1,
};

function op(input: Record<string, unknown>): Operation {
  return { id: "op-1", kind: "gateway-vm", input } as unknown as Operation;
}

function harness(
  record: GatewayVmRecord | null,
  vm: Partial<GatewayVmClient> = {},
  home: { completedAt?: () => number | null; cancelled?: () => boolean; parked?: UserParkedVm | null; replacement?: GatewayVmDeps["replaceStoppedVm"] } = {},
) {
  const unused = (name: string) => vi.fn(() => { throw new Error(`the gateway-vm handler must not call vm.${name}`); });
  const client: GatewayVmClient = {
    expandHome: unused("expandHome"),
    deleteRetainingHome: unused("deleteRetainingHome"),
    setProvisioningModel: unused("setProvisioningModel"),
    suspend: unused("suspend"),
    resume: unused("resume"),
    readBootImage: unused("readBootImage"),
    readFamilyImage: unused("readFamilyImage"),
    readImage: unused("readImage"),
    create: vi.fn(async () => ({ description, provisioningModel: "SPOT" as const, fellBackToStandard: false, alreadyExisted: false })),
    describe: vi.fn(async () => description),
    find: vi.fn(async () => null),
    findByLabels: vi.fn(async () => null),
    list: vi.fn(async () => []),
    bind: vi.fn(async () => {}),
    retainHome: vi.fn(async () => ({ projectId: "octogee-test", zone: "us-west1-b", name: "computer-home", id: "777", sizeGb: 30, diskType: "pd-ssd" as const, source: "projects/octogee-test/zones/us-west1-b/disks/computer-home" })),
    verifyDetachedHome: vi.fn(async () => {}),
    deleteRetainedHome: vi.fn(async () => {}),
    setServiceAccount: vi.fn(async () => {}),
    setMachineType: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => ({ fellBackToStandard: false })),
    delete: vi.fn(async () => true),
    lastPreemptedAt: vi.fn(async () => null),
    ...vm,
  };
  const writeVmState = vi.fn(async () => {});
  const requestHomeCheckpoint = vi.fn(async () => {});
  const clearHomeCheckpointRequest = vi.fn(async () => {});
  const clearVmForReplacement = vi.fn(async () => {});
  const clearParkedVm = vi.fn(async () => {});
  const clock = { now: 1_000 };
  const waits: number[] = [];
  const steps: unknown[] = [];
  const handler = createGatewayVmHandler({
    vm: client,
    replaceStoppedVm: home.replacement,
    readGateway: vi.fn(async () => record),
    writeVmState,
    requestHomeCheckpoint,
    readHomeCheckpointCompletedAt: vi.fn(async () => home.completedAt?.() ?? null),
    clearHomeCheckpointRequest,
    clearVmForReplacement,
    readParkedVm: vi.fn(async () => home.parked ?? null),
    clearParkedVm,
    wait: vi.fn(async (ms: number) => { waits.push(ms); clock.now += ms; }),
    now: () => clock.now,
    log: vi.fn(),
    replaceCheckpointTimeoutMs: 60_000,
    replaceCheckpointPollMs: 10_000,
  });
  const run = (input: Record<string, unknown>) => handler(op(input), {
    reportStep: (s) => { steps.push(s); },
    cancellationRequested: async () => home.cancelled?.() ?? false,
  });
  return { client, writeVmState, requestHomeCheckpoint, clearHomeCheckpointRequest, clearVmForReplacement, clearParkedVm, waits, clock, steps, run };
}

const parkedFresh: UserParkedVm = {
  instanceName: description.name,
  zone: "us-west1-b",
  instanceId: "42",
  gatewayId: "b-old",
  parkedAt: 800,
  checkpoint: { outcome: "fresh", requestedAt: 700, completedAt: 750 },
};
const gceRecord: GatewayVmRecord = { runtime: "gce-vm", vm: null };

describe("gateway-vm handler", () => {
  it("rejects a missing gateway, a bad action, and a cluster-runtime gateway without touching Compute", async () => {
    const missing = harness(null);
    expect(await missing.run({ gatewayId: "b-x", action: "start" })).toMatchObject({ success: false, error: /does not exist/ });

    const cluster = harness({ ...gceRecord, runtime: "cluster", vm: vmState });
    expect(await cluster.run({ gatewayId: "b-x", action: "start" })).toMatchObject({ success: false, error: /runtime is cluster/ });
    expect(cluster.client.start).not.toHaveBeenCalled();

    const bad = harness({ ...gceRecord, vm: vmState });
    expect(await bad.run({ gatewayId: "b-x", action: "reboot" })).toMatchObject({ success: false, error: /action must be one of/ });
    expect(await bad.run({ action: "start" })).toMatchObject({ success: false, error: /missing gatewayId/ });
    expect(bad.client.start).not.toHaveBeenCalled();
    expect(bad.writeVmState).not.toHaveBeenCalled();
  });

  it("has no create action: converge is the only VM creator, so an operator create never reaches Compute", async () => {
    const h = harness(gceRecord);

    const result = await h.run({ gatewayId: "b-mama-3-abc-hobby", action: "create" });

    expect(result).toMatchObject({ success: false, error: "gateway-vm action must be one of stop, start, delete, replace" });
    expect(h.client.create).not.toHaveBeenCalled();
    expect(h.writeVmState).not.toHaveBeenCalled();
    expect(h.steps).toEqual([]);
  });

  it("stop records an operator stop so the fleet controller leaves the VM down; start clears it", async () => {
    const stopped = { ...description, status: "TERMINATED" };
    const h = harness({ ...gceRecord, vm: vmState }, { describe: vi.fn(async () => stopped) });

    const result = await h.run({ gatewayId: "b-mama-3-abc-hobby", action: "stop" });

    expect(result.success).toBe(true);
    expect(h.client.stop).toHaveBeenCalledWith(vmState.instanceName, "us-west1-b");
    expect(h.writeVmState).toHaveBeenCalledWith("b-mama-3-abc-hobby", { ...vmState, status: "TERMINATED", stopReason: "operator", updatedAt: 1_000 });

    const restarted = harness({ ...gceRecord, vm: { ...vmState, status: "TERMINATED", stopReason: "operator" } }, {
      start: vi.fn(async () => ({ fellBackToStandard: true })),
    });
    const started = await restarted.run({ gatewayId: "b-mama-3-abc-hobby", action: "start" });
    expect(started).toMatchObject({ success: true, output: { status: "RUNNING", fellBackToStandard: true } });
    expect(restarted.writeVmState).toHaveBeenCalledWith("b-mama-3-abc-hobby", { ...vmState, updatedAt: 1_000 });

    const none = harness(gceRecord);
    expect(await none.run({ gatewayId: "b-x", action: "start" })).toMatchObject({ success: false, error: /no VM to start/ });
    expect(none.client.start).not.toHaveBeenCalled();
  });

  it("delete clears the VM state even when Compute already lost the instance", async () => {
    const h = harness({ ...gceRecord, vm: vmState }, { delete: vi.fn(async () => false) });

    const result = await h.run({ gatewayId: "b-mama-3-abc-hobby", action: "delete" });

    expect(result).toMatchObject({ success: true, output: { deleted: false } });
    expect(h.writeVmState).toHaveBeenCalledWith("b-mama-3-abc-hobby", null);
  });

  it("routes retained-boot replacement through the operation authority instead of checkpoint/deleting disks", async () => {
    const replacement = vi.fn(async (_gatewayId, _operationId, authority) => { await authority(); return { bootDeleted: true, resumeRequired: true }; });
    const h = harness({ runtime: "gce-vm", vm: vmState }, {}, { replacement });
    expect(await h.run({ gatewayId: "b-x", action: "replace" })).toMatchObject({ success: true, output: { bootDeleted: true } });
    expect(replacement).toHaveBeenCalledWith("b-x", "op-1", expect.any(Function));
    expect(h.client.delete).not.toHaveBeenCalled();
    expect(h.requestHomeCheckpoint).not.toHaveBeenCalled();
  });
  it("routes completed-retired replacement to its owner-anchored provider without recreating runtime", async () => {
    const replacement = vi.fn(async (_gatewayId, _operationId, authority) => { await authority(); return { bootDeleted: true }; });
    const h = harness(null, {}, { parked: parkedFresh, replacement });
    expect(await h.run({ gatewayId: "b-x", action: "replace" })).toMatchObject({ success: true });
    expect(await h.run({ ownerUid: "UidA", action: "replace" })).toMatchObject({ success: true });
    expect(replacement).toHaveBeenCalledTimes(2);
    expect(h.writeVmState).not.toHaveBeenCalled();
    expect(h.requestHomeCheckpoint).not.toHaveBeenCalled();
  });
  it("allows force only for a journaled operator owner request", async () => {
    const replacement = vi.fn(async () => ({ bootDeleted: true }));
    const h = harness(null, {}, { parked: parkedFresh, replacement });
    expect(await h.run({ ownerUid: "UidA", uid: "UidA", action: "replace", force: true })).toMatchObject({ success: false, error: /journaled operator/ });
    expect(replacement).not.toHaveBeenCalled();
    const handler = createGatewayVmHandler({
      ...({} as GatewayVmDeps), readParkedVm: async () => parkedFresh, replaceStoppedVm: replacement,
      now: () => 1,
    });
    const input = { ownerUid: "UidA", uid: "UidA", action: "replace", force: true, expectedGatewayId: "b-old", expectedInstanceId: "42" };
    const operation = { ...op(input), origin: "operator" as const, createdBy: "admin" };
    expect(await handler(operation, { reportStep: () => {} })).toMatchObject({ success: true });
    expect(replacement).toHaveBeenCalledWith("b-old", "op-1", expect.any(Function), { forceOwnerUid: "UidA", expectedInstanceId: "42" });
    replacement.mockClear();
    const changed = { ...operation, input: { ...input, expectedInstanceId: "old-id" } };
    expect(await handler(changed, { reportStep: () => {} })).toMatchObject({ success: false, error: /parked VM changed/ });
    expect(replacement).not.toHaveBeenCalled();
  });
  it("keeps source disks when the replacement operation is cancelled", async () => {
    const deletion = vi.fn();
    const h = harness({ runtime: "gce-vm", vm: vmState }, {}, { cancelled: () => true, replacement: async (_gatewayId, _operationId, authority) => { await authority(); deletion(); return {}; } });
    expect(await h.run({ gatewayId: "b-x", action: "replace" })).toMatchObject({ success: false, error: /cancelled/ });
    expect(deletion).not.toHaveBeenCalled();
  });
  it.each(["RUNNING", "TERMINATED", "STOPPING"])("blocks state-preserving replacement of a %s VM until coverage and fencing are implemented", async (status) => {
    const h = harness({ ...gceRecord, vm: { ...vmState, status } }, {}, { completedAt: () => 5000 });
    expect(await h.run({ gatewayId: "b-x", action: "replace" })).toMatchObject({ success: false, error: /replacement is disabled.*coverage/ });
    expect(h.client.start).not.toHaveBeenCalled();
    expect(h.client.stop).not.toHaveBeenCalled();
    expect(h.client.delete).not.toHaveBeenCalled();
    expect(h.requestHomeCheckpoint).not.toHaveBeenCalled();
    expect(h.clearVmForReplacement).not.toHaveBeenCalled();
  });

  it.each(["fresh", "stale"] as const)("keeps a parked VM with a %s checkpoint and its recovery record", async (outcome) => {
    const h = harness(null, {}, { parked: { ...parkedFresh, checkpoint: { ...parkedFresh.checkpoint, outcome } } });
    expect(await h.run({ ownerUid: "UidA", action: "replace" })).toMatchObject({ success: false, error: /replacement is disabled.*coverage/ });
    expect(h.client.delete).not.toHaveBeenCalled();
    expect(h.clearParkedVm).not.toHaveBeenCalled();
  });

  it("the ownerUid form supports only replace", async () => {
    const h = harness(null, {}, { parked: parkedFresh });
    expect(await h.run({ ownerUid: "UidA", action: "stop" })).toMatchObject({ success: false, error: /ownerUid form supports only replace/ });
    expect(h.client.describe).not.toHaveBeenCalled();
  });

  it("reports a failed step and leaves state untouched when Compute throws", async () => {
    const h = harness({ ...gceRecord, vm: vmState }, { start: vi.fn(async () => { throw new Error("QUOTA_EXCEEDED: cpus"); }) });

    const result = await h.run({ gatewayId: "b-x", action: "start" });

    expect(result).toMatchObject({ success: false, error: "QUOTA_EXCEEDED: cpus" });
    expect(h.steps).toEqual([expect.objectContaining({ name: "vm-start", status: "failed", error: "QUOTA_EXCEEDED: cpus" })]);
    expect(h.writeVmState).not.toHaveBeenCalled();
  });
});
