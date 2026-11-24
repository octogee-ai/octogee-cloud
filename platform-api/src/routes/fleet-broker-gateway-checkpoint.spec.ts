import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { workspaceDefaultAgentId } from "@octogee/shared/types/identity";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const GATEWAY_ID = "shared-blue";
const POD = { podUid: "pod-one", podName: "octogee-gateway-shared-blue-rs-one" };
const NOW = 1_000_000;
const AGENT = workspaceDefaultAgentId("alice");

function seed(fences: Record<string, unknown> = {}): Record<string, Record<string, unknown>> {
  return {
    [`gateways/${GATEWAY_ID}`]: {
      gatewayId: GATEWAY_ID, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test", latestRelease: 1,
      desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1, profile: null, gatewayClass: "shared",
      imageProfile: "standard", sizingTier: null, gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null,
      serviceAccount: null, builderAccess: null, ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null,
    },
    [`glmGateways/${GATEWAY_ID}`]: {
      docKind: "runtime", gatewayId: GATEWAY_ID, release: 1, lifecycle: "serving", createdAt: 1,
      createdByOperationId: null, helm: {}, heartbeat: {}, lastError: { message: null, at: null },
      kubernetes: { status: "ready", readyPods: 1, totalPods: 1, observedAt: NOW - 1_000,
        pods: [{ uid: POD.podUid, name: POD.podName, replicaSetUid: "rs", nodeName: "node", nodePool: "pool", instanceId: "1" }] },
    },
    "users/uid-alice": { provisioning: { ...fences, openclaw: { gatewayId: GATEWAY_ID, slug: "alice" } } },
    [`gateways/${GATEWAY_ID}/assignments/uid-alice`]: {
      uid: "uid-alice", slug: "alice", gatewayId: GATEWAY_ID, state: "serving", epoch: 3, source: "onboarding", createdAt: 1, updatedAt: 1,
    },
  };
}

function server(docs: Record<string, Record<string, unknown>>) {
  const app = express();
  app.use(express.json());
  app.use(((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: GATEWAY_ID, tokenSource: "ksa", ...POD } as never;
    next();
  }) as RequestHandler);
  app.use("/internal/fleet", createFleetBrokerRoutes({
    store: createDocumentFixtureStore(new RecordingDocuments(docs)),
    now: () => NOW,
  }));
  return app;
}

function scheduleCheckpoint(app: express.Express) {
  return request(app).post("/internal/fleet/schedule-checkpoint").send({
    gatewayId: GATEWAY_ID, uid: "uid-alice", assignmentEpoch: 3, observedAt: NOW - 100,
    snapshot: { version: 1, operationId: "checkpoint-alice", agentIds: [AGENT], jobs: [{ id: "job", agentId: AGENT }], scratch: [] },
  });
}

describe("gateway checkpoint routes", () => {
  it("acknowledges a checkpoint from the sole observed Shared writer", async () => {
    const response = await scheduleCheckpoint(server(seed()));
    expect(response.status).toBe(204);
  });

  it("names the reason a checkpoint is refused", async () => {
    const response = await scheduleCheckpoint(server(seed({ pendingNativeSchedulerRetirement: { uid: "uid-alice", slug: "alice" } }))).expect(409);
    expect(response.body).toEqual({ error: "schedule_checkpoint_writer_conflict", reason: "user_fenced" });
  });
});
