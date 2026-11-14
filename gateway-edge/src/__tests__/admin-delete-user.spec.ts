import { AdminDryRunPlanned } from "@octogee/core/admin-dry-run";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

let usersDocs: Record<string, Row> = {};
let glmOperationsDocs: Array<{ id: string; data: Row }> = [];
let deletionJobsDocs: Record<string, Row> = {};
let assignmentDocs: Record<string, Record<string, Row>> = {};
const secretDocs: Record<string, Record<string, Row>> = {};
const systemDocs: Record<string, Record<string, Row>> = {};
const storeWrites: Array<{ op: "set" | "delete"; path: string; row?: Row }> = [];
const authDisabledUids: string[] = [];
const authRevokedUids: string[] = [];
let authNextError: Error | null = null;
const loggedWarnings: string[] = [];

function documentMap(collectionPath: string): Record<string, Row> {
  if (collectionPath === "users") return usersDocs;
  if (collectionPath === "customerDeletionJobs") return deletionJobsDocs;
  if (/^gateways\/[^/]+\/assignments$/.test(collectionPath)) return assignmentDocs[collectionPath] ??= {};
  if (/^users\/[^/]+\/secrets$/.test(collectionPath)) return secretDocs[collectionPath] ??= {};
  if (/^users\/[^/]+\/system$/.test(collectionPath)) return systemDocs[collectionPath] ??= {};
  throw new Error(`admin delete fixture has no collection ${collectionPath}`);
}

function splitPath(path: string): [string, string] {
  const at = path.lastIndexOf("/");
  return [path.slice(0, at), path.slice(at + 1)];
}

const fixtureDocuments = {
  get: (path: string): Row | undefined => {
    const [collectionPath, id] = splitPath(path);
    if (collectionPath === "glmOperations") return glmOperationsDocs.find((doc) => doc.id === id)?.data;
    return documentMap(collectionPath)[id];
  },
  set: (path: string, row: Row): void => {
    storeWrites.push({ op: "set", path, row });
    const [collectionPath, id] = splitPath(path);
    if (collectionPath !== "glmOperations") {
      documentMap(collectionPath)[id] = row;
      return;
    }
    const entry = glmOperationsDocs.find((doc) => doc.id === id);
    if (entry) entry.data = row;
    else glmOperationsDocs.unshift({ id, data: row });
  },
  delete: (path: string): void => {
    storeWrites.push({ op: "delete", path });
    const [collectionPath, id] = splitPath(path);
    if (collectionPath === "glmOperations") glmOperationsDocs = glmOperationsDocs.filter((doc) => doc.id !== id);
    else delete documentMap(collectionPath)[id];
  },
  children: (collectionPath: string): Array<readonly [string, Row]> =>
    collectionPath === "glmOperations"
      ? glmOperationsDocs.map((doc) => [doc.id, doc.data] as const)
      : Object.entries(documentMap(collectionPath)),
  group: (collectionId: string): Array<readonly [string, Row]> => {
    if (collectionId !== "assignments") throw new Error(`admin delete fixture has no collection group ${collectionId}`);
    return Object.entries(assignmentDocs).flatMap(([collectionPath, docs]) =>
      Object.entries(docs).map(([uid, row]) => [`${collectionPath}/${uid}`, row] as const));
  },
};

function operationWrites(): Row[] {
  return storeWrites.flatMap((write) =>
    write.op === "set" && write.path.startsWith("glmOperations/") && typeof write.row?.kind === "string" ? [write.row] : []);
}

vi.mock("@octogee/core/platform-state", async (importOriginal) => {
  const { createJournalFixtureStore } = await import("@octogee/core/testing/journal-store");
  return {
    ...(await importOriginal<typeof import("@octogee/core/platform-state")>()),
    platformStateStoreFromEnvironment: () => createJournalFixtureStore(
      {
        get: (id) => glmOperationsDocs.find((doc) => doc.id === id)?.data,
        set: (id, row) => {
          const entry = glmOperationsDocs.find((doc) => doc.id === id);
          if (entry) entry.data = row;
          else glmOperationsDocs.unshift({ id, data: row });
        },
      },
      {
        documents: {
          get: (path) => fixtureDocuments.get(path),
          set: (path, row) => fixtureDocuments.set(path, row),
          delete: (path) => fixtureDocuments.delete(path),
          children: (collectionPath) => fixtureDocuments.children(collectionPath),
          group: (collectionId) => fixtureDocuments.group(collectionId),
        },
        serializeTransactions: true,
      },
    ),
  };
});

vi.mock("../lib/db", () => {
  function collection(name: string): any {
    return {
      doc: (docId: string) => ({
        id: docId,
        get: async () => {
          const data = name === "users" ? usersDocs[docId] : undefined;
          return { exists: data !== undefined, data: () => data };
        },
        collection: (sub: string) => collection(sub),
      }),
      get: async () => ({ docs: [], size: 0 }),
    };
  }

  return {
    db: {
      collection,
      doc: (path: string) => {
        const [name, id] = path.split("/");
        return collection(name).doc(id);
      },
    },
    auth: {
      updateUser: async (uid: string) => {
        if (authNextError) {
          const e = authNextError;
          authNextError = null;
          throw e;
        }
        authDisabledUids.push(uid);
      },
      revokeRefreshTokens: async (uid: string) => { authRevokedUids.push(uid); },
    },
    FieldValue: { serverTimestamp: () => "now", delete: () => "delete" },
    Timestamp: { now: () => ({ toDate: () => new Date() }) },
  };
});


vi.mock("../middleware/auth", () => ({
  requireAdmin: (req: any, _res: any, next: any) => {
    req.uid = "admin-uid";
    req.user = { email: "admin@octogee.com" };
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.uid = "admin-uid";
    next();
  },
}));

vi.mock("../middleware/logging", () => ({
  logger: {
    info: () => undefined,
    warn: (msg: string) => loggedWarnings.push(msg),
    error: () => undefined,
  },
}));

import express from "express";
import adminRouter, { createAdminRoutes } from "../routes/admin.js";

function buildApp(router = adminRouter) {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", router);
  return app;
}

beforeEach(() => {
  storeWrites.length = 0;
  usersDocs = {};
  glmOperationsDocs = [];
  deletionJobsDocs = {};
  assignmentDocs = {};
  authDisabledUids.length = 0;
  authRevokedUids.length = 0;
  authNextError = null;
  loggedWarnings.length = 0;
});

describe("POST /api/admin/users/:uid/delete — 404 + 409 paths", () => {
  it("404 when the user doc doesn't exist", async () => {
    const res = await request(buildApp()).post("/api/admin/users/missing-uid/delete");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("409 when a suspension op is already pending for this uid", async () => {
    usersDocs["uid-alice"] = { username: "alice", email: "alice@example.com" };
    glmOperationsDocs = [
      {
        id: "op-existing",
        data: {
          kind: "suspend-user",
          status: "pending",
          inputUid: "uid-alice",
          input: { uid: "uid-alice" },
        },
      },
    ];
    const res = await request(buildApp()).post("/api/admin/users/uid-alice/delete");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/i);
    expect(res.body.operationId).toBe("op-existing");
  });

  it("409 when an erasure op is already running", async () => {
    usersDocs["uid-alice"] = { username: "alice" };
    glmOperationsDocs = [
      { id: "op-running", data: { kind: "erase-user", status: "running", inputUid: "uid-alice", input: { uid: "uid-alice" } } },
    ];
    const res = await request(buildApp()).post("/api/admin/users/uid-alice/delete");
    expect(res.status).toBe(409);
  });
});

describe("POST /api/admin/users/:uid/delete — has-slug branch", () => {
  it("enqueues suspension and retained erasure operations, returning their durable ids", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      email: "alice@example.com",
      provisioning: { openclaw: { slug: "alice", gatewayId: "gw-test" } },
    };
    const res = await request(buildApp()).post("/api/admin/users/uid-alice/delete");
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "deletion_scheduled",
      slug: "alice",
      suspensionOperationId: expect.any(String),
      erasureOperationId: expect.any(String),
    });
    expect(operationWrites()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "suspend-user", inputUid: "uid-alice" }),
      expect.objectContaining({ kind: "erase-user", inputUid: "uid-alice" }),
    ]));
  });

  it("uses provisioning.openclaw.slug as canonical when username is absent", async () => {

usersDocs["uid-alice"] = {
      provisioning: { openclaw: { slug: "alice-via-onboarding" } },
    };
    const res = await request(buildApp()).post("/api/admin/users/uid-alice/delete");
    expect(res.status).toBe(202);
    expect(res.body.slug).toBe("alice-via-onboarding");
    
    expect(authDisabledUids).toEqual(["uid-alice"]);
    expect(authRevokedUids).toEqual(["uid-alice"]);
  });

  it("does NOT delete the user doc inline when slug is present (handler does that)", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice" } },
    };
    await request(buildApp()).post("/api/admin/users/uid-alice/delete");
    expect(authDisabledUids).toEqual(["uid-alice"]);
    expect(storeWrites).not.toContainEqual({ op: "delete", path: "users/uid-alice" });
    expect(usersDocs["uid-alice"]).toBeDefined();
  });
});

describe("POST /api/admin/users/:uid/delete — no-slug lifecycle", () => {
  it("schedules retention and suspends Auth without deleting identity inline", async () => {
    usersDocs["uid-bob"] = { email: "bob@example.com" };
    const res = await request(buildApp()).post("/api/admin/users/uid-bob/delete");
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "deletion_scheduled", slug: null });
    expect(authDisabledUids).toEqual(["uid-bob"]);
    expect(authRevokedUids).toEqual(["uid-bob"]);
    expect(storeWrites).not.toContainEqual({ op: "delete", path: "users/uid-bob" });
    expect(usersDocs["uid-bob"]).toBeDefined();
  });

  it("treats an already-missing Auth account as an idempotent suspension success", async () => {
    usersDocs["uid-bob"] = { email: "bob@example.com" };
    const e = Object.assign(new Error("user not found"), { code: "auth/user-not-found" });
    authNextError = e;
    const res = await request(buildApp()).post("/api/admin/users/uid-bob/delete");
    expect(res.status).toBe(202);
    expect(operationWrites()).toHaveLength(2);
  });

  it("does NOT swallow other auth errors (e.g. quota) just because they mention 'user-not-found'", async () => {
    usersDocs["uid-bob"] = { email: "bob@example.com" };
    const e = Object.assign(new Error("quota exceeded — user-not-found cache full"), {
      code: "auth/quota-exceeded",
    });
    authNextError = e;
    const res = await request(buildApp()).post("/api/admin/users/uid-bob/delete");
    expect(res.status).toBe(500);
    expect(glmOperationsDocs.map((entry) => entry.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordType: "audit",
        status: "completed",
        lifecycleStage: "action-partial",
        partialOutcome: expect.objectContaining({
          summary: "user deletion was scheduled but identity suspension failed",
          details: expect.objectContaining({
            uid: "uid-bob",
            failedStep: "suspend-auth",
            deletionId: expect.any(String),
            suspensionOperationId: expect.any(String),
            erasureOperationId: expect.any(String),
          }),
        }),
      }),
    ]));
  });

  it("enqueues lifecycle operations even when provisioning never produced a slug", async () => {
    usersDocs["uid-bob"] = { email: "bob@example.com" };
    await request(buildApp()).post("/api/admin/users/uid-bob/delete");
    expect(operationWrites()).toHaveLength(2);
  });
});

describe("POST /api/admin/users/:uid/delete — product deletion context", () => {
  it("records the product's discovered context on the deletion job for the suspension worker", async () => {
    usersDocs["uid-alice"] = { username: "alice", provisioning: { openclaw: { slug: "alice" } } };
    const discoverDeletionProductContext = vi.fn(async () => ({
      stripeCustomerIds: ["cus_abc"],
      stripeSubscriptionIds: ["sub_personal"],
    }));
    const res = await request(buildApp(createAdminRoutes({ discoverDeletionProductContext })))
      .post("/api/admin/users/uid-alice/delete");
    expect(res.status).toBe(202);
    expect(discoverDeletionProductContext).toHaveBeenCalledWith("uid-alice");
    expect(Object.values(deletionJobsDocs)).toEqual([expect.objectContaining({
      stripeCustomerIds: ["cus_abc"],
      stripeSubscriptionIds: ["sub_personal"],
    })]);
  });

  it("records an empty product context when no product is installed", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice" } },
      subscription: { stripeCustomerId: "cus_abc", stripeSubscriptionId: "sub_personal" },
    };
    await request(buildApp()).post("/api/admin/users/uid-alice/delete");
    const [job] = Object.values(deletionJobsDocs);
    expect(job).not.toHaveProperty("stripeCustomerIds");
    expect(job).not.toHaveProperty("stripeSubscriptionIds");
  });
});

describe("product admin routes on the API's admin router", () => {
  it("answers a product route's dry run with its plan instead of refusing it", async () => {
    const addAdminRoutes = vi.fn((router: express.Router) => {
      router.post("/product-setting", (_req, _res, next) => {
        next(new AdminDryRunPlanned({
          what: "change the product setting", why: "test", target: {}, preActionStatus: {}, mutation: { kind: "product-setting" },
        }));
      });
    });

    const res = await request(buildApp(createAdminRoutes({ addAdminRoutes }))).post("/api/admin/product-setting?dryRun=true");

    expect(res.body).toMatchObject({ dryRun: true, plans: [{ what: "change the product setting", kind: "product-setting" }] });
    expect(res.status).toBe(200);
    expect(addAdminRoutes).toHaveBeenCalledWith(expect.anything(), { store: expect.anything() });
  });

  it("has no idle setting and no lease routes when no product is installed", async () => {
    expect((await request(buildApp()).get("/api/admin/platform-runtime-config")).status).toBe(404);
    expect((await request(buildApp()).post("/api/admin/users/uid-alice/activation-lease")).status).toBe(404);
  });
});
