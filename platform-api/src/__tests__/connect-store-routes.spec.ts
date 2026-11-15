import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";

const h = vi.hoisted(() => ({
  store: null as unknown as PlatformStateStore,
}));

vi.mock("@octogee/core/http/auth", () => ({
  requireAuthenticatedUid: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    Object.assign(req, { uid: req.header("x-test-uid") ?? "uid-ada" });
    next();
  },
  requireActiveAccount: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("@octogee/core/identity/platform-state-store", () => ({
  get platformStateStore() { return h.store; },
}));
vi.mock("@octogee/core/connectors/kms", () => ({
  encryptSecret: async (plaintext: string) => `enc:${plaintext}`,
  decryptSecret: async (ciphertext: string) => ciphertext.replace(/^enc:/, ""),
}));

process.env.CONNECT_STATE_SECRET = "connect-state-secret";
process.env.GITHUB_CLIENT_ID = "gh-client";
process.env.GITHUB_CLIENT_SECRET = "gh-secret";
process.env.APP_URL = "https://app.example.test";

const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
const { default: routes } = await import("../routes/connect.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use(routes);
  return a;
}

interface ProviderReply {
  readonly url: RegExp;
  readonly body: unknown;
  readonly status?: number;
}

function stubProviders(replies: readonly ProviderReply[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = String(input);
    const reply = replies.find((candidate) => candidate.url.test(url));
    if (!reply) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch);
}

const GITHUB_IDENTITY: ProviderReply = { url: /^https:\/\/api\.github\.com\/user$/, body: { login: "ada-gh" } };

beforeEach(() => {
  h.store = createDocumentFixtureStore({
    "users/uid-ada": { username: "ada", accountLifecycle: { status: "active" } },
    "users/uid-bob": { username: "bob", accountLifecycle: { status: "active" } },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function oauthNonce(authUrl: string): string {
  const state = new URL(authUrl).searchParams.get("state")!;
  return JSON.parse(Buffer.from(state.split(".")[0], "base64url").toString()).nonce;
}

async function githubCallback(stateUrl: string, code = "code-1") {
  const state = new URL(stateUrl).searchParams.get("state")!;
  return request(app()).get(`/github/callback?code=${code}&state=${encodeURIComponent(state)}`);
}

describe("connector status read", () => {
  it("returns no integrations for a user who has never connected", async () => {
    const res = await request(app()).get("/status").expect(200);

    expect(res.body).toEqual({ integrations: {} });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns each connector's status without any token material", async () => {
    stubProviders([GITHUB_IDENTITY]);
    await request(app()).post("/github/pat").send({ token: "ghp_secret" }).expect(200);

    const res = await request(app()).get("/status").expect(200);

    expect(res.body.integrations).toEqual({
      github: {
        provider: "github",
        status: "connected",
        accountLabel: "ada-gh",
        scopes: [],
        captureMethod: "pat",
        pickedFiles: [],
        connectedAt: expect.any(Number),
        updatedAt: expect.any(Number),
        verifiedAt: null,
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("ghp_secret");
  });

  it("only shows the signed-in user's own integrations", async () => {
    stubProviders([GITHUB_IDENTITY]);
    await request(app()).post("/github/pat").set("x-test-uid", "uid-bob").send({ token: "ghp_bob" }).expect(200);

    const res = await request(app()).get("/status").expect(200);

    expect(res.body).toEqual({ integrations: {} });
  });
});

describe("connector capture on the platform store", () => {
  it("stores a personal access token as a connector secret and a connected integration", async () => {
    stubProviders([GITHUB_IDENTITY]);

    await request(app()).post("/github/pat").send({ token: " ghp_secret " }).expect(200);

    expect(await h.store.secrets.get("uid-ada", "github")).toMatchObject({
      kind: "connector",
      encryptedAccessToken: "enc:ghp_secret",
      encryptedRefreshToken: null,
      detail: { provider: "github", tokens: { expiresAt: null, tokenType: "bearer" } },
    });
    expect(await h.store.users.connectorIntegrations.get("uid-ada", "github")).toMatchObject({
      status: "connected", accountLabel: "ada-gh", captureMethod: "pat", scopes: [], error: null,
    });
  });

  it("runs an OAuth flow through a stored flow that a second callback cannot reuse", async () => {
    stubProviders([
      { url: /^https:\/\/github\.com\/login\/oauth\/access_token/, body: { access_token: "gho_token", refresh_token: "ghr_refresh", scope: "repo,read:user" } },
      GITHUB_IDENTITY,
    ]);
    const start = await request(app()).get("/github/auth-url").expect(200);
    const nonce = oauthNonce(start.body.url);
    expect(await h.store.users.connectFlows.get(nonce)).toMatchObject({
      uid: "uid-ada", connectorId: "github", kind: "oauth-web", consumedAt: null,
    });

    const callback = await githubCallback(start.body.url);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("github_connected=true");
    expect(await h.store.users.connectFlows.get(nonce)).toMatchObject({ consumedAt: expect.any(Number), outcome: "connected" });
    expect(await h.store.secrets.get("uid-ada", "github")).toMatchObject({
      encryptedAccessToken: "enc:gho_token", encryptedRefreshToken: "enc:ghr_refresh",
    });
    expect(await h.store.users.connectorIntegrations.get("uid-ada", "github")).toMatchObject({
      status: "connected", captureMethod: "oauth-web", scopes: ["repo", "read:user"],
    });

    const replay = await githubCallback(start.body.url);
    expect(replay.headers.location).toContain("connect_error=invalid_state");
  });

  it("records a failed exchange as an error integration the user can reconnect from", async () => {
    stubProviders([{ url: /^https:\/\/github\.com\/login\/oauth\/access_token/, body: {}, status: 500 }]);
    const start = await request(app()).get("/github/auth-url").expect(200);

    const callback = await githubCallback(start.body.url);

    expect(callback.headers.location).toContain("connect_error=github_failed");
    expect(await h.store.users.connectorIntegrations.get("uid-ada", "github")).toMatchObject({
      status: "error", error: "token exchange failed: 500", accountLabel: null,
    });
    expect(await h.store.secrets.get("uid-ada", "github")).toBeNull();
    expect(await h.store.users.connectFlows.get(oauthNonce(start.body.url))).toMatchObject({ outcome: "failed" });
  });

  it("records a flow the user cancelled at the provider as cancelled", async () => {
    const start = await request(app()).get("/github/auth-url").expect(200);
    const state = new URL(start.body.url).searchParams.get("state")!;

    const callback = await request(app()).get(`/github/callback?state=${encodeURIComponent(state)}&error=access_denied`);

    expect(callback.headers.location).toContain("connect_error=cancelled");
    expect(await h.store.users.connectFlows.get(oauthNonce(start.body.url))).toMatchObject({
      consumedAt: expect.any(Number), outcome: "cancelled",
    });
  });

  it("disconnects by marking the integration disconnected and deleting the secret", async () => {
    stubProviders([GITHUB_IDENTITY]);
    await request(app()).post("/github/pat").send({ token: "ghp_secret" }).expect(200);

    await request(app()).post("/disconnect").send({ connector: "github" }).expect(200);

    expect(await h.store.secrets.get("uid-ada", "github")).toBeNull();
    expect(await h.store.users.connectorIntegrations.get("uid-ada", "github")).toMatchObject({
      status: "disconnected", accountLabel: null, scopes: [], captureMethod: null,
    });
  });

  it("finishes a device flow once and marks it consumed with its outcome", async () => {
    const fetch = stubProviders([
      { url: /^https:\/\/github\.com\/login\/device\/code/, body: { device_code: "dev-code", user_code: "ABCD", verification_uri: "https://github.com/login/device", expires_in: 900 } },
      { url: /^https:\/\/github\.com\/login\/oauth\/access_token/, body: { error: "authorization_pending" } },
    ]);
    const start = await request(app()).post("/github/device/start").expect(200);
    expect(await h.store.users.connectFlows.get(start.body.flowId)).toMatchObject({
      kind: "device", encryptedDeviceCode: "enc:dev-code", consumedAt: null, outcome: null,
    });

    const pending = await request(app()).post("/github/device/poll").send({ flowId: start.body.flowId }).expect(200);
    expect(pending.body).toEqual({ status: "pending" });

    fetch.mockRestore();
    stubProviders([{ url: /^https:\/\/github\.com\/login\/oauth\/access_token/, body: { access_token: "gho_device" } }, GITHUB_IDENTITY]);
    const connected = await request(app()).post("/github/device/poll").send({ flowId: start.body.flowId }).expect(200);

    expect(connected.body).toEqual({ status: "connected", accountLabel: "ada-gh" });
    expect(await h.store.users.connectFlows.get(start.body.flowId)).toMatchObject({ consumedAt: expect.any(Number), outcome: "connected" });
    await request(app()).post("/github/device/poll").send({ flowId: start.body.flowId }).expect(404);
  });

  it("refuses another user's device flow", async () => {
    stubProviders([
      { url: /^https:\/\/github\.com\/login\/device\/code/, body: { device_code: "dev-code", user_code: "ABCD", verification_uri: "https://github.com/login/device", expires_in: 900 } },
    ]);
    const start = await request(app()).post("/github/device/start").expect(200);

    await request(app()).post("/github/device/poll").set("x-test-uid", "uid-bob").send({ flowId: start.body.flowId }).expect(404);
  });

  it("does not store tokens for a user without a platform record", async () => {
    stubProviders([GITHUB_IDENTITY]);

    await request(app()).post("/github/pat").set("x-test-uid", "uid-ghost").send({ token: "ghp_secret" }).expect(500);

    expect(await h.store.secrets.get("uid-ghost", "github")).toBeNull();
  });
});

describe("Google picked files on the platform store", () => {
  async function connectGoogle(scopes: readonly string[]) {
    await h.store.users.connectorIntegrations.put({
      uid: "uid-ada",
      connectorId: "google",
      status: "connected",
      accountLabel: "ada@example.com",
      scopes,
      captureMethod: "oauth-web",
      error: null,
      detail: { capabilityCatalogVersion: 1 },
      connectedAt: 1,
      verifiedAt: null,
      updatedAt: 1,
    });
  }

  it("keeps picked files in the integration detail and reports them in status", async () => {
    await connectGoogle(["https://www.googleapis.com/auth/drive.file"]);

    await request(app())
      .post("/google/picked-files")
      .send({ add: [{ id: "file-1", name: "Plan", mimeType: "application/vnd.google-apps.document" }] })
      .expect(200);

    expect((await h.store.users.connectorIntegrations.get("uid-ada", "google"))!.detail).toMatchObject({
      capabilityCatalogVersion: 1,
      pickedFiles: [{ id: "file-1", name: "Plan" }],
    });
    const status = await request(app()).get("/status").expect(200);
    expect(status.body.integrations.google.pickedFiles).toMatchObject([{ id: "file-1", name: "Plan" }]);
  });

  it("refuses picked files when Google is not connected", async () => {
    const res = await request(app()).post("/google/picked-files").send({ add: [{ id: "file-1", name: "Plan", mimeType: "text/plain" }] });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ ok: false, reason: "not_connected" });
  });
});
