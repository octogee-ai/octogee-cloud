import { readGatewayAuthorizationInStore, } from "../gateway-live-release.js";
import { normalizeModelBrokerTokenLimits, normalizeModelBrokerTokenPolicy, } from "./tokens.js";
function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function parseOptionalLimitNumber(raw) {
    if (raw === undefined || raw === "")
        return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
}
export function envDefaultModelBrokerLimits(env = process.env) {
    return {
        spendWindowUsd: parseOptionalLimitNumber(env.MODEL_BROKER_SPEND_WINDOW_USD),
        spendWeekUsd: parseOptionalLimitNumber(env.MODEL_BROKER_SPEND_WEEK_USD),
        requestsPerMinute: parseOptionalLimitNumber(env.MODEL_BROKER_REQUESTS_PER_MINUTE),
    };
}
async function readOwnerProfile(accounts, ownerUid, now, rails) {
    if (!ownerUid)
        return null;
    const account = await accounts.get(ownerUid);
    if (!account)
        return null;
    return rails.resolveOwnerProfile({ ...account.planInputs }, ownerUid, now);
}
async function readGatewayLimitOverrides(state, gatewayId, authorization) {
    const resolved = authorization ?? await readGatewayAuthorizationInStore(state, gatewayId);
    if (!resolved) {
        throw new Error(`durable root config unavailable for gateways/${gatewayId}`);
    }
    const raw = resolved.config.modelBrokerLimits ?? {};
    const spendWindowUsd = finiteNumber(raw.spendWindowUsd);
    const spendWeekUsd = finiteNumber(raw.spendWeekUsd);
    const requestsPerMinute = finiteNumber(raw.requestsPerMinute);
    return {
        ...(spendWindowUsd === null ? {} : { spendWindowUsd }),
        ...(spendWeekUsd === null ? {} : { spendWeekUsd }),
        ...(requestsPerMinute === null ? {} : { requestsPerMinute }),
    };
}
export async function resolveOwnerModelBrokerGrant(input) {
    const tier = await readOwnerProfile(input.accounts, input.ownerUid, input.now, input.rails);
    const overrides = await readGatewayLimitOverrides(input.state, input.gatewayId, input.gatewayAuthorization);
    const rail = tier?.rail ?? input.rails.defaultRailId;
    const limits = normalizeModelBrokerTokenLimits({
        ...(input.defaults ?? {}),
        ...(tier === null || !tier.windowBudgets
            ? {}
            : { spendWindowUsd: tier.spendWindowUsd, spendWeekUsd: tier.spendWeekUsd }),
        ...overrides,
    });
    const policy = normalizeModelBrokerTokenPolicy({
        freeTier: tier?.freeTier === true,
        houseFallback: tier?.houseFallback !== false,
    });
    return { limits, policy, rail, fundedBudget: tier?.fundedBudget ?? null };
}
const DEFAULT_GRANT_CACHE_TTL_MS = 60_000;
const DEFAULT_GRANT_CACHE_MAX_ENTRIES = 10_000;
function cachedGrantIsFresh(entry, now, ttlMs) {
    if (now - entry.resolvedAt >= ttlMs)
        return false;
    const budget = entry.grant.fundedBudget;
    if (!budget)
        return true;
    if (now >= budget.expiresAtMs)
        return false;
    return budget.nextCapIncreaseAtMs === null || now < budget.nextCapIncreaseAtMs;
}
function mutableLimitFingerprint(authorization) {
    const limits = authorization.config.modelBrokerLimits;
    return [
        authorization.gateway.updatedAt,
        authorization.config.configSchemaVersion,
        limits?.spendWindowUsd ?? null,
        limits?.spendWeekUsd ?? null,
        limits?.requestsPerMinute ?? null,
    ].join(":");
}
export function createCachedOwnerModelBrokerGrantResolver(opts) {
    const ttlMs = opts.ttlMs ?? DEFAULT_GRANT_CACHE_TTL_MS;
    const maxEntries = opts.maxEntries ?? DEFAULT_GRANT_CACHE_MAX_ENTRIES;
    const cache = new Map();
    const sweepExpired = (now) => {
        if (cache.size < maxEntries)
            return;
        let evicted = 0;
        for (const [key, entry] of cache) {
            if (now - entry.resolvedAt >= ttlMs) {
                cache.delete(key);
                evicted += 1;
            }
        }
        // Everything still live at the cap: drop the oldest insertions rather
        // than grow unbounded — they re-resolve on their next call.
        while (cache.size >= maxEntries) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined)
                break;
            cache.delete(oldest);
            evicted += 1;
        }
        opts.log?.("llm-broker grant cache swept", { evicted, remaining: cache.size });
    };
    return async ({ gatewayId, ownerUid, now }) => {
        const authorization = await readGatewayAuthorizationInStore(opts.state, gatewayId);
        if (!authorization) {
            throw new Error(`durable root config unavailable for gateways/${gatewayId}`);
        }
        const key = `${gatewayId}:${mutableLimitFingerprint(authorization)}:${ownerUid ?? ""}`;
        const cached = cache.get(key);
        if (cached && cachedGrantIsFresh(cached, now, ttlMs))
            return cached.grant;
        if (cached)
            cache.delete(key);
        sweepExpired(now);
        const grant = await resolveOwnerModelBrokerGrant({
            state: opts.state,
            accounts: opts.accounts,
            gatewayId,
            ownerUid: ownerUid ?? undefined,
            now,
            defaults: opts.defaults,
            gatewayAuthorization: authorization,
            rails: opts.rails,
        });
        cache.set(key, { grant, resolvedAt: now });
        opts.log?.("llm-broker grant resolved", {
            gatewayId,
            ownerUid,
            spendWindowUsd: grant.limits.spendWindowUsd,
            spendWeekUsd: grant.limits.spendWeekUsd,
            requestsPerMinute: grant.limits.requestsPerMinute,
            freeTier: grant.policy.freeTier,
            rail: grant.rail,
            ...grant.fundedBudget?.logFields,
        });
        return grant;
    };
}
