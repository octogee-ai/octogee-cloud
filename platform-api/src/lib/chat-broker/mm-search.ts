/**
 * `octogee_chat_search` HTTP layer — pure data; no shaping, no caching of results.
 * Spec §4.1.
 */

import { asMmJsonObject, type MmClient, type MmJsonObject } from "./mm-client.js";
import type { MmChannelMeta, MmPostsBundle, MmUserMeta } from "./shape.js";

export type SearchScope = "current_channel" | "all_visible";

/**
 * Thrown when `scope: "current_channel"` is requested but no channel name
 * can be supplied. Refusing the call is the right move — silently widening
 * to `all_visible` (the previous behavior) lied to the agent: the response
 * container still reported `scope: "current_channel"` but the search was
 * actually unscoped.
 */
export class MmSearchScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MmSearchScopeError";
  }
}

export interface SearchParams {
  query: string;
  /** Default `all_visible`. */
  scope?: SearchScope;
  /** Default 10, max 20. */
  limit?: number;
  /** Internal over-fetch used when the broker must discard unauthorized hits. */
  candidateLimit?: number;
  /** Required when `scope === "current_channel"`. Channel name (the agent's current). */
  currentChannelName?: string;
  includeDeletedChannels?: boolean;
}

export interface SearchResponse {
  bundle: MmPostsBundle;
  channels: Map<string, MmChannelMeta>;
  users: Map<string, MmUserMeta>;
  raw: { tookMs: number };
}

/**
 * POST /api/v4/teams/{team_id}/posts/search.
 *
 * Scope is enforced by appending an `in:<channel>` operator when
 * `current_channel`. MM accepts any other operator the agent passed
 * (`from:`, `before:`, `after:`) verbatim — we don't sanitize because:
 *   - The PAT scopes ACLs (boundary §2.3.7).
 *   - Stripping operators would silently mangle agent-authored queries.
 *
 * `is_or_search: false` keeps multi-token queries as AND. Spec §4.1.
 */
export async function mmSearch(
  client: MmClient,
  pat: string,
  teamId: string,
  params: SearchParams,
): Promise<SearchResponse> {
  const limit = clamp(params.limit ?? 10, 1, 20);
  const perPage = params.candidateLimit === undefined
    ? limit
    : clamp(params.candidateLimit, limit, 100);
  const scope: SearchScope = params.scope ?? "all_visible";
  let terms = params.query.trim();
  if (scope === "current_channel") {
    // Fail loud when the caller asked for current_channel scope but no
    // channel name was resolved. Falling through to an unscoped search
    // would silently violate the contract (and the response container
    // would still claim `scope: "current_channel"`).
    if (!params.currentChannelName) {
      throw new MmSearchScopeError(
        "scope=current_channel requires a resolved channel name; " +
          "caller could not derive one from the agent context " +
          "(missing deliveryContext.to or non-MM channel). " +
          "Pass an explicit `channel` argument or use scope=all_visible.",
      );
    }
    // Append only if the agent didn't already specify in:
    if (!/\bin:\S+/i.test(terms)) {
      terms = `${terms} in:${params.currentChannelName}`;
    }
  }

  const t0 = Date.now();
  const raw = await client.post(
    `/api/v4/teams/${teamId}/posts/search`,
    pat,
    {
      terms,
      is_or_search: false,
      include_deleted_channels: params.includeDeletedChannels === true,
      page: 0,
      per_page: perPage,
    },
  );
  const tookMs = Date.now() - t0;
  const rawObject = asMmJsonObject(raw);

  const bundle: MmPostsBundle = {
    posts: postsFromRaw(rawObject),
    order: orderFromRaw(rawObject),
  };

  // Spec §10 #4: MM 11.5 `/posts/search` can return posts without embedded
  // `channels`/`users` metadata. This HTTP-layer wrapper returns the raw
  // bundle only — hydration of channel + user metadata happens in the
  // caller (index.ts). The shaper drops any post whose channel can't be
  // hydrated (shape.ts:140) — so a hydration failure manifests as fewer
  // results, not corrupted ones. Test exercising this contract:
  // __tests__/mm-search.spec.ts.
  return {
    bundle,
    channels: new Map(),
    users: new Map(),
    raw: { tookMs },
  };
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
