import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { describe, expect, it } from "vitest";

import {
  parseSystemConfigObservedStatus,
  resolveAssignedUsersRevisionGate,
} from "./fleet-broker.js";
import { revisionIdFromGatewayPodName } from "../lib/gateway-pod-revision.js";

function gatewayStateStore(data: Record<string, unknown> | undefined) {
  return createDocumentFixtureStore({ "gateways/default": data });
}

function durableGatewayState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId: "default",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 14,
    desiredRelease: 14,
    liveRelease: 12,
    desiredStatus: "running",
    liveRevisionId: "default-r12",
    trafficRevisionId: "default-r12",
    roll: {
      operationId: "roll-default-r14",
      status: "migrating",
      fromRelease: 12,
      toRelease: 14,
      sourceRevisionId: "default-r12",
      targetRevisionId: "default-r14",
      acceptingNewAssignments: true,
      startedAt: 1,
      updatedAt: 1,
      error: null,
      flippedAt: null,
    },
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("revisionIdFromGatewayPodName", () => {
  it("resolves the bare gateway id from the stable-name Deployment's pod name", () => {
    expect(
      revisionIdFromGatewayPodName(
        "default",
        "octogee-gateway-default-5bc5949d46-p946t",
      ),
    ).toBe("default");
  });

  it("refuses pods outside the gateway Deployment naming contract", () => {
    expect(revisionIdFromGatewayPodName("default", "octogee-gateway-default")).toBeNull();
    expect(revisionIdFromGatewayPodName("default", "octogee-gateway-other-r27-5bc5949d46-p946t")).toBeNull();
  });
});

describe("system config observed status validation", () => {
  it("drops retired protocol-v2 roll fields instead of persisting them", () => {
    expect(parseSystemConfigObservedStatus({
      state: "clean",
      openclawVersion: "2026.7.1",
      freezeState: "frozen",
      bootRole: "source-frozen",
      controlProtocol: { protocol: "durable-openclaw-config", version: 2 },
      controlOwner: {
        migrationId: "roll-config-roll-1",
        sourceRevisionId: "default-r1",
        targetRevisionId: "default-r2",
      },
      checkpointCommit: "1".repeat(40),
      candidateCommit: "3".repeat(40),
      candidateHash: "b".repeat(64),
    })).toEqual({
      state: "clean",
      openclawVersion: "2026.7.1",
    });
  });

  it("accepts only the redacted bounded status projection", () => {
    expect(parseSystemConfigObservedStatus({
      state: "error",
      acceptedCommit: "a".repeat(40),
      configHash: `sha256:${"b".repeat(64)}`,
      lastErrorCode: "non-fast-forward-conflict",
      rejectedCount: 2,
      recoveryCount: 1,
      runtimeReady: true,
      runtimeHealth: "healthy",
      runtimeHealthCheckedAt: "2026-07-14T20:00:01.000Z",
      openclawVersion: "2026.7.1",
      openclawForkSha: "abc1234",
      dashboardControlState: "ready",
      dashboardControlProtocol: {
        protocol: "openclaw-dashboard-bridge",
        version: 1,
      },
      dashboardControlObservedAt: "2026-07-14T20:00:00.000Z",
      unknown: "drop-me",
    })).toEqual({
      state: "error",
      acceptedCommit: "a".repeat(40),
      configHash: `sha256:${"b".repeat(64)}`,
      lastErrorCode: "non-fast-forward-conflict",
      rejectedCount: 2,
      recoveryCount: 1,
      runtimeReady: true,
      runtimeHealth: "healthy",
      runtimeHealthCheckedAt: "2026-07-14T20:00:01.000Z",
      openclawVersion: "2026.7.1",
      openclawForkSha: "abc1234",
      dashboardControlState: "ready",
      dashboardControlProtocol: {
        protocol: "openclaw-dashboard-bridge",
        version: 1,
      },
      dashboardControlObservedAt: "2026-07-14T20:00:00.000Z",
    });
  });

  it("rejects secret-shaped, invalid, and oversized fields", () => {
    expect(parseSystemConfigObservedStatus({ state: "bogus" })).toBeNull();
    expect(parseSystemConfigObservedStatus({ state: "clean", acceptedCommit: "not-a-sha" })).toBeNull();
    expect(parseSystemConfigObservedStatus({
      state: "error",
      lastErrorCode: "x".repeat(81),
    })).toBeNull();
    expect(parseSystemConfigObservedStatus({
      state: "error",
      token: "must-not-pass",
    })).toEqual({ state: "error" });
    expect(parseSystemConfigObservedStatus({
      state: "clean",
      dashboardControlState: "ready",
      dashboardControlProtocol: { protocol: "openclaw-dashboard-bridge", version: 2 },
      dashboardControlObservedAt: "2026-07-14T20:00:00.000Z",
    })).toBeNull();
    expect(parseSystemConfigObservedStatus({
      state: "clean",
      dashboardControlState: "ready",
    })).toBeNull();
  });
});

describe("fleet broker durable root boundary", () => {
  const incompleteRoot = { gatewayId: "default", internalUrl: "http://legacy-should-not-run" };

  it("permits the empty-revision legacy roster path when the root is absent", async () => {
    await expect(
      resolveAssignedUsersRevisionGate(gatewayStateStore(undefined), "default", ""),
    ).resolves.toEqual({ allowed: true });
  });

  it("fails closed on an incomplete gateway root on the empty-revision legacy roster path", async () => {
    await expect(
      resolveAssignedUsersRevisionGate(gatewayStateStore(incompleteRoot), "default", ""),
    ).rejects.toMatchObject({ name: "MalformedRecordError" });
  });

  it("requires a durable root when a routing roster is requested", async () => {
    await expect(
      resolveAssignedUsersRevisionGate(
        gatewayStateStore(undefined),
        "default",
        "default-r1",
        { requireDurableRoot: true },
      ),
    ).resolves.toEqual({ allowed: false });
  });

  it("authorizes the bare-id pod for a durable root and rejects revision-suffixed identities", async () => {
    const root = durableGatewayState();

    await expect(
      resolveAssignedUsersRevisionGate(
        gatewayStateStore(root),
        "default",
        "default",
        { requireDurableRoot: true },
      ),
    ).resolves.toEqual({ allowed: true });

    await expect(
      resolveAssignedUsersRevisionGate(
        gatewayStateStore(root),
        "default",
        "default-r13",
        { requireDurableRoot: true },
      ),
    ).resolves.toEqual({ allowed: false });
  });

  it("authorizes only an empty retired co-owner mirror on a durable roster root", async () => {
    await expect(
      resolveAssignedUsersRevisionGate(
        gatewayStateStore(durableGatewayState({ coOwnerUids: [] })),
        "default",
        "default",
        { requireDurableRoot: true },
      ),
    ).resolves.toEqual({ allowed: true });
    await expect(
      resolveAssignedUsersRevisionGate(
        gatewayStateStore(durableGatewayState({ coOwnerUids: ["uid-former-helper"] })),
        "default",
        "default",
        { requireDurableRoot: true },
      ),
    ).resolves.toEqual({ allowed: false });
  });

});
