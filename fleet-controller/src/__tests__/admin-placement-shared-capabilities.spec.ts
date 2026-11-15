import { describe, expect, it } from "vitest";
import { adminPlacementSharedCapabilities } from "../admin-placement-shared-capabilities.js";
import type { GatewayPodDiagnostics } from "../gateway-kubernetes-observation.js";

const NOW = 1_762_500_000_000;

function capabilitiesReading(diagnostics: GatewayPodDiagnostics) {
  const read: string[] = [];
  const capabilities = adminPlacementSharedCapabilities({
    readGatewayPodDiagnostics: async (gatewayId) => {
      read.push(gatewayId);
      return diagnostics;
    },
    now: () => NOW,
  });
  if (capabilities === undefined) throw new Error("capabilities were not built");
  return { capabilities, read };
}

describe("adminPlacementSharedCapabilities", () => {
  it("is absent without a Kubernetes reader, so the verbs are not mounted", () => {
    expect(adminPlacementSharedCapabilities({})).toBeUndefined();
  });

  it.each([
    ["missing", { status: "ok", totalPods: 0, readyPods: 0 }],
    ["ready", { status: "ok", totalPods: 1, readyPods: 1 }],
    ["not-ready", { status: "ok", totalPods: 1, readyPods: 0 }],
    ["unknown", { status: "ok", totalPods: 0, readyPods: 0, error: "forbidden" }],
  ] as const)("observes %s from the gateway's pods at the time of the read", async (status, diagnostics) => {
    const { capabilities, read } = capabilitiesReading(diagnostics);

    const observation = await capabilities.observeGatewayKubernetes("shared-a");

    expect(observation).toEqual({ status, totalPods: diagnostics.totalPods, readyPods: diagnostics.readyPods, observedAt: NOW });
    expect(read).toEqual(["shared-a"]);
  });

  it("classifies operation failures with the fleet controller's own rules", () => {
    const { capabilities } = capabilitiesReading({ status: "ok", totalPods: 1, readyPods: 1 });

    expect(capabilities.operationFailureIsTransient("status 503 from gateway")).toBe(true);
    expect(capabilities.operationFailureIsTransient("target rejected the workspace")).toBe(false);
    expect(capabilities.gatewayStartupUnavailable("gateway starting; retry shortly")).toBe(true);
    expect(capabilities.gatewayStartupUnavailable("target rejected the workspace")).toBe(false);
    expect(capabilities.platformArtifact).toBeNull();
  });
});
