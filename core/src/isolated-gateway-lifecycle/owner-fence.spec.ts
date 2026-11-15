import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import {
  advanceActivationLease,
  completeActivationLease,
  failActivationLease,
  requestSizingKeyTransition,
} from "./index.js";

vi.mock("../normal-fleet-mutation.js", () => ({
  runNormalFleetMutation: vi.fn(async (_store: unknown, input: { action: () => Promise<unknown> }) => input.action()),
}));

const TARGET = "alice-xs-12345678";

function harness(status: string, gatewayId: string) {
  const docs = new Map<string, Record<string, unknown>>([["users/uid-alice", {
    username: "alice",
    provisioning: { status: "complete", openclaw: { gatewayId, slug: "alice", activationLease: {
      leaseId: "lease-one", generation: 1, status, targetGatewayId: TARGET, builderSlug: "alice", sourceGatewayId: "shared-blue",
      entitlementTier: "hobby", sizingTier: "s", requestedAt: 1, activationOperationId: `builder-activate-${TARGET}-g1`,
    } } },
  }]]);
  const refusal = new Error("placement automation is owned by fleet-controller");
  const deps = {
    store: createDocumentFixtureStore(docs),
    readSizingKey: async () => "hobby",
    now: () => 5_000,
    log: vi.fn(),
    requireOwner: async () => { throw refusal; },
  };
  const before = structuredClone(docs.get("users/uid-alice"));
  return { docs, deps, refusal, before };
}

const lease = { uid: "uid-alice", leaseId: "lease-one", generation: 1 };

describe("isolated lifecycle owner fence", () => {
  it.each([
    ["advance", "activating", "shared-blue", (deps: ReturnType<typeof harness>["deps"]) =>
      advanceActivationLease(deps, { ...lease, fromStatus: "activating", toStatus: "active" })],
    ["complete", "returning", "shared-blue", (deps: ReturnType<typeof harness>["deps"]) =>
      completeActivationLease(deps, { ...lease, targetGatewayId: TARGET })],
    ["fail", "activating", "shared-blue", (deps: ReturnType<typeof harness>["deps"]) =>
      failActivationLease(deps, { ...lease, targetGatewayId: TARGET, operationId: "op", message: "failed" })],
    ["sizing transition", "active", TARGET, (deps: ReturnType<typeof harness>["deps"]) =>
      requestSizingKeyTransition(deps, { ...lease, targetGatewayId: TARGET, sizingKey: "hobby" })],
  ] as const)("refuses %s and writes nothing while another owner holds placement automation", async (_name, status, gatewayId, run) => {
    const h = harness(status, gatewayId);

    await expect(run(h.deps)).rejects.toBe(h.refusal);

    expect(h.docs.get("users/uid-alice")).toEqual(h.before);
    expect([...h.docs.keys()].filter((key) => key.includes("placement_receipts"))).toEqual([]);
  });
});
