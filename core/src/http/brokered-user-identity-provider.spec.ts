import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isUserCredentialRejected } from "../user-identity-provider.js";

vi.mock("./logging", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../identity/platform-state-store.js", async () => {
  const { createDocumentFixtureStore } = await import("../testing/journal-store.js");
  return { platformStateStore: createDocumentFixtureStore(new Map([["workspaces/ada", { id: "ada", ownerUid: "uid-ada" }]])) };
});

const { installUserIdentityProvider, loadUserWithInstalledProvider, requireAuth } = await import("./auth.js");
const { authenticationFailureLimit } = await import("./authenticated-request-limit.js");
const {
  brokeredUserIdentityProvider,
  installBrokeredUserIdentity,
  userIdentityBrokerUrlFromEnv,
  USER_IDENTITY_BROKER_PATH,
  USER_IDENTITY_BROKER_TIMEOUT_MS,
} = await import("../identity/brokered-user-identity-provider.js");

const BROKER = "http://octogee-api.octogee.svc.cluster.local:3001";
const ADA = { username: "ada", workspaceId: "ada", accountLifecycle: { status: "active" } };

type BrokerFetch = (url: string | URL, init?: RequestInit, opts?: { timeoutMs?: number }) => Promise<Response>;

function broker(answer: (token: string) => Response) {
  return vi.fn<BrokerFetch>(async (_url, init) => {
    const token = new Headers(init?.headers).get("authorization")?.slice("Bearer ".length) ?? "";
    return answer(token);
  });
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function provider(fetch: ReturnType<typeof broker>, now = () => 0) {
  return brokeredUserIdentityProvider({
    brokerUrl: BROKER,
    gatewayId: "walter",
    fetch: fetch as never,
    credentialHeaders: async () => ({ "x-octogee-sidecar-broker-token": "sidecar-token" }),
    now,
  });
}

function sidecar(identity: ReturnType<typeof provider>) {
  installUserIdentityProvider(identity);
  const app = express();
  app.get("/me", authenticationFailureLimit, requireAuth, (req, res) => {
    res.json({ uid: req.uid, user: req.user, workspaceSlug: req.workspaceSlug });
  });
  return app;
}

describe("verifying users on a gateway sidecar through the platform API", () => {
  let fetch: ReturnType<typeof broker>;

  beforeEach(() => {
    fetch = broker((token) => token === "ada-session"
      ? ok({ uid: "uid-ada", authTime: 1_700_000_000, user: ADA })
      : new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 }));
  });

  it("asks the broker with the bearer, the sidecar credential and its gateway, within the timeout", async () => {
    const verified = await provider(fetch).verifyBearer("ada-session");

    expect(verified).toEqual({ uid: "uid-ada", authTime: 1_700_000_000 });
    const [url, init, opts] = fetch.mock.calls[0];
    expect(url).toBe(`${BROKER}${USER_IDENTITY_BROKER_PATH}`);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer ada-session");
    expect(headers.get("x-octogee-sidecar-broker-token")).toBe("sidecar-token");
    expect(JSON.parse(String(init?.body))).toEqual({ gatewayId: "walter" });
    expect(opts).toEqual({ timeoutMs: USER_IDENTITY_BROKER_TIMEOUT_MS });
  });

  it("signs the user in with the user the broker loaded", async () => {
    const response = await request(sidecar(provider(fetch))).get("/me").set("authorization", "Bearer ada-session");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ uid: "uid-ada", user: ADA, workspaceSlug: "ada" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("answers 401 when the platform API rejects the bearer", async () => {
    const response = await request(sidecar(provider(fetch))).get("/me").set("authorization", "Bearer stolen");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Invalid token" });
  });

  it("applies the account lifecycle the broker reports", async () => {
    fetch = broker(() => ok({ uid: "uid-ada", authTime: null, user: { ...ADA, accountLifecycle: { status: "suspended" } } }));

    const response = await request(sidecar(provider(fetch))).get("/me").set("authorization", "Bearer ada-session");

    expect(response.status).toBe(403);
  });

  it("refuses a bearer whose user the broker could not find", async () => {
    fetch = broker(() => ok({ uid: "uid-new", authTime: null, user: null }));

    const response = await request(sidecar(provider(fetch))).get("/me").set("authorization", "Bearer new-session");

    expect(response.status).toBe(403);
  });

  it.each([
    ["an outage", () => new Response("{}", { status: 503 })],
    ["a rate limit", () => new Response("{}", { status: 429 })],
    ["a malformed answer", () => ok({ uid: "", authTime: "yesterday", user: [] })],
    ["a non-JSON answer", () => new Response("<html>", { status: 200 })],
  ])("answers 503 for %s from the broker", async (_case, answer) => {
    const response = await request(sidecar(provider(broker(answer)))).get("/me").set("authorization", "Bearer ada-session");

    expect(response.status).toBe(503);
  });

  it("remembers a verified answer for 60 seconds", async () => {
    let clock = 0;
    const identity = provider(fetch, () => clock);

    await identity.verifyBearer("ada-session");
    clock = 59_999;
    await identity.verifyBearer("ada-session");
    expect(fetch).toHaveBeenCalledTimes(1);

    clock = 60_000;
    await identity.verifyBearer("ada-session");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never remembers a rejection", async () => {
    const identity = provider(fetch);

    for (let attempt = 0; attempt < 2; attempt++) {
      const rejection = await identity.verifyBearer("stolen").catch((error: unknown) => error);
      expect(isUserCredentialRejected(rejection)).toBe(true);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses to load a user it has not verified", async () => {
    await expect(provider(fetch).loadUser("uid-ada")).rejects.toThrow("has not verified this user");
  });

  it("refuses an invalid gateway id", () => {
    expect(() => brokeredUserIdentityProvider({ brokerUrl: BROKER, gatewayId: "" })).toThrow("gateway id is not valid");
  });
});

describe("installing the sidecar's user identity from its deployment", () => {
  it("installs a provider that only knows users the broker verified", async () => {
    installBrokeredUserIdentity({ GATEWAY_ID: "walter", OPENCLAW_RUNTIME_BROKER_URL: BROKER, K8S_NAMESPACE: "octogee" });

    await expect(loadUserWithInstalledProvider("uid-ada")).rejects.toThrow("the user identity broker has not verified this user");
  });

  it("refuses to install without the gateway id", () => {
    expect(() => installBrokeredUserIdentity({ OPENCLAW_RUNTIME_BROKER_URL: BROKER, K8S_NAMESPACE: "octogee" })).toThrow("gateway id is not valid");
  });
});

describe("the sidecar's broker URL", () => {
  it("is the in-cluster platform API from the deployment", () => {
    expect(userIdentityBrokerUrlFromEnv({ OPENCLAW_RUNTIME_BROKER_URL: `${BROKER}/`, K8S_NAMESPACE: "octogee" })).toBe(BROKER);
  });

  it("is required", () => {
    expect(() => userIdentityBrokerUrlFromEnv({})).toThrow("OPENCLAW_RUNTIME_BROKER_URL is required");
  });

  it("must name the platform API", () => {
    expect(() => userIdentityBrokerUrlFromEnv({ OPENCLAW_RUNTIME_BROKER_URL: "http://attacker.example" })).toThrow();
  });
});
