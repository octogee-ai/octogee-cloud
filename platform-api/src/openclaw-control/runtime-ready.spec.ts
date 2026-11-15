import { describe, expect, it } from "vitest";

import {
  OPENCLAW_CONTROL_RUNTIME_FRESH_MS,
  isOpenClawControlRevisionRuntimeReady,
} from "./runtime-ready.js";

interface RevisionFixture {
  docKind: string;
  gatewayId: string;
  lifecycle: string;
  heartbeat: {
    status: string;
    lastHeartbeatAt: unknown;
    configStatus: {
      runtimeReady: boolean;
      runtimeHealth: string;
      runtimeHealthCheckedAt: unknown;
      observedAt: unknown;
      openclawVersion: string;
      openclawForkSha: string;
      dashboardControlState: string;
      dashboardControlProtocol: { protocol: string; version: number };
      dashboardControlObservedAt: unknown;
    };
  };
}

function revision(now: number): RevisionFixture {
  return {
    docKind: "runtime",
    gatewayId: "walter",
    lifecycle: "serving",
    heartbeat: {
      status: "ready",
      lastHeartbeatAt: { seconds: Math.floor((now - 1_000) / 1_000), nanoseconds: 0 },
      configStatus: {
        runtimeReady: true,
        runtimeHealth: "healthy",
        runtimeHealthCheckedAt: new Date(now - 500).toISOString(),
        observedAt: { toMillis: () => now - 250 },
        openclawVersion: "main",
        openclawForkSha: "current",
        dashboardControlState: "ready",
        dashboardControlProtocol: { protocol: "openclaw-dashboard-bridge", version: 1 },
        dashboardControlObservedAt: new Date(now - 100).toISOString(),
      },
    },
  };
}

describe("OpenClaw Dashboard revision runtime gate", () => {
  it("accepts a serving gateway with fresh runtime health and Dashboard proof", () => {
    const now = Date.UTC(2026, 6, 14, 20);
    expect(isOpenClawControlRevisionRuntimeReady(revision(now), {
      gatewayId: "walter",
      revisionId: "walter",
      now,
    })).toBe(true);
  });

  it("rejects stale or incomplete runtime proof", () => {
    const now = Date.UTC(2026, 6, 14, 20);
    for (const mutate of [
      (value: RevisionFixture) => { value.heartbeat.lastHeartbeatAt = now - OPENCLAW_CONTROL_RUNTIME_FRESH_MS - 1; },
      (value: RevisionFixture) => { value.heartbeat.configStatus.observedAt = now - OPENCLAW_CONTROL_RUNTIME_FRESH_MS - 1; },
      (value: RevisionFixture) => { value.heartbeat.configStatus.runtimeHealthCheckedAt = new Date(now - OPENCLAW_CONTROL_RUNTIME_FRESH_MS - 1).toISOString(); },
      (value: RevisionFixture) => { value.heartbeat.configStatus.runtimeReady = false; },
      (value: RevisionFixture) => { value.heartbeat.configStatus.runtimeHealth = "unhealthy"; },
      (value: RevisionFixture) => { value.heartbeat.configStatus.runtimeHealth = "repair"; },
      (value: RevisionFixture) => { value.heartbeat.configStatus.dashboardControlState = "stale"; },
      (value: RevisionFixture) => { value.heartbeat.configStatus.dashboardControlProtocol.version = 2; },
      (value: RevisionFixture) => { value.heartbeat.configStatus.dashboardControlObservedAt = now - 15_001; },
      (value: RevisionFixture) => { value.heartbeat.status = "unreachable"; },
      (value: RevisionFixture) => { value.gatewayId = "other"; },
    ]) {
      const value = revision(now);
      mutate(value);
      expect(isOpenClawControlRevisionRuntimeReady(value, {
        gatewayId: "walter",
        revisionId: "walter",
        now,
      })).toBe(false);
    }
  });
});
