import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const SOURCE = "shared-source";
const UID = "uid-alice";
const POD_NAME = "octogee-gateway-shared-source-5bc59-p946t";
const POD_UID = "5c3cb6d0-ba45-4908-ac88-9136a92bedd9";
const OPERATION = "placement-move";
const MIGRATION = `mig-${OPERATION}`;
const NOW = 1_800_000_000_000;
const COACH = { agentId: "octogee-alice-coach", storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_agent_92c817cc770f466d" };
const SHELVED = { agentId: "octogee-alice-proj-shelved-coach", storeId: "1b7e0f4c-5c0d-4f43-9a55-0b8f1f6f2a10", schema: "octogee_agent_1b7e0f4c5c0d4f43" };

const root = (gatewayId: string, gatewayClass: "shared" | "isolated") => ({
  gatewayId, createdAt: NOW - 1_000, createdBy: "signup-placement", updatedAt: NOW - 1_000, updatedBy: "signup-placement",
  latestRelease: 1, desiredRelease: 1, liveRelease: null, desiredStatus: "running", configSchemaVersion: 1, profile: null,
  gatewayClass, imageProfile: gatewayClass === "shared" ? "standard" : "isolated",sizingTier: "s", gcpProject: null, gatewayContainerSecurityContext: null,
  serviceAccountName: `octogee-gw-${gatewayId}`, serviceAccount: null, builderAccess: null, modelBrokerLimits: null,
  ...(gatewayClass === "isolated"
    ? { ownerUid: UID, builderSlug: "alice", allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-alice", generation: 1, claimedByUid: UID } }
    : { ownerUid: null, builderSlug: null }),
});

async function sourceMoving(target: { gatewayId: string; gatewayClass: "shared" | "isolated" }, { quiesced = false } = {}) {
  const store = createDocumentFixtureStore({
    [`gateways/${SOURCE}`]: root(SOURCE, "shared"),
    [`gateways/${target.gatewayId}`]: root(target.gatewayId, target.gatewayClass),
    [`users/${UID}`]: { username: "alice", provisioning: { openclaw: { gatewayId: SOURCE, slug: "alice", status: "complete" } } },
  });
  await store.gateways.assignments.put({
    uid: UID, slug: "alice", gatewayId: SOURCE, source: "onboarding", epoch: 3, createdAt: NOW - 1_000, updatedAt: NOW - 1_000,
    ...(quiesced ? { state: "quiescing", updatedByOperationId: OPERATION } : { state: "serving", updatedByOperationId: null }),
  });
  await store.users.records.setFence(UID, "migration", { operationId: OPERATION, state: "moving", startedAt: NOW - 80 });
  await store.journal.operations.create({
    id: OPERATION, kind: "migrate-user", status: "running", origin: "automatic", createdBy: "glm-controller-placement-policy",
    createdAt: NOW - 100, startedAt: NOW - 40, completedAt: null, steps: [],
    input: { fromGatewayId: SOURCE, toGatewayId: target.gatewayId, uid: UID, userSlug: "alice", source: "continuous-placement-policy" },
  });
  for (const anchor of [COACH, SHELVED]) {
    await store.users.agentStores.put(UID, { kind: "agent", ...anchor, gatewayId: SOURCE, generation: null, assignmentEpoch: 3, recordedAt: NOW });
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: SOURCE, podName: POD_NAME, podUid: POD_UID };
    next();
  });
  app.use("/internal/fleet", createFleetBrokerRoutes({ store, now: () => NOW }));
  return (body: Record<string, unknown>) => request(app).post("/internal/fleet/agent-anchors/read")
    .send({ gatewayId: SOURCE, revisionId: SOURCE, slug: "alice", ...body });
}

describe.each([
  ["an isolated gateway", { gatewayId: "lin-s-target", gatewayClass: "isolated" as const }],
  ["another shared gateway", { gatewayId: "shared-target", gatewayClass: "shared" as const }],
])("a shared source moving its user to %s, before quiesce", (_label, target) => {
  it("is refused the migration-bound anchor read until the source is quiesced", async () => {
    const read = await sourceMoving(target);
    const response = await read({ uid: UID, migrationId: MIGRATION });
    expect(response.status).toBe(403);
  });

  it("is allowed the migration-bound anchor read once the source is quiesced", async () => {
    const read = await sourceMoving(target, { quiesced: true });
    const response = await read({ uid: UID, migrationId: MIGRATION });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("reads its assigned user's full anchor authority through its serving assignment", async () => {
    const read = await sourceMoving(target);
    const response = await read({ uid: UID });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.anchors).toEqual([COACH, SHELVED]);
    expect(response.body.assignment).toEqual({ uid: UID, epoch: 3, state: "serving" });
  });
});
