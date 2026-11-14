import express from "express";
import request from "supertest";
import { FieldValue } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";

type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  store: null as unknown as PlatformStateStore,
  docs: new Map<string, Record<string, unknown>>(),
  errors: [] as unknown[],
  writeSecret: vi.fn(),
  deleteSecret: vi.fn(),
  triggerSync: vi.fn(),
}));

function isPlainObject(value: unknown): value is Doc {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function mergeInto(target: Doc, patch: Doc): Doc {
  for (const [key, value] of Object.entries(patch)) {
    if (value instanceof FieldValue) {
      if (value.isEqual(FieldValue.delete())) delete target[key];
      else target[key] = Date.now();
    } else if (isPlainObject(value)) {
      target[key] = mergeInto(isPlainObject(target[key]) ? { ...target[key] } : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function write(path: string, data: Doc, options?: { merge?: boolean }): void {
  const base = options?.merge ? { ...(h.docs.get(path) ?? {}) } : {};
  h.docs.set(path, mergeInto(base, data));
}

interface FakeDocRef {
  path: string;
  get(): Promise<{ exists: boolean; data(): Doc | undefined }>;
  set(data: Doc, options?: { merge?: boolean }): Promise<void>;
  collection(name: string): { doc(id: string): FakeDocRef };
}

function docRef(path: string): FakeDocRef {
  return {
    path,
    get: async () => {
      const data = h.docs.get(path);
      return { exists: data !== undefined, data: () => (data ? structuredClone(data) : undefined) };
    },
    set: async (data, options) => write(path, data, options),
    collection: (name) => collectionRef(`${path}/${name}`),
  };
}

function collectionRef(path: string) {
  return { doc: (id: string) => docRef(`${path}/${id}`) };
}

vi.mock("../lib/db.js", () => ({
  db: {
    collection: collectionRef,
    doc: docRef,
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({
      get: (ref: FakeDocRef) => ref.get(),
      set: (ref: FakeDocRef, data: Doc, options?: { merge?: boolean }) => write(ref.path, data, options),
    }),
  },
}));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireInternalServiceAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../lib/platform-state.js", () => ({
  get platformStateStore() { return h.store; },
}));
vi.mock("@octogee/core/secret-store", () => ({
  writeSecret: h.writeSecret,
  deleteSecret: h.deleteSecret,
  addSecretVersionIfExists: vi.fn(),
}));
vi.mock("@octogee/core/gateway-live-release", () => ({
  readGatewayAuthorizationInStore: async () => ({
    kind: "durable",
    config: { gatewayClass: "isolated" },
    gateway: { desiredStatus: "running" },
  }),
}));
vi.mock("../lib/byot-sync-trigger.js", () => ({ triggerGatewayModelCredentialSync: h.triggerSync }));

const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
const { default: routes } = await import("../routes/byosub.js");
const { SubscriptionModelPinError } = await import("../lib/subscription-model-pins.js");
const { codexRuntimeConfig } = await import("@octogee/core/model-credential-materializer");

const UID = "uid-ada";
const COACH = "octogee-ada-coach";
const PROJECT_AGENT = "octogee-ada-site";
const USER_PICK = "anthropic/claude-opus-5";
const CODEX = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r" } });

const ada = {
  username: "ada",
  provisioning: { openclaw: { slug: "ada", gatewayId: "gw-ada", status: "complete", agentIds: [COACH, PROJECT_AGENT] } },
};

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    Object.assign(req, { boundTenant: { kind: "gateway", gatewayId: "gw-ada" } });
    next();
  });
  a.use(routes);
  a.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    h.errors.push(err);
    res.status(500).json({ error: "capture failed" });
  });
  return a;
}

function capture() {
  return request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX });
}

function flow(): Doc | undefined {
  return h.docs.get("byosubFlows/flow-1");
}

async function picks(): Promise<Record<string, string>> {
  return Object.fromEntries((await h.store.users.agentModels.list(UID)).map(({ agentId, primary }) => [agentId, primary]));
}

function failCoachPinOnce() {
  const put = h.store.users.agentModels.put.bind(h.store.users.agentModels);
  let failed = false;
  vi.spyOn(h.store.users.agentModels, "put").mockImplementation(async (selection) => {
    if (selection.agentId === COACH && !failed) {
      failed = true;
      throw new Error("store unavailable");
    }
    return put(selection);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  h.errors.length = 0;
  h.writeSecret.mockResolvedValue(undefined);
  h.deleteSecret.mockResolvedValue(undefined);
  h.store = createDocumentFixtureStore({ [`users/${UID}`]: ada });
  h.docs = new Map([
    [`users/${UID}`, structuredClone(ada)],
    ["byosubFlows/flow-1", { uid: UID, gatewayId: "gw-ada", agentId: COACH, provider: "openai", expireAt: Date.now() + 600_000 }],
  ]);
});

describe("subscription capture model pin", () => {
  it("fails a capture whose pin failed after the credential committed and leaves the flow unpinned", async () => {
    failCoachPinOnce();

    await capture().expect(500);

    expect(h.errors).toEqual([expect.any(SubscriptionModelPinError)]);
    expect(h.docs.get(`users/${UID}/integrations/byosub`)).toMatchObject({ connected: true });
    expect(flow()).toMatchObject({ consumedAt: expect.any(Number) });
    expect(flow()?.modelPinnedAt).toBeUndefined();
  });

  it("fills only agents without a pick when a capture whose pin failed is retried", async () => {
    failCoachPinOnce();
    await capture().expect(500);
    await h.store.users.agentModels.put({ uid: UID, agentId: PROJECT_AGENT, primary: USER_PICK, fallbacks: [], updatedAt: 2 });

    const res = await capture().expect(200);

    expect(res.body).toMatchObject({ ok: true, alreadyConsumed: true });
    expect(await picks()).toEqual({ [COACH]: codexRuntimeConfig().model, [PROJECT_AGENT]: USER_PICK });
    expect(flow()).toMatchObject({ modelPinnedAt: expect.any(Number) });
  });

  it("skips pinning when a capture whose pin landed is replayed, so a pick the user reset stays unset", async () => {
    await capture().expect(200);
    expect(flow()).toMatchObject({ modelPinnedAt: expect.any(Number) });
    await h.store.users.agentModels.delete(UID, COACH);
    const put = vi.spyOn(h.store.users.agentModels, "put");

    await capture().expect(200);

    expect(put).not.toHaveBeenCalled();
    expect(await picks()).toEqual({ [PROJECT_AGENT]: codexRuntimeConfig().model });
  });
});
