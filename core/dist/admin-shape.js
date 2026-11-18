import { userEntitlements } from "@octogee/shared/types/user-entitlements";
export function toISODate(val) {
    if (!val)
        return null;
    if (typeof val.toDate === "function") {
        return val.toDate().toISOString();
    }
    if (val instanceof Date)
        return val.toISOString();
    return null;
}
function numberAt(src, key, fallback = 0) {
    const value = src[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function isoMillis(value) {
    return value === null ? null : new Date(value).toISOString();
}
function displayNameFor(account) {
    return account.displayName || account.username || (account.email ?? "").split("@")[0] || "(unknown)";
}
function userSummaryFields(user) {
    return {
        mattermostConnected: (user.mattermostUserId ?? "").length > 0,
        agentCount: user.agents.agentIds.length,
        createdAt: isoMillis(user.createdAt),
        provisioningStatus: user.openclaw.status ?? user.provisioning.status ?? null,
        accountLifecycleStatus: user.accountLifecycle?.status ?? "active",
    };
}
function lastActiveAt(rollup, usage) {
    const brokerMs = numberAt(rollup ?? {}, "updatedAt", Number.NaN);
    const legacy = toISODate(usage.lastUpdated);
    const legacyMs = legacy === null ? Number.NaN : Date.parse(legacy);
    const latest = Math.max(...[brokerMs, legacyMs].filter((value) => Number.isFinite(value)));
    return Number.isFinite(latest) ? new Date(latest).toISOString() : null;
}
export function buildUserSummary(user, account, ownerCredentialActive, broker) {
    const rollup = broker.rollup ?? {};
    const costUsd = numberAt(rollup, "costUsd");
    return {
        ...userEntitlements().productProjection?.adminUserSummary(account.planInputs, {
            costUsd,
            now: new Date(broker.now),
        }),
        uid: user.uid,
        displayName: displayNameFor(account),
        email: account.email ?? "",
        username: account.username ?? "",
        byotActive: ownerCredentialActive,
        spend: broker.spend,
        brokerTotalTokens: numberAt(rollup, "totalTokens"),
        requestCount: numberAt(rollup, "requestCount"),
        costUsd,
        lastActive: lastActiveAt(broker.rollup, account.usage),
        mattermostUsername: account.mattermostUsername,
        ...userSummaryFields(user),
    };
}
