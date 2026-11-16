import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { addAdminFleetRoutes, OPERATION_LOOKUP_MAX_IDS } from "./admin-fleet-router.js";
import type { AdminPlacementCapabilities } from "./admin-placement-router.js";
import type { UserAccount, UserAccountReader } from "./user-account.js";

type Row = Record<string, unknown>;

const ACTIVATION = "builder-activate-alice-xs-12345678-g1";
const RETURN = "builder-return-alice-xs-12345678-g1";

function operation(kind: string, createdBy: string, fields: Row = {}): Row {
  return { kind, status: "failed", createdBy, createdAt: 1, startedAt: 1, completedAt: 2, input: { uid: "uid-alice" }, steps: [], ...fields };
}

const SEED: Record<string, Row> = {
  [`${GLM_OPERATIONS_COLLECTION}/${ACTIVATION}`]: operation("migrate-user", "uid-admin", { schedulerHandoffReleased: false }),
  [`${GLM_OPERATIONS_COLLECTION}/${RETURN}`]: operation("migrate-user", "uid-other", { schedulerHandoffReleased: true }),
  [`${GLM_OPERATIONS_COLLECTION}/restart-1`]: operation("restart-gateway", "uid-admin", { gatewayId: "shared-a", input: { gatewayId: "shared-a" } }),
};

const placement: AdminPlacementCapabilities = {
  retirementFailedRetryably: () => false,
  schedulerHandoffAwaitingRelease: (stored) => (stored as unknown as Row).schedulerHandoffReleased === false,
  rearmedRetirementPatch: {},
};

function harness(options: { placement?: AdminPlacementCapabilities } = {}) {
  const emails: Record<string, string> = { "uid-admin": "admin@example.com", "uid-other": "other@example.com" };
  const getMany = vi.fn(async (uids: readonly string[]) =>
    new Map(uids.filter((uid) => emails[uid]).map((uid) => [uid, { uid, email: emails[uid] } as unknown as UserAccount])));
  const get = vi.fn(async (uid: string) => (await getMany([uid])).get(uid) ?? null);
  const accounts: UserAccountReader = { get, getMany, list: async () => new Map() };
  const app = express();
  app.use(express.json());
  addAdminFleetRoutes(app, {
    accounts,
    store: createDocumentFixtureStore(new Map(Object.entries(structuredClone(SEED)))),
    logger: { info: vi.fn(), warn: vi.fn() },
    provisionGatewayAuthSecret: vi.fn(async () => ({})),
    listGatewayBuilds: vi.fn(async () => []),
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
    ...(options.placement ? { placement: options.placement } : {}),
  });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return { app, getMany, get };
}

describe("POST /operations/lookup", () => {
  it("answers the operations that exist in the single-operation shape and names the ones that do not", async () => {
    const h = harness({ placement });

    const res = await request(h.app).post("/operations/lookup").send({ ids: [ACTIVATION, "missing-1", "restart-1", "missing-2"] }).expect(200);
    const single = await request(h.app).get(`/operations/${ACTIVATION}`).expect(200);

    expect(res.body.operations.map((entry: Row) => entry.id)).toEqual([ACTIVATION, "restart-1"]);
    expect(res.body.operations[0]).toEqual(single.body.operation);
    expect(res.body.missing).toEqual(["missing-1", "missing-2"]);
  });

  it("looks the actors up once for the whole batch", async () => {
    const h = harness({ placement });

    const res = await request(h.app).post("/operations/lookup").send({ ids: [ACTIVATION, RETURN, "restart-1"] }).expect(200);

    expect(res.body.operations.map((entry: Row) => entry.actorEmail)).toEqual(["admin@example.com", "other@example.com", "admin@example.com"]);
    expect(h.getMany).toHaveBeenCalledTimes(1);
    expect(h.get).not.toHaveBeenCalled();
  });

  it("marks migrate-user operations with their source recovery verdict", async () => {
    const res = await request(harness({ placement }).app).post("/operations/lookup").send({ ids: [ACTIVATION, RETURN, "restart-1"] }).expect(200);

    expect(res.body.operations.map((entry: Row) => entry.sourceRecoveryPending)).toEqual([true, false, undefined]);
  });

  it("leaves the verdict absent without the placement capability", async () => {
    const res = await request(harness().app).post("/operations/lookup").send({ ids: [ACTIVATION] }).expect(200);

    expect(res.body.operations[0]).not.toHaveProperty("sourceRecoveryPending");
  });

  it.each([
    ["no ids", {}],
    ["an empty list", { ids: [] }],
    ["a non-string id", { ids: [ACTIVATION, 7] }],
    ["an empty id", { ids: [""] }],
    ["a repeated id", { ids: [ACTIVATION, ACTIVATION] }],
    ["more ids than the bound", { ids: Array.from({ length: OPERATION_LOOKUP_MAX_IDS + 1 }, (_, index) => `op-${index}`) }],
  ])("answers 400 for %s", async (_name, body) => {
    const res = await request(harness().app).post("/operations/lookup").send(body).expect(400);

    expect(res.body.error).toBe(`ids must be an array of 1 to ${OPERATION_LOOKUP_MAX_IDS} distinct non-empty strings`);
  });

  it("accepts exactly the bound", async () => {
    const ids = Array.from({ length: OPERATION_LOOKUP_MAX_IDS }, (_, index) => `op-${index}`);

    const res = await request(harness().app).post("/operations/lookup").send({ ids }).expect(200);

    expect(res.body.missing).toHaveLength(OPERATION_LOOKUP_MAX_IDS);
  });
});

describe("GET /operations/:id source recovery verdict", () => {
  it("marks a migrate-user operation whose source recovery is pending", async () => {
    const res = await request(harness({ placement }).app).get(`/operations/${ACTIVATION}`).expect(200);

    expect(res.body.operation).toMatchObject({ id: ACTIVATION, sourceRecoveryPending: true });
  });

  it("does not mark another kind of operation", async () => {
    const res = await request(harness({ placement }).app).get("/operations/restart-1").expect(200);

    expect(res.body.operation).not.toHaveProperty("sourceRecoveryPending");
  });
});
