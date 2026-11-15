import { describe, expect, it } from "vitest";
import type { FleetRegistryRecord } from "@octogee/core/platform-state";
import { ADMIN_KUBERNETES_OBSERVATION_MAX_AGE_MS, readAdminGatewayKubernetes } from "./admin-kubernetes-observer.js";

const NOW = 10_000_000;

function runtime(kubernetes: unknown): FleetRegistryRecord {
  return { gatewayId: "shared-aaaaaaaaaaaa", kubernetes } as unknown as FleetRegistryRecord;
}

const UNKNOWN = { status: "unknown", totalPods: null, readyPods: null, ageMs: null };

describe("readAdminGatewayKubernetes", () => {
  it("reports a fresh observation with its pod counts and age", () => {
    expect(readAdminGatewayKubernetes(runtime({ status: "not-ready", totalPods: 2, readyPods: 1, observedAt: NOW - 30_000, pods: [] }), NOW)).toEqual({
      kubernetes: { status: "not-ready", totalPods: 2, readyPods: 1, ageMs: 30_000 },
      kubernetesObservedAt: NOW - 30_000,
    });
  });

  it("reports an observation exactly at the maximum age as observed", () => {
    expect(readAdminGatewayKubernetes(runtime({ status: "ready", totalPods: 1, readyPods: 1, observedAt: NOW - ADMIN_KUBERNETES_OBSERVATION_MAX_AGE_MS }), NOW).kubernetes.status)
      .toBe("ready");
  });

  it("reports an observation older than the maximum age as unknown with its age", () => {
    const observedAt = NOW - ADMIN_KUBERNETES_OBSERVATION_MAX_AGE_MS - 1;

    expect(readAdminGatewayKubernetes(runtime({ status: "ready", totalPods: 1, readyPods: 1, observedAt }), NOW)).toEqual({
      kubernetes: { ...UNKNOWN, ageMs: ADMIN_KUBERNETES_OBSERVATION_MAX_AGE_MS + 1 },
      kubernetesObservedAt: observedAt,
    });
  });

  it("allows two observer refresh periods before an observation counts as old", () => {
    expect(ADMIN_KUBERNETES_OBSERVATION_MAX_AGE_MS).toBe(240_000);
  });

  it.each([
    ["no runtime", null],
    ["no observation", runtime(undefined)],
    ["an unrecognised status", runtime({ status: "crashing", totalPods: 1, readyPods: 1, observedAt: NOW })],
    ["a missing observation time", runtime({ status: "ready", totalPods: 1, readyPods: 1 })],
    ["negative pod counts", runtime({ status: "ready", totalPods: -1, readyPods: 1, observedAt: NOW })],
    ["an observation time in the future", runtime({ status: "ready", totalPods: 1, readyPods: 1, observedAt: NOW + 1 })],
  ])("reports %s as unknown without an age", (_case, input) => {
    expect(readAdminGatewayKubernetes(input, NOW)).toEqual({ kubernetes: UNKNOWN, kubernetesObservedAt: null });
  });
});
