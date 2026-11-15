import { describe, it, expect } from "vitest";
import {
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  GATEWAY_UNREACHABLE_AFTER_MS,
} from "@octogee/shared/types/fleet-controller";
import { OPENCLAW_CONTROL_RUNTIME_FRESH_MS } from "@octogee/core/openclaw-control-runtime-ready";
import {
  HEARTBEAT_REFRESH_MS,
  heartbeatReportIsRedundant,
  pollerHeartbeatReport,
  readHeartbeatLiveness,
  readMountedUsers,
} from "../heartbeat-relocation.js";

describe("pollerHeartbeatReport — the poller's live telemetry report", () => {
  const INTERNAL_URL = "http://octogee-gateway-walter.octogee.svc.cluster.local:18789";

  it("reports the polled telemetry with the gateway's internal URL", () => {
    expect(pollerHeartbeatReport(
      { status: "ready", mountedCustomers: ["a", "b"], startedAt: 42 },
      INTERNAL_URL,
    )).toEqual({
      status: "ready",
      mountedCustomers: ["a", "b"],
      startedAt: 42,
      internalUrl: INTERNAL_URL,
    });
  });

  it("writes the configured user report, including an explicit null, only when the poll carried one", () => {
    expect(pollerHeartbeatReport(
      { status: "ready", mountedCustomers: [], configuredBuilder: { state: "claimed", generation: 2 } }, INTERNAL_URL,
    ).configuredBuilder).toEqual({ state: "claimed", generation: 2 });
    expect(pollerHeartbeatReport(
      { status: "ready", mountedCustomers: [], configuredBuilder: null }, INTERNAL_URL,
    )).toHaveProperty("configuredBuilder", null);
    expect(pollerHeartbeatReport({ status: "ready", mountedCustomers: [] }, INTERNAL_URL))
      .not.toHaveProperty("configuredBuilder");
  });

  it("writes the OpenClaw process report, including an explicit null, only when the poll carried one", () => {
    expect(pollerHeartbeatReport(
      { status: "booting", mountedCustomers: [], openclawProcess: { state: "held", migrationId: "mig-1" } }, INTERNAL_URL,
    ).openclawProcess).toEqual({ state: "held", migrationId: "mig-1" });
    expect(pollerHeartbeatReport(
      { status: "ready", mountedCustomers: [], openclawProcess: null }, INTERNAL_URL,
    )).toHaveProperty("openclawProcess", null);
    expect(pollerHeartbeatReport({ status: "ready", mountedCustomers: [] }, INTERNAL_URL))
      .not.toHaveProperty("openclawProcess");
  });

  it("leaves the separately published config marker and the store's heartbeat stamp out of the report", () => {
    const report = pollerHeartbeatReport({ status: "ready", mountedCustomers: [] }, INTERNAL_URL);
    expect(report).not.toHaveProperty("configStatus");
    expect(report).not.toHaveProperty("lastHeartbeatAt");
  });

  it("omits startedAt when the poll did not report it", () => {
    expect(pollerHeartbeatReport({ status: "ready", mountedCustomers: [] }, INTERNAL_URL))
      .not.toHaveProperty("startedAt");
  });

  it("persists the OpenClaw runtime version from trusted pod health", () => {
    expect(
      pollerHeartbeatReport(
        {
          status: "ready",
          mountedCustomers: [],
          openclawVersion: "2026.7.1",
        },
        INTERNAL_URL,
      ),
    ).toMatchObject({ openclawVersion: "2026.7.1" });
  });
});

describe("heartbeatReportIsRedundant — a converged poll writes nothing", () => {
  const NOW = 1_000_000;
  const INTERNAL_URL = "http://octogee-gateway-walter.octogee.svc.cluster.local:18789";
  const REPORTED = {
    status: "ready",
    mountedCustomers: ["ceckert"],
    startedAt: 42,
    version: "abc1234",
    openclawVersion: "2026.7.1",
  };

  function candidate() {
    return pollerHeartbeatReport(REPORTED, INTERNAL_URL);
  }

  function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...REPORTED,
      internalUrl: INTERNAL_URL,
      lastHeartbeatAt: NOW - GATEWAY_HEARTBEAT_INTERVAL_MS,
      ...overrides,
    };
  }

  it("skips the write when every merged field already matches a fresh stored heartbeat", () => {
    expect(heartbeatReportIsRedundant(stored(), candidate(), NOW)).toBe(true);
  });

  it("reads a Firestore Timestamp lastHeartbeatAt for the freshness gate", () => {
    expect(heartbeatReportIsRedundant(
      stored({ lastHeartbeatAt: { toMillis: () => NOW - GATEWAY_HEARTBEAT_INTERVAL_MS } }),
      candidate(),
      NOW,
    )).toBe(true);
  });

  it.each([
    ["status", { status: "degraded" }],
    ["mountedCustomers", { mountedCustomers: ["ceckert", "walter"] }],
    ["startedAt", { startedAt: 41 }],
    ["version", { version: "0000000" }],
    ["openclawVersion", { openclawVersion: "2026.7.0" }],
    ["internalUrl", { internalUrl: "http://elsewhere:18789" }],
  ])("writes when the poll reports a new %s", (_field, drift) => {
    expect(heartbeatReportIsRedundant(stored(drift), candidate(), NOW)).toBe(false);
  });

  it("writes once the stored heartbeat reaches the refresh deadline", () => {
    expect(heartbeatReportIsRedundant(
      stored({ lastHeartbeatAt: NOW - HEARTBEAT_REFRESH_MS }),
      candidate(),
      NOW,
    )).toBe(false);
  });

  it("writes when the stored heartbeat is absent or carries no lastHeartbeatAt", () => {
    expect(heartbeatReportIsRedundant(undefined, candidate(), NOW)).toBe(false);
    expect(heartbeatReportIsRedundant({ status: "ready" }, candidate(), NOW)).toBe(false);
  });

  it("writes when the stored stamp is ahead of the poller clock", () => {
    expect(heartbeatReportIsRedundant(
      stored({ lastHeartbeatAt: NOW + 1 }),
      candidate(),
      NOW,
    )).toBe(false);
  });

  it("ignores stored fields the poller's report never writes", () => {
    expect(heartbeatReportIsRedundant(
      stored({ lastError: { message: "boom", at: 5 } }),
      candidate(),
      NOW,
    )).toBe(true);
  });

  it("never rewrites over the broker-authored configStatus it does not own", () => {
    expect(heartbeatReportIsRedundant(
      stored({
        configStatus: {
          runtimeReady: true,
          openclawVersion: "2026.7.1",
          observedAt: NOW - GATEWAY_HEARTBEAT_INTERVAL_MS,
        },
      }),
      candidate(),
      NOW,
    )).toBe(true);
  });

  it("keeps a full poll interval of headroom under the fleet staleness bound", () => {
    expect(HEARTBEAT_REFRESH_MS + GATEWAY_HEARTBEAT_INTERVAL_MS)
      .toBeLessThan(GATEWAY_UNREACHABLE_AFTER_MS);
  });

  it("refreshes before the OpenClaw dashboard readiness proof can expire", () => {
    expect(HEARTBEAT_REFRESH_MS + GATEWAY_HEARTBEAT_INTERVAL_MS)
      .toBeLessThanOrEqual(OPENCLAW_CONTROL_RUNTIME_FRESH_MS);
  });
});

describe("readHeartbeatLiveness", () => {
  it("reads lastHeartbeatAt and version from runtime telemetry", () => {
    expect(readHeartbeatLiveness({ heartbeat: { lastHeartbeatAt: 1234, version: "abc" } }))
      .toEqual({ lastHeartbeatAt: 1234, version: "abc" });
  });

  it("coerces a Firestore Timestamp heartbeat value", () => {
    expect(readHeartbeatLiveness({ heartbeat: { lastHeartbeatAt: { toMillis: () => 9999 } } }))
      .toEqual({ lastHeartbeatAt: 9999, version: null });
  });

  it("returns null without runtime heartbeat telemetry", () => {
    expect(readHeartbeatLiveness(undefined)).toBeNull();
    expect(readHeartbeatLiveness({ heartbeat: {} })).toBeNull();
  });
});

describe("readMountedUsers", () => {
  it("reads the mounted set from runtime telemetry", () => {
    expect(readMountedUsers({ heartbeat: { mountedCustomers: ["x", "y"] } }))
      .toEqual(["x", "y"]);
  });

  it("returns an empty set without runtime mounted users", () => {
    expect(readMountedUsers(undefined)).toEqual([]);
  });
});
