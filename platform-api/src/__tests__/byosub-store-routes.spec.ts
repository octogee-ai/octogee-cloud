import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";

const h = vi.hoisted(() => ({
  store: null as unknown as PlatformStateStore,
  writeSecret: vi.fn(),
  deleteSecret: vi.fn(),
  addSecretVersionIfExists: vi.fn(),
  triggerSync: vi.fn(),
  errors: [] as unknown[],
}));

vi.mock("@octogee/core/http/auth", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { uid: "uid-ada", user: { username: "ada" } });
    next();
  },
  requireInternalServiceAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("@octogee/core/identity/platform-state-store", () => ({
  get platformStateStore() { return h.store; },
}));
vi.mock("@octogee/core/secret-store", () => ({
  writeSecret: h.writeSecret,
  deleteSecret: h.deleteSecret,
  addSecretVersionIfExists: h.addSecretVersionIfExists,
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
const { codexRuntimeConfig } = await import("@octogee/core/model-credential-materializer");
const { SubscriptionModelPinError } = await import("../lib/subscription-model-pins.js");

const COACH = "octogee-ada-coach";
const PROJECT_AGENT = "octogee-ada-site";
const CODEX = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r" } });

function app(boundGatewayId = "gw-ada") {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    Object.assign(req, { boundTenant: { kind: "gateway", gatewayId: boundGatewayId } });
    next();
  });
  a.use(routes);
  a.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    h.errors.push(err);
    res.status(500).json({ error: "capture failed" });
  });
  return a;
}

function ada(accountLifecycle?: Record<string, unknown>, agentIds: readonly string[] = [COACH]) {
  return {
    username: "ada",
    ...(accountLifecycle ? { accountLifecycle } : {}),
    provisioning: { openclaw: { slug: "ada", gatewayId: "gw-ada", status: "complete", agentIds } },
  };
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

async function startFlow(flowId = "flow-1") {
  await h.store.users.subscriptionFlows.create({
    flowId,
    uid: "uid-ada",
    gatewayId: "gw-ada",
    agentId: COACH,
    provider: "openai",
    modelCredentialProvider: "openai-codex",
    createdAt: 1,
    expireAt: Date.now() + 600_000,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  h.errors.length = 0;
  h.writeSecret.mockResolvedValue(undefined);
  h.deleteSecret.mockResolvedValue(undefined);
  h.store = createDocumentFixtureStore({ "users/uid-ada": ada() });
});

describe("subscription capture on the platform store", () => {
  it("stores the credential, connects the provider, consumes the flow and pins the coach", async () => {
    await startFlow();

    const res = await request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(200);

    expect(res.body).toEqual({ ok: true, secretName: "byosub-uid-ada-openai" });
    expect(h.writeSecret).toHaveBeenCalledWith(expect.objectContaining({ name: "byosub-uid-ada-openai", value: CODEX }));
    expect(await h.store.users.modelCredentials.get("uid-ada")).toMatchObject({
      active: true, provider: "openai-codex", mode: "oauth", status: "active", secretName: "byosub-uid-ada-openai",
    });
    expect(await h.store.users.subscriptionLinks.list("uid-ada")).toMatchObject([
      { provider: "openai", modelCredentialProvider: "openai-codex", status: "connected", gatewayId: "gw-ada", flowId: "flow-1" },
    ]);
    expect(await h.store.users.subscriptionFlows.get("flow-1")).toMatchObject({
      consumedAt: expect.any(Number), captureClaimId: null, captureClaimedAt: null, modelPinnedAt: expect.any(Number),
    });
    expect(await h.store.users.agentModels.list("uid-ada")).toMatchObject([
      { agentId: COACH, primary: codexRuntimeConfig().model },
    ]);
    expect(h.triggerSync).toHaveBeenCalledOnce();
  });

  it("replays a consumed flow without rewriting the secret or the user's later pick", async () => {
    await startFlow();
    await request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(200);
    await h.store.users.agentModels.put({ uid: "uid-ada", agentId: COACH, primary: "anthropic/claude-opus-5", fallbacks: [], updatedAt: 2 });
    h.writeSecret.mockClear();

    const res = await request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(200);

    expect(res.body).toMatchObject({ ok: true, alreadyConsumed: true });
    expect(h.writeSecret).not.toHaveBeenCalled();
    expect(await h.store.users.agentModels.list("uid-ada")).toMatchObject([{ agentId: COACH, primary: "anthropic/claude-opus-5" }]);
  });

  it("replays a consumed flow without restoring a pick the user reset", async () => {
    await startFlow();
    await request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(200);
    await h.store.users.agentModels.delete("uid-ada", COACH);

    await request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(200);

    expect(await h.store.users.agentModels.list("uid-ada")).toEqual([]);
  });

  it("fails a capture whose pin failed after the credential committed and leaves the flow unpinned", async () => {
    await startFlow();
    failCoachPinOnce();

    await request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(500);

    expect(h.errors).toEqual([expect.any(SubscriptionModelPinError)]);
    expect(await h.store.users.modelCredentials.get("uid-ada")).toMatchObject({ active: true, provider: "openai-codex" });
    expect(await h.store.users.subscriptionFlows.get("flow-1")).toMatchObject({ consumedAt: expect.any(Number), modelPinnedAt: null });
  });

  it("fills only agents without a pick when a capture whose pin failed is retried", async () => {
    h.store = createDocumentFixtureStore({ "users/uid-ada": ada(undefined, [COACH, PROJECT_AGENT]) });
    await startFlow();
    failCoachPinOnce();
    await request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(500);
    await h.store.users.agentModels.put({ uid: "uid-ada", agentId: PROJECT_AGENT, primary: "anthropic/claude-opus-5", fallbacks: [], updatedAt: 2 });

    const res = await request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(200);

    expect(res.body).toMatchObject({ ok: true, alreadyConsumed: true });
    expect(await h.store.users.agentModels.list("uid-ada")).toMatchObject([
      { agentId: COACH, primary: codexRuntimeConfig().model },
      { agentId: PROJECT_AGENT, primary: "anthropic/claude-opus-5" },
    ]);
    expect(await h.store.users.subscriptionFlows.get("flow-1")).toMatchObject({ modelPinnedAt: expect.any(Number) });
  });

  it("refuses a flow another capture already claimed, before writing the secret", async () => {
    await startFlow();
    await h.store.users.subscriptionFlows.update("flow-1", { captureClaimId: "other", captureClaimedAt: 1 });

    await request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(500);

    expect(h.writeSecret).not.toHaveBeenCalled();
    expect(await h.store.users.modelCredentials.get("uid-ada")).toBeNull();
  });

  it("refuses a capture for an owner whose account no longer allows access", async () => {
    h.store = createDocumentFixtureStore({ "users/uid-ada": ada({ status: "deletion_scheduled" }) });
    await startFlow();

    await request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(500);

    expect(h.writeSecret).not.toHaveBeenCalled();
    expect(await h.store.users.subscriptionFlows.get("flow-1")).toMatchObject({ captureClaimId: null, consumedAt: null });
  });

  it("refuses a flow bound to another gateway", async () => {
    await startFlow();

    await request(app("gw-other")).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(403);

    expect(h.writeSecret).not.toHaveBeenCalled();
  });
});

describe("subscription link status on the platform store", () => {
  beforeEach(async () => {
    await startFlow();
    await request(app()).post("/capture").send({ flowId: "flow-1", credential: CODEX }).expect(200);
  });

  it("marks a connected provider as needing reauth and shows it on the connection", async () => {
    await request(app()).post("/auth-state").send({ gatewayId: "gw-ada", agentId: COACH, provider: "openai", state: "needs_reauth" }).expect(200);

    expect(await h.store.users.subscriptionLinks.list("uid-ada")).toMatchObject([{ provider: "openai", status: "needs_reauth" }]);
    const connection = await request(app()).get("/connection").expect(200);
    expect(connection.body).toMatchObject({
      connected: false,
      gatewayId: "gw-ada",
      providers: { openai: { status: "needs_reauth", connected: false } },
    });
  });

  it("rotates the stored codex credential through the connected provider's secret", async () => {
    h.addSecretVersionIfExists.mockResolvedValue({ ok: true });

    const res = await request(app()).post("/sync-back").send({ gatewayId: "gw-ada", agentId: COACH, provider: "openai", credential: CODEX }).expect(200);

    expect(res.body).toEqual({ ok: true, secretName: "byosub-uid-ada-openai" });
    expect(h.addSecretVersionIfExists).toHaveBeenCalledWith("byosub-uid-ada-openai", CODEX);
  });

  it("disconnecting the last provider drops the credential and its pinned picks", async () => {
    await request(app()).post("/disconnect").send({ provider: "openai" }).expect(200);

    expect(await h.store.users.modelCredentials.get("uid-ada")).toBeNull();
    expect(await h.store.users.subscriptionLinks.list("uid-ada")).toMatchObject([{ provider: "openai", status: "disconnected" }]);
    expect(await h.store.users.agentModels.list("uid-ada")).toEqual([]);
    expect((await request(app()).get("/connection").expect(200)).body).toMatchObject({ connected: false, providers: {} });
  });
});
