import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createAdminFleetMutationRunner, respondToAdminFleetMutationError } from "./admin-fleet-router.js";
import { addAdminPlacementIsolatedRoutes, type AdminIsolatedCapabilities } from "./admin-placement-isolated-router.js";
import { initialGatewayReleaseDocuments } from "./gateway-live-release.js";
import { dsn } from "./platform-state/postgres/__tests__/fixtures/harness.js";
import { NOW, useUserFixture } from "./platform-state/postgres/__tests__/fixtures/users.js";
import type { PlatformStateStore } from "./platform-state/store.js";

const TARGET = "alice-xs-12345678";

function app(store: PlatformStateStore, readGatewayPodDiagnostics: AdminIsolatedCapabilities["readGatewayPodDiagnostics"] = vi.fn()) {
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
    capabilities: { namespace: "octogee-test", ensureAuthSecret: vi.fn(), readGatewayPodDiagnostics },
    log: vi.fn(),
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
