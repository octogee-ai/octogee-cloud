import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";

const h = vi.hoisted(() => ({
  events: [] as string[],
  store: null as unknown as PlatformStateStore,
  revokeProviderGrant: vi.fn(async () => undefined),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuthenticatedUid: (req: Request, _res: Response, next: NextFunction) => {
    req.uid = "owner";
    next();
  },
  requireActiveAccount: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("@octogee/core/connector-revocation", () => ({
  revokeProviderGrant: h.revokeProviderGrant,
}));

vi.mock("../lib/platform-state.js", () => ({
  get platformStateStore() { return h.store; },
}));

const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
const { default: connectRoutes } = await import("./connect.js");
const { NO_CONNECTOR_DISCONNECTED, installConnectorDisconnected } = await import("../lib/connector-disconnect.js");

function app() {
  const target = express();
  target.use(express.json());
  target.use("/api/connect", connectRoutes);
  return target;
}

beforeEach(async () => {
  h.events.length = 0;
  h.revokeProviderGrant.mockClear();
  h.store = createDocumentFixtureStore({ "users/owner": { accountLifecycle: { status: "active" } } });
  await h.store.users.connectorIntegrations.put({
    uid: "owner", connectorId: "google", status: "connected", accountLabel: "owner@example.com", scopes: [],
    captureMethod: "oauth-web", error: null, detail: {}, connectedAt: 1, verifiedAt: null, updatedAt: 1,
  });
  const transaction = h.store.transaction.bind(h.store);
  vi.spyOn(h.store, "transaction").mockImplementation((async (options, work) => {
    const result = await transaction(options, work);
    h.events.push("commit");
    return result;
  }) as PlatformStateStore["transaction"]);
});

afterEach(() => {
  installConnectorDisconnected(NO_CONNECTOR_DISCONNECTED);
  vi.restoreAllMocks();
});

describe("connector disconnect", () => {
  it("tells the installed hook which connector the user disconnected, after the disconnect commits", async () => {
    const disconnected = vi.fn(async () => {
      h.events.push("hook");
    });
    installConnectorDisconnected(disconnected);

    await request(app()).post("/api/connect/disconnect").send({ connector: "google" }).expect(200, { ok: true });

    expect(disconnected).toHaveBeenCalledWith("owner", "google");
    expect(h.events).toEqual(["commit", "hook"]);
    expect(await h.store.users.connectorIntegrations.get("owner", "google")).toMatchObject({ status: "disconnected" });
  });

  it("fails the disconnect when the installed hook fails", async () => {
    installConnectorDisconnected(async () => {
      throw new Error("hook failed");
    });

    const response = await request(app()).post("/api/connect/disconnect").send({ connector: "google" });

    expect(response.status).toBe(500);
  });

  it("disconnects without a product hook", async () => {
    await request(app()).post("/api/connect/disconnect").send({ connector: "google" }).expect(200, { ok: true });

    expect(h.events).toEqual(["commit"]);
    expect(await h.store.users.connectorIntegrations.get("owner", "google")).toMatchObject({ status: "disconnected" });
  });

  it("does not serve the Google grant directory", async () => {
    await request(app()).get("/api/connect/google/grants").expect(404);
    await request(app()).post("/api/connect/google/grants/member").send({ permissions: [] }).expect(404);
  });
});
