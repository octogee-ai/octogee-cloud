import { buildUserSummary, isoMillis, toISODate, } from "./admin-shape.js";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { isUserParkedVm } from "@octogee/shared/types/glm";
import { placementReceiptDocId } from "@octogee/shared/types/placement-receipts";
import { userAccountFromData, } from "./user-account.js";
import { MissingRecordError } from "./platform-state/errors.js";
import { BROKER_USAGE_SERIES_READ_LIMIT, brokerUsageSeries } from "./broker-usage-series.js";
import { usageWindowStartMs, weekWindowStartMs } from "@octogee/shared/types/model-broker-usage";
import { anonymousOperationalEnvironment, anonymousOperationalGatewayClass, isAnonymousOperationalModelDimension, } from "@octogee/shared/types/account-lifecycle";
function financeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function operationalNumber(value) {
    return Math.max(0, financeNumber(value));
}
function archiveMonth(value) {
    return typeof value === "string" && /^\d{4}-\d{2}$/.test(value) ? value : null;
}
function projectAnonymousArchive(id, data) {
    const rawTotals = data.totals && typeof data.totals === "object" && !Array.isArray(data.totals)
        ? data.totals
        : {};
    const models = Array.isArray(data.models)
        ? data.models.flatMap((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
                return [];
            const model = raw;
            if (!isAnonymousOperationalModelDimension(model.provider, model.model))
                return [];
            return [{
                    provider: model.provider,
                    model: model.model,
                    costUsd: operationalNumber(model.costUsd),
                    totalTokens: operationalNumber(model.totalTokens),
                    requestCount: operationalNumber(model.requestCount),
                }];
        })
        : [];
    return {
        id,
        schemaVersion: data.schemaVersion === 1 ? 1 : 0,
        archivedAt: operationalNumber(data.archivedAt),
        accountCreatedMonth: archiveMonth(data.accountCreatedMonth),
        deletionRequestedMonth: archiveMonth(data.deletionRequestedMonth),
        environment: anonymousOperationalEnvironment(data.environment),
        ...userEntitlements().productProjection?.adminUserArchive(data),
        gatewayClass: anonymousOperationalGatewayClass(data.gatewayClass),
        totals: {
            costUsd: operationalNumber(rawTotals.costUsd),
            totalTokens: operationalNumber(rawTotals.totalTokens),
            requestCount: operationalNumber(rawTotals.requestCount),
        },
        models,
        cleanupOutcomeCodes: Array.isArray(data.cleanupOutcomeCodes)
            ? data.cleanupOutcomeCodes.filter((value) => value === "verified_erasure")
            : [],
    };
}
export const noAdminUserDirectorySource = {
    brokerLedgers: async () => new Map(),
    brokerWindows: async () => [],
    brokerEvents: async () => [],
    brokerEventCosts: async () => [],
    brokerRollup: async () => undefined,
    totalUsers: async () => null,
    usageLogs: async () => [],
    workspaces: async () => [],
    workspaceModelUsage: async () => [],
    adminActions: async () => [],
};
// Admin USD figures come exclusively from the broker ledger: the current 4h
// window + week ledger + the all-time rollup per user.
async function readBrokerUserUsage(source, uids, now) {
    const usage = new Map();
    if (uids.length === 0)
        return usage;
    const ledgers = await source.brokerLedgers(uids, usageWindowStartMs(now), weekWindowStartMs(now));
    uids.forEach((uid) => {
        const ledger = ledgers.get(uid);
        const windowData = ledger?.window ?? {};
        const weekData = ledger?.week ?? {};
        const rollupData = ledger?.rollup ?? {};
        usage.set(uid, {
            windowCostUsd: financeNumber(windowData.chargeUsd ?? windowData.costUsd),
            weekCostUsd: financeNumber(weekData.chargeUsd ?? weekData.costUsd),
            totalCostUsd: financeNumber(rollupData.costUsd),
            totalTokens: financeNumber(rollupData.totalTokens),
            now,
        });
    });
    return usage;
}
// One admin detail view reads at most this many event docs (30d of history).
// ~20K calls/month/user is far past current scale; when a user crosses
// it the history truncates loudly (warn log) instead of reading unbounded —
// the fix at that scale is day-rollup docs, not a bigger limit.
const BROKER_DAILY_USAGE_EVENT_LIMIT = 20_000;
// Per-UTC-day broker cost series for the admin usage history — replaces the
// legacy usage_logs costUsd (openclaw-reported $0).
async function readBrokerDailyUsage(source, uid, sinceMs, logger) {
    const events = await source.brokerEvents(uid, sinceMs, BROKER_DAILY_USAGE_EVENT_LIMIT);
    if (events.length >= BROKER_DAILY_USAGE_EVENT_LIMIT) {
        logger?.warn("admin daily usage truncated at the broker event limit", {
            uid,
            limit: BROKER_DAILY_USAGE_EVENT_LIMIT,
        });
    }
    const days = new Map();
    for (const data of events) {
        const createdAt = financeNumber(data.createdAt);
        if (!createdAt)
            continue;
        const date = new Date(createdAt).toISOString().slice(0, 10);
        const day = days.get(date) ?? { date, costUsd: 0, totalTokens: 0, requestCount: 0 };
        day.costUsd += financeNumber(data.costUsd);
        day.totalTokens += financeNumber(data.totalTokens);
        day.requestCount += 1;
        days.set(date, day);
    }
    return days;
}
// The "where did my window go" projection: cold turns show up as cache-write
// spikes, blue/green flips as token-name changes, model switches per day.
export function aggregateBrokerDiagnostics(events, recentLimit = 25) {
    const dayMap = new Map();
    const decomposition = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const sorted = [...events].sort((a, b) => financeNumber(b.createdAt) - financeNumber(a.createdAt));
    for (const data of sorted) {
        const createdAt = financeNumber(data.createdAt);
        if (!createdAt)
            continue;
        const model = typeof data.model === "string" ? data.model : "unknown";
        const date = new Date(createdAt).toISOString().slice(0, 10);
        const key = `${date}|${model}`;
        const breakdown = (data.costBreakdown ?? {});
        const day = dayMap.get(key) ?? {
            date,
            model,
            totalTokens: 0,
            requestCount: 0,
            costUsd: 0,
            cacheWriteUsd: 0,
        };
        day.totalTokens += financeNumber(data.totalTokens);
        day.requestCount += 1;
        day.costUsd += financeNumber(data.costUsd);
        day.cacheWriteUsd += financeNumber(breakdown.cacheWrite);
        dayMap.set(key, day);
        decomposition.input += financeNumber(breakdown.input);
        decomposition.output += financeNumber(breakdown.output);
        decomposition.cacheRead += financeNumber(breakdown.cacheRead);
        decomposition.cacheWrite += financeNumber(breakdown.cacheWrite);
    }
    const recentCalls = sorted.slice(0, recentLimit).map((data) => {
        const usage = (data.usage ?? {});
        return {
            at: financeNumber(data.createdAt),
            model: typeof data.model === "string" ? data.model : "unknown",
            inputTokens: financeNumber(usage.inputTokens),
            outputTokens: financeNumber(usage.outputTokens),
            cacheWriteTokens: financeNumber(usage.cacheCreationInputTokens),
            cacheReadTokens: financeNumber(usage.cacheReadInputTokens),
            costUsd: financeNumber(data.costUsd),
            degraded: data.degraded === true,
            brokerTokenSecretName: typeof data.brokerTokenSecretName === "string" ? data.brokerTokenSecretName : null,
        };
    });
    return {
        days: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
        decomposition,
        recentCalls,
    };
}
// Tokens/interactions come from the legacy tailer docs (they see byosub
// traffic the broker never does); costUsd comes only from the broker series.
// Broker-only days (e.g. logs write failed) still surface with their real cost.
export function mergeDailyUsage(legacyLogs, brokerDaily) {
    const merged = new Map();
    for (const log of legacyLogs) {
        const date = typeof log.date === "string" ? log.date : null;
        if (!date)
            continue;
        merged.set(date, {
            ...log,
            costUsd: brokerDaily.get(date)?.costUsd ?? 0,
            brokerTokens: brokerDaily.get(date)?.totalTokens ?? 0,
        });
    }
    for (const [date, day] of brokerDaily) {
        if (merged.has(date))
            continue;
        merged.set(date, {
            date,
            tokensUsed: day.totalTokens,
            interactions: day.requestCount,
            costUsd: day.costUsd,
            brokerTokens: day.totalTokens,
        });
    }
    return Array.from(merged.values()).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function stringValue(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
function adminModelCredential(credential) {
    if (credential === null)
        return null;
    return {
        active: credential.active,
        provider: credential.provider,
        mode: credential.mode,
        status: credential.status,
        reasonCode: credential.reasonCode,
        fingerprint: credential.fingerprint,
        model: credential.model,
        baseUrl: credential.baseUrl,
        lastUsedAt: credential.lastUsedAt === null ? null : new Date(credential.lastUsedAt).toISOString(),
    };
}
function applyUserFilters(items, f) {
    let result = items;
    if (f.search) {
        const q = f.search;
        result = result.filter((c) => c.displayName.toLowerCase().includes(q) ||
            c.email.toLowerCase().includes(q) ||
            c.username.toLowerCase().includes(q));
    }
    if (f.throttleFilter === "degraded") {
        result = result.filter((c) => c.degraded);
    }
    else if (f.throttleFilter === "ok") {
        result = result.filter((c) => !c.degraded);
    }
    if (f.byotFilter !== "all") {
        result = result.filter((c) => c.byotActive === (f.byotFilter === "on"));
    }
    return result;
}
function userFiltersActive(f) {
    return f.search !== "" || f.throttleFilter !== "all" || f.byotFilter !== "all";
}
class UnknownUserCursorError extends Error {
}
function accountFor(accounts, uid) {
    return accounts.get(uid) ?? userAccountFromData(uid, {});
}
async function summarizeUsers(directory, users) {
    const uids = users.map((userRecord) => userRecord.uid);
    const [accounts, brokerUsage, credentials] = await Promise.all([
        directory.accounts.getMany(uids),
        readBrokerUserUsage(directory.source, uids, Date.now()),
        Promise.all(uids.map((uid) => directory.store.users.modelCredentials.get(uid))),
    ]);
    return users.map((userRecord, index) => buildUserSummary(userRecord, accountFor(accounts, userRecord.uid), credentials[index]?.active === true, brokerUsage.get(userRecord.uid) ?? {}));
}
function newestFirstWithUndatedLast(a, b) {
    if (a === null || b === null)
        return Number(a === null) - Number(b === null);
    return b.localeCompare(a);
}
async function sortedUsers(directory, sort) {
    const summaries = await summarizeUsers(directory, await directory.store.users.records.listAll());
    const key = (user) => (sort === "lastActive" ? user.lastActive : user.createdAt);
    return summaries.sort((a, b) => newestFirstWithUndatedLast(key(a), key(b)) || b.uid.localeCompare(a.uid));
}
async function unfilteredUserPage(directory, cursor, pageSize) {
    let page;
    try {
        page = await directory.store.users.records.list({ limit: pageSize, ...(cursor ? { after: cursor } : {}) });
    }
    catch (error) {
        if (error instanceof MissingRecordError && error.record.aggregate === "builder" && error.record.key === cursor) {
            throw new UnknownUserCursorError();
        }
        throw error;
    }
    return { items: await summarizeUsers(directory, page.items), hasMore: page.next !== null };
}
async function sortedUserPage(directory, sort, filters, cursor, pageSize) {
    const matches = applyUserFilters(await sortedUsers(directory, sort), filters);
    const start = cursor ? matches.findIndex((user) => user.uid === cursor) + 1 : 0;
    if (cursor && start === 0)
        throw new UnknownUserCursorError();
    return {
        items: matches.slice(start, start + pageSize),
        hasMore: start + pageSize < matches.length,
    };
}
export function projectUserPlacement(userRecord) {
    return {
        managedBy: userRecord.openclaw.managedBy ?? "cowboy",
        gatewayId: userRecord.gateway?.gatewayId ?? null,
        gatewayProfile: userRecord.gateway?.gatewayProfile ?? null,
    };
}
function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function projectPlacementReceipt(receipt) {
    const data = receipt;
    return {
        id: placementReceiptDocId(receipt.leaseId, receipt.generation, receipt.kind),
        kind: stringValue(data.kind) ?? "unknown",
        at: finiteNumber(data.at),
        userSlug: stringValue(data.builderSlug),
        leaseId: stringValue(data.leaseId),
        generation: finiteNumber(data.generation),
        cause: stringValue(data.cause),
        sizingTier: stringValue(data.sizingTier),
        gatewayId: stringValue(data.gatewayId),
        sharedGatewayId: stringValue(data.sharedGatewayId),
        wakeDurationMs: finiteNumber(data.wakeDurationMs),
        activeDurationMs: finiteNumber(data.activeDurationMs),
        operationId: stringValue(data.operationId),
        retirementOperationId: stringValue(data.retirementOperationId),
        operatorTerminated: data.operatorTerminated === true,
        error: stringValue(data.error),
    };
}
function activationLeaseSummary(lease) {
    if (!lease)
        return null;
    return {
        leaseId: lease.leaseId,
        generation: lease.generation,
        status: lease.status,
        cause: stringValue(lease.cause),
        sizingTier: stringValue(lease.sizingTier),
        targetGatewayId: stringValue(lease.targetGatewayId),
        error: stringValue(objectValue(lease.lastError)?.message),
    };
}
function workspaceSlugs(logger, userRecord) {
    if (userRecord.slug === null) {
        logger.warn("no workspace slug resolved — workspace reads will return empty", { uid: userRecord.uid });
        return [];
    }
    return [userRecord.slug];
}
async function readAllArchives(store) {
    const archives = [];
    let after;
    do {
        const page = await store.jobs.archives.list({ limit: 500, ...(after === undefined ? {} : { after }) });
        archives.push(...page.items);
        after = page.next ?? undefined;
    } while (after !== undefined);
    return archives;
}
function sendUnknownCursor(res, error) {
    if (!(error instanceof UnknownUserCursorError))
        return false;
    res.status(400).json({ error: "Unknown user cursor" });
    return true;
}
// eslint-disable-next-line max-lines-per-function -- factory mounts the user routes; splitting it would scatter the contract
export function addAdminUserDirectoryRoutes(router, deps) {
    const { accounts, source, store, logger } = deps;
    const directory = { source, store, accounts };
    router.get("/user-archives", async (_req, res, next) => {
        try {
            const archives = (await readAllArchives(store)).map((archive) => projectAnonymousArchive(archive.id, { ...archive.record, archivedAt: archive.archivedAt }));
            const summary = archives.reduce((total, archive) => ({
                archiveCount: total.archiveCount + 1,
                totalCostUsd: total.totalCostUsd + archive.totals.costUsd,
                totalTokens: total.totalTokens + archive.totals.totalTokens,
                requestCount: total.requestCount + archive.totals.requestCount,
            }), { archiveCount: 0, totalCostUsd: 0, totalTokens: 0, requestCount: 0 });
            res.json({ archives, summary, generatedAt: new Date().toISOString() });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/users/:uid/broker-diagnostics", async (req, res, next) => {
        try {
            const uid = req.params.uid;
            const days = Math.min(30, Math.max(1, parseInt(req.query.days ?? "14", 10)));
            const now = Date.now();
            const sinceMs = now - days * 24 * 60 * 60 * 1000;
            const windowMs = 4 * 60 * 60 * 1000;
            const currentWindow = usageWindowStartMs(now);
            const windowStartsMs = Array.from({ length: 12 }, (_, i) => currentWindow - i * windowMs);
            const [windowRecords, events] = await Promise.all([
                source.brokerWindows(uid, windowStartsMs),
                source.brokerEvents(uid, sinceMs, BROKER_DAILY_USAGE_EVENT_LIMIT),
            ]);
            const windows = windowRecords
                .map((data) => ({
                windowStartMs: financeNumber(data.windowStartMs),
                totalTokens: financeNumber(data.totalTokens),
                requestCount: financeNumber(data.requestCount),
                costUsd: financeNumber(data.costUsd),
            }))
                .sort((a, b) => b.windowStartMs - a.windowStartMs);
            res.json({
                windows,
                ...aggregateBrokerDiagnostics(events),
            });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/users", async (req, res, next) => {
        try {
            const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize ?? `${DEFAULT_PAGE_SIZE}`, 10)));
            const cursor = req.query.cursor || null;
            const sort = (req.query.sort ?? "createdAt");
            const filters = {
                search: (req.query.search ?? "").trim().toLowerCase(),
                throttleFilter: req.query.throttle ?? "all",
                byotFilter: req.query.byot ?? "all",
            };
            const order = sort === "lastActive" ? "lastActive" : "createdAt";
            const page = userFiltersActive(filters) || order === "lastActive"
                ? await sortedUserPage(directory, order, filters, cursor, pageSize)
                : await unfilteredUserPage(directory, cursor, pageSize);
            const { items, hasMore } = page;
            const nextCursor = hasMore ? items[items.length - 1].uid : null;
            const total = await source.totalUsers();
            res.json({
                items,
                nextCursor,
                hasMore,
                total,
                generatedAt: new Date().toISOString(),
            });
        }
        catch (e) {
            if (!sendUnknownCursor(res, e))
                next(e);
        }
    });
    router.get("/users/stats", async (_req, res, next) => {
        try {
            let totalUsers = 0;
            let incompleteProvisioning = 0;
            let totalCostUsd = 0;
            let needsAttention = 0;
            const summaries = await sortedUsers(directory, "createdAt");
            for (const summary of summaries) {
                totalUsers++;
                if (summary.provisioningStatus !== "complete")
                    incompleteProvisioning++;
                totalCostUsd += summary.costUsd;
                if (summary.degraded || summary.percentUsed > 80)
                    needsAttention++;
            }
            res.json({
                ...userEntitlements().productProjection?.adminUserStats(summaries),
                totalUsers,
                incompleteProvisioning,
                totalCostUsd: Math.round(totalCostUsd * 100) / 100,
                needsAttention,
                generatedAt: new Date().toISOString(),
            });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/users/:uid", 
    // eslint-disable-next-line complexity -- response-shape user; cyclomatic count tracks user schema's optional-field depth, not branching logic. Splitting into sub-builders would scatter the response contract.
    async (req, res, next) => {
        try {
            const uid = req.params.uid;
            if (!uid) {
                res.status(400).json({ error: "uid required" });
                return;
            }
            const userRecord = await store.users.records.get(uid);
            if (!userRecord) {
                res.status(404).json({ error: "User not found" });
                return;
            }
            const account = (await accounts.get(uid)) ?? userAccountFromData(uid, {});
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
            const modelCredential = adminModelCredential(await store.users.modelCredentials.get(uid));
            const userCredentialActive = modelCredential?.active === true;
            const usageLogs = await source.usageLogs(uid, thirtyDaysAgo.toISOString().slice(0, 10));
            const workspaceRecords = await source.workspaces(uid);
            const productDetail = await deps.productUserDetail?.(uid);
            const usage = account.usage;
            const now = Date.now();
            const [brokerUsage, brokerDaily, brokerRollup] = await Promise.all([
                readBrokerUserUsage(source, [uid], now),
                readBrokerDailyUsage(source, uid, thirtyDaysAgo.getTime(), logger),
                source.brokerRollup(uid),
            ]);
            const summary = buildUserSummary(userRecord, account, userCredentialActive, brokerUsage.get(uid) ?? { now });
            const defaultAgentDm = userRecord.slug === null
                ? null
                : await store.workspaces.channels.get({ workspaceSlug: userRecord.slug, projectSlug: null }, "coach-dm");
            const slugs = workspaceSlugs(logger, userRecord);
            // Workspace usage_models carry token telemetry for ALL traffic (byosub
            // included) but openclaw's zero costs; the broker rollup carries the real USD
            // per platform model. Broker figures win per model; workspace-only models
            // (byosub) keep their token counts at zero platform cost.
            const modelCosts = {};
            for (const slug of slugs) {
                for (const { id, record: md } of await source.workspaceModelUsage(slug)) {
                    const model = md.model || id.split("_")[0];
                    if (!modelCosts[model])
                        modelCosts[model] = { tokens: 0, costUsd: 0, lastUsedAt: null };
                    modelCosts[model].tokens += md.tokens || 0;
                    modelCosts[model].costUsd = 0;
                    const lastUsed = toISODate(md.lastUsedAt);
                    if (lastUsed &&
                        (!modelCosts[model].lastUsedAt || lastUsed > modelCosts[model].lastUsedAt)) {
                        modelCosts[model].lastUsedAt = lastUsed;
                    }
                }
            }
            const rollupModels = (brokerRollup?.models ?? {});
            for (const value of Object.values(rollupModels)) {
                const model = typeof value.model === "string" ? value.model.replace(/-\d{8}$/, "") : null;
                if (!model)
                    continue;
                const existing = modelCosts[model] ?? { tokens: 0, costUsd: 0, lastUsedAt: null };
                existing.tokens = Math.max(existing.tokens, financeNumber(value.totalTokens));
                existing.costUsd = financeNumber(value.costUsd);
                modelCosts[model] = existing;
            }
            res.json({
                ...productDetail,
                ...userEntitlements().productProjection?.adminUserDetail(account.planInputs),
                summary,
                accountLifecycle: userRecord.accountLifecycle ?? { status: "active" },
                usage: {
                    totalTokensUsed: usage.totalTokensUsed || 0,
                    brokerTotalTokens: summary.brokerTotalTokens,
                    costUsd: summary.costUsd,
                    nextRefillAt: summary.nextRefillAt,
                    degraded: summary.degraded,
                    percentUsed: summary.percentUsed,
                    interactionCount: usage.interactionCount || 0,
                    lastUpdated: toISODate(usage.lastUpdated),
                    windowCostUsd: summary.windowCostUsd,
                    windowBudgetUsd: summary.windowBudgetUsd,
                    weekCostUsd: summary.weekCostUsd,
                    weekBudgetUsd: summary.weekBudgetUsd,
                    weekPercentUsed: summary.weekPercentUsed,
                    weekResetAt: summary.weekResetAt,
                },
                modelCredential,
                byot: { active: userCredentialActive },
                provisioning: {
                    status: userRecord.openclaw.status || userRecord.provisioning.status || "unknown",
                    slug: userRecord.slug ?? "",
                    activatedAgents: userRecord.agents.activatedAgents,
                    provisionedAt: isoMillis(userRecord.openclaw.provisionedAt ?? null),
                },
                placement: projectUserPlacement(userRecord),
                computer: isUserParkedVm(userRecord.home.computer) ? userRecord.home.computer : null,
                mattermost: {
                    connected: summary.mattermostConnected,
                    userId: userRecord.mattermostUserId || null,
                    channelId: defaultAgentDm?.mattermostChannelId ?? null,
                    username: account.mattermostUsername || null,
                },
                workspaces: workspaceRecords.map(({ id, record }) => ({ id, ...record })),
                // Daily history: token/interaction telemetry from the legacy tailer
                // (covers byosub traffic), USD strictly from the broker ledger.
                usageLogs: mergeDailyUsage(usageLogs, brokerDaily),
                modelCosts,
                createdAt: summary.createdAt,
            });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/users/:uid/usage", async (req, res, next) => {
        try {
            const uid = req.params.uid;
            const days = Math.max(1, Math.min(365, parseInt(req.query.days ?? "30", 10)));
            const userRecord = await store.users.records.get(uid);
            if (!userRecord) {
                res.status(404).json({ error: "User not found" });
                return;
            }
            const account = await accounts.get(uid);
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - days);
            const slugs = workspaceSlugs(logger, userRecord);
            // Cost comes from the broker's per-owner event stream — the
            // self-report ledger (usage_models) records openclaw's zero cost for
            // GLM. The broker meters per OWNER, so the platform usage/cost belongs
            // to the account: attribute it to the primary workspace and leave any
            // additional cards empty so a multi-workspace owner is never
            // double-counted. Owner-credential (BYOSUB) traffic never reaches the
            // broker and carries zero platform cost — correct for a cost panel.
            const series = brokerUsageSeries(await source.brokerEventCosts(uid, cutoff.getTime(), BROKER_USAGE_SERIES_READ_LIMIT));
            if (series.truncated) {
                logger.warn("broker usage series truncated at read limit", { ownerUid: uid, limit: BROKER_USAGE_SERIES_READ_LIMIT });
            }
            const displayName = account?.displayName || account?.username || "";
            const workspaces = slugs.map((slug, i) => {
                const s = i === 0 ? series : null;
                return {
                    workspaceId: slug,
                    displayName: displayName || slug,
                    summary: {
                        totalTokens: s?.totalTokens ?? 0,
                        totalCostUsd: s?.totalCostUsd ?? 0,
                        totalInteractions: s?.totalCalls ?? 0,
                        lastUpdated: null,
                        modelCosts: Object.fromEntries((s?.models ?? []).map((m) => [m.model.replace(/\//g, "_"), m.costUsd])),
                    },
                    sessions: (s?.sessions ?? []).map((d) => ({
                        date: d.date,
                        tokensUsed: d.tokens,
                        costUsd: d.costUsd,
                        interactions: d.calls,
                        roles: {},
                    })),
                    models: (s?.models ?? []).map((m) => ({
                        id: m.model,
                        date: "",
                        model: m.model,
                        tokens: m.tokens,
                        cost_usd: m.costUsd,
                        interaction_count: m.calls,
                        role: "platform",
                        lastUsedAt: m.lastUsedAt ? new Date(m.lastUsedAt).toISOString() : null,
                    })),
                };
            });
            const noSessions = workspaces.every((w) => w.summary.totalTokens === 0 && w.sessions.length === 0);
            let diagnostic;
            if (slugs.length === 0) {
                diagnostic = { kind: "no-slug", message: "User has no workspace slug. Check users/{uid}.username." };
            }
            else if (noSessions) {
                diagnostic = { kind: "no-data", message: "Workspace exists but no sessions logged yet." };
            }
            else {
                diagnostic = { kind: "ok", message: null };
            }
            res.json({ uid, workspaces, diagnostic, generatedAt: new Date().toISOString() });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/users/:uid/placements", async (req, res, next) => {
        try {
            const uid = req.params.uid;
            const userRecord = await store.users.records.get(uid);
            if (!userRecord) {
                res.status(404).json({ error: "User not found" });
                return;
            }
            const limit = Math.max(1, Math.min(200, parseInt(req.query.limit ?? "50", 10) || 50));
            const receipts = await store.users.placementReceipts.list(uid, { limit });
            const items = receipts.items.map(projectPlacementReceipt);
            const hasMore = receipts.next !== null;
            const lease = activationLeaseSummary(userRecord.activationLease);
            let retryAvailable = false;
            if (lease?.status === "failed") {
                retryAvailable = lease.targetGatewayId === null
                    ? true
                    : (await store.gateways.roots.get(lease.targetGatewayId)) === null;
            }
            res.json({ items, hasMore, lease, retryAvailable, generatedAt: new Date().toISOString() });
        }
        catch (e) {
            next(e);
        }
    });
    router.get("/users/:uid/audit", async (req, res, next) => {
        try {
            const uid = req.params.uid;
            const limit = Math.max(1, Math.min(200, parseInt(req.query.limit ?? "50", 10)));
            const items = (await source.adminActions(uid, limit)).map(({ id, record: d }) => ({
                id,
                at: toISODate(d.at),
                adminUid: d.adminUid ?? null,
                adminEmail: d.adminEmail ?? null,
                action: d.action ?? "(unknown)",
                before: d.before ?? null,
                after: d.after ?? null,
            }));
            res.json({ items, generatedAt: new Date().toISOString() });
        }
        catch (e) {
            next(e);
        }
    });
    return router;
}
