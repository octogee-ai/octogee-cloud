import { describe, it, expect } from "vitest";
import {
  projectGatewaySummary,
  resolveFleetNamespace,
} from "../lib/admin-fleet-router.js";

function gatewayDoc(id: string, data: Record<string, unknown> = {}) {
  return {
    id,
    data: () => ({ gatewayId: id, status: "ready", mountedCustomers: [], ...data }),
  };
}

describe("projectGatewaySummary — gatewayId", () => {
  const now = 1_750_000_000_000;

  it("surfaces the bare gatewayId from the status doc", () => {
    const summary = projectGatewaySummary(
      gatewayDoc("walter"),
      [],
      { profile: "isolated" },
      now,
    );
    expect(summary.gatewayId).toBe("walter");
  });

  it("falls back to the doc id when the status doc omits gatewayId", () => {
    const summary = projectGatewaySummary(
      { id: "default", data: () => ({ status: "ready", mountedCustomers: [] }) },
      [],
      undefined,
      now,
    );
    expect(summary.gatewayId).toBe("default");
  });
});

describe("projectGatewaySummary — desired gateway metadata", () => {
  const now = 1_750_000_000_000;

  it("derives OpenClaw from the fleet controller image tag when the heartbeat has not learned it yet", () => {
    const summary = projectGatewaySummary(
      gatewayDoc("walter", {
        version: "5b287cb",
        openclawVersion: "unknown",
      }),
      { imageTag: "5b287cb-oc2026.6.10", desiredStatus: "running" },
      now,
    );

    expect(summary.imageTag).toBe("5b287cb");
    expect(summary.openclawVersion).toBe("2026.6.10");
  });

  it("projects a requested gateway before its heartbeat status doc exists", () => {
    const summary = projectGatewaySummary(
      { id: "canary", data: () => ({ gatewayId: "canary" }) },
      { imageTag: "8507a63-oc2026.6.10", desiredStatus: "running" },
      now,
    );

    expect(summary.status).toBe("booting");
    expect(summary.desiredStatus).toBe("running");
    expect(summary.imageTag).toBe("8507a63-oc2026.6.10");
    expect(summary.openclawVersion).toBe("2026.6.10");
    expect(summary.heartbeatAgeMs).toBeNull();
  });
});

describe("projectGatewaySummary — lastError (restoreJobs retired: no jobId)", () => {
  const now = 1_750_000_000_000;

  it("projects slug/message/at and drops the legacy jobId field", () => {
    const summary = projectGatewaySummary(
      gatewayDoc("default", {
        lastError: { jobId: "legacy-job", slug: "frodo", message: "git clone timeout", at: null },
      }),
      undefined,
      now,
    );
    expect(summary.lastError).toEqual({ slug: "frodo", message: "git clone timeout", at: null });
    expect(summary.lastError).not.toHaveProperty("jobId");
  });

  it("projects a null lastError as null", () => {
    const summary = projectGatewaySummary(gatewayDoc("default"), undefined, now);
    expect(summary.lastError).toBeNull();
  });
});

describe("resolveFleetNamespace", () => {
  it("returns K8S_NAMESPACE when set (the env the fleet lives in)", () => {
    expect(resolveFleetNamespace({ K8S_NAMESPACE: "shared-test" })).toBe("shared-test");
    expect(resolveFleetNamespace({ K8S_NAMESPACE: "octogee" })).toBe("octogee");
  });

  it("defaults to the prod namespace when unset or empty", () => {
    expect(resolveFleetNamespace({})).toBe("octogee");
    expect(resolveFleetNamespace({ K8S_NAMESPACE: "" })).toBe("octogee");
  });
});
