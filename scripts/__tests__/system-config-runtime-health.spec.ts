import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSystemConfigStatusPublisher,
  refreshSystemConfigRuntimeHealth,
} from "../lib/system-config-runtime-health.js";
import {
  readSystemConfigStatus,
  updateSystemConfigStatus,
} from "../lib/system-config-status.js";
import {
  OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
  OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
} from "@octogee/shared/types/fleet-controller";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-health-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    GATEWAY_ID: "g1",
    OPENCLAW_VERSION: "main",
    OPENCLAW_FORK_SHA: "current",
    ...overrides,
  };
}

function writeDashboardCapability(openclawDir: string, observedAt: Date): void {
  const capabilityPath = path.join(openclawDir, OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE);
  fs.writeFileSync(
    capabilityPath,
    `${JSON.stringify({
      protocol: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
      version: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
      revisionId: "g1",
      openclawVersion: "main",
      openclawForkSha: "current",
      instanceId: "instance-1",
      observedAt: observedAt.toISOString(),
    })}\n`,
  );
  fs.utimesSync(capabilityPath, observedAt, observedAt);
}

describe("refreshSystemConfigRuntimeHealth", () => {
  it("stamps healthy + runtimeReady from a passing OpenClaw deep probe with no boot-acceptance gate", async () => {
    const openclawDir = tempDir();
    updateSystemConfigStatus(openclawDir, { state: "clean" });

    const status = await refreshSystemConfigRuntimeHealth({
      openclawDir,
      env: env(),
      probeOpenClaw: async () => true,
    });

    expect(status).toMatchObject({
      state: "clean",
      runtimeReady: true,
      runtimeHealth: "healthy",
      openclawVersion: "main",
      openclawForkSha: "current",
      dashboardControlState: "missing",
    });
    expect(readSystemConfigStatus(openclawDir).runtimeHealth).toBe("healthy");
  });

  it("gates readiness on the deep probe: an unhealthy OpenClaw is unhealthy, not ready", async () => {
    const openclawDir = tempDir();
    updateSystemConfigStatus(openclawDir, { state: "clean" });

    const status = await refreshSystemConfigRuntimeHealth({
      openclawDir,
      env: env(),
      probeOpenClaw: async () => false,
    });

    expect(status).toMatchObject({ runtimeReady: false, runtimeHealth: "unhealthy" });
  });

  it("requires a fresh identity-bound Dashboard bridge heartbeat only when enabled", async () => {
    const openclawDir = tempDir();
    updateSystemConfigStatus(openclawDir, { state: "clean" });
    const now = new Date("2026-07-17T12:00:00.000Z");

    const withoutCapability = await refreshSystemConfigRuntimeHealth({
      openclawDir,
      env: env({ OPENCLAW_DASHBOARD_BRIDGE_REQUIRED: "true" }),
      probeOpenClaw: async () => true,
      now: () => now,
    });
    expect(withoutCapability).toMatchObject({
      runtimeReady: false,
      runtimeHealth: "repair",
      dashboardControlState: "missing",
    });

    writeDashboardCapability(openclawDir, new Date(now.getTime() - 1_000));
    const withCapability = await refreshSystemConfigRuntimeHealth({
      openclawDir,
      env: env({ OPENCLAW_DASHBOARD_BRIDGE_REQUIRED: "true" }),
      probeOpenClaw: async () => true,
      now: () => now,
    });
    expect(withCapability).toMatchObject({
      runtimeReady: true,
      runtimeHealth: "healthy",
      dashboardControlState: "ready",
      dashboardControlProtocol: {
        protocol: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL,
        version: OPENCLAW_DASHBOARD_BRIDGE_PROTOCOL_VERSION,
      },
    });
  });

  it("treats a stale or identity-mismatched Dashboard capability as not ready", async () => {
    const openclawDir = tempDir();
    updateSystemConfigStatus(openclawDir, { state: "clean" });
    const now = new Date("2026-07-17T12:00:00.000Z");
    writeDashboardCapability(openclawDir, new Date(now.getTime() - 60_000));
    const capabilityPath = path.join(openclawDir, OPENCLAW_DASHBOARD_BRIDGE_CAPABILITY_FILE);
    fs.utimesSync(capabilityPath, new Date(now.getTime() - 60_000), new Date(now.getTime() - 60_000));

    const stale = await refreshSystemConfigRuntimeHealth({
      openclawDir,
      env: env({ OPENCLAW_DASHBOARD_BRIDGE_REQUIRED: "true" }),
      probeOpenClaw: async () => true,
      now: () => now,
    });
    expect(stale).toMatchObject({ runtimeReady: false, dashboardControlState: "stale" });

    const mismatched = await refreshSystemConfigRuntimeHealth({
      openclawDir,
      env: env({ OPENCLAW_DASHBOARD_BRIDGE_REQUIRED: "true", GATEWAY_ID: "other" }),
      probeOpenClaw: async () => true,
      now: () => now,
    });
    expect(mismatched).toMatchObject({ runtimeReady: false, dashboardControlState: "invalid" });
  });
});

describe("createSystemConfigStatusPublisher", () => {
  it("publishes renewed Dashboard proof before the status heartbeat is due", async () => {
    const openclawDir = tempDir();
    const start = Date.parse("2026-09-15T23:00:00.000Z");
    let nowMs = start;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    updateSystemConfigStatus(openclawDir, { state: "clean" });
    writeDashboardCapability(openclawDir, new Date(nowMs));
    const publish = vi.fn(async () => {});
    const publisher = createSystemConfigStatusPublisher({
      openclawDir,
      publish,
      refreshRuntimeHealth: () => refreshSystemConfigRuntimeHealth({
        openclawDir,
        env: env({ OPENCLAW_DASHBOARD_BRIDGE_REQUIRED: "true" }),
        probeOpenClaw: async () => true,
        now: () => new Date(nowMs),
      }),
    });

    try {
      await publisher.publishNow();
      nowMs += 5_000;
      writeDashboardCapability(openclawDir, new Date(nowMs));
      await publisher.publishNow();

      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
        runtimeReady: true,
        dashboardControlState: "ready",
        dashboardControlObservedAt: new Date(nowMs).toISOString(),
      }));
      await publisher.publishNow();
      expect(publish).toHaveBeenCalledTimes(2);
    } finally {
      publisher.close();
    }
  });

  it("publishes only changed status and republished heartbeats on the bounded interval", async () => {
    const openclawDir = tempDir();
    updateSystemConfigStatus(openclawDir, { state: "clean" });
    const published: unknown[] = [];
    let nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const publisher = createSystemConfigStatusPublisher({
      openclawDir,
      publish: async (status) => {
        published.push(status);
      },
      refreshRuntimeHealth: () => refreshSystemConfigRuntimeHealth({
        openclawDir,
        env: env(),
        probeOpenClaw: async () => true,
      }),
      heartbeatMs: 10_000,
    });

    await publisher.publishNow();
    await publisher.publishNow();
    expect(published).toHaveLength(1);

    nowMs = 10_001;
    await publisher.publishNow();
    expect(published).toHaveLength(2);

    publisher.close();
  });

  it("logs publish failures and keeps publishing on later attempts", async () => {
    const openclawDir = tempDir();
    updateSystemConfigStatus(openclawDir, { state: "clean" });
    const log = vi.fn();
    let fail = true;
    const published: unknown[] = [];
    const publisher = createSystemConfigStatusPublisher({
      openclawDir,
      publish: async (status) => {
        if (fail) throw new Error("broker unavailable");
        published.push(status);
      },
      log,
    });

    await publisher.publishNow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("status publish failed"));

    fail = false;
    await publisher.publishNow();
    expect(published).toHaveLength(1);
    publisher.close();
  });
});
