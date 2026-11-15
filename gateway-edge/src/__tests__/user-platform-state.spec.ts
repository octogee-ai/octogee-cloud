import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

const { accountActiveInStore, userDataWithUserState } = await import("../lib/user-platform-state.js");
const { platformStateStore } = await import("../lib/platform-state.js");

beforeEach(() => {
  h.docs.clear();
});

describe("accountActiveInStore", () => {
  it("treats an account with no recorded lifecycle as active, leaving existence to its callers", async () => {
    await expect(accountActiveInStore("missing")).resolves.toBe(true);
  });

  it("allows an account with an active lifecycle", async () => {
    h.docs.set("users/u1", { accountLifecycle: { status: "active" } });

    await expect(accountActiveInStore("u1")).resolves.toBe(true);
  });

  it("denies a suspended account", async () => {
    h.docs.set("users/u1", { accountLifecycle: { status: "suspended" } });

    await expect(accountActiveInStore("u1")).resolves.toBe(false);
  });

  it("propagates a store failure rather than deciding from the product document", async () => {
    const get = vi.spyOn(platformStateStore.users.records, "get").mockRejectedValueOnce(new Error("store unavailable"));

    await expect(accountActiveInStore("u1")).rejects.toThrow("store unavailable");
    get.mockRestore();
  });
});

describe("userDataWithUserState", () => {
  it("replaces stale projected fields with the authoritative record and keeps product fields", async () => {
    h.docs.set("users/u1", {
      workspaceId: "mira",
      accountLifecycle: { status: "suspended" },
      mattermost: { userId: "mm-current" },
      provisioning: { openclaw: { gatewayId: "gw-current", slug: "mira", agentIds: ["octogee-mira-coach"] } },
    });
    const user = await platformStateStore.users.records.get("u1");

    const merged = userDataWithUserState(
      {
        username: "mira",
        firstName: "Mira",
        accountLifecycle: { status: "active" },
        mattermost: { userId: "mm-stale", username: "mira-mm" },
        provisioning: { openclaw: { gatewayId: "gw-stale", slug: "old", agentIds: [] } },
      },
      user,
    );

    expect(merged).toMatchObject({
      username: "mira",
      firstName: "Mira",
      workspaceId: "mira",
      accountLifecycle: { status: "suspended" },
      mattermost: { userId: "mm-current", username: "mira-mm" },
      provisioning: { openclaw: { gatewayId: "gw-current", slug: "mira", agentIds: ["octogee-mira-coach"] } },
    });
  });

  it("clears projected authority when the store has no record", () => {
    const merged = userDataWithUserState(
      { username: "mira", accountLifecycle: { status: "active" }, mattermost: { userId: "mm-stale" } },
      null,
    );

    expect(merged).toMatchObject({ username: "mira", accountLifecycle: null, mattermost: { userId: null } });
  });

  it("returns the same object when the projection already matches", async () => {
    h.docs.set("users/u1", { workspaceId: "mira", username: "mira" });
    const user = await platformStateStore.users.records.get("u1");
    const userData = {
      username: "mira",
      workspaceId: "mira",
      accountLifecycle: user?.accountLifecycle ?? null,
      mattermost: { userId: user?.mattermostUserId ?? null },
      provisioning: { openclaw: { gatewayId: null, agentIds: user?.agents.agentIds ?? [], slug: user?.slug ?? null } },
    };

    expect(userDataWithUserState(userData, user)).toBe(userData);
  });
});
