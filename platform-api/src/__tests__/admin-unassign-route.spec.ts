import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins the atomic unassign the PR9 bulk-unassign fan-out depends on
// (admin-fleet-router POST /customers/:uid/unassign). In ONE transaction it
// deletes gateways/{gw}/assignments/{uid} AND clears the user mirror, and the
// guard runs INSIDE that transaction: it refuses (409) if a migrate op is
// pending/running OR the durable assignment state is not "serving" — so a
// terminal failed roll that left the user quiescing cannot be silently
// unassigned. Never deletes the user or their workspace.

interface StoredDoc {
  [k: string]: unknown;
}

const state: {
  store: Record<string, StoredDoc | undefined>;
} = { store: {} };

vi.mock("@octogee/core/platform-state", async (importOriginal) => {
  const { createJournalFixtureStore, fixtureDocumentsAt } = await import("@octogee/core-testing/journal-store");
  const documents = () => fixtureDocumentsAt(state.store);
  return {
    ...(await importOriginal<typeof import("@octogee/core/platform-state")>()),
    platformStateStoreFromEnvironment: () => createJournalFixtureStore(
      {
        get: (id) => state.store[`glmOperations/${id}`],
        set: (id, row) => {
          state.store[`glmOperations/${id}`] = row;
        },
      },
      {
        documents: {
          get: (path) => documents().get(path),
          set: (path, row) => documents().set(path, row),
          delete: (path) => documents().delete(path),
          children: (collectionPath) => documents().children(collectionPath),
          group: (collectionId) => documents().group(collectionId),
        },
      },
    ),
  };
});

vi.mock("@octogee/core/http/auth", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.user = { uid: "admin-user" };
    req.uid = "admin-user";
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { uid: "admin-user" };
    req.uid = "admin-user";
    next();
  },
}));

import express from "express";
import adminRouter from "../routes/admin.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

function seedMountedUser(uid: string, gatewayId: string) {
  state.store[`users/${uid}`] = {
    provisioning: { openclaw: { gatewayId, gatewayProfile: "standard", controlUiEnabled: true } },
  };
}

function seedAssignment(gatewayId: string, uid: string, over: Partial<StoredDoc> = {}) {
  state.store[`gateways/${gatewayId}/assignments/${uid}`] = {
    uid,
    slug: uid,
    gatewayId,
    revisionId: `${gatewayId}-r1`,
    release: 1,
    source: "onboarding",
    state: "serving",
    epoch: 1,
    updatedAt: 1,
    updatedByOperationId: null,
    ...over,
  };
}

describe("POST /api/admin/users/:uid/unassign", () => {
  let app: express.Express;

  beforeEach(() => {
    state.store = {};
    app = buildApp();
  });

  it("clears the placement AND deletes the assignment doc in one transaction", async () => {
    seedMountedUser("u-serving", "gw-blue");
    seedAssignment("gw-blue", "u-serving");

    const res = await request(app).post("/api/admin/users/u-serving/unassign");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unassigned: true, uid: "u-serving", from: "gw-blue" });
    // Assignment doc gone (P1-2): the durable roster is no longer contaminated.
    expect(state.store["gateways/gw-blue/assignments/u-serving"]).toBeUndefined();
    expect(state.store["users/u-serving"]).toEqual({ provisioning: { openclaw: {} } });
  });

  it("is NOT destructive — never deletes the user doc", async () => {
    seedMountedUser("u-serving", "gw-blue");
    await request(app).post("/api/admin/users/u-serving/unassign");
    expect(state.store["users/u-serving"]).toBeDefined();
  });

  it("refuses a user with a running migrate op (409) and writes nothing", async () => {
    seedMountedUser("u-moving", "gw-blue");
    seedAssignment("gw-blue", "u-moving");
    state.store["glmOperations/op-1"] = {
      inputUid: "u-moving",
      kind: "migrate-user",
      status: "running",
    };

    const res = await request(app).post("/api/admin/users/u-moving/unassign");

    expect(res.status).toBe(409);
    expect(res.body.operationId).toBe("op-1");
    // No partial write: assignment intact.
    expect(state.store["gateways/gw-blue/assignments/u-moving"]).toBeDefined();
  });

  it("refuses a DURABLE quiescing assignment even with no live op (409 + state)", async () => {
    seedMountedUser("u-quiesce", "gw-blue");
    seedAssignment("gw-blue", "u-quiesce", { state: "quiescing" });

    const res = await request(app).post("/api/admin/users/u-quiesce/unassign");

    expect(res.status).toBe(409);
    expect(res.body.state).toBe("quiescing");
    expect(state.store["gateways/gw-blue/assignments/u-quiesce"]).toBeDefined();
  });

  it("refuses a durable migrating assignment (409)", async () => {
    seedMountedUser("u-mig", "gw-blue");
    seedAssignment("gw-blue", "u-mig", { state: "migrating" });

    const res = await request(app).post("/api/admin/users/u-mig/unassign");
    expect(res.status).toBe(409);
    expect(res.body.state).toBe("migrating");
  });

  it("clears a serving user that has no assignment doc (legacy) without erroring", async () => {
    seedMountedUser("u-legacy", "gw-blue");
    const res = await request(app).post("/api/admin/users/u-legacy/unassign");
    expect(res.status).toBe(200);
  });

  it("returns 409 when the user is already unassigned", async () => {
    state.store["users/u-none"] = { provisioning: { openclaw: {} } };
    const res = await request(app).post("/api/admin/users/u-none/unassign");
    expect(res.status).toBe(409);
  });

  it("returns 404 when the user does not exist", async () => {
    const res = await request(app).post("/api/admin/users/ghost/unassign");
    expect(res.status).toBe(404);
  });
});
