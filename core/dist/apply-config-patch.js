import { parseAgentId } from "@octogee/shared/types/identity";
import { CONFIG_PATCH_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";
import { log as defaultLog } from "./config.js";
import { OpenclawWireError, createGatewayRpc, } from "./gateway-rpc.js";
const RETRY_AFTER_PATTERN = /\brate limit exceeded\b.*?\bretry after (\d+)s\b/i;
function parseRetryAfterMs(message) {
    const match = RETRY_AFTER_PATTERN.exec(message);
    if (!match)
        return null;
    const seconds = Number.parseInt(match[1], 10);
    if (!Number.isFinite(seconds) || seconds < 0)
        return null;
    return seconds * 1000;
}
export function configPatchRetryPlan(err, currentBackoffMs, remainingMs) {
    const serverHintMs = parseRetryAfterMs(err.message);
    const source = serverHintMs != null ? "server retry-after" : "exp backoff";
    const candidateBackoff = serverHintMs ?? currentBackoffMs;
    return {
        delayMs: Math.min(candidateBackoff, Math.max(0, remainingMs)),
        missingRetryAfterHint: err.code === "rpc-error" && serverHintMs == null && /retry/i.test(err.message),
        source,
    };
}
function seedCacheFromFetch(cache, config, hash) {
    if (!cache)
        return;
    cache.current = config;
    cache.hash = hash;
}
function updateCacheAfterPatch(cache, patchResult) {
    if (!cache)
        return;
    if (patchResult.noop === true)
        return;
    cache.hash = "";
    cache.current = undefined;
}
function invalidateCacheForHashMismatch(cache) {
    if (!cache)
        return;
    cache.hash = "";
    cache.current = undefined;
}
function createAbortableSleep(signal, providedSleep) {
    return (providedSleep ??
        ((ms) => new Promise((resolve) => {
            const t = setTimeout(resolve, ms);
            signal?.addEventListener("abort", () => {
                clearTimeout(t);
                resolve();
            }, { once: true });
        })));
}
function throwIfConfigPatchAborted(signal, prefix) {
    if (!signal?.aborted)
        return;
    const reason = signal.reason;
    throw reason instanceof Error
        ? reason
        : new Error(`${prefix}config.patch aborted: ${String(reason ?? "signal aborted")}`);
}
function configPatchReplacePathOptions(replacePaths) {
    return replacePaths && replacePaths.length > 0 ? { replacePaths } : undefined;
}
function isMergePatchObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function mergePatchValueAlreadyApplied(current, patch) {
    if (Array.isArray(patch)) {
        return Array.isArray(current) &&
            current.length === patch.length &&
            patch.every((value, index) => mergePatchValueAlreadyApplied(current[index], value));
    }
    if (!isMergePatchObject(patch))
        return Object.is(current, patch);
    if (!isMergePatchObject(current))
        return false;
    return Object.entries(patch).every(([key, value]) => {
        const present = Object.prototype.hasOwnProperty.call(current, key);
        if (value === null)
            return !present;
        return present && mergePatchValueAlreadyApplied(current[key], value);
    });
}
async function readConfigForPatch(rpc, cache, now) {
    if (cache && cache.hash !== "" && cache.current !== undefined) {
        return { config: cache.current, hash: cache.hash, getMs: 0 };
    }
    const getStart = now();
    const fetched = await rpc.configGet();
    seedCacheFromFetch(cache, fetched.config, fetched.hash);
    return { config: fetched.config, hash: fetched.hash, getMs: now() - getStart };
}
async function handleHashMismatch(err, ctx) {
    if (ctx.attempts >= ctx.maxRetries) {
        ctx.log(`⚠ ${ctx.prefix}config.patch hash-mismatch exhausted after attempts=${ctx.attempts} — bubbling`);
        throw err;
    }
    if (ctx.remainingMs() <= 0) {
        throw new Error(`${ctx.prefix}config.patch totalDeadlineMs=${ctx.totalDeadlineMs}ms exceeded after attempts=${ctx.attempts} (last error: hash-mismatch)`);
    }
    invalidateCacheForHashMismatch(ctx.cache);
    if (ctx.attempts === 1) {
        ctx.log(`${ctx.prefix}config.patch attempt=${ctx.attempts} hash-mismatch after ${ctx.elapsed}ms — re-fetching hash and retrying immediately`);
        return ctx.currentBackoff;
    }
    const delayMs = Math.min(ctx.currentBackoff, ctx.remainingMs());
    ctx.log(`${ctx.prefix}config.patch attempt=${ctx.attempts} hash-mismatch after ${ctx.elapsed}ms — re-fetching hash and retrying in ${delayMs}ms`);
    await ctx.sleep(delayMs);
    ctx.throwIfAborted();
    return Math.min(ctx.currentBackoff * 2, ctx.maxBackoff);
}
async function runConfigPatchAttempt(args, ctx) {
    const { config, hash, getMs } = await readConfigForPatch(ctx.rpc, ctx.cache, ctx.now);
    const patch = args.buildPatch(config);
    if (args.skipIfAlreadyApplied && mergePatchValueAlreadyApplied(config, patch)) {
        const settled = await settleConfigNoop({ ...ctx, hash });
        ctx.log(`${ctx.prefix}config.patch local ${settled.noop ? "noop" : "reapplied"} attempt=${ctx.attempts} configGet=${getMs}ms totalMs=${ctx.now() - ctx.startedAt}`);
        return { mode: "rpc", attempts: ctx.attempts, ...(settled.noop ? { noop: true } : {}) };
    }
    const replacePaths = args.buildReplacePaths?.(config);
    const patchStart = ctx.now();
    let patchResult;
    try {
        patchResult = await ctx.rpc.configPatch(patch, hash, configPatchReplacePathOptions(replacePaths));
    }
    catch (err) {
        if (isPersistedFailedError(err))
            invalidateCacheForHashMismatch(ctx.cache);
        if (!isPersistedSupersededError(err))
            throw err;
        updateCacheAfterPatch(ctx.cache, {});
        ctx.log(`${ctx.prefix}config.patch persisted; a newer write superseded its reload attempt=${ctx.attempts} configGet=${getMs}ms configPatch=${ctx.now() - patchStart}ms totalMs=${ctx.now() - ctx.startedAt}`);
        return { mode: "rpc", attempts: ctx.attempts, superseded: true };
    }
    if (patchResult.noop === true)
        patchResult = await settleConfigNoop({ ...ctx, hash });
    const patchMs = ctx.now() - patchStart;
    updateCacheAfterPatch(ctx.cache, patchResult);
    ctx.log(`${ctx.prefix}config.patch OK attempt=${ctx.attempts} configGet=${getMs}ms configPatch=${patchMs}ms totalMs=${ctx.now() - ctx.startedAt}`);
    return {
        mode: "rpc",
        attempts: ctx.attempts,
        ...(patchResult.noop === true ? { noop: true } : {}),
    };
}
async function settleConfigNoop(ctx) {
    ctx.checkBudget();
    const current = await ctx.rpc.configGet();
    ctx.checkBudget();
    if (current.hash !== ctx.hash) {
        throw new OpenclawWireError("hash-mismatch", "config changed before verifying the live revision; rebuild the patch");
    }
    if (typeof current.configRevisionHash !== "string" || current.configRevisionHash.length === 0) {
        throw new OpenclawWireError("invalid-response", "config.get omitted the revision needed to verify the applied revision");
    }
    if (current.appliedConfigHash === current.configRevisionHash)
        return { ok: true, noop: true };
    if (!isMergePatchObject(current.config)) {
        throw new OpenclawWireError("invalid-response", "config.get returned an invalid saved config for reapplication");
    }
    await ctx.rpc.configApply(current.config, current.hash);
    invalidateCacheForHashMismatch(ctx.cache);
    ctx.checkBudget();
    const applied = await ctx.rpc.configGet();
    ctx.checkBudget();
    if (applied.configRevisionHash !== current.configRevisionHash) {
        throw new OpenclawWireError("hash-mismatch", "config changed while reapplying the live revision; rebuild the patch");
    }
    if (applied.appliedConfigHash !== current.configRevisionHash) {
        throw new OpenclawWireError("invalid-response", "config.apply did not establish the saved config's applied revision");
    }
    return { ok: true };
}
function isPersistedFailedError(err) {
    return err instanceof OpenclawWireError && err.code === "rpc-error" &&
        /config\.patch persisted but was not applied to the active Gateway \(failed\)/.test(err.message);
}
function isPersistedSupersededError(err) {
    return (err instanceof OpenclawWireError &&
        err.code === "rpc-error" &&
        /config\.patch persisted but was not applied to the active Gateway \(superseded\)/.test(err.message));
}
function isPermanentConfigPatchError(err) {
    return ((err.code === "auth-failed" && !/(?:^gateway starting; retry shortly$|User profile catalog is not ready)/i.test(err.message)) ||
        err.code === "invalid-patch" ||
        err.code === "invalid-response" ||
        (err.code === "rpc-error" && /redacted id placeholder with no matching original value/i.test(err.message)));
}
function isDestructiveArrayGuardError(err) {
    return err.code === "rpc-error" && /would remove entries from array path/i.test(err.message);
}
/**
 * openclaw 2026.7.2's roster guard: a config write may not drop
 * `agents.entries` keys unless it carries `allowedAgentRosterRemovals`, which
 * only `agents.delete` supplies. config.patch never can, so an identical retry
 * is guaranteed to fail — retrying to the deadline only delays the real fix.
 */
function isAgentRosterDropGuardError(err) {
    return (err.code === "rpc-error" &&
        /would drop agent roster entries without an explicit deletion/i.test(err.message));
}
export function isPermanentConfigPatchFailure(err) {
    return (err instanceof OpenclawWireError &&
        (isPermanentConfigPatchError(err) ||
            isDestructiveArrayGuardError(err) ||
            isAgentRosterDropGuardError(err)));
}
function throwIfPermanentConfigPatchFailure(err, ctx) {
    if (isPermanentConfigPatchError(err)) {
        ctx.log(`⚠ ${ctx.prefix}config.patch ${err.code} (permanent) after ${ctx.elapsed}ms — giving up: ${err.message}`);
        throw err;
    }
    if (isDestructiveArrayGuardError(err)) {
        ctx.log(`⚠ ${ctx.prefix}config.patch rejected by the destructive-array guard (permanent — identical retries cannot pass). ` +
            `The caller's buildReplacePaths must confirm every shrunk array path: ${err.message}`);
        throw err;
    }
    if (isAgentRosterDropGuardError(err)) {
        ctx.log(`⚠ ${ctx.prefix}config.patch rejected by the agent-roster guard (permanent — config.patch cannot carry the removal allowance). ` +
            `The caller must delete the departing agents with agents.delete before patching: ${err.message}`);
        throw err;
    }
}
function throwIfConfigPatchRetryUnavailable(err, ctx) {
    if (ctx.attempts >= ctx.maxRetries) {
        ctx.log(`⚠ ${ctx.prefix}config.patch retry exhausted (${err.code} x${ctx.attempts}: ${err.message}) totalMs=${ctx.now() - ctx.startedAt} — bubbling`);
        throw err;
    }
    if (ctx.remainingMs() <= 0) {
        throw new Error(`${ctx.prefix}config.patch totalDeadlineMs=${ctx.totalDeadlineMs}ms exceeded after attempts=${ctx.attempts} (last error: ${err.code}: ${err.message})`);
    }
}
async function handleConfigPatchFailure(err, ctx) {
    const elapsed = ctx.now() - ctx.attemptStartedAt;
    throwIfPermanentConfigPatchFailure(err, { elapsed, log: ctx.log, prefix: ctx.prefix });
    if (err.code === "hash-mismatch") {
        return handleHashMismatch(err, { ...ctx, elapsed });
    }
    throwIfConfigPatchRetryUnavailable(err, ctx);
    const retryPlan = configPatchRetryPlan(err, ctx.currentBackoff, ctx.remainingMs());
    if (retryPlan.missingRetryAfterHint) {
        ctx.log(`⚠ ${ctx.prefix}config.patch rpc-error mentions "retry" but no parsed hint — server wording may have drifted (msg: ${err.message})`);
    }
    if (retryPlan.delayMs <= 0) {
        throw new Error(`${ctx.prefix}config.patch totalDeadlineMs=${ctx.totalDeadlineMs}ms exceeded — no time left for backoff after attempts=${ctx.attempts} (last error: ${err.code}: ${err.message})`);
    }
    ctx.log(`🟡 ${ctx.prefix}config.patch attempt=${ctx.attempts} failed (${err.code}: ${err.message}) after ${elapsed}ms — retrying in ${retryPlan.delayMs}ms (${retryPlan.source})`);
    await ctx.sleep(retryPlan.delayMs);
    ctx.throwIfAborted();
    return Math.min(ctx.currentBackoff * 2, ctx.maxBackoff);
}
async function throwUnlessRetryConfirmed(args, err, ctx) {
    if (!args.beforeRetry || await args.beforeRetry())
        return;
    ctx.log(`⚠ ${ctx.prefix}config.patch retry declined after attempt=${ctx.attempts} (${err.code}) — bubbling`);
    throw err;
}
export async function applyConfigPatch(args, opts = {}) {
    const log = opts.log ?? defaultLog;
    const prefix = args.logPrefix ? `${args.logPrefix} ` : "";
    const initialBackoff = opts.retryBackoffInitialMs ?? 2_000;
    const maxBackoff = opts.retryBackoffMaxMs ?? 30_000;
    const maxRetries = opts.maxRetries ?? Number.POSITIVE_INFINITY;
    const totalDeadlineMs = opts.totalDeadlineMs ?? Number.POSITIVE_INFINITY;
    const now = opts.now ?? Date.now;
    const signal = opts.signal;
    const sleep = createAbortableSleep(signal, opts.sleep);
    const rpc = opts.rpc ?? createGatewayRpc({
        allowLegacyGatewayTokenFallback: true,
        callTimeoutMs: CONFIG_PATCH_DEADLINE_MS,
    });
    const ownsRpc = !opts.rpc;
    const startedAt = now();
    let attempts = 0;
    let currentBackoff = initialBackoff;
    const remainingMs = () => totalDeadlineMs - (now() - startedAt);
    const cache = opts.cache;
    const throwIfAborted = () => throwIfConfigPatchAborted(signal, prefix);
    const checkBudget = () => {
        throwIfAborted();
        if (remainingMs() <= 0)
            throw new Error(`${prefix}config.patch totalDeadlineMs=${totalDeadlineMs}ms exceeded while verifying the applied revision`);
    };
    try {
        throwIfAborted();
        while (true) {
            attempts++;
            const attemptStartedAt = now();
            try {
                return await runConfigPatchAttempt(args, {
                    attempts,
                    cache,
                    log,
                    now,
                    prefix,
                    rpc,
                    startedAt,
                    checkBudget,
                });
            }
            catch (err) {
                if (!(err instanceof OpenclawWireError)) {
                    throw err;
                }
                currentBackoff = await handleConfigPatchFailure(err, {
                    attemptStartedAt,
                    attempts,
                    cache,
                    currentBackoff,
                    log,
                    maxBackoff,
                    maxRetries,
                    now,
                    prefix,
                    remainingMs,
                    sleep,
                    startedAt,
                    throwIfAborted,
                    totalDeadlineMs,
                });
                await throwUnlessRetryConfirmed(args, err, { attempts, log, prefix });
            }
        }
    }
    finally {
        if (ownsRpc) {
            try {
                await rpc.close();
            }
            catch { }
        }
    }
}
function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function upsertAgentInFullAgentList(current, agentId, agentEntry) {
    const currentAgents = fullAgentListFromCurrent(current);
    return [
        ...currentAgents.filter((agent) => !(isPlainObject(agent) && agent.id === agentId)),
        agentEntry,
    ];
}
function keyedAgentEntries(current) {
    const entries = current?.agents?.entries;
    return isPlainObject(entries) ? entries : null;
}
function fullAgentListFromCurrent(current) {
    const entries = keyedAgentEntries(current);
    if (entries) {
        return Object.entries(entries).map(([id, entry]) => {
            if (!isPlainObject(entry)) {
                throw new Error(`agents.entries.${id} must be an object`);
            }
            return { ...entry, id };
        });
    }
    const list = current?.agents?.list;
    return Array.isArray(list) ? list : [];
}
function keyedEntryFromAgent(agent) {
    if (!isPlainObject(agent) || typeof agent.id !== "string" || agent.id.length === 0) {
        throw new Error("user agent patch requires every agent to have a non-empty id");
    }
    const { id, memorySearch, ...entry } = agent;
    if (isPlainObject(memorySearch)) {
        const memory = isPlainObject(entry.memory) ? entry.memory : {};
        entry.memory = { ...memory, search: memorySearch };
    }
    return [id, entry];
}
function isUserAgentId(value, slug) {
    if (typeof value !== "string")
        return false;
    const parsed = parseAgentId(value);
    return parsed.kind !== "unknown" && parsed.username === slug;
}
// Multi-agent: a user owns a SET of agents (agent + project agents). Rebuilding
// the user's slice of the agent list must drop stale project agents too —
// a per-id upsert would leave a retired project agent behind forever.
export function replaceUserAgentsInFullAgentList(current, slug, agentEntries) {
    const currentAgents = fullAgentListFromCurrent(current);
    const next = [];
    let inserted = false;
    for (const agent of currentAgents) {
        const userOwned = isPlainObject(agent) && isUserAgentId(agent.id, slug);
        if (userOwned) {
            if (!inserted) {
                next.push(...agentEntries);
                inserted = true;
            }
            continue;
        }
        next.push(agent);
    }
    if (!inserted)
        next.push(...agentEntries);
    return next;
}
// Under explicit ownership OpenClaw's gateway default is the first roster entry;
// its model decides the Control UI hello's `modelConfigured`.
export function orderIsolatedGatewayRoster(agents, userDefaultAgentId, anchorAgentId) {
    const idOf = (agent) => (isPlainObject(agent) ? agent.id : undefined);
    const defaultAgent = agents.filter((agent) => idOf(agent) === userDefaultAgentId);
    const anchor = agents.filter((agent) => idOf(agent) === anchorAgentId);
    const rest = agents.filter((agent) => {
        const id = idOf(agent);
        return id !== userDefaultAgentId && id !== anchorAgentId;
    });
    return [...defaultAgent, ...rest, ...anchor];
}
/**
 * After the first mount, model authority belongs to the byot-sync pipeline
 * (BYOK overrides, house pins, picker selections) — the attach path re-ships
 * each user entry wholesale, so re-seeding a compiled default here would
 * revert that pipeline's write on every re-attach and the follow-up sync
 * would flip it back: two config writes and two agent restarts per converge
 * (observed live 2026-08-14 on shared-a). An agent whose current entry
 * carries a model keeps it verbatim; an entry without one (first mount, or
 * created-but-unseeded) keeps its seed — no pipeline path ever deletes a
 * model, so seeding on absence converges in one write and stays put.
 */
export function preserveMountedAgentModels(current, agentEntries) {
    const currentById = new Map();
    for (const agent of fullAgentListFromCurrent(current)) {
        if (isPlainObject(agent) && typeof agent.id === "string") {
            currentById.set(agent.id, agent);
        }
    }
    return agentEntries.map((entry) => {
        if (!isPlainObject(entry) || typeof entry.id !== "string")
            return entry;
        const existing = currentById.get(entry.id);
        if (!existing || !Object.prototype.hasOwnProperty.call(existing, "model")) {
            return entry;
        }
        return { ...entry, model: existing.model };
    });
}
/**
 * The user's slice of the agent roster, as a merge patch that only ever
 * ADDS or UPDATES. openclaw 2026.7.2 refuses any config write whose canonical
 * roster loses an entry unless the write carries `allowedAgentRosterRemovals`,
 * which only its own `agents.delete` supplies — so a retired project agent is
 * deleted by RPC before the patch, never nulled inside it.
 */
export function userAgentRosterPatch(current, slug, agentEntries) {
    const currentEntries = keyedAgentEntries(current);
    if (!currentEntries)
        return { list: [...agentEntries] };
    const entries = {};
    for (const agent of agentEntries) {
        const [id, entry] = keyedEntryFromAgent(agent);
        if (isUserAgentId(id, slug) ||
            JSON.stringify(currentEntries[id]) !== JSON.stringify(entry)) {
            entries[id] = entry;
        }
    }
    return { entries };
}
function isUserMattermostAccountBinding(binding, slug) {
    if (!isPlainObject(binding))
        return false;
    const match = binding.match;
    if (!isPlainObject(match) || match.channel !== "mattermost")
        return false;
    const accountId = match.accountId;
    return typeof accountId === "string" && (accountId === `${slug}-coach` || accountId.startsWith(`${slug}-proj-`));
}
function isRetainedAgentOtherChannelBinding(binding, retainedAgentIds) {
    if (!isPlainObject(binding) || !retainedAgentIds.has(binding.agentId))
        return false;
    const match = binding.match;
    return isPlainObject(match) && typeof match.channel === "string" && match.channel !== "mattermost";
}
/**
 * Drops the user's bindings. A binding on a channel other than Mattermost is
 * kept when its agent is in `retainedAgentIds`: the platform writes only
 * Mattermost bindings, so another channel's binding belongs to whatever added it.
 */
export function filterOutUserBindings(bindings, slug, retainedAgentIds = new Set()) {
    return bindings.filter((binding) => {
        if (isRetainedAgentOtherChannelBinding(binding, retainedAgentIds))
            return true;
        const agentId = isPlainObject(binding) ? binding.agentId : undefined;
        return !isUserAgentId(agentId, slug) &&
            !isUserMattermostAccountBinding(binding, slug);
    });
}
// Rebuilding bindings as filter-out-then-append reorders the array on every
// converge, which defeats config.patch's local no-op and buys a full reload
// cycle for a content-identical write. Keep the current array — order and
// identity — whenever the merged content is the same multiset.
export function mergeUserBindings(current, slugs, nextUserBindings) {
    const mountedAgentIds = new Set(nextUserBindings.map((binding) => binding.agentId));
    let kept = current;
    for (const slug of slugs) {
        kept = filterOutUserBindings(kept, slug, mountedAgentIds);
    }
    const rebuilt = [...kept, ...nextUserBindings];
    if (rebuilt.length !== current.length)
        return rebuilt;
    const counts = new Map();
    for (const binding of current) {
        const key = JSON.stringify(binding);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const binding of rebuilt) {
        const key = JSON.stringify(binding);
        const remaining = counts.get(key);
        if (!remaining)
            return rebuilt;
        counts.set(key, remaining - 1);
    }
    return current;
}
// config.patch merges: omitting a retired project-agent account keeps it
// alive on a revoked token. Every account rebuild must null the user's
// `{slug}-proj-*` keys that are no longer active. The prefix is cross-tenant
// safe because `proj` is a reserved username segment.
export function staleProjectAgentAccountNulls(current, slug, keepAccountIds) {
    const accounts = current
        ?.channels?.mattermost?.accounts ?? {};
    const keep = new Set(keepAccountIds);
    const out = {};
    for (const key of Object.keys(accounts)) {
        if (key.startsWith(`${slug}-proj-`) && !keep.has(key))
            out[key] = null;
    }
    return out;
}
// Mirrors the gateway's collectBaseArrayPaths (openclaw src/gateway/server-methods/config.ts):
// null-deleting an object via config.patch trips the destructive-array guard for EVERY array
// anywhere under the deleted object, each named by exact dot-path. Arrays are terminal — the
// guard does not recurse into their elements — and prototype-pollution keys are skipped,
// exactly as upstream's isBlockedObjectKey does.
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function collectArrayPathsUnder(value, prefix) {
    if (Array.isArray(value))
        return [prefix];
    if (!isPlainObject(value))
        return [];
    const paths = [];
    for (const [key, child] of Object.entries(value)) {
        if (BLOCKED_OBJECT_KEYS.has(key))
            continue;
        paths.push(...collectArrayPathsUnder(child, `${prefix}.${key}`));
    }
    return paths;
}
function userMattermostAccountArrayPaths(current, slug) {
    const accounts = current?.channels?.mattermost?.accounts;
    if (!isPlainObject(accounts))
        return [];
    return Object.entries(accounts).flatMap(([accountId, account]) => {
        if (accountId !== `${slug}-coach` && !accountId.startsWith(`${slug}-proj-`))
            return [];
        return collectArrayPathsUnder(account, `channels.mattermost.accounts.${accountId}`);
    });
}
/**
 * The replacePaths set for user config patches that rebuild non-id arrays:
 * `bindings` plus every array under the slug's MM accounts. Add/re-ensure patches
 * intentionally omit `agents.list` so a one-agent upsert stays an id-keyed merge
 * instead of becoming whole-list replacement.
 */
export function userConfigReplacePaths(current, slug) {
    return [
        "bindings",
        ...userMattermostAccountArrayPaths(current, slug),
    ];
}
/**
 * The guard confirmation set for any patch that ships the full `agents.list`.
 * `agents.list` alone is NOT enough: the gateway's destructive-array guard
 * descends INTO id-keyed array entries and reports a shrunk nested array as its
 * own `agents.list[].<field>` path, filtered against replacePaths individually
 * (openclaw server-methods/config.ts, collectDestructiveIdKeyedArrayEntryPatchPaths).
 * The per-entry arrays the platform itself rewrites: `model.fallbacks` shrinks on
 * the BYOK-override → house-pin transition ({primary, fallbacks: [house]} →
 * {primary: house, fallbacks: []}) and whenever a string model replaces an object
 * one; `tools.alsoAllow` shrinks when the free-tier trim overwrites a different
 * existing block. Observed live 2026-07-09: every reconcile tick refused with
 * "would remove entries from array path(s): agents.list[].model.fallbacks".
 */
export function fullAgentListReplacePaths() {
    return [
        "agents.list",
        "agents.list[].model.fallbacks",
        "agents.list[].tools.alsoAllow",
    ];
}
/**
 * The replacePaths set for user config patches that intentionally ship the full
 * post-filter `agents.list` from the current config. Only use this when the patch's
 * `agents.list` is a complete replacement candidate, not a single-agent upsert.
 */
export function userConfigFullAgentListReplacePaths(current, slug) {
    return [
        ...fullAgentListReplacePaths(),
        ...userConfigReplacePaths(current, slug),
    ];
}
/**
 * Array paths under the user's keyed agent entries.
 *
 * `userAgentRosterPatch` rewrites each entry wholesale, so any array it
 * shrinks — `model.fallbacks` on the BYOK-override → house-pin transition,
 * `tools.alsoAllow` on a free-tier trim — trips the gateway's destructive-array
 * guard. The guard walks base-vs-merged and reports each shrunk array by exact
 * name (collectBaseArrayPaths), so each has to be confirmed or the whole patch
 * is refused. Same shape as userMattermostAccountArrayPaths.
 */
function userKeyedAgentEntryArrayPaths(current, slug) {
    const entries = keyedAgentEntries(current);
    if (!entries)
        return [];
    return Object.entries(entries).flatMap(([agentId, entry]) => isUserAgentId(agentId, slug)
        ? collectArrayPathsUnder(entry, `agents.entries.${agentId}`)
        : []);
}
export function userConfigAgentRosterReplacePaths(current, slug, additionalAgentIds = []) {
    const entries = keyedAgentEntries(current);
    const additionalPaths = additionalAgentIds.flatMap((agentId) => {
        if (entries)
            return collectArrayPathsUnder(entries[agentId], `agents.entries.${agentId}`);
        const list = current?.agents?.list;
        const agent = Array.isArray(list)
            ? list.find((entry) => isPlainObject(entry) && entry.id === agentId)
            : undefined;
        return collectArrayPathsUnder(agent, "agents.list[]");
    });
    const paths = entries
        ? [
            ...userKeyedAgentEntryArrayPaths(current, slug),
            ...userConfigReplacePaths(current, slug),
        ]
        : userConfigFullAgentListReplacePaths(current, slug);
    return [...new Set([...paths, ...additionalPaths])];
}
