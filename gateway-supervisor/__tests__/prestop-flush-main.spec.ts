import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { order, report, flush } = vi.hoisted(() => ({
  order: [] as string[],
  report: vi.fn(),
  flush: vi.fn(),
}));

vi.mock("../lib/prestop-marker.js", () => ({
  markPreStopStarted: vi.fn(() => { order.push("mark"); }),
}));

vi.mock("../lib/fleet-broker-client.js", () => ({
  createFleetBrokerClient: () => ({
    recordPreStopFlush: report.mockImplementation(async ({ phase }: { phase: string }) => { order.push(`report ${phase}`); }),
  }),
}));

vi.mock("../lib/gateway-prestop-flush.js", () => ({
  runGatewayPreStopFlush: flush.mockImplementation(async () => {
    order.push("flush");
    return { ok: true, durationMs: 0, steps: [] };
  }),
}));

const { main } = await import("../entrypoints/prestop-flush.js");

beforeEach(() => {
  order.length = 0;
  report.mockClear();
  flush.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("prestop-flush entrypoint", () => {
  it("tells the supervisor the flush started before it reports or releases anything", async () => {
    await main();

    expect(order).toEqual(["mark", "report started", "flush", "report completed"]);
    expect(flush.mock.calls[0]?.[0].syncRuntimeState).toBeUndefined();
  });

  it("runs the anchor checkpoint and bounds broker reports for an ephemeral home", async () => {
    vi.stubEnv("GATEWAY_EPHEMERAL_HOME", "true");
    await main();

    expect(flush.mock.calls[0]?.[0].syncRuntimeState).toEqual(expect.any(Function));
    expect(report.mock.calls.map((call) => call[1])).toEqual([expect.any(AbortSignal), expect.any(AbortSignal)]);
  });
});
