/**
 * Server-side executors for `octogee_chat_search` / `octogee_chat_history`.
 *
 * Relocated from the octogee-chat-tools OpenClaw extension: the agent runtime is
 * injection-reachable, so no PAT broader than the agent's own posting identity may
 * live there (the bots' posting tokens necessarily remain in openclaw.json — that
 * surface is unchanged; the user's PAT is what must never reach the pod). The
 * gateway skill is a thin client; PAT resolution and every MM read happen here,
 * behind the fleet broker's gateway-identity auth. The PAT is the capability boundary — the workspace agent
 * reads with the user's PAT (the human it acts for), a project agent reads with
 * its project bot's PAT (member of that project's channels only).
 */

import { asMmJsonObject, createMmClient, MmFetchError, type MmClient, type MmJsonObject } from "./mm-client.js";
import { mmSearch, MmSearchScopeError } from "./mm-search.js";
import { mmHistory, HistoryParamError, type Direction } from "./mm-history.js";
import { resolveTeamId, resolveChannelId, MmResolveError } from "./team.js";
import {
  shapeBundle,
  type MmChannelMeta,
  type MmPostsBundle,
  type MmUserMeta,
} from "./shape.js";

const RESOLVE_TTL_SECONDS = 300;
const MM_CHANNEL_ID_RE = /^[a-z0-9]{26}$/;

export function mmBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.MM_URL ||
    `http://mattermost.${env.K8S_NAMESPACE || "octogee"}.svc.cluster.local:8065`
  );
}

export interface ChatBrokerIdentity {
  /** PAT the MM reads run under — the capability boundary. */
  pat: string;
  /** The agent's own MM user id; its posts are labeled `self: true` in results. */
  defaultAgentMmUserId: string;
  /** The agent bot's own credential, used ONLY for the `unread` direction (MM serves a
   *  user's unread state only to that user; the user PAT would 403 or clobber the
   *  human's read marker). */
  unread: { pat: string; mmUserId: string };
  /** Workspace slug == MM team name. */
  slug: string;
  /** Public chat URL for permalink construction. */
  siteUrl: string;
  canReadChannel?: (channelId: string) => Promise<boolean>;
  includeArchivedProjectHistory?: true;
}

export class ChatChannelAccessError extends Error {
  readonly code = "channel-forbidden";

  constructor() {
    super("channel is outside the agent's canonical chat scope");
    this.name = "ChatChannelAccessError";
  }
}

export interface ChatSearchParams {
  query: string;
  scope?: "current_channel" | "all_visible";
  limit?: number;
  /** The agent's current MM channel id (deliveryContext), if any. */
  currentChannelId?: string;
}

export interface ChatHistoryParams {
  channel?: string;
  /** Validated here — an unknown value is a loud HistoryParamError, never a default. */
  direction?: string;
  cursor?: string;
  limit?: number;
  fromUsername?: string;
  currentChannelId?: string;
}

const DIRECTIONS: ReadonlySet<string> = new Set([
  "latest",
  "before",
  "after",
  "unread",
  "around",
]);

function validDirection(value: string | undefined): Direction {
  if (value === undefined) return "latest";
  if (!DIRECTIONS.has(value)) {
    throw new HistoryParamError("invalid-direction", `unknown direction: ${value}`);
  }
  return value as Direction;
}

export async function executeChatSearch(
  identity: ChatBrokerIdentity,
  params: ChatSearchParams,
  mm: MmClient = createMmClient(mmBaseUrl()),
): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const query = params.query.trim();
  const scope = params.scope === "current_channel" ? "current_channel" : "all_visible";
  const limit = clamp(params.limit ?? 10, 1, 20);
  const { pat, slug } = identity;

  const teamId = await resolveTeamId({ get: mm.get }, pat, slug, { ttlSeconds: RESOLVE_TTL_SECONDS });
  const currentChannelName =
    scope === "current_channel"
      ? await maybeResolveCurrentChannelName(
          mm,
          pat,
          params.currentChannelId,
          identity.canReadChannel,
        )
      : undefined;

  const result = await mmSearch(mm, pat, teamId, {
    query,
    scope,
    limit,
    ...(identity.canReadChannel && scope === "all_visible"
      ? { candidateLimit: 100 }
      : {}),
    currentChannelName,
    includeDeletedChannels: identity.includeArchivedProjectHistory === true,
  });

  const bundle = await readableBundle(
    result.bundle,
    identity.canReadChannel,
    limit,
  );
  const { channels, users } = await hydrate(mm, pat, bundle);

  const shaped = shapeBundle(bundle, {
    defaultAgentMmUserId: identity.defaultAgentMmUserId,
    siteUrl: identity.siteUrl,
    teamName: slug,
    channels,
    users,
    query,
  });

  return {
    results: shaped.posts,
    query_echo: query,
    scope,
    total_returned: shaped.posts.length,
    took_ms: Date.now() - t0,
  };
}

export async function executeChatHistory(
  identity: ChatBrokerIdentity,
  params: ChatHistoryParams,
  mm: MmClient = createMmClient(mmBaseUrl()),
): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const direction = validDirection(params.direction);
  const limit = clamp(params.limit ?? 25, 1, 50);
  const { pat, slug } = identity;
  const fromUsername = normalizedUsername(params.fromUsername);

  const teamId = await resolveTeamId({ get: mm.get }, pat, slug, { ttlSeconds: RESOLVE_TTL_SECONDS });

  const channelName = params.channel ?? params.currentChannelId;
  if (!channelName) {
    throw new HistoryParamError(
      "missing-channel",
      "no channel argument and no current-channel context — pass an explicit `channel` parameter",
    );
  }
  const channelId = await resolveChannelId({ get: mm.get }, pat, teamId, channelName, {
    ttlSeconds: RESOLVE_TTL_SECONDS,
    includeDeleted: identity.includeArchivedProjectHistory === true,
  });
  await assertChannelReadable(channelId, identity.canReadChannel);

  const channelMeta = await fetchChannelMeta(mm, pat, channelId);
  assertArchivedHistoryReadable(channelMeta, identity);
  const userIndex = await historyUserIndex(mm, pat, fromUsername);

  // `unread` is the agent bot's own read cursor — that one direction runs under the
  // bot's PAT (see ChatBrokerIdentity.unread); every other read stays on the lane PAT.
  const historyPat = direction === "unread" ? identity.unread.pat : pat;
  const result = await mmHistory(mm, historyPat, {
    channelId,
    defaultAgentMmUserId: identity.unread.mmUserId,
    direction,
    cursor: params.cursor,
    limit,
    fromUsername,
    userIndex,
  });

  const channels = new Map<string, MmChannelMeta>();
  if (channelMeta) channels.set(channelId, channelMeta);
  const users = await hydrateUsersForBundle(mm, pat, result.bundle);

  const shaped = shapeBundle(result.bundle, {
    defaultAgentMmUserId: identity.defaultAgentMmUserId,
    siteUrl: identity.siteUrl,
    teamName: slug,
    channels,
    users,
  });

  return {
    messages: shaped.posts,
    channel_echo: channelMeta
      ? { name: channelMeta.name, display_name: channelMeta.display_name }
      : { name: channelName, display_name: channelName },
    direction,
    next_cursor: result.nextCursor,
    prev_cursor: result.prevCursor,
    has_more: result.hasMore,
    took_ms: Date.now() - t0,
  };
}

function normalizedUsername(value: string | undefined): string | undefined {
  return value?.startsWith("@") ? value.slice(1) : value;
}

function assertArchivedHistoryReadable(
  channelMeta: MmChannelMeta | undefined,
  identity: ChatBrokerIdentity,
): void {
  const archived = typeof channelMeta?.delete_at === "number" && channelMeta.delete_at > 0;
  if (!archived || identity.includeArchivedProjectHistory === true) return;
  throw new HistoryParamError(
    "archived-channel",
    "archived project history is unavailable to this identity",
  );
}

async function historyUserIndex(
  mm: MmClient,
  pat: string,
  fromUsername: string | undefined,
): Promise<Map<string, string> | undefined> {
  if (!fromUsername) return undefined;
  const user = await fetchUserByUsername(mm, pat, fromUsername);
  const index = new Map<string, string>();
  if (user) index.set(fromUsername, user.id);
  return index;
}

/**
 * Bucket MM HTTP statuses to a bounded set (401 PAT bad, 403 ACL deny, 404
 * missing, 429 rate limited; 5xx → mm-server-error; rest → mm-error) so the
 * error `code` the agent sees stays low-cardinality.
 */
function bucketMmStatus(status: number): string {
  if (status === 401) return "mm-unauthorized";
  if (status === 403) return "mm-forbidden";
  if (status === 404) return "mm-not-found";
  if (status === 429) return "mm-rate-limited";
  if (status >= 500 && status < 600) return "mm-server-error";
  return "mm-error";
}

/** Map a chat-broker error to the {status, code} pair the route returns. */
export function chatBrokerErrorStatus(err: unknown): { status: number; code: string } {
  if (err instanceof ChatChannelAccessError) {
    return { status: 403, code: err.code };
  }
  if (err instanceof MmResolveError) return { status: 502, code: `resolve-${err.code}` };
  if (err instanceof MmFetchError) return { status: 502, code: bucketMmStatus(err.status) };
  if (err instanceof MmSearchScopeError) return { status: 400, code: "scope-no-channel" };
  if (err instanceof HistoryParamError) return { status: 400, code: `param-${err.code}` };
  return { status: 502, code: "error" };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

async function maybeResolveCurrentChannelName(
  mm: MmClient,
  pat: string,
  channelId: string | undefined,
  canReadChannel: ChatBrokerIdentity["canReadChannel"],
): Promise<string | undefined> {
  if (!channelId || !MM_CHANNEL_ID_RE.test(channelId)) return undefined;
  await assertChannelReadable(channelId, canReadChannel);
  try {
    const ch = asMmJsonObject(await mm.get(`/api/v4/channels/${channelId}`, pat));
    return stringField(ch, "name");
  } catch {
    return undefined;
  }
}

async function assertChannelReadable(
  channelId: string,
  canReadChannel: ChatBrokerIdentity["canReadChannel"],
): Promise<void> {
  if (canReadChannel && !(await canReadChannel(channelId))) {
    throw new ChatChannelAccessError();
  }
}

async function readableBundle(
  bundle: MmPostsBundle,
  canReadChannel: ChatBrokerIdentity["canReadChannel"],
  limit: number,
): Promise<MmPostsBundle> {
  if (!canReadChannel) return {
    posts: bundle.posts,
    order: bundle.order.slice(0, limit),
  };
  const channelIds = [...new Set(
    bundle.order
      .map((postId) => bundle.posts[postId]?.channel_id)
      .filter((channelId): channelId is string => Boolean(channelId)),
  )];
  const decisions = await Promise.all(
    channelIds.map(async (channelId) => [
      channelId,
      await canReadChannel(channelId),
    ] as const),
  );
  const readable = new Set(
    decisions
      .filter(([, allowed]) => allowed)
      .map(([channelId]) => channelId),
  );
  const order = bundle.order
    .filter((postId) => readable.has(bundle.posts[postId]?.channel_id))
    .slice(0, limit);
  return {
    posts: Object.fromEntries(
      order.map((postId) => [postId, bundle.posts[postId]]),
    ),
    order,
  };
}

async function fetchChannelMeta(
  mm: MmClient,
  pat: string,
  channelId: string,
): Promise<MmChannelMeta | undefined> {
  try {
    const ch = asMmJsonObject(await mm.get(`/api/v4/channels/${channelId}`, pat));
    const id = stringField(ch, "id");
    if (!id) return undefined;
    const name = stringField(ch, "name") ?? "";
    return {
      id,
      name,
      display_name: stringField(ch, "display_name") ?? name,
      team_id: stringField(ch, "team_id"),
      delete_at:
        typeof ch?.delete_at === "number" ? ch.delete_at : undefined,
    };
  } catch {
    return undefined;
  }
}

async function fetchUserByUsername(
  mm: MmClient,
  pat: string,
  username: string,
): Promise<MmUserMeta | undefined> {
  try {
    const u = asMmJsonObject(
      await mm.get(`/api/v4/users/username/${encodeURIComponent(username)}`, pat),
    );
    const id = stringField(u, "id");
    if (!id) return undefined;
    return {
      id,
      username: stringField(u, "username") ?? username,
      first_name: stringField(u, "first_name"),
      last_name: stringField(u, "last_name"),
      nickname: stringField(u, "nickname"),
    };
  } catch {
    return undefined;
  }
}

/** Fetch unique channels + users referenced in a bundle. */
async function hydrate(
  mm: MmClient,
  pat: string,
  bundle: { posts: Record<string, { channel_id: string; user_id: string }>; order: string[] },
): Promise<{ channels: Map<string, MmChannelMeta>; users: Map<string, MmUserMeta> }> {
  const channelIds = new Set<string>();
  const userIds = new Set<string>();
  for (const id of bundle.order) {
    const p = bundle.posts[id];
    if (!p) continue;
    if (p.channel_id) channelIds.add(p.channel_id);
    if (p.user_id) userIds.add(p.user_id);
  }
  const channels = new Map<string, MmChannelMeta>();
  for (const cid of channelIds) {
    const meta = await fetchChannelMeta(mm, pat, cid);
    if (meta) channels.set(cid, meta);
  }
  const users = await batchUsers(mm, pat, userIds);
  return { channels, users };
}

async function hydrateUsersForBundle(
  mm: MmClient,
  pat: string,
  bundle: { posts: Record<string, { user_id: string }>; order: string[] },
): Promise<Map<string, MmUserMeta>> {
  const userIds = new Set<string>();
  for (const id of bundle.order) {
    const p = bundle.posts[id];
    if (p?.user_id) userIds.add(p.user_id);
  }
  return batchUsers(mm, pat, userIds);
}

async function batchUsers(
  mm: MmClient,
  pat: string,
  userIds: Set<string>,
): Promise<Map<string, MmUserMeta>> {
  const out = new Map<string, MmUserMeta>();
  if (userIds.size === 0) return out;
  try {
    // POST /api/v4/users/ids with array body returns up to 100 users in one shot.
    const arr = await mm.post("/api/v4/users/ids", pat, [...userIds]);
    if (Array.isArray(arr)) {
      for (const u of arr) {
        const user = asMmJsonObject(u);
        const id = stringField(user, "id");
        if (id) {
          out.set(id, {
            id,
            username: stringField(user, "username") ?? "",
            first_name: stringField(user, "first_name"),
            last_name: stringField(user, "last_name"),
            nickname: stringField(user, "nickname"),
          });
        }
      }
    }
  } catch {
    // Fall through — shape.ts treats missing user as "(unknown)".
  }
  return out;
}

function stringField(source: MmJsonObject | null, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" ? value : undefined;
}
