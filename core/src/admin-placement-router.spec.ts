import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { addAdminFleetRoutes, createAdminFleetMutationRunner, respondToAdminFleetMutationError } from "./admin-fleet-router.js";
import { addAdminPlacementRoutes, type AdminPlacementCapabilities } from "./admin-placement-router.js";
import { noUserAccounts } from "./user-account.js";

type Data = Record<string, unknown>;

const GATEWAY = "alice-xs-12345678";
const OWNER = "uid-alice";
const RETIREMENT = `placement-retire-${OWNER}-${GATEWAY}-g1`;
const RECOVERY = `builder-recover-${GATEWAY}-g1`;
const ACTIVATION = `builder-activate-${GATEWAY}-g1`;
const TARGET = { ownerUid: OWNER, allocationGeneration: 1 };
const REAPED = "reaped: op exceeded 15m running budget";

const capabilities: AdminPlacementCapabilities = {
  retirementFailedRetryably: (operation, gatewayId) =>
    operation.status === "failed" && typeof operation.error === "string" &&
    (operation.error.startsWith("reaped: ") || operation.error.endsWith(`Gateway ${gatewayId} still has database sessions`)),
  schedulerHandoffAwaitingRelease: (operation) => (operation as unknown as Data).schedulerHandoffReleased === false,
  rearmedRetirementPatch: { status: "pending", startedAt: null, completedAt: null, steps: [], error: { clear: true }, expireAt: { clear: true } },
};

class RecordedDocuments extends Map<string, Data> {
  readonly events: string[] = [];
  failingDelete: string | null = null;
  afterDelete: (path: string) => void = () => undefined;

  override set(path: string, row: Data): this {
    this.events?.push(`set:${path}`);
    return super.set(path, row);
  }

  override delete(path: string): boolean {
    if (path === this.failingDelete) throw new Error("root delete unavailable");
    if (this.has(path)) this.events.push(`delete:${path}`);
    const deleted = super.delete(path);
    this.afterDelete(path);
    return deleted;
  }
}

let records = new RecordedDocuments();

function app() {
  const store = createDocumentFixtureStore(records, { serializeTransactions: true });
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = "automation@example.iam.gserviceaccount.com";
    next();
  });
  addAdminPlacementRoutes(server, { ...capabilities, store, journal: createAdminFleetMutationRunner(store) });
  server.use(respondToAdminFleetMutationError);
  server.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return server;
}

function retiredRoot(overrides: Data = {}): Data {
  return {
    gatewayId: GATEWAY,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "retired",
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: "s",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: OWNER,
    builderSlug: "alice",
    modelBrokerLimits: null,
    preemption: null,
    allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-one", generation: 1, claimedByUid: OWNER },
    retirementClaim: { operationId: RETIREMENT, version: 1 },
    ...overrides,
  };
}

function owner(gatewayId: string, activationLease?: Data): Data {
  return { username: "alice", provisioning: { openclaw: { gatewayId, slug: "alice", ...(activationLease ? { activationLease } : {}) } } };
}

function seed(rows: Record<string, Data>): void {
  records = new RecordedDocuments(Object.entries(rows));
}

function deletableSeed(): Record<string, Data> {
  return {
    [`gateways/${GATEWAY}`]: retiredRoot(),
    [`glmOperations/${RETIREMENT}`]: { kind: "retire-gateway", status: "succeeded" },
    [`users/${OWNER}`]: owner("shared-blue"),
    [`glmOperations/${RECOVERY}`]: { kind: "recover-unreachable-disposable", status: "succeeded" },
    [`gatewayRecoveryReceipts/${RECOVERY}`]: { kind: "recover-unreachable-disposable", status: "succeeded" },
    [`gateways/${GATEWAY}/releases/1`]: { gatewayId: GATEWAY, release: 1, payload: { imageRepository: "registry.example/gateway", imageTag: "abc1234" } },
  };
}

function fleetEvents(): string[] {
  return records.events.filter((event) => !event.includes("glmOperations/audit-"));
}

function audits(): Data[] {
  return [...records.entries()].filter(([path]) => path.startsWith("glmOperations/audit-")).map(([, row]) => row);
}

const deleteRetired = (body: Data = TARGET) => request(app()).post(`/isolated-gateways/${GATEWAY}/delete-retired`).send(body);
const rearm = (body: Data = TARGET) => request(app()).post(`/isolated-gateways/${GATEWAY}/retirement/rearm`).send(body);

beforeEach(() => seed({}));

describe("GET /isolated-gateways/retired", () => {
  it("reports the facts the sweep decides on for each retired isolated gateway", async () => {
    seed({
      ...deletableSeed(),
      [`glmOperations/${ACTIVATION}`]: { kind: "migrate-user", status: "failed", schedulerHandoffReleased: false },
      [`users/uid-bob`]: owner("shared-blue", { leaseId: "lease-b", generation: 1, status: "parked", targetGatewayId: GATEWAY }),
      "gateways/shared-blue": retiredRoot({ gatewayId: "shared-blue", desiredStatus: "running", gatewayClass: "shared", ownerUid: null, allocation: null }),
    });

    const res = await request(app()).get("/isolated-gateways/retired").expect(200);

    expect(res.body).toEqual({
      gateways: [{
        gatewayId: GATEWAY,
        ownerUid: OWNER,
        allocationGeneration: 1,
        retirementOperation: { id: RETIREMENT, kind: "retire-gateway", status: "succeeded", placementRetirement: true, failedRetryably: false },
        unreleasedHandoffOperationId: ACTIVATION,
        ownerGatewayId: "shared-blue",
        activationLeases: [{ uid: "uid-bob", status: "parked" }],
      }],
    });
  });

  it("reports a retirement claimed by another operation as not the placement retirement", async () => {
    const operatorRetirement = "operator-retire-alice";
    seed({
      ...deletableSeed(),
      [`gateways/${GATEWAY}`]: retiredRoot({ retirementClaim: { operationId: operatorRetirement, version: 1 } }),
      [`glmOperations/${operatorRetirement}`]: { kind: "retire-gateway", status: "failed", error: REAPED },
    });

    const res = await request(app()).get("/isolated-gateways/retired").expect(200);

    expect(res.body.gateways[0].retirementOperation).toEqual({
      id: operatorRetirement, kind: "retire-gateway", status: "failed", placementRetirement: false, failedRetryably: true,
    });
  });

  it("leaves out gateways that are not retired isolated allocations and reads nothing else when there are none", async () => {
    seed({
      [`gateways/${GATEWAY}`]: retiredRoot({ desiredStatus: "running" }),
      "gateways/builder-alice": retiredRoot({ gatewayId: "builder-alice", allocation: null }),
    });

    const res = await request(app()).get("/isolated-gateways/retired").expect(200);

    expect(res.body).toEqual({ gateways: [] });
    expect(records.events).toEqual([]);
  });
});

describe("POST /isolated-gateways/:id/delete-retired", () => {
  it("deletes recovery residue and the root while retaining migration and retirement journals", async () => {
    const rows = deletableSeed();
    const completedRetirement = {
      kind: "retire-gateway", status: "succeeded", input: { gatewayId: GATEWAY }, completedAt: 4_500,
      expireAt: new Date(30 * 24 * 60 * 60_000),
    };
    rows[`glmOperations/${RETIREMENT}`] = completedRetirement;
    const activation = { kind: "migrate-user", status: "failed", rolledBack: true, steps: [{ name: "recover-source", status: "done" }] };
    rows[`glmOperations/${ACTIVATION}`] = activation;
    seed(rows);

    const res = await deleteRetired().expect(200);

    expect(res.body).toEqual({ gatewayId: GATEWAY, deleted: true, preparationCleared: false });
    const events = fleetEvents();
    expect(events.slice(0, 2).sort()).toEqual([
      `delete:gatewayRecoveryReceipts/${RECOVERY}`,
      `delete:glmOperations/${RECOVERY}`,
    ]);
    expect(events.slice(2)).toEqual([
      `delete:gateways/${GATEWAY}/releases/1`,
      `delete:gateways/${GATEWAY}`,
    ]);
    expect(records.get(`glmOperations/${RETIREMENT}`)).toEqual(completedRetirement);
    expect(records.get(`glmOperations/${ACTIVATION}`)).toEqual(activation);
    expect(audits()).toEqual([expect.objectContaining({ status: "completed", mutation: expect.objectContaining({ kind: "delete-retired-gateway" }) })]);
  });

  it("keeps the root when its retirement changed after the deletion verdict", async () => {
    seed({ ...deletableSeed(), [`gateways/${GATEWAY}`]: retiredRoot({ retirementVersion: 1 }) });
    const reclaimed = retiredRoot({ retirementVersion: 2, retirementClaim: { operationId: "placement-retire-other", version: 2 } });
    records.afterDelete = (path) => {
      if (path === `gatewayRecoveryReceipts/${RECOVERY}`) records.set(`gateways/${GATEWAY}`, reclaimed);
    };

    const res = await deleteRetired().expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed" });
    expect(records.get(`gateways/${GATEWAY}`)).toEqual(reclaimed);
    expect(records.has(`gateways/${GATEWAY}/releases/1`)).toBe(true);
  });

  it("keeps the root and retire op when the root deletion fails, so the sweep can re-drive", async () => {
    seed(deletableSeed());
    records.failingDelete = `gateways/${GATEWAY}`;

    await deleteRetired().expect(500);

    expect(records.has(`gateways/${GATEWAY}`)).toBe(true);
    expect(records.has(`glmOperations/${RETIREMENT}`)).toBe(true);
  });

  it("refuses while an activation's scheduler handoff is unreleased", async () => {
    seed({ ...deletableSeed(), [`glmOperations/${ACTIVATION}`]: { kind: "migrate-user", status: "failed", schedulerHandoffReleased: false } });

    const res = await deleteRetired().expect(409);

    expect(res.body.error).toContain(`${ACTIVATION} has an unreleased scheduler handoff`);
    expect(fleetEvents()).toEqual([]);
  });

  it("refuses while the cleanup operation has not succeeded", async () => {
    seed({ ...deletableSeed(), [`glmOperations/${RETIREMENT}`]: { kind: "retire-gateway", status: "running" } });

    await deleteRetired().expect(409);

    expect(fleetEvents()).toEqual([]);
    expect(audits()).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("refuses while the owner mirror still points at the gateway", async () => {
    seed({ ...deletableSeed(), [`users/${OWNER}`]: owner(GATEWAY) });

    await deleteRetired().expect(409);

    expect(fleetEvents()).toEqual([]);
  });

  it("refuses when the root carries another allocation generation", async () => {
    seed({
      ...deletableSeed(),
      [`gateways/${GATEWAY}`]: retiredRoot({
        allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-two", generation: 2, claimedByUid: OWNER },
      }),
    });

    await deleteRetired().expect(409);

    expect(fleetEvents()).toEqual([]);
  });

  it("refuses roots that are not isolated allocations", async () => {
    seed({ ...deletableSeed(), [`gateways/${GATEWAY}`]: retiredRoot({ allocation: null }) });

    await deleteRetired().expect(409);

    expect(fleetEvents()).toEqual([]);
  });

  it("keeps an operator-retired root whose retirement claim is not the placement retirement", async () => {
    const operatorRetirement = "operator-retire-alice-xs-12345678";
    const rows = deletableSeed();
    rows[`gateways/${GATEWAY}`] = retiredRoot({ retirementClaim: { operationId: operatorRetirement, version: 1 } });
    delete rows[`glmOperations/${RETIREMENT}`];
    rows[`glmOperations/${operatorRetirement}`] = { kind: "retire-gateway", status: "succeeded" };
    seed(rows);

    await deleteRetired().expect(409);

    expect(fleetEvents()).toEqual([]);
    expect(records.has(`gateways/${GATEWAY}`)).toBe(true);
  });

  it("logs a refusal as a warning, not an error", async () => {
    seed({ ...deletableSeed(), [`glmOperations/${RETIREMENT}`]: { kind: "retire-gateway", status: "running" } });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await deleteRetired().expect(409);

      const refused = warnings.mock.calls.map(([line]) => JSON.parse(String(line)) as Data)
        .find((line) => line.message === "fleet mutation refused");
      expect(refused).toMatchObject({ severity: "WARNING", error: expect.stringContaining("is running, not succeeded") });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      warnings.mockRestore();
      errors.mockRestore();
    }
  });

  it("plans without writing on a dry run", async () => {
    seed(deletableSeed());

    const res = await request(app()).post(`/isolated-gateways/${GATEWAY}/delete-retired?dryRun=true`).send(TARGET).expect(200);

    expect(res.body).toMatchObject({ dryRun: true, plans: [expect.objectContaining({ kind: "delete-retired-gateway" })] });
    expect(records.events).toEqual([]);
  });

  it("answers a replay with the same Idempotency-Key with its audit instead of acting twice", async () => {
    seed(deletableSeed());
    await deleteRetired().set("Idempotency-Key", "key-1").expect(200);

    const replay = await request(app()).post(`/isolated-gateways/${GATEWAY}/delete-retired`).set("Idempotency-Key", "key-1").send(TARGET);

    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ auditId: expect.any(String) });
    expect(audits()).toHaveLength(1);
  });

  it("rejects a malformed target", async () => {
    const zero = await deleteRetired({ ownerUid: OWNER, allocationGeneration: 0 });
    const ownerless = await deleteRetired({ allocationGeneration: 1 });

    expect([zero.status, ownerless.status]).toEqual([400, 400]);
    expect(records.events).toEqual([]);
  });
});

describe("POST /isolated-gateways/:id/retirement/rearm", () => {
  it("re-arms a reaped retire operation so the op runner re-drives it, and deletes nothing", async () => {
    seed({
      ...deletableSeed(),
      [`glmOperations/${RETIREMENT}`]: {
        kind: "retire-gateway", status: "failed", startedAt: 2, completedAt: 3,
        steps: [{ name: "helm-uninstall", status: "running", startedAt: 2 }], error: REAPED,
      },
    });

    await rearm().expect(200);

    expect(fleetEvents()).toEqual([`set:glmOperations/${RETIREMENT}`]);
    expect(records.get(`glmOperations/${RETIREMENT}`)).toEqual({
      kind: "retire-gateway", status: "pending", startedAt: null, completedAt: null, steps: [],
    });
    expect(records.has(`gateways/${GATEWAY}`)).toBe(true);
  });

  it("re-arms a retire operation that failed only on the stopped gateway's draining database sessions", async () => {
    const error = `agent-store credential retirement failed (records preserved for retry): Agent-store Gateway ${GATEWAY} still has database sessions`;
    const steps = [{ name: "helm-uninstall", status: "done" }, { name: "revoke-agent-store-credentials", status: "failed", error }];
    const attemptHistory = [{ attempt: 3, classification: "transient", error, steps }];
    const input = { gatewayId: GATEWAY, uid: OWNER, userSlug: "alice", reason: "builder-returned", retirementClaimVersion: 1 };
    seed({
      ...deletableSeed(),
      [`glmOperations/${RETIREMENT}`]: {
        kind: "retire-gateway", status: "failed", attempts: 3, startedAt: 2, completedAt: 3,
        expireAt: new Date(4), steps, attemptHistory, error, input,
      },
    });

    await rearm().expect(200);

    expect(fleetEvents()).toEqual([`set:glmOperations/${RETIREMENT}`]);
    expect(records.get(`glmOperations/${RETIREMENT}`)).toEqual({
      kind: "retire-gateway", status: "pending", attempts: 3, startedAt: null, completedAt: null, steps: [], attemptHistory, input,
    });
  });

  it("leaves a retire operation that failed on another gateway's draining sessions alone", async () => {
    seed({
      ...deletableSeed(),
      [`glmOperations/${RETIREMENT}`]: {
        kind: "retire-gateway", status: "failed",
        error: "agent-store credential retirement failed (records preserved for retry): Agent-store Gateway shared-foreign still has database sessions",
      },
    });

    await rearm().expect(409);

    expect(fleetEvents()).toEqual([]);
    expect(records.get(`glmOperations/${RETIREMENT}`)).toMatchObject({ status: "failed" });
  });

  it("leaves a retire operation that failed on its own merits alone", async () => {
    seed({ ...deletableSeed(), [`glmOperations/${RETIREMENT}`]: { kind: "retire-gateway", status: "failed", error: "helm uninstall failed: release is stuck" } });

    await rearm().expect(409);

    expect(fleetEvents()).toEqual([]);
  });

  it("does not re-arm a reaped retire while the owner mirror still points at the gateway", async () => {
    seed({
      ...deletableSeed(),
      [`glmOperations/${RETIREMENT}`]: { kind: "retire-gateway", status: "failed", error: REAPED },
      [`users/${OWNER}`]: owner(GATEWAY),
    });

    await rearm().expect(409);

    expect(fleetEvents()).toEqual([]);
  });
});

describe("addAdminFleetRoutes", () => {
  function fleetApp(placement?: AdminPlacementCapabilities) {
    const store = createDocumentFixtureStore(records);
    const router = express.Router();
    addAdminFleetRoutes(router, {
      accounts: noUserAccounts,
      store,
      logger: { info: vi.fn(), warn: vi.fn() },
      provisionGatewayAuthSecret: vi.fn(async () => ({})),
      listGatewayBuilds: vi.fn(async () => []),
      suspendAuthUser: vi.fn(async () => undefined),
      revokeConnectorGrantsForUser: vi.fn(async () => undefined),
      ...(placement ? { placement } : {}),
    });
    return express().use(express.json()).use(router);
  }

  it("mounts the placement routes when the fleet controller passes its capabilities", async () => {
    await request(fleetApp(capabilities)).get("/isolated-gateways/retired").expect(200, { gateways: [] });
  });
});
