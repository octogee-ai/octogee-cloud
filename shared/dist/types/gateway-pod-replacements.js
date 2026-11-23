const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const POD_REPLACEMENT_RECENT_WINDOW_MS = 7 * DAY_MS;
export const POD_REPLACEMENT_WARNING_THRESHOLD_24H = 3;
export const POD_REPLACEMENT_MAX_RETAINED = 64;
export const GATEWAY_POD_REPLACEMENT_SCHEMA = "octogee.gateway-pod-replacement.v1";
export const EMPTY_GATEWAY_POD_REPLACEMENTS = {
    recentAt: [],
    lastAt: null,
    lastVacatedPodUid: null,
    lastVacatedNodeName: null,
    lastVacatedInstanceId: null,
    lastVacatedNodePool: null,
    total: 0,
};
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isEpochMs(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isNullableString(value) {
    return value === null || typeof value === "string";
}
export function isGatewayPodPlacement(value) {
    if (!isRecord(value))
        return false;
    return (typeof value.uid === "string" &&
        value.uid.length > 0 &&
        typeof value.name === "string" &&
        isNullableString(value.replicaSetUid) &&
        isNullableString(value.nodeName) &&
        (value.providerId === undefined || typeof value.providerId === "string") &&
        isNullableString(value.instanceId) &&
        isNullableString(value.nodePool));
}
export function isGatewayPodReplacements(value) {
    if (!isRecord(value))
        return false;
    return (Array.isArray(value.recentAt) &&
        value.recentAt.every(isEpochMs) &&
        (value.lastAt === null || isEpochMs(value.lastAt)) &&
        isNullableString(value.lastVacatedPodUid) &&
        isNullableString(value.lastVacatedNodeName) &&
        isNullableString(value.lastVacatedInstanceId) &&
        isNullableString(value.lastVacatedNodePool) &&
        typeof value.total === "number" &&
        Number.isSafeInteger(value.total) &&
        value.total >= 0);
}
// A loss stamped ahead of `now` cannot be counted against a window that ends at
// `now`; clock skew must not inflate the indicator.
function countWithin(recentAt, now, windowMs) {
    return recentAt.filter((at) => at <= now && now - at < windowMs).length;
}
export function summarizeGatewayPodReplacements(value, now) {
    if (!value) {
        return {
            count24h: 0,
            count7d: 0,
            lastAgeMs: null,
            lastVacatedNodeName: null,
            lastVacatedInstanceId: null,
            lastVacatedNodePool: null,
            total: 0,
            warn: false,
        };
    }
    const count24h = countWithin(value.recentAt, now, DAY_MS);
    return {
        count24h,
        count7d: countWithin(value.recentAt, now, POD_REPLACEMENT_RECENT_WINDOW_MS),
        lastAgeMs: value.lastAt === null ? null : Math.max(0, now - value.lastAt),
        lastVacatedNodeName: value.lastVacatedNodeName,
        lastVacatedInstanceId: value.lastVacatedInstanceId,
        lastVacatedNodePool: value.lastVacatedNodePool,
        total: value.total,
        warn: count24h >= POD_REPLACEMENT_WARNING_THRESHOLD_24H,
    };
}
// Only entries older than the window are dropped. An entry stamped ahead of
// `now` is excluded from the counts, not deleted — a reconcile pass that ran on
// an older clock must not erase a loss a newer pass already recorded.
export function pruneGatewayPodReplacementWindow(recentAt, now) {
    return recentAt.filter((at) => now - at < POD_REPLACEMENT_RECENT_WINDOW_MS);
}
