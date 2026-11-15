import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readSystemConfigStatus,
  renderSystemConfigMetrics,
  systemConfigStatusPath,
  updateSystemConfigStatus,
} from "../lib/system-config-status.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-status-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("system config observed status", () => {
  it("atomically merges a redacted mode-0600 status record", () => {
    const dir = tempDir();
    updateSystemConfigStatus(dir, {
      state: "dirty",
      dirtySince: "2026-07-14T20:00:00.000Z",
      lastErrorCode: "validation-failed",
    });
    updateSystemConfigStatus(dir, {
      state: "clean",
      acceptedCommit: "abc123",
      configHash: "sha256:deadbeef",
      lastSyncedAt: "2026-07-14T20:00:05.000Z",
      lastErrorCode: null,
      runtimeReady: true,
      runtimeHealth: "healthy",
      runtimeHealthCheckedAt: "2026-07-14T20:00:06.000Z",
    });

    expect(readSystemConfigStatus(dir)).toMatchObject({
      state: "clean",
      acceptedCommit: "abc123",
      configHash: "sha256:deadbeef",
      lastSyncedAt: "2026-07-14T20:00:05.000Z",
      lastErrorCode: null,
      runtimeReady: true,
      runtimeHealth: "healthy",
      runtimeHealthCheckedAt: "2026-07-14T20:00:06.000Z",
    });
    expect(fs.statSync(systemConfigStatusPath(dir)).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${systemConfigStatusPath(dir)}.tmp`)).toBe(false);
  });

  it("renders state, dirty age, and recovery/rejection counters without identity labels", () => {
    const metrics = renderSystemConfigMetrics({
      state: "error",
      dirtySince: "2026-07-14T20:00:00.000Z",
      rejectedCount: 2,
      recoveryCount: 1,
      lastErrorCode: "non-fast-forward-conflict",
      runtimeReady: false,
    }, Date.parse("2026-07-14T20:00:09.000Z"));

    expect(metrics).toContain('octogee_system_config_state{state="error"} 1');
    expect(metrics).toContain("octogee_system_config_dirty_age_seconds 9.000");
    expect(metrics).toContain("octogee_system_config_rejected_total 2");
    expect(metrics).toContain("octogee_system_config_recovery_total 1");
    expect(metrics).toContain('octogee_system_config_last_error{code="non-fast-forward-conflict"} 1');
    expect(metrics).toContain("octogee_openclaw_runtime_ready 0");
    expect(metrics).not.toMatch(/uid|slug|path=/);
  });

  it("returns unavailable when no status has been recorded", () => {
    expect(readSystemConfigStatus(tempDir())).toEqual({ state: "unavailable" });
  });

  it("projects only redacted typed fields from the local status file", () => {
    const dir = tempDir();
    fs.writeFileSync(systemConfigStatusPath(dir), JSON.stringify({
      state: "error",
      acceptedCommit: "abc1234",
      rejectedCount: 2,
      lastErrorCode: "validation-failed",
      secret: "must-not-leave-the-pod",
      configPath: "/home/node/.openclaw/system_config/openclaw.json",
      recoveryCount: "not-a-number",
      runtimeReady: true,
      runtimeHealth: "healthy",
      runtimeHealthCheckedAt: "2026-07-14T20:00:06.000Z",
    }));

    expect(readSystemConfigStatus(dir)).toEqual({
      state: "error",
      acceptedCommit: "abc1234",
      rejectedCount: 2,
      lastErrorCode: "validation-failed",
      runtimeReady: true,
      runtimeHealth: "healthy",
      runtimeHealthCheckedAt: "2026-07-14T20:00:06.000Z",
    });
  });

  it("projects the pinned OpenClaw identity and drops retired roll-era fields", () => {
    const dir = tempDir();
    updateSystemConfigStatus(dir, {
      state: "clean",
      openclawVersion: "2026.7.1",
      openclawForkSha: "abc1234",
      configHash: "b".repeat(64),
    });
    fs.writeFileSync(path.join(dir, "system_config.status.json"), JSON.stringify({
      state: "clean",
      openclawVersion: "2026.7.1",
      openclawForkSha: "abc1234",
      configHash: "b".repeat(64),
      freezeState: "unfrozen",
      bootRole: "source-frozen",
      controlProtocol: { protocol: "durable-openclaw-config", version: 2 },
      checkpointCommit: "a".repeat(40),
      controlOwner: { migrationId: "mig-1" },
    }));

    const status = readSystemConfigStatus(dir);
    expect(status).toMatchObject({
      state: "clean",
      openclawVersion: "2026.7.1",
      openclawForkSha: "abc1234",
      configHash: "b".repeat(64),
    });
    expect(status).not.toHaveProperty("freezeState");
    expect(status).not.toHaveProperty("bootRole");
    expect(status).not.toHaveProperty("controlProtocol");
    expect(status).not.toHaveProperty("checkpointCommit");
    expect(status).not.toHaveProperty("controlOwner");
  });

  it("recovers an expired legacy status writer lock before merging a new update", () => {
    const dir = tempDir();
    const lockPath = path.join(dir, "system_config.status.lock");
    fs.writeFileSync(lockPath, "999999999\n");
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    updateSystemConfigStatus(dir, { state: "dirty", watcherState: "running" });

    expect(readSystemConfigStatus(dir)).toMatchObject({ state: "dirty", watcherState: "running" });
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
