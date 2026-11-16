import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createAdminFleetMutationRunner, respondToAdminFleetMutationError } from "./admin-fleet-router.js";
import { addAdminPlacementIsolatedRoutes, type AdminIsolatedCapabilities } from "./admin-placement-isolated-router.js";
import { initialGatewayReleaseDocuments } from "./gateway-live-release.js";
import { dsn, operation } from "./platform-state/postgres/__tests__/fixtures/harness.js";
import { NOW, useUserFixture } from "./platform-state/postgres/__tests__/fixtures/users.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import { FIXTURE_SIZING_PROFILES } from "@octogee/core-testing/journal-store";
import {
  allocateIsolatedGateway,
  prepareIsolatedHome,
  requireStoredHomeReadiness,
  unauditedLifecycleMutations,
  type AllocateIsolatedGatewayInput,
  type HomeCapabilities,
} from "./isolated-gateway-lifecycle/index.js";
import { assertClientOwnsPlacementAutomation, placementOwnerRefusalBody } from "./placement-automation-owner.js";

const TARGET = "alice-xs-12345678";

const warn = vi.fn();

function app(
  store: PlatformStateStore,
  readGatewayPodDiagnostics: AdminIsolatedCapabilities["readGatewayPodDiagnostics"] = vi.fn(),
  sourceRecoveryPending: AdminIsolatedCapabilities["sourceRecoveryPending"] = () => false,
) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = "automation@example.iam.gserviceaccount.com";
    next();
  });
  addAdminPlacementIsolatedRoutes(server, {
    store,
    journal: createAdminFleetMutationRunner(store),
    accounts: { get: async () => null },
    capabilities: { namespace: "octogee-test", sourceRecoveryPending, ensureAuthSecret: vi.fn(), readGatewayPodDiagnostics },
    log: vi.fn(),
    warn,
    now: () => NOW + 5_000,
  });
  server.use(respondToAdminFleetMutationError);
  server.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return server;
}

describe.skipIf(!dsn)("PostgreSQL isolated verbs", () => {
  const fixture = useUserFixture();

  async function seed() {
    const { records, admitted, place, store } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await admitted("alice");
    await place("alice", "shared-blue");
    await records.setActivationLease("alice", {
      leaseId: "lease-one", generation: 1, status: "activating", targetGatewayId: TARGET,
      sourceGatewayId: "shared-blue", sourceAssignmentEpoch: 0, requestedAt: NOW, activationOperationId: `builder-activate-${TARGET}-g1`,
    }, { leaseId: null, generation: null });
    return store;
  }

  const advance = (store: PlatformStateStore, body: Record<string, unknown> = {}) => request(app(store))
    .post("/users/alice/activation-lease/advance")
    .send({ leaseId: "lease-one", generation: 1, fromStatus: "activating", toStatus: "active", ...body });

  const status = async () => (await fixture().records.get("alice"))!.activationLease!.status;

  it("refuses with placement-owner until the fleet controller yields, then advances and journals", async () => {
    const store = await seed();

    await advance(store).expect(409).expect((res) => expect(res.body.code).toBe("placement-owner"));
    expect(await status()).toBe("activating");

    await store.config.orchestrator.patch({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });
    await advance(store).set("Idempotency-Key", "tick-1").expect(200);
    expect(await status()).toBe("active");
    expect(await store.users.placementReceipts.get("alice", "lease-one", 1, "activated")).toMatchObject({ wakeDurationMs: 5_000 });

    await advance(store).set("Idempotency-Key", "tick-1").expect(409);
  });

  it("answers precondition-failed and writes nothing on a stale generation", async () => {
    const store = await seed();
    await store.config.orchestrator.patch({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });

    await advance(store, { generation: 2 }).expect(409).expect((res) => expect(res.body).toMatchObject({
      code: "precondition-failed", reason: "activation lease for alice changed",
    }));
    expect(await status()).toBe("activating");
    expect(await store.users.placementReceipts.get("alice", "lease-one", 1, "activated")).toBeNull();
  });
});

describe.skipIf(!dsn)("PostgreSQL isolated lease completion, failure and retirement", () => {
  const fixture = useUserFixture();
  const RETIREMENT = `placement-retire-alice-${TARGET}-g1`;

  async function seed(status: "activating" | "returning" | "parked") {
    const { records, admitted, place, store } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await admitted("alice");
    await place("alice", "shared-blue");
    await records.setActivationLease("alice", {
      leaseId: "lease-one", generation: 1, status, targetGatewayId: TARGET, builderSlug: "alice",
      sourceGatewayId: "shared-blue", sourceAssignmentEpoch: 0, requestedAt: NOW, activationOperationId: `builder-activate-${TARGET}-g1`,
    }, { leaseId: null, generation: null });
    const { gatewayDoc, releaseDoc } = initialGatewayReleaseDocuments({
      gatewayId: TARGET,
      config: {
        configSchemaVersion: 1, profile: null, gatewayClass: "isolated", imageProfile: "isolated", sizingTier: "s", gcpProject: null,
        gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
        ownerUid: "alice", builderSlug: "alice", modelBrokerLimits: null,
      },
      artifact: { imageRepository: "registry/images/octogee-gateway", imageTag: "753c212" },
      createdBy: "test",
      now: NOW,
      desiredStatus: "paused",
    });
    await store.transaction({ label: "seed isolated gateway" }, async (tx) => {
      await tx.gateways.roots.create({
        ...gatewayDoc,
        allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-one", generation: 1, claimedByUid: "alice" },
      });
      await tx.gateways.releases.createInitial(releaseDoc);
    });
    return store;
  }

  const yieldToClient = (store: PlatformStateStore) =>
    store.config.orchestrator.patch({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });
  const lease = async () => (await fixture().records.get("alice"))!.activationLease!;
  const complete = (store: PlatformStateStore, body: Record<string, unknown> = {}) => request(app(store))
    .post("/users/alice/activation-lease/complete").send({ leaseId: "lease-one", generation: 1, targetGatewayId: TARGET, ...body });
  const fail = (store: PlatformStateStore, body: Record<string, unknown> = {}) => request(app(store))
    .post("/users/alice/activation-lease/fail").send({ leaseId: "lease-one", generation: 1, targetGatewayId: TARGET, message: "prepare failed", ...body });
  const retire = (store: PlatformStateStore, body: Record<string, unknown> = {}) => request(app(store))
    .post(`/isolated-gateways/${TARGET}/retire-owned`).send({ ownerUid: "alice", generation: 1, leaseId: "lease-one", reason: "builder-returned", ...body });

  it("withholds failure cleanup while the activation still recovers its source, inside the verb's transaction", async () => {
    const store = await seed("activating");
    await yieldToClient(store);
    const activationId = `builder-activate-${TARGET}-g1`;
    await store.journal.operations.create(operation({
      id: activationId, kind: "migrate-user", status: "failed", startedAt: NOW, completedAt: NOW, schedulerHandoffReleased: false,
    }));
    const recovering: AdminIsolatedCapabilities["sourceRecoveryPending"] = (stored) =>
      stored.id === activationId && stored.schedulerHandoffReleased === false;
    const server = app(store, vi.fn(), recovering);
    const failLease = () => request(server).post("/users/alice/activation-lease/fail")
      .send({ leaseId: "lease-one", generation: 1, targetGatewayId: TARGET, message: "prepare failed" });
    const retireTarget = () => request(server).post(`/isolated-gateways/${TARGET}/retire-owned`)
      .send({ ownerUid: "alice", generation: 1, leaseId: "lease-one", reason: "activation-failed" });

    for (const refused of [await failLease().expect(409), await retireTarget().expect(409)]) {
      expect(refused.body).toMatchObject({ code: "precondition-failed", reasonCode: "source-recovery-pending" });
    }
    expect((await lease()).status).toBe("activating");
    expect((await store.gateways.roots.get(TARGET))?.desiredStatus).toBe("paused");

    await store.journal.operations.patch(activationId, { schedulerHandoffReleased: true });

    await failLease().expect(200);
    await retireTarget().expect(200);
    expect((await lease()).status).toBe("failed");
    expect((await store.gateways.roots.get(TARGET))?.desiredStatus).toBe("retired");
  });

  it("completes a returning lease only after the fleet controller yields, and writes the returned receipt", async () => {
    const store = await seed("returning");

    await complete(store).expect(409).expect((res) => expect(res.body.code).toBe("placement-owner"));
    expect((await lease()).status).toBe("returning");

    await yieldToClient(store);
    await complete(store, { targetGatewayId: "alice-xs-other" }).expect(409)
      .expect((res) => expect(res.body).toMatchObject({ code: "precondition-failed", reason: "returning activation lease for alice changed" }));
    expect(await store.users.placementReceipts.get("alice", "lease-one", 1, "returned")).toBeNull();

    await complete(store).expect(200);
    expect((await lease()).status).toBe("parked");
    expect(await store.users.placementReceipts.get("alice", "lease-one", 1, "returned"))
      .toMatchObject({ retirementOperationId: RETIREMENT });
  });

  it("fails an activating lease only after the fleet controller yields, under the canonical activation operation", async () => {
    const store = await seed("activating");

    await fail(store).expect(409).expect((res) => expect(res.body.code).toBe("placement-owner"));
    expect((await lease()).status).toBe("activating");

    await yieldToClient(store);
    await fail(store, { generation: 2 }).expect(409).expect((res) => expect(res.body.code).toBe("precondition-failed"));
    expect(await store.users.placementReceipts.get("alice", "lease-one", 1, "activation-failed")).toBeNull();

    await fail(store).expect(200);
    expect(await lease()).toMatchObject({ status: "failed", lastError: { operationId: `builder-activate-${TARGET}-g1` } });
  });

  it("fails under a journal operation of the user on the target, and answers 400 for another user's", async () => {
    const store = await seed("activating");
    await yieldToClient(store);
    await store.journal.operations.create(operation({ id: "move-in-7", kind: "migrate-user", status: "failed", inputUid: "alice", input: { uid: "alice", fromGatewayId: "shared-blue", toGatewayId: TARGET } }));
    await store.journal.operations.create(operation({ id: "move-bob", kind: "migrate-user", status: "failed", inputUid: "bob", input: { uid: "bob", fromGatewayId: "shared-blue", toGatewayId: TARGET } }));

    await fail(store, { operationId: "move-bob" }).expect(400);
    expect((await lease()).status).toBe("activating");

    await fail(store, { operationId: "move-in-7" }).expect(200);
    expect(await lease()).toMatchObject({ status: "failed", lastError: { operationId: "move-in-7" } });
  });

  it("retires the owned gateway only after the fleet controller yields and while the allocation matches", async () => {
    const store = await seed("parked");

    await retire(store).expect(409).expect((res) => expect(res.body.code).toBe("placement-owner"));

    await yieldToClient(store);
    await retire(store, { leaseId: "lease-two" }).expect(409)
      .expect((res) => expect(res.body).toMatchObject({ code: "precondition-failed", reason: `gateway ${TARGET} no longer matches isolated allocation for alice` }));
    expect((await store.gateways.roots.get(TARGET))!.desiredStatus).toBe("paused");
    expect(await store.journal.operations.get(RETIREMENT)).toBeNull();

    await retire(store).expect(200).expect((res) => expect(res.body).toEqual({ gatewayId: TARGET, operationId: RETIREMENT, retired: true }));
    expect(await store.gateways.roots.get(TARGET)).toMatchObject({ desiredStatus: "retired", retirementClaim: { operationId: RETIREMENT } });
    expect(await store.journal.operations.get(RETIREMENT)).toMatchObject({ kind: "retire-gateway", input: { reason: "builder-returned" } });
  });

  it("answers 400 for a telemetry fence on another user's finished operation, and retires behind the user's own return", async () => {
    const store = await seed("parked");
    await yieldToClient(store);
    const RETURN = `builder-return-${TARGET}-g1`;
    const finished = { kind: "migrate-user" as const, status: "succeeded" as const, startedAt: NOW, completedAt: NOW + 1_000 };
    await store.journal.operations.create(operation({ ...finished, id: "return-bob", inputUid: "bob", input: { uid: "bob", fromGatewayId: "bob-xs-1", toGatewayId: "shared-blue" } }));
    await store.journal.operations.create(operation({ ...finished, id: RETURN, inputUid: "alice", input: { uid: "alice", fromGatewayId: TARGET, toGatewayId: "shared-blue" } }));

    await retire(store, { telemetryFenceOperationId: "return-bob", telemetryFenceStatus: "succeeded" }).expect(400);
    expect((await store.gateways.roots.get(TARGET))!.desiredStatus).toBe("paused");
    expect(await store.journal.operations.get(RETIREMENT)).toBeNull();

    await retire(store, { telemetryFenceOperationId: RETURN, telemetryFenceStatus: "succeeded" }).expect(200);
    expect(await store.gateways.roots.get(TARGET)).toMatchObject({ desiredStatus: "retired", retirementClaim: { operationId: RETIREMENT } });
  });
});

describe.skipIf(!dsn)("PostgreSQL unreachable isolated gateway recovery", () => {
  const fixture = useUserFixture();
  const RECOVERY = `builder-recover-${TARGET}-g1`;
  const body = { ownerUid: "alice", leaseId: "lease-one", generation: 1, authoritativeGatewayId: "shared-blue", sourceUnavailable: true };

  async function seed() {
    const { records, admitted, place, store } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await admitted("alice");
    await place("alice", "shared-blue");
    const { gatewayDoc, releaseDoc } = initialGatewayReleaseDocuments({
      gatewayId: TARGET,
      config: {
        configSchemaVersion: 1, profile: null, gatewayClass: "isolated", imageProfile: "isolated", sizingTier: "s", gcpProject: null,
        gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
        ownerUid: "alice", builderSlug: "alice", modelBrokerLimits: null,
      },
      artifact: { imageRepository: "registry/images/octogee-gateway", imageTag: "753c212" },
      createdBy: "test",
      now: NOW,
      desiredStatus: "running",
    });
    await store.transaction({ label: "seed isolated gateway" }, async (tx) => {
      await tx.gateways.roots.create({
        ...gatewayDoc,
        allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-one", generation: 1, claimedByUid: "alice" },
      });
      await tx.gateways.releases.createInitial(releaseDoc);
    });
    await records.setActivationLease("alice", {
      leaseId: "lease-one", generation: 1, status: "returning", targetGatewayId: TARGET, returnReason: "source-unavailable",
      sourceGatewayId: "shared-blue", sourceAssignmentEpoch: 0, requestedAt: NOW,
    }, { leaseId: null, generation: null });
    await store.config.orchestrator.patch({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });
    return store;
  }

  const desiredStatus = async () => (await fixture().store.gateways.roots.get(TARGET))!.desiredStatus;
  const receipt = () => fixture().store.journal.recoveryReceipts.get(RECOVERY);

  it("keeps the reservation while the pods cannot be observed and completes it on the repeat call", async () => {
    const store = await seed();
    const diagnostics = vi.fn()
      .mockRejectedValueOnce(new Error("kubectl timed out"))
      .mockResolvedValueOnce({ status: "missing", totalPods: 0 });

    const waiting = await request(app(store, diagnostics)).post(`/isolated-gateways/${TARGET}/recover-unreachable`).send(body).expect(200);

    expect(waiting.body).toEqual({ gatewayId: TARGET, state: "waiting", reason: "observation-unknown", operationId: RECOVERY });
    expect(await desiredStatus()).toBe("paused");
    expect(await receipt()).toMatchObject({ status: "pending", kind: "recover-unreachable-disposable" });

    const recovered = await request(app(store, diagnostics)).post(`/isolated-gateways/${TARGET}/recover-unreachable`).send(body).expect(200);

    expect(recovered.body).toEqual({ gatewayId: TARGET, state: "recovered", operationId: RECOVERY });
    expect(await receipt()).toMatchObject({ status: "succeeded", recoveryReceipt: { schemaVersion: 1, pods: 0 } });
  });

  it("writes nothing when the reservation fence fails", async () => {
    const store = await seed();
    const diagnostics = vi.fn();

    await request(app(store, diagnostics)).post(`/isolated-gateways/${TARGET}/recover-unreachable`)
      .send({ ...body, authoritativeGatewayId: "shared-green" }).expect(409)
      .expect((res) => expect(res.body.code).toBe("precondition-failed"));

    expect(await desiredStatus()).toBe("running");
    expect(await receipt()).toBeNull();
    expect(diagnostics).not.toHaveBeenCalled();
  });
});

describe.skipIf(!dsn)("PostgreSQL isolated allocation home readiness", () => {
  const fixture = useUserFixture();
  const request = {
    uid: "alice", builderSlug: "alice", leaseId: "lease-one", generation: 1, sourceGatewayId: "shared-blue",
    sourceAssignmentEpoch: 0, sizingKey: "hobby", sizingTier: "s",
  } as AllocateIsolatedGatewayInput;

  async function seed() {
    const { records, admitted, place, store } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await admitted("alice");
    await place("alice", "shared-blue");
    await records.setActivationLease("alice", {
      leaseId: "lease-one", generation: 1, status: "requested", sourceGatewayId: "shared-blue", sourceAssignmentEpoch: 0,
      entitlementTier: "hobby", sizingTier: "s", requestedAt: NOW,
    }, { leaseId: null, generation: null });
    await store.config.orchestrator.patch({ sizingProfiles: FIXTURE_SIZING_PROFILES, placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });
    return store;
  }

  function allocate(store: PlatformStateStore, ensureAuthSecret = vi.fn(async () => undefined)) {
    return allocateIsolatedGateway({
      store,
      readSizingKey: async () => "hobby",
      requireOwner: async (transaction) => { await assertClientOwnsPlacementAutomation(transaction); },
      requireHomeReady: requireStoredHomeReadiness,
      mutations: unauditedLifecycleMutations,
      namespace: "octogee-test",
      ensureAuthSecret,
      now: () => NOW + 5_000,
      log: vi.fn(),
      sourceRecoveryPending: () => false,
    }, request);
  }

  it("refuses a VM-sized user before the auth secret until the stored preparation names the lease", async () => {
    const store = await seed();
    const ensureAuthSecret = vi.fn(async () => undefined);

    await expect(allocate(store, ensureAuthSecret)).rejects.toThrow("home for alice is not prepared for lease lease-one generation 1 sizing key hobby");
    expect(ensureAuthSecret).not.toHaveBeenCalled();

    await fixture().records.patch("alice", { home: { homeMigration: { id: "home-copy-1", phase: "complete", tier: "hobby", preparedFor: { leaseId: "lease-one", generation: 2, sizingKey: "hobby" } } } });
    await expect(allocate(store, ensureAuthSecret)).rejects.toThrow("home for alice is not prepared");

    await fixture().records.patch("alice", { home: { homeMigration: { id: "home-copy-1", phase: "complete", tier: "hobby", preparedFor: { leaseId: "lease-one", generation: 1, sizingKey: "hobby" } } } });
    await expect(allocate(store, ensureAuthSecret)).rejects.toThrow("isolated gateway source shared-blue is unavailable");
    expect(ensureAuthSecret).not.toHaveBeenCalled();
  });

  function homeWithoutSource() {
    return {
      environment: "test", subnetwork: "subnet", nativeZones: ["us-central1-a"],
      nativeZone: vi.fn(async () => null),
      inventory: vi.fn(async () => null),
      verifyStopped: vi.fn(async () => undefined),
      copy: { advance: vi.fn(), release: vi.fn(async () => true), abort: vi.fn(async () => true) },
      adopt: vi.fn(async () => true),
      removeStoppedHome: vi.fn(async () => true),
    } satisfies HomeCapabilities;
  }

  function prepare(store: PlatformStateStore, home: HomeCapabilities, overrides: Partial<AllocateIsolatedGatewayInput> = {}) {
    return prepareIsolatedHome({
      store,
      readSizingKey: async () => "hobby",
      requireOwner: async (transaction) => { await assertClientOwnsPlacementAutomation(transaction); },
      home,
      now: () => NOW + 5_000,
      log: vi.fn(),
    }, { ...request, ...overrides });
  }

  const homeMigration = async () => (await fixture().records.get("alice"))!.home?.homeMigration ?? null;

  it("refuses home preparation before any Compute Engine call while the fleet controller owns placement", async () => {
    const store = await seed();
    await store.config.orchestrator.patch({ placementAutomationOwner: "fleet-controller", placementAutomationYieldedAt: null });
    const home = homeWithoutSource();

    const refusal = await prepare(store, home).catch((error: unknown) => error);
    expect(placementOwnerRefusalBody(refusal)).toMatchObject({ code: "placement-owner" });
    expect(home.inventory).not.toHaveBeenCalled();
    expect(await homeMigration()).toBeNull();
  });

  it("refuses home preparation for a stale lease generation without writing", async () => {
    const store = await seed();
    const home = homeWithoutSource();

    await expect(prepare(store, home, { generation: 2 })).rejects.toThrow("home migration activation authority changed");
    expect(home.inventory).not.toHaveBeenCalled();
    expect(await homeMigration()).toBeNull();
  });

  it("records the lease it prepared for, which then satisfies the allocation home fence", async () => {
    const store = await seed();
    const ensureAuthSecret = vi.fn(async () => undefined);

    await expect(prepare(store, homeWithoutSource())).resolves.toEqual({ state: "ready" });

    expect(await homeMigration()).toEqual({ phase: "complete", preparedFor: { leaseId: "lease-one", generation: 1, sizingKey: "hobby" } });
    await expect(allocate(store, ensureAuthSecret)).rejects.toThrow("isolated gateway source shared-blue is unavailable");
  });
});
