import express from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { GLM_GATEWAYS_COLLECTION, GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";

import { addAdminFleetRoutes } from "./admin-fleet-router.js";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "./testing/journal-store.js";
import { firestoreUserAccountReader } from "./user-account.js";

type Row = Record<string, unknown>;
type Seed = Record<string, Row>;

const SHARED = "shared-aa55bcd6ecef";
const ISOLATED = "owner-s-604ccd8f";

function gatewayRoot(gatewayId: string, overrides: Row = {}): Row {
  return {
    gatewayId, createdAt: 1, createdBy: "operator", updatedAt: 1, updatedBy: "operator",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
    profile: "standard", gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null, coOwnerUids: [],
    ...overrides,
  };
}

function isolatedRoot(lease: { leaseId: string; generation: number }, overrides: Row = {}): Row {
  return gatewayRoot(ISOLATED, {
    gatewayClass: "isolated", imageProfile: "isolated", profile: "isolated", sizingTier: "s",
    ownerUid: "uid-owner", builderSlug: "owner",
    allocation: { kind: "disposable-builder", schemaVersion: 1, claimedByUid: "uid-owner", ...lease },
    ...overrides,
  });
}

function fleet(lease: Row | null, gatewayId: string, extra: Seed = {}): Seed {
  return {
    "config/orchestrator": { defaultGatewayId: SHARED, sharedGatewayIds: [SHARED], sizingProfiles: FIXTURE_SIZING_PROFILES },
    [`gateways/${SHARED}`]: gatewayRoot(SHARED),
    [`${GLM_GATEWAYS_COLLECTION}/${SHARED}`]: {
      docKind: "runtime", gatewayId: SHARED, release: 1, lifecycle: "serving", createdAt: 1, createdByOperationId: null, helm: {},
      heartbeat: { status: "ready", lastHeartbeatAt: Date.now(), version: "abc1234", startedAt: Date.now() - 1_000, mountedCustomers: ["owner"] },
      lastError: { message: null, at: null },
    },
    "users/uid-owner": {
      username: "owner",
      provisioning: { status: "complete", openclaw: { slug: "owner", gatewayId, status: "complete", ...(lease ? { activationLease: lease } : {}) } },
    },
    [`gateways/${gatewayId}/assignments/uid-owner`]: {
      uid: "uid-owner", slug: "owner", gatewayId, source: "onboarding", state: "serving", epoch: 7,
      createdAt: 1, updatedAt: 1, updatedByOperationId: null,
    },
    ...extra,
  };
}

function accountsDb(accounts: Record<string, Row> = {}): Firestore {
  const snapshot = (id: string) => ({ id, exists: id in accounts, data: () => accounts[id] });
  const doc = (id: string) => ({ id, get: async () => snapshot(id) });
  return {
    doc: (path: string) => doc(path.replace(/^users\//, "")),
    collection: () => ({
      doc,
      get: async () => ({ docs: Object.keys(accounts).map((id) => ({ id, data: () => accounts[id] })) }),
    }),
    getAll: async (...refs: { id: string }[]) => refs.map((ref) => snapshot(ref.id)),
  } as unknown as Firestore;
}

function harness(seed: Seed, accounts: Record<string, Row> = {}) {
  const records = new Map<string, Row>(Object.entries(structuredClone(seed)));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { uid: "operator", isAdmin: true });
    next();
  });
  addAdminFleetRoutes(app, {
    accounts: firestoreUserAccountReader(accountsDb(accounts)),
    store: createDocumentFixtureStore(records),
    logger: { info: vi.fn(), warn: vi.fn() },
    provisionGatewayAuthSecret: vi.fn(async () => ({})),
    listGatewayBuilds: vi.fn(async () => []),
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
  });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return { app };
}

describe("the status of a gateway", () => {
  const runtime = (gatewayId: string, heartbeat: Row): Seed => ({
    [`${GLM_GATEWAYS_COLLECTION}/${gatewayId}`]: {
      docKind: "runtime", gatewayId, release: 1, lifecycle: "serving", createdAt: 1, createdByOperationId: null, helm: {},
      runtime: "gce-vm", heartbeat: { version: "abc1234", startedAt: 1, mountedCustomers: [], ...heartbeat },
      lastError: { message: null, at: null },
    },
  });
  const lastReady = (ageMs: number) => ({ status: "ready", lastHeartbeatAt: Date.now() - ageMs });
  const parkedLease = { leaseId: "45c1cb22", generation: 1, status: "parked", targetGatewayId: ISOLATED, entitlementTier: "hobby", sizingTier: "s" };
  const withIsolated = (desiredStatus: string, heartbeat: Row, extra: Seed = {}) => fleet(parkedLease, SHARED, {
    [`gateways/${ISOLATED}`]: isolatedRoot({ leaseId: "45c1cb22", generation: 1 }, { desiredStatus }),
    ...runtime(ISOLATED, heartbeat),
    ...extra,
  });
  const listed = async (h: ReturnType<typeof harness>, path: string) => {
    const res = await request(h.app).get(path).expect(200);
    return {
      body: res.body,
      status: Object.fromEntries((res.body.gateways as Row[]).map((gateway) => [gateway.gatewayId, gateway.status])),
    };
  };

  it("is paused for a parked gateway whose last heartbeat said ready", async () => {
    const h = harness(withIsolated("paused", lastReady(8 * 60_000)));

    const { body, status } = await listed(h, "/gateways");

    expect(status).toEqual({ [SHARED]: "ready", [ISOLATED]: "paused" });
    expect(body.stats.gateways).toEqual({ total: 2, ready: 1, paused: 1, unreachable: 0 });
    expect((await listed(h, "/placement")).status).toEqual({ [SHARED]: "ready", [ISOLATED]: "paused" });
  });

  it("is booting after a resume until the fleet controller restarts the parked deployment, though its last heartbeat said ready", async () => {
    const parkedDeployment = runtime(ISOLATED, lastReady(60_000));
    const record = parkedDeployment[`${GLM_GATEWAYS_COLLECTION}/${ISOLATED}`];
    const h = harness(withIsolated("running", lastReady(60_000), {
      [`${GLM_GATEWAYS_COLLECTION}/${ISOLATED}`]: { ...record, helm: { replicas: 0 } },
    }));

    expect((await listed(h, "/gateways")).status).toEqual({ [SHARED]: "ready", [ISOLATED]: "booting" });
    expect((await listed(h, "/placement")).status).toEqual({ [SHARED]: "ready", [ISOLATED]: "booting" });
  });

  it("is the heartbeat's status once the fleet controller has restarted the deployment", async () => {
    const restarted = runtime(ISOLATED, lastReady(5_000));
    const record = restarted[`${GLM_GATEWAYS_COLLECTION}/${ISOLATED}`];
    const h = harness(withIsolated("running", lastReady(5_000), {
      [`${GLM_GATEWAYS_COLLECTION}/${ISOLATED}`]: { ...record, helm: { replicas: 1 } },
    }));

    expect((await listed(h, "/gateways")).status).toEqual({ [SHARED]: "ready", [ISOLATED]: "ready" });
  });

  it("is unreachable once the heartbeat is older than the reachability limit", async () => {
    const h = harness(withIsolated("running", lastReady(GATEWAY_UNREACHABLE_AFTER_MS + 1_000)));

    const { body, status } = await listed(h, "/gateways");

    expect(status).toEqual({ [SHARED]: "ready", [ISOLATED]: "unreachable" });
    expect(body.stats.gateways).toEqual({ total: 2, ready: 1, paused: 0, unreachable: 1 });
    expect((await listed(h, "/placement")).status).toEqual({ [SHARED]: "ready", [ISOLATED]: "unreachable" });
  });

  it("is the heartbeat's own status while the heartbeat is fresh", async () => {
    const h = harness(withIsolated("running", { status: "booting", lastHeartbeatAt: Date.now() - 5_000 }));

    expect((await listed(h, "/gateways")).status).toEqual({ [SHARED]: "ready", [ISOLATED]: "booting" });
  });

  it("is retired for a retired gateway when retired gateways are listed", async () => {
    const h = harness(withIsolated("retired", lastReady(60 * 60_000)));

    expect((await listed(h, "/gateways?all=true")).status).toMatchObject({ [ISOLATED]: "retired" });
  });

  it("does not offer an unreachable shared gateway as a default target", async () => {
    const h = harness(withIsolated("paused", lastReady(1_000), runtime(SHARED, lastReady(GATEWAY_UNREACHABLE_AFTER_MS + 1_000))));

    const res = await request(h.app).get("/placement").expect(200);

    expect((res.body.gateways as Row[]).find((gateway) => gateway.gatewayId === SHARED)).toMatchObject({
      status: "unreachable",
      assignableAsDefault: false,
    });
  });
});

describe("who did it, in the operations journal", () => {
  const operation = (id: string, createdBy: string, createdAt: number): Seed => ({
    [`${GLM_OPERATIONS_COLLECTION}/${id}`]: {
      kind: "restart-gateway", status: "succeeded", createdBy, createdAt, startedAt: createdAt, completedAt: createdAt + 1,
      input: { gatewayId: SHARED }, gatewayId: SHARED, steps: [],
    },
  });
  const journal = () => harness({
    ...fleet(null, SHARED),
    ...operation("op-admin-page", "uid-admin", 4),
    ...operation("op-cli", "ops@example.com", 3),
    ...operation("op-policy", "glm-controller-placement-policy", 2),
    ...operation("op-erased-admin", "uid-erased", 1),
  }, { "uid-admin": { username: "admin", email: "admin@example.com" } });

  it("names one identity for an Admin page action and a CLI action: the operator's email", async () => {
    const res = await request(journal().app).get("/operations?limit=10").expect(200);

    expect(Object.fromEntries((res.body.operations as Row[]).map((entry) => [entry.id, [entry.createdBy, entry.actorEmail]]))).toEqual({
      "op-admin-page": ["uid-admin", "admin@example.com"],
      "op-cli": ["ops@example.com", "ops@example.com"],
      "op-policy": ["glm-controller-placement-policy", null],
      "op-erased-admin": ["uid-erased", null],
    });
  });

  it("names it on a single record too", async () => {
    const res = await request(journal().app).get("/operations/op-admin-page").expect(200);

    expect(res.body.operation).toMatchObject({ id: "op-admin-page", createdBy: "uid-admin", actorEmail: "admin@example.com" });
  });
});
