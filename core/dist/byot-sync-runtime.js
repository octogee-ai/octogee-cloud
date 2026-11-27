import * as path from "path";
import { mattermostAccountIdForAgentId } from "@octogee/shared/types/identity";
import * as os from "os";
import * as fs from "fs";
import { applyByotState, byosDefaultAgentConfigPatch, defaultAgentExists, defaultAgentPatch, defaultAgentPatchReplacePaths, deriveDesiredByotState, HOUSE_MODEL_DEFAULT_AGENT_TOOLS, isPlatformProviderRef, platformDefaultAgentModelInputForUser, platformProjectAgentModelForUser, ISOLATED_CODEX_APP_SERVER, STANDARD_CODEX_APP_SERVER, } from "./byot-sync.js";
import { createGatewayRpc, OpenclawWireError } from "./gateway-rpc.js";
import { internalFetch } from "./internal-fetch.js";
import { claudeCliRuntimeConfig, codexRuntimeConfig, isModelCredentialOauthProvider, OPENAI_CODEX_DEFAULT_PROFILE_ID, } from "./model-credential-materializer.js";
import { codexAgentDir, purgeUserOauthRuntimeArtifacts, removeStaleCodexAuthJson, removeSubscriptionProfiles, restoreByosubCredentials, sharedAuthAgentDir, } from "./byosub-restore.js";
import { SHARED_MAIN_AGENT_ID, sharedAuthStoreUsable } from "./auth-profile-store.js";
import { applyConfigPatch, fullAgentListReplacePaths } from "./apply-config-patch.js";
import { AGENTS_DIR, OPENCLAW_DIR, isIsolatedGateway, isSharedGateway, log, readOpenClawConfig, usesLlmBrokerToken, } from "./config.js";
import { openAiCatalogInputForBaseUrl, vertexCatalogInputForBaseUrl, metaCatalogInputForBaseUrl, openRouterCatalogInputForBaseUrl, openRouterBrokerCatalogJson, openRouterBrokerModelConfig, materializeBrokerProfilesForAgents, } from "./agent-model-token-materializer.js";
import { agentIdBelongsToSlug, catalogEntryForModelRef, canonicalUserModelDefinition, parseAgentModelSelections, platformModelRefs, } from "@octogee/shared/types/agent-models";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { configuredPlatformVertexBaseUrl } from "./platform-vertex-env.js";
import { userModelProviderDeclarationsMatch, platformBrokerProviderDeclarations } from "./system-config-invariants.js";
import { DEFAULT_HOUSE_MODEL_REF, parseUserAgentModelDefault, } from "@octogee/shared/types/platform-config";
// byot-sync fires at pod boot, before openclaw is listening on :18789, so the
// default-agent-model patch must wait for the runtime to finish booting (ECONNREFUSED)
// rather than burn a fixed 3-shot budget. Deadline-bounded (matches the
// default-agent-attach verify's runtime-readiness budget); permanent errors still fail
// fast inside applyConfigPatch.
const BYOT_RUNTIME_BOOT_PATIENCE_MS = 120_000;
const PLATFORM_CATALOG_RESTART_MARKER = path.join(OPENCLAW_DIR, ".platform-model-catalog-restart-required");
function hasPendingPlatformCatalogRestart() {
    return fs.existsSync(PLATFORM_CATALOG_RESTART_MARKER);
}
function markPlatformCatalogRestartPending() {
    fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
    fs.writeFileSync(PLATFORM_CATALOG_RESTART_MARKER, "pending\n", "utf-8");
}
function clearPlatformCatalogRestartPending() {
    fs.rmSync(PLATFORM_CATALOG_RESTART_MARKER, { force: true });
}
export async function applyDefaultAgentModelPatch(input, deps) {
    const logFn = deps?.logFn ?? log;
    if (!input)
        return false;
    const patch = byosDefaultAgentConfigPatch(input);
    if (!patch)
        return false;
    const { id: agentId, model, tools } = patch.agents.list[0];
    const modelPrimary = typeof model === "string" ? model : model.primary;
    const modelFallbacks = typeof model === "string" ? [] : model.fallbacks;
    const applyConfigPatchFn = deps?.applyConfigPatch ?? applyConfigPatch;
    const { list: _defaultAgentPatchList, ...defaultAgentPatchAgents } = patch.agents;
    const buildPatch = (current) => ({
        ...patch,
        agents: { ...defaultAgentPatchAgents, ...defaultAgentPatch(current, agentId, model, tools ?? null) },
    });
    try {
        await applyConfigPatchFn({
            buildPatch,
            buildReplacePaths: (current) => defaultAgentPatchReplacePaths(current, agentId),
            logPrefix: `[byot-sync:${input.slug}]`,
        }, { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS });
        logFn(`[byot-sync] ${input.slug}: defaultAgent model → ${modelPrimary}${modelFallbacks.length ? ` (fallback ${modelFallbacks.join(", ")})` : ""}`);
        return true;
    }
    catch (e) {
        logFn(`⚠ [byot-sync] default-agent-model patch failed for ${input.slug}: ${e.message}`);
        return false;
    }
}
// Plan-gated tools reassert for syncs that ship no default-agent-model patch (catalog
// plan, no BYOK, no explicit pick — the config-default agent). The model
// patch converges tools whenever it ships; this covers the remaining lapse/
// upgrade transitions so the free-tier trim appears and disappears exactly
// like the model pin does. Model untouched (model:null).
export async function applyDefaultAgentToolsConvergence(slug, houseOnly, deps) {
    const logFn = deps?.logFn ?? log;
    const agentId = `octogee-${slug}-coach`;
    const tools = houseOnly ? HOUSE_MODEL_DEFAULT_AGENT_TOOLS : null;
    const applyConfigPatchFn = deps?.applyConfigPatch ?? applyConfigPatch;
    // A missing agent entry means there is nothing to converge — succeeding
    // silently here would mask an unmounted/half-mounted user on the very
    // path that exists to repair upgrade/lapse drift. Fail loudly instead; the
    // next sync/re-mount retries.
    const buildPatch = (current) => {
        if (!defaultAgentExists(current, agentId)) {
            throw new Error(`coach entry ${agentId} missing from agents.list/entries — nothing to converge (user not mounted on this pod?)`);
        }
        return { agents: defaultAgentPatch(current, agentId, null, tools) };
    };
    try {
        await applyConfigPatchFn({
            buildPatch,
            buildReplacePaths: (current) => defaultAgentPatchReplacePaths(current, agentId),
            logPrefix: `[coach-tools:${slug}]`,
            skipIfAlreadyApplied: true,
        }, { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS });
        logFn(`[byot-sync] ${slug}: defaultAgent tools ${houseOnly ? "trimmed to the free-tier surface" : "converged to the inherited gateway surface"}`);
        return true;
    }
    catch (e) {
        logFn(`⚠ [byot-sync] default-agent-tools convergence failed for ${slug}: ${e.message}`);
        return false;
    }
}
// Per-agent model picks from the PWA catalog picker (users/{uid}/system/
// config.agentModels). Applied last so an explicit pick wins over the class
// default the standard sync just wrote. Absence means "leave the agent
// alone" — partial userData from other trigger sites must never reset models.
export async function applyAgentModelOverrides(slug, agentModels, opts, deps) {
    const logFn = deps?.logFn ?? log;
    const owned = Object.entries(agentModels ?? {}).filter(([agentId]) => {
        if (agentIdBelongsToSlug(agentId, slug))
            return true;
        logFn(`⚠ [byot-sync] ${slug}: agent-model override for foreign agent ${agentId} ignored`);
        return false;
    });
    if (opts.houseOnly) {
        if (owned.length > 0) {
            logFn(`[byot-sync] ${slug}: agent-model overrides deferred — house-only plan pins the house model`);
        }
        return false;
    }
    const applyConfigPatchFn = deps?.applyConfigPatch ?? applyConfigPatch;
    let patched = false;
    for (const [agentId, selection] of owned) {
        const model = { primary: selection.primary, fallbacks: selection.fallbacks };
        const platformRefs = [selection.primary, ...selection.fallbacks].filter(isPlatformProviderRef);
        // Overrides only run for catalog plans (house-only defers above), so the
        // agent's rebuild also strips a lingering free-tier trim (fingerprint-
        // gated). The trim is default-agent-only, so every other owned agent's tools keys
        // are left untouched.
        const toolsConvergence = agentId === `octogee-${slug}-coach` ? null : undefined;
        const buildPatch = (current) => ({
            agents: {
                ...(platformRefs.length > 0
                    ? {
                        defaults: {
                            models: Object.fromEntries(platformRefs.map((ref) => [ref, {}])),
                        },
                    }
                    : {}),
                ...defaultAgentPatch(current, agentId, model, toolsConvergence),
            },
        });
        try {
            await applyConfigPatchFn({
                buildPatch,
                buildReplacePaths: (current) => defaultAgentPatchReplacePaths(current, agentId),
                logPrefix: `[agent-models:${slug}]`,
                skipIfAlreadyApplied: true,
            }, { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS });
            logFn(`[byot-sync] ${slug}: ${agentId} model → ${selection.primary}${selection.fallbacks.length ? ` (fallback ${selection.fallbacks.join(", ")})` : ""}`);
            patched = true;
        }
        catch (e) {
            logFn(`⚠ [byot-sync] agent-model override failed for ${agentId}: ${e.message}`);
        }
    }
    if (opts.projectAgentDefault) {
        const pickedAgentIds = new Set(owned.map(([agentId]) => agentId));
        const defaulted = await applyProjectAgentModelDefault(slug, opts.projectAgentDefault, pickedAgentIds, { applyConfigPatch: applyConfigPatchFn, logFn });
        patched = defaulted || patched;
    }
    return patched;
}
function unpickedProjectAgentIds(current, slug, pickedAgentIds) {
    const userDefaultAgentId = `octogee-${slug}-coach`;
    return agentIdsForSlug(slug, current).filter((agentId) => agentId !== userDefaultAgentId && !pickedAgentIds.has(agentId));
}
function agentsModelPatch(current, agentIds, model) {
    const agents = recordChild(current, "agents");
    if (isRecord(agents.entries)) {
        const entries = agents.entries;
        return {
            entries: Object.fromEntries(agentIds.flatMap((agentId) => isRecord(entries[agentId]) ? [[agentId, { ...entries[agentId], model }]] : [])),
        };
    }
    const targets = new Set(agentIds);
    const list = Array.isArray(agents.list) ? agents.list : [];
    return {
        list: list.map((entry) => isRecord(entry) && typeof entry.id === "string" && targets.has(entry.id)
            ? { ...entry, model }
            : entry),
    };
}
function agentsModelReplacePaths(current, agentIds) {
    if (agentIds.length === 0)
        return [];
    if (isRecord(recordChild(current, "agents").entries)) {
        return agentIds.map((agentId) => `agents.entries.${agentId}.model.fallbacks`);
    }
    return fullAgentListReplacePaths();
}
async function applyProjectAgentModelDefault(slug, model, pickedAgentIds, deps) {
    const platformRefs = [model.primary, ...model.fallbacks].filter(isPlatformProviderRef);
    let defaultedAgentIds = [];
    try {
        await deps.applyConfigPatch({
            buildPatch: (current) => {
                defaultedAgentIds = unpickedProjectAgentIds(current, slug, pickedAgentIds);
                if (defaultedAgentIds.length === 0)
                    return {};
                return {
                    agents: {
                        ...(platformRefs.length > 0
                            ? { defaults: { models: Object.fromEntries(platformRefs.map((ref) => [ref, {}])) } }
                            : {}),
                        ...agentsModelPatch(current, defaultedAgentIds, model),
                    },
                };
            },
            buildReplacePaths: (current) => agentsModelReplacePaths(current, unpickedProjectAgentIds(current, slug, pickedAgentIds)),
            logPrefix: `[agent-models:${slug}]`,
            skipIfAlreadyApplied: true,
        }, { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS });
    }
    catch (e) {
        deps.logFn(`⚠ [byot-sync] ${slug}: project agent model default failed: ${e.message}`);
        return false;
    }
    if (defaultedAgentIds.length === 0)
        return false;
    deps.logFn(`[byot-sync] ${slug}: ${defaultedAgentIds.join(", ")} model → ${model.primary}${model.fallbacks.length ? ` (fallback ${model.fallbacks.join(", ")})` : ""}`);
    return true;
}
export async function applyOauthRuntimeModelAllowlist(providers, codexAppServer, deps) {
    const uniqueProviders = Array.from(new Set(providers));
    const models = {};
    let enableCodex = false;
    let enableClaudeCli = false;
    if (uniqueProviders.includes("openai")) {
        Object.assign(models, codexRuntimeConfig().modelsDef);
        enableCodex = true;
    }
    if (uniqueProviders.includes("anthropic")) {
        Object.assign(models, claudeCliRuntimeConfig().modelsDef);
        enableClaudeCli = true;
    }
    if (Object.keys(models).length === 0) {
        return { patched: false, changed: false, restartRequired: false };
    }
    const buildPatch = () => ({
        agents: { defaults: { models } },
        ...(enableCodex
            ? {
                plugins: {
                    entries: {
                        codex: {
                            enabled: true,
                            config: { appServer: codexAppServer },
                        },
                    },
                },
            }
            : {}),
    });
    const logFn = deps?.logFn ?? log;
    const applyConfigPatchFn = deps?.applyConfigPatch ?? applyConfigPatch;
    try {
        const result = await applyConfigPatchFn({
            buildPatch,
            logPrefix: "[byot-sync:oauth-runtime]",
        }, { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS });
        logFn(`[byot-sync] OAuth runtime models allowlisted for ${uniqueProviders.sort().join(", ")}`);
        const changed = result.noop !== true;
        return { patched: true, changed, restartRequired: changed && enableClaudeCli };
    }
    catch (e) {
        logFn(`⚠ [byot-sync] OAuth runtime allowlist patch failed: ${e.message}`);
        return { patched: false, changed: false, restartRequired: false };
    }
}
export async function requestGatewayRestartForRuntimeChange(reason = "byosub.oauth-runtime") {
    const rpc = createGatewayRpc({
        allowLegacyGatewayTokenFallback: true,
        connectTimeoutMs: 10_000,
        callTimeoutMs: 10_000,
    });
    try {
        await rpc.gatewayRestartRequest({
            reason,
            skipDeferral: true,
        });
        log(`[byot-sync] gateway restart requested after runtime change (${reason})`);
        return true;
    }
    catch (err) {
        let detail;
        if (err instanceof OpenclawWireError) {
            detail = `${err.code}: ${err.message}`;
        }
        else if (err instanceof Error) {
            detail = err.message;
        }
        else {
            detail = String(err);
        }
        log(`⚠ [byot-sync] gateway restart request failed after runtime change (${reason}): ${detail}`);
        return false;
    }
    finally {
        await rpc.close();
    }
}
export async function triggerSecretsReload() {
    const rpc = createGatewayRpc({
        allowLegacyGatewayTokenFallback: true,
        connectTimeoutMs: 10_000,
        callTimeoutMs: 10_000,
    });
    try {
        const result = await rpc.secretsReload();
        const warnings = Number(result.warningCount ?? 0);
        if (warnings > 0) {
            log(`[byot-sync] secrets reload ok — ${warnings} warning(s)`);
        }
        else {
            log("[byot-sync] secrets reload ok");
        }
    }
    catch (err) {
        let detail;
        if (err instanceof OpenclawWireError) {
            detail = `${err.code}: ${err.message}`;
        }
        else if (err instanceof Error) {
            detail = err.message;
        }
        else {
            detail = String(err);
        }
        log(`⚠ [byot-sync] secrets reload failed: ${detail}`);
    }
    finally {
        await rpc.close();
    }
}
function claudeCliNativeHomeDirForGateway() {
    return isIsolatedGateway() ? os.homedir() : undefined;
}
// Cattle gateways are egress-blocked from the GCP metadata server, so they
// cannot read user integration state or Secret Manager directly. octogee-api
// proves the assigned user for the KSA-bound gateway, then derives the user's
// BYOSUB secret name from that integration. internalFetch attaches the projected
// octogee-api KSA token the broker authorizes on.
function byokBrokerBaseUrl() {
    const configured = process.env.FLEET_BROKER_URL || process.env.OCTOGEE_API_URL;
    if (configured) {
        let base = configured;
        while (base.endsWith("/"))
            base = base.slice(0, -1);
        return base;
    }
    const ns = process.env.K8S_NAMESPACE ?? "octogee";
    return `http://octogee-api.${ns}.svc.cluster.local:3001`;
}
export async function brokerPushByosubCred(agentId, provider, credential) {
    const r = await internalFetch(`${byokBrokerBaseUrl()}/internal/byok/byosub-cred-syncback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, provider, credential }),
    });
    if (!r.ok) {
        const body = (await r.text().catch(() => "")).slice(0, 200);
        throw new Error(`byosub-cred-syncback ${r.status} ${body}`);
    }
    const data = await r.json();
    if (typeof data.changed !== "boolean" || typeof data.destroyed !== "number") {
        throw new Error("byosub-cred-syncback: malformed broker response");
    }
    return { changed: data.changed, destroyed: data.destroyed };
}
export async function brokerSignalSubscriptionNeedsReauth(rejection) {
    const r = await internalFetch(`${byokBrokerBaseUrl()}/api/model-credentials/subscription/auth-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...rejection, state: "needs_reauth" }),
    }, { requireProjectedToken: true });
    if (!r.ok) {
        const body = (await r.text().catch(() => "")).slice(0, 200);
        throw new Error(`subscription auth-state ${r.status} ${body}`);
    }
}
export async function brokerFetchByosubCreds(agentId) {
    const r = await internalFetch(`${byokBrokerBaseUrl()}/internal/byok/byosub-cred`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId }),
    });
    if (r.status === 404)
        return null;
    if (!r.ok) {
        const body = (await r.text().catch(() => "")).slice(0, 200);
        throw new Error(`byosub-cred ${r.status} ${body}`);
    }
    const data = await r.json();
    const credentials = data.credentials;
    if (!Array.isArray(credentials) ||
        credentials.some((cred) => !cred ||
            typeof cred !== "object" ||
            (cred.provider !== "openai" &&
                cred.provider !== "anthropic") ||
            typeof cred.secretName !== "string" ||
            typeof cred.credential !== "string")) {
        throw new Error("byosub-cred: malformed broker response");
    }
    return credentials.map((cred) => ({
        provider: cred.provider,
        secretName: cred.secretName,
        credential: cred.credential,
    }));
}
function subscriptionRestorePlan(creds, openclawDir, userDefaultAgentId) {
    return creds.map((cred) => ({
        agentId: userDefaultAgentId ?? SHARED_MAIN_AGENT_ID,
        provider: cred.provider,
        secretName: cred.secretName,
        openclawDir,
    }));
}
function credentialFromBrokerResponse(creds) {
    return async (secretName) => {
        const cred = creds.find((candidate) => candidate.secretName === secretName);
        if (!cred)
            throw new Error(`broker response omitted ${secretName}`);
        return cred.credential;
    };
}
const SUBSCRIPTION_PROVIDERS = ["openai", "anthropic"];
function claudeCliHomeOption(explicit) {
    const claudeCliNativeHomeDir = explicit ?? claudeCliNativeHomeDirForGateway();
    return claudeCliNativeHomeDir ? { claudeCliNativeHomeDir } : {};
}
async function inheritSharedSubscription({ slug, openclawDir, agentIds, providers, restore, logFn, }) {
    if (restore.failed > 0 || restore.restored + restore.skipped === 0)
        return;
    const disconnected = SUBSCRIPTION_PROVIDERS.filter((provider) => !providers.includes(provider));
    if (await removeSubscriptionProfiles(sharedAuthAgentDir(openclawDir), disconnected)) {
        logFn(`[byot-sync] ${slug}: dropped disconnected subscription(s) ${disconnected.join(", ")} from the shared store`);
    }
    for (const agentId of agentIds ?? mountedAgentIdsForSlug(slug)) {
        if (await removeSubscriptionProfiles(codexAgentDir(openclawDir, agentId), providers)) {
            logFn(`[byot-sync] ${slug}: ${agentId} now inherits the shared subscription credential`);
        }
        if (removeStaleCodexAuthJson(openclawDir, agentId)) {
            logFn(`[byot-sync] ${slug}: removed the stale codex-home auth.json for ${agentId} (OpenClaw reads only its auth store)`);
        }
    }
}
export async function restoreOauthStoreForSlug(slug, deps) {
    const userDefaultAgentId = `octogee-${slug}-coach`;
    const logFn = deps?.logFn ?? log;
    try {
        const fetchByosubCreds = deps?.fetchByosubCreds ?? brokerFetchByosubCreds;
        const ocDir = deps?.openclawDir ?? OPENCLAW_DIR;
        const creds = await fetchByosubCreds(userDefaultAgentId);
        if (!creds || creds.length === 0) {
            return { restored: false, present: false, providers: [] };
        }
        const providers = Array.from(new Set(creds.map((cred) => cred.provider)));
        const shared = await sharedAuthStoreUsable(ocDir);
        const plan = subscriptionRestorePlan(creds, ocDir, shared ? null : userDefaultAgentId);
        const r = await restoreByosubCredentials({
            plan,
            fetchSecret: credentialFromBrokerResponse(creds),
            logFn,
            ...claudeCliHomeOption(deps?.claudeCliNativeHomeDir),
        });
        const present = r.restored > 0 || r.skipped > 0;
        if (shared) {
            await inheritSharedSubscription({ slug, openclawDir: ocDir, agentIds: deps?.agentIds, providers, restore: r, logFn });
        }
        return { restored: r.restored > 0, present, providers };
    }
    catch (e) {
        logFn(`⚠ [byot-sync] oauth-store restore failed for ${slug}: ${e.message}`);
        return { restored: false, present: false, providers: [] };
    }
}
// Model-readiness: every agent gets BOTH broker provider surfaces —
// the anthropic:default profile and the full OpenRouter catalog — so "/models
// switch to <any catalog model>" is a pure agents.list flip. Plan policy gates
// at the broker, so pre-wiring every provider on every agent is safe.
export function agentIdsForSlug(slug, config) {
    const list = config?.agents?.list;
    const fromList = Array.isArray(list) ? list.flatMap((entry) => {
        const agentId = entry?.id;
        return typeof agentId === "string" && agentIdBelongsToSlug(agentId, slug) ? [agentId] : [];
    }) : [];
    const entries = config?.agents?.entries;
    const fromEntries = entries && typeof entries === "object" && !Array.isArray(entries)
        ? Object.keys(entries).filter((agentId) => agentIdBelongsToSlug(agentId, slug))
        : [];
    return Array.from(new Set([...fromList, ...fromEntries]));
}
const USER_OAUTH_PROFILE_IDS = new Set([
    OPENAI_CODEX_DEFAULT_PROFILE_ID,
    "openai-codex:default",
    "anthropic:claude-cli",
]);
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isDirectAgentRuntimeId(value) {
    return typeof value === "string" && value.trim().length > 0 && value !== "openclaw";
}
function normalizedCatalogSelection(value) {
    if (typeof value === "string") {
        return catalogEntryForModelRef(value) ? { primary: value, fallbacks: [] } : null;
    }
    if (!isRecord(value) || typeof value.primary !== "string" ||
        !catalogEntryForModelRef(value.primary))
        return null;
    const fallbacks = value.fallbacks === undefined ? [] : value.fallbacks;
    if (!Array.isArray(fallbacks) ||
        fallbacks.some((ref) => typeof ref !== "string" || !catalogEntryForModelRef(ref))) {
        return null;
    }
    return {
        primary: value.primary,
        fallbacks: Array.from(new Set(fallbacks)).filter((ref) => ref !== value.primary),
    };
}
function catalogModelMapPlan(value, ensureModelRef) {
    const current = isRecord(value) ? value : {};
    const modelRefs = new Set(Object.keys(current).filter((modelRef) => catalogEntryForModelRef(modelRef) !== null));
    if (ensureModelRef)
        modelRefs.add(ensureModelRef);
    const expected = Object.fromEntries([...modelRefs].map((modelRef) => [modelRef, canonicalUserModelDefinition(modelRef)]));
    const removedRefs = Object.keys(current).filter((modelRef) => catalogEntryForModelRef(modelRef) === null);
    const changed = JSON.stringify(current) !== JSON.stringify(expected);
    return {
        ...(isRecord(value) || ensureModelRef
            ? { patch: exactObjectPatch(current, expected) }
            : {}),
        removedRefs,
        changed,
    };
}
function userModelProvidersPlan(current, gatewayEnv = process.env) {
    const providers = isRecord(current) ? current : {};
    const anthropicBaseUrl = gatewayEnv.ANTHROPIC_BASE_URL?.trim();
    const expected = {
        ...(anthropicBaseUrl ? { anthropic: { baseUrl: anthropicBaseUrl } } : {}),
        ...platformBrokerProviderDeclarations(gatewayEnv),
    };
    return {
        patch: exactObjectPatch(providers, expected),
        unsafe: !userModelProviderDeclarationsMatch(providers, expected),
    };
}
function authProfileRemovalPatch(value) {
    if (!isRecord(value))
        return undefined;
    const removals = Object.fromEntries(Object.entries(value)
        .filter(([profileId, profile]) => {
        if (USER_OAUTH_PROFILE_IDS.has(profileId))
            return true;
        if (!isRecord(profile))
            return false;
        return profile.provider === "claude-cli" ||
            (profile.provider === "openai" && (profile.type === "oauth" || profile.mode === "oauth"));
    })
        .map(([profileId]) => [profileId, null]));
    return Object.keys(removals).length > 0 ? removals : undefined;
}
export const USER_APPROVED_PLUGINS = [
    "mattermost",
    "anthropic",
    "memory-core",
    "octogee-chat-tools",
    "octogee-activity-tools",
    "octogee-connector-tools",
    "octogee-access-tools",
    "octogee-project-tools",
    "octogee-board-tools",
    "octogee-status-tools",
    "octogee-broker-tools",
    "octogee-ops-tools",
    "octogee-web-tools",
    "octogee-workspace-tools",
    "parallel",
    "openai",
];
const FLEET_BROKER_URL_PLACEHOLDER = "${FLEET_BROKER_URL}";
const BROKER_TOKEN_PATH_PLACEHOLDER = "${OCTOGEE_API_SA_TOKEN_PATH}";
const USER_PLUGIN_ENTRIES = {
    "octogee-broker-tools": { enabled: true, config: { brokerUrl: FLEET_BROKER_URL_PLACEHOLDER, tokenPath: BROKER_TOKEN_PATH_PLACEHOLDER } },
    mattermost: { enabled: true },
    anthropic: { enabled: true },
    "octogee-activity-tools": {
        enabled: true,
        config: { heartbeatMs: 5000 },
    },
    "octogee-chat-tools": {
        enabled: true,
        hooks: {
            allowPromptModification: true,
            allowConversationAccess: true,
            timeouts: { before_dispatch: 3000, before_prompt_build: 3000, before_agent_run: 3000 },
        },
        config: {
            siteUrl: "${MM_SITE_URL}",
            brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
            tokenPath: BROKER_TOKEN_PATH_PLACEHOLDER,
            customersRoot: "${CUSTOMERS_DIR}",
        },
    },
    "octogee-connector-tools": {
        enabled: true,
        config: {
            brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
            tokenPath: BROKER_TOKEN_PATH_PLACEHOLDER,
        },
    },
    "octogee-access-tools": {
        enabled: true,
        config: {
            brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
            tokenPath: BROKER_TOKEN_PATH_PLACEHOLDER,
        },
    },
    "octogee-project-tools": {
        enabled: true,
        config: {
            brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
            tokenPath: BROKER_TOKEN_PATH_PLACEHOLDER,
        },
    },
    "octogee-board-tools": {
        enabled: true,
        config: {
            brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
            tokenPath: BROKER_TOKEN_PATH_PLACEHOLDER,
        },
    },
    "octogee-status-tools": {
        enabled: true,
        config: {
            brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
            tokenPath: BROKER_TOKEN_PATH_PLACEHOLDER,
            gatewayClass: "${GATEWAY_CLASS}",
        },
    },
    "octogee-ops-tools": {
        enabled: true,
        config: {
            brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
            tokenPath: BROKER_TOKEN_PATH_PLACEHOLDER,
        },
    },
    "octogee-web-tools": {
        enabled: true,
        config: {
            brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
            gatewayId: "${GATEWAY_ID}",
            tokenPath: BROKER_TOKEN_PATH_PLACEHOLDER,
        },
    },
    "octogee-workspace-tools": { enabled: true, config: {} },
    parallel: { enabled: true },
};
function materializeUserPluginValue(value) {
    if (value === BROKER_TOKEN_PATH_PLACEHOLDER)
        return value;
    if (typeof value === "string") {
        const match = /^\$\{([A-Z0-9_]+)\}$/u.exec(value);
        return match ? process.env[match[1]] ?? value : value;
    }
    if (Array.isArray(value))
        return value.map(materializeUserPluginValue);
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, materializeUserPluginValue(child)]));
}
function userPluginEntries() {
    return materializeUserPluginValue(USER_PLUGIN_ENTRIES);
}
const USER_SECRET_PROVIDERS = {
    "gcp-secret-manager": {
        source: "exec",
        command: "/octogee/scripts/secret-resolver.mjs",
        passEnv: [
            "FLEET_BROKER_URL",
            "OCTOGEE_API_URL",
            "OCTOGEE_API_SA_TOKEN_PATH",
            "INTERNAL_SERVICE_KEY",
            "OPENCLAW_AGENTS_DIR",
            "HOME",
        ],
        jsonOnly: true,
        timeoutMs: 45000,
    },
    "octogee-mattermost": {
        source: "file",
        path: path.join(OPENCLAW_DIR, "secrets", "mattermost-accounts.json"),
        mode: "json",
    },
};
function mergeConfigPatches(...patches) {
    const merged = {};
    for (const patch of patches) {
        for (const [key, value] of Object.entries(patch)) {
            if (isRecord(value) && isRecord(merged[key])) {
                merged[key] = mergeConfigPatches(merged[key], value);
            }
            else {
                merged[key] = value;
            }
        }
    }
    return merged;
}
function resolvesToEnvPlaceholder(current, expected, env) {
    if (!env || typeof expected !== "string" || typeof current !== "string")
        return false;
    const name = /^\$\{([A-Z0-9_]+)\}$/u.exec(expected)?.[1];
    return name !== undefined && env[name] !== undefined && env[name] === current;
}
function exactObjectPatch(current, expected, gatewayEnv) {
    const existing = isRecord(current) ? current : {};
    const patch = {};
    for (const key of Object.keys(existing)) {
        if (!Object.prototype.hasOwnProperty.call(expected, key))
            patch[key] = null;
    }
    for (const [key, value] of Object.entries(expected)) {
        if (isRecord(value))
            patch[key] = exactObjectPatch(existing[key], value, gatewayEnv);
        else if (!resolvesToEnvPlaceholder(existing[key], value, gatewayEnv)) {
            patch[key] = Array.isArray(value) ? [...value] : value;
        }
    }
    return patch;
}
function isSecretRef(value) {
    return isRecord(value) && ["env", "file", "exec"].includes(String(value.source));
}
function escapedJsonPointerSegment(value) {
    return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}
function agentIdAtSecretRefPath(config, segments) {
    if (segments[0] !== "agents")
        return null;
    if (segments[1] === "entries" && typeof segments[2] === "string")
        return segments[2];
    if (segments[1] !== "list" || !/^\d+$/u.test(segments[2] ?? ""))
        return null;
    const agents = isRecord(config.agents) && Array.isArray(config.agents.list)
        ? config.agents.list
        : [];
    const agent = agents[Number(segments[2])];
    return isRecord(agent) && typeof agent.id === "string" ? agent.id : null;
}
function expectedUserSecretRef(config, segments) {
    if (segments.join(".") === "database.postgres.connection") {
        return { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" };
    }
    if (segments.length === 5 &&
        segments[0] === "channels" &&
        segments[1] === "mattermost" &&
        segments[2] === "accounts" &&
        segments[4] === "botToken") {
        const accountId = segments[3];
        return {
            source: "file",
            provider: "octogee-mattermost",
            id: `/${escapedJsonPointerSegment(accountId)}`,
        };
    }
    const agentId = agentIdAtSecretRefPath(config, segments);
    const suffix = segments.slice(3).join(".");
    if (agentId &&
        (suffix === "memorySearch.remote.apiKey" || suffix === "memory.search.remote.apiKey")) {
        return {
            source: "exec",
            provider: "gcp-secret-manager",
            id: `agent-embedding-token-openai-${agentId}`,
        };
    }
    return null;
}
function sanitizeSecretValue(value, config, segments) {
    if (isSecretRef(value)) {
        const expected = expectedUserSecretRef(config, segments);
        if (!expected)
            return { changed: true, remove: true };
        return {
            value: expected,
            changed: JSON.stringify(value) !== JSON.stringify(expected),
        };
    }
    if (Array.isArray(value)) {
        let changed = false;
        const next = value.flatMap((entry, index) => {
            const sanitized = sanitizeSecretValue(entry, config, [...segments, String(index)]);
            changed = changed || sanitized.changed;
            return sanitized.remove ? [] : [sanitized.value ?? entry];
        });
        return { value: changed ? next : value, changed };
    }
    if (!isRecord(value))
        return { value, changed: false };
    let changed = false;
    const next = { ...value };
    for (const [key, child] of Object.entries(value)) {
        if (segments.length === 1 && segments[0] === "secrets" && key === "providers")
            continue;
        const sanitized = sanitizeSecretValue(child, config, [...segments, key]);
        if (!sanitized.changed)
            continue;
        changed = true;
        if (sanitized.remove)
            delete next[key];
        else
            next[key] = sanitized.value;
    }
    return { value: changed ? next : value, changed };
}
function secretRefChildPatch(child, config, segments) {
    if (isSecretRef(child)) {
        const expected = expectedUserSecretRef(config, segments);
        if (!expected)
            return { changed: true, value: null };
        if (JSON.stringify(child) === JSON.stringify(expected))
            return { changed: false };
        return { changed: true, value: exactObjectPatch(child, expected) };
    }
    if (Array.isArray(child)) {
        const sanitized = sanitizeSecretValue(child, config, segments);
        return sanitized.changed ? { changed: true, value: sanitized.value } : { changed: false };
    }
    if (!isRecord(child))
        return { changed: false };
    const nested = secretRefRemovalPatch(child, config, segments);
    return isRecord(nested) && Object.keys(nested).length > 0
        ? { changed: true, value: nested }
        : { changed: false };
}
function secretRefRemovalPatch(value, config, segments) {
    if (!isRecord(value))
        return undefined;
    const patch = {};
    for (const [key, child] of Object.entries(value)) {
        if (segments.length === 1 && segments[0] === "secrets" && key === "providers")
            continue;
        const childSegments = [...segments, key];
        const childPatch = secretRefChildPatch(child, config, childSegments);
        if (childPatch.changed)
            patch[key] = childPatch.value;
    }
    return patch;
}
function recordChild(value, key) {
    return isRecord(value) && isRecord(value[key]) ? value[key] : {};
}
function toolModelList(config, tool) {
    const models = recordChild(recordChild(config, "tools"), tool).models;
    return Array.isArray(models) ? models : null;
}
function commandFreeModels(models, rejectCli) {
    return models?.filter((model) => isRecord(model) && (!rejectCli || model.type !== "cli") &&
        !Object.prototype.hasOwnProperty.call(model, "command")) ?? null;
}
function safeHookMappings(config) {
    const mappings = recordChild(config, "hooks").mappings;
    if (!Array.isArray(mappings))
        return null;
    return mappings.map((mapping) => {
        if (!isRecord(mapping) || !Object.prototype.hasOwnProperty.call(mapping, "transform")) {
            return mapping;
        }
        const next = { ...mapping };
        delete next.transform;
        return next;
    });
}
function userSecretProviderPatch(config) {
    const existing = recordChild(recordChild(config, "secrets"), "providers");
    return {
        ...Object.fromEntries(Object.keys(existing)
            .filter((providerId) => !Object.hasOwn(USER_SECRET_PROVIDERS, providerId))
            .map((providerId) => [providerId, null])),
        ...Object.fromEntries(Object.entries(USER_SECRET_PROVIDERS).map(([providerId, expected]) => [
            providerId,
            exactObjectPatch(existing[providerId], expected),
        ])),
    };
}
function userSecretRefsPatch(config) {
    return Object.fromEntries(Object.entries(config).flatMap(([key, value]) => {
        const patch = secretRefRemovalPatch(value, config, [key]);
        return isRecord(patch) && Object.keys(patch).length > 0 ? [[key, patch]] : [];
    }));
}
function platformAgentAccountIds(config) {
    const agents = recordChild(config, "agents");
    const ids = new Set();
    const add = (agentId) => {
        const accountId = typeof agentId === "string" ? mattermostAccountIdForAgentId(agentId) : null;
        if (accountId)
            ids.add(accountId);
    };
    if (Array.isArray(agents.list)) {
        for (const entry of agents.list)
            add(isRecord(entry) ? entry.id : undefined);
    }
    for (const agentId of Object.keys(recordChild(agents, "entries")))
        add(agentId);
    return ids;
}
function platformAgentDirectMessagePatch(config) {
    const accounts = recordChild(recordChild(recordChild(config, "channels"), "mattermost"), "accounts");
    const managed = platformAgentAccountIds(config);
    const patch = {};
    for (const [accountId, entry] of Object.entries(accounts)) {
        if (!managed.has(accountId) || !isRecord(entry) || entry.dmPolicy === "disabled")
            continue;
        patch[accountId] = { dmPolicy: "disabled" };
    }
    return Object.keys(patch).length > 0 ? { channels: { mattermost: { accounts: patch } } } : {};
}
function userToolsProjectionPatch(config) {
    const patch = {};
    const mediaModels = toolModelList(config, "media");
    const safeMediaModels = commandFreeModels(mediaModels, true);
    if (mediaModels && safeMediaModels && safeMediaModels.length !== mediaModels.length) {
        patch.media = { models: safeMediaModels };
    }
    const linkModels = toolModelList(config, "links");
    const safeLinkModels = commandFreeModels(linkModels, false);
    if (linkModels && safeLinkModels && safeLinkModels.length !== linkModels.length) {
        patch.links = { models: safeLinkModels };
    }
    return patch;
}
function userModelsProjectionPatch(providerEntries, modelProviders) {
    return Object.keys(providerEntries).length > 0 || Object.keys(modelProviders.patch).length > 0
        ? { models: { providers: modelProviders.patch } }
        : {};
}
function userCommandSurfaceRemovalPatch(config) {
    const patch = {};
    const hooks = recordChild(config, "hooks");
    const internalHooks = recordChild(hooks, "internal");
    const internalLoad = recordChild(internalHooks, "load");
    const hookPatch = {};
    if (hooks.transformsDir !== undefined && hooks.transformsDir !== null)
        hookPatch.transformsDir = null;
    if (internalHooks.handlers !== undefined && internalHooks.handlers !== null) {
        hookPatch.internal = { handlers: null };
    }
    if (internalLoad.extraDirs !== undefined && internalLoad.extraDirs !== null) {
        hookPatch.internal = mergeConfigPatches(isRecord(hookPatch.internal) ? hookPatch.internal : {}, { load: { extraDirs: null } });
    }
    if (Object.keys(hookPatch).length > 0)
        patch.hooks = hookPatch;
    const qmd = recordChild(recordChild(config, "memory"), "qmd");
    if (qmd.command !== undefined && qmd.command !== null) {
        patch.memory = { qmd: { command: null } };
    }
    const installPolicy = recordChild(recordChild(config, "security"), "installPolicy");
    if (installPolicy.exec !== undefined && installPolicy.exec !== null) {
        patch.security = { installPolicy: { exec: null } };
    }
    return patch;
}
function userSecurityProjectionPatch(current, gatewayEnv) {
    const config = isRecord(current) ? current : {};
    const pluginEntries = recordChild(recordChild(config, "plugins"), "entries");
    const pluginEntryPatch = exactObjectPatch(pluginEntries, userPluginEntries(), gatewayEnv);
    const providerEntries = recordChild(recordChild(config, "models"), "providers");
    const modelProviders = userModelProvidersPlan(providerEntries, gatewayEnv);
    const hookMappings = safeHookMappings(config);
    return mergeConfigPatches(userSecretRefsPatch(config), userCommandSurfaceRemovalPatch(config), platformAgentDirectMessagePatch(config), {
        plugins: {
            enabled: true,
            allow: [...USER_APPROVED_PLUGINS],
            entries: pluginEntryPatch,
            load: null,
            installs: null,
        },
        secrets: { providers: userSecretProviderPatch(config) },
        ...(hookMappings ? { hooks: { mappings: hookMappings } } : {}),
        cron: {
            webhookToken: null,
            webhookAuth: null,
            failureAlert: null,
            failureAlerts: null,
        },
        ...userModelsProjectionPatch(providerEntries, modelProviders),
        tools: userToolsProjectionPatch(config),
    });
}
export function userSecurityProjectionReplacePaths(current) {
    const config = isRecord(current) ? current : {};
    const paths = new Set([
        "plugins.allow",
        "secrets.providers.gcp-secret-manager.passEnv",
        ...arrayReplacePathsForPatch(config, userSecurityProjectionPatch(config)),
    ]);
    if (isRecord(config.tools) && isRecord(config.tools.media) && Array.isArray(config.tools.media.models)) {
        paths.add("tools.media.models");
    }
    if (isRecord(config.tools) && isRecord(config.tools.links) && Array.isArray(config.tools.links.models)) {
        paths.add("tools.links.models");
    }
    if (isRecord(config.hooks) && Array.isArray(config.hooks.mappings)) {
        paths.add("hooks.mappings");
    }
    paths.add("agents.defaults.model.fallbacks");
    paths.add("agents.list[].model.fallbacks");
    if (isRecord(config.agents) && isRecord(config.agents.entries)) {
        for (const agentId of Object.keys(config.agents.entries)) {
            paths.add(`agents.entries.${agentId}.model.fallbacks`);
        }
    }
    return [...paths];
}
function arrayReplacePathsForPatch(current, patch, prefix = "") {
    if (Array.isArray(patch))
        return prefix ? [prefix] : [];
    if (patch === null)
        return arrayPathsUnder(current, prefix);
    if (!isRecord(patch) || !isRecord(current))
        return [];
    return Object.entries(patch).flatMap(([key, childPatch]) => arrayReplacePathsForPatch(current[key], childPatch, prefix ? `${prefix}.${key}` : key));
}
function arrayPathsUnder(value, prefix) {
    if (Array.isArray(value))
        return prefix ? [prefix] : [];
    if (!isRecord(value))
        return [];
    return Object.entries(value).flatMap(([key, child]) => arrayPathsUnder(child, prefix ? `${prefix}.${key}` : key));
}
function safeOwnedAgentPatch(value, safeModelRef, forceSafeModel) {
    const record = isRecord(value) ? value : {};
    const models = catalogModelMapPlan(record.models);
    const agentRuntime = recordChild(record, "agentRuntime");
    const directRuntime = isDirectAgentRuntimeId(agentRuntime?.id);
    const hasSelection = Object.prototype.hasOwnProperty.call(record, "model");
    const normalizedSelection = hasSelection ? normalizedCatalogSelection(record.model) : null;
    const unsafeSelection = hasSelection && normalizedSelection === null;
    const pinToSafe = unsafeSelection || (forceSafeModel && !hasSelection);
    const affected = [pinToSafe, directRuntime, models.changed].some(Boolean);
    const modelPatch = {};
    if (pinToSafe) {
        modelPatch.model = { primary: safeModelRef, fallbacks: [] };
    }
    else if (normalizedSelection && JSON.stringify(record.model) !== JSON.stringify(normalizedSelection)) {
        modelPatch.model = normalizedSelection;
    }
    const patch = { ...modelPatch };
    if (models.patch)
        patch.models = models.patch;
    if (directRuntime)
        patch.agentRuntime = null;
    return { patch, affected, directRuntimeModelRefs: models.removedRefs };
}
function userDefaultRuntimePlan(defaults, safeModelRef, forceSafeModel) {
    const models = catalogModelMapPlan(defaults.models, safeModelRef);
    const hasModel = Object.prototype.hasOwnProperty.call(defaults, "model");
    const normalizedModel = hasModel ? normalizedCatalogSelection(defaults.model) : null;
    const unsafeModel = hasModel && normalizedModel === null;
    const unsafeRuntime = isRecord(defaults.agentRuntime) &&
        isDirectAgentRuntimeId(defaults.agentRuntime.id);
    const pinToSafe = unsafeModel || (forceSafeModel && !hasModel);
    const patch = { models: models.patch };
    if (pinToSafe) {
        patch.model = { primary: safeModelRef, fallbacks: [] };
    }
    else if (normalizedModel && JSON.stringify(defaults.model) !== JSON.stringify(normalizedModel)) {
        patch.model = normalizedModel;
    }
    if (unsafeRuntime)
        patch.agentRuntime = null;
    return {
        patch,
        affected: pinToSafe || unsafeRuntime || models.changed,
        directRuntimeModelRefs: models.removedRefs,
    };
}
function ownedAgentRuntimePlans(entries, slug, safeModelRef, forceSafeModel) {
    const patches = [];
    const affectedAgentIds = [];
    const directRuntimeModelRefs = [];
    for (const [agentId, entry] of entries) {
        if (!agentIdBelongsToSlug(agentId, slug))
            continue;
        const planned = safeOwnedAgentPatch(entry, safeModelRef, forceSafeModel);
        if (!planned.affected)
            continue;
        patches.push([agentId, planned.patch]);
        affectedAgentIds.push(agentId);
        directRuntimeModelRefs.push(...planned.directRuntimeModelRefs);
    }
    return { patches, affectedAgentIds, directRuntimeModelRefs };
}
function listedAgentEntries(agents) {
    const list = Array.isArray(agents.list) ? agents.list : [];
    return list.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" ? [[entry.id, entry]] : []);
}
function oauthModelProviderRemovalPatch(config) {
    const providers = recordChild(recordChild(config, "models"), "providers");
    return Object.fromEntries(Object.keys(providers)
        .filter((provider) => provider === "claude-cli" || provider === "openai-codex")
        .map((provider) => [provider, null]));
}
function userOauthRuntimeConfigPlan(current, slug, safeModelRef, forceSafeAll, gatewayEnv) {
    const affectedAgentIds = new Set();
    const config = isRecord(current) ? current : {};
    const agents = recordChild(config, "agents");
    const ownedAgentIds = agentIdsForSlug(slug, current);
    const defaults = recordChild(agents, "defaults");
    const providerEntries = recordChild(recordChild(config, "models"), "providers");
    const forceSafeOwnedAgents = forceSafeAll || userModelProvidersPlan(providerEntries, gatewayEnv).unsafe;
    if (!catalogEntryForModelRef(safeModelRef)) {
        throw new Error(`user runtime purge: safe model is outside the platform catalog (${safeModelRef})`);
    }
    const defaultPlan = userDefaultRuntimePlan(defaults, safeModelRef, forceSafeOwnedAgents);
    const directRuntimeModelRefs = new Set(defaultPlan.directRuntimeModelRefs);
    if (defaultPlan.affected) {
        ownedAgentIds.forEach((agentId) => affectedAgentIds.add(agentId));
    }
    const listPlans = ownedAgentRuntimePlans(listedAgentEntries(agents), slug, safeModelRef, forceSafeOwnedAgents);
    const listPatch = listPlans.patches.map(([id, patch]) => ({ id, ...patch }));
    const entries = recordChild(agents, "entries");
    const entryPlans = ownedAgentRuntimePlans(Object.entries(entries), slug, safeModelRef, forceSafeOwnedAgents);
    for (const agentId of [...listPlans.affectedAgentIds, ...entryPlans.affectedAgentIds]) {
        affectedAgentIds.add(agentId);
    }
    for (const modelRef of [...listPlans.directRuntimeModelRefs, ...entryPlans.directRuntimeModelRefs]) {
        directRuntimeModelRefs.add(modelRef);
    }
    const entriesPatch = Object.fromEntries(entryPlans.patches);
    const authProfiles = authProfileRemovalPatch(recordChild(config, "auth").profiles);
    const modelProviders = oauthModelProviderRemovalPatch(config);
    const oauthPatch = {
        agents: {
            defaults: defaultPlan.patch,
            ...(listPatch.length > 0 ? { list: listPatch } : {}),
            ...(Object.keys(entriesPatch).length > 0 ? { entries: entriesPatch } : {}),
        },
        ...(authProfiles ? { auth: { profiles: authProfiles } } : {}),
        ...(Object.keys(modelProviders).length > 0
            ? { models: { providers: modelProviders } }
            : {}),
    };
    return { patch: mergeConfigPatches(oauthPatch, userSecurityProjectionPatch(current, gatewayEnv)),
        affectedAgentIds: [...affectedAgentIds],
        directRuntimeModelRefs: [...directRuntimeModelRefs],
    };
}
export function userOauthRuntimeConfigPatch(current, slug, safeModelRef, opts) {
    return userOauthRuntimeConfigPlan(current, slug, safeModelRef, opts?.forceSafeAll === true, opts?.gatewayEnv).patch;
}
export function userMountConfigPatch(current, mountPatch, slug, safeModelRef, opts) {
    const candidate = mergeConfigPatches(isRecord(current) ? current : {}, mountPatch);
    const security = userOauthRuntimeConfigPlan(candidate, slug, safeModelRef, opts?.forceSafeAll === true, opts?.gatewayEnv).patch;
    const candidateAgents = recordChild(candidate, "agents");
    const securityAgents = recordChild(security, "agents");
    const projectAgent = (id, entry, patch) => {
        const projected = mergeConfigPatches(isRecord(entry) ? entry : {}, isRecord(patch) ? patch : {});
        if (agentIdBelongsToSlug(id, slug) && isRecord(entry)) {
            const model = normalizedCatalogSelection(entry.model);
            if (model)
                projected.model = model;
        }
        return projected;
    };
    if (Array.isArray(candidateAgents.list)) {
        const patches = new Map(listedAgentEntries(securityAgents));
        securityAgents.list = candidateAgents.list.map((entry) => isRecord(entry) && typeof entry.id === "string"
            ? projectAgent(entry.id, entry, patches.get(entry.id))
            : entry);
    }
    if (isRecord(candidateAgents.entries)) {
        const entries = candidateAgents.entries;
        const patches = recordChild(securityAgents, "entries");
        const mounted = recordChild(recordChild(mountPatch, "agents"), "entries");
        securityAgents.entries = Object.fromEntries([...new Set([
                ...Object.keys(mounted), ...Object.keys(patches),
            ])].map((id) => [id, projectAgent(id, entries[id], patches[id])]));
    }
    return mergeConfigPatches(mountPatch, security);
}
function userAgentIds(slug, config) {
    const agentIds = agentIdsForSlug(slug, config);
    return agentIds.length > 0 ? agentIds : [`octogee-${slug}-coach`];
}
async function applyUserOauthPurgeConfig(slug, safeModelRef, forceSafeAll, applyConfigPatchFn) {
    return applyConfigPatchFn({
        buildPatch: (current) => userOauthRuntimeConfigPatch(current, slug, safeModelRef, {
            forceSafeAll,
            gatewayEnv: process.env,
        }),
        buildReplacePaths: userSecurityProjectionReplacePaths,
        logPrefix: `[customer-oauth-purge:${slug}]`,
        skipIfAlreadyApplied: true,
    }, { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS });
}
async function resetAffectedOauthSessions(affectedAgentIds, suppliedRpc) {
    const rpc = suppliedRpc ?? createGatewayRpc({
        allowLegacyGatewayTokenFallback: true,
        connectTimeoutMs: 10_000,
        callTimeoutMs: 10_000,
    });
    let resetCount = 0;
    try {
        for (const agentId of affectedAgentIds) {
            const response = await rpc.sessionsList({ agentId });
            for (const session of response.sessions.filter((candidate) => candidate.agentId === agentId)) {
                await rpc.sessionsReset({ key: session.key, agentId, reason: "reset" });
                resetCount++;
            }
        }
    }
    finally {
        if (!suppliedRpc)
            await rpc.close();
    }
    return resetCount;
}
function oauthArtifactsChanged(artifacts) {
    return [
        artifacts.removedFiles,
        artifacts.removedDirectories,
        artifacts.scrubbedProfileStores,
        artifacts.resetSessions,
    ].some((count) => count > 0);
}
export async function purgeUserOauthRuntime(slug, safeModelRef, deps) {
    const options = deps ?? {};
    const config = options.config ?? readOpenClawConfig();
    const agentIds = userAgentIds(slug, config);
    const forceSafeAll = options.forceSafeAll === true;
    const initialConfigPlan = userOauthRuntimeConfigPlan(config, slug, safeModelRef, forceSafeAll);
    const openclawDir = options.openclawDir ?? OPENCLAW_DIR;
    const sharedProfilesRemoved = await sharedAuthStoreUsable(openclawDir) &&
        await removeSubscriptionProfiles(sharedAuthAgentDir(openclawDir), SUBSCRIPTION_PROVIDERS);
    const artifacts = await purgeUserOauthRuntimeArtifacts({
        openclawDir,
        homeDir: options.homeDir ?? os.homedir(),
        agentIds,
        resetSessionStores: false,
        directRuntimeModelRefs: initialConfigPlan.directRuntimeModelRefs,
        allowedModelRefs: platformModelRefs(),
        allowedProviderIds: ["anthropic", "platform-openrouter", "platform-openai", "platform-vertex", ...(process.env.PLATFORM_META_BASE_URL?.trim() ? ["platform-meta"] : [])],
        modelProviders: userBrokerModelProviders(),
    });
    const configResult = await applyUserOauthPurgeConfig(slug, safeModelRef, forceSafeAll, options.applyConfigPatch ?? applyConfigPatch);
    const affectedAgentIds = new Set([
        ...artifacts.affectedAgentIds,
        ...initialConfigPlan.affectedAgentIds,
    ]);
    const resetCount = await resetAffectedOauthSessions(affectedAgentIds, options.rpc);
    options.logFn?.(`[byot-sync] ${slug}: purged user OAuth runtime artifacts for ${agentIds.length} agent(s); reset ${resetCount} session(s)`);
    const changed = [
        sharedProfilesRemoved,
        oauthArtifactsChanged(artifacts),
        configResult.noop !== true,
        resetCount > 0,
    ]
        .some(Boolean);
    return { changed, resetCount };
}
function mountedAgentIdsForSlug(slug) {
    try {
        const mounted = agentIdsForSlug(slug, readOpenClawConfig());
        return mounted.length > 0 ? mounted : [`octogee-${slug}-coach`];
    }
    catch (error) {
        log(`⚠ [byot-sync] failed to enumerate mounted agents for ${slug}: ${error.message}`);
        return [`octogee-${slug}-coach`];
    }
}
async function materializePlatformBrokerSurfaces(slug) {
    const baseUrl = configuredOpenRouterBaseUrl();
    const openAiBaseUrl = configuredPlatformOpenAiBaseUrl();
    const vertexBaseUrl = configuredPlatformVertexBaseUrl();
    const result = await materializeBrokerProfilesForAgents(mountedAgentIdsForSlug(slug), {
        agentsDir: AGENTS_DIR,
        openRouter: baseUrl ? openRouterCatalogInputForBaseUrl(baseUrl) : undefined,
        openAi: openAiBaseUrl ? openAiCatalogInputForBaseUrl(openAiBaseUrl) : undefined,
        meta: process.env.PLATFORM_META_BASE_URL ? metaCatalogInputForBaseUrl(process.env.PLATFORM_META_BASE_URL) : undefined,
        vertex: vertexBaseUrl ? vertexCatalogInputForBaseUrl(vertexBaseUrl) : undefined,
        logFn: log,
    });
    if (result.deferred.length > 0) {
        log(`[byot-sync] ${slug}: broker profile deferred for ${result.deferred.join(", ")}` +
            ` — openclaw refused the secrets apply; the level-triggered sweep retries it`);
    }
    const allowlistChanged = await applyPlatformModelAllowlist();
    return result.materialized > 0 || allowlistChanged;
}
export const PLATFORM_MODEL_POLICY_ALLOW_PATH = "agents.defaults.modelPolicy.allow";
export function platformModelAllowlistPatch(current, user) {
    const existing = current?.agents?.defaults?.models;
    const models = Object.fromEntries(platformModelRefs().map((ref) => [ref, canonicalUserModelDefinition(ref)]));
    for (const ref of Object.keys(isRecord(existing) ? existing : {})) {
        if (isPlatformProviderRef(ref) && !Object.prototype.hasOwnProperty.call(models, ref))
            models[ref] = null;
    }
    return { agents: { defaults: {
                models,
                modelPolicy: { allow: user ? [] : ["anthropic/*", "platform-openrouter/*", "platform-openai/*", "platform-vertex/*", ...(process.env.PLATFORM_META_BASE_URL?.trim() ? ["platform-meta/*"] : [])] },
            } } };
}
export async function applyPlatformModelAllowlist(applyConfigPatchFn = applyConfigPatch, user = isIsolatedGateway()) {
    const result = await applyConfigPatchFn({
        buildPatch: (current) => platformModelAllowlistPatch(current, user),
        buildReplacePaths: () => [PLATFORM_MODEL_POLICY_ALLOW_PATH],
        skipIfAlreadyApplied: true,
        logPrefix: "[byot-sync:platform-models]",
    }, { maxRetries: Number.POSITIVE_INFINITY, totalDeadlineMs: BYOT_RUNTIME_BOOT_PATIENCE_MS });
    return result.noop !== true;
}
function configuredOpenRouterBaseUrl() {
    const raw = process.env.OPENROUTER_BASE_URL?.trim();
    return raw || null;
}
// Deliberately NOT OPENAI_BASE_URL — that name would repoint BYOK-openai and
// the embeddings flows at the broker. This env only feeds the platform-openai
// broker provider profile.
function configuredPlatformOpenAiBaseUrl() {
    const raw = process.env.PLATFORM_OPENAI_BASE_URL?.trim();
    return raw || null;
}
function userBrokerModelProviders() {
    const providers = {};
    const openRouterBaseUrl = configuredOpenRouterBaseUrl();
    if (openRouterBaseUrl) {
        Object.assign(providers, openRouterBrokerCatalogJson("customer", openRouterCatalogInputForBaseUrl(openRouterBaseUrl)).providers);
    }
    const openAiBaseUrl = configuredPlatformOpenAiBaseUrl();
    if (openAiBaseUrl) {
        const input = openAiCatalogInputForBaseUrl(openAiBaseUrl);
        providers["platform-openai"] = {
            api: "openai-responses",
            baseUrl: input.baseUrl,
            models: input.models.map(openRouterBrokerModelConfig),
        };
    }
    const vertexBaseUrl = configuredPlatformVertexBaseUrl();
    if (vertexBaseUrl) {
        const input = vertexCatalogInputForBaseUrl(vertexBaseUrl);
        providers["platform-vertex"] = {
            api: "anthropic-messages",
            baseUrl: input.baseUrl,
            models: input.models.map(openRouterBrokerModelConfig),
        };
    }
    const metaBaseUrl = process.env.PLATFORM_META_BASE_URL?.trim();
    if (metaBaseUrl) {
        const input = metaCatalogInputForBaseUrl(metaBaseUrl);
        providers["platform-meta"] = {
            api: "openai-responses",
            baseUrl: input.baseUrl,
            models: input.models.map(openRouterBrokerModelConfig),
        };
    }
    return providers;
}
// eslint-disable-next-line complexity -- Dependency injection defaults are intentionally centralized for runtime and tests.
function syncActions(deps) {
    const patchDeps = deps?.applyConfigPatch
        ? { applyConfigPatch: deps.applyConfigPatch, logFn: deps.logFn }
        : undefined;
    return {
        applyByotState: deps?.applyByotState ?? applyByotState,
        restoreOauthStoreForSlug: deps?.restoreOauthStoreForSlug ?? restoreOauthStoreForSlug,
        applyDefaultAgentModelPatch: deps?.applyDefaultAgentModelPatch ?? ((input) => applyDefaultAgentModelPatch(input, patchDeps)),
        applyDefaultAgentToolsConvergence: deps?.applyDefaultAgentToolsConvergence ??
            ((slug, houseOnly) => applyDefaultAgentToolsConvergence(slug, houseOnly, patchDeps)),
        applyOauthRuntimeModelAllowlist: deps?.applyOauthRuntimeModelAllowlist ??
            ((providers, codexAppServer) => applyOauthRuntimeModelAllowlist(providers, codexAppServer, patchDeps)),
        requestGatewayRestart: deps?.requestGatewayRestart ?? requestGatewayRestartForRuntimeChange,
        triggerSecretsReload: deps?.triggerSecretsReload ?? triggerSecretsReload,
        materializePlatformBrokerSurfaces: deps?.materializePlatformBrokerSurfaces ?? materializePlatformBrokerSurfaces,
        purgeUserOauthRuntime: deps?.purgeUserOauthRuntime ??
            ((slug, safeModelRef, purgeDeps) => purgeUserOauthRuntime(slug, safeModelRef, {
                ...(deps?.applyConfigPatch ? { applyConfigPatch: deps.applyConfigPatch } : {}),
                ...(deps?.logFn ? { logFn: deps.logFn } : {}),
                ...(purgeDeps?.forceSafeAll ? { forceSafeAll: true } : {}),
            })),
        applyAgentModelOverrides: deps?.applyAgentModelOverrides ??
            ((slug, agentModels, opts) => applyAgentModelOverrides(slug, agentModels, opts, patchDeps)),
        hasPendingPlatformCatalogRestart: deps?.hasPendingPlatformCatalogRestart ?? hasPendingPlatformCatalogRestart,
        markPlatformCatalogRestartPending: deps?.markPlatformCatalogRestartPending ?? markPlatformCatalogRestartPending,
        clearPlatformCatalogRestartPending: deps?.clearPlatformCatalogRestartPending ?? clearPlatformCatalogRestartPending,
    };
}
async function applyRestoredOauthRuntimeAllowlist(slug, restore, actions, codexAppServer) {
    if (!restore.present)
        return { patched: false, changed: false, restartRequired: false };
    const result = await actions.applyOauthRuntimeModelAllowlist(restore.providers ?? [], codexAppServer);
    if (restore.providers?.includes("openai")) {
        const rpc = createGatewayRpc({ allowLegacyGatewayTokenFallback: true, connectTimeoutMs: 10_000, callTimeoutMs: 10_000 });
        try {
            await rpc.modelsAuthRefresh({ agentId: `octogee-${slug}-coach` });
        }
        finally {
            await rpc.close();
        }
    }
    return result;
}
async function requestRestartIfRequired(runtimePatch, actions, reason, platformCatalogRestartPending = false) {
    if (!runtimePatch.restartRequired && !platformCatalogRestartPending)
        return false;
    const requested = await actions.requestGatewayRestart(platformCatalogRestartPending ? "platform-model-catalog" : reason);
    if (requested && platformCatalogRestartPending) {
        actions.clearPlatformCatalogRestartPending();
    }
    return requested;
}
async function materializePlatformCatalog(slug, actions) {
    const changed = await actions.materializePlatformBrokerSurfaces(slug);
    if (changed)
        actions.markPlatformCatalogRestartPending();
    return {
        changed,
        restartPending: changed || actions.hasPendingPlatformCatalogRestart(),
    };
}
function isBrokerResolvedAnthropic(desired, usesBrokerToken) {
    return usesBrokerToken && desired.input?.provider === "anthropic";
}
async function clearBrokerResolvedAnthropic(slug, actions, userOauthRuntimeChanged = false) {
    const changed = await actions.applyByotState(slug, null);
    const catalog = await materializePlatformCatalog(slug, actions);
    log(`[byot-sync] ${slug}: anthropic BYOT is broker-resolved; local provider-key refs removed`);
    const restartRequested = await requestRestartIfRequired({ patched: false, changed: false, restartRequired: false }, actions, undefined, catalog.restartPending);
    if ((changed || catalog.changed || catalog.restartPending || userOauthRuntimeChanged) &&
        !restartRequested) {
        await actions.triggerSecretsReload();
    }
}
async function restoreOauthIfNeeded(slug, desired, actions) {
    const provider = desired.input?.provider;
    if (!provider || !isModelCredentialOauthProvider(provider)) {
        return { restored: false, present: true };
    }
    return actions.restoreOauthStoreForSlug(slug);
}
async function syncStandardByotState(slug, desired, actions, opts) {
    const changed = opts?.purgeAuthProfileStore
        ? await actions.applyByotState(slug, desired.input, undefined, { preserveAuthProfileStore: false })
        : await actions.applyByotState(slug, desired.input);
    const restore = await restoreOauthIfNeeded(slug, desired, actions);
    const runtimePatched = await applyRestoredOauthRuntimeAllowlist(slug, restore, actions, STANDARD_CODEX_APP_SERVER);
    const patched = restore.present && desired.defaultAgentModelInput
        ? await actions.applyDefaultAgentModelPatch(desired.defaultAgentModelInput)
        : false;
    const catalogRestartPending = actions.hasPendingPlatformCatalogRestart();
    const restartRequested = await requestRestartIfRequired(runtimePatched, actions, undefined, catalogRestartPending);
    if ((changed ||
        restore.restored ||
        runtimePatched.patched ||
        patched ||
        catalogRestartPending ||
        opts?.userOauthRuntimeChanged) &&
        !restartRequested) {
        await actions.triggerSecretsReload();
    }
}
async function syncUserByotState(slug, desired, actions) {
    const restore = await restoreOauthIfNeeded(slug, desired, actions);
    const catalog = await materializePlatformCatalog(slug, actions);
    const runtimePatched = await applyRestoredOauthRuntimeAllowlist(slug, restore, actions, ISOLATED_CODEX_APP_SERVER);
    const patched = restore.present && desired.defaultAgentModelInput
        ? await actions.applyDefaultAgentModelPatch(desired.defaultAgentModelInput)
        : false;
    const restartRequested = await requestRestartIfRequired(runtimePatched, actions, undefined, catalog.restartPending);
    if ((restore.restored || catalog.changed || catalog.restartPending || runtimePatched.patched || patched) &&
        !restartRequested) {
        await actions.triggerSecretsReload();
    }
}
function gateUserModelCredentials(shared, desired, userData, logFn) {
    const provider = desired.input?.provider;
    if (!provider || (!shared && !isModelCredentialOauthProvider(provider))) {
        return { desired, suppressed: false };
    }
    const slug = userData.username ?? "";
    const reason = shared
        ? `user credentials stay off a shared gateway; serving the platform broker profile with the owner's tier grant`
        : `OAuth agent runtimes cannot preserve verified turn authority; serving the platform broker profile with the owner's tier grant`;
    const credential = isModelCredentialOauthProvider(provider) ? "byosub" : "byok";
    logFn(`[byot-sync] ${slug}: ${credential} (${provider}) suppressed on ${shared ? "a shared gateway" : "user gateway"} — ${reason}`);
    return {
        desired: {
            enabled: false,
            input: null,
            defaultAgentModelInput: platformDefaultAgentModelInputForUser(slug, userData),
        },
        suppressed: true,
    };
}
async function syncSharedBrokerByotState(slug, desired, actions, userOauthRuntimeChanged) {
    const changed = await actions.applyByotState(slug, null, undefined, {
        preserveAuthProfileStore: true,
    });
    const catalogChanged = await actions.materializePlatformBrokerSurfaces(slug);
    const patched = desired.defaultAgentModelInput
        ? await actions.applyDefaultAgentModelPatch(desired.defaultAgentModelInput)
        : false;
    if (changed || catalogChanged || patched || userOauthRuntimeChanged) {
        await actions.triggerSecretsReload();
    }
}
function userByotGate(user, shared, desired, userData, logFn) {
    if (user)
        return { desired, suppressed: false };
    return gateUserModelCredentials(shared, desired, userData, logFn);
}
function safeUserModelRef(userData, houseOnly) {
    if (houseOnly)
        return DEFAULT_HOUSE_MODEL_REF;
    return parseUserAgentModelDefault(userData.builderAgentDefault)?.primary ??
        DEFAULT_HOUSE_MODEL_REF;
}
async function purgeUserOauthIfRequired(user, slug, safeModelRef, suppressed, actions) {
    if (user)
        return { changed: false, resetCount: 0 };
    return actions.purgeUserOauthRuntime(slug, safeModelRef, { forceSafeAll: suppressed });
}
async function applyUserAgentModelOverrides(slug, userData, desired, actions, opts) {
    const projectAgentDefault = userData.provisioning?.openclaw?.status === "complete"
        ? platformProjectAgentModelForUser(slug, userData)
        : null;
    await actions.applyAgentModelOverrides(slug, agentModelsWithUserDefault(slug, userData, desired, {
        user: opts.user,
        forceSafeDefaultAgentModel: opts.suppressed,
        houseOnly: opts.houseOnly,
        logFn: opts.logFn,
    }), {
        houseOnly: opts.houseOnly && !opts.suppressed,
        ...(projectAgentDefault ? { projectAgentDefault } : {}),
    });
}
export async function syncByotForUser(userData, deps) {
    const isUser = deps?.isIsolatedGateway ?? isIsolatedGateway;
    const isShared = deps?.isSharedGateway ?? isSharedGateway;
    const usesBrokerToken = deps?.usesLlmBrokerToken ?? usesLlmBrokerToken;
    const actions = syncActions(deps);
    const desired = deriveDesiredByotState(userData);
    const slug = userData.username;
    if (!slug)
        return;
    const user = isUser();
    const shared = isShared();
    const logFn = deps?.logFn ?? log;
    const userGate = userByotGate(user, shared, desired, userData, logFn);
    const effectiveDesired = userGate.desired;
    const houseOnly = userEntitlements().policy(userData.planInputs).modelAccess === "house_only";
    const oauthPurge = await purgeUserOauthIfRequired(user, slug, safeUserModelRef(userData, houseOnly), userGate.suppressed, actions);
    await syncByotStateForClass({
        slug,
        desired: effectiveDesired,
        actions,
        shared,
        user,
        usesBrokerToken,
        purgeAuthProfileStore: userGate.suppressed,
        userOauthRuntimeChanged: oauthPurge.changed,
    });
    await convergeDefaultAgentToolsIfNoModelPatch(slug, effectiveDesired, userData, actions);
    await applyUserAgentModelOverrides(slug, userData, effectiveDesired, actions, {
        user,
        suppressed: userGate.suppressed,
        houseOnly,
        logFn,
    });
}
// The operator's user agent default fills in for an agent with no explicit
// pick — exactly the "config default stands" case (catalog plan, no BYOT, no
// house pin). BYOT and house-only agents keep their own model authority, and
// an explicit pick always wins by sitting later in the map.
function agentModelsWithUserDefault(slug, userData, desired, opts) {
    const platformDefault = platformDefaultSelection(userData, opts.houseOnly);
    const explicit = explicitAgentModelSelections(slug, userData, platformDefault, opts);
    const userDefaultAgentId = `octogee-${slug}-coach`;
    if (opts.forceSafeDefaultAgentModel) {
        return forceSafeDefaultAgentSelection(userDefaultAgentId, explicit, platformDefault, opts.houseOnly);
    }
    return stampUserDefaultSelection(userDefaultAgentId, explicit, userData, desired);
}
function platformDefaultSelection(userData, houseOnly) {
    if (houseOnly)
        return { primary: DEFAULT_HOUSE_MODEL_REF, fallbacks: [] };
    return parseUserAgentModelDefault(userData.builderAgentDefault) ?? {
        primary: DEFAULT_HOUSE_MODEL_REF,
        fallbacks: [],
    };
}
function explicitAgentModelSelections(slug, userData, platformDefault, opts) {
    if (opts.user)
        return userData.systemConfig?.agentModels;
    return catalogOnlyAgentModels(slug, userData.systemConfig?.agentModels, platformDefault, opts.logFn);
}
function forceSafeDefaultAgentSelection(userDefaultAgentId, explicit, platformDefault, houseOnly) {
    if (houseOnly) {
        if (!explicit)
            return undefined;
        const { [userDefaultAgentId]: _defaultAgent, ...projectAgentModels } = explicit;
        return Object.keys(projectAgentModels).length > 0 ? projectAgentModels : undefined;
    }
    return {
        ...(explicit ?? {}),
        [userDefaultAgentId]: explicit?.[userDefaultAgentId] ?? platformDefault,
    };
}
function stampUserDefaultSelection(userDefaultAgentId, explicit, userData, desired) {
    if (desired.enabled || desired.defaultAgentModelInput !== null)
        return explicit;
    if (userData.provisioning?.openclaw?.status !== "complete")
        return explicit;
    const stampedPlatformDefault = parseUserAgentModelDefault(userData.builderAgentDefault);
    if (!stampedPlatformDefault)
        return explicit;
    if (explicit?.[userDefaultAgentId])
        return explicit;
    return { [userDefaultAgentId]: stampedPlatformDefault, ...(explicit ?? {}) };
}
function catalogOnlyAgentModels(slug, value, safeDefault, logFn) {
    const parsed = parseAgentModelSelections(value);
    const safe = {};
    if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const agentId of Object.keys(value)) {
            if (agentIdBelongsToSlug(agentId, slug) && !parsed[agentId]) {
                safe[agentId] = safeDefault;
                logFn(`[byot-sync] ${agentId}: malformed model selection reset on user gateway`);
            }
        }
    }
    for (const [agentId, selection] of Object.entries(parsed)) {
        const catalogRefs = [selection.primary, ...selection.fallbacks].filter((ref) => catalogEntryForModelRef(ref) !== null);
        if (catalogRefs.length === 0) {
            safe[agentId] = safeDefault;
            logFn(`[byot-sync] ${agentId}: non-catalog model selection reset on user gateway`);
            continue;
        }
        const [primary, ...fallbacks] = Array.from(new Set(catalogRefs));
        if (primary !== selection.primary || fallbacks.length !== selection.fallbacks.length) {
            logFn(`[byot-sync] ${agentId}: non-catalog model refs removed on user gateway`);
        }
        safe[agentId] = { primary, fallbacks };
    }
    return Object.keys(safe).length > 0 ? safe : undefined;
}
// When a default-agent-model patch ships it converges tools inline; whenever no patch
// will ship — config-default agent (catalog, no BYOK, no pick) OR a
// no-model-override BYOK provider like plain anthropic — the plan-gated tools
// reassert must run standalone, or an upgrade/lapse (and the BYOK carve-out:
// BYOK-active house_only keeps the inherited surface) would never converge.
// The trim target follows the model-pin gate exactly: only the free-tier
// house pin trims, and that pin always ships its own patch.
async function convergeDefaultAgentToolsIfNoModelPatch(slug, desired, userData, actions) {
    const modelPatchWillShip = desired.defaultAgentModelInput != null && byosDefaultAgentConfigPatch(desired.defaultAgentModelInput) != null;
    if (modelPatchWillShip || userData.provisioning?.openclaw?.status !== "complete")
        return;
    const trimTarget = desired.defaultAgentModelInput != null && "source" in desired.defaultAgentModelInput;
    await actions.applyDefaultAgentToolsConvergence(slug, trimTarget);
}
async function syncByotStateForClass(args) {
    const { slug, desired, actions } = args;
    if (args.shared) {
        await syncSharedBrokerByotState(slug, desired, actions, args.userOauthRuntimeChanged);
        return;
    }
    if (isBrokerResolvedAnthropic(desired, args.usesBrokerToken())) {
        await clearBrokerResolvedAnthropic(slug, actions, args.userOauthRuntimeChanged);
        return;
    }
    if (args.user) {
        await syncUserByotState(slug, desired, actions);
        return;
    }
    await syncStandardByotState(slug, desired, actions, {
        purgeAuthProfileStore: args.purgeAuthProfileStore,
        userOauthRuntimeChanged: args.userOauthRuntimeChanged,
    });
}
