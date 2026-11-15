import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDocumentPresentation } from "./helpers/project-presentation.js";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  mmApi: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

const documentFake = (path: string) => ({
      get: async () => {
        const data = h.docs.get(path);
        return { exists: data !== undefined, data: () => data };
      },
    });

vi.mock("../lib/mattermost.js", () => ({
  mmApi: (...args: unknown[]) => h.mmApi(...args),
}));

vi.mock("@octogee/core/http/logging", () => ({ logger: h.logger }));

const {
  MattermostChannelBindingError,
  MattermostIdentityMissingError,
  addChannelMember,
  addActiveChannelMember,
  mapMattermostMembershipError,
  removeChannelMember,
  retireStoredChannel,
  setStoredChannelArchived,
  setStoredPrimaryChannelArchived,
} = await import("../lib/channel-lifecycle.js");

installDocumentPresentation(documentFake);

const channelPath = "workspaces/alice/channels/general";

function channel(
  id: string,
  name: string,
  teamId = "team",
  type: "P" | "O" = "P",
  deleteAt = 0,
) {
  return { id, name, team_id: teamId, type, delete_at: deleteAt };
}

beforeEach(() => {
  h.docs.clear();
  h.docs.set("workspaces/alice", { id: "alice", ownerUid: "owner-1", mattermost: { teamId: "team" } });
  h.docs.set(channelPath, {
    kind: "general",
    mattermost: { channelId: "primary" },
  });
  h.mmApi.mockReset();
  h.logger.error.mockReset();
  h.logger.warn.mockReset();
});

describe("channel lifecycle", () => {
  it("joins and leaves the canonical channel", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") return channel("primary", "alice-general");
      if (path === "/users/member" && method === "GET") return { id: "member", delete_at: 0 };
      if (path === "/channels/primary/members" && method === "POST") return {};
      if (path === "/channels/primary/members/member" && method === "DELETE") return {};
      throw new Error(`unexpected ${method} ${path}`);
    });

    await addChannelMember(channelPath, "member");
    await removeChannelMember(channelPath, "member");

    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary/members", "POST", { user_id: "member" });
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary/members/member", "DELETE");
  });

  it("revokes membership from a verified legacy Activity channel before the canonical channel", async () => {
    h.docs.set(channelPath, {
      kind: "general",
      mattermost: { channelId: "primary", activityChannelId: "legacy" },
    });
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") return channel("primary", "alice-general");
      if (path === "/channels/legacy" && method === "GET") return channel("legacy", "alice-general-activity");
      if (path.endsWith("/members/member") && method === "DELETE") return {};
      throw new Error(`unexpected ${method} ${path}`);
    });

    await removeChannelMember(channelPath, "member");

    expect(h.mmApi.mock.calls).toEqual([
      ["/channels/primary"],
      ["/channels/legacy"],
      ["/channels/legacy/members/member", "DELETE"],
      ["/channels/primary/members/member", "DELETE"],
    ]);
  });

  it("refuses a forged legacy Activity pointer before revoking either membership", async () => {
    h.docs.set(channelPath, {
      kind: "general",
      mattermost: { channelId: "primary", activityChannelId: "legacy" },
    });
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") return channel("primary", "alice-general");
      if (path === "/channels/legacy" && method === "GET") return channel("legacy", "victim-general", "victim-team");
      throw new Error(`unexpected ${method} ${path}`);
    });

    await expect(removeChannelMember(channelPath, "member"))
      .rejects.toBeInstanceOf(MattermostChannelBindingError);

    expect(h.mmApi.mock.calls.some(([, method]) => method === "DELETE")).toBe(false);
  });

  it("restores legacy Activity membership when canonical revocation fails", async () => {
    h.docs.set(channelPath, {
      kind: "general",
      mattermost: { channelId: "primary", activityChannelId: "legacy" },
    });
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") return channel("primary", "alice-general");
      if (path === "/channels/legacy" && method === "GET") return channel("legacy", "alice-general-activity");
      if (path === "/channels/legacy/members/member" && method === "DELETE") return {};
      if (path === "/channels/primary/members/member" && method === "DELETE") throw new Error("primary failed");
      if (path === "/channels/legacy/members" && method === "POST") return {};
      throw new Error(`unexpected ${method} ${path}`);
    });

    await expect(removeChannelMember(channelPath, "member")).rejects.toThrow("primary failed");

    expect(h.mmApi).toHaveBeenCalledWith(
      "/channels/legacy/members",
      "POST",
      { user_id: "member" },
    );
  });

  it.each([
    ["add", addChannelMember],
    ["remove", removeChannelMember],
  ] as const)("refuses to %s membership through a forged primary pointer", async (_operation, mutate) => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return channel("primary", "other-general", "other-team");
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await expect(mutate(channelPath, "member"))
      .rejects.toBeInstanceOf(MattermostChannelBindingError);

    expect(h.mmApi).toHaveBeenCalledTimes(1);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
    expect(h.mmApi.mock.calls.some(([, method]) => method === "POST" || method === "DELETE")).toBe(false);
  });

  it("archives and restores the canonical channel", async () => {
    let deleteAt = 0;
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return channel("primary", "alice-general", "team", "P", deleteAt);
      }
      if (path === "/channels/primary" && method === "DELETE") {
        deleteAt = Date.now();
        return {};
      }
      if (path === "/channels/primary/restore" && method === "POST") {
        deleteAt = 0;
        return {};
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await setStoredPrimaryChannelArchived(channelPath, true);
    await setStoredPrimaryChannelArchived(channelPath, false);

    expect(h.mmApi.mock.calls).toEqual([
      ["/channels/primary"],
      ["/channels/primary", "DELETE"],
      ["/channels/primary"],
      ["/channels/primary/restore", "POST"],
    ]);
  });

  it("retires the canonical channel: one verification, rename while live, then archive", async () => {
    let name = "alice-general";
    let deleteAt = 0;
    h.mmApi.mockImplementation(async (path: string, method = "GET", body?: { name?: string }) => {
      if (path === "/channels/primary" && method === "GET") return channel("primary", name, "team", "P", deleteAt);
      if (path === "/channels/primary/patch" && method === "PUT") {
        name = String(body?.name);
        return channel("primary", name, "team", "P", deleteAt);
      }
      if (path === "/channels/primary" && method === "DELETE") {
        deleteAt = 1;
        return {};
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await retireStoredChannel(channelPath, () => 1_789_070_223_358);

    expect(h.mmApi.mock.calls).toEqual([
      ["/channels/primary"],
      ["/channels/primary/patch", "PUT", { name: `alice-general-x${Math.floor(1_789_070_223_358 / 1000).toString(36)}` }],
      ["/channels/primary", "DELETE"],
    ]);
    expect(deleteAt).toBe(1);
  });

  it("archives an already-retired-by-name channel only once and never renames an archived one", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") return channel("primary", "alice-general", "team", "P", 5);
      throw new Error(`unexpected ${method} ${path}`);
    });

    await retireStoredChannel(channelPath);

    expect(h.mmApi.mock.calls).toEqual([["/channels/primary"]]);
  });

  it("changes the primary lifecycle without binding or mutating a legacy history pointer", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") return channel("primary", "alice-general");
      if (path === "/channels/primary" && method === "DELETE") return {};
      throw new Error(`unexpected ${method} ${path}`);
    });

    await setStoredChannelArchived(channelPath, true);

    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary", "DELETE");
    expect(h.mmApi.mock.calls.some(([path]) => String(path).includes("legacy"))).toBe(false);
  });

  it("treats an already archived primary channel as an idempotent no-op", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return channel("primary", "alice-general", "team", "P", Date.now());
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await setStoredPrimaryChannelArchived(channelPath, true);

    expect(h.mmApi).toHaveBeenCalledTimes(1);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
  });

  it("treats an already active primary channel as an idempotent no-op", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return channel("primary", "alice-general");
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await setStoredPrimaryChannelArchived(channelPath, false);

    expect(h.mmApi).toHaveBeenCalledTimes(1);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
  });

  it("rejects channel state without a numeric deletion timestamp", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return { ...channel("primary", "alice-general"), delete_at: "0" };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await expect(setStoredPrimaryChannelArchived(channelPath, true))
      .rejects.toBeInstanceOf(MattermostChannelBindingError);

    expect(h.mmApi).toHaveBeenCalledTimes(1);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
  });

  it("rejects an already archived channel whose stored binding is forged", async () => {
    h.mmApi.mockImplementation(async (path: string, method = "GET") => {
      if (path === "/channels/primary" && method === "GET") {
        return channel("primary", "other-general", "other-team", "P", Date.now());
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    await expect(setStoredPrimaryChannelArchived(channelPath, true))
      .rejects.toBeInstanceOf(MattermostChannelBindingError);

    expect(h.mmApi).toHaveBeenCalledTimes(1);
    expect(h.mmApi).toHaveBeenCalledWith("/channels/primary");
  });

  it("maps a missing Mattermost identity without treating channel lifecycle failures as membership errors", () => {
    expect(mapMattermostMembershipError(new MattermostIdentityMissingError("missing"))).toEqual({
      status: 422,
      body: { error: expect.stringMatching(/chat account/i) },
    });
    expect(mapMattermostMembershipError(new MattermostChannelBindingError("forged"))).toBeNull();
  });
});


it("new-channel enrollment skips deactivated General members without reactivating them", async () => {
  h.mmApi.mockImplementation(async (path: string) => {
    if (path === "/channels/primary") return channel("primary", "alice-general");
    if (path === "/users/retired") return { id: "retired", delete_at: 123 };
    throw new Error(`unexpected call ${path}`);
  });
  expect(await addActiveChannelMember(channelPath, "retired")).toBe(false);
  expect(h.mmApi.mock.calls.every(([, method]) => !method || method === "GET")).toBe(true);
});
