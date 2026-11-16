import { beforeEach, describe, expect, it, vi } from "vitest";

const order = vi.hoisted(() => [] as string[]);

vi.mock("../lib/prestop-marker.js", () => ({
  markPreStopStarted: vi.fn(() => { order.push("mark"); }),
}));

vi.mock("../lib/fleet-broker-client.js", () => ({
  createFleetBrokerClient: () => ({
    recordPreStopFlush: vi.fn(async ({ phase }: { phase: string }) => { order.push(`report ${phase}`); }),
  }),
}));

vi.mock("../lib/gateway-prestop-flush.js", () => ({
  runGatewayPreStopFlush: vi.fn(async () => {
    order.push("flush");
    return { ok: true, durationMs: 0, steps: [] };
  }),
}));

const { main } = await import("../entrypoints/prestop-flush.js");

beforeEach(() => {
  order.length = 0;
});

describe("prestop-flush entrypoint", () => {
  it("tells the supervisor the flush started before it reports or releases anything", async () => {
    await main();

    expect(order).toEqual(["mark", "report started", "flush", "report completed"]);
  });
});
