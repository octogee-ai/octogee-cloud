import { describe, expect, it, vi } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { readFleetLiveKeyHolders, readLiveGatewayKeyHolders } from "../gitea-gateway-key-gc.js";
import type { GatewayPodDiagnostics } from "../lib/kube-ops.js";

function diagnostics(podNames: string[], status: GatewayPodDiagnostics["status"] = "ready"): GatewayPodDiagnostics {
  return {
    status,
    totalPods: podNames.length,
    readyPods: podNames.length,
    totalRestarts: 0,
    spotPods: 0,
    onDemandPods: 0,
    unknownCapacityPods: podNames.length,
    pods: podNames.map((name) => ({
      name,
      gatewayId: null,
      deleting: false,
      gatewayContainerStartedAt: null,
      uid: null,
      replicaSetUid: null,
      phase: "Running",
      readyContainers: 1,
      totalContainers: 1,
      restarts: 0,
      reason: null,
      nodeName: null,
      instanceId: null,
      nodePool: null,
      capacityType: null,
      ageMs: null,
    })),
  };
}

function root(gatewayId: string) {
  return { gatewayId };
}

function runtime(gatewayId: string, vm: { instanceId: string } | null = null) {
  return { gatewayId, vm } as never;
}

describe("readLiveGatewayKeyHolders", () => {
  it("names every existing gateway pod and every recorded VM VM as a live key owner", async () => {
    const readBatch = vi.fn(async (gatewayIds: readonly string[]) =>
      Object.fromEntries(gatewayIds.map((id) => [
        id,
        id === "shared-0"
          ? diagnostics(["octogee-gateway-shared-0-a-1", "octogee-gateway-shared-0-b-2"])
          : diagnostics([], "missing"),
      ])));

    const { owners } = await readLiveGatewayKeyHolders({
      gateways: [root("shared-0"), root("builder-jack")],
      fleetRegistry: [
        runtime("shared-0"),
        runtime("builder-jack", { instanceId: "123456789" }),
      ],
      readGatewayPodDiagnosticsBatch: readBatch,
    });

    expect(readBatch).toHaveBeenCalledWith(["builder-jack", "shared-0"]);
    expect([...owners].sort()).toEqual([
      "builder-jack/octogee-gateway-builder-jack-vm-123456789",
      "shared-0/octogee-gateway-shared-0-a-1",
      "shared-0/octogee-gateway-shared-0-b-2",
    ]);
  });

  it("fails closed when a direct read meets a revision runtime document named for another gateway", async () => {
    const store = createDocumentFixtureStore({
      "gateways/shared-0": { gatewayId: "shared-0", desiredRelease: 1, latestRelease: 1, desiredStatus: "running" },
      "glmGateways/shared-0-r3": { docKind: "runtime", gatewayId: "shared-0", release: 1, lifecycle: "serving" },
    });
    const readBatch = vi.fn(async () => ({}));

    await expect(readFleetLiveKeyHolders({
      informer: { gateways: () => null, fleetRegistry: () => null },
      store,
      readGatewayPodDiagnosticsBatch: readBatch,
    })).rejects.toBeInstanceOf(MalformedRecordError);
    expect(readBatch).not.toHaveBeenCalled();
  });

  it("reads key holders from the fresh mirrors without a direct read", async () => {
    const store = createDocumentFixtureStore({});
    const list = vi.spyOn(store.fleetRegistry, "list");
    const { owners } = await readFleetLiveKeyHolders({
      informer: {
        gateways: () => [root("builder-jack")] as never,
        fleetRegistry: () => [runtime("builder-jack", { instanceId: "123456789" })],
      },
      store,
      readGatewayPodDiagnosticsBatch: async (gatewayIds) =>
        Object.fromEntries(gatewayIds.map((id) => [id, diagnostics([], "missing")])),
    });

    expect([...owners]).toEqual(["builder-jack/octogee-gateway-builder-jack-vm-123456789"]);
    expect(list).not.toHaveBeenCalled();
  });

  it("fails closed when any gateway's pods cannot be observed", async () => {
    await expect(readLiveGatewayKeyHolders({
      gateways: [root("shared-0")],
      fleetRegistry: [],
      readGatewayPodDiagnosticsBatch: async () => ({
        "shared-0": { ...diagnostics([], "unknown"), error: "pods not found" },
      }),
    })).rejects.toThrow(/shared-0.*pods not found/);
  });
});
