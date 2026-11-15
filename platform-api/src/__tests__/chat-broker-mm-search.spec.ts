import { describe, it, expect } from "vitest";
import { mmSearch, MmSearchScopeError } from "../lib/chat-broker/mm-search.js";

interface FakeClient {
  get: (path: string, pat: string) => Promise<any>;
  post: (path: string, pat: string, body: any) => Promise<any>;
  calls: Array<{ method: string; path: string; body?: any }>;
  responses: Record<string, any>;
}

function makeClient(responses: Record<string, any>): FakeClient {
  const calls: FakeClient["calls"] = [];
  return {
    calls,
    responses,
    async get(path) {
      calls.push({ method: "GET", path });
      const r = responses[`GET ${path}`];
      if (r === undefined) throw new Error(`unmocked GET ${path}`);
      return r;
    },
    async post(path, _pat, body) {
      calls.push({ method: "POST", path, body });
      const r = responses[`POST ${path}`];
      if (r === undefined) throw new Error(`unmocked POST ${path}`);
      return r;
    },
  };
}

const TEAM = "team-id-26-chars-abcdefghijk";

describe("mmSearch", () => {
  it("calls /teams/{tid}/posts/search with is_or_search:false", async () => {
    const c = makeClient({
      [`POST /api/v4/teams/${TEAM}/posts/search`]: { posts: {}, order: [] },
    });
    await mmSearch(c, "PAT", TEAM, { query: "decision", limit: 5 });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].body).toMatchObject({
      terms: "decision",
      is_or_search: false,
      include_deleted_channels: false,
      page: 0,
      per_page: 5,
    });
  });

  it("includes native archived channels only when the broker grants archive reads", async () => {
    const c = makeClient({
      [`POST /api/v4/teams/${TEAM}/posts/search`]: { posts: {}, order: [] },
    });

    await mmSearch(c, "PAT", TEAM, {
      query: "decision",
      includeDeletedChannels: true,
    });

    expect(c.calls[0].body).toMatchObject({ include_deleted_channels: true });
  });

  it("appends in:<channel> for current_channel scope", async () => {
    const c = makeClient({
      [`POST /api/v4/teams/${TEAM}/posts/search`]: { posts: {}, order: [] },
    });
    await mmSearch(c, "PAT", TEAM, {
      query: "decision",
      scope: "current_channel",
      currentChannelName: "builder-pulse",
    });
    expect(c.calls[0].body.terms).toBe("decision in:builder-pulse");
  });

  it("does not double-append in: when agent already specified one", async () => {
    const c = makeClient({
      [`POST /api/v4/teams/${TEAM}/posts/search`]: { posts: {}, order: [] },
    });
    await mmSearch(c, "PAT", TEAM, {
      query: "decision in:other-channel",
      scope: "current_channel",
      currentChannelName: "builder-pulse",
    });
    expect(c.calls[0].body.terms).toBe("decision in:other-channel");
  });

  it("current_channel scope WITHOUT a resolved channel name fails loud (no silent widen)", async () => {
    // Engineering principles: no silent failures. When the agent asks for
    // current_channel scope but the runtime can't supply a channel name
    // (e.g. no deliveryContext.to), the prior code path quietly fell
    // through to all_visible while the response container still reported
    // scope: "current_channel" — a lie. We now refuse the call with a
    // typed error so the caller (index.ts) can surface a clear tool-result
    // error instead of returning misleading results.
    const c = makeClient({
      // No POST should be made — fail before MM is touched.
    });
    await expect(
      mmSearch(c, "PAT", TEAM, { query: "decision", scope: "current_channel" /* no currentChannelName */ }),
    ).rejects.toBeInstanceOf(MmSearchScopeError);
    expect(c.calls).toHaveLength(0);
  });

  it("current_channel scope WITH empty-string channel name fails loud too", async () => {
    const c = makeClient({});
    await expect(
      mmSearch(c, "PAT", TEAM, { query: "decision", scope: "current_channel", currentChannelName: "" }),
    ).rejects.toBeInstanceOf(MmSearchScopeError);
    expect(c.calls).toHaveLength(0);
  });

  it("default scope is all_visible (no in: appended)", async () => {
    const c = makeClient({
      [`POST /api/v4/teams/${TEAM}/posts/search`]: { posts: {}, order: [] },
    });
    await mmSearch(c, "PAT", TEAM, { query: "anything", currentChannelName: "builder-pulse" });
    expect(c.calls[0].body.terms).toBe("anything");
  });

  it("clamps limit to 1..20 with default 10", async () => {
    const c = makeClient({
      [`POST /api/v4/teams/${TEAM}/posts/search`]: { posts: {}, order: [] },
    });
    await mmSearch(c, "PAT", TEAM, { query: "x", limit: 999 });
    expect(c.calls[0].body.per_page).toBe(20);
    await mmSearch(c, "PAT", TEAM, { query: "x", limit: 0 });
    expect(c.calls[1].body.per_page).toBe(1);
    await mmSearch(c, "PAT", TEAM, { query: "x" });
    expect(c.calls[2].body.per_page).toBe(10);
  });

  it("supports a bounded candidate scan for post-authorization filtering", async () => {
    const c = makeClient({
      [`POST /api/v4/teams/${TEAM}/posts/search`]: { posts: {}, order: [] },
    });
    await mmSearch(c, "PAT", TEAM, {
      query: "x",
      limit: 5,
      candidateLimit: 999,
    });
    expect(c.calls[0].body.per_page).toBe(100);
  });

  it("returns empty bundle when MM returns null/garbage", async () => {
    const c = makeClient({
      [`POST /api/v4/teams/${TEAM}/posts/search`]: null,
    });
    const out = await mmSearch(c, "PAT", TEAM, { query: "x" });
    expect(out.bundle.posts).toEqual({});
    expect(out.bundle.order).toEqual([]);
  });
});
