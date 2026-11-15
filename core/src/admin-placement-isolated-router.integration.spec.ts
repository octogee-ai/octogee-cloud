import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createAdminFleetMutationRunner, respondToAdminFleetMutationError } from "./admin-fleet-router.js";
import { addAdminPlacementIsolatedRoutes } from "./admin-placement-isolated-router.js";
import { dsn } from "./platform-state/postgres/__tests__/fixtures/harness.js";
import { NOW, useUserFixture } from "./platform-state/postgres/__tests__/fixtures/users.js";
import type { PlatformStateStore } from "./platform-state/store.js";

const TARGET = "alice-xs-12345678";

function app(store: PlatformStateStore) {
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
    capabilities: { namespace: "octogee-test", ensureAuthSecret: vi.fn(), readGatewayPodDiagnostics: vi.fn() },
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
