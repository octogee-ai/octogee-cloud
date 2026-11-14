import { parseAgentId, type ParsedAgentId } from "@octogee/shared/types/identity";
import { isDeepStrictEqual } from "node:util";
import {
  PLATFORM_MATTERMOST_BASE_URL,
  platformAgentMattermostAccountsProjected,
  projectPlatformAgentMattermostAccounts,
} from "@octogee/shared/types/openclaw-mattermost-accounts";
import {
  openClawOperatorRoles,
  OPENCLAW_TRUSTED_PROXIES,
  OPENCLAW_TRUSTED_PROXY_AUTH,
  openClawIdentityScopes,
  withOpenClawOperatorRoles,
} from "@octogee/shared/types/openclaw-proxy-identity";

type JsonObject = Record<string, unknown>;

const ABSENT = Symbol("absent");
const REQUIRED_ARRAY = "required-array" as const;
const USER_AGENT_WORKSPACE = "customer-agent-workspace" as const;
const USER_AGENT_TOOL_POLICY = "customer-agent-tool-policy" as const;
const PROJECT_AGENT_TOOL_POLICY = "project-agent-tool-policy" as const;
const FORBIDDEN_ARRAY = "forbidden-array" as const;
const PLUGIN_ALLOWLIST_PATH = "plugins.allow";

export type GatewayConfigClass = "shared" | "isolated";

export type GatewayControlIdentityMode = "shared-operator" | "per-user";

type BrokerProviderEnvironment = Partial<Pick<NodeJS.ProcessEnv, "OPENROUTER_BASE_URL" | "PLATFORM_OPENAI_BASE_URL" | "PLATFORM_VERTEX_BASE_URL" | "PLATFORM_META_BASE_URL">>;
const BROKER_PROVIDER_DECLARATIONS = [
  ["platform-openrouter", "OPENROUTER_BASE_URL"],
  ["platform-openai", "PLATFORM_OPENAI_BASE_URL"],
  ["platform-vertex", "PLATFORM_VERTEX_BASE_URL"],
  ["platform-meta", "PLATFORM_META_BASE_URL"],
] as const;

/** Declare provider ownership; API, model rows and credentials remain agent-local. */
export function platformBrokerProviderDeclarations(env: BrokerProviderEnvironment): Record<string, { baseUrl: string; models: never[] }> {
  return Object.fromEntries(BROKER_PROVIDER_DECLARATIONS.flatMap(([id, key]) => {
    const baseUrl = env[key]?.trim();
    return baseUrl ? [[id, { baseUrl, models: [] }]] : [];
  }));
}

/** Missing public declarations are a safe addition; existing routes and auth must match exactly. */
export function userModelProviderDeclarationsMatch(current: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const required = { ...expected };
  for (const [id] of BROKER_PROVIDER_DECLARATIONS) {
    if (!Object.hasOwn(current, id)) delete required[id];
  }
  return isDeepStrictEqual(current, required);
}

export interface SystemConfigInvariantContext {
  gatewayClass: GatewayConfigClass;
  gatewayId?: string;
  apiOrigin?: string;
  controlIdentity?: GatewayControlIdentityMode;
  ownerUid?: string;
  workspaceSlug?: string;
  brokerProviderEnv?: BrokerProviderEnvironment;
}

type ExactInvariant = {
  kind: "exact";
  path: string;
  value: unknown | typeof ABSENT;
  project?: boolean;
};

type RequiredArrayInvariant = {
  kind: typeof REQUIRED_ARRAY;
  path: string;
  values: readonly string[];
};

type ForbiddenArrayInvariant = {
  kind: typeof FORBIDDEN_ARRAY;
  path: string;
  values: readonly string[];
};

type UserAgentWorkspaceInvariant = {
  kind: typeof USER_AGENT_WORKSPACE;
  path:
    | "agents.list[].tools.fs.workspaceOnly"
    | "agents.entries.*.tools.fs.workspaceOnly";
};

type MattermostAccountProjectionInvariant = {
  kind: "mattermost-account-projection";
  path: "channels.mattermost.accounts";
  platformOwned: boolean;
};

type UserAgentToolPolicyInvariant = {
  kind: typeof USER_AGENT_TOOL_POLICY;
  path: "agents.list[].tools" | "agents.entries.*.tools";
};

type ProjectAgentToolPolicyInvariant = {
  kind: typeof PROJECT_AGENT_TOOL_POLICY;
  path: "agents.list[].tools" | "agents.entries.*.tools";
};

export type PlatformInvariant =
  | ExactInvariant
  | RequiredArrayInvariant
  | ForbiddenArrayInvariant
  | UserAgentWorkspaceInvariant
  | UserAgentToolPolicyInvariant
  | ProjectAgentToolPolicyInvariant
  | MattermostAccountProjectionInvariant;

const REQUIRED_PLUGINS = [
  "mattermost",
  "anthropic",
  "memory-core",
  "octogee-chat-tools",
  "octogee-activity-tools",
  "octogee-access-tools",
  "octogee-connector-tools",
  "octogee-ops-tools",
  "octogee-project-tools",
  "octogee-board-tools",
  "octogee-status-tools",
  "octogee-broker-tools",
  "octogee-web-tools",
  "octogee-workspace-tools",
  "parallel",
] as const;

const RETIRED_PLUGINS = [
  "octogee-computer-tools",
  "octogee-mattermost-tools",
  "octogee-router",
  "octogee-preview-tools",
  "octogee-publish-tools",
] as const;

const PLUGIN_ENTRIES = REQUIRED_PLUGINS.filter((id) => id !== "memory-core");

const FLEET_BROKER_URL_PLACEHOLDER = "${FLEET_BROKER_URL}";
const OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER = "${OCTOGEE_API_SA_TOKEN_PATH}";

const PLATFORM_PLUGIN_CONFIGS: Readonly<Record<string, JsonObject>> = {
  "octogee-activity-tools": {
    heartbeatMs: 5_000,
  },
  "octogee-chat-tools": {
    siteUrl: "${MM_SITE_URL}",
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
    customersRoot: "${CUSTOMERS_DIR}",
  },
  "octogee-access-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  },
  "octogee-ops-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  },
  "octogee-project-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  },
  "octogee-board-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  },
  "octogee-broker-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  },
  "octogee-status-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
    gatewayClass: "${GATEWAY_CLASS}",
  },
  "octogee-web-tools": {
    brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
    gatewayId: "${GATEWAY_ID}",
    tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  },
  "octogee-workspace-tools": {},
};

const PLATFORM_PLUGIN_CONFIG_FIELDS: Readonly<Record<string, unknown>> = {
  "plugins.entries.octogee-connector-tools.config.brokerUrl":
    FLEET_BROKER_URL_PLACEHOLDER,
  "plugins.entries.octogee-connector-tools.config.tokenPath":
    OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
  "plugins.entries.octogee-connector-tools.config.requireWriteApproval": ABSENT,
  "plugins.entries.octogee-chat-tools.hooks.allowPromptModification": true,
  "plugins.entries.octogee-chat-tools.hooks.allowConversationAccess": true,
  "plugins.entries.octogee-chat-tools.hooks.timeouts.before_dispatch": 3000,
  "plugins.entries.octogee-chat-tools.hooks.timeouts.before_prompt_build": 3000,
  "plugins.entries.octogee-chat-tools.hooks.timeouts.before_agent_run": 3000,
};

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
] as const;

const USER_STRUCTURED_AVAILABLE_TOOLS = [
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
] as const;

export const USER_WORKFLOW_TOOLS = [
  "automations",
  "message",
  "octogee_project_create",
  "octogee_project_delegate",
  "octogee_project_commit",
  "octogee_project_list",
  "octogee_project_set_recipe",
  "octogee_project_capability",
  "octogee_project_build",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_publish",
  "octogee_board_list",
  "octogee_board_card_read",
  "octogee_board_card_create",
  "octogee_board_card_update",
  "octogee_board_card_move",
  "octogee_board_card_comment",
  "workspace_commit",
  "brave_search",
  "tavily_search",
  "tavily_extract",
  "octogee_chat_search",
  "octogee_chat_history",
  "octogee_chat_set_identity",
  "octogee_connection_request",
  "octogee_status",
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
] as const;

export const PRODUCTIVITY_TOOL_NAMES = USER_WORKFLOW_TOOLS.filter((tool) =>
  tool.startsWith("octogee_google_") || tool.startsWith("octogee_obsidian_"));

export const PROJECT_AGENT_ALLOWED_TOOLS = [
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
] as const;

export const PROJECT_AGENT_DENIED_TOOLS = [
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
] as const;

function userToolInvariants(): PlatformInvariant[] {
  return [
    { kind: "exact", path: "tools.elevated.enabled", value: false },
    {
      kind: REQUIRED_ARRAY,
      path: "tools.deny",
      values: USER_CODE_DENIED_TOOLS,
    },
    {
      kind: FORBIDDEN_ARRAY,
      path: "tools.deny",
      values: USER_STRUCTURED_AVAILABLE_TOOLS,
    },
    { kind: "exact", path: "tools.profile", value: "coding" },
    { kind: "exact", path: "tools.allow", value: ABSENT },
    { kind: "exact", path: "tools.alsoAllow", value: USER_WORKFLOW_TOOLS },
    { kind: "exact", path: "tools.exec", value: { mode: "deny" } },
    { kind: "exact", path: "tools.fs.workspaceOnly", value: true },
    { kind: "exact", path: "tools.sessions.visibility", value: "self" },
    {
      kind: REQUIRED_ARRAY,
      path: "tools.subagents.tools.deny",
      values: ["exec", "process"],
    },
    { kind: "exact", path: "gateway.terminal.enabled", value: false },
    {
      kind: "exact",
      path: "channels.mattermost.network",
      value: { dangerouslyAllowPrivateNetwork: true },
    },
    {
      kind: "exact",
      path: "channels.mattermost.interactions",
      value: {
        callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
        allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
      },
    },
    { kind: "exact", path: "commands.bash", value: false },
    { kind: "exact", path: "commands.config", value: false },
    { kind: "exact", path: "commands.mcp", value: false },
    { kind: "exact", path: "commands.plugins", value: false },
    { kind: "exact", path: "commands.debug", value: false },
    { kind: "exact", path: "mcp.servers", value: ABSENT },
    { kind: "exact", path: "cron.triggers.enabled", value: false },
    { kind: "exact", path: "skills.load.allowSymlinkTargets", value: ABSENT },
    { kind: "exact", path: "skills.load.extraDirs", value: ABSENT },
    { kind: "exact", path: "skills.workshop", value: ABSENT },
    { kind: REQUIRED_ARRAY, path: PLUGIN_ALLOWLIST_PATH, values: ["skill-workshop"] },
    { kind: "exact", path: "plugins.entries.skill-workshop", value: { enabled: true, config: { autonomous: { mode: "off" } } } },
    { kind: FORBIDDEN_ARRAY, path: PLUGIN_ALLOWLIST_PATH, values: ["codex"] },
    {
      kind: "exact",
      path: "plugins.entries.codex",
      value: {
        enabled: false,
        config: { appServer: { sandbox: "workspace-write", approvalPolicy: "never" } },
      },
    },
    {
      kind: USER_AGENT_WORKSPACE,
      path: "agents.list[].tools.fs.workspaceOnly",
    },
    {
      kind: USER_AGENT_WORKSPACE,
      path: "agents.entries.*.tools.fs.workspaceOnly",
    },
    { kind: USER_AGENT_TOOL_POLICY, path: "agents.list[].tools" },
    { kind: USER_AGENT_TOOL_POLICY, path: "agents.entries.*.tools" },
  ];
}

function controlIdentityInvariants(
  perUser: boolean,
  ownerUid: string | undefined,
  workspaceSlug: string | undefined,
): PlatformInvariant[] {
  return [
    { kind: "exact", path: "plugins.entries.octogee-identity-tools.enabled", value: perUser },
    ...(perUser ? [{ kind: REQUIRED_ARRAY, path: PLUGIN_ALLOWLIST_PATH, values: ["octogee-identity-tools"] }] : []),
    { kind: "exact", path: "gateway.auth.mode", value: perUser ? "trusted-proxy" : "token" },
    {
      kind: "exact",
      path: "gateway.auth.trustedProxy",
      value: perUser ? OPENCLAW_TRUSTED_PROXY_AUTH.trustedProxy : ABSENT,
    },
    {
      kind: "exact",
      path: "gateway.auth.identityScopes",
      value: perUser ? openClawIdentityScopes(ownerUid) : ABSENT,
    },
    { kind: "exact", path: "gateway.trustedProxies", value: perUser ? [...OPENCLAW_TRUSTED_PROXIES] : ABSENT },
    ...(perUser
      ? Object.entries(openClawOperatorRoles(workspaceSlug).definitions).map(([role, definition]) => (
        { kind: "exact" as const, path: `gateway.roles.definitions.${role}`, value: definition }
      ))
      : [{ kind: "exact" as const, path: "gateway.roles", value: ABSENT }]),
  ];
}

export function platformInvariantTable(
  context: SystemConfigInvariantContext,
): readonly PlatformInvariant[] {
  const isolated = context.gatewayClass === "isolated";
  const gatewayId = context.gatewayId?.trim();
  const apiOrigin = context.apiOrigin?.trim().replace(/\/$/, "");
  if (isolated && (!gatewayId || !apiOrigin)) {
    throw new Error("gatewayId and apiOrigin are required for isolated config invariants");
  }
  const perUser = isolated && context.controlIdentity === "per-user";
  const brokerProviders = platformBrokerProviderDeclarations(context.brokerProviderEnv ?? {});
  const base: PlatformInvariant[] = [
    { kind: "exact", path: "meta.migrations.skillWorkshopPlugin", value: true },
    { kind: "exact", path: "discovery.mdns.mode", value: "off" },
    { kind: "exact", path: "gateway.port", value: 18789 },
    { kind: "exact", path: "gateway.mode", value: "local" },
    { kind: "exact", path: "gateway.bind", value: "lan" },
    ...controlIdentityInvariants(perUser, context.ownerUid, context.workspaceSlug),
    { kind: "exact", path: "gateway.auth.token", value: ABSENT },
    { kind: "exact", path: "gateway.auth.password", value: ABSENT },
    { kind: "exact", path: "gateway.auth.allowTailscale", value: ABSENT },
    {
      kind: "exact",
      path: "gateway.controlUi.allowedOrigins",
      value: isolated
        ? [apiOrigin]
        : ["http://localhost:18789", "http://127.0.0.1:18789"],
    },
    {
      kind: "exact",
      path: "gateway.controlUi.basePath",
      value: isolated ? `/g/${gatewayId}/openclaw` : ABSENT,
    },
    { kind: "exact", path: "gateway.controlUi.allowInsecureAuth", value: ABSENT },
    { kind: "exact", path: "gateway.controlUi.dangerouslyDisableDeviceAuth", value: ABSENT },
    { kind: "exact", path: "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback", value: false },
    { kind: "exact", path: "logging.redactSensitive", value: ABSENT },
    {
      kind: "exact",
      path: "secrets.providers.octogee-mattermost",
      value: {
        source: "file",
        path: "/home/node/.openclaw/secrets/mattermost-accounts.json",
        mode: "json",
      },
    },
    { kind: "exact", path: "channels.mattermost.enabled", value: true },
    ...(!isolated ? [{ kind: "exact" as const, path: "channels.mattermost.baseUrl", value: ABSENT }] : []),
    { kind: "exact", path: "channels.mattermost.network.dangerouslyAllowPrivateNetwork", value: true },
    {
      kind: "exact",
      path: "channels.mattermost.interactions.callbackBaseUrl",
      value: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
    },
    {
      kind: "exact",
      path: "channels.mattermost.interactions.allowedSourceIps",
      value: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
    },
    { kind: "exact", path: "channels.mattermost.commands.native", value: false },
    { kind: "mattermost-account-projection", path: "channels.mattermost.accounts", platformOwned: !isolated },
    { kind: "exact", path: "models.providers.octogee-broker", value: { baseUrl: "${ANTHROPIC_BASE_URL}", models: [] } },
    ...(context.brokerProviderEnv === undefined ? [] : BROKER_PROVIDER_DECLARATIONS.map<PlatformInvariant>(([id]) => ({
      kind: "exact", path: `models.providers.${id}`, value: brokerProviders[id] ?? ABSENT,
    }))),
    { kind: "exact", path: "plugins.enabled", value: true },
    { kind: REQUIRED_ARRAY, path: PLUGIN_ALLOWLIST_PATH, values: REQUIRED_PLUGINS },
    { kind: FORBIDDEN_ARRAY, path: PLUGIN_ALLOWLIST_PATH, values: RETIRED_PLUGINS },
    ...RETIRED_PLUGINS.map<PlatformInvariant>((id) => ({
      kind: "exact",
      path: `plugins.entries.${id}`,
      value: ABSENT,
    })),
    ...PLUGIN_ENTRIES.map<PlatformInvariant>((id) => ({
      kind: "exact",
      path: `plugins.entries.${id}.enabled`,
      value: true,
    })),
    ...Object.entries(PLATFORM_PLUGIN_CONFIGS).map<PlatformInvariant>(([id, value]) => ({
      kind: "exact",
      path: `plugins.entries.${id}.config`,
      value,
    })),
    ...(perUser ? [{
      kind: "exact" as const,
      path: "plugins.entries.octogee-voice-tools.config",
      value: {
        brokerUrl: FLEET_BROKER_URL_PLACEHOLDER,
        tokenPath: OCTOGEE_API_SA_TOKEN_PATH_PLACEHOLDER,
      },
    }] : []),
    ...Object.entries(PLATFORM_PLUGIN_CONFIG_FIELDS).map<PlatformInvariant>(([path, value]) => ({
      kind: "exact",
      path,
      value,
    })),
  ];
  if (!isolated) {
    base.push({ kind: "exact", path: "commands.ownerAllowFrom", value: ABSENT });
  }
  const platformProjection = base;
  // An isolated gateway is the user's own OpenClaw: no platform credential lives
  // in the pod, so host code, terminals, MCP servers, cron, skills, sub-agents,
  // and the codex BYOSUB plugin stay at the user's discretion. The platform
  // keeps only wiring and tenant-scoped secret providers.
  return context.gatewayClass === "isolated"
    ? platformProjection
    : [...platformProjection, ...userToolInvariants()];
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function readPath(root: JsonObject, dottedPath: string): unknown | typeof ABSENT {
  let current: unknown = root;
  for (const part of dottedPath.split(".")) {
    const record = asObject(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, part)) return ABSENT;
    current = record[part];
  }
  return current;
}

function parentForPath(root: JsonObject, dottedPath: string): [JsonObject, string] {
  const parts = dottedPath.split(".");
  const leaf = parts.pop()!;
  let current = root;
  for (const part of parts) {
    const existing = asObject(current[part]);
    if (existing) {
      current = existing;
      continue;
    }
    const created: JsonObject = {};
    current[part] = created;
    current = created;
  }
  return [current, leaf];
}

function equal(left: unknown, right: unknown): boolean {
  if (left === ABSENT || right === ABSENT) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equal(value, right[index]));
  }
  const leftObject = asObject(left);
  const rightObject = asObject(right);
  if (leftObject || rightObject) {
    if (!leftObject || !rightObject) return false;
    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && equal(leftObject[key], rightObject[key]));
  }
  return Object.is(left, right);
}

function userAgentRecords(
  config: JsonObject,
  path: UserAgentWorkspaceInvariant["path"],
): JsonObject[] {
  const agents = asObject(config.agents);
  if (!agents) return [];
  if (path === "agents.list[].tools.fs.workspaceOnly") {
    return Array.isArray(agents.list)
      ? agents.list.flatMap((entry) => {
        const record = asObject(entry);
        return record ? [record] : [];
      })
      : [];
  }
  const entries = asObject(agents.entries);
  return entries
    ? Object.values(entries).flatMap((entry) => {
      const record = asObject(entry);
      return record ? [record] : [];
    })
    : [];
}

function agentWorkspaceOnly(agent: JsonObject): boolean {
  return asObject(asObject(agent.tools)?.fs)?.workspaceOnly === true;
}

function forceAgentWorkspaceOnly(agent: JsonObject): void {
  const tools = asObject(agent.tools) ?? {};
  agent.tools = tools;
  const fs = asObject(tools.fs) ?? {};
  tools.fs = fs;
  fs.workspaceOnly = true;
}

function userAgentEntries(
  config: JsonObject,
  path: UserAgentToolPolicyInvariant["path"],
): Array<{ agent: JsonObject; agentId: string }> {
  const agents = asObject(config.agents);
  if (!agents) return [];
  if (path === "agents.list[].tools") {
    return Array.isArray(agents.list)
      ? agents.list.flatMap((entry) => {
        const agent = asObject(entry);
        return agent && typeof agent.id === "string"
          ? [{ agent, agentId: agent.id }]
          : [];
      })
      : [];
  }
  const entries = asObject(agents.entries);
  return entries
    ? Object.entries(entries).flatMap(([agentId, entry]) => {
      const agent = asObject(entry);
      return agent ? [{ agent, agentId }] : [];
    })
    : [];
}

function agentToolPolicySatisfied(config: JsonObject, agent: JsonObject, agentId: string): boolean {
  const parsed = parseAgentId(agentId);
  const tools = asObject(agent.tools);
  const deny = Array.isArray(tools?.deny) ? tools.deny : [];
  const expectedAlsoAllow = allowedToolsForAgent(parsed.kind);
  const expectedSenderPolicy = userToolsBySenderPolicy(config, agentId);
  return tools !== null
    && tools.profile === (parsed.kind === "coach" ? "coding" : "minimal")
    && equal(tools.alsoAllow, expectedAlsoAllow)
    && !Object.prototype.hasOwnProperty.call(tools, "allow")
    && (parsed.kind === "project"
      ? equal(deny, PROJECT_AGENT_DENIED_TOOLS)
      : USER_CODE_DENIED_TOOLS.every((tool) => deny.includes(tool))
        && USER_STRUCTURED_AVAILABLE_TOOLS.every((tool) => !deny.includes(tool)))
    && equal(tools.toolsBySender, expectedSenderPolicy);
}

function forceAgentToolPolicy(config: JsonObject, agent: JsonObject, agentId: string): void {
  const parsed = parseAgentId(agentId);
  const tools = asObject(agent.tools) ?? {};
  agent.tools = tools;
  tools.profile = parsed.kind === "coach" ? "coding" : "minimal";
  tools.alsoAllow = structuredClone(allowedToolsForAgent(parsed.kind));
  const deny = Array.isArray(tools.deny)
    ? tools.deny.filter((value): value is string => typeof value === "string")
    : [];
  tools.deny = parsed.kind === "project"
    ? structuredClone(PROJECT_AGENT_DENIED_TOOLS)
    : [
      ...deny.filter((tool) => !USER_STRUCTURED_AVAILABLE_TOOLS.includes(
        tool as typeof USER_STRUCTURED_AVAILABLE_TOOLS[number],
      )),
      ...USER_CODE_DENIED_TOOLS.filter((tool) => !deny.includes(tool)),
    ];
  tools.toolsBySender = userToolsBySenderPolicy(config, agentId);
  delete tools.allow;
}

export function reconcileSharedGatewayAgentEntry(
  agentId: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const agent = structuredClone(entry);
  forceAgentWorkspaceOnly(agent);
  forceAgentToolPolicy({}, agent, agentId);
  return agent;
}

export function reconcileIsolatedGatewayAgentEntry(
  agentId: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const agent = structuredClone(entry);
  const parsed = parseAgentId(agentId);
  const tools = asObject(agent.tools);
  if ((parsed.kind === "coach" || parsed.kind === "project") && carriesSharedHostCodeFence(tools)) {
    delete agent.tools;
  }
  return agent;
}

function carriesSharedHostCodeFence(tools: JsonObject | null): boolean {
  if (!tools) return false;
  const deny = Array.isArray(tools.deny) ? tools.deny : [];
  return deny.includes("exec") && deny.includes("process") && (
    asObject(tools.fs)?.workspaceOnly === true ||
    asObject(tools.exec)?.mode === "deny"
  );
}


function allowedToolsForAgent(kind: ParsedAgentId["kind"]): readonly string[] {
  if (kind === "coach") return USER_WORKFLOW_TOOLS;
  if (kind === "project") return PROJECT_AGENT_ALLOWED_TOOLS;
  return [];
}

function userToolsBySenderPolicy(_config: JsonObject, agentId: string): JsonObject {
  return parseAgentId(agentId).kind === "project"
    ? { "*": { deny: structuredClone(PRODUCTIVITY_TOOL_NAMES) } }
    : {};
}


function mattermostAccounts(config: JsonObject): JsonObject | null | typeof ABSENT {
  const value = readPath(config, "channels.mattermost.accounts");
  return value === ABSENT ? ABSENT : asObject(value);
}

function mattermostRootEndpointSatisfied(mattermost: JsonObject | null): boolean {
  if (!mattermost || !Object.hasOwn(mattermost, "baseUrl")) return true;
  return Object.hasOwn(mattermost, "botToken") && mattermost.baseUrl === PLATFORM_MATTERMOST_BASE_URL;
}

export function projectIsolatedMattermostRootEndpoint(mattermost: JsonObject): boolean {
  if (mattermostRootEndpointSatisfied(mattermost)) return false;
  if (Object.hasOwn(mattermost, "botToken")) {
    mattermost.baseUrl = PLATFORM_MATTERMOST_BASE_URL;
    return true;
  }
  for (const value of Object.values(asObject(mattermost.accounts) ?? {})) {
    const account = asObject(value);
    if (account && !Object.hasOwn(account, "baseUrl")) account.baseUrl = PLATFORM_MATTERMOST_BASE_URL;
  }
  delete mattermost.baseUrl;
  return true;
}

function accountProjectionSatisfied(config: JsonObject, platformOwned: boolean): boolean {
  const mattermost = asObject(readPath(config, "channels.mattermost"));
  if (!platformOwned && !mattermostRootEndpointSatisfied(mattermost)) return false;
  const accounts = mattermostAccounts(config);
  if (accounts === ABSENT) return true;
  if (!accounts) return false;
  return platformAgentMattermostAccountsProjected(config, accounts, platformOwned);
}

function reconcileMattermostAccounts(config: JsonObject, platformOwned: boolean): void {
  const mattermost = asObject(readPath(config, "channels.mattermost"));
  if (!platformOwned && mattermost) projectIsolatedMattermostRootEndpoint(mattermost);
  const current = mattermostAccounts(config);
  if (current === ABSENT) return;
  if (!current) {
    const [mattermost, leaf] = parentForPath(config, "channels.mattermost.accounts");
    mattermost[leaf] = {};
    return;
  }
  projectPlatformAgentMattermostAccounts(config, current, platformOwned);
}

function invariantSatisfied(config: JsonObject, invariant: PlatformInvariant): boolean {
  if (invariant.kind === USER_AGENT_WORKSPACE) {
    return userAgentRecords(config, invariant.path).every(agentWorkspaceOnly);
  }
  if (invariant.kind === USER_AGENT_TOOL_POLICY) {
    return userAgentEntries(config, invariant.path).every(({ agent, agentId }) =>
      agentToolPolicySatisfied(config, agent, agentId));
  }
  if (invariant.kind === PROJECT_AGENT_TOOL_POLICY) {
    return userAgentEntries(config, invariant.path)
      .filter(({ agentId }) => parseAgentId(agentId).kind === "project")
      .every(({ agent, agentId }) => agentToolPolicySatisfied(config, agent, agentId));
  }
  if (invariant.kind === "mattermost-account-projection") {
    return accountProjectionSatisfied(config, invariant.platformOwned);
  }
  const actual = readPath(config, invariant.path);
  if (invariant.kind === "exact") return equal(actual, invariant.value);
  if (invariant.kind === REQUIRED_ARRAY) {
    return Array.isArray(actual) && invariant.values.every((value) => actual.includes(value));
  }
  return !Array.isArray(actual) || invariant.values.every((value) => !actual.includes(value));
}

function applyInvariant(config: JsonObject, invariant: PlatformInvariant): void {
  if (invariant.kind === USER_AGENT_WORKSPACE) {
    userAgentRecords(config, invariant.path).forEach(forceAgentWorkspaceOnly);
    return;
  }
  if (invariant.kind === USER_AGENT_TOOL_POLICY) {
    for (const { agent, agentId } of userAgentEntries(config, invariant.path)) {
      forceAgentToolPolicy(config, agent, agentId);
    }
    return;
  }
  if (invariant.kind === PROJECT_AGENT_TOOL_POLICY) {
    for (const { agent, agentId } of userAgentEntries(config, invariant.path)) {
      if (parseAgentId(agentId).kind === "project") forceAgentToolPolicy(config, agent, agentId);
    }
    return;
  }
  if (invariant.kind === "mattermost-account-projection") {
    reconcileMattermostAccounts(config, invariant.platformOwned);
    return;
  }
  const [parent, leaf] = parentForPath(config, invariant.path);
  if (invariant.kind === "exact") {
    if (invariant.value === ABSENT) delete parent[leaf];
    else parent[leaf] = structuredClone(invariant.value);
    return;
  }
  const actual = Array.isArray(parent[leaf])
    ? parent[leaf].filter((value): value is string => typeof value === "string")
    : [];
  parent[leaf] = invariant.kind === REQUIRED_ARRAY
    ? [...actual, ...invariant.values.filter((value) => !actual.includes(value))]
    : actual.filter((value) => !invariant.values.includes(value));
}

export class PlatformInvariantPolicyError extends Error {
  readonly code = "platform-invariant-violation";

  constructor(readonly paths: string[]) {
    super(`platform-owned config paths changed: ${paths.join(", ")}`);
    this.name = "PlatformInvariantPolicyError";
  }
}

export function platformInvariantViolations(
  config: JsonObject,
  context: SystemConfigInvariantContext,
): string[] {
  return platformInvariantTable(context)
    .filter((invariant) => !invariantSatisfied(config, invariant))
    .map((invariant) => invariant.path);
}

export function assertPlatformInvariants(
  config: JsonObject,
  context: SystemConfigInvariantContext,
): void {
  const paths = platformInvariantViolations(config, context);
  if (paths.length > 0) throw new PlatformInvariantPolicyError(paths);
}

const PLATFORM_PROJECTION_KINDS = new Set<PlatformInvariant["kind"]>([
  "mattermost-account-projection",
  USER_AGENT_WORKSPACE,
  USER_AGENT_TOOL_POLICY,
  PROJECT_AGENT_TOOL_POLICY,
]);

export function reconcilePlatformProjections(
  config: JsonObject,
  context: SystemConfigInvariantContext,
): { changedPaths: string[] } {
  const changedPaths: string[] = [];
  for (const invariant of platformInvariantTable(context)) {
    if (invariant.kind === "exact" ? !invariant.project : !PLATFORM_PROJECTION_KINDS.has(invariant.kind)) continue;
    if (invariantSatisfied(config, invariant)) continue;
    applyInvariant(config, invariant);
    if (!changedPaths.includes(invariant.path)) changedPaths.push(invariant.path);
  }
  return { changedPaths };
}

export function reconcilePlatformInvariants(
  config: JsonObject,
  context: SystemConfigInvariantContext,
): { changedPaths: string[] } {
  const table = platformInvariantTable(context);
  const rolesChanged = reconcileOperatorRoles(config, context);
  const changedPaths = Array.from(new Set([
    ...(rolesChanged ? ["gateway.roles"] : []),
    ...table
      .filter((invariant) => !invariantSatisfied(config, invariant))
      .map((invariant) => invariant.path),
  ]));
  for (const invariant of table) {
    if (changedPaths.includes(invariant.path)) applyInvariant(config, invariant);
  }
  return { changedPaths };
}

function reconcileOperatorRoles(config: JsonObject, context: SystemConfigInvariantContext): boolean {
  if (context.gatewayClass !== "isolated" || context.controlIdentity !== "per-user") return false;
  const [gateway] = parentForPath(config, "gateway.roles");
  const roles = withOpenClawOperatorRoles(gateway.roles, context.workspaceSlug);
  if (equal(gateway.roles, roles)) return false;
  gateway.roles = roles;
  return true;
}
