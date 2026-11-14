import { describe, expect, it, vi } from "vitest";

import {
  OPENCLAW_CONTROL_RUNTIME_FRESH_MS,
  isOpenClawControlRevisionRuntimeReady,
  isOpenClawControlServingRevision,
} from "./openclaw-control-runtime-ready.js";

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

describe("serving isolated gateway during an unconverged roll", () => {
  const now = Date.UTC(2026, 6, 14, 20);
  function fixture() {
    const root: Record<string, unknown> = {
      gatewayId: "walter", createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
      latestRelease: 3, desiredRelease: 3, liveRelease: 2, desiredStatus: "running",
      configSchemaVersion: 1, gatewayClass: "isolated", profile: "isolated", imageProfile: "isolated",
      ownerUid: "owner", builderSlug: "walter", sizingTier: null, gcpProject: null,
      gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null,
      builderAccess: null, modelBrokerLimits: null, preemption: null,
    };
    const runtime = { ...revision(now), release: 3, createdAt: 1, createdByOperationId: null,
      helm: {}, lastError: { message: null, at: null },
      heartbeat: { ...revision(now).heartbeat, version: "abc1234" } };
    const readArtifact = vi.fn(async () => ({ imageRepository: "registry/octogee-gateway", imageTag: "def5678",
      profileImages: { builder: { imageRepository: "registry/octogee-gateway-builder", imageTag: `abc1234@sha256:${"b".repeat(64)}` } } }));
    return { root, runtime, readArtifact,
      check: () => isOpenClawControlServingRevision(root, runtime, { gatewayId: "walter", revisionId: "walter", now, readArtifact }) };
  }

  it.each([2, 3])("admits the fresh live image while runtime release records %i", async (release) => {
    const f = fixture();
    f.runtime.release = release;
    expect(await f.check()).toBe(true);
    expect(f.readArtifact).toHaveBeenCalledWith(2);
  });

  it("admits the fresh live image when the release keys it under isolated", async () => {
    const f = fixture();
    f.readArtifact.mockResolvedValueOnce({ imageRepository: "registry/octogee-gateway", imageTag: "def5678",
      profileImages: { isolated: { imageRepository: "registry/octogee-gateway-builder", imageTag: `abc1234@sha256:${"b".repeat(64)}` } } } as never);
    expect(await f.check()).toBe(true);
  });

  it.each([
    { desiredStatus: "paused" }, { desiredStatus: "retired" }, { desiredStatus: "draining" },
    { liveRelease: null }, { desiredRelease: 1 }, { gatewayId: "other" },
    { gatewayClass: "shared", profile: "standard", imageProfile: "standard", ownerUid: null, builderSlug: null },
    { retirementClaim: { operationId: "retire" } }, { runtimeRestartFence: { phase: "reserved" } },
    { retireAfter: now + 60_000 }, { retireAfter: now - 60_000 },
  ])("refuses an ineligible root %o", async (patch) => {
    const f = fixture(); Object.assign(f.root, patch);
    expect(await f.check()).toBe(false);
  });

  it("refuses a replacement image, stale health, and unrelated runtime release", async () => {
    const f = fixture();
    f.runtime.heartbeat.version = "def5678";
    expect(await f.check()).toBe(false);
    f.runtime.heartbeat.version = "abc1234";
    f.runtime.release = 4;
    expect(await f.check()).toBe(false);
    f.runtime.release = 3;
    f.runtime.heartbeat.configStatus.runtimeHealth = "repair";
    expect(await f.check()).toBe(false);
    f.runtime.heartbeat.configStatus.runtimeHealth = "healthy";
    f.runtime.heartbeat.lastHeartbeatAt = now - OPENCLAW_CONTROL_RUNTIME_FRESH_MS - 1;
    expect(await f.check()).toBe(false);
  });

  it("refuses missing live artifacts and missing isolated images", async () => {
    const f = fixture();
    for (const artifact of [null, { imageRepository: "registry/octogee-gateway", imageTag: "abc1234" }]) {
      expect(await isOpenClawControlServingRevision(f.root, f.runtime, {
        gatewayId: "walter", revisionId: "walter", now, readArtifact: async () => artifact,
      })).toBe(false);
    }
  });
});
