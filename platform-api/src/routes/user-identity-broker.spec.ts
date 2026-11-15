import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { UserCredentialRejected, type UserIdentityProvider } from "@octogee/core/user-identity-provider";

const logged = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("../../../gateway-edge/src/middleware/logging.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../gateway-edge/src/middleware/logging.js")>(),
  logger: logged,
}));

import { USER_IDENTITY_BROKER_PATH } from "../../../gateway-edge/src/lib/brokered-user-identity-provider.js";
import {
  installUserIdentityProvider,
  loadUserWithInstalledProvider,
} from "../../../gateway-edge/src/middleware/auth.js";
import { SIDECAR_BROKER_ROUTES } from "../app.js";
import { createTenantEnforcementMiddleware, NO_PRODUCT_TENANT_ROUTES } from "../middleware/tenant-enforcement.js";
import { USER_IDENTITY_GATEWAY_REQUEST_LIMIT, userIdentityBrokerHandlers } from "./user-identity-broker.js";

const ADA = { username: "ada", accountLifecycle: { status: "active" } };

function identity(users: Record<string, Record<string, unknown>> = { "uid-ada": ADA }) {
  return {
    verifyBearer: vi.fn<UserIdentityProvider["verifyBearer"]>(async (token) => {
      if (token !== "ada-session") throw new UserCredentialRejected("unknown session");
      return { uid: "uid-ada", authTime: 1_700_000_000 };
    }),
    loadUser: vi.fn<UserIdentityProvider["loadUser"]>(async (uid) => users[uid] ?? null),
  };
}

function api(opts: { bound?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const gatewayId = req.get("x-bound-gateway") ?? "walter";
    if (opts.bound !== false) req.boundTenant = { kind: "gateway", gatewayId, saName: `octogee-gw-${gatewayId}`, podUid: "pod-1", podName: "pod-1" };
    next();
  });
  app.use(createTenantEnforcementMiddleware({
    onDenied: async () => {},
    onAccess: () => {},
    readFlowGateway: async () => null,
    store: createDocumentFixtureStore(new Map()),
    productRoutes: NO_PRODUCT_TENANT_ROUTES,
  }));
  app.use("/internal/user-identity", ...userIdentityBrokerHandlers({ loadUser: loadUserWithInstalledProvider }));
  return app;
}

function verify(app: Parameters<typeof request>[0], opts: { bearer?: string; gatewayId?: string; boundTo?: string } = {}) {
  const boundTo = opts.boundTo ?? "walter";
  return request(app)
    .post(USER_IDENTITY_BROKER_PATH)
    .set("authorization", `Bearer ${opts.bearer ?? "ada-session"}`)
    .set("x-bound-gateway", boundTo)
    .send({ gatewayId: opts.gatewayId ?? boundTo });
}

beforeEach(() => {
  logged.error.mockClear();
  logged.warn.mockClear();
  installUserIdentityProvider(identity());
});

describe("the user identity broker for gateway sidecars", () => {
  it("is a sidecar-only broker route", () => {
    expect(SIDECAR_BROKER_ROUTES.has(USER_IDENTITY_BROKER_PATH)).toBe(true);
  });

  it("answers the verified uid, sign-in time and user from the installed identity", async () => {
    const response = await verify(api());

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ uid: "uid-ada", authTime: 1_700_000_000, user: ADA });
  });

  it("answers a null user for a verified bearer whose user does not exist yet", async () => {
    installUserIdentityProvider(identity({}));

    const response = await verify(api());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ uid: "uid-ada", authTime: 1_700_000_000, user: null });
  });

  it("answers 401 for a bearer the installed identity rejects", async () => {
    const response = await verify(api(), { bearer: "stolen" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Invalid token" });
  });

  it("keeps verifying a gateway's users after many rejected bearers arrive through it", async () => {
    const app = api();

    for (let attempt = 0; attempt < 1_201; attempt++) {
      expect((await verify(app, { bearer: "garbage" })).status).toBe(401);
    }
    expect((await verify(app)).status).toBe(200);
  }, 60_000);

  it("refuses a gateway's verify calls past its cap before authenticating them, and logs the gateway once", async () => {
    const server = api().listen();
    try {
      for (let sent = 0; sent < USER_IDENTITY_GATEWAY_REQUEST_LIMIT; sent += 50) {
        const batch = Math.min(50, USER_IDENTITY_GATEWAY_REQUEST_LIMIT - sent);
        const statuses = await Promise.all(Array.from({ length: batch }, () => verify(server, { bearer: "garbage" }).then(response => response.status)));
        expect(new Set(statuses)).toEqual(new Set([401]));
      }

      expect((await verify(server)).status).toBe(429);
      expect((await verify(server)).status).toBe(429);
      const refusals = logged.warn.mock.calls.filter(([message]) => message === "[broker-request-limit] refused a tenant over its limit");
      expect(refusals).toEqual([["[broker-request-limit] refused a tenant over its limit", expect.objectContaining({ gatewayId: "walter", scope: "gateway", limit: USER_IDENTITY_GATEWAY_REQUEST_LIMIT })]]);

      expect((await verify(server, { boundTo: "harriet" })).status).toBe(200);
    } finally {
      server.close();
    }
  }, 60_000);

  it("refuses a request that names another gateway", async () => {
    const response = await verify(api(), { gatewayId: "other" });

    expect(response.status).toBe(403);
  });

  it("refuses a caller that is not bound to a gateway", async () => {
    const response = await verify(api({ bound: false }));

    expect(response.status).toBe(403);
  });

  it("answers 503 and logs when the user cannot be loaded", async () => {
    const failing = identity();
    failing.loadUser.mockRejectedValueOnce(new Error("platform state unavailable"));
    installUserIdentityProvider(failing);

    const response = await verify(api());

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "Authentication lookup unavailable" });
    expect(logged.error).toHaveBeenCalledWith("[user-identity-broker] user lookup failed", expect.objectContaining({ gatewayId: "walter" }));
  });
});
