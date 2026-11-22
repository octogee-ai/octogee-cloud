import * as fs from "fs";
import * as path from "path";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { catalogEntryForModelRef, OPENAI_PLATFORM_PROVIDER_ID, VERTEX_PLATFORM_PROVIDER_ID, OPENROUTER_PLATFORM_PROVIDER_ID, } from "@octogee/shared/types/agent-models";
import { DEFAULT_HOUSE_MODEL_REF, parseUserAgentModelDefault, } from "@octogee/shared/types/platform-config";
import { buildModelCredentialConfigForProvider, claudeCliRuntimeConfig, codexRuntimeConfig, isModelCredentialOauthProvider, MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS, } from "./model-credential-materializer.js";
import { AGENTS_DIR, log } from "./config.js";
import { deleteAuthProfileStore, readAuthProfileStore, writeAuthProfileStore, } from "./auth-profile-store.js";
function agentIdForSlug(slug) {
    return `octogee-${slug}-coach`;
}
function agentDirForSlug(slug, agentsDir = AGENTS_DIR) {
    return path.join(agentsDir, agentIdForSlug(slug), "agent");
}
// auth-profiles moved to SQLite in openclaw v2026.6.1+ (PR #89102) — we
// write that row directly via auth-profile-store. models.json stayed as a
// file, so it's the only entry in this list.
const BYOT_FILES = ["models.json"];
const BYOT_MARKER = ".byot-managed";
export const HOUSE_MODEL_DEFAULT_AGENT_TOOLS = {
    profile: "minimal",
    alsoAllow: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "web_search",
        "web_fetch",
        "brave_search",
        "tavily_search",
        "tavily_extract",
        "memory_search",
        "memory_get",
        "octogee_chat_search",
        "octogee_chat_history",
        "octogee_chat_set_identity",
        "octogee_connection_request",
        "octogee_ask_ops",
        "octogee_google_calendar_events",
        "octogee_google_calendar_create",
        "octogee_google_calendar_create_approved",
        "octogee_google_calendar_update",
        "octogee_google_calendar_update_approved",
        "octogee_google_calendar_delete",
        "octogee_google_calendar_delete_approved",
        "octogee_google_gmail_search",
        "octogee_google_gmail_get",
        "octogee_google_gmail_triage",
        "octogee_google_gmail_triage_approved",
        "octogee_google_gmail_draft_create",
        "octogee_google_gmail_draft_create_approved",
        "octogee_google_gmail_draft_send",
        "octogee_google_gmail_draft_send_approved",
        "octogee_google_drive_read",
        "octogee_google_docs_read",
        "octogee_google_docs_write",
        "octogee_google_contacts_read",
        "octogee_google_tasks_lists",
        "octogee_google_tasks_list",
        "octogee_google_tasks_add",
        "octogee_google_tasks_add_approved",
        "octogee_google_tasks_update",
        "octogee_google_tasks_update_approved",
        "octogee_google_sheets_read",
        "octogee_google_sheets_write",
        "octogee_obsidian_read",
        "octogee_obsidian_write",
        "octogee_owner_automations",
        "octogee_project_create",
        "octogee_project_list",
        "workspace_commit",
        "octogee_project_commit",
        "octogee_project_capability",
        "octogee_project_build",
        "octogee_project_test",
        "octogee_project_preview",
        "octogee_project_run_status",
        "octogee_project_publish",
        "octogee_project_services",
        "octogee_project_attach_services",
        "octogee_project_deploy_rules",
        "octogee_project_enable_database",
        "octogee_project_deploy_database",
        "octogee_project_restore_database",
        "octogee_project_set_recipe",
        "octogee_board_list",
        "octogee_board_card_read",
        "octogee_board_card_create",
        "octogee_board_card_update",
        "octogee_board_card_move",
        "octogee_board_card_comment",
    ],
};
export const STANDARD_CODEX_APP_SERVER = {
    sandbox: "workspace-write",
    approvalPolicy: "never",
};
export const ISOLATED_CODEX_APP_SERVER = {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
};
// The always-available platform house model: the operator's house model dial
// (snapshot freeTierModelRef), compiled default DEFAULT_HOUSE_MODEL_REF.
// A failed/exhausted BYOK provider degrades here rather than leaving the
// agent credential-less, and house-only plans pin the agent here so config,
// status, and broker routing agree. Refs are revalidated against the catalog
// at this trust boundary.
function houseModelRefFrom(ref) {
    return typeof ref === "string" && catalogEntryForModelRef(ref)
        ? ref
        : DEFAULT_HOUSE_MODEL_REF;
}
// A platform-provider ref (openrouter/openai) may sit outside the boot
// template's model set — declare it in agents.defaults.models (the picker
// path's pattern) so the pin resolves on every pod. Anthropic refs are
// declared by the boot materializer.
export function isPlatformProviderRef(ref) {
    return (ref.startsWith(`${OPENROUTER_PLATFORM_PROVIDER_ID}/`) ||
        ref.startsWith(`${OPENAI_PLATFORM_PROVIDER_ID}/`) ||
        ref.startsWith(`${VERTEX_PLATFORM_PROVIDER_ID}/`));
}
function platformModelsDef(refs) {
    const platformRefs = refs.filter(isPlatformProviderRef);
    if (platformRefs.length === 0)
        return null;
    return { models: Object.fromEntries(platformRefs.map((ref) => [ref, {}])) };
}
function runtimeModelsForProvider(provider) {
    if (provider === "openai-codex")
        return codexRuntimeConfig().modelsDef;
    if (provider === "claude-cli")
        return claudeCliRuntimeConfig().modelsDef;
    return null;
}
export function byosDefaultAgentConfigPatch(input) {
    if (!input)
        return null;
    if ("source" in input) {
        const defaults = platformModelsDef([input.model]);
        return {
            agents: {
                ...(defaults ? { defaults } : {}),
                list: [
                    {
                        id: agentIdForSlug(input.slug),
                        model: { primary: input.model, fallbacks: [] },
                        tools: HOUSE_MODEL_DEFAULT_AGENT_TOOLS,
                    },
                ],
            },
        };
    }
    const cfg = buildModelCredentialConfigForProvider(input);
    if (cfg.agentModelOverride == null)
        return null;
    const houseModelRef = houseModelRefFrom(input.houseModelRef);
    const patch = {
        agents: {
            list: [
                {
                    id: agentIdForSlug(input.slug),
                    model: { primary: cfg.agentModelOverride, fallbacks: [houseModelRef] },
                },
            ],
        },
    };
    const runtimeModels = runtimeModelsForProvider(input.provider);
    const houseDefaults = platformModelsDef([houseModelRef]);
    if (runtimeModels || houseDefaults) {
        patch.agents.defaults = {
            models: { ...(runtimeModels ?? {}), ...(houseDefaults?.models ?? {}) },
        };
    }
    return patch;
}
function isAgentRecord(a) {
    return a !== null && typeof a === "object" && !Array.isArray(a);
}
// The strip may only remove what the platform itself wrote: an exact
// fingerprint of HOUSE_MODEL_DEFAULT_AGENT_TOOLS. A user-authored or legacy
// profile/alsoAllow never matches and survives the catalog convergence.
function isPlatformHouseModelToolsBlock(existing) {
    const alsoAllow = existing.alsoAllow;
    return (existing.profile === HOUSE_MODEL_DEFAULT_AGENT_TOOLS.profile &&
        Array.isArray(alsoAllow) &&
        alsoAllow.length === HOUSE_MODEL_DEFAULT_AGENT_TOOLS.alsoAllow.length &&
        HOUSE_MODEL_DEFAULT_AGENT_TOOLS.alsoAllow.every((tool, i) => alsoAllow[i] === tool));
}
// Tools convergence for the agent entry, applied alongside the model update:
// a HouseModelDefaultAgentToolsBlock merges over the entry's existing tools (fs guards
// and any other keys preserved — the house-only surface is platform-tuned, so the
// block wins over prior profile/alsoAllow values); null strips ONLY the platform's
// own house model block (fingerprint-gated) so a catalog user returns to
// the inherited gateway-wide surface without losing fs.workspaceOnly or any
// user-authored tools keys.
export function convergedDefaultAgentToolsValue(existing, tools) {
    const base = isAgentRecord(existing)
        ? { ...existing }
        : {};
    if (tools) {
        delete base.profile;
        delete base.alsoAllow;
        return { ...base, profile: tools.profile, alsoAllow: [...tools.alsoAllow] };
    }
    if (isPlatformHouseModelToolsBlock(base)) {
        delete base.profile;
        delete base.alsoAllow;
    }
    return Object.keys(base).length > 0 ? base : undefined;
}
// The default-agent-model config.patch must ship the FULL agents.list — the agent's
// model updated, every sibling agent preserved verbatim — not a single-entry
// list. openclaw's id-keyed array merge (config/merge-patch.ts) upserts by id
// ONLY when every base entry carries a string id; a single id-less agent flips
// the whole array to wholesale replacement, so a one-entry patch drops the rest
// and trips the destructive-array guard (observed live 2026-06-23). A full list
// is safe under both the id-keyed merge and the wholesale fallback — no entries
// are removed either way.
//
// model:null leaves the entry's model untouched (plan-only tools reassert);
// tools:undefined leaves its tools untouched (pure model update).
export function defaultAgentFullAgentList(current, agentId, model, tools) {
    const list = current?.agents?.list;
    const agents = Array.isArray(list) ? list : [];
    return agents.map((a) => {
        if (!(isAgentRecord(a) && a.id === agentId))
            return a;
        const next = { ...a };
        if (model !== null)
            next.model = model;
        if (tools !== undefined) {
            const converged = convergedDefaultAgentToolsValue(next.tools, tools);
            if (converged === undefined) {
                delete next.tools;
            }
            else {
                next.tools = converged;
            }
        }
        return next;
    });
}
function keyedAgentEntries(current) {
    const entries = current?.agents?.entries;
    return isAgentRecord(entries) ? entries : null;
}
export function defaultAgentPatch(current, agentId, model, tools) {
    const entries = keyedAgentEntries(current);
    if (!entries)
        return { list: defaultAgentFullAgentList(current, agentId, model, tools) };
    const currentEntry = entries[agentId];
    if (!isAgentRecord(currentEntry))
        return { entries: {} };
    const [next] = defaultAgentFullAgentList({ agents: { list: [{ ...currentEntry, id: agentId }] } }, agentId, model, tools);
    if (!isAgentRecord(next))
        throw new Error(`coach patch: invalid agent entry for ${agentId}`);
    const { id: _id, ...entry } = next;
    return { entries: { [agentId]: entry } };
}
export function defaultAgentExists(current, agentId) {
    const entries = keyedAgentEntries(current);
    if (entries)
        return isAgentRecord(entries[agentId]);
    const list = current?.agents?.list;
    return Array.isArray(list) && list.some((agent) => isAgentRecord(agent) && agent.id === agentId);
}
export function defaultAgentPatchReplacePaths(current, agentId) {
    return keyedAgentEntries(current)
        ? [
            `agents.entries.${agentId}.model.fallbacks`,
            `agents.entries.${agentId}.tools.alsoAllow`,
        ]
        : [
            "agents.list",
            "agents.list[].model.fallbacks",
            "agents.list[].tools.alsoAllow",
        ];
}
export function deriveDesiredByotState(userData) {
    const status = userData.provisioning?.openclaw?.status;
    const slug = userData.username;
    if (!slug || status !== "complete") {
        return { enabled: false, input: null, defaultAgentModelInput: null };
    }
    if (!userData.byotActive) {
        return {
            enabled: false,
            input: null,
            defaultAgentModelInput: houseModelDefaultAgentModelInput(slug, userData),
        };
    }
    const input = byotInputForSlug(slug, userData.systemConfig?.byot);
    return {
        enabled: true,
        input,
        defaultAgentModelInput: { ...input, houseModelRef: houseModelRefFrom(userData.freeTierModelRef) },
    };
}
// The model a non-byot user would run: the house pin for house-only
// plans, else null — the config default stands and the PWA picker's per-agent
// overrides land afterwards. Used by deriveDesiredByotState and the
// shared-gateway byosub gate.
export function platformDefaultAgentModelInputForUser(slug, userData) {
    return houseModelDefaultAgentModelInput(slug, userData);
}
export function platformProjectAgentModelForUser(slug, userData) {
    if (houseModelDefaultAgentModelInput(slug, userData))
        return null;
    return parseUserAgentModelDefault(userData.builderAgentDefault);
}
// A house-only plan pins the agent to the house model. The broker would degrade
// anyway; pinning keeps the config
// honest so /status and the agent's self-report agree with the wire.
function houseModelDefaultAgentModelInput(slug, userData) {
    const policy = userEntitlements().policy(userData.planInputs);
    return policy.modelAccess === "house_only"
        ? { slug, model: houseModelRefFrom(userData.freeTierModelRef), source: "house-model" }
        : null;
}
function byotInputForSlug(slug, cfg) {
    const provider = cfg?.provider && Object.prototype.hasOwnProperty.call(MODEL_CREDENTIAL_MATERIALIZER_PROVIDERS, cfg.provider)
        ? cfg.provider
        : "anthropic";
    return { slug, provider, baseUrl: cfg?.baseUrl, model: cfg?.model };
}
function writeAtomic(target, content) {
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, target);
}
function removeIfExists(target) {
    if (!fs.existsSync(target))
        return false;
    fs.rmSync(target);
    return true;
}
async function removeManagedByotState(slug, dir, markerPath, filePath, preserveAuthProfileStore) {
    if (!fs.existsSync(markerPath))
        return false;
    let changed = false;
    for (const f of BYOT_FILES)
        changed = removeIfExists(filePath(f)) || changed;
    // On a shared (per-agent broker-token) pod the auth-profile store holds the
    // anthropic:default broker token (+ any byosub OAuth) that the materializer owns;
    // tearing down a user's local BYOT files must NOT delete it.
    if (!preserveAuthProfileStore && await readAuthProfileStore(dir) !== null) {
        await deleteAuthProfileStore(dir);
        changed = true;
    }
    changed = removeIfExists(markerPath) || changed;
    if (changed)
        log(`[byot-sync] ${slug}: removed BYOT files (BYOT off)`);
    return changed;
}
function desiredByotFiles(input) {
    const cfg = buildModelCredentialConfigForProvider(input);
    return {
        "models.json": cfg.models ? JSON.stringify(cfg.models, null, 2) : null,
    };
}
function writeDesiredByotFiles(desired, filePath) {
    let changed = false;
    for (const f of BYOT_FILES) {
        const target = filePath(f);
        const want = desired[f];
        const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
        if (want == null) {
            changed = removeIfExists(target) || changed;
        }
        else if (existing !== want) {
            writeAtomic(target, want);
            changed = true;
        }
    }
    return changed;
}
async function syncAuthProfileStore(dir, input, preserveAuthProfileStore) {
    if (isModelCredentialOauthProvider(input.provider))
        return false;
    const cfg = buildModelCredentialConfigForProvider(input);
    if (cfg.authProfiles) {
        const before = await readAuthProfileStore(dir);
        if (JSON.stringify(before) !== JSON.stringify(cfg.authProfiles)) {
            await writeAuthProfileStore(dir, cfg.authProfiles);
            return true;
        }
        return false;
    }
    // Custom-provider BYOK (grok/openrouter/minimax) keeps its key in models.json,
    // not the profile store — so the store would normally be cleared here. On a
    // shared broker-token pod it instead holds the anthropic:default broker token,
    // so preserve it.
    if (preserveAuthProfileStore || await readAuthProfileStore(dir) === null)
        return false;
    await deleteAuthProfileStore(dir);
    return true;
}
export async function applyByotState(slug, input, agentsDir = AGENTS_DIR, opts = {}) {
    const dir = agentDirForSlug(slug, agentsDir);
    const filePath = (f) => path.join(dir, f);
    const markerPath = filePath(BYOT_MARKER);
    const preserve = opts.preserveAuthProfileStore ?? false;
    if (!input) {
        return await removeManagedByotState(slug, dir, markerPath, filePath, preserve);
    }
    if (!fs.existsSync(dir)) {
        log(`⚠ [byot-sync] ${slug}: agent dir missing (provisioning incomplete?) — skipping BYOT write`);
        return false;
    }
    let changed = writeDesiredByotFiles(desiredByotFiles(input), filePath);
    changed = await syncAuthProfileStore(dir, input, preserve) || changed;
    if (!fs.existsSync(markerPath)) {
        writeAtomic(markerPath, JSON.stringify({ managedSince: new Date().toISOString() }) + "\n");
    }
    if (changed) {
        const modelSuffix = input.model ? ` model=${input.model}` : "";
        log(`[byot-sync] ${slug}: BYOT config updated (provider=${input.provider}${modelSuffix})`);
    }
    return changed;
}
