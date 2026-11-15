import { describe, expect, it, vi } from "vitest";
import { bootRecoveryReport } from "../../lib/vm-gateway-agent/boot-recovery.js";
import type { VmAgentDeps } from "../../lib/vm-gateway-agent/agent.js";

const sample = { currentPointId: "image-new-" + "a".repeat(32), retainedPoints: 1, ready: true, bundleVersion: "v1", freeBytes: 3 * 1024 ** 3 };
function fixture() {
  return { gatewayId: "b-x", stateRoot: "/srv/octogee", log: vi.fn(), home: { desktop: { recovery: vi.fn(async () => sample) }, fs: { listDir: vi.fn(async (): Promise<string[]> => []) } }, fs: { diskUsage: vi.fn(async () => ({ freeBytes: sample.freeBytes })) },
    engine: { request: vi.fn(async () => ({ status: 200, body: { State: { Running: true }, Config: { Labels: { "ai.octogee.bundle-version": "v1", "ai.octogee.gateway-id": "b-x" } } } })) },
    fetchImpl: vi.fn(async () => new Response(JSON.stringify({ ready: true, openclawUp: true, brokerProfilesSettled: true, dashboardBridgeReady: true, handoffReleased: true, runtimeStatus: "ready", prelaunchState: "serving" }))) };
}
describe("boot recovery capacity/admission report", () => {
  it("reports host-verified native admission/capacity", async () => {
    const h = fixture();
    expect(await bootRecoveryReport(h as unknown as VmAgentDeps)).toEqual({ bootRecovery: sample });
  });
  it("reports failed native inspection as unready/full instead of preserving an earlier success", async () => {
    const h = fixture();
    h.home.desktop.recovery.mockRejectedValue(new Error("unverified snapshot"));
    expect(await bootRecoveryReport(h as unknown as VmAgentDeps)).toMatchObject({ bootRecovery: { ready: false, retainedPoints: 1000 } });
  });
  it("logs the recovery sample when it changes and stays quiet while it holds", async () => {
    const h = fixture();
    await bootRecoveryReport(h as unknown as VmAgentDeps);
    await bootRecoveryReport(h as unknown as VmAgentDeps);
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith("[vm-agent] boot recovery ready=true retainedPoints=1 freeGiB=3 bundle=v1");
    h.home.desktop.recovery.mockResolvedValue({ ...sample, ready: false, freeBytes: 1024 ** 3 });
    await bootRecoveryReport(h as unknown as VmAgentDeps);
    expect(h.log).toHaveBeenLastCalledWith("[vm-agent] boot recovery ready=false retainedPoints=1 freeGiB=1 bundle=v1");
  });
  it("logs a persistent inspection failure once", async () => {
    const h = fixture();
    h.home.desktop.recovery.mockRejectedValue(new Error("unverified snapshot"));
    await bootRecoveryReport(h as unknown as VmAgentDeps);
    await bootRecoveryReport(h as unknown as VmAgentDeps);
    expect(h.log.mock.calls.filter(([line]) => String(line).includes("unavailable"))).toHaveLength(1);
  });
  it("allows a verified legacy first update only with no existing points and actual native readiness", async () => {
    const h = fixture();
    h.home.desktop.recovery.mockRejectedValue(Object.assign(new Error("unknown action"), { status: 400 }));
    expect(await bootRecoveryReport(h as unknown as VmAgentDeps)).toMatchObject({ bootRecovery: { ready: true, retainedPoints: 0, currentPointId: null } });
    h.home.fs.listDir.mockResolvedValue(["unverified-old-point"]);
    expect(await bootRecoveryReport(h as unknown as VmAgentDeps)).toMatchObject({ bootRecovery: { ready: false, retainedPoints: 1 } });
    h.home.fs.listDir.mockResolvedValue([]);
    h.fetchImpl.mockResolvedValue(new Response(JSON.stringify({ ready: false })));
    expect(await bootRecoveryReport(h as unknown as VmAgentDeps)).toMatchObject({ bootRecovery: { ready: false } });
  });
});
