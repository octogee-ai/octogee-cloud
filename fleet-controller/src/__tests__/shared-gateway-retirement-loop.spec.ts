import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { describe, expect, it, vi } from "vitest";
import { startSharedGatewayRetirementLoop } from "../shared-gateway-retirement-loop.js";

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

describe("startSharedGatewayRetirementLoop", () => {
  it("finishes an operator's shared gateway retirement", async () => {
    vi.useFakeTimers();
    try {
      const records = new Map<string, Record<string, unknown>>();
      retiredOperatorGateway(records, "failed");
      const stop = startSharedGatewayRetirementLoop({ store: createDocumentFixtureStore(records), log: vi.fn() });

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

  it("logs a failed sweep and sweeps again on the next interval", async () => {
    vi.useFakeTimers();
    try {
      const store = createDocumentFixtureStore(new Map());
      const log = vi.fn();
      const list = vi.spyOn(store.gateways.roots, "list").mockRejectedValueOnce(new Error("store unreachable"));
      const stop = startSharedGatewayRetirementLoop({ store, log });
      await vi.advanceTimersByTimeAsync(30_000);
      stop();
      expect(log).toHaveBeenCalledWith("[glm-controller] ⚠ shared gateway retirement sweep failed: store unreachable");
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
