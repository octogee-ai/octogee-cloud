import { describe, expect, it } from "vitest";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";

import {
  projectGatewayRuntimeStatus,
  projectOwnerActivation,
} from "../lib/gateway-runtime-status.js";

const NOW = 1_800_000_000_000;

function runtimeDoc(overrides: Record<string, unknown> = {}, heartbeat: Record<string, unknown> = {}) {
  return {
    docKind: "runtime",
    gatewayId: "walter",
    release: 2,
    lifecycle: "serving",
    createdAt: 1,
    createdByOperationId: null,
    helm: {},
    heartbeat: {
      status: "ready",
      lastHeartbeatAt: NOW - 1_000,
      version: "abc1234",
      openclawVersion: null,
      internalUrl: null,
      startedAt: 1,
      mountedCustomers: [],
      migratingIn: [],
      ...heartbeat,
    },
    lastError: { message: null, at: null },
    ...overrides,
  };
}

describe("projectGatewayRuntimeStatus", () => {
  it("reports a fresh serving heartbeat status as-is", () => {
    expect(projectGatewayRuntimeStatus(runtimeDoc(), { gatewayId: "walter", now: NOW })).toBe("ready");
    expect(projectGatewayRuntimeStatus(runtimeDoc({}, { status: "booting" }), { gatewayId: "walter", now: NOW })).toBe("booting");
    expect(projectGatewayRuntimeStatus(runtimeDoc({}, { status: "error" }), { gatewayId: "walter", now: NOW })).toBe("error");
  });

  it("turns a stale ready or booting heartbeat into unreachable", () => {
    const stale = NOW - GATEWAY_UNREACHABLE_AFTER_MS - 1;
    expect(projectGatewayRuntimeStatus(runtimeDoc({}, { lastHeartbeatAt: stale }), { gatewayId: "walter", now: NOW })).toBe("unreachable");
    expect(projectGatewayRuntimeStatus(runtimeDoc({}, { status: "booting", lastHeartbeatAt: stale }), { gatewayId: "walter", now: NOW })).toBe("unreachable");
    expect(projectGatewayRuntimeStatus(runtimeDoc({}, { lastHeartbeatAt: null }), { gatewayId: "walter", now: NOW })).toBe("unreachable");
  });

  it("accepts Firestore Timestamp-shaped heartbeat times", () => {
    const fresh = { seconds: Math.floor((NOW - 1_000) / 1_000), nanoseconds: 0 };
    expect(projectGatewayRuntimeStatus(runtimeDoc({}, { lastHeartbeatAt: fresh }), { gatewayId: "walter", now: NOW })).toBe("ready");
    const stale = { toMillis: () => NOW - GATEWAY_UNREACHABLE_AFTER_MS - 1 };
    expect(projectGatewayRuntimeStatus(runtimeDoc({}, { lastHeartbeatAt: stale }), { gatewayId: "walter", now: NOW })).toBe("unreachable");
  });

  it("maps the runtime lifecycle before the pod ever reports", () => {
    expect(projectGatewayRuntimeStatus(runtimeDoc({ lifecycle: "provisioning" }), { gatewayId: "walter", now: NOW })).toBe("booting");
    expect(projectGatewayRuntimeStatus(runtimeDoc({ lifecycle: "failed" }), { gatewayId: "walter", now: NOW })).toBe("error");
  });

  it("is unknown without a runtime doc for this gateway", () => {
    expect(projectGatewayRuntimeStatus(undefined, { gatewayId: "walter", now: NOW })).toBe("unknown");
    expect(projectGatewayRuntimeStatus(runtimeDoc({ gatewayId: "other" }), { gatewayId: "walter", now: NOW })).toBe("unknown");
    expect(projectGatewayRuntimeStatus({ docKind: "runtime", gatewayId: "walter" }, { gatewayId: "walter", now: NOW })).toBe("unknown");
  });
});

describe("projectOwnerActivation", () => {
  it("projects only the lease status and target, never the lease internals", () => {
    expect(projectOwnerActivation({
      leaseId: "lease-1",
      generation: 3,
      status: "activating",
      targetGatewayId: "alice-s-12c32613",
      activationOperationId: "op-9",
      requestedAt: NOW,
    })).toEqual({ status: "activating", targetGatewayId: "alice-s-12c32613" });
  });

  it("projects a lease that has no target yet", () => {
    expect(projectOwnerActivation({ leaseId: "lease-1", generation: 1, status: "requested" }))
      .toEqual({ status: "requested", targetGatewayId: null });
  });

  it("is null without a lease or with a status outside the activation lifecycle", () => {
    expect(projectOwnerActivation(null)).toBeNull();
    expect(projectOwnerActivation({ leaseId: "lease-1", generation: 1, status: "parked", targetGatewayId: "x" })).toBeNull();
  });
});
