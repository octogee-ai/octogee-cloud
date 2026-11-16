import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { addAdminFleetRoutes, createAdminFleetMutationRunner, respondToAdminFleetMutationError } from "./admin-fleet-router.js";
import { addAdminPlacementOwnerRoutes } from "./admin-placement-owner-router.js";
import type { AdminPlacementSharedCapabilities } from "./admin-placement-shared-router.js";
import { createPlacementAutomationGate } from "./placement-automation-handoff.js";
import { noUserAccounts } from "./user-account.js";

type Data = Record<string, unknown>;

const NOW = 1_762_500_000_000;
const ACTOR = "operator@example.com";

class RecordedDocuments extends Map<string, Data> {
  readonly events: string[] = [];

  override set(path: string, row: Data): this {
    this.events?.push(`set:${path}`);
    return super.set(path, row);
  }
}

let records = new RecordedDocuments();
let logs: string[] = [];

function seed(rows: Record<string, Data>) {
  records = new RecordedDocuments(Object.entries(rows));
  records.events.length = 0;
}

function store() {
  return createDocumentFixtureStore(records, { serializeTransactions: true });
}

function asOperator(server: express.Express) {
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = ACTOR;
    next();
  });
}

function app() {
  const server = express();
  asOperator(server);
  const fixture = store();
  addAdminPlacementOwnerRoutes(server, { store: fixture, journal: createAdminFleetMutationRunner(fixture), log: (message) => logs.push(message) });
  server.use(respondToAdminFleetMutationError);
  server.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return server;
}

const sharedCapabilities: AdminPlacementSharedCapabilities = {
  observeGatewayKubernetes: async () => null,
  platformArtifact: null,
  operationJournalRetentionMs: 1_000,
  operationFailureIsTransient: () => false,
  gatewayStartupUnavailable: () => false,
  sourceRecoveryForwardRetryable: () => false,
};

function fleetApp() {
  const server = express();
  asOperator(server);
  addAdminFleetRoutes(server, {
    accounts: noUserAccounts,
    store: store(),
    logger: { info: (message: string) => logs.push(message), warn: () => undefined },
    provisionGatewayAuthSecret: async () => ({}),
    listGatewayBuilds: async () => [],
    suspendAuthUser: async () => undefined,
    revokeConnectorGrantsForUser: async () => undefined,
    placementShared: sharedCapabilities,
  });
  server.use(respondToAdminFleetMutationError);
  return server;
}

function audits(): Data[] {
  return [...records.entries()].filter(([path]) => path.startsWith("glmOperations/audit-")).map(([, row]) => row);
}

function configWrites(): string[] {
  return records.events.filter((event) => event === "set:config/orchestrator");
}

const setOwner = (owner: unknown, query = "") => request(app()).post(`/placement-automation/owner${query}`).send({ owner });

beforeEach(() => {
  seed({});
  logs = [];
});

describe("GET /placement-automation", () => {
  it("answers the fleet controller by default", async () => {
    const res = await request(app()).get("/placement-automation").expect(200);

    expect(res.body).toEqual({ owner: "fleet-controller", yieldedAt: null, phase: "fleet-controller" });
  });

  it("answers a handoff the fleet controller has not yet yielded as pending", async () => {
    seed({ "config/orchestrator": { placementAutomationOwner: "client" } });

    expect((await request(app()).get("/placement-automation").expect(200)).body)
      .toEqual({ owner: "client", yieldedAt: null, phase: "handoff-pending" });
  });
});

describe("POST /placement-automation/owner", () => {
  it("switches the owner to the client, journals it and logs the change, leaving the yield to the fleet controller", async () => {
    const res = await setOwner("client").expect(200);

    expect(res.body).toEqual({ owner: "client", yieldedAt: null, phase: "handoff-pending" });
    expect(records.get("config/orchestrator")).toMatchObject({ placementAutomationOwner: "client" });
    expect(audits()).toEqual([expect.objectContaining({
      status: "completed",
      actor: ACTOR,
      mutation: { kind: "set-placement-automation-owner", owner: "client" },
      preActionStatus: { owner: "fleet-controller", yieldedAt: null, phase: "fleet-controller" },
    })]);
    expect(logs).toEqual([`[placement-automation] owner set from fleet-controller to client by ${ACTOR}; the fleet controller yields on its next pass`]);
  });

  it("answers setting the current owner with success and changes nothing", async () => {
    const res = await setOwner("fleet-controller").expect(200);

    expect(res.body).toEqual({ owner: "fleet-controller", yieldedAt: null, phase: "fleet-controller" });
    expect(configWrites()).toEqual([]);
    expect(audits()).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(logs).toEqual([]);
  });

  it("answers a repeated switch with the same result, keeping the recorded yield", async () => {
    seed({ "config/orchestrator": { placementAutomationOwner: "client", placementAutomationYieldedAt: NOW } });

    const first = await setOwner("client").expect(200);
    const second = await setOwner("client").expect(200);

    expect(first.body).toEqual({ owner: "client", yieldedAt: NOW, phase: "client" });
    expect(second.body).toEqual(first.body);
    expect(configWrites()).toEqual([]);
  });

  it("hands back to the fleet controller and clears the yield at once", async () => {
    seed({ "config/orchestrator": { placementAutomationOwner: "client", placementAutomationYieldedAt: NOW } });

    const res = await setOwner("fleet-controller").expect(200);

    expect(res.body).toEqual({ owner: "fleet-controller", yieldedAt: null, phase: "fleet-controller" });
    expect(records.get("config/orchestrator")?.placementAutomationYieldedAt ?? null).toBeNull();
    expect(logs).toEqual([`[placement-automation] owner set from client to fleet-controller by ${ACTOR}; the fleet controller resumes on its next pass`]);
  });

  it("plans a dry run without writing", async () => {
    const res = await setOwner("client", "?dryRun=true").expect(200);

    expect(res.body).toMatchObject({
      dryRun: true,
      plans: [expect.objectContaining({ kind: "set-placement-automation-owner", mutation: { kind: "set-placement-automation-owner", owner: "client" } })],
    });
    expect(records.events).toEqual([]);
  });

  it("answers a replay with the same Idempotency-Key with its audit instead of acting twice", async () => {
    await request(app()).post("/placement-automation/owner").set("Idempotency-Key", "flip-1").send({ owner: "client" }).expect(200);

    const replay = await request(app()).post("/placement-automation/owner").set("Idempotency-Key", "flip-1").send({ owner: "client" });

    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ auditId: expect.any(String), status: "completed" });
    expect(audits()).toHaveLength(1);
  });

  it.each([undefined, "", "operator", "Client", 1])("rejects the owner %j without writing", async (owner) => {
    const res = await setOwner(owner).expect(400);

    expect(res.body).toEqual({ error: "owner must be fleet-controller or client" });
    expect(records.events).toEqual([]);
  });
});

describe("the handoff through the Admin API", () => {
  const enqueue = () => request(fleetApp()).post("/users/uid-alice/placement-migrations").send({
    source: "continuous-placement-policy",
    slug: "alice",
    fromGatewayId: "shared-a",
    toGatewayId: "shared-b",
    operationId: "placement-0123456789abcdef0123456789abcdef",
    expectedTargetUsersAtMost: 5,
  });
  const yieldOnce = () => createPlacementAutomationGate({ store: store(), now: () => NOW, log: () => undefined, warn: () => undefined })
    .pass(async (turn) => turn);

  it("is mounted on every fleet router, with or without placement capabilities", async () => {
    const server = express();
    asOperator(server);
    addAdminFleetRoutes(server, {
      accounts: noUserAccounts,
      store: store(),
      logger: { info: () => undefined, warn: () => undefined },
      provisionGatewayAuthSecret: async () => ({}),
      listGatewayBuilds: async () => [],
      suspendAuthUser: async () => undefined,
      revokeConnectorGrantsForUser: async () => undefined,
    });

    expect((await request(server).get("/placement-automation").expect(200)).body.phase).toBe("fleet-controller");
  });

  it("keeps refusing the verbs after the switch until the fleet controller yields, and again at once after the hand-back", async () => {
    expect((await enqueue()).body.code).toBe("placement-owner");

    await request(fleetApp()).post("/placement-automation/owner").send({ owner: "client" }).expect(200);
    expect((await enqueue()).body.code).toBe("placement-owner");

    await yieldOnce();
    const owned = await enqueue();
    expect(owned.body.code).not.toBe("placement-owner");

    await request(fleetApp()).post("/placement-automation/owner").send({ owner: "fleet-controller" }).expect(200);
    expect((await enqueue()).body.code).toBe("placement-owner");
  });

  it("shows the client the owner, the yield and a migration the in-process pass left running", async () => {
    seed({
      "glmOperations/placement-0123456789abcdef0123456789abcdef": {
        kind: "migrate-user",
        status: "running",
        createdAt: NOW - 10_000,
        createdBy: "glm-controller-placement-policy",
        input: { uid: "uid-alice", fromGatewayId: "shared-a", toGatewayId: "shared-b", source: "continuous-placement-policy" },
      },
    });
    await request(fleetApp()).post("/placement-automation/owner").send({ owner: "client" }).expect(200);

    const pending = await request(fleetApp()).get("/fleet/state?sections=placementAutomation").expect(200);
    expect(pending.body.placementAutomation).toEqual({ owner: "client", yieldedAt: null, phase: "handoff-pending" });

    await yieldOnce();
    const handed = await request(fleetApp()).get("/fleet/state?sections=placementAutomation,migrations").expect(200);

    expect(handed.body.placementAutomation).toEqual({ owner: "client", yieldedAt: NOW, phase: "client" });
    expect(handed.body.migrations).toEqual([expect.objectContaining({
      id: "placement-0123456789abcdef0123456789abcdef",
      status: "running",
      createdBy: "glm-controller-placement-policy",
    })]);
  });
});
