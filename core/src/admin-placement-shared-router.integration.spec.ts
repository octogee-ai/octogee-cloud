import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createAdminFleetMutationRunner, respondToAdminFleetMutationError } from "./admin-fleet-router.js";
import { addAdminPlacementSharedRoutes } from "./admin-placement-shared-router.js";
import {
  continuousPlacementMigrationOperationId,
  enqueuePlacementMigrationInTransaction,
  isPlacementMigrationRefusal,
} from "./placement-migrations.js";
import { requireClientPlacementOwner } from "./placement-automation-owner.js";
import { barrier, dsn } from "./platform-state/postgres/__tests__/fixtures/harness.js";
import { NOW, useUserFixture, type UserFixture } from "./platform-state/postgres/__tests__/fixtures/users.js";
import type { PlatformStateStore } from "./platform-state/store.js";

const UID = "uid-alice";
const SLUG = "alice";
const SOURCE = "shared-a";
const TARGETS = ["shared-b", "shared-c"];

const migrationId = (toGatewayId: string) =>
  continuousPlacementMigrationOperationId({ uid: UID, builderSlug: SLUG, fromGatewayId: SOURCE, toGatewayId, sourceAssignmentEpoch: 0 });

function app(store: PlatformStateStore) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = "automation@example.iam.gserviceaccount.com";
    next();
  });
  addAdminPlacementSharedRoutes(server, {
    store,
    journal: createAdminFleetMutationRunner(store),
    now: () => NOW,
    observeGatewayKubernetes: async () => null,
    platformArtifact: null,
    operationJournalRetentionMs: 1_000,
    operationFailureIsTransient: () => false,
    gatewayStartupUnavailable: () => false,
    sourceRecoveryForwardRetryable: () => false,
  });
  server.use(respondToAdminFleetMutationError);
  server.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return server;
}

function enqueue(server: express.Express, toGatewayId: string) {
  return request(server).post(`/users/${UID}/placement-migrations`).send({
    slug: SLUG, fromGatewayId: SOURCE, toGatewayId, source: "continuous-placement-policy",
    operationId: migrationId(toGatewayId), expectedTargetUsersAtMost: 5,
  });
}

async function seed(fixture: UserFixture): Promise<void> {
  await fixture.store.config.orchestrator.patch({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW - 60_000 });
  await fixture.admitted(UID, SLUG);
  await fixture.assign(SOURCE, UID, SLUG);
  for (const target of TARGETS) await fixture.gateway(target);
}

function reclaimingAfterOwnerCheck(store: PlatformStateStore): PlatformStateStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "transaction") {
        const transaction: PlatformStateStore["transaction"] = async (options, run) => {
          const result = await target.transaction(options, run);
          if (options.label.endsWith(".owner")) {
            await target.config.orchestrator.patch({ placementAutomationOwner: "fleet-controller", placementAutomationYieldedAt: null });
          }
          return result;
        };
        return transaction;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe.skipIf(!dsn)("shared placement verbs on PostgreSQL", { timeout: 30_000 }, () => {
  const fixture = useUserFixture();

  it("lets only one of two migrations for the same user commit when both read before either writes", async () => {
    await seed(fixture());
    const bothRead = barrier(2);
    const attempts: number[] = [];
    const context = {
      requireOwner: requireClientPlacementOwner, now: NOW, platformArtifact: null, operationFailureIsTransient: () => false,
      gatewayStartupUnavailable: () => false, sourceRecoveryForwardRetryable: () => false,
    };
    const enqueueTo = (toGatewayId: string) => fixture().store.transaction({ label: "test.enqueue" }, (transaction) => {
      attempts.push(transaction.attempt);
      return enqueuePlacementMigrationInTransaction(transaction, context, {
        uid: UID, builderSlug: SLUG, fromGatewayId: SOURCE, toGatewayId,
        source: "continuous-placement-policy", operationId: migrationId(toGatewayId),
      }, async () => {
        if (transaction.attempt === 1) await bothRead();
      });
    });

    const outcomes = await Promise.allSettled(TARGETS.map(enqueueTo));

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(isPlacementMigrationRefusal(refused?.reason)).toBe(true);
    expect((refused?.reason as Error).message).toMatch(new RegExp(`^user ${UID} already has pending migration `));
    expect(Math.max(...attempts)).toBe(2);
    const active = await fixture().store.journal.operations.listForUid(UID, { kind: "migrate-user", statuses: ["pending", "running"] });
    expect(active).toHaveLength(1);
  });

  it("writes nothing when the fleet controller reclaims placement between the owner check and the write", async () => {
    await seed(fixture());

    const res = await enqueue(app(reclaimingAfterOwnerCheck(fixture().store)), TARGETS[0]).expect(409);

    expect(res.body).toEqual({ code: "placement-owner", error: "placement automation is owned by fleet-controller" });
    expect(await fixture().store.journal.operations.get(migrationId(TARGETS[0]))).toBeNull();
  });
});
