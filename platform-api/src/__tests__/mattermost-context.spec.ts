import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

const { getWorkspaceMmContext } = await import("../lib/mattermost-context.js");
const { installDocumentUserAccounts } = await import("./helpers/user-accounts.js");

installDocumentUserAccounts((uid) => h.docs.get(`users/${uid}`));

describe("getWorkspaceMmContext", () => {
  beforeEach(() => {
    h.docs.clear();
  });

  it("returns null when the owner has no account", async () => {
    await expect(getWorkspaceMmContext("uid-1")).resolves.toBeNull();
  });

  it("assembles workspace Mattermost ids from the platform records and product username", async () => {
    h.docs.set("users/uid-1", { username: "alice", mattermost: { userId: "owner-mm", username: "alice-mm" } });
    h.docs.set("workspaces/alice", { id: "alice", ownerUid: "uid-1", mattermost: { teamId: "team-1" } });
    h.docs.set("agents/uid-1", { mattermost: { userId: "coach-mm" } });
    h.docs.set("workspaces/alice/channels/general", { mattermost: { channelId: "general-ch" } });
    h.docs.set("workspaces/alice/channels/coach-dm", { mattermost: { channelId: "coach-dm-ch" } });
    h.docs.set("workspaces/alice/channels/admin", { mattermost: { channelId: "admin-ch" } });

    const ctx = await getWorkspaceMmContext("uid-1");

    expect(ctx).toEqual({
      ownerUid: "uid-1",
      slug: "alice",
      teamId: "team-1",
      userId: "owner-mm",
      username: "alice-mm",
      coachUserId: "coach-mm",
      coachDmChannelId: "coach-dm-ch",
      generalChannelId: "general-ch",
      adminChannelId: "admin-ch",
    });
  });

  it("takes the workspace slug from the platform user record before the account username", async () => {
    h.docs.set("users/uid-1", { username: "alice-account", provisioning: { openclaw: { slug: "alice" } } });
    h.docs.set("workspaces/alice", { id: "alice", ownerUid: "uid-1", mattermost: { teamId: "team-1" } });

    const ctx = await getWorkspaceMmContext("uid-1");

    expect(ctx).toMatchObject({ slug: "alice", teamId: "team-1" });
  });
});
