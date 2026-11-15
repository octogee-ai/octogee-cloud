import { describe, it, expect, vi } from "vitest";
import {
  ChatToolError,
  createChatClient,
  parseAgentIdentity,
  extractSlug,
} from "../chat-client.js";

function okJson(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

function client(fetchImpl: any, tokenProvider = async () => "sa-token") {
  return createChatClient({
    brokerUrl: "http://broker.test:3001",
    fetchImpl,
    tokenProvider,
  });
}

describe("parseAgentIdentity — multi-agent project agents", () => {
  it("parses agent and project agent ids, hyphenated slugs included", () => {
    expect(parseAgentIdentity("octogee-alice-coach")).toEqual({ slug: "alice", project: null });
    expect(parseAgentIdentity("octogee-big-sky-coach")).toEqual({ slug: "big-sky", project: null });
    expect(parseAgentIdentity("octogee-alice-proj-camp-coach")).toEqual({
      slug: "alice",
      project: "camp",
    });
    expect(parseAgentIdentity("octogee-big-sky-proj-app2-coach")).toEqual({
      slug: "big-sky",
      project: "app2",
    });
  });

  it("extractSlug returns the WORKSPACE slug for project agents (not the greedy body)", () => {
    expect(extractSlug("octogee-alice-proj-camp-coach")).toBe("alice");
  });

  it("rejects malformed ids", () => {
    expect(parseAgentIdentity("octogee-ops-gw-test")).toBeNull();
    expect(parseAgentIdentity("octogee-alice-proj--coach")).toBeNull();
    expect(parseAgentIdentity(undefined)).toBeNull();
  });
});

describe("chat client — thin broker calls (ZERO PAT handling in the extension)", () => {
  it("POSTs search to the fleet broker with the SA token and derived workspace slug", async () => {
    const fetchImpl = vi.fn(async () => okJson({ results: [], total_returned: 0 }));
    const c = client(fetchImpl);

    const out = await c.search({
      agentId: "octogee-alice-coach",
      siteUrl: "https://chat.example",
      query: "campsite",
      scope: "all_visible",
      limit: 5,
      currentChannelId: "abcdefghijklmnopqrstuvwxyz",
    });

    expect(out).toEqual({ results: [], total_returned: 0 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://broker.test:3001/internal/fleet/agent/chat-search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-K8s-Sa-Token": "sa-token" }),
      }),
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({
      workspaceSlug: "alice",
      agentId: "octogee-alice-coach",
      siteUrl: "https://chat.example",
      query: "campsite",
      scope: "all_visible",
      limit: 5,
      currentChannelId: "abcdefghijklmnopqrstuvwxyz",
    });
  });

  it("POSTs history with the browse params", async () => {
    const fetchImpl = vi.fn(async () => okJson({ messages: [], has_more: false }));
    const c = client(fetchImpl);

    await c.history({
      agentId: "octogee-alice-coach",
      siteUrl: "https://chat.example",
      channel: "alice-general",
      direction: "before",
      cursor: "post-1",
      limit: 10,
      fromUsername: "taylor",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("http://broker.test:3001/internal/fleet/agent/chat-history");
    expect(JSON.parse(init.body)).toMatchObject({
      workspaceSlug: "alice",
      channel: "alice-general",
      direction: "before",
      cursor: "post-1",
      limit: 10,
      fromUsername: "taylor",
    });
  });

  it("throws not-coach before any network call for an unparseable agent id", async () => {
    const fetchImpl = vi.fn();
    const c = client(fetchImpl);
    await expect(
      c.search({ agentId: "octogee-ops-gw", siteUrl: "https://x", query: "q" }),
    ).rejects.toMatchObject({ code: "not-coach" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws auth-unavailable when the projected SA token is missing", async () => {
    const fetchImpl = vi.fn();
    const c = client(fetchImpl, async () => null);
    await expect(
      c.search({ agentId: "octogee-alice-coach", siteUrl: "https://x", query: "q" }),
    ).rejects.toMatchObject({ code: "auth-unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects project agents before credential lookup or network", async () => {
    const fetchImpl = vi.fn();
    const c = client(fetchImpl);
    const err = await c
      .search({ agentId: "octogee-alice-proj-camp-coach", siteUrl: "https://x", query: "q" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatToolError);
    expect((err as ChatToolError).code).toBe("not-coach");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps an unreachable broker to control-error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const c = client(fetchImpl);
    await expect(
      c.history({ agentId: "octogee-alice-coach", siteUrl: "https://x", channel: "c" }),
    ).rejects.toMatchObject({ code: "control-error" });
  });
});
