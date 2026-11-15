/**
 * Shape Mattermost API responses into the per-post objects the Agent sees.
 *
 * Boundary rule: default-agent-authored posts are included and labeled `self: true`.
 * The label — not omission — is what keeps "evidence from the team" honest:
 * the Agent can recover its own half of a conversation (full-fidelity
 * re-prime after a restart) while seeing plainly which words are its own and
 * therefore not team evidence. Supersedes the original §2.3.8 omission rule;
 * DECISIONS.md (2026-07-17) records the reversal.
 */

export interface MmPost {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  create_at: number; // ms
  root_id?: string;
  delete_at?: number;
  type?: string;
}

/** Subset of `posts` + `order` returned by GET /channels/{id}/posts and POST /search. */
export interface MmPostsBundle {
  posts: Record<string, MmPost>;
  order: string[];
}

export interface MmChannelMeta {
  id: string;
  name: string;
  display_name: string;
  team_id?: string;
  delete_at?: number;
}

export interface MmUserMeta {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
}

export interface ShapeContext {
  /** Agent's own MM user id. Posts authored by this id are labeled `self: true`. */
  defaultAgentMmUserId: string;
  /** Public site URL for permalink construction, e.g. https://mattermost.octogee.com */
  siteUrl: string;
  /** MM team name (== user slug). Used in permalink path. */
  teamName: string;
  /** Optional preloaded channel/user lookups (search returns these inline; history needs separate fetch). */
  channels?: Map<string, MmChannelMeta>;
  users?: Map<string, MmUserMeta>;
  /** Search query — used to choose snippet anchor. Empty → snippet from start. */
  query?: string;
}

export interface DefaultAgentPost {
  post_id: string;
  channel: { name: string; display_name: string };
  author:  { username: string; display_name: string };
  /** True when the Agent itself authored this post — its own words, not team evidence. */
  self: boolean;
  created_at: string; // ISO 8601 UTC
  permalink: string;
  snippet: string;
  thread_root_id: string | null;
}

const SNIPPET_LEN = 200;
const SNIPPET_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function displayName(u: MmUserMeta | undefined): string {
  if (!u) return "(unknown)";
  if (u.nickname) return u.nickname;
  const full = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
  return full || u.username || "(unknown)";
}

function buildPermalink(siteUrl: string, teamName: string, postId: string): string {
  // Strip ONE trailing slash if present. siteUrl is operator-controlled config,
  // not user input — pathological inputs like "//" aren't a realistic concern.
  // Avoid `/\/+$/` here (eslint's sonarjs/slow-regex flags it as
  // backtracking-prone even though the anchor makes it linear).
  const base = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl;
  // MM permalink convention: <site>/<team_name>/pl/<post_id>
  return `${base}/${teamName}/pl/${postId}`;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function makeSnippet(message: string, query?: string): string {
  const text = (message ?? "").replace(/\s+/g, " ").trim();
  const characters = Array.from(SNIPPET_SEGMENTER.segment(text), ({ segment }) => segment);
  if (characters.length <= SNIPPET_LEN) return text;
  if (!query) return characters.slice(0, SNIPPET_LEN).join("") + "…";

  // Find the longest token from the query and anchor the snippet around it.
  // Strip MM search operators (from:, in:, before:, after:) before tokenizing.
  const stripped = query
    .replace(/\b(?:from|in|before|after):\S+/gi, " ")
    .toLowerCase();
  const tokens = stripped
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);

  const lower = text.toLowerCase();
  for (const tok of tokens) {
    const idx = lower.indexOf(tok);
    if (idx === -1) continue;
    const anchor = Array.from(SNIPPET_SEGMENTER.segment(lower.slice(0, idx))).length;
    const start = Math.max(0, anchor - Math.floor(SNIPPET_LEN / 3));
    const end = Math.min(characters.length, start + SNIPPET_LEN);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < characters.length ? "…" : "";
    return prefix + characters.slice(start, end).join("") + suffix;
  }
  return characters.slice(0, SNIPPET_LEN).join("") + "…";
}

export interface ShapedBundle {
  posts: DefaultAgentPost[];
  /** Total returned by MM after the drops below. */
  total: number;
}

/**
 * Order-preserving shape. Default-agent-authored posts are kept and labeled
 * `self: true`. Drops:
 *   - Soft-deleted posts (`delete_at > 0`).
 *   - System messages (`type` non-empty — joins, leaves, etc.).
 *   - Posts whose channel can't be hydrated (defensive — should not happen).
 */
export function shapeBundle(
  bundle: MmPostsBundle,
  ctx: ShapeContext,
): ShapedBundle {
  const out: DefaultAgentPost[] = [];
  for (const id of bundle.order ?? []) {
    const post = bundle.posts?.[id];
    if (!shouldShapePost(post)) continue;
    const shaped = shapePost(post, ctx);
    if (shaped) out.push(shaped);
  }
  return { posts: out, total: out.length };
}

function shouldShapePost(post: MmPost | undefined): post is MmPost {
  if (!post) return false;
  if ((post.delete_at ?? 0) > 0) return false;
  if (post.type && post.type !== "") return false;
  return true;
}

function shapePost(post: MmPost, ctx: ShapeContext): DefaultAgentPost | null {
  const channel = ctx.channels?.get(post.channel_id);
  if (!channel) return null;
  const author = ctx.users?.get(post.user_id);
  return {
    post_id: post.id,
    channel: {
      name: channel.name,
      display_name: channel.display_name,
    },
    author: {
      username: author?.username ?? "(unknown)",
      display_name: displayName(author),
    },
    self: post.user_id === ctx.defaultAgentMmUserId,
    created_at: isoFromMs(post.create_at),
    permalink: buildPermalink(ctx.siteUrl, ctx.teamName, post.id),
    snippet: makeSnippet(post.message, ctx.query),
    thread_root_id: post.root_id && post.root_id !== "" ? post.root_id : null,
  };
}
