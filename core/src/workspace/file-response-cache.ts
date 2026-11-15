import type { FileTarget } from "./fileTarget.js";

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 500;

const responseCache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

// Bumped on every invalidation/clear. An in-flight load captures the epoch at
// start and refuses to repopulate the cache if it changed — otherwise a read that
// began before a write could re-insert stale data after the write's invalidation.
let invalidationEpoch = 0;

export const FILE_LIST_CACHE_TTL_MS = 30_000;
export const FILE_CONTENT_CACHE_TTL_MS = 30_000;
export const FILE_COMMIT_CACHE_TTL_MS = 5 * 60_000;
export const FILE_INDEX_CACHE_TTL_MS = 5 * 60_000;

function evictOldest(): void {
  const oldest = responseCache.keys().next().value as string | undefined;
  if (oldest) responseCache.delete(oldest);
}

export function workspaceFileTargetCacheKey(target: FileTarget): string {
  return [
    workspaceFileRepositoryCacheKey(target),
    workspaceFileAuthorityCacheKey(target),
  ].join("|");
}

function workspaceFileAuthorityCacheKey(target: FileTarget): string {
  if (target.cacheAuthority) return `caller:${encodeURIComponent(target.cacheAuthority)}`;
  return target.workspaceMemberBrokered ? "knowledge" : "full";
}

function workspaceFileRepositoryCacheKey(target: FileTarget): string {
  return [
    target.provider,
    target.slug,
    target.projectSlug ?? "",
    target.org,
    target.repoName,
  ].join("|");
}

export function workspaceFileCacheKey(
  kind: "list" | "file" | "commit" | "index",
  target: FileTarget,
  path: string,
  ref?: string,
): string {
  return `${workspaceFileTargetCacheKey(target)}|${kind}|${path}|${ref ?? ""}`;
}

export async function cachedWorkspaceFileResponse<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  forceRefresh = false,
): Promise<T> {
  const now = Date.now();
  if (!forceRefresh) {
    const cached = responseCache.get(key) as CacheEntry<T> | undefined;
    if (cached && cached.expiresAt > now) {
      responseCache.delete(key);
      responseCache.set(key, cached); // refresh LRU recency on a hit
      return cached.value;
    }
  }

  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const startEpoch = invalidationEpoch;
  const promise = load().then((value) => {
    // Skip caching if an invalidation raced with this load — the write must win.
    if (invalidationEpoch === startEpoch) {
      if (responseCache.size >= MAX_CACHE_ENTRIES) evictOldest();
      responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
    }
    return value;
  }).finally(() => {
    // Only clear our own slot — a newer load may have replaced us after an invalidation.
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

export function invalidateWorkspaceFileResponseCache(target: FileTarget): void {
  invalidationEpoch++;
  const prefix = `${workspaceFileRepositoryCacheKey(target)}|`;
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) responseCache.delete(key);
  }
  for (const key of inflight.keys()) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
}

export function clearWorkspaceFileResponseCache(): void {
  invalidationEpoch++;
  responseCache.clear();
  inflight.clear();
}
