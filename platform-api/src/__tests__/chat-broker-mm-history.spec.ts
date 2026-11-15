import { describe, it, expect } from "vitest";
import { mmHistory, HistoryParamError } from "../lib/chat-broker/mm-history.js";

const DEFAULT_AGENT = "coach-uid-26-chars-abcdefgh";
const CH = "ch1id26charlongabcdefghij";

interface FakeClient {
  get: (path: string, pat: string) => Promise<any>;
  post: (path: string, pat: string, body: unknown) => Promise<any>;
  calls: string[];
  responses: Record<string, any>;
}

function makeClient(responses: Record<string, any>): FakeClient {
  const calls: string[] = [];
  return {
    calls,
    responses,
    async get(path) {
      calls.push(`GET ${path}`);
      const r = responses[path];
      if (r === undefined) throw new Error(`unmocked GET ${path}`);
      return r;
    },
    async post(path) {
      calls.push(`POST ${path}`);
      const r = responses[path];
      if (r === undefined) throw new Error(`unmocked POST ${path}`);
      return r;
    },
  };
}

const SAMPLE = {
  posts: {
    p1: { id: "p1", channel_id: CH, user_id: "u-1", message: "first", create_at: 1 },
    p2: { id: "p2", channel_id: CH, user_id: "u-2", message: "second", create_at: 2 },
    p3: { id: "p3", channel_id: CH, user_id: "u-1", message: "third", create_at: 3 },
  },
  // MM returns NEWEST first
  order: ["p3", "p2", "p1"],
  has_next: false,
};

describe("mmHistory dispatch", () => {
  it("latest hits /posts?per_page", async () => {
    const c = makeClient({ [`/api/v4/channels/${CH}/posts?per_page=10`]: SAMPLE });
    await mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "latest", limit: 10 });
    expect(c.calls).toEqual([`GET /api/v4/channels/${CH}/posts?per_page=10`]);
  });

  it("before requires cursor; throws missing-cursor without it", async () => {
    const c = makeClient({});
    await expect(
      mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "before", limit: 10 }),
    ).rejects.toBeInstanceOf(HistoryParamError);
  });

  it("before/after pass cursor in querystring", async () => {
    const c = makeClient({
      [`/api/v4/channels/${CH}/posts?before=p2&per_page=10`]: SAMPLE,
      [`/api/v4/channels/${CH}/posts?after=p2&per_page=10`]: SAMPLE,
    });
    await mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "before", cursor: "p2", limit: 10 });
    await mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "after", cursor: "p2", limit: 10 });
    expect(c.calls).toEqual([
      `GET /api/v4/channels/${CH}/posts?before=p2&per_page=10`,
      `GET /api/v4/channels/${CH}/posts?after=p2&per_page=10`,
    ]);
  });

  it("unread hits the user/channel/posts/unread endpoint", async () => {
    const path = `/api/v4/users/${DEFAULT_AGENT}/channels/${CH}/posts/unread?limit_before=0&limit_after=10`;
    const c = makeClient({ [path]: { ...SAMPLE, order: [] } });
    await mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "unread", limit: 10 });
    expect(c.calls).toEqual([`GET ${path}`]);
  });

  it("around splits ~symmetric (odd → extra to after)", async () => {
    const path = `/api/v4/channels/${CH}/posts/p2/around?limit_before=5&limit_after=6`;
    const c = makeClient({ [path]: SAMPLE });
    await mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "around", cursor: "p2", limit: 11 });
    expect(c.calls).toEqual([`GET ${path}`]);
  });

  it("around with even limit splits 50/50", async () => {
    const path = `/api/v4/channels/${CH}/posts/p2/around?limit_before=5&limit_after=5`;
    const c = makeClient({ [path]: SAMPLE });
    await mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "around", cursor: "p2", limit: 10 });
    expect(c.calls).toEqual([`GET ${path}`]);
  });

  it("around rejects limit < 2 — symmetric split is meaningless when there's no room for both sides", async () => {
    // The "around" semantics require at least one post before AND one after
    // the cursor, plus the cursor itself. limit=1 is internally inconsistent
    // with that contract — it would either silently return 3 posts (1+1+anchor,
    // breaking the limit) or 1 post (skipping a side). Refuse the request
    // with a typed error so the agent can correct.
    const c = makeClient({});
    await expect(
      mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "around", cursor: "p2", limit: 1 }),
    ).rejects.toBeInstanceOf(HistoryParamError);
    expect(c.calls).toHaveLength(0);
  });

  it("around with limit=2 splits 1/1", async () => {
    const path = `/api/v4/channels/${CH}/posts/p2/around?limit_before=1&limit_after=1`;
    const c = makeClient({ [path]: SAMPLE });
    await mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "around", cursor: "p2", limit: 2 });
    expect(c.calls).toEqual([`GET ${path}`]);
  });

  it("around with limit=3 splits 1/2 (odd → extra to after)", async () => {
    const path = `/api/v4/channels/${CH}/posts/p2/around?limit_before=1&limit_after=2`;
    const c = makeClient({ [path]: SAMPLE });
    await mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "around", cursor: "p2", limit: 3 });
    expect(c.calls).toEqual([`GET ${path}`]);
  });

  it("reverses MM order (newest-first → oldest-first)", async () => {
    const c = makeClient({ [`/api/v4/channels/${CH}/posts?per_page=10`]: SAMPLE });
    const out = await mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "latest", limit: 10 });
    expect(out.bundle.order).toEqual(["p1", "p2", "p3"]);
  });

  it("nextCursor = oldest, prevCursor = newest", async () => {
    const c = makeClient({ [`/api/v4/channels/${CH}/posts?per_page=10`]: SAMPLE });
    const out = await mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "latest", limit: 10 });
    expect(out.nextCursor).toBe("p1"); // oldest in oldest-first order
    expect(out.prevCursor).toBe("p3");
  });

  it("from_user filter applied client-side", async () => {
    const c = makeClient({ [`/api/v4/channels/${CH}/posts?per_page=10`]: SAMPLE });
    const out = await mmHistory(c, "PAT", {
      channelId: CH,
      defaultAgentMmUserId: DEFAULT_AGENT,
      direction: "latest",
      limit: 10,
      fromUsername: "alice",
      userIndex: new Map([["alice", "u-1"]]),
    });
    expect(out.bundle.order).toEqual(["p1", "p3"]);
  });

  it("unknown from_user returns empty (does not silently drop the filter)", async () => {
    const c = makeClient({ [`/api/v4/channels/${CH}/posts?per_page=10`]: SAMPLE });
    const out = await mmHistory(c, "PAT", {
      channelId: CH,
      defaultAgentMmUserId: DEFAULT_AGENT,
      direction: "latest",
      limit: 10,
      fromUsername: "ghost",
      userIndex: new Map(),
    });
    expect(out.bundle.order).toEqual([]);
  });

  it("limit clamped to 1..50", async () => {
    const c = makeClient({ [`/api/v4/channels/${CH}/posts?per_page=50`]: SAMPLE });
    await mmHistory(c, "PAT", { channelId: CH, defaultAgentMmUserId: DEFAULT_AGENT, direction: "latest", limit: 9999 });
    expect(c.calls).toEqual([`GET /api/v4/channels/${CH}/posts?per_page=50`]);
  });
});
