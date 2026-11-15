import { beforeEach, describe, expect, it } from "vitest";
import {
  chatBrokerErrorStatus,
  executeChatHistory,
  executeChatSearch,
  type ChatBrokerIdentity,
} from "../lib/chat-broker/execute.js";
import { _resetTeamCachesForTests } from "../lib/chat-broker/team.js";
import type { MmClient } from "../lib/chat-broker/mm-client.js";

const IDENTITY: ChatBrokerIdentity = {
  pat: "user-pat",
  defaultAgentMmUserId: "mm-coach-bot",
  unread: { pat: "default-agent-pat", mmUserId: "mm-coach-bot" },
  slug: "alice",
  siteUrl: "https://chat.example",
};

function fakeMm(calls: Array<{ path: string; pat: string }>): MmClient {
  return {
    get: async (path: string, pat: string) => {
      calls.push({ path, pat });
      if (path.startsWith("/api/v4/teams/name/")) return { id: "team-1" };
      if (path.includes("/channels/name/")) return { id: "abcdefghijklmnopqrstuvwxyz" };
      if (path.includes("/posts")) return { posts: {}, order: [] };
      if (path.startsWith("/api/v4/channels/")) {
        return { id: "abcdefghijklmnopqrstuvwxyz", name: "alice-general", display_name: "General" };
      }
      return {};
    },
    post: async (path: string, pat: string) => {
      calls.push({ path, pat });
      return [];
    },
  };
}

beforeEach(() => _resetTeamCachesForTests());

describe("executeChatHistory — unread runs under the agent bot's own PAT", () => {
  it("direction=unread fetches the BOT's cursor with the BOT's PAT, not the user's", async () => {
    const calls: Array<{ path: string; pat: string }> = [];
    await executeChatHistory(IDENTITY, { channel: "alice-general", direction: "unread" }, fakeMm(calls));

    const unreadCall = calls.find((c) => c.path.includes("/posts/unread"));
    expect(unreadCall).toBeDefined();
    expect(unreadCall!.path).toContain("/users/mm-coach-bot/");
    expect(unreadCall!.pat).toBe("default-agent-pat");
  });

  it("every other direction reads under the lane PAT (the user's, for the workspace agent)", async () => {
    const calls: Array<{ path: string; pat: string }> = [];
    await executeChatHistory(IDENTITY, { channel: "alice-general", direction: "latest" }, fakeMm(calls));

    const postsCall = calls.find((c) => /\/channels\/[a-z0-9]{26}\/posts\?/.test(c.path));
    expect(postsCall).toBeDefined();
    expect(postsCall!.pat).toBe("user-pat");
  });

  it("reads a natively archived channel only during the granted archive window", async () => {
    const calls: Array<{ path: string; pat: string }> = [];
    const mm = fakeMm(calls);
    mm.get = async (path: string, pat: string) => {
      calls.push({ path, pat });
      if (path.startsWith("/api/v4/teams/name/")) return { id: "team-1" };
      if (path.includes("/channels/name/")) return { id: "abcdefghijklmnopqrstuvwxyz" };
      if (path.includes("/posts")) return { posts: {}, order: [] };
      if (path.startsWith("/api/v4/channels/")) {
        return {
          id: "abcdefghijklmnopqrstuvwxyz",
          name: "alice-proj-camp-general",
          display_name: "Camp",
          delete_at: 1,
        };
      }
      return {};
    };

    await expect(executeChatHistory(
      { ...IDENTITY, includeArchivedProjectHistory: true },
      { channel: "alice-proj-camp-general", direction: "latest" },
      mm,
    )).resolves.toMatchObject({ messages: [] });

    expect(calls).toContainEqual({
      path: "/api/v4/teams/team-1/channels/name/alice-proj-camp-general?include_deleted=true",
      pat: "user-pat",
    });
  });

  it("denies direct archived-channel history when the archive grant is absent", async () => {
    const calls: Array<{ path: string; pat: string }> = [];
    const mm = fakeMm(calls);
    mm.get = async (path: string, pat: string) => {
      calls.push({ path, pat });
      if (path.startsWith("/api/v4/teams/name/")) return { id: "team-1" };
      if (path.startsWith("/api/v4/channels/")) {
        return {
          id: "abcdefghijklmnopqrstuvwxyz",
          name: "alice-proj-camp-general",
          display_name: "Camp",
          delete_at: 1,
        };
      }
      if (path.includes("/posts")) return { posts: {}, order: [] };
      return {};
    };

    await expect(executeChatHistory(
      IDENTITY,
      { channel: "abcdefghijklmnopqrstuvwxyz", direction: "latest" },
      mm,
    )).rejects.toMatchObject({ code: "archived-channel" });
    expect(calls.some((call) => call.path.includes("/posts?"))).toBe(false);
  });

  it("rejects non-canonical channel history before any post read", async () => {
    const calls: Array<{ path: string; pat: string }> = [];
    const error = await executeChatHistory(
      { ...IDENTITY, canReadChannel: async () => false },
      { channel: "abcdefghijklmnopqrstuvwxyz", direction: "latest" },
      fakeMm(calls),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "channel-forbidden" });
    expect(chatBrokerErrorStatus(error)).toEqual({
      status: 403,
      code: "channel-forbidden",
    });
    expect(calls.some((call) => call.path.includes("/posts?"))).toBe(false);
  });
});

describe("executeChatSearch — canonical channel boundary", () => {
  it("drops unauthorized posts before channel or user hydration", async () => {
    const allowedChannelId = "a".repeat(26);
    const deniedChannelId = "d".repeat(26);
    const calls: Array<{ path: string; pat: string }> = [];
    const mm = fakeMm(calls);
    mm.post = async (path: string, pat: string) => {
      calls.push({ path, pat });
      if (path.includes("/posts/search")) {
        return {
          posts: {
            allowed: {
              id: "allowed",
              channel_id: allowedChannelId,
              user_id: "allowed-user",
              message: "allowed result",
              create_at: 1,
            },
            denied: {
              id: "denied",
              channel_id: deniedChannelId,
              user_id: "denied-user",
              message: "private result",
              create_at: 2,
            },
            allowed2: {
              id: "allowed2",
              channel_id: allowedChannelId,
              user_id: "allowed-user",
              message: "second allowed result",
              create_at: 3,
            },
          },
          order: ["allowed", "denied", "allowed2"],
        };
      }
      if (path === "/api/v4/users/ids") {
        return [{ id: "allowed-user", username: "allowed" }];
      }
      return [];
    };
    mm.get = async (path: string, pat: string) => {
      calls.push({ path, pat });
      if (path.startsWith("/api/v4/teams/name/")) return { id: "team-1" };
      if (path === `/api/v4/channels/${allowedChannelId}`) {
        return {
          id: allowedChannelId,
          name: "alice-general",
          display_name: "General",
        };
      }
      throw new Error(`unexpected read ${path}`);
    };

    const result = await executeChatSearch(
      {
        ...IDENTITY,
        canReadChannel: async (channelId) => channelId === allowedChannelId,
      },
      { query: "result", limit: 1 },
      mm,
    );

    expect(result.results).toEqual([
      expect.objectContaining({ post_id: "allowed" }),
    ]);
    expect(calls).not.toContainEqual({
      path: `/api/v4/channels/${deniedChannelId}`,
      pat: "user-pat",
    });
    expect(calls.find((call) => call.path === "/api/v4/users/ids")).toBeDefined();
  });
});
