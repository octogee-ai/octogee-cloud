/**
 * `octogee_chat_history` HTTP layer — channel browsing in time order.
 * Spec §4.2.
 */

import { asMmJsonObject, type MmClient, type MmJsonObject } from "./mm-client.js";
import type { MmChannelMeta, MmPost, MmPostsBundle } from "./shape.js";

export type Direction = "latest" | "before" | "after" | "unread" | "around";

export interface HistoryParams {
  /** Resolved channel id (caller does name → id resolution). */
  channelId: string;
  /** Agent's MM user id — required by `unread` endpoint. */
  defaultAgentMmUserId: string;
  direction?: Direction;
  /** Required for `before`, `after`, `around`. Post id. */
  cursor?: string;
  /** 1-50, default 25. For `around`, splits roughly half/half. */
  limit?: number;
  /** Filter to posts by this MM username (no `@`); applied client-side. */
  fromUsername?: string;
  /** Map of MM users for fromUsername filter resolution; supplied by caller. */
  userIndex?: Map<string, string>; // username → user_id
}

export interface HistoryResponse {
  bundle: MmPostsBundle;
  channelMeta?: MmChannelMeta;
  /** Post id at the oldest end of the page — pass as cursor with direction=before to page back. */
  nextCursor: string | null;
  /** Post id at the newest end of the page. */
  prevCursor: string | null;
  /** Hint, not guaranteed — MM doesn't always tell us. */
  hasMore: boolean;
  raw: { tookMs: number };
}

export class HistoryParamError extends Error {
  constructor(
    public readonly code:
      | "missing-cursor"
      | "missing-channel"
      | "invalid-direction"
      | "invalid-limit"
      | "archived-channel",
    message: string,
  ) {
    super(message);
    this.name = "HistoryParamError";
  }
}

export async function mmHistory(
  client: MmClient,
  pat: string,
  params: HistoryParams,
): Promise<HistoryResponse> {
  const direction: Direction = params.direction ?? "latest";
  const limit = clamp(params.limit ?? 25, 1, 50);
  const path = endpointFor(direction, params.channelId, params.defaultAgentMmUserId, params.cursor, limit);

  const t0 = Date.now();
  const raw = await client.get(path, pat);
  const tookMs = Date.now() - t0;
  const rawObject = asMmJsonObject(raw);

  let bundle: MmPostsBundle = {
    posts: postsFromRaw(rawObject),
    order: orderFromRaw(rawObject),
  };

  // Apply from_user filter (spec §4.2 — client-side).
  if (params.fromUsername && params.userIndex) {
    const userId = params.userIndex.get(params.fromUsername);
    if (userId) {
      bundle = filterByUser(bundle, userId);
    } else {
      // Unknown username → empty result. Do NOT silently drop the filter,
      // that would mislead the agent into thinking the user has zero posts
      // when really we just couldn't resolve them.
      bundle = { posts: {}, order: [] };
    }
  }

  // MM returns posts NEWEST-first in `order`; spec §4.2 ships them
  // OLDEST-first to the agent so it reads chronologically. Reverse here.
  const orderOldestFirst = [...bundle.order].reverse();
  const oldest = orderOldestFirst[0] ?? null;
  const newest = orderOldestFirst[orderOldestFirst.length - 1] ?? null;

  return {
    bundle: { posts: bundle.posts, order: orderOldestFirst },
    channelMeta: undefined,
    nextCursor: oldest, // pass with direction=before to page further back
    prevCursor: newest,
    hasMore: typeof rawObject?.has_next === "boolean" ? rawObject.has_next : orderOldestFirst.length >= limit,
    raw: { tookMs },
  };
}

function endpointFor(
  direction: Direction,
  channelId: string,
  defaultAgentMmUserId: string,
  cursor: string | undefined,
  limit: number,
): string {
  switch (direction) {
    case "latest":
      return `/api/v4/channels/${channelId}/posts?per_page=${limit}`;
    case "before":
      requireCursor(cursor, "before");
      return `/api/v4/channels/${channelId}/posts?before=${encodeURIComponent(cursor!)}&per_page=${limit}`;
    case "after":
      requireCursor(cursor, "after");
      return `/api/v4/channels/${channelId}/posts?after=${encodeURIComponent(cursor!)}&per_page=${limit}`;
    case "unread":
      // MM API: ?limit_before=0 says "no posts older than last_viewed_at",
      // ?limit_after={N} says "up to N posts newer than last_viewed_at".
      // Side effect: this endpoint advances last_viewed_at as a documented
      // MM behavior (spec §6 acceptance — matches human client semantics).
      return `/api/v4/users/${defaultAgentMmUserId}/channels/${channelId}/posts/unread?limit_before=0&limit_after=${limit}`;
    case "around": {
      requireCursor(cursor, "around");
      // `around` returns N before + 1 anchor + M after. Spec §10 #6 says
      // "minimum 1 each side", which is incompatible with limit=1. Rather
      // than silently violating the user's `limit` (returning 3 posts when
      // they asked for 1) or silently dropping a side, refuse limits < 2.
      if (limit < 2) {
        throw new HistoryParamError(
          "invalid-limit",
          `direction "around" requires limit >= 2 (got ${limit}) — needs room for at least 1 before + 1 after the anchor`,
        );
      }
      // Symmetric split. If limit is odd, the extra goes to `after`
      // (more weight to newer context).
      const half = Math.floor(limit / 2);
      const limitBefore = half;
      const limitAfter = limit - half;
      return `/api/v4/channels/${channelId}/posts/${encodeURIComponent(cursor!)}/around?limit_before=${limitBefore}&limit_after=${limitAfter}`;
    }
    default: {
      const _exhaustive: never = direction;
      throw new HistoryParamError("invalid-direction", `unknown direction: ${_exhaustive}`);
    }
  }
}

function requireCursor(cursor: string | undefined, direction: Direction): void {
  if (!cursor) {
    throw new HistoryParamError(
      "missing-cursor",
      `direction "${direction}" requires a cursor (post id)`,
    );
  }
}

function filterByUser(bundle: MmPostsBundle, userId: string): MmPostsBundle {
  const order: string[] = [];
  const posts: Record<string, MmPost> = {};
  for (const id of bundle.order) {
    const p = bundle.posts[id];
    if (p && p.user_id === userId) {
      order.push(id);
      posts[id] = p;
    }
  }
  return { order, posts };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function postsFromRaw(raw: MmJsonObject | null): MmPostsBundle["posts"] {
  const posts = raw?.posts;
  return posts && typeof posts === "object" && !Array.isArray(posts)
    ? (posts as MmPostsBundle["posts"])
    : {};
}

function orderFromRaw(raw: MmJsonObject | null): string[] {
  return Array.isArray(raw?.order) ? (raw.order as string[]) : [];
}
