import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Firestore } from "firebase-admin/firestore";

import {
  addAdminFleetRoutes,
  projectIsolatedRuntime,
  projectDisposableFleetCapacity,
  projectGatewayReservation,
  projectGatewayControl,
  projectGatewaySummary,
  scheduleUserSelfDeletion,
  shapeOperationsHistoryRecord,
} from "./admin-fleet-router.js";
import {
  durableGatewayRoot,
  isolatedGatewayRoot,
  mkAdminFleetRouteApp,
  runtimeDoc,
} from "./testing/admin-fleet-route-app.js";
import {
  createJournalFixtureStore,
  journalRowsAtPaths,
  type FixtureDocuments,
} from "./testing/journal-store.js";
import type { PlatformStateTransaction } from "./platform-state/store.js";
import { SPOT_PRICE_MULTIPLIER } from "@octogee/shared/types/cost-estimator";
import { ACCOUNT_DELETION_RETENTION_MS } from "@octogee/shared/types/account-lifecycle";
import { firestoreUserAccountReader } from "./user-account.js";
import { isPlainObject, type PlainObject } from "./platform-state/documents/secrets.js";

function storedProvisioning(user: PlainObject | undefined): PlainObject {
  const provisioning = user?.provisioning;
  if (!isPlainObject(provisioning)) throw new Error("stored user has no provisioning");
  return provisioning;
}

function storedOpenclaw(user: PlainObject | undefined): PlainObject {
  const openclaw = storedProvisioning(user).openclaw;
  if (!isPlainObject(openclaw)) throw new Error("stored user has no provisioning.openclaw");
  return openclaw;
}

describe("projectGatewayControl", () => {
  const root = {
    gatewayId: "gw-1",
    imageRepository: "repo",
    imageTag: "tag",
    desiredStatus: "running",
    createdBy: "test",
    desiredRelease: 3,
    liveRelease: 2,
  };

  it("exposes every mutable config knob with explicit nulls", () => {
    const control = projectGatewayControl(
      {
        ...root,
        gatewayClass: "builder",
        sizingTier: "m",
        ownerUid: "uid-1",
        builderSlug: "alice",
        modelBrokerLimits: { rpm: 10 },
      } as never,
      { runtime: "gce-vm", vm: { instanceName: "octogee-computer-prod-uid", zone: "us-central1-a", status: "TERMINATED" } },
    );

    expect(control).toMatchObject({
      desiredStatus: "running",
      desiredRelease: 3,
      liveRelease: 2,
      runtime: "gce-vm",
      gatewayClass: "builder",
      imageProfile: "builder",
      sizingTier: "m",
      ownerUid: "uid-1",
      userSlug: "alice",
      modelBrokerLimits: { rpm: 10 },
      userAccess: null,
      gcpProject: null,
      serviceAccountName: null,
      vm: { instanceName: "octogee-computer-prod-uid", status: "TERMINATED" },
    });
  });

  it("projects a cluster gateway with no VM", () => {
    const control = projectGatewayControl(root as never, undefined);
    expect(control).toMatchObject({ runtime: "cluster", gatewayClass: "shared", vm: null, liveRelease: 2 });
  });
});

describe("projectGatewayReservation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults Shared gateways to on-demand and disposable gateways to Spot before a pod schedules", () => {
    expect(projectGatewayReservation({ gatewayClass: "shared" })).toEqual({
      type: "on-demand",
      priceMultiplier: 1,
      source: "class-default",
    });
    expect(projectGatewayReservation({ gatewayClass: "builder" })).toEqual({
      type: "spot",
      priceMultiplier: SPOT_PRICE_MULTIPLIER,
      source: "class-default",
    });
  });

  it("uses observed pod-node capacity instead of the class default", () => {
    expect(projectGatewayReservation({ gatewayClass: "shared" }, "spot")).toEqual({
      type: "spot",
      priceMultiplier: SPOT_PRICE_MULTIPLIER,
      source: "kubernetes",
    });
    expect(projectGatewayReservation({ gatewayClass: "builder" }, "on-demand")).toEqual({
      type: "on-demand",
      priceMultiplier: 1,
      source: "kubernetes",
    });
  });
});

describe("shapeOperationsHistoryRecord", () => {
  it("preserves an audit union member without projecting it as a command", () => {
    expect(shapeOperationsHistoryRecord("audit-1", {
      recordType: "audit",
      schemaVersion: 1,
      status: "completed",
      lifecycleStage: "action-completed",
      idempotencyKey: "key",
      mutationFingerprint: "fingerprint",
      mutation: { kind: "move-alias" },
      actor: "fleet-cli:chris",
      forced: true,
      what: "move release alias",
      why: "candidate verified in TEST",
      target: { gatewayId: "walter" },
      preActionStatus: { alias: "stable", target: "sha-old" },
      aliasPlan: [],
      createdAt: 1,
      actionClaimId: "runner-1",
      actionStartedAt: 1.5,
      actionRecoveryCount: 0,
      completedAt: 2,
      outcome: "completed",
    })).toEqual({
      id: "audit-1",
      recordType: "audit",
      schemaVersion: 1,
      status: "completed",
      lifecycleStage: "action-completed",
      idempotencyKey: "key",
      mutationFingerprint: "fingerprint",
      mutation: { kind: "move-alias" },
      kind: "move-alias",
      actor: "fleet-cli:chris",
      createdBy: "fleet-cli:chris",
      forced: true,
      what: "move release alias",
      why: "candidate verified in TEST",
      target: { gatewayId: "walter" },
      preActionStatus: { alias: "stable", target: "sha-old" },
      aliasPlan: [],
      createdAt: 1,
      actionClaimId: "runner-1",
      actionStartedAt: 1.5,
      actionRecoveryCount: 0,
      completedAt: 2,
      outcome: "completed",
    });
  });

  it("projects malformed and future audit rows as safe invalid history records", () => {
    expect(shapeOperationsHistoryRecord("audit-future", {
      recordType: "audit",
      schemaVersion: 2,
      status: "recorded",
      lifecycleStage: "intent-recorded",
      createdAt: 5,
    })).toEqual({
      id: "audit-future",
      recordType: "audit",
      invalid: true,
      schemaVersion: 2,
      status: "invalid",
      lifecycleStage: "invalid",
      createdAt: 5,
      completedAt: null,
      error: "Unsupported or malformed operation audit record",
    });
  });
});

// Step 1 of the Fleet regroup (GATEWAY-RELEASES-SPEC): every row projects its
// durable "gateway" identity so the client can group blue/green siblings under
// one card without an id/route migration.
describe("projectGatewaySummary — pod replacement projection", () => {
  const HOUR = 60 * 60 * 1000;
  const NOW = 1_770_000_000_000;

  function summaryWith(podReplacements: unknown) {
    return projectGatewaySummary(
      { id: "ceckert-test-s", data: () => ({ gatewayId: "ceckert-test-s" }) },
      { gatewayId: "ceckert-test-s", podReplacements },
      NOW,
    );
  }

  it("derives the rolling counts against the request clock", () => {
    const summary = summaryWith({
      recentAt: [NOW - 30 * HOUR, NOW - 5 * HOUR, NOW - HOUR],
      lastAt: NOW - HOUR,
      lastVacatedPodUid: "uid-fresh",
      lastVacatedNodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
      lastVacatedInstanceId: "7311234567890123456",
      lastVacatedNodePool: "nap-1dx2tv8d",
      total: 12,
    });
    expect(summary.podReplacements).toEqual({
      count24h: 2,
      count7d: 3,
      lastAgeMs: HOUR,
      lastVacatedNodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
      lastVacatedInstanceId: "7311234567890123456",
      lastVacatedNodePool: "nap-1dx2tv8d",
      total: 12,
      warn: false,
    });
  });

  it("flags a gateway that crossed the 24h warning threshold", () => {
    const summary = summaryWith({
      recentAt: [NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - HOUR],
      lastAt: NOW - HOUR,
      lastVacatedPodUid: "uid-c",
      lastVacatedNodeName: null,
      lastVacatedInstanceId: null,
      lastVacatedNodePool: null,
      total: 3,
    });
    expect(summary.podReplacements?.count24h).toBe(3);
    expect(summary.podReplacements?.warn).toBe(true);
  });

  it("projects null for a gateway the fleet controller has not tracked yet", () => {
    expect(summaryWith(undefined).podReplacements).toBeNull();
  });

  it("projects null rather than trusting a malformed stored record", () => {
    expect(summaryWith({ recentAt: "lots", total: 3 }).podReplacements).toBeNull();
  });
});

describe("projectGatewaySummary — gateway identity projection", () => {
  it("uses the explicit glmGateways.gateway field when present", () => {
    const summary = projectGatewaySummary(
      { id: "default-blue", data: () => ({ gatewayId: "default-blue" }) },
      { gatewayId: "default-blue", gateway: "default" },
      Date.now(),
    );
    expect(summary.gateway).toBe("default");
  });

  it("falls back to convention-parse (strip trailing -blue/-green) when the field is absent", () => {
    const summary = projectGatewaySummary(
      { id: "walter-green", data: () => ({ gatewayId: "walter-green" }) },
      { gatewayId: "walter-green" },
      Date.now(),
    );
    expect(summary.gateway).toBe("walter");
  });

  it("treats an unsuffixed id as its own bare gateway identity", () => {
    const summary = projectGatewaySummary(
      { id: "jack", data: () => ({ gatewayId: "jack" }) },
      { gatewayId: "jack" },
      Date.now(),
    );
    expect(summary.gateway).toBe("jack");
  });

  it("marks an allocated isolated gateway as one disposable isolated generation", () => {
    const summary = projectGatewaySummary(
      { id: "run-alice-12345678", data: () => ({ gatewayId: "run-alice-12345678" }) },
      {
        gatewayId: "run-alice-12345678",
        gatewayClass: "builder",
        ownerUid: "uid-alice",
        allocation: {
          kind: "disposable-builder",
          schemaVersion: 1,
          leaseId: "lease-1",
          generation: 3,
          claimedByUid: "uid-alice",
        },
      },
      Date.now(),
    );

    expect(summary.disposableRuntime).toEqual({
      ownerUid: "uid-alice",
      leaseId: "lease-1",
      generation: 3,
    });
  });
});

describe("projectGatewaySummary — why OpenClaw is not serving", () => {
  function reasonFor(heartbeat: Record<string, unknown>, now = Date.now()) {
    return projectGatewaySummary(
      { id: "christopher-s-1", data: () => ({ gatewayId: "christopher-s-1", lastHeartbeatAt: now, ...heartbeat }) },
      { gatewayId: "christopher-s-1", gatewayClass: "builder", desiredStatus: "running" },
      now,
    ).statusReason;
  }

  it.each([
    [{ state: "held", migrationId: null }, "OpenClaw is held with no move in progress"],
    [{ state: "held", migrationId: "mig-1" }, "OpenClaw is held for move mig-1"],
    [{ state: "hydrated", migrationId: "mig-1" }, "OpenClaw is held for move mig-1"],
    [{ state: "unavailable", migrationId: null }, "The OpenClaw supervisor is not answering; it is still preparing or has failed"],
    [{ state: "starting", migrationId: null }, "OpenClaw is starting"],
    [{ state: "serving", migrationId: null }, "OpenClaw is running; startup checks are not finished"],
  ])("explains a booting gateway whose OpenClaw reports %j", (openclawProcess, expected) => {
    expect(reasonFor({ status: "booting", openclawProcess })).toBe(expected);
  });

  it("explains nothing for a serving gateway", () => {
    expect(reasonFor({ status: "ready", openclawProcess: { state: "held", migrationId: "mig-1" } })).toBeNull();
  });

  it("explains nothing when the gateway reported no OpenClaw process or a malformed one", () => {
    expect(reasonFor({ status: "booting" })).toBeNull();
    expect(reasonFor({ status: "booting", openclawProcess: { state: "stuck" } })).toBeNull();
  });

  it("explains nothing from a heartbeat too old to trust", () => {
    const now = Date.now();
    expect(reasonFor({ status: "booting", lastHeartbeatAt: now - 60 * 60_000, openclawProcess: { state: "held", migrationId: null } }, now))
      .toBeNull();
  });
});

describe("projectGatewaySummary — openclaw version projection", () => {
  function summaryFor(heartbeat: Record<string, unknown>, glmDoc: Record<string, unknown> = {}) {
    return projectGatewaySummary(
      { id: "default", data: () => ({ gatewayId: "default", ...heartbeat }) },
      { gatewayId: "default", ...glmDoc },
      Date.now(),
    );
  }

  it.each([
    ["OpenClaw 2026.7.1 (2ddb9a9)", "2026.7.1"],
    ["OpenClaw 2026.7.2-beta.7", "2026.7.2-beta.7"],
    ["2026.7.1 (2ddb9a9)", "2026.7.1"],
    ["  OpenClaw 2026.7.1  ", "2026.7.1"],
  ])("projects the raw `openclaw --version` string %j as the bare version", (reported, expected) => {
    expect(summaryFor({ openclawVersion: reported }).openclawVersion).toBe(expected);
  });

  it.each(["unknown", "OpenClaw unknown", "", "   "])(
    "falls back to the image tag when the pod reports %j",
    (reported) => {
      const summary = summaryFor(
        { openclawVersion: reported },
        { imageTag: "0bf497e-oc2026.7.2-beta.7" },
      );
      expect(summary.openclawVersion).toBe("2026.7.2-beta.7");
    },
  );
});

describe("projectIsolatedRuntime — disposable lifecycle visibility", () => {
  const now = 1_722_000_900_000;

  function user(activationLease: Record<string, unknown>) {
    return {
      id: "uid-alice",
      data: () => ({
        username: "alice",
        provisioning: {
          openclaw: {
            gatewayId: "shared-blue",
            slug: "alice",
            activationLease,
          },
        },
      }),
    };
  }

  it("does not present an operator-parked source as a failed active return", () => {
    const snapshot = user({ leaseId: "lease-1", generation: 1, status: "returning", targetGatewayId: "builder-alice", requestedAt: now - 90_000 });
    const data = snapshot.data();
    expect(projectIsolatedRuntime({ ...snapshot, data: () => ({ ...data, provisioning: { openclaw: { ...data.provisioning.openclaw, managedBy: "operator" } } }) }, new Map(), new Map(), now)).toBeNull();
  });

  it("projects requestedAt as the wake duration origin", () => {
    expect(projectIsolatedRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "requested",
        cause: "run-start",
        requestedAt: now - 90_000,
        sourceGatewayId: "shared-blue",
        sizingTier: "s",
      }),
      new Map(),
      new Map(),
      now,
    )).toMatchObject({
      uid: "uid-alice",
      userSlug: "alice",
      lifecycle: "requested",
      wakeDurationMs: 90_000,
      currentGatewayId: "shared-blue",
      sourceGatewayId: "shared-blue",
      targetGatewayId: null,
      sizingTier: "s",
    });
  });

  it("keeps stale provisioning visible with the exact disposable target", () => {
    expect(projectIsolatedRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "provisioning",
        cause: "scheduled",
        requestedAt: now - 20 * 60_000,
        provisionedAt: now - 60_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId: "run-alice-12345678",
        sizingTier: "s",
      }),
      new Map(),
      new Map(),
      now,
    )).toMatchObject({
      lifecycle: "provisioning",
      stale: true,
      targetGatewayId: "run-alice-12345678",
      wakeDurationMs: 20 * 60_000,
    });
  });

  it("freezes wake duration at cutover and never marks an active runtime stale", () => {
    expect(projectIsolatedRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "active",
        cause: "chat",
        requestedAt: now - 20 * 60_000,
        activeAt: now - 19 * 60_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId: "run-alice-12345678",
        sizingTier: "s",
      }),
      new Map(),
      new Map(),
      now,
    )).toMatchObject({
      lifecycle: "active",
      wakeDurationMs: 60_000,
      stale: false,
    });
  });

  it.each([
    ["running", "retiring", null],
    ["failed", "failed", "helm uninstall timed out"],
  ] as const)(
    "projects a %s teardown receipt as %s",
    (operationStatus, lifecycle, error) => {
      const targetGatewayId = "run-alice-12345678";
      const operationId = `placement-retire-uid-alice-${targetGatewayId}-g1`;
      const projected = projectIsolatedRuntime(
        user({
          leaseId: "lease-1",
          generation: 1,
          status: "returning",
          requestedAt: now - 300_000,
          returningAt: now - 30_000,
          sourceGatewayId: "shared-blue",
          targetGatewayId,
          sizingTier: "s",
        }),
        new Map([[targetGatewayId, {
          gatewayId: targetGatewayId,
          desiredStatus: "retired",
        }]]),
        new Map([[operationId, {
          status: operationStatus,
          ...(error ? { error } : {}),
        }]]),
        now,
      );

      expect(projected).toMatchObject({
        lifecycle,
        phase: "retirement",
        operationId,
        error,
      });
    },
  );

  it("keeps a failed activation visible after its target cleanup is retired", () => {
    const targetGatewayId = "run-alice-12345678";
    const activationOperationId = `builder-activate-${targetGatewayId}-g1`;
    const cleanupOperationId = `placement-retire-uid-alice-${targetGatewayId}-g1`;
    const projected = projectIsolatedRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "failed",
        requestedAt: now - 300_000,
        failedAt: now - 10_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId,
        sizingTier: "s",
        activationOperationId,
        lastError: {
          message: "restore target failed",
          operationId: activationOperationId,
        },
      }),
      new Map([[targetGatewayId, {
        gatewayId: targetGatewayId,
        desiredStatus: "retired",
        retirementClaim: { operationId: cleanupOperationId },
      }]]),
      new Map([
        [activationOperationId, {
          status: "failed",
          error: "restore target failed",
          steps: [
            { name: "restore-target", status: "failed" },
            { name: "cutover", status: "pending" },
            { secret: "drop-me" },
          ],
        }],
        [cleanupOperationId, {
          status: "running",
          steps: [{ name: "helm-uninstall", status: "running" }],
        }],
      ]),
      now,
    );

    expect(projected).toMatchObject({
      lifecycle: "failed",
      phase: "activation",
      operationId: activationOperationId,
      operationStatus: "failed",
      operationSteps: [
        { name: "restore-target", status: "failed" },
        { name: "cutover", status: "pending" },
      ],
      cleanupOperationId,
      cleanupOperationStatus: "running",
      cleanupOperationSteps: [
        { name: "helm-uninstall", status: "running" },
      ],
      cleanupError: null,
      error: "restore target failed",
    });
  });

  it("omits a failed activation once its cleanup succeeded or its runtime record is gone", () => {
    const targetGatewayId = "alice-s-12345678";
    const cleanupOperationId = `placement-retire-uid-alice-${targetGatewayId}-g1`;
    const failedLease = {
      leaseId: "lease-1",
      generation: 1,
      status: "failed",
      requestedAt: now - 300_000,
      failedAt: now - 10_000,
      sourceGatewayId: "shared-blue",
      targetGatewayId,
    };

    expect(projectIsolatedRuntime(
      user(failedLease),
      new Map([[targetGatewayId, {
        gatewayId: targetGatewayId,
        desiredStatus: "retired",
        retirementClaim: { operationId: cleanupOperationId },
      }]]),
      new Map([[cleanupOperationId, { status: "succeeded" }]]),
      now,
    )).toBeNull();

    expect(projectIsolatedRuntime(user(failedLease), new Map(), new Map(), now)).toBeNull();
  });

  it("omits parked leases after teardown receipts have completed", () => {
    expect(projectIsolatedRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "parked",
        requestedAt: now - 300_000,
      }),
      new Map(),
      new Map(),
      now,
    )).toBeNull();
  });

  it("keeps a parked lease visible until its disposable teardown completes", () => {
    const targetGatewayId = "run-alice-12345678";
    const operationId = `placement-retire-uid-alice-${targetGatewayId}-g1`;
    expect(projectIsolatedRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "parked",
        requestedAt: now - 300_000,
        activeAt: now - 240_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId,
      }),
      new Map([[targetGatewayId, {
        gatewayId: targetGatewayId,
        desiredStatus: "retired",
        retirementClaim: { operationId },
      }]]),
      new Map([[operationId, { status: "running" }]]),
      now,
    )).toMatchObject({
      lifecycle: "retiring",
      phase: "retirement",
      operationId,
      operationStatus: "running",
    });
  });

  it("omits a parked lease whose VM gateway is retained paused", () => {
    const targetGatewayId = "alice-m-12345678";
    expect(projectIsolatedRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "parked",
        requestedAt: now - 300_000,
        activeAt: now - 240_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId,
      }),
      new Map([[targetGatewayId, { gatewayId: targetGatewayId, desiredStatus: "paused" }]]),
      new Map(),
      now,
    )).toBeNull();
  });

  it("omits a parked lease after its disposable teardown succeeds", () => {
    const targetGatewayId = "run-alice-12345678";
    const operationId = `placement-retire-uid-alice-${targetGatewayId}-g1`;
    expect(projectIsolatedRuntime(
      user({
        leaseId: "lease-1",
        generation: 1,
        status: "parked",
        requestedAt: now - 300_000,
        sourceGatewayId: "shared-blue",
        targetGatewayId,
      }),
      new Map([[targetGatewayId, {
        gatewayId: targetGatewayId,
        desiredStatus: "retired",
        retirementClaim: { operationId },
      }]]),
      new Map([[operationId, { status: "succeeded" }]]),
      now,
    )).toBeNull();
  });
});

describe("projectDisposableFleetCapacity", () => {
  it("counts only allocated disposable pods without inventing node disk allocation", () => {
    const gateways = [
      projectGatewaySummary(
        { id: "shared-blue", data: () => ({ gatewayId: "shared-blue" }) },
        { gatewayId: "shared-blue", gatewayClass: "shared" },
        Date.now(),
      ),
      projectGatewaySummary(
        { id: "run-alice", data: () => ({ gatewayId: "run-alice" }) },
        {
          gatewayId: "run-alice",
          gatewayClass: "builder",
          sizingTier: "s",
          ownerUid: "uid-alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
        },
        Date.now(),
      ),
    ];

    expect(projectDisposableFleetCapacity(gateways)).toEqual({
      disposableInstances: 1,
      stagedInstances: 0,
      byTier: { s: 1 },
      parkedUsers: 0,
      byLifecycle: {
        requested: 0,
        provisioning: 0,
        activating: 0,
        active: 0,
        returning: 0,
        retiring: 0,
        failed: 0,
        parked: 0,
      },
      failedUsers: 0,
      staleActivations: 0,
      oldestActivationAgeMs: null,
    });
  });

});

describe("retired operator reservation routes", () => {
  it.each([
    ["get", "/operator-gateway-reservations"],
    ["delete", "/operator-gateway-reservations/uid-orphan"],
    ["post", "/operator-gateway-reservations/uid-orphan/activate"],
    ["post", "/operator-gateway-reservations/uid-orphan/fulfill"],
    ["patch", "/fleet-settings"],
  ] as const)("returns 404 for %s %s", async (method, path) => {
    const { app } = mkAdminFleetRouteApp({ config: {}, users: {} });
    await request(app)[method](path).send({}).expect(404);
  });
});

describe("the fleet command line contract", () => {
  const isolatedRoot = durableGatewayRoot("iso-ada", {
    gatewayClass: "builder",
    imageProfile: "builder",
    profile: "builder",
    ownerUid: "uid-ada",
    builderSlug: "ada",
  });

  it("names isolated gateways and their owners on the gateway list", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-a" },
      users: {},
      gateways: { "iso-ada": isolatedRoot },
    });
    const res = await request(app).get("/gateways").expect(200);
    const byId = new Map(res.body.gateways.map((gateway: { gatewayId: string }) => [gateway.gatewayId, gateway]));
    expect(byId.get("iso-ada")).toMatchObject({ gatewayClass: "isolated", ownerId: "uid-ada" });
    expect(byId.get("shared-a")).toMatchObject({ gatewayClass: "shared", ownerId: null, mountedUsers: [] });
  });

  it("lists retired gateways only when asked for all of them", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-a" },
      users: {},
      gateways: {
        gone: durableGatewayRoot("gone", { desiredStatus: "retired" }),
        "still-reporting": durableGatewayRoot("still-reporting", { desiredStatus: "retired", liveRelease: 1 }),
      },
      glmGateways: {
        "still-reporting": {
          docKind: "runtime",
          gatewayId: "still-reporting",
          release: 1,
          lifecycle: "serving",
          helm: { imageRepository: "registry.example/gateway", imageTag: "1234567" },
          heartbeat: { status: "ready", mountedCustomers: [], version: "1234567", lastHeartbeatAt: 1_000, startedAt: 500 },
          lastError: { message: null, at: null },
        },
      },
    });
    const ids = (res: { body: { gateways: Array<{ gatewayId: string }> } }) =>
      res.body.gateways.map((gateway) => gateway.gatewayId);
    expect(ids(await request(app).get("/gateways").expect(200))).toEqual(["shared-a"]);
    expect(ids(await request(app).get("/gateways?all=true").expect(200)).sort()).toEqual(["gone", "shared-a", "still-reporting"]);
  });

  it("says who added each shared gateway on the gateway listing", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { sharedGatewayIds: ["shared-a", "shared-ops"] },
      users: {},
      gateways: {
        "shared-a": durableGatewayRoot("shared-a", { liveRelease: 1, createdBy: "glm-controller-shared-pool-scaler" }),
        "shared-ops": durableGatewayRoot("shared-ops", { liveRelease: 1, createdBy: "operator-uid" }),
      },
    });

    const res = await request(app).get("/gateways").expect(200);

    expect(Object.fromEntries(res.body.gateways.map((gateway: { gatewayId: string; addedBy: unknown }) => [gateway.gatewayId, gateway.addedBy])))
      .toEqual({ "shared-a": "automation", "shared-ops": "operator" });
  });

  it("names users by id and name on the placement directory", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-a" },
      users: {
        "uid-ada": {
          username: "ada",
          email: "ada@example.com",
          provisioning: { status: "complete", openclaw: { slug: "ada", gatewayId: "shared-a" } },
        },
      },
    });
    const res = await request(app).get("/placement").expect(200);
    expect(res.body).not.toHaveProperty("customers");
    expect(res.body.users[0]).toMatchObject({ id: "uid-ada", name: "ada", assignedGatewayId: "shared-a" });
    expect(res.body.users[0]).not.toHaveProperty("uid");
    expect(res.body.config).not.toHaveProperty("sharedGatewayAutoscaling");
    expect(res.body.gateways[0]).toMatchObject({ gatewayId: "shared-a", gatewayClass: "shared" });
  });

  it("refuses the internal gateway class name when adding a gateway", async () => {
    const { app } = mkAdminFleetRouteApp({ config: { defaultGatewayId: "shared-a" }, users: {} });
    const res = await request(app).post("/gateways").send({
      gatewayId: "new-gateway",
      gatewayClass: "builder",
    }).expect(400);
    expect(res.body.error).toContain("shared, isolated");
  });

});

describe("fleet gateway projection", () => {
  it("counts an operator-held source as parked without a failed active-return row", async () => {
    const { app } = mkAdminFleetRouteApp({ config: { defaultGatewayId: "shared-blue" }, users: {
      "uid-held": { username: "held", provisioning: { openclaw: { managedBy: "operator", gatewayId: "builder-held", activationLease: { leaseId: "held", generation: 1, status: "returning", targetGatewayId: "builder-held" } } } },
    } });
    const fleet = await request(app).get("/gateways").expect(200);
    expect(fleet.body.isolatedRuntimes).toEqual([]);
    expect(fleet.body.disposableCapacity.operatorParkedUsers).toBe(1);
  });

  it("keeps disposable retirement intent and user lifecycle in the Fleet response", async () => {
    const targetGatewayId = "run-alice-12345678";
    const retirementOperationId = `placement-retire-uid-alice-${targetGatewayId}-g1`;
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              slug: "alice",
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "parked",
                cause: "run-start",
                requestedAt: Date.now() - 120_000,
                activeAt: Date.now() - 90_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "s",
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "s",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
        }),
      },
      operations: {
        [retirementOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: targetGatewayId },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.isolatedRuntimes).toEqual([
      expect.objectContaining({
        uid: "uid-alice",
        userSlug: "alice",
        lifecycle: "retiring",
        phase: "retirement",
        targetGatewayId,
        operationId: retirementOperationId,
        operationStatus: "running",
      }),
    ]);
    expect(fleet.body.gateways).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gatewayId: targetGatewayId,
          desiredStatus: "retired",
          disposableRuntime: {
            ownerUid: "uid-alice",
            leaseId: "lease-1",
            generation: 1,
          },
        }),
      ]),
    );
    expect(fleet.body.disposableCapacity).toEqual({
      operatorParkedUsers: 0,
      disposableInstances: 1,
      stagedInstances: 0,
      byTier: { s: 1 },
      parkedUsers: 1,
      byLifecycle: {
        requested: 0,
        provisioning: 0,
        activating: 0,
        active: 0,
        returning: 0,
        retiring: 1,
        failed: 0,
        parked: 1,
      },
      failedUsers: 0,
      staleActivations: 0,
      oldestActivationAgeMs: null,
    });
  });

  it("keeps a failed activation target in Fleet until its cleanup operation succeeds", async () => {
    const targetGatewayId = "run-alice-failed";
    const activationOperationId = "builder-activate-run-alice-failed-g1";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-failed-g1";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              slug: "alice",
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "failed",
                requestedAt: Date.now() - 120_000,
                failedAt: Date.now() - 30_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "s",
                activationOperationId,
                lastError: { message: "restore failed" },
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "s",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [activationOperationId]: {
          kind: "migrate-user",
          status: "failed",
          error: "restore failed",
        },
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: targetGatewayId },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.isolatedRuntimes).toEqual([
      expect.objectContaining({
        lifecycle: "failed",
        phase: "activation",
        operationId: activationOperationId,
        cleanupOperationId,
        cleanupOperationStatus: "running",
      }),
    ]);
    expect(fleet.body.gateways).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gatewayId: targetGatewayId,
          desiredStatus: "retired",
        }),
      ]),
    );
    expect(fleet.body.disposableCapacity.disposableInstances).toBe(1);
    const operational = fleet.body.gateways.filter(
      (gateway: { desiredStatus: string }) => gateway.desiredStatus !== "retired",
    );
    expect(fleet.body.stats.gateways.total).toBe(operational.length);
  });

  it("offers retry only after the retired target has an explicit zero-pod proof", async () => {
    const targetGatewayId = "run-alice-clean";
    const activationOperationId = "builder-activate-run-alice-clean-g1";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-clean-g1";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              slug: "alice",
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "failed",
                requestedAt: Date.now() - 120_000,
                failedAt: Date.now() - 30_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "s",
                activationOperationId,
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "s",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [activationOperationId]: {
          kind: "migrate-user",
          status: "failed",
        },
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "succeeded",
          input: { gatewayId: targetGatewayId },
        },
      },
      podDiagnostics: {
        "shared-blue": {
          status: "ready",
          totalPods: 1,
          readyPods: 1,
          totalRestarts: 0,
          spotPods: 0,
          onDemandPods: 1,
          unknownCapacityPods: 0,
          pods: [],
        },
        [targetGatewayId]: {
          status: "missing",
          totalPods: 0,
          readyPods: 0,
          totalRestarts: 0,
          spotPods: 0,
          onDemandPods: 0,
          unknownCapacityPods: 0,
          pods: [],
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.isolatedRuntimes).toEqual([]);
    expect(fleet.body.gateways).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gatewayId: targetGatewayId }),
      ]),
    );
  });

  it("keeps a failed runtime on Fleet only while its cleanup is unfinished", async () => {
    const targetGatewayId = "run-alice-cleaning";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-cleaning-g1";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-1",
                generation: 1,
                status: "failed",
                requestedAt: Date.now() - 120_000,
                failedAt: Date.now() - 30_000,
                sourceGatewayId: "shared-blue",
                targetGatewayId,
                sizingTier: "s",
              },
            },
          },
        },
      },
      gateways: {
        "shared-blue": durableGatewayRoot("shared-blue"),
        [targetGatewayId]: durableGatewayRoot(targetGatewayId, {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "s",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-1",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: targetGatewayId },
        },
      },
      podDiagnostics: {
        [targetGatewayId]: {
          status: "missing",
          totalPods: 0,
          readyPods: 0,
          totalRestarts: 0,
          spotPods: 0,
          onDemandPods: 0,
          unknownCapacityPods: 0,
          pods: [],
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.isolatedRuntimes).toEqual([
      expect.objectContaining({
        lifecycle: "failed",
        cleanupOperationStatus: "running",
      }),
    ]);
    expect(fleet.body.isolatedRuntimes[0]).not.toHaveProperty("retryAvailable");
  });

  it("keeps an old disposable visible after a new lease replaces the user target", async () => {
    const oldGatewayId = "run-alice-old";
    const cleanupOperationId = "placement-retire-uid-alice-run-alice-old-g1";
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {
        "uid-alice": {
          username: "alice",
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-new",
                generation: 2,
                status: "requested",
                requestedAt: Date.now(),
                sourceGatewayId: "shared-blue",
              },
            },
          },
        },
      },
      gateways: {
        [oldGatewayId]: durableGatewayRoot(oldGatewayId, {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "s",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-old",
            generation: 1,
            claimedByUid: "uid-alice",
          },
          retirementClaim: { operationId: cleanupOperationId },
        }),
      },
      operations: {
        [cleanupOperationId]: {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: oldGatewayId },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.gateways).toEqual([
      expect.objectContaining({ gatewayId: oldGatewayId, desiredStatus: "retired" }),
      expect.objectContaining({ gatewayId: "shared-blue" }),
    ]);
    expect(fleet.body.disposableCapacity.disposableInstances).toBe(1);
  });

  it("summarizes parked users, lifecycle failures, staleness, and oldest activation", async () => {
    const now = Date.now();
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue", sharedGatewayIds: ["shared-blue", "shared-green"] },
      users: {
        parked: {
          provisioning: {
            openclaw: {
              gatewayId: "shared-green",
              activationLease: {
                leaseId: "lease-parked",
                generation: 1,
                status: "parked",
              },
            },
          },
        },
        requested: {
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-requested",
                generation: 1,
                status: "requested",
                requestedAt: now - 20 * 60_000,
              },
            },
          },
        },
        failed: {
          provisioning: {
            openclaw: {
              gatewayId: "shared-blue",
              activationLease: {
                leaseId: "lease-failed",
                generation: 1,
                status: "failed",
                requestedAt: now - 60_000,
                failedAt: now - 30_000,
                targetGatewayId: "fail-s-deadbeef",
              },
            },
          },
        },
      },
      gateways: {
        "fail-s-deadbeef": durableGatewayRoot("fail-s-deadbeef", {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "s",
          ownerUid: "failed",
          builderSlug: "failed",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-failed",
            generation: 1,
            claimedByUid: "failed",
          },
          retirementClaim: { operationId: "placement-retire-failed-fail-s-deadbeef" },
        }),
      },
      operations: {
        "placement-retire-failed-fail-s-deadbeef": {
          kind: "retire-gateway",
          status: "running",
          input: { gatewayId: "fail-s-deadbeef" },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);

    expect(fleet.body.disposableCapacity).toMatchObject({
      parkedUsers: 1,
      byLifecycle: {
        requested: 1,
        failed: 1,
        parked: 1,
      },
      failedUsers: 1,
      staleActivations: 1,
    });
    expect(fleet.body.disposableCapacity.oldestActivationAgeMs).toBeGreaterThanOrEqual(
      20 * 60_000,
    );
  });

  it("does not revive stale bare runtime state when an existing root is malformed", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-alice": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      gateways: {
        default: {
          gatewayId: "default",
          latestRelease: 1,
          desiredRelease: 1,
          desiredStatus: "running",
          status: "ready",
          mountedCustomers: ["alice"],
        },
      },
      glmGateways: {
        default: {
          gatewayId: "default",
          desiredStatus: "running",
          gatewayClass: "shared",
          heartbeat: { status: "ready", mountedCustomers: ["alice"] },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);
    expect(fleet.body.gateways).toEqual([]);

    const placement = await request(app).get("/placement").expect(200);
    expect(placement.body.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "default-gateway-missing" })]),
    );
    expect(placement.body.users).toEqual([
      expect.objectContaining({
        id: "uid-alice",
        mountedGatewayId: null,
        driftState: "missing-gateway",
      }),
    ]);
  });

  it("keeps the durable gateway ID while reading telemetry from its exact live revision", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-alice": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      gateways: {
        default: durableGatewayRoot("default", {
          liveRelease: 1,
        }),
      },
      glmGateways: {
        default: {
          docKind: "runtime",
          gatewayId: "default",
          release: 1,
          lifecycle: "serving",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: {
            status: "ready",
            mountedCustomers: ["alice"],
            version: "1234567",
            lastHeartbeatAt: Date.now(),
            startedAt: 500,
          },
          lastError: { message: null, at: null },
        },
      },
    });

    const fleet = await request(app).get("/gateways").expect(200);
    expect(fleet.body.gateways).toEqual([
      expect.objectContaining({
        gatewayId: "default",
        status: "ready",
        mountedUsers: ["alice"],
      }),
    ]);

    const placement = await request(app).get("/placement").expect(200);
    expect(placement.body.warnings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "default-gateway-missing" })]),
    );
    expect(placement.body.users).toEqual([
      expect.objectContaining({
        id: "uid-alice",
        assignedGatewayId: "default",
        mountedGatewayId: "default",
        driftState: "healthy",
      }),
    ]);

    const distribution = await request(app).get("/user-distribution").expect(200);
    expect(distribution.body.perGateway).toEqual([
      expect.objectContaining({
        gatewayId: "default",
        status: "ready",
        assignedCount: 1,
        mountedCount: 1,
      }),
    ]);

    const details = await request(app).get("/gateways/default/details").expect(200);
    expect(details.body.mountedUsers).toEqual([
      expect.objectContaining({ uid: "uid-alice", slug: "alice" }),
    ]);
  });

  it("excludes retired gateways from the user distribution", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {},
      gateways: {
        default: durableGatewayRoot("default", { liveRelease: 1 }),
        "alice-s-deadbeef": durableGatewayRoot("alice-s-deadbeef", {
          desiredStatus: "retired",
          profile: "builder",
          gatewayClass: "builder",
          imageProfile: "builder",
          sizingTier: "s",
          ownerUid: "uid-alice",
          builderSlug: "alice",
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-old",
            generation: 1,
            claimedByUid: "uid-alice",
          },
        }),
      },
    });

    const distribution = await request(app).get("/user-distribution").expect(200);

    expect(
      distribution.body.perGateway.map((row: { gatewayId: string }) => row.gatewayId),
    ).toEqual(["default"]);
  });

  it("renders one fleet entry per durable gateway from its bare-id runtime doc", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {},
      gateways: {
        default: durableGatewayRoot("default", {
          latestRelease: 2,
          desiredRelease: 2,
          liveRelease: 2,
        }),
        walter: durableGatewayRoot("walter", {
          latestRelease: 2,
          desiredRelease: 2,
          liveRelease: 2,
        }),
      },
      glmGateways: {
        walter: {
          docKind: "runtime",
          gatewayId: "walter",
          release: 2,
          lifecycle: "serving",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: ["ceckert"] },
          lastError: { message: null, at: null },
        },
        default: {
          docKind: "runtime",
          gatewayId: "default",
          release: 2,
          lifecycle: "serving",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: ["alice"] },
          lastError: { message: null, at: null },
        },
      },
    });

    const res = await request(app).get("/gateways").expect(200);

    expect(res.body.gateways.map((gateway: { gatewayId: string }) => gateway.gatewayId).sort()).toEqual([
      "default",
      "walter",
    ]);
  });

  it("counts intentionally paused gateways separately from unreachable gateways", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {},
      gateways: {
        default: durableGatewayRoot("default", { liveRelease: 1 }),
        sleeper: durableGatewayRoot("sleeper", { desiredStatus: "paused", liveRelease: 1 }),
      },
      glmGateways: {
        default: {
          docKind: "runtime",
          gatewayId: "default",
          release: 1,
          lifecycle: "serving",
          desiredStatus: "running",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: [], lastHeartbeatAt: Date.now() },
        },
        sleeper: {
          docKind: "runtime",
          gatewayId: "sleeper",
          release: 1,
          lifecycle: "serving",
          desiredStatus: "paused",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: { status: "ready", mountedCustomers: [], lastHeartbeatAt: 1 },
        },
      },
    });

    const res = await request(app).get("/gateways").expect(200);

    expect(res.body.stats.gateways).toEqual({
      total: 2,
      ready: 1,
      paused: 1,
      unreachable: 0,
    });
  });

  it("reports the bare openclaw version from a verbatim `openclaw --version` heartbeat", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {},
      gateways: { default: durableGatewayRoot("default", { liveRelease: 1 }) },
      glmGateways: {
        default: {
          docKind: "runtime",
          gatewayId: "default",
          release: 1,
          lifecycle: "serving",
          desiredStatus: "running",
          helm: {
            imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway",
            imageTag: "1234567",
          },
          heartbeat: {
            status: "ready",
            mountedCustomers: [],
            lastHeartbeatAt: Date.now(),
            openclawVersion: "OpenClaw 2026.7.1 (2ddb9a9)",
          },
        },
      },
    });

    const res = await request(app).get("/gateways").expect(200);

    expect(res.body.gateways).toEqual([
      expect.objectContaining({ gatewayId: "default", openclawVersion: "2026.7.1" }),
    ]);
  });
});

describe("default placement", () => {
  it("labels in-flight operations with the user slug and uid", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-alice": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
      operations: {
        "operation-opaque-id": {
          kind: "migrate-user",
          status: "pending",
          inputUid: "uid-alice",
          createdAt: 1_000,
        },
      },
    });

    const res = await request(app).get("/placement").expect(200);

    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "migration-in-flight",
          operationId: "operation-opaque-id",
          message: "migrate-user alice (uid-alice) is pending",
        }),
      ]),
    );
  });

  it("excludes non-interactive accounts from the active user roster", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-active": {
          username: "active-user",
          provisioning: { openclaw: { slug: "active-user", gatewayId: "default" } },
        },
        "uid-scheduled": {
          username: "scheduled-user",
          accountLifecycle: { status: "deletion_scheduled", eraseAfter: 1_800_000_000_000 },
          provisioning: { openclaw: { slug: "scheduled-user", gatewayId: "default" } },
        },
        "uid-erasing": {
          username: "erasing-user",
          accountLifecycle: { status: "erasing" },
          provisioning: { openclaw: { slug: "erasing-user", gatewayId: "default" } },
        },
        "uid-suspended": {
          username: "suspended-user",
          accountLifecycle: { status: "suspended" },
          provisioning: { openclaw: { slug: "suspended-user", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
      operations: {
        "erase-operation": {
          kind: "erase-user",
          status: "pending",
          inputUid: "uid-scheduled",
          createdAt: 1_000,
        },
      },
    });

    const res = await request(app).get("/placement").expect(200);

    expect(res.body.users.map((user: { id: string }) => user.id)).toEqual([
      "uid-active",
    ]);
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "account-deletion-pending",
          uid: "uid-scheduled",
          slug: "scheduled-user",
          operationId: "erase-operation",
          expiresAt: 1_800_000_000_000,
          message: "scheduled-user (uid-scheduled) is scheduled for deletion",
        }),
      ]),
    );
  });

  it("warns when no shared gateway anchors default placement", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: {},
      users: {},
      gateways: { "gw-user": isolatedGatewayRoot("gw-user", "uid-owner", "owner") },
    });

    const res = await request(app).get("/placement").expect(200);

    expect(res.body.config).toEqual({
      defaultGatewayId: null,
      sharedGatewayIds: [],
    });
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        { code: "default-gateway-missing", severity: "error", message: "No default gateway is configured" },
      ]),
    );
    const userRecord = res.body.gateways.find(
      (g: { gatewayId: string }) => g.gatewayId === "gw-user",
    );
    expect(userRecord).toMatchObject({ assignableAsDefault: false, defaultTarget: false });
  });

  it("surfaces the DURABLE roster state + epoch from the assignment doc", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-a": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
      assignments: {
        default: {
          "uid-a": {
            uid: "uid-a",
            slug: "alice",
            gatewayId: "default",
            source: "migrate-user",
            state: "quiescing",
            epoch: 5,
          },
        },
      },
    });

    const res = await request(app).get("/placement").expect(200);
    const user = res.body.users.find((user: { id: string }) => user.id === "uid-a");
    expect(user).toMatchObject({
      rosterState: "quiescing",
      rosterRevisionId: "default",
      rosterEpoch: 5,
    });
  });

  it("projects draining gateway counts and rosters from durable assignments", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: {
        defaultGatewayId: "shared-a",
        sharedGatewayIds: ["shared-a", "shared-c"],
      },
      users: {
        "uid-alice": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "shared-a" } },
        },
      },
      gateways: {
        "shared-a": durableGatewayRoot("shared-a", { liveRelease: 1 }),
        "shared-c": durableGatewayRoot("shared-c", { liveRelease: 1, desiredStatus: "draining" }),
      },
      glmGateways: {
        "shared-a": runtimeDoc("shared-a", { status: "ready", mountedCustomers: [] }),
        "shared-c": runtimeDoc("shared-c", { status: "ready", mountedCustomers: ["alice"] }),
      },
      assignments: {
        "shared-c": {
          "uid-alice": {
            uid: "uid-alice",
            slug: "alice",
            gatewayId: "shared-c",
            source: "migrate-user",
            state: "serving",
            epoch: 7,
          },
        },
      },
    });

    const res = await request(app).get("/placement").expect(200);
    const draining = res.body.gateways.find(
      (gateway: { gatewayId: string }) => gateway.gatewayId === "shared-c",
    );

    expect(draining).toMatchObject({ assignedCount: 1, mountedCount: 1 });
    expect(res.body.users[0]).toMatchObject({
      assignedGatewayId: "shared-c",
      mountedGatewayId: "shared-c",
      rosterRevisionId: "shared-c",
      rosterState: "serving",
      rosterEpoch: 7,
    });
  });

  it("reports null roster fields for a user with no assignment doc (legacy/un-backfilled)", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default" },
      users: {
        "uid-a": {
          username: "alice",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
        },
      },
      glmGateways: { default: { gatewayClass: "shared", desiredStatus: "running" } },
    });

    const res = await request(app).get("/placement").expect(200);
    const user = res.body.users.find((user: { id: string }) => user.id === "uid-a");
    expect(user).toMatchObject({
      rosterState: null,
      rosterRevisionId: null,
      rosterEpoch: null,
    });
  });

  it("derives the shared pool from shared-class roots, not config/orchestrator", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: {},
      users: {},
      gateways: {
        "shared-1": durableGatewayRoot("shared-1"),
        "shared-0": durableGatewayRoot("shared-0", { desiredStatus: "paused" }),
        "shared-a": durableGatewayRoot("shared-a", { desiredStatus: "draining" }),
        walter: durableGatewayRoot("walter", {
          gatewayClass: "builder",
          ownerUid: "uid-walter",
          builderSlug: "walter",
        }),
      },
      glmGateways: {
        "shared-1": { gatewayClass: "shared", desiredStatus: "running" },
      },
    });

    const res = await request(app).get("/placement").expect(200);

    expect(res.body.config).toEqual({
      defaultGatewayId: "shared-1",
      sharedGatewayIds: ["shared-1", "shared-0", "shared-a"],
    });
  });

  it("ignores retired override data and exposes no override API", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "gw-default", overrides: { "uid-alice": "gw-canary" } },
      users: {
        "uid-alice": {
          username: "alice-old",
          email: "alice@example.com",
          provisioning: { openclaw: { slug: "alice" } },
        },
      },
      gateways: {
        "gw-default": durableGatewayRoot("gw-default"),
        "gw-canary": durableGatewayRoot("gw-canary"),
      },
    });

    const res = await request(app).get("/placement").expect(200);

    expect(res.body.config).toEqual({
      defaultGatewayId: "gw-canary",
      sharedGatewayIds: ["gw-canary", "gw-default"],
    });
    expect(res.body).not.toHaveProperty("overrides");
    expect(res.body.users[0]).not.toHaveProperty("overrideGatewayId");

    await request(app)
      .put("/placement/overrides/by-slug/alice")
      .send({ gatewayId: "gw-canary" })
      .expect(404);

    await request(app).delete("/placement/overrides/uid-alice").expect(404);
  });

  it("does not report pointer drift for an active disposable isolated runtime outside default placement", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default-blue" },
      users: {
        "uid-ceckert": {
          username: "ceckert",
          email: "ceckert@example.com",
          builderSubscription: { tier: "pro", status: "active" },
          provisioning: {
            openclaw: {
              slug: "ceckert",
              gatewayId: "walter-blue",
              activationLease: {
                leaseId: "lease-one",
                generation: 1,
                status: "active",
                targetGatewayId: "walter-blue",
                requestedAt: 1_000,
                activeAt: 2_000,
              },
            },
          },
        },
      },
      gateways: {
        "default-blue": durableGatewayRoot("default-blue", { liveRelease: 1 }),
        "walter-blue": isolatedGatewayRoot("walter-blue", "uid-ceckert", "ceckert", {
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-one",
            generation: 1,
            claimedByUid: "uid-ceckert",
          },
        }),
      },
      glmGateways: {
        "default-blue": runtimeDoc("default-blue"),
        "walter-blue": runtimeDoc("walter-blue", { status: "ready", mountedCustomers: ["ceckert"] }),
      },
    });

    const res = await request(app).get("/placement").expect(200);

    const user = res.body.users.find((user: { id: string }) => user.id === "uid-ceckert");
    expect(user).toMatchObject({
      id: "uid-ceckert",
      assignedGatewayId: "walter-blue",
      mountedGatewayId: "walter-blue",
      policyTargetGatewayId: "walter-blue",
      driftState: "healthy",
    });
    expect(user.warnings).toEqual([]);
    expect(res.body.driftSummary).toMatchObject({
      healthy: 1,
      "pointer-drift": 0,
    });
  });

  it("treats an assignment on a non-primary shared pool member as authoritative", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: {
        defaultGatewayId: "default-blue",
        sharedGatewayIds: ["default-blue", "default-green"],
      },
      users: {
        "uid-bob": {
          username: "bob",
          provisioning: { openclaw: { slug: "bob", gatewayId: "default-green" } },
        },
      },
      gateways: {
        "default-blue": durableGatewayRoot("default-blue", { liveRelease: 1 }),
        "default-green": durableGatewayRoot("default-green", { liveRelease: 1 }),
      },
      glmGateways: {
        "default-blue": runtimeDoc("default-blue", { status: "ready", mountedCustomers: [] }),
        "default-green": runtimeDoc("default-green", { status: "ready", mountedCustomers: ["bob"] }),
      },
    });

    const res = await request(app).get("/placement").expect(200);

    expect(res.body.users[0]).toMatchObject({
      policyTargetGatewayId: "default-green",
      assignedGatewayId: "default-green",
      mountedGatewayId: "default-green",
      driftState: "healthy",
    });
  });

  it("targets the Platform default when a stale owner-runtime assignment has no live lease", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "default-blue" },
      users: {
        "uid-stale": {
          username: "stale",
          provisioning: { openclaw: { slug: "stale", gatewayId: "stale-user" } },
        },
      },
      gateways: {
        "default-blue": durableGatewayRoot("default-blue", { liveRelease: 1 }),
        "stale-user": isolatedGatewayRoot("stale-user", "uid-stale", "stale", {
          allocation: {
            kind: "disposable-builder",
            schemaVersion: 1,
            leaseId: "lease-stale",
            generation: 1,
            claimedByUid: "uid-stale",
          },
        }),
      },
      glmGateways: {
        "default-blue": runtimeDoc("default-blue"),
        "stale-user": runtimeDoc("stale-user", { status: "ready", mountedCustomers: ["stale"] }),
      },
    });

    const res = await request(app).get("/placement").expect(200);

    expect(res.body.users[0]).toMatchObject({
      id: "uid-stale",
      policyTargetGatewayId: "default-blue",
      assignedGatewayId: "stale-user",
      driftState: "pointer-drift",
    });
  });
});

describe("account deletion revokes connector grants at the provider first", () => {
  function makeDeleteApp(
    users: Record<string, Record<string, unknown>>,
    otherDocs: Record<string, Record<string, unknown>> = {},
  ) {
    const calls: string[] = [];
    const remaining = { ...users };
    const added: Record<string, unknown>[] = [];
    const operationQueries: Array<{ uid: string; statuses: readonly string[] | undefined }> = [];
    const userId = (path: string) => /^users\/([^/]+)$/.exec(path)?.[1];
    const entries = (): Array<readonly [string, Record<string, unknown>]> => [
      ...Object.entries(remaining).map(([uid, row]) => [`users/${uid}`, row] as const),
      ...Object.entries(otherDocs),
    ];
    const documents: FixtureDocuments = {
      get: (path) => {
        const uid = userId(path);
        return uid === undefined ? otherDocs[path] : remaining[uid];
      },
      set: (path, row) => {
        calls.push(`set:${path}`);
        added.push(row);
        const uid = userId(path);
        if (uid === undefined) otherDocs[path] = row;
        else remaining[uid] = row;
      },
      delete: (path) => {
        calls.push(`delete:${path}`);
        const uid = userId(path);
        if (uid === undefined) delete otherDocs[path];
        else delete remaining[uid];
      },
      children: (collectionPath) => entries().flatMap(([path, row]) => {
        if (!path.startsWith(`${collectionPath}/`)) return [];
        const id = path.slice(collectionPath.length + 1);
        return id.includes("/") ? [] : [[id, row] as const];
      }),
      group: (collectionId) => entries().filter(([path]) => {
        const segments = path.split("/");
        return segments.length % 2 === 0 && segments[segments.length - 2] === collectionId;
      }),
    };
    const fixture = createJournalFixtureStore(journalRowsAtPaths(otherDocs), { documents, serializeTransactions: true });
    const recordingOperationQueries = (transaction: PlatformStateTransaction): PlatformStateTransaction => {
      const operations = transaction.journal.operations;
      const journal = {
        ...transaction.journal,
        operations: new Proxy(operations, {
          get: (target, method) => method === "listForUid"
            ? async (uid: string, filter: { statuses?: readonly string[] }) => {
              operationQueries.push({ uid, statuses: filter.statuses });
              return target.listForUid(uid, filter as Parameters<typeof target.listForUid>[1]);
            }
            : Reflect.get(target, method),
        }),
      };
      return new Proxy(transaction, {
        get: (target, property) => property === "journal" ? journal : Reflect.get(target, property),
      });
    };
    const store = new Proxy(fixture, {
      get: (target, property) => property === "transaction"
        ? <T>(options: { label: string; readOnly?: boolean }, body: (transaction: PlatformStateTransaction) => Promise<T>) =>
          target.transaction(options, (transaction) => body(recordingOperationQueries(transaction)))
        : Reflect.get(target, property),
    });
    const userDoc = (id: string) => ({
      get: async () => ({ id, exists: id in remaining, data: () => remaining[id] }),
    });
    const db = {
      collection: (name: string) => {
        expect(name).toBe("users");
        return {
          doc: userDoc,
          get: async () => ({
            docs: Object.entries(remaining).map(([id, data]) => ({ id, data: () => data })),
          }),
        };
      },
      doc: (path: string) => {
        const uid = userId(path);
        expect(uid).toBeDefined();
        return userDoc(uid!);
      },
    } as unknown as Firestore;
    const discoverProductContext = vi.fn(async (_uid: string) => ({}));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { uid?: string }).uid = "admin-1";
      next();
    });
    const deletionDeps = {
      suspendAuthUser: vi.fn(async (uid: string) => {
        calls.push(`suspend-auth:${uid}`);
      }),
      revokeConnectorGrantsForUser: vi.fn(async (uid: string) => {
        calls.push(`revoke:${uid}`);
      }),
    };
    addAdminFleetRoutes(app, {
      accounts: firestoreUserAccountReader(db),
      store,
      logger: { info: vi.fn(), warn: vi.fn() },
      provisionGatewayAuthSecret: vi.fn(async () => ({})),
      listGatewayBuilds: vi.fn(async () => []),
      discoverDeletionProductContext: discoverProductContext,
      ...deletionDeps,
    });
    return { app, store, discoverProductContext, deletionDeps, calls, added, remaining, otherDocs, operationQueries };
  }

  it("lets a user schedule their own deletion on the 90-day retention path, journaled under their uid", async () => {
    const { store, discoverProductContext, deletionDeps, calls, added, remaining, otherDocs } = makeDeleteApp({
      u2: { username: "acme", email: "c@d.co" },
    });
    discoverProductContext.mockResolvedValueOnce({ stripeCustomerIds: ["cus_1"] });
    const before = Date.now();

    const outcome = await scheduleUserSelfDeletion({ store, discoverProductContext, deps: deletionDeps, uid: "u2" });

    if (outcome.kind !== "scheduled") throw new Error(`unexpected outcome ${outcome.kind}`);
    expect(outcome.incompleteStep).toBeNull();
    expect(outcome.eraseAfter).toBeGreaterThanOrEqual(before + ACCOUNT_DELETION_RETENTION_MS);
    expect(remaining.u2.accountLifecycle).toMatchObject({
      status: "deletion_scheduled",
      eraseAfter: outcome.eraseAfter,
    });
    expect(added).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedBy: "u2", status: "suspension_pending", stripeCustomerIds: ["cus_1"] }),
      expect.objectContaining({ kind: "suspend-user", inputUid: "u2", createdBy: "u2" }),
      expect.objectContaining({ kind: "erase-user", inputUid: "u2", nextAttemptAt: outcome.eraseAfter }),
    ]));
    expect(Object.values(otherDocs)).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordType: "audit", actor: "u2", why: "User account deletion request", status: "completed" }),
    ]));
    expect(calls).toContain("suspend-auth:u2");
    expect(calls).toContain("revoke:u2");
    expect(discoverProductContext).toHaveBeenCalledWith("u2");
  });

  it("reports a user's deletion as scheduled even when the immediate sign-out fails, naming the step", async () => {
    const { store, discoverProductContext, deletionDeps, remaining } = makeDeleteApp({
      u2: { username: "acme", email: "c@d.co" },
    });
    deletionDeps.suspendAuthUser.mockRejectedValueOnce(new Error("identity platform unavailable"));

    const outcome = await scheduleUserSelfDeletion({ store, discoverProductContext, deps: deletionDeps, uid: "u2" });

    expect(outcome).toMatchObject({
      kind: "scheduled",
      incompleteStep: { name: "suspend-auth", error: expect.objectContaining({ message: "identity platform unavailable" }) },
    });
    expect(remaining.u2.accountLifecycle).toMatchObject({ status: "deletion_scheduled" });
  });

  it.each(["restoreFence", "sourceTransferFence"])(
    "tells a user their workspace is busy, not already deleted, while a %s holds it",
    async (fence) => {
      const { store, discoverProductContext, deletionDeps, calls, remaining } = makeDeleteApp({
        u1: { username: "alice", provisioning: { openclaw: { [fence]: { phase: "dispatched" }, gatewayId: "shared-1" } } },
      });

      await expect(scheduleUserSelfDeletion({ store, discoverProductContext, deps: deletionDeps, uid: "u1" }))
        .resolves.toEqual({ kind: "workspace-busy" });
      expect(remaining.u1.accountLifecycle).toBeUndefined();
      expect(calls).not.toContain("suspend-auth:u1");
    },
  );

  it.each(["legacy-pending", "legacy-running", "v2-pending", "v2-running"])("preserves forward migration custody before deletion admission: %s", async scenario => {
    const operationId = "move-1";
    const input = { uid: "u1", fromGatewayId: "shared-1", toGatewayId: "shared-2" };
    const user = { username: "alice", provisioning: { openclaw: { gatewayId: "shared-1" } } };
    const assignmentPath = "gateways/shared-1/assignments/u1";
    const assignment = { uid: "u1", slug: "alice", gatewayId: "shared-1", source: "migrate-user", state: "quiescing", epoch: 3 };
    const recovery = scenario.startsWith("legacy") ? { schedulerHandoff: {
      ...input, slug: "alice", migrationId: "mig-move-1:scheduler:1:claim:100",
      forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 3 },
    } } : { customerMigrationV2: { operationId, uid: "u1", sourceGatewayId: "shared-1", targetGatewayId: "shared-2", phase: "sourceQuiesced" } };
    const { store, discoverProductContext, deletionDeps, calls, remaining, otherDocs, added } = makeDeleteApp({ u1: user }, {
      [assignmentPath]: assignment,
      [`glmOperations/${operationId}`]: { kind: "migrate-user", status: scenario.endsWith("pending") ? "pending" : "running", inputUid: "u1", input, ...recovery },
    });
    await expect(scheduleUserSelfDeletion({ store, discoverProductContext, deps: deletionDeps, uid: "u1" })).resolves.toEqual({ kind: "workspace-busy" });
    expect(remaining.u1).toEqual(user);
    expect(otherDocs[assignmentPath]).toEqual(assignment);
    expect(added.some(row => row.kind === "suspend-user" || row.kind === "erase-user" || row.status === "suspension_pending")).toBe(false);
    expect(calls).not.toContain("suspend-auth:u1");
  });

  it("reports a deletion in progress when the user's suspension is already queued", async () => {
    const { store, discoverProductContext, deletionDeps, calls } = makeDeleteApp(
      { u2: { username: "acme" } },
      { "glmOperations/suspend-1": { kind: "suspend-user", status: "pending", inputUid: "u2" } },
    );

    await expect(scheduleUserSelfDeletion({ store, discoverProductContext, deps: deletionDeps, uid: "u2" }))
      .resolves.toEqual({ kind: "conflict" });
    expect(calls).not.toContain("suspend-auth:u2");
  });

  it("refuses a second self-deletion while one is already scheduled", async () => {
    const { store, discoverProductContext, deletionDeps, calls } = makeDeleteApp({
      u2: { username: "acme", accountLifecycle: { status: "deletion_scheduled", deletionId: "d1" } },
    });

    await expect(scheduleUserSelfDeletion({ store, discoverProductContext, deps: deletionDeps, uid: "u2" }))
      .resolves.toEqual({ kind: "conflict" });
    expect(calls).not.toContain("suspend-auth:u2");
  });

  it("reads only a user's in-flight operations, never their terminal history", async () => {
    const history = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `glmOperations/failed-${index}`,
        { kind: "migrate-user", status: "failed", inputUid: "u2" },
      ]),
    );
    const { app, operationQueries } = makeDeleteApp(
      { u2: { username: "acme", email: "c@d.co" } },
      history,
    );

    await request(app).post("/users/u2/delete").expect(202);

    expect(operationQueries).toEqual([{ uid: "u2", statuses: ["pending", "running"] }]);
  });

  it.each(["failed", "succeeded"])("refuses unassignment after a restore operation is %s while its fence remains", async (status) => {
    const user = { username: "alice", provisioning: { openclaw: { gatewayId: "shared-1", restoreFence: { operationId: "restore-1", phase: "dispatched" } } } };
    const assignmentPath = "gateways/shared-1/assignments/u1";
    const assignment = { uid: "u1", slug: "alice", gatewayId: "shared-1", source: "migrate-user", state: "serving", epoch: 3, createdAt: 1, updatedAt: 2, updatedByOperationId: null };
    const { app, calls, remaining, otherDocs } = makeDeleteApp({ u1: user }, {
      [assignmentPath]: assignment,
      "glmOperations/restore-1": { kind: "migrate-user", status, inputUid: "u1", input: { uid: "u1" } },
    });

    const response = await request(app).post("/users/u1/unassign");

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/restore/);
    expect(remaining.u1).toEqual(user);
    expect(otherDocs[assignmentPath]).toEqual(assignment);
    expect(calls).not.toContain("set:users/u1");
    expect(calls).not.toContain(`delete:${assignmentPath}`);
  });

  it("restores the operator Park command without migrating a serving user", async () => {
    const user = { username: "alice", provisioning: { status: "complete", openclaw: { gatewayId: "shared-1", status: "complete", agentIds: ["octogee-alice-coach"] } } };
    const path = "gateways/shared-1/assignments/u1";
    const { app, remaining, otherDocs } = makeDeleteApp({ u1: user }, {
      [path]: { uid: "u1", slug: "alice", gatewayId: "shared-1", source: "repair", state: "serving", epoch: 3 },
    });
    await request(app).patch("/users/u1/placement").send({ managedBy: "operator", gatewayId: null }).expect(200);
    expect(storedOpenclaw(remaining.u1).managedBy).toBe("operator");
    expect(storedOpenclaw(remaining.u1).gatewayId).toBeUndefined();
    expect(storedOpenclaw(remaining.u1).agentIds).toEqual(["octogee-alice-coach"]);
    expect(otherDocs[path]).toBeUndefined();
    await request(app).patch("/users/u1/placement").send({ managedBy: "cowboy" }).expect(200);
    expect(storedOpenclaw(remaining.u1).managedBy).toBe("cowboy");
  });

  it("releases an old provisioned parked user through the current placement eligibility gate", async () => {
    const { app, remaining } = makeDeleteApp({ u1: { username: "alice", provisioning: { openclaw: { managedBy: "operator", status: "complete" } } } });
    await request(app).patch("/users/u1/placement").send({ managedBy: "cowboy" }).expect(200);
    expect(storedProvisioning(remaining.u1).status).toBe("complete");
    expect(storedOpenclaw(remaining.u1).managedBy).toBe("cowboy");
  });

  it("also pauses the user's dedicated gateway when parking it", async () => {
    const { app, otherDocs } = makeDeleteApp({ u1: { username: "alice", provisioning: { openclaw: { gatewayId: "builder-alice" } } } }, {
      "gateways/builder-alice": durableGatewayRoot("builder-alice", { gatewayClass: "builder", ownerUid: "u1", desiredStatus: "running" }),
      "gateways/builder-alice/assignments/u1": { uid: "u1", slug: "alice", gatewayId: "builder-alice", source: "repair", state: "serving", epoch: 3 },
    });
    await request(app).patch("/users/u1/placement").send({ managedBy: "operator", gatewayId: null }).expect(200);
    expect(otherDocs["gateways/builder-alice"].desiredStatus).toBe("paused");
  });

  it("retains dedicated source custody while parked and resumes that exact gateway", async () => {
    const lease = { leaseId: "lease-4", status: "active", generation: 4, targetGatewayId: "builder-alice" };
    const assignment = { uid: "u1", slug: "alice", gatewayId: "builder-alice", source: "repair", state: "serving", epoch: 3 };
    const { app, remaining, otherDocs, calls } = makeDeleteApp({ u1: { username: "alice", provisioning: { openclaw: { gatewayId: "builder-alice", activationLease: lease, status: "complete" } } } }, {
      "gateways/builder-alice": durableGatewayRoot("builder-alice", { gatewayClass: "builder", ownerUid: "u1", desiredStatus: "running" }),
      "gateways/builder-alice/assignments/u1": assignment,
    });
    await request(app).patch("/users/u1/placement").send({ managedBy: "operator", gatewayId: null }).expect(200);
    expect(otherDocs["gateways/builder-alice"].desiredStatus).toBe("paused");
    expect(otherDocs["gateways/builder-alice/assignments/u1"]).toEqual(assignment);
    expect(storedOpenclaw(remaining.u1).activationLease).toEqual(lease);
    expect(storedOpenclaw(remaining.u1).gatewayId).toBe("builder-alice");
    expect(calls).not.toContain("delete:gateways/builder-alice/assignments/u1");
    await request(app).patch("/users/u1/placement").send({ managedBy: "cowboy" }).expect(200);
    expect(otherDocs["gateways/builder-alice"].desiredStatus).toBe("running");
  });

  it("preserves the generation of a parked VM while holding its Shared agent offline", async () => {
    const lease = { leaseId: "parked", generation: 24, status: "parked", targetGatewayId: "builder-alice" };
    const { app, remaining } = makeDeleteApp({ u1: { username: "alice", provisioning: { openclaw: { gatewayId: "shared-1", activationLease: lease } } } });
    await request(app).patch("/users/u1/placement").send({ managedBy: "operator", gatewayId: null }).expect(200);
    expect(storedOpenclaw(remaining.u1).activationLease).toEqual(lease);
  });

  it("parks a user whose activation is requested: the hold does not read the lease, and leaves it as it is", async () => {
    const user = { username: "alice", provisioning: { openclaw: { gatewayId: "shared-1", activationLease: { leaseId: "requested", generation: 25, status: "requested" } } } };
    const { app, remaining } = makeDeleteApp({ u1: user });
    const res = await request(app).patch("/users/u1/placement").send({ managedBy: "operator", gatewayId: null }).expect(200);
    expect(res.body).toMatchObject({ uid: "u1", parked: true, managedBy: "operator" });
    expect(storedOpenclaw(remaining.u1)).toMatchObject({ managedBy: "operator", activationLease: user.provisioning.openclaw.activationLease });
  });

  it("parks a user while a lease has another gateway allocated for them, and leaves that gateway as it is", async () => {
    const user = { username: "alice", provisioning: { openclaw: { gatewayId: "shared-1", activationLease: { leaseId: "lease-4", status: "provisioning", generation: 4, targetGatewayId: "builder-alice" } } } };
    const { app, remaining, otherDocs } = makeDeleteApp({ u1: user }, { "gateways/builder-alice": durableGatewayRoot("builder-alice", { gatewayClass: "builder", ownerUid: "u1", desiredStatus: "running" }) });
    await request(app).patch("/users/u1/placement").send({ managedBy: "operator", gatewayId: null }).expect(200);
    expect(storedOpenclaw(remaining.u1)).toMatchObject({ managedBy: "operator", activationLease: user.provisioning.openclaw.activationLease });
    expect(otherDocs["gateways/builder-alice"].desiredStatus).toBe("running");
  });

  it.each(["foreign-owner", "runtime-fence", "retirement"])("does not bypass a dedicated gateway %s when parking", async reason => {
    const root = durableGatewayRoot("builder-alice", { gatewayClass: "builder", ownerUid: reason === "foreign-owner" ? "u2" : "u1", desiredStatus: "running", ...(reason === "runtime-fence" ? { runtimeRestartFence: { phase: "dispatched" } } : {}), ...(reason === "retirement" ? { retirementClaim: { phase: "claimed" } } : {}) });
    const user = { username: "alice", provisioning: { openclaw: { gatewayId: "builder-alice" } } };
    const { app, otherDocs, remaining } = makeDeleteApp({ u1: user }, { "gateways/builder-alice": root });
    await request(app).patch("/users/u1/placement").send({ managedBy: "operator", gatewayId: null }).expect(409);
    expect(remaining.u1).toEqual(user);
    expect(otherDocs["gateways/builder-alice"]).toEqual(root);
  });

  it.each(["pending", "running"])("refuses Park while a migration is %s", async status => {
    const user = { username: "alice", provisioning: { openclaw: { gatewayId: "shared-1" } } };
    const { app, remaining } = makeDeleteApp({ u1: user }, { "glmOperations/move": { kind: "migrate-user", status, inputUid: "u1" } });
    await request(app).patch("/users/u1/placement").send({ managedBy: "operator", gatewayId: null }).expect(409);
    expect(remaining.u1).toEqual(user);
  });

  it("refuses Park while terminal migration custody still quiesces the roster", async () => {
    const user = { username: "alice", provisioning: { openclaw: { gatewayId: "shared-1" } } };
    const { app, remaining } = makeDeleteApp({ u1: user }, { "gateways/shared-1/assignments/u1": { uid: "u1", slug: "alice", gatewayId: "shared-1", source: "repair", state: "quiescing", epoch: 3 } });
    await request(app).patch("/users/u1/placement").send({ managedBy: "operator", gatewayId: null }).expect(409);
    expect(remaining.u1).toEqual(user);
  });

  it.each(["restoreFence", "sourceTransferFence"])("keeps the existing %s protection on the restored Park command", async fence => {
    const user = { username: "alice", provisioning: { openclaw: { gatewayId: "shared-1", [fence]: { phase: "dispatched" } } } };
    const { app, remaining } = makeDeleteApp({ u1: user });
    await request(app).patch("/users/u1/placement").send({ managedBy: "operator", gatewayId: null }).expect(409);
    expect(remaining.u1).toEqual(user);
  });

  it("refuses suspension while an ambiguous restore holds user authority", async () => {
    const { app, calls, remaining } = makeDeleteApp({
      u1: { username: "alice", provisioning: { openclaw: { restoreFence: { phase: "dispatched" }, gatewayId: "shared-1" } } },
    });
    await request(app).post("/users/u1/delete").expect(409);
    expect(calls).not.toContain("suspend-auth:u1");
    expect(calls).not.toContain("revoke:u1");
    expect(remaining.u1.accountLifecycle).toBeUndefined();
  });

  it.each(["failed", "succeeded"])("refuses unassignment after a source transfer operation is %s while its fence remains", async (status) => {
    const user = { username: "alice", provisioning: { openclaw: { gatewayId: "shared-1", sourceTransferFence: { operationId: "restore-1", phase: "dispatched" } } } };
    const assignmentPath = "gateways/shared-1/assignments/u1";
    const assignment = { uid: "u1", slug: "alice", gatewayId: "shared-1", source: "migrate-user", state: "serving", epoch: 3, createdAt: 1, updatedAt: 2, updatedByOperationId: null };
    const { app, calls, remaining, otherDocs } = makeDeleteApp({ u1: user }, {
      [assignmentPath]: assignment,
      "glmOperations/restore-1": { kind: "migrate-user", status, inputUid: "u1", input: { uid: "u1" } },
    });

    const response = await request(app).post("/users/u1/unassign");

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/source transfer/);
    expect(remaining.u1).toEqual(user);
    expect(otherDocs[assignmentPath]).toEqual(assignment);
    expect(calls).not.toContain("set:users/u1");
    expect(calls).not.toContain(`delete:${assignmentPath}`);
  });

  it("refuses suspension while an ambiguous source transfer holds user authority", async () => {
    const { app, calls, remaining } = makeDeleteApp({
      u1: { username: "alice", provisioning: { openclaw: { sourceTransferFence: { phase: "dispatched" }, gatewayId: "shared-1" } } },
    });
    await request(app).post("/users/u1/delete").expect(409);
    expect(calls).not.toContain("suspend-auth:u1");
    expect(calls).not.toContain("revoke:u1");
    expect(remaining.u1.accountLifecycle).toBeUndefined();
  });

  it("schedules retention for a pre-provisioning account instead of deleting inline", async () => {
    const { app, calls } = makeDeleteApp({ u1: { email: "a@b.co" } });

    const res = await request(app).post("/users/u1/delete").expect(202);

    expect(res.body).toMatchObject({ status: "deletion_scheduled", slug: null });
    expect(calls).toContain("suspend-auth:u1");
    expect(calls).toContain("revoke:u1");
  });

  it("queues independent suspension and delayed erasure operations", async () => {
    const { app, calls, added } = makeDeleteApp({
      u2: { username: "acme", email: "c@d.co" },
    });

    const res = await request(app).post("/users/u2/delete").expect(202);

    expect(res.body).toMatchObject({ status: "deletion_scheduled", slug: "acme" });
    expect(added).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "suspend-user", inputUid: "u2" }),
      expect.objectContaining({ kind: "erase-user", inputUid: "u2" }),
    ]));
    expect(calls).toContain("suspend-auth:u2");
    expect(calls).toContain("revoke:u2");
  });

  it("stores the product's discovered context on the deletion job an admin schedules", async () => {
    const { app, added, discoverProductContext } = makeDeleteApp({
      u2: { username: "acme", email: "c@d.co" },
    });
    discoverProductContext.mockResolvedValueOnce({ stripeCustomerIds: ["cus_1"] });

    await request(app).post("/users/u2/delete").expect(202);

    expect(discoverProductContext).toHaveBeenCalledWith("u2");
    expect(added).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestedBy: "admin-1", status: "suspension_pending", stripeCustomerIds: ["cus_1"] }),
    ]));
  });

  it("atomically admits one deletion when two requests race for the same user", async () => {
    const { app, added } = makeDeleteApp({
      u2: { username: "acme", email: "c@d.co" },
    });

    const responses = await Promise.all([
      request(app).post("/users/u2/delete"),
      request(app).post("/users/u2/delete"),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(added.filter((data) => data.kind === "suspend-user")).toHaveLength(1);
    expect(added.filter((data) => data.kind === "erase-user")).toHaveLength(1);
  });

  it("admits deletion without reading or writing an unbounded public-document fan-out", async () => {
    const publicDocs = {
      "workspaces/acme": { ownerUid: "u2", ownerActive: true },
      "workspaces/acme/projects/project-one": { ownerUid: "u2", ownerActive: true },
      "posts/post-one": { authorUid: "u2", ownerActive: true },
      "feed/feed-one": { actorUid: "u2" },
      "stars/star-one": { target: { ownerUid: "u2" } },
      "follows/follow-one": { actorUid: "u2" },
    };
    const { app } = makeDeleteApp({ u2: { username: "acme" } }, publicDocs);

    await request(app).post("/users/u2/delete").expect(202);

    expect(publicDocs).toMatchObject({
      "workspaces/acme": { ownerUid: "u2", ownerActive: true },
      "workspaces/acme/projects/project-one": { ownerUid: "u2", ownerActive: true },
      "posts/post-one": { authorUid: "u2", ownerActive: true },
      "feed/feed-one": { actorUid: "u2" },
      "stars/star-one": { target: { ownerUid: "u2" } },
      "follows/follow-one": { actorUid: "u2" },
    });
  });

  it("does not revoke or delete when the user does not exist", async () => {
    const { app, calls } = makeDeleteApp({});

    await request(app).post("/users/ghost/delete").expect(404);

    expect(calls).toEqual([]);
  });

  it("marks a deletion admission conflict as a failed audit", async () => {
    const { app, otherDocs } = makeDeleteApp(
      { u2: { username: "acme", email: "c@d.co" } },
      {
        "glmOperations/existing": {
          kind: "suspend-user",
          status: "pending",
          inputUid: "u2",
        },
      },
    );

    await request(app).post("/users/u2/delete").expect(409);

    expect(Object.values(otherDocs)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordType: "audit",
        status: "failed",
        lifecycleStage: "action-failed",
      }),
    ]));
  });

  it("moves an already scheduled erasure to now only after an explicit eraseNow request", async () => {
    const { app, calls, added } = makeDeleteApp(
      {
        u3: {
          username: "later",
          accountLifecycle: {
            status: "deletion_scheduled",
            deletionId: "delete-3",
            eraseAfter: Date.now() + 90 * 24 * 60 * 60 * 1_000,
          },
        },
      },
      {
        "customerDeletionJobs/delete-3": {
          version: 1,
          uid: "u3",
          status: "hibernating",
          requestedAt: 1,
          eraseAfter: Date.now() + 90 * 24 * 60 * 60 * 1_000,
          erasureOperationId: "erase-3",
        },
        "glmOperations/erase-3": {
          kind: "erase-user",
          status: "pending",
        },
      },
    );

    const res = await request(app)
      .post("/users/u3/delete")
      .send({ eraseNow: true })
      .expect(202);

    expect(res.body).toMatchObject({
      status: "erasure_requested",
      deletionId: "delete-3",
      erasureOperationId: "erase-3",
    });
    expect(added).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountLifecycle: expect.objectContaining({ eraseAfter: expect.any(Number) }) }),
      expect.objectContaining({ eraseAfter: expect.any(Number) }),
      expect.objectContaining({ nextAttemptAt: expect.any(Number) }),
    ]));
    expect(calls).not.toContain("suspend-auth:u3");
    expect(calls).not.toContain("revoke:u3");
  });
});

describe("roll handoff progress on the fleet response", () => {
  const record = (slug: string, phase: string, status: string, at: number) =>
    ({ phase, status, at, migrationId: "surge-shared-blue-pod", slug, source: "pod-old" });

  it("shows a handoff while the roster holds the user out of serving or its last report failed, never a finished one", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {},
      gateways: { "shared-blue": durableGatewayRoot("shared-blue") },
      assignments: {
        "shared-blue": {
          u1: { uid: "u1", slug: "alice", gatewayId: "shared-blue", source: "onboarding", state: "quiescing", handoffProgress: [record("alice", "gate-source", "done", 1_000), record("alice", "transfer-and-verify", "running", 2_000)] },
          u2: { uid: "u2", slug: "bob", gatewayId: "shared-blue", source: "onboarding", state: "serving", handoffProgress: [record("bob", "gate-source", "failed", 3_000)] },
          u3: { uid: "u3", slug: "carol", gatewayId: "shared-blue", source: "onboarding", state: "serving", handoffProgress: [record("carol", "serving-handoff", "done", 4_000)] },
          u4: { uid: "u4", slug: "dora", gatewayId: "shared-blue", source: "onboarding", state: "serving" },
        },
      },
    });
    const fleet = await request(app).get("/gateways").expect(200);
    const gateway = fleet.body.gateways.find((g: { gatewayId: string }) => g.gatewayId === "shared-blue");
    expect(Object.keys(gateway.handoffProgress).sort()).toEqual(["alice", "bob"]);
    expect(gateway.handoffProgress.alice.map((r: { phase: string }) => r.phase)).toEqual(["gate-source", "transfer-and-verify"]);
  });
});

describe("operations history route", () => {
  function operationsApp(assignments: Record<string, Record<string, Record<string, unknown>>> = {}) {
    return mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {},
      gateways: { "shared-blue": durableGatewayRoot("shared-blue") },
      operations: {
        "old-running": { kind: "migrate-user", status: "running", createdAt: 1_000, input: { uid: "u1" }, steps: [] },
        "newer-pending": { kind: "rollout", status: "pending", createdAt: 3_000, input: { gatewayId: "shared-blue" }, steps: [] },
        "done": { kind: "migrate-user", status: "succeeded", createdAt: 2_000, input: { uid: "u2" }, steps: [] },
        "failed": { kind: "migrate-user", status: "failed", createdAt: 4_000, input: { uid: "u3" }, steps: [] },
        "rolled-back": { kind: "migrate-user", status: "rolled-back", createdAt: 5_000, input: { uid: "u4" }, steps: [] },
        "restart-failed": { kind: "restart-gateway", status: "failed", createdAt: 6_000, input: { gatewayId: "shared-blue" }, steps: [] },
      },
      assignments,
    });
  }
  const ids = (res: { body: { operations: Array<{ id: string }> } }) => res.body.operations.map((op) => op.id);

  it("returns only in-flight operations, newest first, when no roster entry points at a failure", async () => {
    const { app } = operationsApp();
    const res = await request(app).get("/operations?status=unresolved&limit=100").expect(200);
    expect(ids(res)).toEqual(["newer-pending", "old-running"]);
  });

  it("keeps a rolled-back or failed migration the roster still points at, however old the history window", async () => {
    const { app } = operationsApp({
      "shared-blue": {
        u4: { uid: "u4", slug: "dora", state: "serving", updatedByOperationId: "rolled-back" },
        u3: { uid: "u3", slug: "carol", state: "quiescing", updatedByOperationId: "failed" },
        u2: { uid: "u2", slug: "bob", state: "serving", updatedByOperationId: "done" },
        u1: { uid: "u1", slug: "alice", state: "migrating", updatedByOperationId: "old-running" },
        u5: { uid: "u5", slug: "erin", state: "serving", updatedByOperationId: "restart-failed" },
        u6: { uid: "u6", slug: "fay", state: "serving", updatedByOperationId: "surge-shared-blue-pod" },
      },
    });
    const res = await request(app).get("/operations?status=unresolved&limit=100").expect(200);
    expect(ids(res)).toEqual(["rolled-back", "failed", "newer-pending", "old-running"]);
  });

  it("returns every roster-pointed failure even when in-flight operations fill the limit", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {},
      gateways: { "shared-blue": durableGatewayRoot("shared-blue") },
      operations: {
        "old-failed": { kind: "migrate-user", status: "failed", createdAt: 10, input: { uid: "u1" }, steps: [] },
        ...Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
          `pending-${index}`,
          { kind: "rollout", status: "pending", createdAt: 1_000 + index, input: { gatewayId: "shared-blue" }, steps: [] },
        ])),
      },
      assignments: { "shared-blue": { u1: { uid: "u1", slug: "alice", gatewayId: "shared-blue", source: "onboarding", state: "serving", updatedByOperationId: "old-failed" } } },
    });
    const res = await request(app).get("/operations?status=unresolved&limit=100").expect(200);
    expect(res.body.operations).toHaveLength(101);
    expect(ids(res).at(-1)).toBe("old-failed");
  });

  it("caps unresolved results at the requested limit", async () => {
    const { app } = operationsApp();
    const res = await request(app).get("/operations?status=unresolved&limit=1").expect(200);
    expect(ids(res)).toEqual(["newer-pending"]);
  });

  it("rejects an unknown status filter", async () => {
    const { app } = operationsApp();
    await request(app).get("/operations?status=bogus").expect(400);
  });

  it("returns one operation with its steps and failure reason", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-a" },
      users: {},
      operations: {
        "op-move": {
          kind: "migrate-user",
          status: "failed",
          createdAt: 4_000,
          input: { uid: "u3" },
          error: "source drain timed out",
          steps: [{ name: "quiesce-source", status: "failed", error: "source drain timed out" }],
        },
      },
    });
    const res = await request(app).get("/operations/op-move").expect(200);
    expect(res.body.operation).toMatchObject({
      id: "op-move",
      kind: "migrate-user",
      status: "failed",
      error: "source drain timed out",
      steps: [{ name: "quiesce-source", status: "failed", error: "source drain timed out" }],
    });
  });

  it("returns 404 for an operation that does not exist", async () => {
    const { app } = operationsApp();
    await request(app).get("/operations/missing").expect(404);
  });

  it("filters by one status, newest first, capped at the limit", async () => {
    const { app } = operationsApp();
    const all = await request(app).get("/operations?status=failed&limit=100").expect(200);
    expect(ids(all)).toEqual(["restart-failed", "failed"]);
    const capped = await request(app).get("/operations?status=failed&limit=1").expect(200);
    expect(ids(capped)).toEqual(["restart-failed"]);
  });

  it("filters audited mutations by their own status alongside operations", async () => {
    const audit = (status: "completed" | "failed", createdAt: number) => ({
      recordType: "audit",
      schemaVersion: 1,
      status,
      lifecycleStage: status === "failed" ? "action-failed" : "action-completed",
      outcome: status,
      idempotencyKey: `key-${createdAt}`,
      mutationFingerprint: `fingerprint-${createdAt}`,
      mutation: { kind: "move-alias" },
      actor: "fleet-cli:operator",
      forced: false,
      what: "move release alias",
      why: "candidate verified",
      target: { gatewayId: "shared-blue" },
      preActionStatus: {},
      aliasPlan: [],
      createdAt,
      actionClaimId: "runner-1",
      actionStartedAt: createdAt,
      actionRecoveryCount: 0,
      completedAt: createdAt + 1,
      ...(status === "failed" ? { error: "alias move refused" } : {}),
    });
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {},
      gateways: { "shared-blue": durableGatewayRoot("shared-blue") },
      operations: {
        "failed": { kind: "migrate-user", status: "failed", createdAt: 4_000, input: { uid: "u3" }, steps: [] },
        "audit-failed": audit("failed", 7_000),
        "audit-completed": audit("completed", 8_000),
      },
    });
    const failed = await request(app).get("/operations?status=failed&limit=100").expect(200);
    expect(ids(failed)).toEqual(["audit-failed", "failed"]);
    const completed = await request(app).get("/operations?status=completed&limit=100").expect(200);
    expect(ids(completed)).toEqual(["audit-completed"]);
  });

  it("finds a status match older than the newest page of the journal", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {},
      gateways: { "shared-blue": durableGatewayRoot("shared-blue") },
      operations: {
        "old-failed": { kind: "migrate-user", status: "failed", createdAt: 10, input: { uid: "u1" }, steps: [] },
        ...Object.fromEntries(Array.from({ length: 150 }, (_, index) => [
          `done-${index}`,
          { kind: "rollout", status: "succeeded", createdAt: 1_000 + index, input: { gatewayId: "shared-blue" }, steps: [] },
        ])),
      },
    });
    const res = await request(app).get("/operations?status=failed&limit=5").expect(200);
    expect(ids(res)).toEqual(["old-failed"]);
  });
});

describe("release status route", () => {
  it("reports each gateway's release observation under a fleet summary", async () => {
    const { app } = mkAdminFleetRouteApp({
      config: { defaultGatewayId: "shared-blue" },
      users: {},
      gateways: { "shared-blue": durableGatewayRoot("shared-blue", { liveRelease: 1 }) },
    });
    const res = await request(app).get("/release-status").expect(200);
    expect(res.body.summary).toEqual({
      status: "incomplete",
      serving: 1,
      converged: 0,
      excluded: 0,
      blockers: ["shared-blue: missing-release"],
    });
    expect(res.body.gateways).toEqual([expect.objectContaining({
      gatewayId: "shared-blue",
      isDefault: true,
      desiredRelease: 1,
      liveRelease: 1,
      runtimeRelease: null,
      observation: "missing-release",
    })]);
  });
});
