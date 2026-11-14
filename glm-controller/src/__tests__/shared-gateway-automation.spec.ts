import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { describe, expect, it, vi } from "vitest";
import { createSharedGatewayAutomation } from "../index.js";
import { startSharedGatewayLoop, type SharedGatewayAutomation } from "../shared-gateway-automation.js";
import { JOURNEY_FIRST_BUILD } from "./fixtures/shared-pool-scaler-journey.js";

describe("shared gateway automation hook", () => {
  it("installs nothing without a product and says so", () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    expect(createSharedGatewayAutomation(undefined, createDocumentFixtureStore(new Map()), JOURNEY_FIRST_BUILD)).toBeNull();

    const written = [...info.mock.calls, ...out.mock.calls].map((call) => String(call[0])).join("\n");
    info.mockRestore();
    out.mockRestore();
    expect(written).toContain("shared gateways: platform only");
    expect(written).toContain("no shared gateway is added, retired, replaced or drained automatically");
    expect(written).toContain("no user is placed or moved automatically; place each new user with user assign");
  });

  it("builds the product's automation from the platform store and the platform build", () => {
    const store = createDocumentFixtureStore(new Map());
    const automation: SharedGatewayAutomation = {
      recoverInterruptedAdds: vi.fn(async () => undefined),
      start: vi.fn(() => ({ intervalMs: 1, tick: async () => undefined })),
    };
    const factory = vi.fn(() => automation);

    expect(createSharedGatewayAutomation(factory, store, JOURNEY_FIRST_BUILD)).toBe(automation);
    expect(factory).toHaveBeenCalledWith({ store, platformArtifact: JOURNEY_FIRST_BUILD, log: expect.any(Function) });
  });
});

function retiredOperatorGateway(records: Map<string, Record<string, unknown>>, operationStatus: string): void {
  records.set("gateways/shared-ops", {
    gatewayId: "shared-ops", createdAt: 1, createdBy: "operator-uid", updatedAt: 1, updatedBy: "operator-uid",
    configSchemaVersion: 1, profile: null, gatewayClass: "shared", imageProfile: "standard", sizingTier: null,
    gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null,
    builderAccess: null, ownerUid: null, builderSlug: null, modelBrokerLimits: null, allocation: null,
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "retired",
    retirementClaim: { operationId: "operator-retire-1", version: 1, phase: "claimed" }, retirementVersion: 1,
  });
  records.set("glmOperations/operator-retire-1", {
    kind: "retire-gateway", status: operationStatus, error: operationStatus === "failed" ? "reaped: controller restarted" : null,
    createdBy: "operator-uid", createdAt: 1, input: { gatewayId: "shared-ops", retirementClaimVersion: 1 }, steps: [],
  });
}

describe("startSharedGatewayLoop", () => {
  it("runs a tick at once, skips ticks while one is in flight, and stops", async () => {
    vi.useFakeTimers();
    try {
      let ticks = 0;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const tick = vi.fn(async () => {
        ticks += 1;
        await gate;
      });

      const stop = startSharedGatewayLoop({ store: createDocumentFixtureStore(new Map()), log: vi.fn(), automation: { intervalMs: 1_000, tick } });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(ticks).toBe(1);

      open();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ticks).toBe(2);

      stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ticks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes an operator's shared gateway retirement with no product installed", async () => {
    vi.useFakeTimers();
    try {
      const records = new Map<string, Record<string, unknown>>();
      retiredOperatorGateway(records, "failed");
      const stop = startSharedGatewayLoop({ store: createDocumentFixtureStore(records), log: vi.fn(), automation: null });

      await vi.advanceTimersByTimeAsync(0);
      expect(records.get("glmOperations/operator-retire-1")?.status).toBe("pending");

      records.set("glmOperations/operator-retire-1", { ...records.get("glmOperations/operator-retire-1")!, status: "succeeded" });
      await vi.advanceTimersByTimeAsync(30_000);
      stop();

      expect(records.has("gateways/shared-ops")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps before the product's tick and skips that tick when the sweep fails", async () => {
    vi.useFakeTimers();
    try {
      const records = new Map<string, Record<string, unknown>>();
      retiredOperatorGateway(records, "succeeded");
      const seen: boolean[] = [];
      const tick = vi.fn(async () => {
        seen.push(records.has("gateways/shared-ops"));
      });
      const stop = startSharedGatewayLoop({ store: createDocumentFixtureStore(records), log: vi.fn(), automation: { intervalMs: 1_000, tick } });
      await vi.advanceTimersByTimeAsync(0);
      stop();
      expect(seen).toEqual([false]);

      const failing = createDocumentFixtureStore(new Map());
      const log = vi.fn();
      const skipped = vi.fn(async () => undefined);
      vi.spyOn(failing.gateways.roots, "list").mockRejectedValue(new Error("store unreachable"));
      const stopFailing = startSharedGatewayLoop({ store: failing, log, automation: { intervalMs: 1_000, tick: skipped } });
      await vi.advanceTimersByTimeAsync(0);
      stopFailing();
      expect(skipped).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[shared-pool-scaler] blocked closed: store unreachable");
    } finally {
      vi.useRealTimers();
    }
  });
});
