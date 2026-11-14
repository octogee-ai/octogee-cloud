#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { OCTOGEE_WORKFLOW_TOOLS } from "./workflow-tools.mjs";
export { OCTOGEE_WORKFLOW_TOOLS } from "./workflow-tools.mjs";
import {
  canonicalUserModelDefinition,
  platformModelRefs,
} from "../../shared/dist/types/agent-models.js";
import { modelCatalogForProvider } from "../../shared/dist/types/model-catalog.js";
import { parseAgentId } from "../../shared/dist/types/identity.js";
import { isIsolatedGatewayClassValue } from "../../shared/dist/types/glm.js";
import { projectPlatformAgentMattermostAccounts } from "../../shared/dist/types/openclaw-mattermost-accounts.js";
import {
  withOpenClawOperatorRoles,
  OPENCLAW_TRUSTED_PROXIES,
  OPENCLAW_TRUSTED_PROXY_AUTH,
  isPerUserControlIdentity,
  openClawIdentityScopes,
} from "../../shared/dist/types/openclaw-proxy-identity.js";
import { readUserClaim } from "../../shared/dist/server/user-claim.js";
const scriptsRequire = createRequire(new URL("../../scripts/package.json", import.meta.url));
const { userModelProviderDeclarationsMatch, platformBrokerProviderDeclarations } = await import(
  pathToFileURL(scriptsRequire.resolve("@octogee/core/system-config-invariants")).href,
);

export const USER_CODE_DENIED_TOOLS = [
  "exec",
  "process",
  "subagents",
  "sessions_spawn",
  "terminal",
  "preview_start",
  "preview_stop",
  "preview_list",
  "octogee_publish",
  "bundle-mcp",
  "skill_workshop",
  "skill_library",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "browser",
  "computer",
];
export const USER_STRUCTURED_AVAILABLE_TOOLS = [
  "automations",
  "workspace_commit",
  "octogee_project_commit",
  "octogee_project_capability",
  "octogee_project_build",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_publish",
  "octogee_project_set_recipe",
  "octogee_board_list",
  "octogee_board_card_read",
  "octogee_board_card_create",
  "octogee_board_card_update",
  "octogee_board_card_move",
  "octogee_board_card_comment",
];

const PRODUCTIVITY_TOOL_NAMES = OCTOGEE_WORKFLOW_TOOLS.filter((tool) =>
  tool.startsWith("octogee_google_") || tool.startsWith("octogee_obsidian_"));
const PROJECT_AGENT_ALLOWED_TOOLS = [
  "octogee_chat_set_identity",
  "octogee_connection_request",
  "octogee_ask_ops",
  "message",
  "read",
  "ls",
  "write",
  "edit",
  "apply_patch",
  "web_search",
  "web_fetch",
  "brave_search",
  "tavily_search",
  "tavily_extract",
  "octogee_project_build",
  "octogee_project_capability",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_commit",
  "octogee_project_set_recipe",
  "octogee_board_list",
  "octogee_board_card_read",
  "octogee_board_card_create",
  "octogee_board_card_update",
  "octogee_board_card_move",
  "octogee_board_card_comment",
];
const PROJECT_AGENT_DENIED_TOOLS = [
  ...PRODUCTIVITY_TOOL_NAMES,
  "exec",
  "process",
  "subagents",
  "sessions_spawn",
  "terminal",
  "preview_start",
  "preview_stop",
  "preview_list",
  "octogee_publish",
  "workspace_commit",
  "octogee_project_create",
  "octogee_project_delegate",
  "octogee_project_publish",
  "octogee_status",
  "octogee_chat_search",
  "octogee_chat_history",
  "octogee_owner_automations",
  "bundle-mcp",
  "automations",
  "skill_workshop",
  "skill_library",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "browser",
  "computer",
];
export const USER_APPROVED_PLUGINS = [
  "mattermost",
  "anthropic",
  "memory-core",
  "octogee-chat-tools",
  "octogee-connector-tools",
  "octogee-access-tools",
  "octogee-broker-tools",
  "octogee-project-tools",
  "octogee-board-tools",
  "octogee-status-tools",
  "octogee-ops-tools",
  "octogee-web-tools",
  "octogee-workspace-tools",
  "octogee-activity-tools",
  "parallel",
  "openai",
  "skill-workshop",
];
const FLEET_BROKER_URL_TEMPLATE = "${FLEET_BROKER_URL}";
const API_SA_TOKEN_PATH_TEMPLATE = "${OCTOGEE_API_SA_TOKEN_PATH}";
const USER_PLUGIN_ENTRIES = {
  mattermost: { enabled: true },
  anthropic: { enabled: true },
  "octogee-chat-tools": {
    enabled: true,
    hooks: {
      allowPromptModification: true,
      allowConversationAccess: true,
      timeouts: { before_dispatch: 3000, before_prompt_build: 3000, before_agent_run: 3000 },
    },
    config: {
      siteUrl: "${MM_SITE_URL}",
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
      customersRoot: "${CUSTOMERS_DIR}",
    },
  },
  "octogee-connector-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-access-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-project-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-board-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-status-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
      gatewayClass: "${GATEWAY_CLASS}",
    },
  },
  "octogee-ops-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-web-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      gatewayId: "${GATEWAY_ID}",
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-broker-tools": {
    enabled: true,
    config: {
      brokerUrl: FLEET_BROKER_URL_TEMPLATE,
      tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
    },
  },
  "octogee-workspace-tools": { enabled: true, config: {} },
  "octogee-activity-tools": {
    enabled: true,
    config: { heartbeatMs: 5000 },
  },
  parallel: { enabled: true },
  "skill-workshop": { enabled: true, config: { autonomous: { mode: "off" } } },
};
const CONNECTOR_TOOLS_PLUGIN = "octogee-connector-tools";
const PROJECT_TOOLS_PLUGIN = "octogee-project-tools";
const BOARD_TOOLS_PLUGIN = "octogee-board-tools";
const OPS_TOOLS_PLUGIN = "octogee-ops-tools";
const ACCESS_TOOLS_PLUGIN = "octogee-access-tools";
const CODEX_PROFILE = "openai-codex:default";
const CLAUDE_CLI_PROFILE = "anthropic:claude-cli";
const CANONICAL_AGENT_AUTH_PROFILE_IDS = new Set([
  "anthropic:default",
  "platform-openrouter:default",
  "platform-openai:default",
  "platform-vertex:default",
  "platform-meta:default",
]);
const SESSION_RUNTIME_STATE_FIELDS = [
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "modelFallback",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "liveModelSwitchPending",
  "modelProvider",
  "model",
  "modelSelectionLocked",
  "agentHarnessId",
  "agentRuntimeOverride",
  "fallbackNotice",
  "contextTokens",
  "systemPromptReport",
  "cliSessionIds",
  "cliSessionBindings",
  "acpSessionBinding",
  "acp",
  "claudeCliSessionId",
  "pluginOwnerId",
  "pluginExtensions",
  "initializationPending",
  "spawnedCwd",
  "execHost",
  "execSecurity",
  "execAsk",
  "execNode",
  "execCwd",
  "elevatedLevel",
  "toolOverrides",
];
const SAFE_USER_MODEL = "platform-openrouter/deepseek/deepseek-v4-pro";
const SAFE_AGENT_ID = /^[a-z0-9-]{1,64}$/;
const USER_MODEL_REFS = new Set(platformModelRefs());
const USER_MODEL_PROVIDER_IDS = new Set([
  "anthropic",
  "platform-openrouter",
  "platform-openai",
  "platform-vertex",
  "platform-meta",
]);
const USER_DISK_MODEL_PROVIDERS = [
  { id: "platform-meta", env: "PLATFORM_META_BASE_URL", catalog: "meta", api: "openai-responses" },
  { id: "platform-openrouter", env: "OPENROUTER_BASE_URL", catalog: "openrouter", api: "openai-completions" },
  { id: "platform-openai", env: "PLATFORM_OPENAI_BASE_URL", catalog: "openai", api: "openai-completions" },
  { id: "platform-vertex", env: "PLATFORM_VERTEX_BASE_URL", catalog: "vertex", api: "anthropic-messages" },
];

function userDiskModelProviders(env) {
  const providers = {};
  for (const provider of USER_DISK_MODEL_PROVIDERS) {
    const baseUrl = env[provider.env]?.trim();
    if (!baseUrl) continue;
    providers[provider.id] = {
      api: provider.api,
      baseUrl,
      apiKey: `${provider.id}:default`,
      models: modelCatalogForProvider(provider.catalog).map((entry) => ({
        id: entry.id.replace(/^vertex\//u, ""),
        name: entry.id.replace(/^vertex\//u, ""),
        ...(entry.contextTokens !== undefined
          ? { contextTokens: entry.contextTokens, contextWindow: entry.contextTokens } : {}),
        ...(entry.input ? { input: [...entry.input] } : {}),
        ...(entry.maxOutputTokens !== undefined ? { maxTokens: entry.maxOutputTokens } : {}),
        ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
      })),
    };
  }
  return providers;
}

const USER_AGENT_ID = /^octogee-[a-z0-9]+(?:-[a-z0-9]+)*-coach$/;

function addUnique(list, tool) {
  if (!Array.isArray(list)) return [tool];
  return list.includes(tool) ? list : [...list, tool];
}

function addTools(list, tools) {
  return tools.reduce((next, tool) => addUnique(next, tool), list);
}

function removeTools(list, tools) {
  if (!Array.isArray(list)) return [];
  const removed = new Set(tools);
  return list.filter((tool) => !removed.has(tool));
}

function removeSharedSubagentDefaults(config) {
  if (
    config.agents?.defaults &&
    Object.prototype.hasOwnProperty.call(config.agents.defaults, "subagents")
  ) {
    delete config.agents.defaults.subagents;
  }
}

function isPolicyCodexAuthProfile(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    Object.keys(value).length === 2 &&
    value.provider === "openai-codex" &&
    value.mode === "oauth"
  );
}

export function removePolicyCodexAuthPlaceholder(config) {
  const profile = config.auth?.profiles?.[CODEX_PROFILE];
  if (isPolicyCodexAuthProfile(profile)) {
    delete config.auth.profiles[CODEX_PROFILE];
  }
}

// Users never approve connector writes per-call; the capability convergence
// has already allowed and enabled the plugin by the time this runs.
function clearConnectorWriteApproval(config) {
  delete config.plugins.entries[CONNECTOR_TOOLS_PLUGIN].config.requireWriteApproval;
}

// Plugins the platform itself ships. A gateway that was materialized before one
// of these existed must gain it at boot, or its agents never see the tools the
// plugin registers even when the image carries them.
const PLATFORM_CAPABILITY_PLUGINS = [
  CONNECTOR_TOOLS_PLUGIN,
  PROJECT_TOOLS_PLUGIN,
  BOARD_TOOLS_PLUGIN,
  OPS_TOOLS_PLUGIN,
  ACCESS_TOOLS_PLUGIN,
  "octogee-broker-tools",
];

// An isolated gateway's config is persisted and restored across every VM
// replacement, so an absent `plugins.allow` means "no allowlist" and must stay
// absent — materializing one here would silently narrow the gateway to exactly
// the platform's own plugins. An explicitly disabled entry is a user
// decision and survives; only a missing entry is defaulted on.
function enablePlatformPlugin(config, id, isolated) {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  if (Array.isArray(config.plugins.allow)) {
    if (!config.plugins.allow.includes(id)) config.plugins.allow.push(id);
  } else if (!isolated) {
    config.plugins.allow = [id];
  }
  config.plugins.entries[id] ??= {};
  config.plugins.entries[id].config ??= {};
  if (isolated) config.plugins.entries[id].enabled ??= true;
  else config.plugins.entries[id].enabled = true;
}

// The platform's capability surface: the tools Octogee ships and the plugins
// that register them. Every gateway class converges onto it, because no gateway
// owner chose these and none can be expected to maintain them by hand. The
// restriction half of the class policy (deny lists, terminal, session
// visibility, config-mutation locks) stays user-only, which is why an
// isolated gateway converges additively: new platform capabilities arrive and
// the user's own profile, allow, deny and extra tools survive untouched.
function addIsolatedToolCapabilities(config, capabilities) {
  config.tools ??= {};
  const alsoAllow = Array.isArray(config.tools.alsoAllow) ? config.tools.alsoAllow : [];
  if (Array.isArray(config.tools.allow) && config.tools.allow.length > 0) {
    config.tools.allow = [...new Set([...config.tools.allow, ...alsoAllow, ...capabilities])];
    delete config.tools.alsoAllow;
  } else {
    config.tools.alsoAllow = [...new Set([...alsoAllow, ...capabilities])];
  }
}

function convergePlatformCapabilities(config, isolated) {
  config.meta ??= {};
  config.meta.migrations ??= {};
  config.meta.migrations.skillWorkshopPlugin = true;
  config.tools ??= {};
  if (isolated) {
    addIsolatedToolCapabilities(config, OCTOGEE_WORKFLOW_TOOLS);
  } else {
    config.tools.profile = "coding";
    delete config.tools.allow;
    config.tools.alsoAllow = [...OCTOGEE_WORKFLOW_TOOLS];
  }
  for (const id of PLATFORM_CAPABILITY_PLUGINS) enablePlatformPlugin(config, id, isolated);
}

function disableCodex(config) {
  config.plugins ??= {};
  config.plugins.allow = [...USER_APPROVED_PLUGINS];
  config.plugins.entries ??= {};
  config.plugins.entries.codex = {
    enabled: false,
  };
}

function setTerminal(config, enabled) {
  config.gateway ??= {};
  config.gateway.terminal ??= {};
  config.gateway.terminal.enabled = enabled;
}

function restrictSessionVisibility(config) {
  config.tools ??= {};
  config.tools.sessions ??= {};
  config.tools.sessions.visibility = "self";
}

function disableUserConfigMutation(config) {
  config.commands ??= {};
  for (const command of ["bash", "config", "mcp", "plugins", "debug"]) {
    config.commands[command] = false;
  }
  delete config.commands.ownerAllowFrom;
  if (config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp)) {
    delete config.mcp.servers;
  }
}

function userAgentLane(agentId) {
  if (typeof agentId !== "string" || !USER_AGENT_ID.test(agentId)) return "unknown";
  return agentId.includes("-proj-") ? "project" : "coach";
}

function userAgentToolProjection(lane, currentDeny) {
  if (lane === "coach") {
    return {
      profile: "coding",
      alsoAllow: [...OCTOGEE_WORKFLOW_TOOLS],
      deny: addTools(
        removeTools(currentDeny, USER_STRUCTURED_AVAILABLE_TOOLS),
        USER_CODE_DENIED_TOOLS,
      ),
    };
  }
  if (lane === "project") {
    return {
      profile: "minimal",
      alsoAllow: [...PROJECT_AGENT_ALLOWED_TOOLS],
      deny: [...PROJECT_AGENT_DENIED_TOOLS],
    };
  }
  return {
    profile: "minimal",
    alsoAllow: [],
    deny: addTools(currentDeny, USER_CODE_DENIED_TOOLS),
  };
}

function projectUserAgentTools(config, entry, agentId) {
  entry.tools ??= {};
  entry.tools.fs ??= {};
  entry.tools.fs.workspaceOnly = true;
  const projected = userAgentToolProjection(userAgentLane(agentId), entry.tools.deny);
  entry.tools.profile = projected.profile;
  entry.tools.alsoAllow = projected.alsoAllow;
  entry.tools.deny = projected.deny;
  entry.tools.toolsBySender = userToolsBySender(config, agentId);
  delete entry.tools.allow;
}

function forceUserWorkspaceOnly(config) {
  config.tools ??= {};
  config.tools.fs ??= {};
  config.tools.fs.workspaceOnly = true;
  if (Array.isArray(config.agents?.list)) {
    for (const rawEntry of config.agents.list) {
      const entry = objectValue(rawEntry);
      if (entry) projectUserAgentTools(config, entry, entry.id);
    }
  }
  const entries = objectValue(config.agents?.entries);
  if (!entries) return;
  for (const [agentId, rawEntry] of Object.entries(entries)) {
    const entry = objectValue(rawEntry);
    if (entry) projectUserAgentTools(config, entry, agentId);
  }
}

function userToolsBySender(_config, agentId) {
  return agentId.includes("-proj-")
    ? { "*": { deny: [...PRODUCTIVITY_TOOL_NAMES] } }
    : {};
}

function disableUserAutomationsAndSkillWrites(config) {
  config.cron ??= {};
  config.cron.triggers ??= {};
  config.cron.triggers.enabled = false;
  config.skills ??= {};
  config.skills.load ??= {};
  delete config.skills.load.allowSymlinkTargets;
  delete config.skills.load.extraDirs;
  delete config.skills.workshop;
}

function forceUserMattermostProjection(config) {
  config.channels ??= {};
  config.channels.mattermost ??= {};
  const mattermost = config.channels.mattermost;
  delete mattermost.baseUrl;
  mattermost.network = { dangerouslyAllowPrivateNetwork: true };
  mattermost.interactions = {
    callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
    allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
  };
  projectMattermostAccounts(config, true);
}

function projectMattermostAccounts(config, platformOwned) {
  config.channels ??= {};
  config.channels.mattermost ??= {};
  const mattermost = config.channels.mattermost;
  mattermost.accounts = objectValue(mattermost.accounts) ?? {};
  projectPlatformAgentMattermostAccounts(config, mattermost.accounts, platformOwned);
}

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

const INSTALLED_PLUGIN_INDEX_STATE_KEY = "plugins.installedIndex";
const RETIRED_MATTERMOST_FILE_SPEC_PREFIX = "@openclaw/mattermost@file:";
const BUNDLED_CODEX_NPM_PACKAGE = "@openclaw/codex";

function removeRetiredMattermostInstallRecord(openclawDir) {
  return removeMatchingNpmInstallRecord(openclawDir, "mattermost", (spec) =>
    spec.startsWith(RETIRED_MATTERMOST_FILE_SPEC_PREFIX),
  );
}

function removeStaleCodexInstallRecord(openclawDir) {
  return removeMatchingNpmInstallRecord(openclawDir, "codex", (spec) =>
    spec === BUNDLED_CODEX_NPM_PACKAGE || spec.startsWith(`${BUNDLED_CODEX_NPM_PACKAGE}@`),
  );
}

function removeMatchingNpmInstallRecord(openclawDir, pluginId, matchesSpec) {
  const dbPath = path.join(openclawDir, "state", "openclaw.sqlite");
  if (!fs.existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 30000;");
    const table = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'",
    ).get();
    if (!table) return false;
    const row = db.prepare(
      "SELECT value_json FROM config_machine_state WHERE state_key = ?",
    ).get(INSTALLED_PLUGIN_INDEX_STATE_KEY);
    if (typeof row?.value_json !== "string") return false;
    const value = JSON.parse(row.value_json);
    const index = objectValue(value?.index);
    const installRecords = objectValue(index?.installRecords);
    const record = objectValue(installRecords?.[pluginId]);
    if (
      record?.source !== "npm" ||
      typeof record.spec !== "string" ||
      !matchesSpec(record.spec)
    ) {
      return false;
    }
    delete installRecords[pluginId];
    const revision = Math.max(
      Date.now(),
      Number.isSafeInteger(value.revision) ? value.revision + 1 : 1,
    );
    value.revision = revision;
    db.prepare(
      "UPDATE config_machine_state SET value_json = ?, updated_at_ms = ? WHERE state_key = ?",
    ).run(JSON.stringify(value), revision, INSTALLED_PLUGIN_INDEX_STATE_KEY);
    return true;
  } finally {
    db.close();
  }
}

function isDirectAgentRuntimeId(value) {
  return typeof value === "string" && value.trim().length > 0 && value !== "openclaw";
}

function projectUserPlugins(config) {
  config.plugins ??= {};
  config.plugins.enabled = true;
  config.plugins.allow = [...USER_APPROVED_PLUGINS];
  config.plugins.entries = structuredClone(USER_PLUGIN_ENTRIES);
  delete config.plugins.load;
  delete config.plugins.installs;
}

function isSecretRef(value) {
  const ref = objectValue(value);
  return ref && ["env", "file", "exec"].includes(ref.source);
}

function escapedJsonPointerSegment(value) {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function agentIdAtSecretRefPath(config, segments) {
  if (segments[0] !== "agents") return null;
  if (segments[1] === "entries" && typeof segments[2] === "string") return segments[2];
  if (segments[1] !== "list" || !/^\d+$/u.test(segments[2] ?? "")) return null;
  const agent = Array.isArray(config.agents?.list)
    ? config.agents.list[Number(segments[2])]
    : null;
  return typeof agent?.id === "string" ? agent.id : null;
}

function projectAgentStoreSecretRef(config) {
  const postgres = objectValue(objectValue(config.database)?.postgres);
  if (postgres) {
    postgres.connection = { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" };
  }
}

function expectedUserSecretRef(config, segments) {
  if (
    segments.length === 5 &&
    segments[0] === "channels" &&
    segments[1] === "mattermost" &&
    segments[2] === "accounts" &&
    segments[4] === "botToken"
  ) {
    return {
      source: "file",
      provider: "octogee-mattermost",
      id: `/${escapedJsonPointerSegment(segments[3])}`,
    };
  }
  const agentId = agentIdAtSecretRefPath(config, segments);
  const suffix = segments.slice(3).join(".");
  if (
    agentId &&
    (suffix === "memorySearch.remote.apiKey" || suffix === "memory.search.remote.apiKey")
  ) {
    return {
      source: "exec",
      provider: "gcp-secret-manager",
      id: `agent-embedding-token-openai-${agentId}`,
    };
  }
  return null;
}

function neutralizeSecretRefsInArray(value, config, segments) {
  for (let index = value.length - 1; index >= 0; index--) {
    const child = value[index];
    const childSegments = [...segments, String(index)];
    if (!isSecretRef(child)) {
      neutralizeUnapprovedUserSecretRefs(child, config, childSegments);
      continue;
    }
    const expected = expectedUserSecretRef(config, childSegments);
    if (expected) value[index] = expected;
    else value.splice(index, 1);
  }
}

function isUserSecretProviderPath(segments, key) {
  return segments.length === 1 && segments[0] === "secrets" && key === "providers";
}

function neutralizeSecretRefsInRecord(record, config, segments) {
  for (const [key, child] of Object.entries(record)) {
    if (isUserSecretProviderPath(segments, key)) continue;
    const childSegments = [...segments, key];
    if (!isSecretRef(child)) {
      neutralizeUnapprovedUserSecretRefs(child, config, childSegments);
      continue;
    }
    const expected = expectedUserSecretRef(config, childSegments);
    if (expected) record[key] = expected;
    else delete record[key];
  }
}

function neutralizeUnapprovedUserSecretRefs(value, config, segments = []) {
  if (Array.isArray(value)) {
    neutralizeSecretRefsInArray(value, config, segments);
    return;
  }
  const record = objectValue(value);
  if (record) neutralizeSecretRefsInRecord(record, config, segments);
}

function projectUserSecretProviders(config, openclawDir) {
  neutralizeUnapprovedUserSecretRefs(config, config);
  projectAgentStoreSecretRef(config);
  config.secrets ??= {};
  config.secrets.providers = {
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
      path: path.join(openclawDir, "secrets", "mattermost-accounts.json"),
      mode: "json",
    },
  };
}

function scrubUserHookNamespaces(config) {
  const hooks = objectValue(config.hooks);
  if (hooks) {
    delete hooks.transformsDir;
    if (Array.isArray(hooks.mappings)) {
      hooks.mappings = hooks.mappings.map((mapping) => {
        const entry = objectValue(mapping);
        if (!entry || !Object.prototype.hasOwnProperty.call(entry, "transform")) return mapping;
        const next = { ...entry };
        delete next.transform;
        return next;
      });
    }
  }
  const internalHooks = objectValue(config.hooks?.internal);
  if (!internalHooks) return;
  delete internalHooks.handlers;
  const load = objectValue(internalHooks.load);
  if (!load) return;
  delete load.extraDirs;
  if (Object.keys(load).length === 0) delete internalHooks.load;
}

function scrubUserProviderCommands(config) {
  const qmd = objectValue(config.memory?.qmd);
  if (qmd) delete qmd.command;
  const providers = objectValue(config.models?.providers);
  if (!providers) return;
  for (const provider of Object.values(providers)) {
    const localService = objectValue(objectValue(provider)?.localService);
    if (localService) delete localService.command;
  }
}

function commandlessModel(value, rejectCli) {
  const entry = objectValue(value);
  return Boolean(entry) && (!rejectCli || entry.type !== "cli") &&
    !Object.prototype.hasOwnProperty.call(entry, "command");
}

function scrubUserMediaCommands(config) {
  const media = objectValue(config.tools?.media);
  if (media && Array.isArray(media.models)) {
    media.models = media.models.filter((model) => commandlessModel(model, true));
  }
  const links = objectValue(config.tools?.links);
  if (links && Array.isArray(links.models)) {
    links.models = links.models.filter((model) => commandlessModel(model, false));
  }
}

function scrubUserInstallAndCronCommands(config) {
  const installPolicy = objectValue(config.security?.installPolicy);
  if (installPolicy) delete installPolicy.exec;
  const cron = objectValue(config.cron);
  if (!cron) return;
  for (const key of ["webhookToken", "webhookAuth", "failureAlert", "failureAlerts"]) {
    delete cron[key];
  }
}

function projectUserSpawnNamespaces(config) {
  scrubUserHookNamespaces(config);
  scrubUserProviderCommands(config);
  scrubUserMediaCommands(config);
  scrubUserInstallAndCronCommands(config);
}

function normalizedCatalogSelection(value) {
  if (typeof value === "string") {
    return USER_MODEL_REFS.has(value) ? { primary: value, fallbacks: [] } : null;
  }
  const selection = objectValue(value);
  if (!selection || typeof selection.primary !== "string" ||
      !USER_MODEL_REFS.has(selection.primary)) return null;
  const fallbacks = selection.fallbacks === undefined ? [] : selection.fallbacks;
  if (!Array.isArray(fallbacks) || fallbacks.some((ref) => !USER_MODEL_REFS.has(ref))) {
    return null;
  }
  return {
    primary: selection.primary,
    fallbacks: [...new Set(fallbacks)].filter((ref) => ref !== selection.primary),
  };
}

function projectCatalogModelMap(models, ensureModelRef) {
  const modelMap = objectValue(models);
  if (!modelMap) return { changed: false, removedRefs: new Set() };
  let changed = false;
  const removedRefs = new Set();
  for (const modelRef of Object.keys(modelMap)) {
    if (!USER_MODEL_REFS.has(modelRef)) {
      removedRefs.add(modelRef);
      delete modelMap[modelRef];
      changed = true;
      continue;
    }
    const expected = canonicalUserModelDefinition(modelRef);
    if (JSON.stringify(modelMap[modelRef]) !== JSON.stringify(expected)) {
      modelMap[modelRef] = expected;
      changed = true;
    }
  }
  if (ensureModelRef && !Object.prototype.hasOwnProperty.call(modelMap, ensureModelRef)) {
    modelMap[ensureModelRef] = canonicalUserModelDefinition(ensureModelRef);
    changed = true;
  }
  return { changed, removedRefs };
}

function scrubOwnedAgentRuntime(entry, forceSafeModel = false) {
  const agent = objectValue(entry);
  if (!agent) return false;
  const localModels = projectCatalogModelMap(agent.models);
  let affected = localModels.changed;
  const agentRuntime = objectValue(agent.agentRuntime);
  const hasSelection = Object.prototype.hasOwnProperty.call(agent, "model");
  const normalizedSelection = hasSelection ? normalizedCatalogSelection(agent.model) : null;
  const unsafePin = hasSelection && normalizedSelection === null;
  if (isDirectAgentRuntimeId(agentRuntime?.id)) {
    delete agent.agentRuntime;
    affected = true;
  }
  if (forceSafeModel || unsafePin) {
    agent.model = { primary: SAFE_USER_MODEL, fallbacks: [] };
    affected = true;
  } else if (normalizedSelection && JSON.stringify(agent.model) !== JSON.stringify(normalizedSelection)) {
    agent.model = normalizedSelection;
  }
  return affected;
}

function configuredUserAgentIds(config) {
  const ids = new Set();
  if (Array.isArray(config.agents?.list)) {
    for (const entry of config.agents.list) {
      if (typeof entry?.id === "string" && parseAgentId(entry.id).kind !== "unknown") {
        ids.add(entry.id);
      }
    }
  }
  const entries = objectValue(config.agents?.entries);
  if (entries) {
    for (const agentId of Object.keys(entries)) {
      if (parseAgentId(agentId).kind !== "unknown") ids.add(agentId);
    }
  }
  return [...ids];
}

function userModelProviders(env) {
  const anthropicBaseUrl = env.ANTHROPIC_BASE_URL?.trim();
  return {
    ...(anthropicBaseUrl ? { anthropic: { baseUrl: anthropicBaseUrl } } : {}),
    ...platformBrokerProviderDeclarations(env),
  };
}

function resetConfiguredAgents(resetAgentIds, agentIds) {
  for (const agentId of agentIds) resetAgentIds.add(agentId);
}

function projectUserDefaultRuntime(config, unsafeProviders, allAgentIds, resetAgentIds) {
  config.agents.defaults.models ??= {};
  const defaultModels = projectCatalogModelMap(
    config.agents.defaults.models,
    SAFE_USER_MODEL,
  );
  if (defaultModels.changed || unsafeProviders) {
    resetConfiguredAgents(resetAgentIds, allAgentIds);
  }
  const hasDefaultModel = Object.prototype.hasOwnProperty.call(config.agents.defaults, "model");
  const normalizedDefaultModel = hasDefaultModel
    ? normalizedCatalogSelection(config.agents.defaults.model)
    : null;
  if (unsafeProviders || (hasDefaultModel && normalizedDefaultModel === null)) {
    config.agents.defaults.model = { primary: SAFE_USER_MODEL, fallbacks: [] };
    resetConfiguredAgents(resetAgentIds, allAgentIds);
  } else if (
    normalizedDefaultModel &&
    JSON.stringify(config.agents.defaults.model) !== JSON.stringify(normalizedDefaultModel)
  ) {
    config.agents.defaults.model = normalizedDefaultModel;
  }
  const defaultAgentRuntime = objectValue(config.agents.defaults.agentRuntime);
  if (isDirectAgentRuntimeId(defaultAgentRuntime?.id)) {
    delete config.agents.defaults.agentRuntime;
    resetConfiguredAgents(resetAgentIds, allAgentIds);
  }
  return new Set(defaultModels.removedRefs);
}

function unapprovedAgentModelRefs(entry) {
  const models = objectValue(objectValue(entry)?.models);
  if (!models) return [];
  return Object.keys(models).filter((modelRef) => !USER_MODEL_REFS.has(modelRef));
}

function projectUserAgentRuntime(entry, agentId, unsafeProviders, resetAgentIds, directRefs) {
  if (!SAFE_AGENT_ID.test(agentId)) return;
  for (const modelRef of unapprovedAgentModelRefs(entry)) directRefs.add(modelRef);
  if (scrubOwnedAgentRuntime(entry, unsafeProviders)) resetAgentIds.add(agentId);
  if (agentId === "octogee-unmatched-route" && objectValue(entry)) delete entry.model;
}

function projectConfiguredUserAgentRuntimes(config, unsafeProviders, resetAgentIds, directRefs) {
  if (Array.isArray(config.agents.list)) {
    for (const entry of config.agents.list) {
      if (typeof entry?.id === "string") {
        projectUserAgentRuntime(entry, entry.id, unsafeProviders, resetAgentIds, directRefs);
      }
    }
  }
  const entries = objectValue(config.agents.entries);
  if (!entries) return;
  for (const [agentId, entry] of Object.entries(entries)) {
    projectUserAgentRuntime(entry, agentId, unsafeProviders, resetAgentIds, directRefs);
  }
}

function removeUnapprovedUserAuthProfiles(config) {
  const profiles = objectValue(config.auth?.profiles);
  if (!profiles) return;
  for (const [profileId, profile] of Object.entries(profiles)) {
    const provider = objectValue(profile)?.provider;
    const unapproved = profileId === CODEX_PROFILE ||
      profileId === CLAUDE_CLI_PROFILE ||
      provider === "openai-codex" ||
      provider === "claude-cli";
    if (unapproved) delete profiles[profileId];
  }
}

function scrubUserOauthConfig(config, env) {
  const resetAgentIds = new Set();
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.modelPolicy ??= {};
  config.agents.defaults.modelPolicy.allow = [
    "anthropic/*", "platform-openrouter/*", "platform-openai/*", "platform-vertex/*",
    ...(env.PLATFORM_META_BASE_URL?.trim() ? ["platform-meta/*"] : []),
  ];
  const allAgentIds = configuredUserAgentIds(config);
  const providers = objectValue(config.models?.providers);
  const expectedProviders = userModelProviders(env);
  const unsafeProviders = !userModelProviderDeclarationsMatch(providers ?? {}, expectedProviders);
  config.models ??= {};
  config.models.providers = expectedProviders;
  const directRuntimeModelRefs = projectUserDefaultRuntime(
    config,
    unsafeProviders,
    allAgentIds,
    resetAgentIds,
  );
  projectConfiguredUserAgentRuntimes(
    config,
    unsafeProviders,
    resetAgentIds,
    directRuntimeModelRefs,
  );
  removeUnapprovedUserAuthProfiles(config);
  return { resetAgentIds, directRuntimeModelRefs };
}

function removeFile(targetPath) {
  if (!fs.existsSync(targetPath)) return false;
  fs.rmSync(targetPath, { force: true });
  return true;
}

function canonicalAgentAuthProfiles(agentId, env) {
  const ref = (provider, id) => ({
    type: "api_key",
    provider,
    keyRef: { source: "exec", provider: "gcp-secret-manager", id },
  });
  return {
    "anthropic:default": ref("anthropic", `agent-model-token-${agentId}`),
    "platform-openrouter:default": ref(
      "platform-openrouter",
      `agent-model-token-openrouter-${agentId}`,
    ),
    "platform-openai:default": ref("platform-openai", `agent-model-token-openai-${agentId}`),
    ...(env.PLATFORM_META_BASE_URL?.trim()
      ? { "platform-meta:default": ref("platform-meta", `agent-model-token-meta-${agentId}`) }
      : {}),
    ...(env.PLATFORM_VERTEX_BASE_URL?.trim()
      ? { "platform-vertex:default": ref("platform-vertex", `agent-model-token-vertex-${agentId}`) }
      : {}),
  };
}

function scrubAgentOauthProfiles(agentDir, agentId, env) {
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const dbPath = path.join(agentDir, "openclaw-agent.sqlite");
  if (!fs.existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath);
  try {
    if (db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'openclaw_engine_anchor'",
    ).get()) return false;
    db.exec("PRAGMA busy_timeout = 30000;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const row = db.prepare(
      "SELECT store_json AS value FROM auth_profile_store WHERE store_key = ?",
    ).get("primary");
    const store = typeof row?.value === "string" ? JSON.parse(row.value) : {};
    if (!objectValue(store)) {
      throw new Error(`apply-gateway-class-policy: ${dbPath} auth profile store is invalid`);
    }
    const profiles = canonicalAgentAuthProfiles(agentId, env);
    if (JSON.stringify(store?.profiles) === JSON.stringify(profiles)) {
      fs.chmodSync(agentDir, 0o700);
      fs.chmodSync(dbPath, 0o600);
      return false;
    }
    store.profiles = profiles;
    db.prepare(
      `INSERT INTO auth_profile_store (store_key, store_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(store_key) DO UPDATE SET
         store_json = excluded.store_json,
         updated_at = excluded.updated_at`,
    ).run("primary", JSON.stringify(store), Date.now());
    fs.chmodSync(agentDir, 0o700);
    fs.chmodSync(dbPath, 0o600);
    return true;
  } finally {
    db.close();
  }
}

function projectAgentModelsJson(agentDir, providers) {
  const modelsPath = path.join(agentDir, "models.json");
  const desired = { providers };
  const fd = openRegularFile(modelsPath);
  if (fd !== null) {
    try {
      const current = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (JSON.stringify(current) === JSON.stringify(desired)) {
        fs.chmodSync(agentDir, 0o700);
        fs.fchmodSync(fd, 0o600);
        return false;
      }
    } finally { fs.closeSync(fd); }
  }
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  atomicWrite(modelsPath, `${JSON.stringify(desired, null, 2)}\n`);
  fs.chmodSync(agentDir, 0o700);
  return true;
}

function openRegularFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`apply-gateway-class-policy: ${file} is not a private regular file`);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readSessionMap(sessionsPath) {
  const fd = openRegularFile(sessionsPath);
  if (fd === null) return null;
  try {
    const sessions = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!objectValue(sessions)) throw new Error(`apply-gateway-class-policy: ${sessionsPath} is not a session map`);
    return sessions;
  } finally {
    fs.closeSync(fd);
  }
}

function resetLegacySessionStore(sessionsPath) {
  const sessions = readSessionMap(sessionsPath);
  if (!sessions) return false;
  let changed = false;
  for (const entry of Object.values(sessions)) {
    changed = clearSessionRuntimeState(entry) || changed;
  }
  if (!changed) return false;
  atomicWrite(sessionsPath, `${JSON.stringify(sessions)}\n`);
  return true;
}

function rollbackSessionTransaction(db, error) {
  try {
    db.exec("ROLLBACK");
  } catch {
    return error;
  }
  return error;
}

function parseSessionNode(row, dbPath) {
  if (typeof row.entry_json !== "string") return null;
  const entry = JSON.parse(row.entry_json);
  if (!objectValue(entry)) {
    throw new Error(
      `apply-gateway-class-policy: ${dbPath} session ${String(row.session_key)} is invalid`,
    );
  }
  return entry;
}

function mutateSqliteSessionStore(dbPath, mutateEntry) {
  if (!fs.existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath);
  try {
    const table = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_nodes'",
    ).get();
    if (!table) return false;
    const rows = db.prepare("SELECT session_key, entry_json FROM session_nodes").all();
    const update = db.prepare(
      "UPDATE session_nodes SET entry_json = ? WHERE session_key = ?",
    );
    let changed = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const entry = parseSessionNode(row, dbPath);
        if (!entry || !mutateEntry(entry)) continue;
        update.run(JSON.stringify(entry), row.session_key);
        changed = true;
      }
      db.exec("COMMIT");
      return changed;
    } catch (error) {
      throw rollbackSessionTransaction(db, error);
    }
  } finally {
    db.close();
  }
}

function resetAgentSessionStore(openclawDir, agentId) {
  const sessionsPath = path.join(openclawDir, "agents", agentId, "sessions", "sessions.json");
  const legacyChanged = resetLegacySessionStore(sessionsPath);
  const dbPath = path.join(openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  const sqliteChanged = mutateSqliteSessionStore(dbPath, clearSessionRuntimeState);
  return legacyChanged || sqliteChanged;
}

function unsupportedUserModel(provider, model) {
  if (typeof model !== "string" || USER_MODEL_REFS.has(model)) return false;
  return typeof provider !== "string" || !USER_MODEL_REFS.has(`${provider}/${model}`);
}

function hasUnsafeSessionModelState(entry, directRuntimeModelRefs) {
  const providers = [entry.providerOverride, entry.modelProvider];
  const unsupportedProvider = providers.some(
    (provider) => typeof provider === "string" && !USER_MODEL_PROVIDER_IDS.has(provider),
  );
  const bindings = [
    [entry.providerOverride, entry.modelOverride],
    [entry.modelProvider, entry.model],
    [entry.providerOverride, entry.modelOverrideFallbackOriginModel],
  ];
  const unsupportedModel = bindings.some(([provider, model]) =>
    unsupportedUserModel(provider, model));
  const directModel = bindings.some(([, model]) =>
    typeof model === "string" && directRuntimeModelRefs.has(model));
  return unsupportedProvider || unsupportedModel || directModel;
}

function hasUnsafeFallbackState(modelFallback, directRuntimeModelRefs) {
  const unsafeProvider = typeof modelFallback.prevProvider === "string" &&
    !USER_MODEL_PROVIDER_IDS.has(modelFallback.prevProvider);
  const unsafeAuth = typeof modelFallback.prevAuthProfileOverride === "string" &&
    !CANONICAL_AGENT_AUTH_PROFILE_IDS.has(modelFallback.prevAuthProfileOverride);
  const unsafeModel = typeof modelFallback.prevModel === "string" && (
    unsupportedUserModel(modelFallback.prevProvider, modelFallback.prevModel) ||
    directRuntimeModelRefs.has(modelFallback.prevModel)
  );
  return unsafeProvider || unsafeAuth || unsafeModel;
}

function hasExecutableSessionState(entry) {
  return [
    entry.toolOverrides,
    entry.execHost,
    entry.execSecurity,
    entry.execAsk,
    entry.execNode,
    entry.execCwd,
    entry.elevatedLevel,
    entry.acpSessionBinding,
    entry.acp,
    entry.pluginExtensions,
  ].some((state) => state !== undefined);
}

function sessionEntryUsesUnsafeRuntime(rawEntry, directRuntimeModelRefs) {
  const entry = objectValue(rawEntry);
  if (!entry) return false;
  const modelFallback = objectValue(entry.modelFallback) ?? {};
  const cliSessionIds = Object.keys(objectValue(entry.cliSessionIds) ?? {});
  const cliSessionBindings = Object.keys(objectValue(entry.cliSessionBindings) ?? {});
  const unsafeAuth = typeof entry.authProfileOverride === "string" &&
    !CANONICAL_AGENT_AUTH_PROFILE_IDS.has(entry.authProfileOverride);
  return [
    hasUnsafeSessionModelState(entry, directRuntimeModelRefs),
    hasUnsafeFallbackState(modelFallback, directRuntimeModelRefs),
    [entry.agentRuntimeOverride, entry.agentHarnessId].some(isDirectAgentRuntimeId),
    entry.pluginOwnerId === "codex",
    typeof entry.claudeCliSessionId === "string",
    hasExecutableSessionState(entry),
    cliSessionIds.some(isDirectAgentRuntimeId),
    cliSessionBindings.some(isDirectAgentRuntimeId),
    unsafeAuth,
  ].some(Boolean);
}

function clearSessionRuntimeState(rawEntry) {
  const entry = objectValue(rawEntry);
  if (!entry) return false;
  let changed = false;
  for (const field of SESSION_RUNTIME_STATE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(entry, field)) continue;
    delete entry[field];
    changed = true;
  }
  return changed;
}

function scrubUnsafeLegacySessions(sessionsPath, directRuntimeModelRefs) {
  const sessions = readSessionMap(sessionsPath);
  if (!sessions) return false;
  let changed = false;
  for (const entry of Object.values(sessions)) {
    if (sessionEntryUsesUnsafeRuntime(entry, directRuntimeModelRefs)) {
      changed = clearSessionRuntimeState(entry) || changed;
    }
  }
  if (changed) atomicWrite(sessionsPath, `${JSON.stringify(sessions)}\n`);
  return changed;
}

function scrubUnsafePersistedSessions(openclawDir, agentId, directRuntimeModelRefs) {
  const sessionsPath = path.join(openclawDir, "agents", agentId, "sessions", "sessions.json");
  const legacyChanged = scrubUnsafeLegacySessions(sessionsPath, directRuntimeModelRefs);
  const dbPath = path.join(openclawDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  const sqliteChanged = mutateSqliteSessionStore(dbPath, (entry) =>
    sessionEntryUsesUnsafeRuntime(entry, directRuntimeModelRefs) && clearSessionRuntimeState(entry));
  return legacyChanged || sqliteChanged;
}

function projectUnmatchedRouteModelMetadata(openclawDir, config, modelProviders) {
  const unmatchedId = "octogee-unmatched-route";
  const configured = config.agents?.entries?.[unmatchedId] ||
    config.agents?.list?.some((agent) => agent.id === unmatchedId);
  if (!configured) return;
  const metadata = structuredClone(modelProviders);
  for (const provider of Object.values(metadata)) delete provider.apiKey;
  projectAgentModelsJson(path.join(openclawDir, "agents", unmatchedId, "agent"), metadata);
}

function scrubUserOauthDisk(
  configPath,
  config,
  env,
  {
    resetAgentIds,
    directRuntimeModelRefs,
    preserveNativeCredentials = false,
  },
) {
  const openclawDir = env.OPENCLAW_DIR ?? path.dirname(configPath);
  const homeDir = env.HOME ?? "/home/node";
  const nativeCredential = path.join(homeDir, ".claude", ".credentials.json");
  const nativeRemoved = preserveNativeCredentials
    ? false
    : [nativeCredential, `${nativeCredential}.tmp`].map(removeFile).some(Boolean);
  const agentIds = configuredUserAgentIds(config);
  const modelProviders = userDiskModelProviders(env);
  if (nativeRemoved) agentIds.forEach((agentId) => resetAgentIds.add(agentId));
  for (const agentId of agentIds) {
    const agentDir = path.join(openclawDir, "agents", agentId, "agent");
    const authJson = path.join(agentDir, "codex-home", "auth.json");
    const authRemoved = preserveNativeCredentials
      ? false
      : [authJson, `${authJson}.tmp`, `${authJson}.promote.tmp`]
        .map(removeFile)
        .some(Boolean);
    const staging = path.join(agentDir, "codex-home.staging");
    const stagingRemoved = !preserveNativeCredentials && fs.existsSync(staging);
    if (stagingRemoved) fs.rmSync(staging, { recursive: true, force: true });
    const profilesScrubbed = scrubAgentOauthProfiles(agentDir, agentId, env);
    const modelsScrubbed = projectAgentModelsJson(agentDir, modelProviders);
    scrubUnsafePersistedSessions(openclawDir, agentId, directRuntimeModelRefs);
    if (
      authRemoved ||
      stagingRemoved ||
      profilesScrubbed ||
      modelsScrubbed
    ) {
      resetAgentIds.add(agentId);
    }
  }
  projectUnmatchedRouteModelMetadata(openclawDir, config, modelProviders);
  for (const agentId of resetAgentIds) resetAgentSessionStore(openclawDir, agentId);
}

function applyUserPolicy(config) {
  config.tools ??= {};
  config.tools.elevated ??= {};
  config.tools.elevated.enabled = false;
  config.tools.deny = addTools(
    removeTools(config.tools.deny, USER_STRUCTURED_AVAILABLE_TOOLS),
    USER_CODE_DENIED_TOOLS,
  );
  config.tools.exec = { mode: "deny" };
  config.tools.subagents ??= {};
  config.tools.subagents.tools ??= {};
  config.tools.subagents.tools.deny = addTools(config.tools.subagents.tools.deny, [
    "exec",
    "process",
  ]);
  removeSharedSubagentDefaults(config);
  setTerminal(config, false);
  restrictSessionVisibility(config);
  disableUserConfigMutation(config);
  disableUserAutomationsAndSkillWrites(config);
  forceUserMattermostProjection(config);
  forceUserWorkspaceOnly(config);
  convergePlatformCapabilities(config, false);
  clearConnectorWriteApproval(config);
  removePolicyCodexAuthPlaceholder(config);
  disableCodex(config);
}

function preserveIsolatedPluginConfiguration(config) {
  if (!objectValue(config.plugins)) return;
  delete config.plugins.load;
  delete config.plugins.installs;
}

const ISOLATED_SECRET_REF_PROVIDERS = new Set([
  "gcp-secret-manager",
  "octogee-mattermost",
]);
const INLINE_SECRET_KEYS = new Set([
  "apiKey",
  "key",
  "token",
  "secret",
  "password",
  "botToken",
  "keyRef",
  "tokenRef",
]);

function isSafeIsolatedSecretRef(value) {
  const ref = objectValue(value);
  return (
    ref &&
    typeof ref.id === "string" &&
    ISOLATED_SECRET_REF_PROVIDERS.has(ref.provider) &&
    ((ref.source === "exec" && ref.provider === "gcp-secret-manager") ||
      (ref.source === "file" && ref.provider === "octogee-mattermost"))
  );
}

function sanitizeIsolatedSecretReferences(value) {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index--) {
      const child = value[index];
      if (isSecretRef(child)) {
        if (!isSafeIsolatedSecretRef(child)) value.splice(index, 1);
        continue;
      }
      sanitizeIsolatedSecretReferences(child);
    }
    return;
  }
  const record = objectValue(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    if (INLINE_SECRET_KEYS.has(key) && typeof child === "string") {
      delete record[key];
      continue;
    }
    if (isSecretRef(child)) {
      if (!isSafeIsolatedSecretRef(child)) delete record[key];
      continue;
    }
    sanitizeIsolatedSecretReferences(child);
  }
}

function projectIsolatedSecretProviders(config, openclawDir) {
  sanitizeIsolatedSecretReferences(config);
  projectAgentStoreSecretRef(config);
  config.secrets ??= {};
  const providers = objectValue(config.secrets.providers) ?? {};
  config.secrets.providers = providers;
  providers["gcp-secret-manager"] = {
    source: "exec",
    command: "/octogee/scripts/secret-resolver.mjs",
    passEnv: [
      "FLEET_BROKER_URL",
      "OCTOGEE_API_URL",
      "OCTOGEE_API_SA_TOKEN_PATH",
      "INTERNAL_SERVICE_KEY",
      "OPENCLAW_AGENTS_DIR",
      "OPENCLAW_DIR",
      "GATEWAY_ID",
      "HOME",
    ],
    jsonOnly: true,
    timeoutMs: 45000,
  };
  providers["octogee-mattermost"] = {
    source: "file",
    path: path.join(openclawDir, "secrets", "mattermost-accounts.json"),
    mode: "json",
  };
}

// A Builder gateway is the Builder's own OpenClaw. No platform credential lives
// in the pod, so host code, terminals, MCP servers, cron, skills, sub-agents,
// and the codex BYOSUB plugin stay at the user's discretion; the platform
// keeps only its plugin configuration boundary and tenant-scoped secret providers.
function applyIsolatedPolicy(config, openclawDir, env) {
  projectMattermostAccounts(config, false);
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.modelPolicy ??= {};
  config.agents.defaults.modelPolicy.allow = [];
  convergePlatformCapabilities(config, true);
  preserveIsolatedPluginConfiguration(config);
  projectIsolatedSecretProviders(config, openclawDir);
  applyControlIdentityPolicy(config, env, readUserClaim(openclawDir, env.GATEWAY_ID?.trim()));
}

function applyIsolatedTalkDefaults(config) {
  addIsolatedToolCapabilities(config, ["screen", "talk_voice"]);
  config.plugins.entries["octogee-voice-tools"] ??= {};
  config.plugins.entries["octogee-voice-tools"].enabled ??= true;
  config.plugins.entries["octogee-voice-tools"].config = {
    brokerUrl: FLEET_BROKER_URL_TEMPLATE,
    tokenPath: API_SA_TOKEN_PATH_TEMPLATE,
  };
  config.talk ??= {};
  config.talk.realtime ??= {
    provider: "octogee-openai", providers: { "octogee-openai": { model: "gpt-live-1" }, octogee: {} },
    mode: "realtime", transport: "gateway-relay", brain: "agent-consult", consultRouting: "provider-direct",
  };
}

function applyControlIdentityPolicy(config, env, claim) {
  config.plugins ??= {};
  config.plugins.entries ??= {};
  config.plugins.entries["octogee-identity-tools"] = { enabled: isPerUserControlIdentity(env) };
  if (isPerUserControlIdentity(env)) {
    applyIsolatedTalkDefaults(config);
    config.gateway ??= {};
    config.gateway.auth ??= {};
    const auth = config.gateway.auth;
    delete auth.token;
    delete auth.allowTailscale;
    auth.mode = OPENCLAW_TRUSTED_PROXY_AUTH.mode;
    auth.trustedProxy = structuredClone(OPENCLAW_TRUSTED_PROXY_AUTH.trustedProxy);
    auth.identityScopes = openClawIdentityScopes(claim?.ownerUid);
    config.gateway.trustedProxies = [...OPENCLAW_TRUSTED_PROXIES];
    config.gateway.roles = withOpenClawOperatorRoles(config.gateway.roles, claim?.builderSlug);
    // Only extend an allowlist that already exists. An absent `plugins.allow`
    // means "every plugin is allowed", so identity-tools is permitted already;
    // materializing a list here would narrow the gateway to this single entry
    // and drop the platform capability plugins convergence just enabled.
    if (Array.isArray(config.plugins.allow)) {
      config.plugins.allow = [...new Set([...config.plugins.allow, "octogee-identity-tools", "octogee-voice-tools", "talk-voice"])];
    }
    return;
  }
  const gateway = config.gateway;
  if (!gateway || typeof gateway !== "object") return;
  const auth = gateway.auth;
  const trustedProxyResidue = auth?.mode === "trusted-proxy" || auth?.trustedProxy !== undefined;
  if (trustedProxyResidue) {
    auth.mode = "token";
    delete auth.trustedProxy;
  }
  delete gateway.trustedProxies;
  delete gateway.roles;
}

function resolveGatewayClass(env) {
  return isIsolatedGatewayClassValue(env.GATEWAY_CLASS) ? "isolated" : "shared";
}

function resolveOpenclawJsonPath() {
  if (process.env.OPENCLAW_CONFIG_PATH?.trim()) return process.env.OPENCLAW_CONFIG_PATH.trim();
  const dir =
    process.env.OPENCLAW_DIR ?? path.join(process.env.HOME ?? "/home/node", ".openclaw");
  return path.join(dir, "openclaw.json");
}

function atomicWrite(destination, bytes) {
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), ".gateway-policy-"));
  try {
    const file = path.join(staging, "next");
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(file, destination);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function applyGatewayClassPolicy({ openclawJsonPath, env = process.env } = {}) {
  const configPath = openclawJsonPath ?? resolveOpenclawJsonPath();
  if (!fs.existsSync(configPath)) return { applied: false, reason: "no-openclaw-json" };
  const raw = fs.readFileSync(configPath, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `apply-gateway-class-policy: ${configPath} is not valid JSON — refusing to overwrite (${err.message})`,
    );
  }
  const gatewayClass = resolveGatewayClass(env);
  const openclawDir = env.OPENCLAW_DIR ?? path.dirname(configPath);
  const retiredMattermostInstallRecordRemoved =
    removeRetiredMattermostInstallRecord(openclawDir);
  const staleCodexInstallRecordRemoved = removeStaleCodexInstallRecord(openclawDir);
  const before = JSON.stringify(config);
  if (gatewayClass === "shared") {
    projectUserPlugins(config);
    projectUserSecretProviders(config, openclawDir);
    projectUserSpawnNamespaces(config);
    const scrub = scrubUserOauthConfig(config, env);
    scrubUserOauthDisk(
      configPath,
      config,
      env,
      {
        resetAgentIds: scrub.resetAgentIds,
        directRuntimeModelRefs: scrub.directRuntimeModelRefs,
        preserveNativeCredentials: gatewayClass === "isolated",
      },
    );
    applyUserPolicy(config);
  } else if (gatewayClass === "isolated") {
    applyIsolatedPolicy(config, openclawDir, env);
  }
  if (JSON.stringify(config) === before) {
    const installRecordRemoved = retiredMattermostInstallRecordRemoved || staleCodexInstallRecordRemoved;
    let reason = "already-set";
    if (retiredMattermostInstallRecordRemoved) reason = "retired-mattermost-install";
    else if (staleCodexInstallRecordRemoved) reason = "source-mismatched-codex-install";
    return {
      applied: installRecordRemoved,
      reason,
      ...(installRecordRemoved ? { path: configPath } : {}),
      gatewayClass,
    };
  }
  atomicWrite(configPath, JSON.stringify(config, null, 2));
  return { applied: true, path: configPath, gatewayClass };
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = applyGatewayClassPolicy();
  if (result.applied) {
    console.log(`[apply-gateway-class-policy] applied class=${result.gatewayClass} in ${result.path}`);
  } else {
    console.log(`[apply-gateway-class-policy] skipped: ${result.reason}`);
  }
}
