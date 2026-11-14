import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FleetRegistryRecord } from "@octogee/core/platform-state";
import { gatewayPodDiagnosticsScope } from "../gateway-kubernetes-observation.js";

describe("gatewayPodDiagnosticsScope", () => {
  it("keeps gce-vm gateways out of the pod scan and reports them as unknown to Kubernetes", () => {
    const runtimes = new Map<string, Pick<FleetRegistryRecord, "runtime">>([
      ["b-vm", { runtime: "gce-vm" }],
      ["b-pod", { runtime: "cluster" }],
    ]);

    const scope = gatewayPodDiagnosticsScope(["b-vm", "b-pod", "shared-1"], runtimes);

    expect(scope.clusterGatewayIds).toEqual(["b-pod", "shared-1"]);
    expect(scope.vmDiagnostics).toEqual({ "b-vm": { status: "unknown", totalPods: 0, readyPods: 0 } });
  });
});

describe("agent VM wiring", () => {
  const indexSource = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");

  it("recovers preempted VMs from the heartbeat poller", () => {
    expect(indexSource).toMatch(/createBackgroundGatewayRecovery\(\s*\(gatewayId\) => runGatewayRuntimeExclusive\(async \(\) => \{ await vmGatewayRuntimeRef\.current\?\.recoverUnreachable\(gatewayId\); \}\)/u);
    expect(indexSource).toMatch(/deleteVm: async \(uid: string\) => \{/u);
  });
});
