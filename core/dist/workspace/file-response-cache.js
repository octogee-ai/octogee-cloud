const MAX_CACHE_ENTRIES = 500;
const responseCache = new Map();
const inflight = new Map();
// Bumped on every invalidation/clear. An in-flight load captures the epoch at
// start and refuses to repopulate the cache if it changed — otherwise a read that
// began before a write could re-insert stale data after the write's invalidation.
let invalidationEpoch = 0;
export const FILE_LIST_CACHE_TTL_MS = 30_000;
export const FILE_CONTENT_CACHE_TTL_MS = 30_000;
export const FILE_COMMIT_CACHE_TTL_MS = 5 * 60_000;
export const FILE_INDEX_CACHE_TTL_MS = 5 * 60_000;
function evictOldest() {
    const oldest = responseCache.keys().next().value;
    if (oldest)
        responseCache.delete(oldest);
}
export function workspaceFileTargetCacheKey(target) {
    return [
        workspaceFileRepositoryCacheKey(target),
        workspaceFileAuthorityCacheKey(target),
    ].join("|");
}
function workspaceFileAuthorityCacheKey(target) {
    if (target.cacheAuthority)
        return `caller:${encodeURIComponent(target.cacheAuthority)}`;
    return target.workspaceMemberBrokered ? "knowledge" : "full";
}
function workspaceFileRepositoryCacheKey(target) {
    return [
        target.provider,
        target.slug,
        target.projectSlug ?? "",
        target.org,
        target.repoName,
    ].join("|");
}
export function workspaceFileCacheKey(kind, target, path, ref) {
    return `${workspaceFileTargetCacheKey(target)}|${kind}|${path}|${ref ?? ""}`;
}
export async function cachedWorkspaceFileResponse(key, ttlMs, load, forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh) {
        const cached = responseCache.get(key);
        if (cached && cached.expiresAt > now) {
            responseCache.delete(key);
            responseCache.set(key, cached); // refresh LRU recency on a hit
            return cached.value;
        }
    }
    const pending = inflight.get(key);
    if (pending)
        return pending;
    const startEpoch = invalidationEpoch;
    const promise = load().then((value) => {
        // Skip caching if an invalidation raced with this load — the write must win.
        if (invalidationEpoch === startEpoch) {
            if (responseCache.size >= MAX_CACHE_ENTRIES)
                evictOldest();
            responseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
        }
        return value;
    }).finally(() => {
        // Only clear our own slot — a newer load may have replaced us after an invalidation.
        if (inflight.get(key) === promise)
            inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
}
export function invalidateWorkspaceFileResponseCache(target) {
    invalidationEpoch++;
    const prefix = `${workspaceFileRepositoryCacheKey(target)}|`;
    for (const key of responseCache.keys()) {
        if (key.startsWith(prefix))
            responseCache.delete(key);
    }
    for (const key of inflight.keys()) {
        if (key.startsWith(prefix))
            inflight.delete(key);
    }
}
export function clearWorkspaceFileResponseCache() {
    invalidationEpoch++;
    responseCache.clear();
    inflight.clear();
}
