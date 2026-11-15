import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

vi.hoisted(() => {
  process.env.API_PUBLIC_URL = "https://api.octogee.test";
});
vi.mock("../../../gateway-edge/src/middleware/auth.js", () => ({
  requireActiveAccount: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAuthenticatedUid: (req: Request, _res: Response, next: NextFunction) => {
    req.uid = req.get("x-test-uid");
    next();
  },
}));

import {
  createMattermostMintRoutes,
  createMmRestProxyHandler,
  isCreatePostRequest,
  setMmCredsCache,
  mmCredsCache,
  MM_CREDS_CACHE_MAX,
} from "../routes/mattermost-proxy.js";

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("mmRestProxyHandler — fail-closed on misconfiguration", () => {
  it("returns 502 when MM_INTERNAL_URL is unset (no env in the test runner)", () => {

const res = mockRes();
    createMmRestProxyHandler(createDocumentFixtureStore({}))({ method: "GET", url: "/api/v4/users/me", headers: {} } as Request, res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: expect.stringContaining("misconfigured") });
  });
});

describe("isCreatePostRequest — which proxied calls feed the user-DM notifier", () => {
  it("matches only POST /api/v4/posts, with or without a query string", () => {
    expect(isCreatePostRequest("POST", "/api/v4/posts")).toBe(true);
    expect(isCreatePostRequest("POST", "/api/v4/posts?set_online=true")).toBe(true);
    expect(isCreatePostRequest("GET", "/api/v4/posts")).toBe(false);
    expect(isCreatePostRequest("POST", "/api/v4/posts/abc/reactions")).toBe(false);
    expect(isCreatePostRequest("POST", "/api/v4/channels/direct")).toBe(false);
    expect(isCreatePostRequest(undefined, undefined)).toBe(false);
  });
});

describe("mmCredsCache — bounded on the cluster singleton", () => {
  beforeEach(() => mmCredsCache.clear());

  it("never grows past MM_CREDS_CACHE_MAX, evicting oldest-inserted first", () => {
    const future = Date.now() + 60_000;
    for (let i = 0; i < MM_CREDS_CACHE_MAX + 250; i++) {
      setMmCredsCache(`uid-${i}`, { mmToken: "t", mmUserId: "u", expiresAt: future });
    }
    expect(mmCredsCache.size).toBeLessThanOrEqual(MM_CREDS_CACHE_MAX);
    
    expect(mmCredsCache.has(`uid-${MM_CREDS_CACHE_MAX + 249}`)).toBe(true);
    expect(mmCredsCache.has("uid-0")).toBe(false);
  });

  it("drops expired entries before evicting live ones on overflow", () => {
    const past = Date.now() - 1;
    const future = Date.now() + 60_000;
    
    for (let i = 0; i < MM_CREDS_CACHE_MAX; i++) {
      setMmCredsCache(`stale-${i}`, { mmToken: "t", mmUserId: "u", expiresAt: past });
    }
    
    setMmCredsCache("fresh", { mmToken: "t", mmUserId: "u", expiresAt: future });
    expect(mmCredsCache.has("fresh")).toBe(true);
    expect(mmCredsCache.size).toBeLessThanOrEqual(MM_CREDS_CACHE_MAX);
  });
});

describe("Mattermost credential mint", () => {
  const MM_USER_ID = "u".repeat(26);

  beforeEach(() => mmCredsCache.clear());

  function mint(documents: Record<string, Record<string, unknown>>, uid: string) {
    const app = express();
    app.use("/mint", createMattermostMintRoutes(createDocumentFixtureStore(documents)));
    return request(app).post("/mint").set("x-test-uid", uid);
  }

  it("returns the user's own Mattermost user and personal token", async () => {
    const res = await mint({
      "users/uid-mira": { mattermost: { userId: MM_USER_ID } },
      "users/uid-mira/secrets/mattermost": { personalToken: "mira-pat" },
    }, "uid-mira");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mmUrl: "https://api.octogee.test", mmToken: "mira-pat", mmUserId: MM_USER_ID });
  });

  it("reports chat as not provisioned without a stored personal token", async () => {
    const res = await mint({ "users/uid-mira": { mattermost: { userId: MM_USER_ID } } }, "uid-mira");

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Chat not provisioned" });
  });

  it("reports the credential lookup as unavailable when the stored token is malformed", async () => {
    const res = await mint({
      "users/uid-mira": { mattermost: { userId: MM_USER_ID } },
      "users/uid-mira/secrets/mattermost": { personalToken: 42 },
    }, "uid-mira");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Credential lookup unavailable" });
  });
});
