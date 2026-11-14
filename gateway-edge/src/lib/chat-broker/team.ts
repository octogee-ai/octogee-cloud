/**
 * Workspace slug → MM team_id and channel name → channel_id resolvers.
 *
 * Mattermost's team-per-workspace pattern means the team name == user
 * slug (core/src/mattermost/provision.ts). Channel name → id is a
 * separate per-team lookup. Both are cached with the same TTL as the PAT
 * cache to keep cross-call drift bounded.
 *
 * Cache scope (spec §10 #7): per-workspace 5-min TTL. Renames within the
 * window will resolve to a stale id — acceptable for v1; revisit only if
 * a rename actually surfaces a Agent error.
 */

interface TtlEntry<T> {
  value: T;
  expiresAtMs: number;
}

const teamCache = new Map<string, TtlEntry<string>>();
const channelCache = new Map<string, TtlEntry<string>>();

export interface MmFetcher {
  /** GET /api/v4/<path>; returns parsed JSON or throws on non-2xx. */
  get: (path: string, pat: string) => Promise<unknown>;
}

export class MmResolveError extends Error {
  constructor(
    public readonly code: "team-not-found" | "channel-not-found" | "fetch-failed",
    message: string,
  ) {
    super(message);
    this.name = "MmResolveError";
  }
}

export async function resolveTeamId(
  fetcher: MmFetcher,
  pat: string,
  slug: string,
  opts: { ttlSeconds: number; now?: () => number },
): Promise<string> {
  const now = (opts.now ?? Date.now)();
  const hit = teamCache.get(slug);
  if (hit && hit.expiresAtMs > now) return hit.value;

  let team: unknown;
  try {
    team = await fetcher.get(`/api/v4/teams/name/${encodeURIComponent(slug)}`, pat);
  } catch (err) {
    throw new MmResolveError(
      "fetch-failed",
      `teams/name/${slug} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const id = (team as { id?: unknown })?.id;
  if (typeof id !== "string" || !id) {
    throw new MmResolveError("team-not-found", `no team named ${slug}`);
  }
  teamCache.set(slug, { value: id, expiresAtMs: now + opts.ttlSeconds * 1000 });
  return id;
}

export async function resolveChannelId(
  fetcher: MmFetcher,
  pat: string,
  teamId: string,
  channelName: string,
  opts: {
    ttlSeconds: number;
    now?: () => number;
    includeDeleted?: boolean;
  },
): Promise<string> {
  // Pass-through: if the caller already has an id, don't burn an MM call.
  // MM channel ids are 26-char lowercase alphanum. Names use the URL slug
  // pattern (lowercase, dashes) so the two never collide.
  if (/^[a-z0-9]{26}$/.test(channelName)) return channelName;

  const now = (opts.now ?? Date.now)();
  const key = `${teamId}/${channelName}/${opts.includeDeleted === true ? "with-deleted" : "active"}`;
  const hit = channelCache.get(key);
  if (hit && hit.expiresAtMs > now) return hit.value;

  let ch: unknown;
  try {
    ch = await fetcher.get(
      `/api/v4/teams/${teamId}/channels/name/${encodeURIComponent(channelName)}${
        opts.includeDeleted === true ? "?include_deleted=true" : ""
      }`,
      pat,
    );
  } catch (err) {
    throw new MmResolveError(
      "fetch-failed",
      `channels/name/${channelName} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const id = (ch as { id?: unknown })?.id;
  if (typeof id !== "string" || !id) {
    throw new MmResolveError(
      "channel-not-found",
      `no channel named ${channelName} in team ${teamId}`,
    );
  }
  channelCache.set(key, { value: id, expiresAtMs: now + opts.ttlSeconds * 1000 });
  return id;
}

/** Test helper. */
export function _resetTeamCachesForTests(): void {
  teamCache.clear();
  channelCache.clear();
}
