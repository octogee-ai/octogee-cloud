import { describe, expect, it, vi } from "vitest";
import { bootRepairedParkedGateway, finishParkedGatewayPrewarm, startParkedGatewayPrewarm } from "@octogee/core/isolated-gateway-lifecycle";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { Operation } from "@octogee/shared/types/glm";
import { createParkedPrewarmHandler } from "../handlers/parked-prewarm.js";
import type { VmGatewayRuntime } from "../vm-gateway-runtime.js";

vi.mock("@octogee/core/isolated-gateway-lifecycle", async (original) => ({
  ...await original<typeof import("@octogee/core/isolated-gateway-lifecycle")>(),
  startParkedGatewayPrewarm: vi.fn(),
  bootRepairedParkedGateway: vi.fn(),
  finishParkedGatewayPrewarm: vi.fn(),
}));

const operation: Operation = {
  id: "prewarm", kind: "prewarm-gateway", status: "running", createdAt: 500, startedAt: 600, completedAt: null, createdBy: "test",
  input: { uid: "alice", gatewayId: "builder-alice", generation: 5, bootImageId: "123", sourceSha: "a".repeat(40),
    payload: { imageRepository: "registry/images/octogee-gateway", imageTag: `abc1234@sha256:${"a".repeat(64)}` } },
  steps: [],
};
const claim = { release: 2, previousRelease: 1, previousInstanceId: "987", sourceGatewayId: "shared", sourceAssignmentEpoch: 4 };

function fixture(now = () => 625) {
  const listeners = new Map<string, (event: { kind: "resync"; reason: "notification-gap" }) => void>();
  const close = vi.fn(async () => undefined);
  const notify = (aggregate: string) => listeners.get(aggregate)?.({ kind: "resync", reason: "notification-gap" });
  const root = { gatewayClass: "isolated", ownerUid: "alice", desiredStatus: "running", desiredRelease: 2, liveRelease: 2, allocation: { generation: 5 } };
  const registry = { runtime: "gce-vm", release: 2, vm: { status: "SUSPENDED", instanceId: "987" } as { status: string; instanceId: string } | null, vmBootRecovery: {} };
  const owner = { gateway: { gatewayId: "shared" }, activationLease: { status: "parked" } };
  const readRegistry = vi.fn(async () => registry);
  let persisted = operation;
  const store = {
    watch: (request: { aggregate: string }, listener: { onEvent: (event: { kind: "resync"; reason: "notification-gap" }) => void }) => {
      listeners.set(request.aggregate, listener.onEvent);
      return { close };
    },
    gateways: { roots: { get: async () => root }, assignments: { get: async () => ({ state: "serving", epoch: 4 }) } },
    fleetRegistry: { get: readRegistry },
    users: { records: { get: async () => owner } },
    journal: { operations: { get: async () => persisted } },
  } as unknown as PlatformStateStore;
  const observe = vi.fn(async () => {
    const vm = registry.vm;
    if (!vm) return null;
    return { ...vm, bootImageId: vm.instanceId === "987" ? "100" : "123", recoveryReady: true };
  });
  const bootImage = vi.fn(async () => "123");
  const runtime = {
    prewarmBootImageId: bootImage,
    prewarmVmObservation: observe,
  } as unknown as VmGatewayRuntime;
  const probeReady = vi.fn(async () => true);
  const reportStep = vi.fn(async () => undefined);
  const requestReconcileTick = vi.fn();
  vi.mocked(startParkedGatewayPrewarm).mockReset().mockResolvedValue({ state: "booting", claim });
  vi.mocked(finishParkedGatewayPrewarm).mockReset().mockImplementation(async () => {
    root.desiredStatus = "paused";
    return "parked";
  });
  const handler = createParkedPrewarmHandler({ store, readVmRuntime: () => runtime, requestReconcileTick, probeReady, now });
  return {
    run: (op = operation) => handler(op, { reportStep }),
    bootImage, observe, probeReady, reportStep, notify, close, root, registry, owner, readRegistry,
    persistRepair: () => { persisted = { ...operation, output: { prewarmState: "repairing", previousBootImageId: "100", repairStartedAt: 625 } }; },
    clearVm: () => { registry.vm = null; notify("fleetRegistry"); },
    runVm: (instanceId = "998") => { registry.vm = { status: "RUNNING", instanceId }; notify("fleetRegistry"); },
    suspendVm: () => { registry.vm = { ...registry.vm!, status: "SUSPENDED" }; notify("fleetRegistry"); },
  };
}

describe("parked prewarm operation", () => {
  it("waits for a replacement to be recorded and suspended on retry, then verifies its readiness", async () => {
    const h = fixture();
    h.root.desiredStatus = "paused";
    h.clearVm();
    vi.mocked(startParkedGatewayPrewarm).mockImplementationOnce(async () => {
      h.root.desiredStatus = "running";
      return { state: "booting", claim };
    });
    const complete = vi.fn();
    const running = h.run({ ...operation, attempts: 1 });
    void running.then(complete, complete);
    await vi.waitFor(() => expect(h.readRegistry).toHaveBeenCalledOnce());
    expect(complete).not.toHaveBeenCalled();
    expect(startParkedGatewayPrewarm).not.toHaveBeenCalled();

    h.runVm();
    await vi.waitFor(() => expect(h.readRegistry).toHaveBeenCalledTimes(2));
    expect(h.observe).not.toHaveBeenCalled();
    expect(startParkedGatewayPrewarm).not.toHaveBeenCalled();
    h.suspendVm();
    await vi.waitFor(() => expect(startParkedGatewayPrewarm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ attempts: 1 }), 625, {
      instanceId: "998", bootImageId: "123", needsRepair: false,
    }));
    h.probeReady.mockResolvedValueOnce(false);
    h.runVm();
    await vi.waitFor(() => expect(h.probeReady).toHaveBeenCalledWith("builder-alice", "998"));
    expect(complete).not.toHaveBeenCalled();
    expect(h.reportStep).not.toHaveBeenCalled();
    h.notify("fleetRegistry");
    await vi.waitFor(() => expect(h.reportStep).toHaveBeenCalledWith(expect.objectContaining({
      name: "verify-prewarmed-computer", detail: "instance=998 bootImage=123",
    })));
    h.suspendVm();
    await expect(running).resolves.toMatchObject({ success: true, output: { prewarmState: "parked", instanceId: "998", bootImageId: "123" } });
  });

  it("fails the attempt if its replacement never becomes observable", async () => {
    let now = 625;
    const h = fixture(() => now);
    h.root.desiredStatus = "paused";
    h.clearVm();
    const running = h.run({ ...operation, attempts: 1 });
    void running.catch(() => {});
    await vi.waitFor(() => expect(h.readRegistry).toHaveBeenCalled());
    now += 25 * 60_000;
    h.notify("fleetRegistry");
    await expect(running).rejects.toThrow("waiting for the replacement computer to be recorded as suspended");
    expect(startParkedGatewayPrewarm).not.toHaveBeenCalled();
  });

  it("requires readiness proof for the exact instance it reports as parked after resuming", async () => {
    const h = fixture();
    h.root.desiredStatus = "paused";
    h.runVm();
    h.suspendVm();
    vi.mocked(startParkedGatewayPrewarm).mockResolvedValueOnce({ state: "parked", claim });
    await expect(h.run()).rejects.toThrow("without readiness verification for this instance");
  });

  it("retries a parked computer while the previous attempt is still suspending it", async () => {
    const h = fixture();
    h.root.desiredStatus = "paused";
    h.runVm("987");
    await expect(h.run()).rejects.toThrow("still suspending");
    expect(startParkedGatewayPrewarm).not.toHaveBeenCalled();
  });

  it("records a superseded image without waking the computer", async () => {
    const h = fixture();
    h.bootImage.mockResolvedValueOnce("124");
    await expect(h.run()).resolves.toMatchObject({ success: true, output: { prewarmState: "superseded" } });
    expect(h.observe).not.toHaveBeenCalled();
    expect(startParkedGatewayPrewarm).not.toHaveBeenCalled();
  });

  it("releases the claim for retry when shared placement changes during recovery", async () => {
    const h = fixture();
    vi.mocked(startParkedGatewayPrewarm).mockImplementationOnce(async () => {
      h.persistRepair();
      h.owner.gateway.gatewayId = "new-shared";
      return { state: "repairing", claim };
    });
    await expect(h.run()).rejects.toThrow("Shared assignment changed");
    expect(finishParkedGatewayPrewarm).toHaveBeenCalledWith(expect.anything(), operation, 625, "rollback");
    expect(bootRepairedParkedGateway).not.toHaveBeenCalled();
  }, 1000);

  it("waits for the instance-bound healthy probe and wakes on suspend publication", async () => {
    const h = fixture();
    h.probeReady.mockResolvedValueOnce(false);
    const running = h.run();
    await vi.waitFor(() => expect(h.observe).toHaveBeenCalledTimes(1));
    expect(h.probeReady).not.toHaveBeenCalled();
    h.runVm();
    await vi.waitFor(() => expect(h.probeReady).toHaveBeenCalledWith("builder-alice", "998"));
    expect(finishParkedGatewayPrewarm).not.toHaveBeenCalled();
    expect(h.observe).toHaveBeenCalledTimes(1);
    h.notify("fleetRegistry");
    await vi.waitFor(() => expect(h.reportStep).toHaveBeenCalledWith({
      name: "verify-prewarmed-computer", status: "done", completedAt: 625, detail: "instance=998 bootImage=123",
    }));
    h.suspendVm();
    await expect(running).resolves.toMatchObject({
      success: true, output: { prewarmState: "parked", instanceId: "998", bootImageId: "123", release: 2 },
    });
    expect(h.close).toHaveBeenCalledTimes(3);
  });

  it("proves recovery on the original boot before park, then verifies replacement under the new boot", async () => {
    const h = fixture();
    h.observe.mockResolvedValueOnce({ status: "SUSPENDED", instanceId: "987", bootImageId: "100", recoveryReady: false });
    h.root.liveRelease = 1;
    h.registry.release = 1;
    vi.mocked(startParkedGatewayPrewarm).mockImplementationOnce(async () => {
      h.persistRepair();
      return { state: "repairing", claim };
    });
    vi.mocked(finishParkedGatewayPrewarm).mockImplementation(async (_store, _operation, _now, mode) => {
      h.root.desiredStatus = "paused";
      return mode === "repaired" ? "repair-parking" : "parked";
    });
    vi.mocked(bootRepairedParkedGateway).mockResolvedValueOnce("booting");
    const running = h.run();
    await vi.waitFor(() => expect(h.observe).toHaveBeenCalledTimes(1));
    h.runVm("987");
    expect(h.probeReady).not.toHaveBeenCalled();
    h.registry.vmBootRecovery = {
      currentPointId: null, retainedPoints: 0, ready: true, bundleVersion: "v1",
      freeBytes: 3 * 1024 ** 3, instanceId: "987", observedAt: 626,
    };
    h.notify("fleetRegistry");
    await vi.waitFor(() => expect(finishParkedGatewayPrewarm).toHaveBeenCalledWith(expect.anything(), operation, 625, "repaired"));
    expect(bootRepairedParkedGateway).not.toHaveBeenCalled();
    h.suspendVm();
    await vi.waitFor(() => expect(bootRepairedParkedGateway).toHaveBeenCalledTimes(1));
    h.root.desiredStatus = "running";
    h.root.liveRelease = 2;
    h.registry.release = 2;
    h.runVm();
    await vi.waitFor(() => expect(h.reportStep).toHaveBeenCalledWith(expect.objectContaining({ name: "verify-prewarmed-computer" })));
    h.suspendVm();
    await expect(running).resolves.toMatchObject({ success: true, output: { prewarmState: "parked", instanceId: "998", bootImageId: "123" } });
    expect(h.probeReady.mock.calls).toEqual([["builder-alice", "987"], ["builder-alice", "998"]]);
  });

  it("rolls back a running computer whose actual boot image differs from the requested image", async () => {
    const h = fixture();
    h.observe.mockResolvedValueOnce({ status: "SUSPENDED", instanceId: "987", bootImageId: "100", recoveryReady: true })
      .mockResolvedValueOnce({ status: "RUNNING", instanceId: "998", bootImageId: "333", recoveryReady: true });
    const rejected = expect(h.run()).rejects.toThrow("other than the requested image");
    await vi.waitFor(() => expect(h.observe).toHaveBeenCalledTimes(1));
    h.runVm();
    await rejected;
    expect(finishParkedGatewayPrewarm).toHaveBeenCalledWith(expect.anything(), operation, 625, "rollback");
    expect(h.reportStep).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledTimes(3);
  });
});
