import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";

let glmOperationsDocs: Array<{ id: string; data: Record<string, unknown> }> = [];
let glmGatewaysDocs: Record<string, Record<string, unknown>> = {};
let gatewaysDocs: Record<string, Record<string, unknown>> = {};
// Step 2 release docs live at gateways/{id}/releases/{n}; keyed here by
// `${gatewayId}/${release}` so the fake can serve subcollection reads/writes.
let gatewayReleasesDocs: Record<string, Record<string, unknown>> = {};
// PR7 durable roster docs at gateways/{id}/assignments/{uid}; keyed by
// `${gatewayId}/${uid}` so the fake can serve subcollection + collectionGroup.
let gatewayAssignmentsDocs: Record<string, Record<string, unknown>> = {};
let usersDocs: Record<string, Record<string, unknown>> = {};
const usersSystemDocs: Record<string, Record<string, unknown>> = {};
let workspacesDocs: Record<string, Record<string, unknown>> = {};
let configDocs: Record<string, Record<string, unknown>> = {};
let controllerStateDocs: Record<string, Record<string, unknown>> = {};
let sideEffects: string[] = [];
let failingStoreTransaction: string | null = null;

type FixtureCollection = Record<string, Record<string, unknown>>;

function fixtureCollection(collectionPath: string): { docs: FixtureCollection; prefix: string } {
  const [root, gatewayId, subcollection, ...rest] = collectionPath.split("/");
  const topLevel: Record<string, FixtureCollection | undefined> = {
    gateways: gatewaysDocs,
    users: usersDocs,
    glmGateways: glmGatewaysDocs,
    config: configDocs,
    glmControllerState: controllerStateDocs,
  };
  const gatewaySubcollections: Record<string, FixtureCollection | undefined> = {
    releases: gatewayReleasesDocs,
    assignments: gatewayAssignmentsDocs,
  };
  const docs = gatewayId === undefined
    ? topLevel[root]
    : root === "gateways" && rest.length === 0
      ? gatewaySubcollections[subcollection]
      : root === "users" && subcollection === "system" && rest.length === 0
        ? usersSystemDocs
        : undefined;
  if (docs === undefined) throw new Error(`admin-glm fixture has no collection ${collectionPath}`);
  return { docs, prefix: gatewayId === undefined ? "" : `${gatewayId}/` };
}

function splitDocumentPath(path: string): [string, string] {
  const at = path.lastIndexOf("/");
  return [path.slice(0, at), path.slice(at + 1)];
}

function readFixtureDocument(path: string): Record<string, unknown> | undefined {
  const [collectionPath, id] = splitDocumentPath(path);
  if (collectionPath === "glmOperations") return glmOperationsDocs.find((doc) => doc.id === id)?.data;
  const { docs, prefix } = fixtureCollection(collectionPath);
  return docs[`${prefix}${id}`];
}

function writeFixtureDocument(path: string, row: Record<string, unknown>): void {
  sideEffects.push(`set ${path}`);
  const [collectionPath, id] = splitDocumentPath(path);
  if (collectionPath !== "glmOperations") {
    const { docs, prefix } = fixtureCollection(collectionPath);
    docs[`${prefix}${id}`] = row;
    return;
  }
  const entry = glmOperationsDocs.find((doc) => doc.id === id);
  if (entry) entry.data = row;
  else glmOperationsDocs.unshift({ id, data: row });
}

function deleteFixtureDocument(path: string): void {
  sideEffects.push(`delete ${path}`);
  const [collectionPath, id] = splitDocumentPath(path);
  if (collectionPath === "glmOperations") {
    glmOperationsDocs = glmOperationsDocs.filter((doc) => doc.id !== id);
    return;
  }
  const { docs, prefix } = fixtureCollection(collectionPath);
  delete docs[`${prefix}${id}`];
}

function fixtureGroup(collectionId: string): Array<[string, Record<string, unknown>]> {
  if (collectionId !== "assignments") throw new Error(`admin-glm fixture has no collection group ${collectionId}`);
  return Object.entries(gatewayAssignmentsDocs).map(([key, row]) => {
    const [gatewayId, uid] = key.split("/");
    return [`gateways/${gatewayId}/assignments/${uid}`, row];
  });
}

function fixtureChildren(collectionPath: string): Array<[string, Record<string, unknown>]> {
  if (collectionPath === "glmOperations") return glmOperationsDocs.map((doc) => [doc.id, doc.data]);
  const { docs, prefix } = fixtureCollection(collectionPath);
  return Object.entries(docs).flatMap(([key, row]): Array<[string, Record<string, unknown>]> =>
    key.startsWith(prefix) ? [[key.slice(prefix.length), row]] : []);
}

function storedOperation(operationId: string): Record<string, unknown> | undefined {
  return glmOperationsDocs.find((doc) => doc.id === operationId)?.data;
}

function commandOperation(): Record<string, unknown> | undefined {
  return glmOperationsDocs.find((doc) => typeof doc.data.kind === "string" && doc.data.recordType !== "audit")?.data;
}

function readNestedField(data: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = data;
  for (const part of path.split(".")) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

vi.mock("@octogee/core/platform-state", async (importOriginal) => {
  const { createJournalFixtureStore } = await import("@octogee/core/testing/journal-store");
  return {
    ...(await importOriginal<typeof import("@octogee/core/platform-state")>()),
    platformStateStoreFromEnvironment: () => createJournalFixtureStore(
      {
        get: (id) => readFixtureDocument(`glmOperations/${id}`),
        set: (id, row) => writeFixtureDocument(`glmOperations/${id}`, row),
      },
      {
        documents: {
          get: readFixtureDocument,
          set: writeFixtureDocument,
          delete: deleteFixtureDocument,
          children: fixtureChildren,
          group: fixtureGroup,
        },
        beforeTransaction: (label) => {
          sideEffects.push(`begin ${label}`);
          if (label === failingStoreTransaction) throw new Error(`simulated ${label} transaction failure`);
        },
      },
    ),
  };
});

vi.mock("../lib/db", () => {
  let autoId = 0;
  function whereChain(
    collectionName: string,
    filter?: { field: string; value: unknown },
  ) {
    return {
      orderBy: () => whereChain(collectionName, filter),
      limit: () => whereChain(collectionName, filter),
      where: (field: string, _op: string, value: unknown) =>
        whereChain(collectionName, { field, value }),
      get: async () => {
        if (collectionName === "glmOperations") {
          const docs = filter
            ? glmOperationsDocs.filter((d) => {
                const v = d.data[filter.field];
                if (Array.isArray(filter.value)) {
                  return (filter.value as unknown[]).includes(v);
                }
                return v === filter.value;
              })
            : glmOperationsDocs;
          return {
            docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
            size: docs.length,
          };
        }
        if (collectionName === "gateways" && filter) {
          const matches = Object.entries(gatewaysDocs)
            .filter(([, data]) => data[filter.field] === filter.value)
            .map(([id, data]) => ({ id, data: () => data }));
          return { docs: matches, size: matches.length };
        }
        if (collectionName === "glmGateways" && filter) {
          const matches = Object.entries(glmGatewaysDocs)
            .filter(([, data]) => data[filter.field] === filter.value)
            .map(([id, data]) => ({ id, data: () => data }));
          return { docs: matches, size: matches.length };
        }
        if (collectionName === "glmGateways" && !filter) {
          const docs = Object.entries(glmGatewaysDocs).map(([id, data]) => ({ id, data: () => data }));
          return { docs, size: docs.length };
        }
        if (collectionName === "users" && filter) {
          const matches = Object.entries(usersDocs)
            .filter(([, data]) => readNestedField(data, filter.field) === filter.value)
            .map(([id, data]) => ({ id, data: () => data }));
          return { docs: matches, size: matches.length };
        }
        if (collectionName === "users" && !filter) {
          const docs = Object.entries(usersDocs).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        return { docs: [], size: 0 };
      },
    };
  }

  function makeDocRef(name: string, docId: string): any {
    return {
      id: docId,
      _collection: name,
      get: async () => {
        if (name === "glmGateways") {
          const data = glmGatewaysDocs[docId];
          return { exists: data !== undefined, data: () => data };
        }
        if (name === "glmOperations") {
          const entry = glmOperationsDocs.find((candidate) => candidate.id === docId);
          return { exists: entry !== undefined, data: () => entry?.data };
        }
        if (name === "gateways") {
          const data = gatewaysDocs[docId];
          return { exists: data !== undefined, data: () => data };
        }
        if (name === "users") {
          const data = usersDocs[docId];
          return { exists: data !== undefined, data: () => data };
        }
        if (name === "workspaces") {
          const data = workspacesDocs[docId];
          return { exists: data !== undefined, data: () => data };
        }
        if (name === "config") {
          const data = configDocs[docId];
          return { exists: data !== undefined, data: () => data };
        }
        return { exists: true, data: () => ({}) };
      },
      set: async (data: Record<string, unknown>, options?: Record<string, unknown>) => {
        if (name === "glmGateways") glmGatewaysDocs[docId] = data;
        if (name === "glmOperations") glmOperationsDocs.unshift({ id: docId, data });
        if (name === "users") usersDocs[docId] = data;
        if (name === "config") configDocs[docId] = options?.merge ? { ...(configDocs[docId] ?? {}), ...data } : data;
        if (name === "gateways") {
          gatewaysDocs[docId] = options?.merge
            ? { ...(gatewaysDocs[docId] ?? {}), ...data }
            : data;
        }
      },
      update: async (data: Record<string, unknown>) => {
        if (name === "glmGateways" && glmGatewaysDocs[docId]) {
          glmGatewaysDocs[docId] = { ...glmGatewaysDocs[docId], ...data };
        }
        if (name === "glmOperations") {
          const entry = glmOperationsDocs.find((candidate) => candidate.id === docId);
          if (entry) entry.data = { ...entry.data, ...data };
        }
        if (name === "users" && usersDocs[docId]) {
          usersDocs[docId] = { ...usersDocs[docId], ...data };
        }
        if (name === "config" && configDocs[docId]) {
          configDocs[docId] = { ...configDocs[docId], ...data };
        }
        if (name === "gateways" && gatewaysDocs[docId]) {
          gatewaysDocs[docId] = { ...gatewaysDocs[docId], ...data };
        }
      },
      // Step 2 subcollections: gateways/{id}/releases/{n} (release records) and
      // gateways/{id}/assignments/{uid} (PR7 durable roster docs).
      collection: (subName: string) => {
        const key = (rid: string) => `${docId}/${rid}`;
        if (subName === "assignments") {
          return {
            doc: (uid: string) => ({
              id: uid,
              __isDoc: true,
              get: async () => {
                const d = gatewayAssignmentsDocs[key(uid)];
                return { id: uid, exists: d !== undefined, data: () => d };
              },
              set: async (data: Record<string, unknown>) => {
                gatewayAssignmentsDocs[key(uid)] = data;
              },
              update: async (data: Record<string, unknown>) => {
                if (gatewayAssignmentsDocs[key(uid)]) {
                  gatewayAssignmentsDocs[key(uid)] = { ...gatewayAssignmentsDocs[key(uid)], ...data };
                }
              },
              delete: async () => {
                delete gatewayAssignmentsDocs[key(uid)];
              },
            }),
            // Retire enumerates the gateway's assignments to refuse while
            // users are still assigned.
            get: async () => {
              const prefix = `${docId}/`;
              const docs = Object.entries(gatewayAssignmentsDocs)
                .filter(([k]) => k.startsWith(prefix))
                .map(([k, d]) => ({ id: k.slice(prefix.length), exists: true, data: () => d }));
              return { empty: docs.length === 0, size: docs.length, docs };
            },
          };
        }
        const documents = {
          doc: (rid: string) => ({
            id: rid,
            get: async () => {
              const d = gatewayReleasesDocs[key(rid)];
              return { id: rid, exists: d !== undefined, data: () => d };
            },
            set: async (data: Record<string, unknown>) => {
              gatewayReleasesDocs[key(rid)] = data;
            },
          }),
        };
        if (name === "users") return { ...whereChain(`users/${docId}/${subName}`), ...documents };
        return {
          ...documents,
          orderBy: (field: string, dir = "asc") => ({
            get: async () => {
              const docs = Object.entries(gatewayReleasesDocs)
                .filter(([k]) => k.startsWith(`${docId}/`))
                .map(([k, data]) => ({ id: k.split("/")[1], data: () => data }));
              docs.sort((a, b) => {
                const av = (a.data() as Record<string, number>)[field];
                const bv = (b.data() as Record<string, number>)[field];
                const cmp = av < bv ? -1 : av > bv ? 1 : 0;
                return dir === "desc" ? -cmp : cmp;
              });
              return { docs, size: docs.length };
            },
          }),
        };
      },
    };
  }

  function collection(name: string): any {
    return {
      add: async (data: Record<string, unknown>) => {
        const id = `doc-${++autoId}`;
        if (name === "glmOperations") glmOperationsDocs.unshift({ id, data });
        return { id };
      },
      doc: (docId?: string) => {
        const id = docId ?? `auto-${++autoId}-${name}`;
        return makeDocRef(name, id);
      },
      orderBy: () => whereChain(name),
      where: (field: string, _op: string, value: unknown) =>
        whereChain(name, { field, value }),
      limit: () => whereChain(name),
      get: async () => {
        if (name === "gateways") {
          const docs = Object.entries(gatewaysDocs).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        if (name === "users") {
          const docs = Object.entries(usersDocs).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        if (name === "glmGateways") {
          const docs = Object.entries(glmGatewaysDocs).map(([id, data]) => ({
            id,
            data: () => data,
          }));
          return { docs, size: docs.length };
        }
        return { docs: [], size: 0 };
      },
    };
  }

function makeBatch() {
    const pending: Array<() => Promise<void>> = [];
    return {
      update(docRef: any, data: Record<string, unknown>) {
        pending.push(() => docRef.update(data));
        return this;
      },
      set(docRef: any, data: Record<string, unknown>, options?: Record<string, unknown>) {
        pending.push(() => docRef.set(data, options));
        return this;
      },
      delete(docRef: any) {
        pending.push(() => docRef.delete?.());
        return this;
      },
      commit: async () => {
        for (const fn of pending) await fn();
      },
    };
  }

  return {
    db: {
      collection,
      collectionGroup: (name: string) => ({
        get: async () => {
          if (name === "assignments") {
            const docs = Object.entries(gatewayAssignmentsDocs).map(([k, data]) => ({
              id: k.split("/")[1],
              data: () => data,
            }));
            return { docs, size: docs.length };
          }
          return { docs: [], size: 0 };
        },
      }),
      // Buffered transaction over the existing ref methods (Firestore
      // all-or-nothing): writes apply only after the body resolves.
      runTransaction: async (body: (txn: any) => Promise<unknown>) => {
        const pending: Array<() => Promise<void>> = [];
        const txn = {
          get: (refOrQuery: any) => refOrQuery.get(),
          update: (ref: any, data: Record<string, unknown>) => {
            pending.push(() => ref.update(data));
          },
          create: (ref: any, data: Record<string, unknown>) => {
            pending.push(() => ref.set(data));
          },
          set: (ref: any, data: Record<string, unknown>, options?: Record<string, unknown>) => {
            pending.push(() => ref.set(data, options));
          },
          delete: (ref: any) => {
            pending.push(() => ref.delete());
          },
        };
        const result = await body(txn);
        for (const fn of pending) await fn();
        return result;
      },
      batch: () => makeBatch(),
      doc: (path: string) => {
        const [coll, id] = path.split("/");
        return makeDocRef(coll, id);
      },
      getAll: async () => [],
    },
    FieldValue: { serverTimestamp: () => "now", delete: () => ({ __delete: true }) },
    Timestamp: { now: () => ({ toDate: () => new Date() }) },
  };
});

const provisionerCalls: Array<{ gatewayId: string; gatewayServiceAccount: string }> = [];
let provisionerNextError: Error | null = null;

vi.mock("@octogee/core/secret-store", () => ({
  provisionGatewayAuthSecret: async (params: {
    gatewayId: string;
    gatewayServiceAccount: string;
  }) => {
    if (provisionerNextError) {
      const e = provisionerNextError;
      provisionerNextError = null;
      throw e;
    }
    provisionerCalls.push(params);
    sideEffects.push(`provision ${params.gatewayId}`);
    return { secretName: `projects/octogee-test/secrets/gateway-auth-token-${params.gatewayId}`, created: true };
  },
}));

type BuildResult = { tag: string; pushedAt: string; digest: string };
const userCalls: Array<{ service: string; limit?: number }> = [];
let nextBuildsResult: BuildResult[] = [];
let nextBuildsError: Error | null = null;

const BUILD_SHA = "a".repeat(40);

vi.hoisted(() => {
  process.env.DEPLOYMENT_TARGET_ID = "test-central";
});

vi.mock("@octogee/core/artifact-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@octogee/core/artifact-registry")>()),
  createCentralReleaseAuthority: () => ({
    resolveManifest: async (sourceSha: string) => ({
      sourceSha,
      manifestDigest: `sha256:${"b".repeat(64)}`,
      openclawVersion: "2026.11.3",
      repository: "us-central1-docker.pkg.dev/octogee/octogee",
      surfaces: {
        gateway: {
          "octogee-gateway": `sha256:${"c".repeat(64)}`,
          "octogee-gateway-builder": `sha256:${"d".repeat(64)}`,
          "gateway-edge": `sha256:${"e".repeat(64)}`,
        },
        platform: {},
      },
    }),
    aliasesFor: () => [],
    keepTagsFor: () => [],
    ensureAliases: async () => [],
  }),
  listGatewayBuilds: async (opts: { service: string; limit?: number }) => {
    userCalls.push({ service: opts.service, limit: opts.limit });
    if (nextBuildsError) {
      const e = nextBuildsError;
      nextBuildsError = null;
      throw e;
    }
    return nextBuildsResult;
  },
}));

vi.mock("../middleware/auth", () => ({

  requireAdmin: (req: any, _res: any, next: any) => {
    req.uid = "admin-user";
    req.user = { email: "admin@octogee.com" };
    next();
  },
  requireAuth: (req: any, _res: any, next: any) => {
    req.uid = "admin-user";
    req.user = usersDocs["admin-user"] ?? { email: "admin@octogee.com" };
    next();
  },
}));

import express from "express";
import adminRouter, { createAdminRoutes } from "../routes/admin.js";
import { userAccountFromData, type UserAccountReader } from "@octogee/core/user-account";

function eligibleUser(slug: string, openclaw: Record<string, unknown> = {}): Record<string, unknown> {
  return { username: slug, onboardingStep: "complete", provisioning: { status: "complete", openclaw: { slug, ...openclaw } } };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

const GATEWAY_REPOSITORY =
  "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway";

function seedDurableGateway(
  gatewayId: string,
  options: {
    imageTag?: string;
    heartbeat?: Record<string, unknown>;
    root?: Record<string, unknown>;
  } = {},
) {
  const imageTag = options.imageTag ?? "abc1234";
  const payload = {
    imageRepository: GATEWAY_REPOSITORY,
    imageTag,
  };
  gatewaysDocs[gatewayId] = {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: null,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "standard",
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
    preemption: null,
    ...options.root,
  };
  gatewayReleasesDocs[`${gatewayId}/1`] = {
    gatewayId,
    release: 1,
    createdAt: 1,
    createdBy: "test",
    sourceRelease: null,
    note: null,
    payloadHash: releasePayloadHash(payload),
    payload,
  };
  if (options.heartbeat) markGatewayServing(gatewayId, options.heartbeat);
}

function markGatewayServing(
  gatewayId: string,
  heartbeat: Record<string, unknown>,
) {
  gatewaysDocs[gatewayId] = {
    ...gatewaysDocs[gatewayId],
    liveRelease: 1,
  };
  glmGatewaysDocs[gatewayId] = {
    docKind: "runtime",
    gatewayId,
    release: 1,
    lifecycle: "serving",
    createdAt: 1,
    createdByOperationId: null,
    helm: {},
    heartbeat,
    lastError: { message: null, at: null },
  };
}

function seedRetirableGateway(gatewayId: string) {
  const observedAt = Date.now();
  seedDurableGateway(gatewayId, {
    heartbeat: {
      status: "ready",
      lastHeartbeatAt: observedAt,
      startedAt: observedAt - 1_000,
      version: "abc1234",
      openclawVersion: "2026.7.1",
      mountedCustomers: [],
    },
  });
}

beforeEach(() => {
  glmOperationsDocs = [];
  glmGatewaysDocs = {};
  gatewaysDocs = {};
  gatewayReleasesDocs = {};
  gatewayAssignmentsDocs = {};
  usersDocs = {};
  workspacesDocs = {};
  configDocs = {};
  controllerStateDocs = {};
  provisionerCalls.length = 0;
  provisionerNextError = null;
  userCalls.length = 0;
  nextBuildsResult = [];
  nextBuildsError = null;
  sideEffects = [];
  failingStoreTransaction = null;
  process.env.GATEWAY_SERVICE_ACCOUNT = "octogee-gateway@octogee-test.iam.gserviceaccount.com";
});

describe("GET /api/admin/users/:uid — what the product adds", () => {
  const detailOf = (router: express.Router) => {
    const app = express();
    app.use("/api/admin", router);
    return request(app).get("/api/admin/users/uid-alice");
  };

  beforeEach(() => {
    usersDocs = { "uid-alice": { email: "alice@example.test" } };
  });

  it("adds the fields the product's hook reports for the user", async () => {
    const userDetail = vi.fn(async () => ({ onboarding: { step: "complete", complete: true, milestones: {} } }));

    const res = await detailOf(createAdminRoutes({ userDetail }));

    expect(res.status).toBe(200);
    expect(userDetail).toHaveBeenCalledExactlyOnceWith("uid-alice");
    expect(res.body.onboarding).toEqual({ step: "complete", complete: true, milestones: {} });
  });

  it("reads the user's account from the reader it is given", async () => {
    const accounts: UserAccountReader = {
      get: vi.fn(async (uid: string) => userAccountFromData(uid, { username: "alice", email: "alice@reader.test" })),
      getMany: vi.fn(async () => new Map()),
      list: vi.fn(async () => new Map()),
    };

    const res = await detailOf(createAdminRoutes({ accounts }));

    expect(res.status).toBe(200);
    expect(accounts.get).toHaveBeenCalledWith("uid-alice");
    expect(res.body.summary).toMatchObject({ username: "alice", email: "alice@reader.test" });
  });

  it("reports no onboarding state without a product", async () => {
    const res = await detailOf(createAdminRoutes());

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("onboarding");
  });
});

describe("Admin default placement", () => {
  it("projects policy target, assigned gateway, mounted gateway, and pointer drift separately", async () => {
    seedDurableGateway("gw-source", {
      imageTag: "oldsha1",
      root: { profile: "builder", gatewayClass: "builder", imageProfile: "builder", ownerUid: "uid-bob", builderSlug: "bob" },
      heartbeat: { status: "ready", mountedCustomers: ["alice"] },
    });
    seedDurableGateway("gw-target", {
      imageTag: "newsha1",
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-alice": {
        username: "alice",
        provisioning: {
          openclaw: {
            slug: "alice",
            gatewayId: "gw-source",
          },
        },
      },
    };

    const res = await request(buildApp()).get("/api/admin/placement");

    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({
      defaultGatewayId: "gw-target",
      sharedGatewayIds: ["gw-target"],
    });
    expect(res.body.driftSummary["pointer-drift"]).toBe(1);
    expect(res.body.users).toEqual([
      expect.objectContaining({
        id: "uid-alice",
        name: "alice",
        policyTargetGatewayId: "gw-target",
        assignedGatewayId: "gw-source",
        mountedGatewayId: "gw-source",
        driftState: "pointer-drift",
      }),
    ]);
    expect(res.body.gateways).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gatewayId: "gw-target",
          defaultTarget: true,
          assignedCount: 0,
          mountedCount: 0,
          driftCount: 1,
        }),
        expect.objectContaining({
          gatewayId: "gw-source",
          defaultTarget: false,
          assignedCount: 1,
          mountedCount: 1,
          driftCount: 1,
        }),
      ]),
    );
  });

  it("rejects the retired default-gateway setter and override endpoints", async () => {
    seedRetirableGateway("gw-old");
    seedRetirableGateway("gw-new");
    usersDocs = {
      "uid-alice": {
        username: "alice",
        provisioning: { openclaw: { slug: "alice", gatewayId: "gw-new" } },
      },
    };

    const patched = await request(buildApp())
      .patch("/api/admin/placement")
      .send({ defaultGatewayId: "gw-new" });
    expect(patched.status).toBe(404);
    expect(configDocs.orchestrator).toBeUndefined();

    const retiredPut = await request(buildApp())
      .put("/api/admin/placement/overrides/uid-alice")
      .send({ gatewayId: "gw-new" });
    expect(retiredPut.status).toBe(404);

    const retiredDelete = await request(buildApp()).delete(
      "/api/admin/placement/overrides/uid-alice",
    );
    expect(retiredDelete.status).toBe(404);
  });
});

describe("POST /api/admin/gateways — create durable state + op", () => {
  it("writes a durable gateway root and immutable release with an add-gateway operation", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "shared-canary",
      sourceSha: BUILD_SHA,
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ gatewayId: "shared-canary" });
    expect(res.body.operationId).toBeTruthy();

    expect(gatewaysDocs["shared-canary"]).toMatchObject({
      gatewayId: "shared-canary",
      desiredStatus: "running",
      createdBy: "admin-user",
      latestRelease: 1,
      desiredRelease: 1,
    });
    expect(glmGatewaysDocs["shared-canary"]).toBeUndefined();

    expect(commandOperation()).toMatchObject({
      kind: "add-gateway",
      status: "pending",
      createdBy: "admin-user",
      gatewayId: "shared-canary",
    });

    expect(gatewayReleasesDocs["shared-canary/1"]).toMatchObject({
      gatewayId: "shared-canary",
      release: 1,
      sourceRelease: null,
      payload: {
        imageTag: `aaaaaaa-oc2026.11.3@sha256:${"c".repeat(64)}`,
        gatewayEdgeImage: { imageTag: `aaaaaaa-oc2026.11.3@sha256:${"e".repeat(64)}` },
      },
    });
    expect(glmOperationsDocs.map((doc) => doc.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordType: "audit",
        releaseRollout: {
          releaseId: "shared-canary/1",
          releaseTag: `aaaaaaa-oc2026.11.3@sha256:${"c".repeat(64)}`,
          rolloutOperationId: res.body.operationId,
        },
      }),
    ]));
  });

  it("records a partial audit when the initial release exists but the add operation cannot be enqueued", async () => {
    failingStoreTransaction = "admin.fleet.createOperation";

    await request(buildApp()).post("/api/admin/gateways").send({
      gatewayId: "shared-partial",
      sourceSha: BUILD_SHA,
    }).expect(500);

    expect(gatewaysDocs["shared-partial"]).toMatchObject({
      gatewayId: "shared-partial",
      latestRelease: 1,
    });
    expect(glmOperationsDocs.map((doc) => doc.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordType: "audit",
        status: "completed",
        lifecycleStage: "action-partial",
        releaseRollout: {
          releaseId: "shared-partial/1",
          releaseTag: `aaaaaaa-oc2026.11.3@sha256:${"c".repeat(64)}`,
        },
      }),
    ]));
  });

  it("rejects bodies missing required fields with 400", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({ gatewayId: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects new gateway ids ending in the reserved -blue/-green roll-role suffixes", async () => {
    const app = buildApp();
    for (const gatewayId of ["team-blue", "team-green"]) {
      const res = await request(app).post("/api/admin/gateways").send({
        gatewayId,
        sourceSha: BUILD_SHA,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reserved for roll roles/);
      expect(gatewaysDocs[gatewayId]).toBeUndefined();
    }
  });

  it("persists sizingTier for a shared gateway", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "shared-sized",
      sourceSha: BUILD_SHA,
      sizingTier: "l",
    });
    expect(res.status).toBe(202);
    expect(gatewaysDocs["shared-sized"]).toMatchObject({
      profile: null,
      gatewayClass: "shared",
      imageProfile: "standard",
      sizingTier: "l",
      builderAccess: null,
      serviceAccountName: null,
      serviceAccount: null,
    });
  });

  it("rejects the retired operator profile before side effects", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "jack",
      sourceSha: BUILD_SHA,
      profile: "operator",
      ownerUid: "uid-jack",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/profile.*standard.*builder/i);
    expect(provisionerCalls).toEqual([]);
    expect(gatewaysDocs.jack).toBeUndefined();
  });

  it("rejects manually creating an owner isolated gateway before side effects", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "jack",
      sourceSha: BUILD_SHA,
      gatewayClass: "isolated",
      ownerUid: "uid-jack",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/isolated gateways.*disposable lifecycle/);
    expect(provisionerCalls).toEqual([]);
    expect(gatewaysDocs.jack).toBeUndefined();
  });

  it("rejects manually creating owner gateways without an owner before side effects", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "jack",
      sourceSha: BUILD_SHA,
      gatewayClass: "isolated",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/isolated gateways.*disposable lifecycle/);
    expect(provisionerCalls).toEqual([]);
    expect(gatewaysDocs.jack).toBeUndefined();
  });

  it("rejects owner fields on shared gateways before side effects", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "shared-with-owner",
      sourceSha: BUILD_SHA,
      ownerUid: "uid-jack",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/shared gateway creation does not accept owner fields/);
    expect(provisionerCalls).toEqual([]);
    expect(gatewaysDocs["shared-with-owner"]).toBeUndefined();
  });

  it("rejects owner gateway creation before looking up a supplied owner", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "ghost",
      sourceSha: BUILD_SHA,
      gatewayClass: "isolated",
      ownerUid: "uid-ghost",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/isolated gateways.*disposable lifecycle/);
    expect(provisionerCalls).toEqual([]);
    expect(gatewaysDocs.ghost).toBeUndefined();
  });

  it("rejects unknown sizingTier values on create with 400", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "invalid-tier",
      sourceSha: BUILD_SHA,
      sizingTier: "bogus-tier",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sizingTier/);
    expect(gatewaysDocs["invalid-tier"]).toBeUndefined();
  });

  it("provisions the gateway auth secret inside the transaction that creates the durable root", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "shared-ready",
      sourceSha: BUILD_SHA,
    });
    expect(res.status).toBe(202);
    expect(provisionerCalls).toEqual([
      {
        gatewayId: "shared-ready",
        gatewayServiceAccount: "octogee-gateway@octogee-test.iam.gserviceaccount.com",
      },
    ]);
    expect(sideEffects.filter((effect) => effect.endsWith("shared-ready") || effect === "begin gateway-release.initial")).toEqual([
      "begin gateway-release.initial",
      "provision shared-ready",
      "set gateways/shared-ready",
    ]);
  });

  it("does NOT write the durable root if SM provisioning fails — operator gets 502 with detail", async () => {
    provisionerNextError = new Error("PERMISSION_DENIED on secretmanager.secrets.create");
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "shared-nosecret",
      sourceSha: BUILD_SHA,
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/auth-token/);
    expect(gatewaysDocs["shared-nosecret"]).toBeUndefined();
    expect(gatewayReleasesDocs["shared-nosecret/1"]).toBeUndefined();
  });

  it("returns 500 if GATEWAY_SERVICE_ACCOUNT is not configured (cluster misconfigured)", async () => {
    delete process.env.GATEWAY_SERVICE_ACCOUNT;
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "shared-noaccount",
      sourceSha: BUILD_SHA,
    });
    expect(res.status).toBe(500);
    expect(provisionerCalls).toEqual([]);
  });

  it("returns 409 when the gatewayId already exists", async () => {
    seedDurableGateway("shared-existing");
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: "shared-existing",
      sourceSha: BUILD_SHA,
    });
    expect(res.status).toBe(409);
  });

});

describe("PATCH /api/admin/gateways/:id — durable config only", () => {
  it("rejects an imageTag write when the gateway has mounted users", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: ["u1", "u2"] },
    });
    const app = buildApp();

    const res = await request(app).patch("/api/admin/gateways/default").send({ imageTag: "new" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/immutable releases/i);
    expect(gatewaysDocs["default"].latestRelease).toBe(1);
  });

  it("rejects an imageTag write on an empty gateway", async () => {
    seedDurableGateway("canary");
    const app = buildApp();

    const res = await request(app).patch("/api/admin/gateways/canary").send({ imageTag: "new" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/immutable releases/i);
    expect(gatewayReleasesDocs["canary/1"].payload).toMatchObject({ imageTag: "abc1234" });
  });

  it("allows a non-image PATCH (desiredStatus) on a mounted gateway", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: ["u1"] },
    });
    const app = buildApp();

    const res = await request(app).patch("/api/admin/gateways/default").send({ desiredStatus: "paused" });

    expect(res.status).toBe(202);
    expect(gatewaysDocs["default"].desiredStatus).toBe("paused");
  });
});

describe("GET /api/admin/gateways — sizing enrichment", () => {
  it("attaches sizing.tier from the durable root and marks it explicit", async () => {
    seedDurableGateway("walter", {
      heartbeat: { status: "ready", mountedCustomers: ["alice"] },
      root: {
        sizingTier: "l",
        profile: "builder",
        gatewayClass: "builder",
        imageProfile: "builder",
        ownerUid: "uid-walter",
        builderSlug: "walter",
      },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    expect(res.status).toBe(200);
    const walter = res.body.gateways.find((g: any) => g.gatewayId === "walter");
    expect(walter.sizing.tier).toBe("l");
    expect(walter.sizing.resolvedFrom).toBe("explicit");
    expect(walter.sizing.resources.requests.cpu).toBe("4000m");
    expect(walter.sizing.monthlyCostUsd.compute).toBeGreaterThan(0);
    expect(walter.desiredStatus).toBe("running");
  });

  it("falls back to class-default tier when sizingTier is unset (resolvedFrom='class-default')", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: {
        profile: "builder",
        gatewayClass: "builder",
        imageProfile: "builder",
        ownerUid: "uid-default",
        builderSlug: "default",
      },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const g = res.body.gateways.find((x: any) => x.gatewayId === "default");
    expect(g.sizing.tier).toBe("s");
    expect(g.sizing.resolvedFrom).toBe("class-default");
  });

  it("reports compute=0 for paused gateways (no replicas → no node consumption)", async () => {
    seedDurableGateway("paused", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: { sizingTier: "l", desiredStatus: "paused" },
    });
    seedDurableGateway("running", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: { sizingTier: "l" },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const paused = res.body.gateways.find((g: any) => g.gatewayId === "paused");
    const running = res.body.gateways.find((g: any) => g.gatewayId === "running");
    expect(paused.sizing.tier).toBe("l");
    expect(paused.sizing.monthlyCostUsd.compute).toBe(0);
    expect(paused.sizing.monthlyCostUsd.perUserAtTarget).toBe(0);
    expect(running.sizing.monthlyCostUsd.compute).toBeGreaterThan(0);
    expect(res.body.stats.fleetCost.monthlyUsd).toBe(running.sizing.monthlyCostUsd.compute);
  });

  it("drops any legacy persistence to emptyDir and keeps the PROD operator Spot reservation default", async () => {
    seedDurableGateway("walter", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: {
        gatewayClass: "builder",
        profile: "builder",
        imageProfile: "builder",
        ownerUid: "uid-walter",
        builderSlug: "walter",
        sizingTier: "m",
        persistence: {
          enabled: true,
          storageClassName: "premium-rwo",
          size: "20Gi",
          accessModes: ["ReadWriteOnce"],
        },
      },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const walter = res.body.gateways.find((g: any) => g.gatewayId === "walter");
    expect(walter.storage).toMatchObject({ mode: "emptyDir", pvcName: null });
    expect(walter.reservation).toMatchObject({
      type: "spot",
    });
    expect(walter.sizing.monthlyCostUsd.compute).toBeLessThan(
      walter.sizing.monthlyCostUsd.onDemandCompute,
    );
    expect(res.body.stats.fleetCost.savingsUsd).toBeGreaterThan(0);
  });

  it("defaults isolated gateways to Spot even with a residual computeClass", async () => {
    seedDurableGateway("dedicated", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: {
        gatewayClass: "builder",
        profile: "builder",
        imageProfile: "builder",
        ownerUid: "uid-dedicated",
        builderSlug: "dedicated",
        sizingTier: "m",
        computeClass: "octogee-gateway",
      },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const dedicated = res.body.gateways.find((g: any) => g.gatewayId === "dedicated");
    expect(dedicated.storage).toMatchObject({ mode: "emptyDir", pvcName: null });
    expect(dedicated.reservation).toEqual({
      type: "spot",
      priceMultiplier: 0.3,
      source: "class-default",
    });
    expect(dedicated.sizing.monthlyCostUsd.compute).toBeLessThan(
      dedicated.sizing.monthlyCostUsd.onDemandCompute,
    );
  });

  it("defaults shared gateways to On-Demand pricing", async () => {
    seedDurableGateway("shared", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: { sizingTier: "m" },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const shared = res.body.gateways.find((g: any) => g.gatewayId === "shared");
    expect(shared.reservation).toMatchObject({
      type: "on-demand",
      source: "class-default",
    });
    expect(shared.sizing.monthlyCostUsd.compute).toBe(
      shared.sizing.monthlyCostUsd.onDemandCompute,
    );
    expect(res.body.stats.fleetCost.savingsUsd).toBe(0);
  });

  it("rolls up stats.fleetCost.byTier and stats.fleetCost.monthlyUsd across the fleet", async () => {
    seedDurableGateway("walter", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: { sizingTier: "l" },
    });
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: { sizingTier: "m" },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways");
    const fc = res.body.stats.fleetCost;
    expect(fc).toBeDefined();
    expect(fc.byTier.l?.count).toBe(1);
    expect(fc.byTier["m"]?.count).toBe(1);
    expect(fc.monthlyUsd).toBe(fc.byTier.l.subtotalUsd + fc.byTier["m"].subtotalUsd);
  });
});

describe("PATCH /api/admin/gateways/:id — update desired state", () => {
  it("rejects an imageTag field on an existing durable root", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ imageTag: "def5678" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/immutable releases/i);
    expect(gatewayReleasesDocs["canary/1"].payload).toMatchObject({ imageTag: "abc1234" });
  });

  it("returns 404 when the gateway does not exist", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/gw-missing")
      .send({ imageTag: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects unknown desiredStatus enum values with 400 (does not write garbage to Firestore)", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ desiredStatus: "burning" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/desiredStatus/);
    expect(sideEffects).not.toContain("set gateways/canary");
  });

  it("rejects desiredStatus=retired — retirement must go through DELETE for full teardown", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ desiredStatus: "retired" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/DELETE \/gateways\/:id/);
    expect(sideEffects).not.toContain("set gateways/canary");
  });

  it("accepts desiredStatus=paused for the pause/resume flow", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ desiredStatus: "paused" });
    expect(res.status).toBe(202);
    expect(gatewaysDocs.canary).toMatchObject({ desiredStatus: "paused" });
  });

  it("updates the sizingTier field when a valid tier is supplied", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ sizingTier: "l" });
    expect(res.status).toBe(202);
    expect(gatewaysDocs.canary).toMatchObject({ sizingTier: "l" });
  });

  it("rejects unknown sizingTier values with 400 (does not write garbage to Firestore)", async () => {
    seedDurableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .patch("/api/admin/gateways/canary")
      .send({ sizingTier: "bogus-tier" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/durable gateway configuration/);
    expect(sideEffects).not.toContain("set gateways/canary");
  });
});

describe("POST /api/admin/gateways — body type guards", () => {
  it("rejects non-string gatewayId with 400", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/gateways").send({
      gatewayId: 12345,
      sourceSha: BUILD_SHA,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it("rejects gatewayIds that cannot render as fleet Kubernetes resource names", async () => {
    const app = buildApp();
    for (const gatewayId of [
      "Walter",
      "gw_test",
      "-walter",
      "walter-",
      "a".repeat(33),
    ]) {
      const res = await request(app).post("/api/admin/gateways").send({
        gatewayId,
        sourceSha: BUILD_SHA,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/gatewayId/i);
    }
    expect(gatewaysDocs).toEqual({});
    expect(provisionerCalls).toEqual([]);
  });
});

describe("POST /api/admin/users/:uid/migrate — body type guards", () => {
  it("rejects non-string `to` field with 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-bob/migrate")
      .send({ to: 42 });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/rollouts — body type guards", () => {
  it("rejects non-string imageTag with 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/rollouts")
      .send({ gatewayId: "default", targetRelease: 2, imageTag: 9999 });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/admin/gateways/:id — retire", () => {
  it("atomically claims a converged gateway for retirement when no users are mounted", async () => {
    seedRetirableGateway("canary");
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(202);
    expect(gatewaysDocs.canary).toMatchObject({
      desiredStatus: "retired",
      retirementVersion: 1,
      retirementClaim: { operationId: res.body.operationId, version: 1 },
    });
    expect(storedOperation(res.body.operationId)).toMatchObject({
      kind: "retire-gateway",
      createdBy: "admin-user",
      input: { gatewayId: "canary", retirementClaimVersion: 1 },
    });
  });

  it("defaults to full teardown — no retain flags on the retire-gateway op", async () => {
    seedRetirableGateway("canary");
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(202);
    expect(res.body.retainData).toBe(false);
    expect(res.body.retainServiceAccount).toBe(false);
    const input = storedOperation(res.body.operationId)?.input as Record<string, unknown> | undefined;
    expect(input).toMatchObject({ gatewayId: "canary" });
    expect(input?.retainData).toBeUndefined();
    expect(input?.retainServiceAccount).toBeUndefined();
  });

  it("passes retainData + retainServiceAccount through to the retire-gateway operation", async () => {
    seedRetirableGateway("canary");
    const app = buildApp();
    const res = await request(app)
      .delete("/api/admin/gateways/canary")
      .query({ retainData: "true", retainServiceAccount: "true" });
    expect(res.status).toBe(202);
    expect(res.body.retainData).toBe(true);
    expect(res.body.retainServiceAccount).toBe(true);
    expect(storedOperation(res.body.operationId)?.input).toMatchObject({
      gatewayId: "canary",
      retainData: true,
      retainServiceAccount: true,
    });
  });

  it("returns 404 when the gateway does not exist", async () => {
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/gw-missing");
    expect(res.status).toBe(404);
  });

  it("returns 409 with the user list when the gateway still has mounted users", async () => {
    seedDurableGateway("canary", {
      heartbeat: { status: "ready", mountedCustomers: ["alice", "bob"] },
    });
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still has mounted users/i);
    expect(res.body.mountedUsers).toEqual(["alice", "bob"]);
    expect(gatewaysDocs.canary).toMatchObject({ desiredStatus: "running" });
    expect(gatewaysDocs.canary.retirementClaim).toBeUndefined();
  });

  it("fails closed when the runtime telemetry is unavailable", async () => {
    seedRetirableGateway("orphan");
    delete glmGatewaysDocs["orphan"];
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/orphan");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/runtime telemetry is unavailable/i);
    expect(gatewaysDocs.orphan).toMatchObject({ desiredStatus: "running" });
    expect(glmOperationsDocs.find((d) => d.data.kind === "retire-gateway")).toBeUndefined();
  });

  it("commits retirement claim + op create in one transaction", async () => {
    seedRetirableGateway("canary");
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(202);

    const claimAt = sideEffects.indexOf("begin gateway-retirement.claim");
    const nextTransactionAt = sideEffects.findIndex(
      (effect, index) => index > claimAt && effect.startsWith("begin "),
    );
    expect(claimAt).toBeGreaterThanOrEqual(0);
    expect(nextTransactionAt).toBeGreaterThan(claimAt);
    expect(sideEffects.slice(claimAt + 1, nextTransactionAt)).toEqual([
      "set gateways/canary",
      `set glmOperations/${res.body.operationId}`,
    ]);
  });

  it("rolls back both claim writes if the claim transaction fails", async () => {
    seedRetirableGateway("canary");
    failingStoreTransaction = "gateway-retirement.claim";
    const app = buildApp();
    const res = await request(app).delete("/api/admin/gateways/canary");
    expect(res.status).toBe(500);

    expect(sideEffects).toContain("begin gateway-retirement.claim");
    expect(gatewaysDocs["canary"]).toMatchObject({ desiredStatus: "running" });
    expect(glmOperationsDocs.find((d) => d.data.kind === "retire-gateway")).toBeUndefined();
  });

});

describe("POST /api/admin/gateways/:id/restart — rotate the pod via kubectl rollout restart", () => {
  it("creates a restart-gateway operation (kind carried in input)", async () => {
    seedDurableGateway("walter", { imageTag: "abcdef1" });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/walter/restart")
      .send({});
    expect(res.status).toBe(202);
    expect(commandOperation()).toMatchObject({
      kind: "restart-gateway",
      input: { gatewayId: "walter" },
      createdBy: "admin-user",
    });
  });

  it("returns 404 when the gateway is not registered", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/gw-missing/restart")
      .send({});
    expect(res.status).toBe(404);
    expect(commandOperation()).toBeUndefined();
  });

  it("does NOT gate on mountedCustomers — restart is operator intent", async () => {
    seedDurableGateway("walter", {
      imageTag: "abcdef1",
      heartbeat: { status: "ready", mountedCustomers: ["alice", "bob"] },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/walter/restart")
      .send({});
    expect(res.status).toBe(202);
  });

  it("returns 409 when another op is already pending or running for this gateway", async () => {
    seedDurableGateway("walter", { imageTag: "abcdef1" });
    glmOperationsDocs.push({
      id: "op-running-99",
      data: {
        kind: "rollout",
        status: "running",
        input: { gatewayId: "walter", imageTag: "feedbee" },
      },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/gateways/walter/restart")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already pending or running/);
    expect(res.body.operationId).toBe("op-running-99");
  });

});

describe("POST /api/admin/users/:uid/migrate — start migration", () => {
  it("creates a migrate-customer operation", async () => {
    seedDurableGateway("canary", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-alice/migrate")
      .send({ to: "canary" });
    expect(res.status).toBe(202);
    expect(commandOperation()).toMatchObject({
      kind: "migrate-user",
      status: "pending",
      input: {
        uid: "uid-alice",
        builderSlug: "alice",
        fromGatewayId: "default",
        toGatewayId: "canary",
      },
      createdBy: "admin-user",
    });
  });

  it("rejects without a target gateway", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-alice/migrate")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when the target gateway is not registered", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-alice/migrate")
      .send({ to: "gw-bogus" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the target gateway is registered but not ready", async () => {
    seedDurableGateway("gw-booting", {
      heartbeat: { status: "booting", mountedCustomers: [] },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-alice/migrate")
      .send({ to: "gw-booting" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when the target equals the user's current gateway (migrate-to-self)", async () => {
    seedDurableGateway("canary", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs["uid-alice"] = {
      provisioning: { openclaw: { slug: "alice", gatewayId: "canary" } },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-alice/migrate")
      .send({ to: "canary" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already/i);
  });

  it("returns 409 with the blocking op while a migration for the user is already pending or running (Retry double-click)", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
    };
    glmOperationsDocs.unshift({
      id: "op-mig-live",
      data: {
        kind: "migrate-user",
        status: "pending",
        inputUid: "uid-alice",
        input: { uid: "uid-alice", toGatewayId: "canary" },
      },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-alice/migrate")
      .send({ to: "canary" });
    expect(res.status).toBe(409);
    expect(res.body.operationId).toBe("op-mig-live");
    expect(glmOperationsDocs.filter((doc) => doc.data.recordType !== "audit").map((doc) => doc.id))
      .toEqual(["op-mig-live"]);
  });
});

describe("POST /api/admin/users/:uid/unassign — clear assignment, let reconcile evict", () => {
  it("clears provisioning.openclaw.gatewayId and reports where the user was", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default-green" } },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-alice/unassign")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unassigned: true, uid: "uid-alice", from: "default-green" });
    expect(usersDocs["uid-alice"].provisioning).toEqual({ openclaw: { slug: "alice" } });
  });

  it("returns 404 for an unknown user", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-ghost/unassign")
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 409 when the user is already unassigned", async () => {
    usersDocs["uid-alice"] = { username: "alice", provisioning: { openclaw: { slug: "alice" } } };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-alice/unassign")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already unassigned/i);
  });

  it("returns 409 while a migration for the user is pending or running", async () => {
    usersDocs["uid-alice"] = {
      username: "alice",
      provisioning: { openclaw: { slug: "alice", gatewayId: "default-green" } },
    };
    glmOperationsDocs.unshift({
      id: "op-mig-1",
      data: {
        kind: "migrate-user",
        status: "running",
        inputUid: "uid-alice",
        input: { uid: "uid-alice", toGatewayId: "default-blue" },
      },
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-alice/unassign")
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.operationId).toBe("op-mig-1");
    expect(sideEffects).not.toContain("set users/uid-alice");
  });
});

describe("POST /api/admin/rollouts — composite operation", () => {
  it("creates a rollout operation with the gateway + target image", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/admin/rollouts").send({
      gatewayId: "default",
      targetRelease: 2,
      imageTag: "def5678",
    });
    expect(res.status).toBe(202);
    expect(commandOperation()).toMatchObject({
      kind: "rollout",
      status: "pending",
      input: { gatewayId: "default", targetRelease: 2, imageTag: "def5678" },
      createdBy: "admin-user",
    });
  });

  it("does not replay a completed Idempotency-Key", async () => {
    const app = buildApp();
    const requestBody = { gatewayId: "default", targetRelease: 2, imageTag: "def5678" };

    await request(app)
      .post("/api/admin/rollouts")
      .set("Idempotency-Key", "rollout-1")
      .send(requestBody)
      .expect(202);
    const replay = await request(app)
      .post("/api/admin/rollouts")
      .set("Idempotency-Key", "rollout-1")
      .send(requestBody)
      .expect(409);

    expect(replay.body).toMatchObject({ status: "completed", auditId: expect.any(String) });
    expect(glmOperationsDocs.filter((doc) => doc.data.kind === "rollout")).toHaveLength(1);
  });

  it("rejects an Idempotency-Key reused for a different rollout", async () => {
    const app = buildApp();

    await request(app)
      .post("/api/admin/rollouts")
      .set("Idempotency-Key", "rollout-1")
      .send({ gatewayId: "default", targetRelease: 2, imageTag: "def5678" })
      .expect(202);
    const conflict = await request(app)
      .post("/api/admin/rollouts")
      .set("Idempotency-Key", "rollout-1")
      .send({ gatewayId: "default", targetRelease: 2, imageTag: "abc1234" })
      .expect(409);

    expect(conflict.body).toMatchObject({
      error: expect.stringContaining("conflicts with its deterministic idempotency key"),
      auditId: expect.any(String),
    });
    expect(glmOperationsDocs.filter((doc) => doc.data.kind === "rollout")).toHaveLength(1);
  });
});

describe("GET /api/admin/user-by-slug/:slug — slug→uid lookup", () => {
  it("returns uid + currentGatewayId for a slug stored at provisioning.openclaw.slug", async () => {
    usersDocs["uid-alice"] = {
      provisioning: { openclaw: { slug: "alice", gatewayId: "canary" } },
    };
    const app = buildApp();
    const res = await request(app).get("/api/admin/user-by-slug/alice");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uid: "uid-alice", currentGatewayId: "canary" });
  });

  it("falls back to username when no provisioning slug matches", async () => {
    usersDocs["uid-bob"] = { username: "bob" };
    const app = buildApp();
    const res = await request(app).get("/api/admin/user-by-slug/bob");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uid: "uid-bob", currentGatewayId: null });
  });

  it("returns currentGatewayId=null when the user doc has no provisioned gateway yet", async () => {
    usersDocs["uid-claire"] = {
      provisioning: { openclaw: { slug: "claire" } },
    };
    const app = buildApp();
    const res = await request(app).get("/api/admin/user-by-slug/claire");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ uid: "uid-claire", currentGatewayId: null });
  });

  it("returns 404 when no user has the slug or username", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/admin/user-by-slug/ghost");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/admin/user-distribution — fleet-wide ops view", () => {
  it("buckets every user into mounted / assigned-not-mounted / unassigned", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: ["alice", "bob"] },
    });
    usersDocs = {
      "uid-alice": {
        username: "alice",
        email: "alice@example.com",
        provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
      },
      "uid-bob": {
        username: "bob",
        email: "bob@example.com",
        provisioning: { openclaw: { slug: "bob", gatewayId: "default" } },
      },
      "uid-carol": {
        username: "carol",
        email: "carol@example.com",
        provisioning: { openclaw: { slug: "carol", gatewayId: "default" } },
      },
      "uid-dave": {
        username: "dave",
        email: "dave@example.com",
        provisioning: {},
      },
      "uid-eve": {
        username: "eve",
        email: "eve@example.com",
        provisioning: { openclaw: { slug: "eve", gatewayId: "default" } },
      },
    };
    const app = buildApp();
    const res = await request(app).get("/api/admin/user-distribution");
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({
      totalUsers: 5,
      assigned: 4,
      unassigned: 1,
      mounted: 2,
      assignedNotMounted: 2,
    });
    expect(res.body.pendingPlacements).toHaveLength(1);
    expect(res.body.pendingPlacements[0]).toMatchObject({
      uid: "uid-dave",
      username: "dave",
      reason: "never-assigned",
      currentGatewayId: null,
    });
    expect(res.body.perGateway).toEqual([
      expect.objectContaining({
        gatewayId: "default",
        status: "ready",
        assignedCount: 4,
        mountedCount: 2,
      }),
    ]);
  });

  it("flags users whose gateway no longer exists with reason='gateway-gone'", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-orphan": {
        username: "orphan",
        email: "orphan@example.com",
        provisioning: { openclaw: { slug: "orphan", gatewayId: "gw-deleted" } },
      },
    };
    const app = buildApp();
    const res = await request(app).get("/api/admin/user-distribution");
    expect(res.status).toBe(200);
    expect(res.body.pendingPlacements).toHaveLength(1);
    expect(res.body.pendingPlacements[0]).toMatchObject({
      uid: "uid-orphan",
      reason: "gateway-gone",
      currentGatewayId: "gw-deleted",
    });
  });

  it("returns empty buckets when no userRecords exist", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {};
    const app = buildApp();
    const res = await request(app).get("/api/admin/user-distribution");
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({
      totalUsers: 0,
      assigned: 0,
      unassigned: 0,
      mounted: 0,
    });
    expect(res.body.pendingPlacements).toEqual([]);
  });
});

describe("POST /api/admin/users/:uid/assign — initial placement", () => {
  it("writes placement without a separate eligibility field", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-dave": { ...eligibleUser("dave"), email: "dave@example.com" },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-dave/assign")
      .send({ gatewayId: "default" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ uid: "uid-dave", gatewayId: "default" });
    expect(usersDocs["uid-dave"]).toHaveProperty("provisioning.openclaw.gatewayId", "default");
  });

  it("rejects assigning a user to an owner gateway", async () => {
    seedDurableGateway("gw-operator", {
      heartbeat: { status: "ready", mountedCustomers: [] },
      root: {
        profile: "builder",
        gatewayClass: "builder",
        imageProfile: "builder",
        ownerUid: "uid-owner",
        builderSlug: "owner",
        builderAccess: {
          controlUiEnabled: true,
          reason: "owned-runtime-gateway",
        },
      },
    });
    usersDocs = {
      "uid-dave": { ...eligibleUser("dave"), email: "dave@example.com" },
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-dave/assign")
      .send({ gatewayId: "gw-operator" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ reason: "gateway-not-shared", error: expect.stringMatching(/isolated; only shared gateways/) });

    expect(sideEffects).not.toContain("set glmGateways/gw-operator");
    expect(sideEffects).not.toContain("set users/uid-dave");
  });

  it("returns 400 when gatewayId is missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-dave/assign")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when the user does not exist", async () => {
    gatewaysDocs = { "default": { status: "ready" } };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-missing/assign")
      .send({ gatewayId: "default" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/user not found/);
  });

  it("returns 404 when the target gateway is not registered", async () => {
    usersDocs = { "uid-dave": eligibleUser("dave") };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-dave/assign")
      .send({ gatewayId: "gw-missing" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/gateway not found/);
  });

  it("assigns onto a running gateway that is still booting", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "booting", mountedCustomers: [] },
    });
    usersDocs = { "uid-dave": eligibleUser("dave") };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-dave/assign")
      .send({ gatewayId: "default" });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(usersDocs["uid-dave"]).toHaveProperty("provisioning.openclaw.gatewayId", "default");
  });

  it("repairs a missing durable assignment when the mirror already targets that gateway", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-alice": eligibleUser("alice", { gatewayId: "default" }),
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/admin/users/uid-alice/assign")
      .send({ gatewayId: "default" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ repaired: true, gatewayId: "default" });
    expect(gatewayAssignmentsDocs["default/uid-alice"]).toMatchObject({ source: "repair", slug: "alice" });
  });

  it("preserves an in-flight assignment when same-target repair races a roll", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-alice": eligibleUser("alice", { gatewayId: "default" }),
    };
    const existing = {
      uid: "uid-alice",
      slug: "alice",
      gatewayId: "default",
      source: "migrate-user",
      state: "quiescing",
      epoch: 7,
      updatedAt: 90,
      updatedByOperationId: "roll-default-r2",
    };
    gatewayAssignmentsDocs["default/uid-alice"] = existing;

    const res = await request(buildApp())
      .post("/api/admin/users/uid-alice/assign")
      .send({ gatewayId: "default" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(gatewayAssignmentsDocs["default/uid-alice"]).toEqual(existing);
    expect(sideEffects).not.toContain("set gateways/default/assignments/uid-alice");
  });

  it("rejects assignment when the user has no slug", async () => {
    seedDurableGateway("default", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    usersDocs = {
      "uid-orphan": {
        onboardingStep: "complete",
        provisioning: { status: "complete", openclaw: { gatewayId: "default" } },
      },
    };

    const res = await request(buildApp())
      .post("/api/admin/users/uid-orphan/assign")
      .send({ gatewayId: "default" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason: "user-slug-missing", error: "user has no slug" });
    expect(gatewayAssignmentsDocs["default/uid-orphan"]).toBeUndefined();
  });
});

describe("GET /api/admin/gateways/:id/details — drawer payload", () => {
  it("returns mounted-user details + recent ops for the gateway", async () => {
    seedDurableGateway("default", {
      imageTag: "abc1234",
      heartbeat: { status: "ready", mountedCustomers: ["alice", "bob"] },
    });
    usersDocs = {
      "uid-alice": {
        username: "alice",
        email: "alice@octogee.com",
        throttleLevel: 0,
        lastActive: "2026-05-04T09:00:00Z",
        provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
      },
      "uid-bob": {
        username: "bob",
        email: "bob@octogee.com",
        throttleLevel: 2,
        lastActive: "2026-05-04T08:30:00Z",
        provisioning: { openclaw: { slug: "bob", gatewayId: "default" } },
      },
      "uid-carol": {
        username: "carol",
        email: "carol@octogee.com",
        provisioning: { openclaw: { slug: "carol", gatewayId: "gw-other" } },
      },
    };
    glmOperationsDocs = [
      {
        id: "op-this-gw",
        data: {
          kind: "rollout",
          status: "succeeded",
          createdAt: 5_000,
          gatewayId: "default",
          input: { gatewayId: "default", imageTag: "abc1234" },
          steps: [],
        },
      },
      {
        id: "op-other-gw",
        data: {
          kind: "rollout",
          status: "succeeded",
          createdAt: 4_000,
          gatewayId: "gw-other",
          input: { gatewayId: "gw-other" },
          steps: [],
        },
      },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways/default/details");
    expect(res.status).toBe(200);
    expect(res.body.mountedUsers).toHaveLength(2);
    const slugs = res.body.mountedUsers.map((m: { slug: string }) => m.slug).sort();
    expect(slugs).toEqual(["alice", "bob"]);
    const alice = res.body.mountedUsers.find(
      (m: { slug: string }) => m.slug === "alice",
    );
    expect(alice).toMatchObject({
      uid: "uid-alice",
      username: "alice",
      email: "alice@octogee.com",
    });
    expect(res.body.recentOperations).toHaveLength(1);
    expect(res.body.recentOperations[0].id).toBe("op-this-gw");
    expect(res.body.generatedAt).toBeTruthy();
  });

  it("returns empty mountedCustomers when the gateway heartbeat doc has no mounts", async () => {
    seedDurableGateway("gw-empty", {
      heartbeat: { status: "ready", mountedCustomers: [] },
    });
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways/gw-empty/details");
    expect(res.status).toBe(200);
    expect(res.body.mountedUsers).toEqual([]);
  });

  it("404s for an unknown gateway", async () => {
    glmGatewaysDocs = {};
    gatewaysDocs = {};
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways/gw-missing/details");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("survives a missing heartbeat doc when the desired-state record exists", async () => {
    seedDurableGateway("gw-booting");
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways/gw-booting/details");
    expect(res.status).toBe(200);
    expect(res.body.mountedUsers).toEqual([]);
  });

  it("only returns operations whose input.gatewayId matches the path id", async () => {
    seedDurableGateway("default");
    glmOperationsDocs = [
      {
        id: "op-a",
        data: {
          kind: "rollout",
          status: "succeeded",
          createdAt: 5_000,
          gatewayId: "default",
          input: { gatewayId: "default" },
          steps: [],
        },
      },
      {
        id: "op-b",
        data: {
          kind: "migrate-user",
          status: "succeeded",
          createdAt: 4_000,
          input: { uid: "uid-alice" },
          steps: [],
        },
      },
      {
        id: "op-c",
        data: {
          kind: "add-gateway",
          status: "succeeded",
          createdAt: 3_000,
          gatewayId: "gw-other",
          input: { gatewayId: "gw-other" },
          steps: [],
        },
      },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/gateways/default/details");
    expect(res.status).toBe(200);
    expect(res.body.recentOperations.map((o: { id: string }) => o.id)).toEqual(["op-a"]);
  });
});

describe("GET /api/admin/builds — Artifact Registry SHA picker", () => {
  it("returns the recent SHA-tagged builds for the requested service", async () => {
    nextBuildsResult = [
      { tag: "abc1234", pushedAt: "2026-05-04T10:00:00Z", digest: "sha256:aaa" },
      { tag: "def5678", pushedAt: "2026-05-03T08:00:00Z", digest: "sha256:bbb" },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/builds?service=octogee-gateway");
    expect(res.status).toBe(200);
    expect(res.body.builds).toHaveLength(2);
    expect(res.body.builds[0].tag).toBe("abc1234");
    expect(res.body.service).toBe("octogee-gateway");
    expect(res.body.generatedAt).toBeTruthy();
    expect(userCalls[0].service).toBe("octogee-gateway");
  });

  it("defaults to octogee-gateway when no service is provided", async () => {
    nextBuildsResult = [];
    const app = buildApp();
    const res = await request(app).get("/api/admin/builds");
    expect(res.status).toBe(200);
    expect(res.body.service).toBe("octogee-gateway");
    expect(userCalls[0].service).toBe("octogee-gateway");
  });

  it("rejects services outside the allowlist", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/admin/builds?service=evil-image");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/service/i);
    expect(userCalls).toHaveLength(0);
  });

  it("accepts the gateway-edge service; rejects the retired chat-proxy image", async () => {
    nextBuildsResult = [];
    const app = buildApp();

const a = await request(app).get("/api/admin/builds?service=octogee-chat-proxy");
    const b = await request(app).get("/api/admin/builds?service=gateway-edge");
    expect(a.status).toBe(400);
    expect(b.status).toBe(200);
    expect(userCalls.map((c) => c.service)).toEqual(["gateway-edge"]);
  });

  it("clamps limit to a sane maximum", async () => {
    nextBuildsResult = [];
    const app = buildApp();
    const res = await request(app).get("/api/admin/builds?limit=500");
    expect(res.status).toBe(200);
    expect(userCalls[0].limit).toBeLessThanOrEqual(100);
  });

  it("propagates Artifact Registry failures as 502", async () => {
    nextBuildsError = new Error("artifact-registry list failed: 403 Forbidden");
    const app = buildApp();
    const res = await request(app).get("/api/admin/builds");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/artifact-registry/i);
  });
});

describe("GET /api/admin/operations — history", () => {
  it("returns a list of operations with newest first", async () => {
    glmOperationsDocs = [
      {
        id: "op-newer",
        data: {
          kind: "migrate-user",
          status: "succeeded",
          createdAt: 2_000,
          steps: [],
        },
      },
      {
        id: "op-older",
        data: {
          kind: "add-gateway",
          status: "succeeded",
          createdAt: 1_000,
          steps: [],
        },
      },
    ];
    const app = buildApp();
    const res = await request(app).get("/api/admin/operations");
    expect(res.status).toBe(200);
    expect(res.body.operations).toHaveLength(2);
    expect(res.body.operations[0].id).toBe("op-newer");
  });
});
