import { describe, expect, it, vi } from "vitest";
import { finishParkedGatewayPrewarm, startParkedGatewayPrewarm } from "@octogee/core/isolated-gateway-lifecycle";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { Operation } from "@octogee/shared/types/glm";
import { createParkedPrewarmHandler } from "../handlers/parked-prewarm.js";
import type { VmGatewayRuntime } from "../vm-gateway-runtime.js";

vi.mock("@octogee/core/isolated-gateway-lifecycle", async (original) => ({
  ...await original<typeof import("@octogee/core/isolated-gateway-lifecycle")>(),
  startParkedGatewayPrewarm: vi.fn(),
  finishParkedGatewayPrewarm: vi.fn(),
}));

const operation: Operation = {
  id: "prewarm", kind: "prewarm-gateway", status: "running", createdAt: 500, startedAt: 600, completedAt: null, createdBy: "test",
  input: { uid: "alice", gatewayId: "builder-alice", generation: 5, bootImageId: "123", sourceSha: "a".repeat(40),
    payload: { imageRepository: "registry/images/octogee-gateway", imageTag: `abc1234@sha256:${"a".repeat(64)}` } },
  steps: [],
};
const claim = { release: 2, previousRelease: 1, previousInstanceId: "987", sourceGatewayId: "shared", sourceAssignmentEpoch: 4 };

function fixture() {
  const listeners = new Map<string, (event: { kind: "resync"; reason: "notification-gap" }) => void>();
  const close = vi.fn(async () => undefined);
  const notify = (aggregate: string) => listeners.get(aggregate)?.({ kind: "resync", reason: "notification-gap" });
  const root = { desiredStatus: "running", liveRelease: 2, allocation: { generation: 5 } };
  const registry = { release: 2, vm: { status: "SUSPENDED", instanceId: "987" } };
  const store = {
    watch: (request: { aggregate: string }, listener: { onEvent: (event: { kind: "resync"; reason: "notification-gap" }) => void }) => {
      listeners.set(request.aggregate, listener.onEvent);
      return { close };
    },
    gateways: { roots: { get: async () => root } },
    fleetRegistry: { get: async () => registry },
    users: { records: { get: async () => ({ gateway: { gatewayId: "shared" }, activationLease: { status: "parked" } }) } },
    journal: { operations: { get: async () => operation } },
  } as unknown as PlatformStateStore;
  const observe = vi.fn(async () => ({
    status: registry.vm.status,
    instanceId: registry.vm.instanceId,
    bootImageId: registry.vm.instanceId === "987" ? "100" : "123",
  }));
  const runtime = {
    prewarmBootImageId: async () => "123",
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
  const handler = createParkedPrewarmHandler({ store, readVmRuntime: () => runtime, requestReconcileTick, probeReady, now: () => 625 });
  return {
    run: () => handler(operation, { reportStep }),
    observe, probeReady, reportStep, notify, close,
    runVm: () => { registry.vm = { status: "RUNNING", instanceId: "998" }; notify("fleetRegistry"); },
    suspendVm: () => { registry.vm.status = "SUSPENDED"; notify("fleetRegistry"); },
  };
}

describe("parked prewarm operation", () => {
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

  it("rolls back a running computer whose actual boot image differs from the requested image", async () => {
    const h = fixture();
    h.observe.mockResolvedValueOnce({ status: "SUSPENDED", instanceId: "987", bootImageId: "100" })
      .mockResolvedValueOnce({ status: "RUNNING", instanceId: "998", bootImageId: "333" });
    const rejected = expect(h.run()).rejects.toThrow("other than the requested image");
    await vi.waitFor(() => expect(h.observe).toHaveBeenCalledTimes(1));
    h.runVm();
    await rejected;
    expect(finishParkedGatewayPrewarm).toHaveBeenCalledWith(expect.anything(), operation, 625, "rollback");
    expect(h.reportStep).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledTimes(3);
  });
});
