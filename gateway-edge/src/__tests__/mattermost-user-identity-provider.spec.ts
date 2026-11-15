import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserAccountRecord } from "@octogee/core/platform-state";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  accounts: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});
vi.mock("../middleware/logging", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { installUserIdentityProvider, requireAdmin, requireAuth } = await import("../middleware/auth.js");
const { authenticationFailureLimit } = await import("../middleware/authenticated-request-limit.js");
const { mattermostUserIdentityProvider, platformStateUserLoader } = await import("../lib/mattermost-user-identity-provider.js");
const { platformStateStore } = await import("../lib/platform-state.js");

const MATTERMOST_URL = "http://mattermost.internal:8065";
const LIN_SESSION = "abcdefghijklmnopqrstuvwxyz";

const store = {
  users: {
    records: platformStateStore.users.records,
    accounts: {
      get: async (uid: string) => (h.accounts.get(uid) as UserAccountRecord | undefined) ?? null,
    },
  },
};

function mattermostKnowing(sessions: Record<string, Record<string, unknown>>) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const token = new Headers(init.headers).get("authorization")?.slice("Bearer ".length) ?? "";
    const account = sessions[token];
    return account === undefined
      ? new Response(JSON.stringify({ id: "api.context.session_expired.app_error" }), { status: 401 })
      : new Response(JSON.stringify(account), { status: 200 });
  });
}

function appWith(fetch: ReturnType<typeof mattermostKnowing>) {
  installUserIdentityProvider(mattermostUserIdentityProvider({
    mattermostUrl: MATTERMOST_URL,
    store,
    fetch: fetch as unknown as typeof globalThis.fetch,
  }));
  const app = express();
  app.get("/me", authenticationFailureLimit, requireAuth, (req, res) => {
    res.json({ uid: req.uid, user: req.user, workspaceSlug: req.workspaceSlug, isAdmin: req.isAdmin });
  });
  app.get("/admin", authenticationFailureLimit, requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

beforeEach(() => {
  h.docs.clear();
  h.accounts.clear();
  h.docs.set("users/uid-lin", {
    mattermost: { userId: "mm-lin" },
    workspaceId: "lin",
    provisioning: { openclaw: { slug: "lin", gatewayId: "shared-a" } },
  });
  h.docs.set("workspaces/lin", { id: "lin", ownerUid: "uid-lin" });
  h.accounts.set("uid-lin", { uid: "uid-lin", name: "lin", email: "lin@example.com", createdAt: 1 });
});

describe("signing in to the platform with a Mattermost session", () => {
  it("authenticates the platform user provisioned for the Mattermost account", async () => {
    const fetch = mattermostKnowing({ [LIN_SESSION]: { id: "mm-lin", delete_at: 0 } });

    const response = await request(appWith(fetch)).get("/me").set("authorization", `Bearer ${LIN_SESSION}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      uid: "uid-lin",
      workspaceSlug: "lin",
      isAdmin: false,
      user: {
        username: "lin",
        email: "lin@example.com",
        workspaceId: "lin",
        mattermost: { userId: "mm-lin" },
        provisioning: { openclaw: { gatewayId: "shared-a" } },
      },
    });
  });

  it("refuses a session Mattermost does not accept", async () => {
    const response = await request(appWith(mattermostKnowing({}))).get("/me").set("authorization", `Bearer ${LIN_SESSION}`);

    expect(response.status).toBe(401);
  });

  it("refuses a suspended platform user", async () => {
    h.docs.set("users/uid-lin", { ...h.docs.get("users/uid-lin"), accountLifecycle: { status: "suspended" } });
    const fetch = mattermostKnowing({ [LIN_SESSION]: { id: "mm-lin", delete_at: 0 } });

    const response = await request(appWith(fetch)).get("/me").set("authorization", `Bearer ${LIN_SESSION}`);

    expect(response.status).toBe(403);
  });

  it("asks only the configured Mattermost, whatever host the request names", async () => {
    const fetch = mattermostKnowing({ [LIN_SESSION]: { id: "mm-lin", delete_at: 0 } });

    await request(appWith(fetch))
      .get("/me")
      .set("authorization", `Bearer ${LIN_SESSION}`)
      .set("host", "attacker.example")
      .set("x-forwarded-host", "attacker.example");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(`${MATTERMOST_URL}/api/v4/users/me`);
  });
});

describe("platform administration with a Mattermost session", () => {
  it("does not make a Mattermost system admin a platform admin", async () => {
    const fetch = mattermostKnowing({
      [LIN_SESSION]: { id: "mm-lin", delete_at: 0, roles: "system_admin system_user", username: "admin" },
    });

    const response = await request(appWith(fetch)).get("/admin").set("authorization", `Bearer ${LIN_SESSION}`);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Admin access required" });
  });

  it("admits a user the platform records as an admin", async () => {
    h.docs.set("users/uid-lin/system/config", { role: "admin" });
    const fetch = mattermostKnowing({ [LIN_SESSION]: { id: "mm-lin", delete_at: 0, roles: "system_user" } });

    const response = await request(appWith(fetch)).get("/admin").set("authorization", `Bearer ${LIN_SESSION}`);

    expect(response.status).toBe(200);
  });
});

describe("loading a platform user from platform state", () => {
  it("has no user when platform state has no record, even with an account", async () => {
    h.docs.delete("users/uid-lin");

    await expect(platformStateUserLoader(store)("uid-lin")).resolves.toBeNull();
  });

  it("loads a record that has no account", async () => {
    h.accounts.delete("uid-lin");

    const user = await platformStateUserLoader(store)("uid-lin");

    expect(user).toMatchObject({ workspaceId: "lin", provisioning: { openclaw: { slug: "lin" } } });
    expect(user).not.toHaveProperty("email");
  });

  it("propagates a store failure", async () => {
    const failing = { users: { ...store.users, accounts: { get: async () => { throw new Error("store unavailable"); } } } };

    await expect(platformStateUserLoader(failing)("uid-lin")).rejects.toThrow("store unavailable");
  });
});
