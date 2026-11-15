import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { releasePayloadHash, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { SHARED_POOL_SCALER_CREATOR } from "@octogee/shared/types/shared-gateway-pool";
import { createAdminFleetMutationRunner } from "./admin-fleet-router.js";
import { addAdminSharedPoolRoutes } from "./admin-shared-pool-router.js";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";

type Data = Record<string, unknown>;

const records = new Map<string, Data>();
const NOW = 2_000_000;
const CONTROLLER_STARTED_AT = 100;
const PLATFORM: ReleasePayload = {
  imageRepository: "registry.example/gateway",
  imageTag: `abc1234@sha256:${"a".repeat(64)}`,
};
const PREVIOUS: ReleasePayload = {
  imageRepository: "registry.example/gateway",
  imageTag: `def5678@sha256:${"d".repeat(64)}`,
};

function app() {
  const store = createDocumentFixtureStore(records, { serializeTransactions: true });
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = "automation@example.iam.gserviceaccount.com";
    next();
  });
  addAdminSharedPoolRoutes(server, {
    store,
    platformArtifact: PLATFORM,
    controllerStartedAt: CONTROLLER_STARTED_AT,
    journal: createAdminFleetMutationRunner(store),
    now: () => NOW,
  });
  server.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return server;
}

function root(gatewayId: string, overrides: Data = {}): Data {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: SHARED_POOL_SCALER_CREATOR,
    updatedAt: 10,
    updatedBy: "test",
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
    allocation: null,
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    ...overrides,
  };
}

function release(gatewayId: string, payload: ReleasePayload): Data {
  return { gatewayId, release: 1, createdAt: 1, createdBy: "test", sourceRelease: null, note: null, payloadHash: releasePayloadHash(payload), payload };
}

function runtime(gatewayId: string, overrides: Data = {}): Data {
  return {
    docKind: "runtime",
    gatewayId,
    release: 1,
    lifecycle: "serving",
    helm: { imageRepository: PLATFORM.imageRepository, imageTag: PLATFORM.imageTag },
    heartbeat: { status: "ready", version: "abc1234", mountedCustomers: [], lastHeartbeatAt: NOW },
    ...overrides,
  };
}

function seedMember(gatewayId: string, overrides: Data = {}, payload: ReleasePayload = PLATFORM): void {
  records.set(`gateways/${gatewayId}`, root(gatewayId, overrides));
  records.set(`gateways/${gatewayId}/releases/1`, release(gatewayId, payload));
  records.set(`glmGateways/${gatewayId}`, runtime(gatewayId));
}

function seedAutomationState(actionSequence: number, replacements: Data[] = []): void {
  records.set("glmControllerState/sharedPoolScaler", { schemaVersion: 1, actionSequence, lastActionAt: 5, replacements });
}

function audits(): Data[] {
  return [...records.entries()].filter(([path]) => path.startsWith("glmOperations/audit-")).map(([, row]) => row);
}

beforeEach(() => {
  records.clear();
  records.set("config/orchestrator", { sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 4 } });
});

describe("GET /fleet/state", () => {
  it("reads users, gateways, assignments, runtimes, active operations and automation state in one answer", async () => {
    seedMember("shared-aaaaaaaaaaaa");
    seedMember("shared-bbbbbbbbbbbb", {}, PREVIOUS);
    seedAutomationState(3);
    records.set("glmOperations/pending-op", { kind: "migrate-user", status: "pending", createdBy: "x", createdAt: 1, input: { uid: "u1" }, steps: [] });
    records.set("glmOperations/done-op", { kind: "migrate-user", status: "succeeded", createdBy: "x", createdAt: 1, input: { uid: "u1" }, steps: [] });

    const res = await request(app()).get("/fleet/state").expect(200);

    expect(res.body.generatedAt).toBe(NOW);
    expect(res.body.fleetControllerStartedAt).toBe(CONTROLLER_STARTED_AT);
    expect(res.body.platformArtifactHash).toBe(releasePayloadHash(PLATFORM));
    expect(res.body.config.sharedGatewayAutoscaling).toMatchObject({ enabled: true, buildersPerGateway: 4 });
    expect(res.body.sharedPoolAutomation).toMatchObject({ actionSequence: 3 });
    expect(res.body.gateways.map((gateway: Data) => gateway.gatewayId).sort()).toEqual(["shared-aaaaaaaaaaaa", "shared-bbbbbbbbbbbb"]);
    expect(res.body.latestReleasePayloadHashes).toEqual({
      "shared-aaaaaaaaaaaa": releasePayloadHash(PLATFORM),
      "shared-bbbbbbbbbbbb": releasePayloadHash(PREVIOUS),
    });
    expect(res.body.runtimes).toHaveLength(2);
    expect(res.body.operations.map((operation: Data) => operation.id)).toEqual(["pending-op"]);
  });

  it("answers each user with only the placement fields and reads release hashes for shared gateways only", async () => {
    seedMember("shared-aaaaaaaaaaaa");
    seedMember("gw-isolated", { gatewayClass: "isolated", profile: "builder", ownerUid: "uid-a" });
    records.set("users/uid-a", {
      username: "alice",
      onboardingStep: "complete",
      mattermostUserId: "mm-1",
      accountLifecycle: { status: "active" },
      provisioning: { status: "complete", gitRepoUrl: "https://git.example/alice", openclaw: { gatewayId: "gw-isolated", slug: "alice", managedBy: "operator", greeting: { sent: true } } },
    });

    const res = await request(app()).get("/fleet/state").expect(200);

    expect(res.body.users).toEqual([{
      uid: "uid-a",
      slug: "alice",
      admitted: true,
      accountLifecycle: { status: "active" },
      provisioning: { status: "complete" },
      gateway: { gatewayId: "gw-isolated" },
      openclaw: { managedBy: "operator" },
      fences: {},
    }]);
    expect(Object.keys(res.body.latestReleasePayloadHashes)).toEqual(["shared-aaaaaaaaaaaa"]);
  });

  it("answers a malformed autoscaling dial as null instead of failing the read", async () => {
    records.set("config/orchestrator", { sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 1 } });

    const res = await request(app()).get("/fleet/state").expect(200);

    expect(res.body.config.sharedGatewayAutoscaling).toBeNull();
  });

  it("refuses an unknown operation status", async () => {
    await request(app()).get("/fleet/state?operationStatus=pending,bogus").expect(400);
  });
});

describe("POST /shared-gateways/:id/desired-status", () => {
  const send = (body: Data) => request(app()).post("/shared-gateways/shared-aaaaaaaaaaaa/desired-status").send({
    decision: "begin-drain",
    expectedUpdatedAt: 10,
    automationState: { expectedSequence: 3, replacements: [] },
    ...body,
  });

  it("changes the status, journals the change and advances the automation sequence in one write", async () => {
    seedMember("shared-aaaaaaaaaaaa");
    seedAutomationState(3);

    const res = await send({}).expect(200);

    expect(res.body).toEqual({
      gatewayId: "shared-aaaaaaaaaaaa",
      fromDesiredStatus: "running",
      toDesiredStatus: "draining",
      operationId: "shared-pool-scale-00000004",
      automationSequence: 4,
    });
    expect(records.get("gateways/shared-aaaaaaaaaaaa")).toMatchObject({ desiredStatus: "draining", updatedAt: NOW, updatedBy: SHARED_POOL_SCALER_CREATOR });
    expect(records.get("glmOperations/shared-pool-scale-00000004")).toMatchObject({
      kind: "scale-shared-member",
      status: "succeeded",
      origin: "automatic",
      createdBy: SHARED_POOL_SCALER_CREATOR,
      input: { gatewayId: "shared-aaaaaaaaaaaa", fromDesiredStatus: "running", toDesiredStatus: "draining", decision: "begin-drain" },
    });
    expect(records.get("glmControllerState/sharedPoolScaler")).toMatchObject({ actionSequence: 4, lastActionAt: NOW });
    expect(audits()).toEqual([expect.objectContaining({
      actor: "automation@example.iam.gserviceaccount.com",
      status: "completed",
      what: "change shared gateway desired status for automation",
    })]);
  });

  it.each([
    ["the automation sequence moved", () => seedAutomationState(4), {}],
    ["the gateway changed since it was read", () => seedAutomationState(3), { expectedUpdatedAt: 9 }],
    ["the gateway is not in the status the decision leaves", () => seedAutomationState(3), { decision: "resume-member" }],
    ["the assignment count changed", () => seedAutomationState(3), { expectedAssignmentCount: 1 }],
  ])("fails closed when %s", async (_name, arrange, body) => {
    seedMember("shared-aaaaaaaaaaaa");
    arrange();
    const before = structuredClone(records.get("gateways/shared-aaaaaaaaaaaa"));

    const res = await send(body).expect(409);

    expect(res.body.code).toBe("precondition-failed");
    expect(records.get("gateways/shared-aaaaaaaaaaaa")).toEqual(before);
    expect(records.has("glmOperations/shared-pool-scale-00000004")).toBe(false);
    expect(audits()).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("logs a refused precondition as a warning, not an error, and keeps its failed audit", async () => {
    seedMember("shared-aaaaaaaaaaaa");
    seedAutomationState(2);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await send({}).expect(409);

      const refused = warnings.mock.calls.map(([line]) => JSON.parse(String(line)) as Data)
        .find((line) => line.message === "fleet mutation refused");
      expect(refused).toMatchObject({ severity: "WARNING", error: expect.stringContaining("automation sequence is 2") });
      expect(errors).not.toHaveBeenCalled();
      expect(audits()).toEqual([expect.objectContaining({ status: "failed" })]);
    } finally {
      warnings.mockRestore();
      errors.mockRestore();
    }
  });

  it("refuses a shared gateway an operator added", async () => {
    seedMember("shared-aaaaaaaaaaaa", { createdBy: "operator:ada" });
    seedAutomationState(3);

    const res = await send({}).expect(409);

    expect(res.body.code).toBe("precondition-failed");
    expect(records.get("gateways/shared-aaaaaaaaaaaa")).toMatchObject({ desiredStatus: "running" });
  });

  it("creates the automation state when none exists yet", async () => {
    seedMember("shared-aaaaaaaaaaaa");

    await send({ automationState: { expectedSequence: null, replacements: [] } }).expect(200);

    expect(records.get("glmControllerState/sharedPoolScaler")).toMatchObject({ actionSequence: 1 });
    expect(records.has("glmOperations/shared-pool-scale-00000001")).toBe(true);
  });
});

describe("POST /shared-gateways", () => {
  it("adds a running shared gateway on the platform build and enqueues its add operation", async () => {
    seedMember("shared-aaaaaaaaaaaa");
    seedAutomationState(2);

    const res = await request(app()).post("/shared-gateways").send({
      gatewayId: "shared-cccccccccccc",
      reason: "platform-replacement",
      replacesGatewayId: "shared-aaaaaaaaaaaa",
      automationState: {
        expectedSequence: 2,
        replacements: [{ sourceGatewayId: "shared-aaaaaaaaaaaa", targetGatewayId: "shared-cccccccccccc", updatedAt: NOW }],
      },
    }).expect(202);

    expect(res.body).toMatchObject({ gatewayId: "shared-cccccccccccc", automationSequence: 3 });
    expect(records.get("gateways/shared-cccccccccccc")).toMatchObject({
      gatewayClass: "shared",
      desiredStatus: "running",
      createdBy: SHARED_POOL_SCALER_CREATOR,
      latestRelease: 1,
    });
    expect(records.get("gateways/shared-cccccccccccc/releases/1")).toMatchObject({ payload: PLATFORM });
    expect(records.get(`glmOperations/${res.body.operationId}`)).toMatchObject({
      kind: "add-gateway",
      status: "pending",
      origin: "automatic",
      createdBy: SHARED_POOL_SCALER_CREATOR,
      input: { gatewayId: "shared-cccccccccccc", source: "shared-pool-scaler", reason: "platform-replacement", replacesGatewayId: "shared-aaaaaaaaaaaa" },
    });
    expect(records.get("glmControllerState/sharedPoolScaler")).toMatchObject({
      actionSequence: 3,
      replacements: [{ sourceGatewayId: "shared-aaaaaaaaaaaa", targetGatewayId: "shared-cccccccccccc" }],
    });
  });

  it("keeps the last status change on record", async () => {
    records.set("glmControllerState/sharedPoolScaler", {
      schemaVersion: 1, actionSequence: 2, lastActionAt: 5, replacements: [], lastAction: { operationId: "shared-pool-scale-00000002" },
    });

    await request(app()).post("/shared-gateways").send({
      gatewayId: "shared-cccccccccccc",
      reason: "scale-out",
      automationState: { expectedSequence: 2, replacements: [] },
    }).expect(202);

    expect(records.get("glmControllerState/sharedPoolScaler")).toMatchObject({
      actionSequence: 3,
      lastActionAt: NOW,
      lastAction: { operationId: "shared-pool-scale-00000002" },
    });
  });

  it("writes nothing when the automation sequence moved", async () => {
    seedAutomationState(3);

    const res = await request(app()).post("/shared-gateways").send({
      gatewayId: "shared-cccccccccccc",
      reason: "scale-out",
      automationState: { expectedSequence: 2, replacements: [] },
    }).expect(409);

    expect(res.body.code).toBe("precondition-failed");
    expect(records.has("gateways/shared-cccccccccccc")).toBe(false);
  });

  it("refuses a replacement of a gateway automation did not add", async () => {
    seedAutomationState(3);

    const res = await request(app()).post("/shared-gateways").send({
      gatewayId: "shared-cccccccccccc",
      reason: "platform-replacement",
      replacesGatewayId: "shared-missing",
      automationState: { expectedSequence: 3, replacements: [] },
    });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "precondition-failed", error: "gateway shared-missing does not exist" });
    expect(records.has("gateways/shared-cccccccccccc")).toBe(false);
  });

  it("refuses a replacement without the gateway it replaces", async () => {
    const res = await request(app()).post("/shared-gateways").send({
      reason: "platform-replacement",
      automationState: { expectedSequence: null, replacements: [] },
    });

    expect(res.status).toBe(400);
    expect([...records.keys()].some((key) => key.startsWith("gateways/"))).toBe(false);
  });
});

describe("POST /shared-gateways/:id/retire", () => {
  it("claims the retirement of a paused automation gateway with a deterministic operation", async () => {
    seedMember("shared-aaaaaaaaaaaa", { desiredStatus: "paused" });
    seedAutomationState(3);

    const res = await request(app()).post("/shared-gateways/shared-aaaaaaaaaaaa/retire")
      .send({ expectedAutomationSequence: 3, expectedUpdatedAt: 10, expectedAssignmentCount: 0 }).expect(202);

    expect(res.body).toEqual({
      gatewayId: "shared-aaaaaaaaaaaa",
      fromDesiredStatus: "paused",
      toDesiredStatus: "retired",
      operationId: "shared-pool-retire-shared-aaaaaaaaaaaa",
    });
    expect(records.get("gateways/shared-aaaaaaaaaaaa")).toMatchObject({ desiredStatus: "retired" });
    expect(records.get("glmOperations/shared-pool-retire-shared-aaaaaaaaaaaa")).toMatchObject({
      kind: "retire-gateway",
      origin: "automatic",
      createdBy: SHARED_POOL_SCALER_CREATOR,
    });
  });

  it("keeps the gateway when it gained an assignment", async () => {
    seedMember("shared-aaaaaaaaaaaa", { desiredStatus: "paused" });
    seedAutomationState(3);
    records.set("gateways/shared-aaaaaaaaaaaa/assignments/u1", {
      uid: "u1", gatewayId: "shared-aaaaaaaaaaaa", slug: "u1", source: "repair", state: "serving", epoch: 0, createdAt: 1, updatedAt: 1, updatedByOperationId: null,
    });

    const res = await request(app()).post("/shared-gateways/shared-aaaaaaaaaaaa/retire")
      .send({ expectedAutomationSequence: 3, expectedUpdatedAt: 10, expectedAssignmentCount: 0 }).expect(409);

    expect(res.body.code).toBe("precondition-failed");
    expect(records.get("gateways/shared-aaaaaaaaaaaa")).toMatchObject({ desiredStatus: "paused" });
  });
});

describe("POST /shared-gateways/replacements/:sourceGatewayId/finish", () => {
  const replacement = { sourceGatewayId: "shared-aaaaaaaaaaaa", targetGatewayId: "shared-cccccccccccc", updatedAt: 1 };

  it("drops a replacement once the departed gateway is gone", async () => {
    seedMember("shared-cccccccccccc");
    seedAutomationState(5, [replacement]);

    await request(app()).post("/shared-gateways/replacements/shared-aaaaaaaaaaaa/finish")
      .send({ departedGatewayId: "shared-aaaaaaaaaaaa", expectedAutomationSequence: 5 }).expect(200);

    expect(records.get("glmControllerState/sharedPoolScaler")).toMatchObject({ actionSequence: 6, replacements: [] });
  });

  it("keeps the replacement while the departed gateway still exists", async () => {
    seedMember("shared-aaaaaaaaaaaa", { desiredStatus: "retired" });
    seedAutomationState(5, [replacement]);

    await request(app()).post("/shared-gateways/replacements/shared-aaaaaaaaaaaa/finish")
      .send({ departedGatewayId: "shared-aaaaaaaaaaaa", expectedAutomationSequence: 5 }).expect(409);

    expect(records.get("glmControllerState/sharedPoolScaler")).toMatchObject({ actionSequence: 5, replacements: [replacement] });
  });
});

describe("POST /shared-gateways/:id/add-operations/:operationId/complete", () => {
  function seedRunningAdd(startedAt = 2): void {
    records.set("glmOperations/add-op", {
      kind: "add-gateway",
      status: "running",
      createdBy: SHARED_POOL_SCALER_CREATOR,
      createdAt: 1,
      startedAt,
      gatewayId: "shared-aaaaaaaaaaaa",
      input: { gatewayId: "shared-aaaaaaaaaaaa", source: "shared-pool-scaler", imageTag: PLATFORM.imageTag },
      steps: [{ name: "helm", status: "running" }],
    });
  }

  it("completes an add whose gateway is serving and ready on the image it was added with", async () => {
    seedMember("shared-aaaaaaaaaaaa");
    seedRunningAdd();

    await request(app()).post("/shared-gateways/shared-aaaaaaaaaaaa/add-operations/add-op/complete").expect(200);

    expect(records.get("glmOperations/add-op")).toMatchObject({
      status: "succeeded",
      completedAt: NOW,
      output: { mintRecovery: "healthy-slot-runtime" },
      steps: [{ name: "helm", status: "done", completedAt: NOW }],
    });
  });

  it("leaves an add the running fleet controller claimed to its worker", async () => {
    seedMember("shared-aaaaaaaaaaaa");
    seedRunningAdd(CONTROLLER_STARTED_AT + 1);

    const res = await request(app()).post("/shared-gateways/shared-aaaaaaaaaaaa/add-operations/add-op/complete").expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", error: "operation was not claimed by a previous fleet controller" });
    expect(records.get("glmOperations/add-op")).toMatchObject({ status: "running" });
  });

  it("leaves the add running while the gateway is not ready", async () => {
    seedMember("shared-aaaaaaaaaaaa");
    records.set("glmGateways/shared-aaaaaaaaaaaa", runtime("shared-aaaaaaaaaaaa", {
      heartbeat: { status: "starting", version: "abc1234", mountedCustomers: [], lastHeartbeatAt: NOW },
    }));
    seedRunningAdd();

    const res = await request(app()).post("/shared-gateways/shared-aaaaaaaaaaaa/add-operations/add-op/complete").expect(409);

    expect(res.body.code).toBe("precondition-failed");
    expect(records.get("glmOperations/add-op")).toMatchObject({ status: "running" });
    expect(audits()).toEqual([expect.objectContaining({ status: "failed" })]);
  });
});
