import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("pre-boot-config");
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { agentIdsFromConfig } from "../lib/byosub-restore.js";
import {
  materializeBrokerProfilesForAgents,
  applyOpenClawSecretsPlan,
  openAiCatalogInputForBaseUrl,
  vertexCatalogInputForBaseUrl,
  metaCatalogInputForBaseUrl,
  META_BROKER_PROVIDER_ID,
  openRouterCatalogInputForBaseUrl,
} from "../lib/agent-model-token-materializer.js";
import {
  gatewayAgentRoster,
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingsEnabled,
} from "../lib/openclaw-config-users.js";
import { applyOpenClawComputerBrowserConfig } from "../lib/openclaw-computer-browser.js";
import { clusterIsolatedGateway, localStateStoreKind, localStateStorePath, openclawStateRoot, type LocalStateStoreKind } from "../lib/openclaw-state-store.js";
import { applyConnectorApprovalDelivery } from "../lib/openclaw-connector-approvals.js";
import { projectIsolatedMattermostRootEndpoint } from "@octogee/core/system-config-invariants";
import { platformBrokerProviderDeclarations } from "../lib/system-config-invariants.js";
import { openClawConfigPath } from "../lib/openclaw-config-path.js";
import {
  OPENAI_PLATFORM_PROVIDER_ID,
  OPENROUTER_PLATFORM_PROVIDER_ID,
  VERTEX_PLATFORM_PROVIDER_ID,
  platformModelRefs,
  canonicalUserModelDefinition,
} from "@octogee/shared/types/agent-models";
import { parseAgentId } from "@octogee/shared/types/identity";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

const CONFIG_PATH = openClawConfigPath();

const log = runtimeLogger.info;

// Users reach platform credits through the LLM broker exactly like shared gateways;
// only BYOSUB bypasses it, and no gateway class ever holds a provider key.
export function shouldMaterializeAnthropicBrokerProfiles(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const gatewayClass = env.GATEWAY_CLASS ?? "";
  return gatewayClass === "shared" || isIsolatedGatewayClassValue(gatewayClass);
}

export function platformBrokerCatalogOpts(env: NodeJS.ProcessEnv): {
  openRouter?: ReturnType<typeof openRouterCatalogInputForBaseUrl>;
  openAi?: ReturnType<typeof openAiCatalogInputForBaseUrl>;
  vertex?: ReturnType<typeof vertexCatalogInputForBaseUrl>;
  meta?: ReturnType<typeof metaCatalogInputForBaseUrl>;
} {
  const openRouterBaseUrl = env.OPENROUTER_BASE_URL?.trim();
  const platformOpenAiBaseUrl = env.PLATFORM_OPENAI_BASE_URL?.trim();
  const metaBaseUrl = env.PLATFORM_META_BASE_URL?.trim();
  const platformVertexBaseUrl = env.PLATFORM_VERTEX_BASE_URL?.trim();
  return {
    ...(openRouterBaseUrl
      ? { openRouter: openRouterCatalogInputForBaseUrl(openRouterBaseUrl) }
      : {}),
    ...(platformOpenAiBaseUrl
      ? { openAi: openAiCatalogInputForBaseUrl(platformOpenAiBaseUrl) }
      : {}),
    ...(metaBaseUrl ? { meta: metaCatalogInputForBaseUrl(metaBaseUrl) } : {}),
    ...(platformVertexBaseUrl
      ? { vertex: vertexCatalogInputForBaseUrl(platformVertexBaseUrl) }
      : {}),
  };
}

type OpenClawConfig = Record<string, unknown>;

const MANAGED_AGENT_ID_RE = /^octogee-[a-z0-9][a-z0-9-]{0,62}-coach$/;

function objectProperty(
  parent: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (!parent) return null;
  const value = parent[key];
  return isPlainObject(value) ? value : null;
}

function ensureNullishObjectProperty(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = parent[key];
  if (isPlainObject(value)) return value;
  if (value !== null && value !== undefined) return null;
  const created: Record<string, unknown> = {};
  parent[key] = created;
  return created;
}

function applyToolsProfilePatch(
  config: OpenClawConfig,
  logFn: (msg: string) => void,
): boolean {
  const tools = ensureNullishObjectProperty(config, "tools");
  if (!tools) return false;
  if (tools.profile === "coding") return false;
  tools.profile = "coding";
  logFn(`set tools.profile=coding (gateway policy: openclaw "coding" defaults)`);
  return true;
}

function isManagedAgentEntry(value: unknown): value is Record<string, unknown> & { id: string } {
  return isPlainObject(value) && typeof value.id === "string" && MANAGED_AGENT_ID_RE.test(value.id);
}

function applyMattermostAccountSessionPolicy(
  account: Record<string, unknown>,
  configPath: string,
  logFn: (msg: string) => void,
): boolean {
  let changed = false;
  for (const key of ["agentActivity", "threadDirectMessages"]) {
    if (!Object.hasOwn(account, key)) continue;
    delete account[key];
    changed = true;
    logFn(`removed unsupported ${configPath}.${key}`);
  }
  if (account.threadSessionScope !== "channel") {
    account.threadSessionScope = "channel";
    changed = true;
    logFn(`set ${configPath}.threadSessionScope=channel`);
  }
  return changed;
}

function applyMattermostQueuePolicy(
  config: OpenClawConfig,
  logFn: (msg: string) => void,
): boolean {
  const messages = ensureNullishObjectProperty(config, "messages");
  const queue = messages ? ensureNullishObjectProperty(messages, "queue") : null;
  const byChannel = queue ? ensureNullishObjectProperty(queue, "byChannel") : null;
  if (!byChannel || byChannel.mattermost === "steer") return false;
  byChannel.mattermost = "steer";
  logFn("set messages.queue.byChannel.mattermost=steer");
  return true;
}

const MATTERMOST_REPLY_TO_MODES = ["off", "first", "all", "batched"] as const;
const MATTERMOST_STREAMING_MODES = ["off", "partial", "block", "progress"] as const;

function configuredMattermostMode(
  env: NodeJS.ProcessEnv,
  name: "MM_REPLY_TO_MODE" | "MM_STREAMING_MODE",
  modes: readonly string[],
): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!modes.includes(value)) throw new Error(`${name}=${value} is not one of ${modes.join(", ")}`);
  return value;
}

function applyMattermostStreamingDefaults(
  mattermost: Record<string, unknown>,
  streamingMode: string | undefined,
  logFn: (msg: string) => void,
): boolean {
  let changed = false;
  const streaming = ensureNullishObjectProperty(mattermost, "streaming");
  if (streaming && streamingMode !== undefined && streaming.mode === undefined) {
    streaming.mode = streamingMode;
    changed = true;
    logFn(`set channels.mattermost.streaming.mode=${streamingMode}`);
  }
  const preview = streaming ? ensureNullishObjectProperty(streaming, "preview") : null;
  if (preview && preview.toolProgress === undefined) {
    preview.toolProgress = true;
    changed = true;
    logFn("set channels.mattermost.streaming.preview.toolProgress=true");
  }
  const progress =
    streaming && preview?.toolProgress !== false
      ? ensureNullishObjectProperty(streaming, "progress")
      : null;
  if (progress && progress.toolProgress === undefined) {
    progress.toolProgress = true;
    changed = true;
    logFn("set channels.mattermost.streaming.progress.toolProgress=true");
  }

  return changed;
}

const MATTERMOST_ACTION_GATE_DEFAULTS = ["messages", "pins", "search", "memberInfo"] as const;
const MATTERMOST_MESSAGE_ACTION_GATES = ["messageWrites", "fileDownloads"] as const;

function migrateMattermostAccountMessageActions(
  mattermost: Record<string, unknown>,
  actions: Record<string, unknown> | null,
  logFn: (msg: string) => void,
): boolean {
  let changed = false;
  // Preserve old account message overrides before generated provider defaults
  // become the inherited write/download policy. Authored new gates retain priority.
  for (const [accountId, account] of Object.entries(objectProperty(mattermost, "accounts") ?? {})) {
    if (!isPlainObject(account)) continue;
    const accountActions = objectProperty(account, "actions");
    if (!accountActions || accountActions.messages === undefined) continue;
    for (const gate of MATTERMOST_MESSAGE_ACTION_GATES) {
      if (accountActions[gate] !== undefined || actions?.[gate] !== undefined) continue;
      accountActions[gate] = (accountActions.messages ?? actions?.messages) !== false;
      changed = true;
      logFn(`set channels.mattermost.accounts.${accountId}.actions.${gate}=${accountActions[gate]}`);
    }
  }
  return changed;
}

function applyMattermostActionDefaults(
  mattermost: Record<string, unknown>,
  logFn: (msg: string) => void,
): boolean {
  const actions = ensureNullishObjectProperty(mattermost, "actions");
  let changed = migrateMattermostAccountMessageActions(mattermost, actions, logFn);
  for (const gate of MATTERMOST_ACTION_GATE_DEFAULTS) {
    if (!actions || actions[gate] !== undefined) continue;
    actions[gate] = true;
    changed = true;
    logFn(`set channels.mattermost.actions.${gate}=true`);
  }
  for (const gate of MATTERMOST_MESSAGE_ACTION_GATES) {
    if (!actions || actions[gate] !== undefined) continue;
    actions[gate] = actions.messages !== false;
    changed = true;
    logFn(`set channels.mattermost.actions.${gate}=${actions[gate]}`);
  }
  if (mattermost.reactionNotifications === undefined) {
    mattermost.reactionNotifications = "own";
    changed = true;
    logFn("set channels.mattermost.reactionNotifications=own");
  }
  if (mattermost.joinIntro === undefined) {
    mattermost.joinIntro = true;
    changed = true;
    logFn("set channels.mattermost.joinIntro=true");
  }
  return changed;
}

function applyMattermostAckReactionDefaults(
  config: OpenClawConfig,
  logFn: (msg: string) => void,
): boolean {
  const messages = ensureNullishObjectProperty(config, "messages");
  if (!messages || messages.ackReactionScope !== undefined) return false;
  messages.ackReactionScope = "all";
  logFn("set messages.ackReactionScope=all");
  return true;
}

function disableMattermostNativeCommands(
  container: Record<string, unknown>,
  configPath: string,
  logFn: (msg: string) => void,
): boolean {
  const commands = ensureNullishObjectProperty(container, "commands");
  if (!commands || commands.native === false) return false;
  commands.native = false;
  logFn(`forced ${configPath}.commands.native=false`);
  return true;
}

function applyMattermostAccountPatches(
  mattermost: Record<string, unknown>,
  logFn: (msg: string) => void,
): boolean {
  const configuredAccounts = objectProperty(mattermost, "accounts");
  if (!configuredAccounts) return false;
  let changed = false;
  for (const [accountId, account] of Object.entries(configuredAccounts)) {
    if (!isPlainObject(account)) continue;
    const configPath = `channels.mattermost.accounts.${accountId}`;
    changed = applyMattermostAccountSessionPolicy(account, configPath, logFn) || changed;
    changed = disableMattermostNativeCommands(account, configPath, logFn) || changed;
  }
  return changed;
}

export function applyMattermostPreBootPatches(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void,
): boolean {
  const replyToMode = configuredMattermostMode(env, "MM_REPLY_TO_MODE", MATTERMOST_REPLY_TO_MODES);
  const streamingMode = configuredMattermostMode(env, "MM_STREAMING_MODE", MATTERMOST_STREAMING_MODES);
  const mattermost = objectProperty(objectProperty(config, "channels"), "mattermost");
  if (!mattermost) return false;
  let changed = applyMattermostAccountSessionPolicy(mattermost, "channels.mattermost", logFn);
  changed = applyMattermostQueuePolicy(config, logFn) || changed;
  if (replyToMode !== undefined && mattermost.replyToMode === undefined) {
    mattermost.replyToMode = replyToMode;
    changed = true;
    logFn(`set channels.mattermost.replyToMode=${replyToMode}`);
  }

  changed = applyMattermostStreamingDefaults(mattermost, streamingMode, logFn) || changed;
  changed = applyMattermostActionDefaults(mattermost, logFn) || changed;
  changed = applyMattermostAckReactionDefaults(config, logFn) || changed;

  if (isIsolatedGatewayClassValue(env.GATEWAY_CLASS) && projectIsolatedMattermostRootEndpoint(mattermost)) {
    changed = true;
    logFn("reconciled platform ownership of the root Mattermost endpoint");
  }

  changed = disableMattermostNativeCommands(mattermost, "channels.mattermost", logFn) || changed;
  return applyMattermostAccountPatches(mattermost, logFn) || changed;
}

function accountRouteKey(accountId: string, agentId: string): string {
  return `${accountId}\u0000${agentId}`;
}

function mattermostBindingFacts(value: unknown): {
  agentId: string;
  accountId: string;
  hasPeer: boolean;
} | null {
  if (!isPlainObject(value) || typeof value.agentId !== "string") return null;
  const match = value.match;
  if (
    !isPlainObject(match) ||
    match.channel !== "mattermost" ||
    typeof match.accountId !== "string"
  ) {
    return null;
  }
  return {
    agentId: value.agentId,
    accountId: match.accountId,
    hasPeer: match.peer !== undefined,
  };
}

function managedAgentIdForMattermostAccount(accountId: string): string | null {
  if (accountId.includes("-proj-")) {
    const agentId = `octogee-${accountId}-coach`;
    const parsed = parseAgentId(agentId);
    return parsed.kind === "project" &&
        `${parsed.username}-proj-${parsed.project}` === accountId
      ? agentId
      : null;
  }
  if (accountId.endsWith("-coach")) {
    const agentId = `octogee-${accountId}`;
    const parsed = parseAgentId(agentId);
    return parsed.kind === "coach" && `${parsed.username}-coach` === accountId
      ? agentId
      : null;
  }
  return null;
}

function applySharedDefaultAgent(config: OpenClawConfig): boolean {
  const agents = ensureNullishObjectProperty(config, "agents");
  if (!agents) throw new Error("shared routing safety requires an agents object");
  let changed = false;
  if (Array.isArray(agents.list)) {
    const next = gatewayAgentRoster(agents.list, "");
    if (!valueEqual(agents.list, next)) {
      agents.list = next;
      changed = true;
    }
  } else if (agents.list !== undefined) {
    throw new Error("shared routing safety requires agents.list to be an array");
  } else {
    const entries = objectProperty(agents, "entries");
    if (!entries) {
      if (agents.entries !== undefined) {
        throw new Error("shared routing safety requires agents.entries to be an object");
      }
      agents.list = gatewayAgentRoster([], "");
      changed = true;
    } else {
      if (Object.values(entries).some((entry) => !isPlainObject(entry))) {
        throw new Error("shared routing safety requires every agent entry to be an object");
      }
      const list = Object.entries(entries)
        .map(([id, entry]) => ({ ...(entry as Record<string, unknown>), id }));
      const nextEntries = Object.fromEntries(
        gatewayAgentRoster(list, "").map((entry) => {
          const { id, ...rest } = entry as Record<string, unknown> & { id: string };
          return [id, rest];
        }),
      );
      if (!valueEqual(entries, nextEntries)) {
        agents.entries = nextEntries;
        changed = true;
      }
    }
  }
  if (agents.ownership !== "explicit") {
    agents.ownership = "explicit";
    changed = true;
  }
  return changed;
}

function managedMattermostRoutes(
  accounts: Record<string, unknown>,
  configuredAgentIds: ReadonlySet<string>,
  logFn: (msg: string) => void,
): { routes: Map<string, string>; quarantinedAccounts: Set<string> } {
  const routes = new Map<string, string>();
  const quarantinedAccounts = new Set<string>();
  for (const accountId of Object.keys(accounts)) {
    const agentId = managedAgentIdForMattermostAccount(accountId);
    if (agentId && configuredAgentIds.has(agentId)) {
      routes.set(accountId, agentId);
      continue;
    }
    quarantinedAccounts.add(accountId);
    logFn(
      agentId
        ? `refused account route without managed agent for ${accountId}`
        : `refused unmanaged account route for ${accountId}`,
    );
  }
  return { routes, quarantinedAccounts };
}

export function applySharedMattermostRoutingSafetyPatch(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void,
): boolean {
  if (isIsolatedGatewayClassValue(env.GATEWAY_CLASS?.trim())) return false;
  let changed = applySharedDefaultAgent(config);
  if (changed) {
    logFn("converged the non-tenant agent roster for unmatched routes");
  }

  const mattermost = objectProperty(objectProperty(config, "channels"), "mattermost");
  const accounts = objectProperty(mattermost, "accounts");
  if (!accounts) return changed;
  if (config.bindings !== undefined && !Array.isArray(config.bindings)) {
    throw new Error("shared routing safety requires bindings to be an array");
  }
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];

  const configuredAgentIds = new Set(agentIdsFromConfig(config));
  const { routes, quarantinedAccounts } = managedMattermostRoutes(
    accounts,
    configuredAgentIds,
    logFn,
  );
  if (routes.size === 0 && quarantinedAccounts.size === 0) return changed;

  const retained = bindings.filter((binding) => {
    const facts = mattermostBindingFacts(binding);
    if (!facts) return true;
    if (quarantinedAccounts.has(facts.accountId)) return false;
    const inferredAgentId = routes.get(facts.accountId);
    return inferredAgentId === undefined || inferredAgentId === facts.agentId;
  });
  const present = new Set(
    retained.flatMap((binding) => {
      const facts = mattermostBindingFacts(binding);
      return facts && !facts.hasPeer ? [accountRouteKey(facts.accountId, facts.agentId)] : [];
    }),
  );
  for (const [accountId, agentId] of routes) {
    if (present.has(accountRouteKey(accountId, agentId))) continue;
    retained.push({
      agentId,
      match: { channel: "mattermost", accountId },
    });
  }
  if (!valueEqual(bindings, retained)) {
    config.bindings = retained;
    changed = true;
    logFn(
      `converged Mattermost account routes (stable=${routes.size}, quarantined=${quarantinedAccounts.size})`,
    );
  }
  return changed;
}

export function applyAnthropicBaseUrlPatch(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void,
): boolean {
  if (!env.ANTHROPIC_BASE_URL) return false;
  let changed = false;

  const auth = ensureNullishObjectProperty(config, "auth");
  const profiles = auth ? ensureNullishObjectProperty(auth, "profiles") : null;
  if (profiles) {
    profiles["anthropic:default"] ??= {
      provider: "anthropic",
      mode: "api_key",
    };
    const anthropicProfile = objectProperty(profiles, "anthropic:default");
    if (anthropicProfile?.baseUrl !== undefined) {
      delete anthropicProfile.baseUrl;
      changed = true;
      logFn(`removed stale auth.profiles.anthropic:default.baseUrl (OpenClaw expects provider baseUrl)`);
    }
  }

  const models = ensureNullishObjectProperty(config, "models");
  const providers = models ? ensureNullishObjectProperty(models, "providers") : null;
  if (!providers) return changed;
  providers.anthropic ??= {};
  const anthropicProvider = objectProperty(providers, "anthropic");
  if (!anthropicProvider) return changed;
  if (anthropicProvider.baseUrl !== env.ANTHROPIC_BASE_URL) {
    anthropicProvider.baseUrl = env.ANTHROPIC_BASE_URL;
    changed = true;
    logFn(`Anthropic provider baseUrl synced from ANTHROPIC_BASE_URL env var`);
  }
  return changed;
}

function applyPlatformBrokerProviderPatch(config: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (env.GATEWAY_CLASS !== "shared" && !isIsolatedGatewayClassValue(env.GATEWAY_CLASS)) return false;
  const expected = platformBrokerProviderDeclarations(env);
  const models = ensureNullishObjectProperty(config, "models");
  const providers = models ? ensureNullishObjectProperty(models, "providers") : null;
  if (!providers) return false;
  let changed = false;
  for (const id of [OPENROUTER_PLATFORM_PROVIDER_ID, OPENAI_PLATFORM_PROVIDER_ID, VERTEX_PLATFORM_PROVIDER_ID, META_BROKER_PROVIDER_ID]) {
    if (expected[id]) {
      if (JSON.stringify(providers[id]) === JSON.stringify(expected[id])) continue;
      providers[id] = expected[id];
    } else {
      if (!Reflect.has(providers, id)) continue;
      delete providers[id];
    }
    changed = true;
  }
  return changed;
}

export function applyMemorySearchPlatformEmbeddingsPatch(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void,
): boolean {
  if (!platformOpenAiEmbeddingsEnabled(env)) {
    return false;
  }
  const agents = objectProperty(config, "agents");
  const list = Array.isArray(agents?.list) ? agents.list : [];
  const entries = objectProperty(agents, "entries");
  const candidates = [
    ...list
      .filter(isManagedAgentEntry)
      .map((entry) => ({ id: entry.id, entry })),
    ...Object.entries(entries ?? {})
      .filter(([id, entry]) => MANAGED_AGENT_ID_RE.test(id) && isPlainObject(entry))
      .map(([id, entry]) => ({ id, entry: entry as Record<string, unknown> })),
  ];
  const patched = candidates.flatMap(({ id, entry }) => {
    if (entry.memorySearch !== undefined) return [];
    const memory = ensureNullishObjectProperty(entry, "memory");
    if (!memory || Reflect.has(memory, "search")) return [];
    memory.search = platformOpenAiEmbeddingMemorySearch(id, env);
    return [id];
  });
  if (patched.length === 0) return false;
  logFn(`memory search embeddings configured for ${patched.length} agent(s)`);
  return true;
}

export function applyMemorySearchSchemaPatch(
  config: OpenClawConfig,
  logFn: (msg: string) => void,
): boolean {
  const agents = objectProperty(config, "agents");
  if (!agents) return false;
  const list = Array.isArray(agents.list) ? agents.list : [];
  const entries = objectProperty(agents, "entries");
  const candidates = [
    ...list.filter(isPlainObject),
    ...Object.values(entries ?? {}).filter(isPlainObject),
  ];
  let migrated = 0;
  for (const entry of candidates) {
    if (!Object.prototype.hasOwnProperty.call(entry, "memorySearch") ||
        !isPlainObject(entry.memorySearch)) {
      continue;
    }
    const memory = ensureNullishObjectProperty(entry, "memory");
    if (!memory) {
      logFn("left legacy agent memorySearch unchanged because memory is not an object");
      continue;
    }
    const legacySearch = cloneWithoutUnsafeKeys(entry.memorySearch);
    if (!Reflect.has(memory, "search") || !isPlainObject(memory.search)) {
      memory.search = legacySearch;
    } else {
      mergeMissingInto(memory.search, legacySearch);
    }
    Reflect.deleteProperty(entry, "memorySearch");
    migrated += 1;
  }
  if (migrated === 0) return false;
  logFn(`migrated legacy memorySearch for ${migrated} agent(s)`);
  return true;
}

function cloneWithoutUnsafeKeys(source: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (PROTO_POLLUTION_KEYS.has(key)) continue;
    clone[key] = cloneValueWithoutUnsafeKeys(value);
  }
  return clone;
}

function cloneValueWithoutUnsafeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValueWithoutUnsafeKeys);
  return isPlainObject(value) ? cloneWithoutUnsafeKeys(value) : value;
}

function mergeMissingInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined || PROTO_POLLUTION_KEYS.has(key)) continue;
    const targetValue = Object.hasOwn(target, key) ? target[key] : undefined;
    if (targetValue === undefined) {
      Object.defineProperty(target, key, { value: sourceValue, enumerable: true, writable: true, configurable: true });
      continue;
    }
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      mergeMissingInto(targetValue, sourceValue);
    }
  }
}

function applyPlatformModelAllowlist(config: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (!shouldMaterializeAnthropicBrokerProfiles(env)) return false;
  const agents = objectProperty(config, "agents");
  const defaults = agents ? ensureNullishObjectProperty(agents, "defaults") : null;
  const models = defaults ? ensureNullishObjectProperty(defaults, "models") : null;
  if (!models) return false;
  const refs = platformModelRefs().filter((ref) =>
    (!ref.startsWith(`${OPENROUTER_PLATFORM_PROVIDER_ID}/`) || Boolean(env.OPENROUTER_BASE_URL?.trim())) &&
    (!ref.startsWith(`${OPENAI_PLATFORM_PROVIDER_ID}/`) || Boolean(env.PLATFORM_OPENAI_BASE_URL?.trim())) &&
    (!ref.startsWith(`${VERTEX_PLATFORM_PROVIDER_ID}/`) || Boolean(env.PLATFORM_VERTEX_BASE_URL?.trim())) &&
    (!ref.startsWith(`${META_BROKER_PROVIDER_ID}/`) || Boolean(env.PLATFORM_META_BASE_URL?.trim())),
  );
  let changed = false;
  for (const ref of refs) {
    if (models[ref] !== undefined) continue;
    models[ref] = canonicalUserModelDefinition(ref);
    changed = true;
  }
  return changed;
}

function isLegacyGcpSecretResolverProvider(
  providerName: string,
  provider: Record<string, unknown>,
): boolean {
  return (
    providerName === "gcp-secret-manager" &&
    provider.source === "exec" &&
    provider.command === "/usr/local/bin/node" &&
    Array.isArray(provider.args) &&
    provider.args.length === 1 &&
    provider.args[0] === "/octogee/scripts/secret-resolver.mjs"
  );
}

export function applyOpenClawBeta5CompatibilityPatch(
  config: OpenClawConfig,
  logFn: (msg: string) => void = () => {},
): boolean {
  let changed = false;
  const meta = objectProperty(config, "meta");
  if (meta && Reflect.has(meta, "lastTouchedAt")) {
    Reflect.deleteProperty(meta, "lastTouchedAt");
    changed = true;
    logFn("removed meta.lastTouchedAt (unsupported by OpenClaw 2026.7.2-beta.5)");
  }

  const commands = objectProperty(config, "commands");
  if (commands && Reflect.has(commands, "ownerDisplay")) {
    Reflect.deleteProperty(commands, "ownerDisplay");
    changed = true;
    logFn("removed commands.ownerDisplay (unsupported by OpenClaw 2026.7.2-beta.5)");
  }

  const providers = objectProperty(objectProperty(config, "secrets"), "providers");
  if (!providers) return changed;
  for (const [providerName, provider] of Object.entries(providers)) {
    if (!isPlainObject(provider)) continue;
    if (isLegacyGcpSecretResolverProvider(providerName, provider)) {
      provider.command = "/octogee/scripts/secret-resolver.mjs";
      Reflect.deleteProperty(provider, "args");
      changed = true;
      logFn(
        "migrated secrets.providers.gcp-secret-manager to the node-owned resolver executable",
      );
    }
    if (Reflect.has(provider, "allowInsecurePath")) {
      Reflect.deleteProperty(provider, "allowInsecurePath");
      changed = true;
      logFn(
        `removed secrets.providers.${providerName}.allowInsecurePath (unsupported by OpenClaw 2026.7.2-beta.5)`,
      );
    }
  }
  return changed;
}

// OpenClaw starts typing at the first reply text for a group chat without a
// mention, and the agent channel is a private channel, so a user saw nothing
// while a turn prepared. Existing durable configs never re-read the template,
// so the default converges here on every boot; an explicit choice stays.
export function applyTypingModeDefault(
  config: OpenClawConfig,
  logFn: (msg: string) => void,
): boolean {
  const agents = ensureNullishObjectProperty(config, "agents");
  const defaults = agents ? ensureNullishObjectProperty(agents, "defaults") : null;
  if (!defaults) {
    logFn("left agents.defaults.typingMode unset because agents.defaults is not an object");
    return false;
  }
  const current = defaults.typingMode;
  if (typeof current === "string" && current.length > 0) return false;
  defaults.typingMode = "instant";
  logFn('set agents.defaults.typingMode = "instant" (typing starts when the message arrives)');
  return true;
}

export function applyVerboseDefault(
  config: OpenClawConfig,
  logFn: (msg: string) => void,
): boolean {
  const agents = ensureNullishObjectProperty(config, "agents");
  const defaults = agents ? ensureNullishObjectProperty(agents, "defaults") : null;
  if (!defaults) {
    logFn("left agents.defaults.verboseDefault unset because agents.defaults is not an object");
    return false;
  }
  if (defaults.verboseDefault === "off") return false;
  defaults.verboseDefault = "off";
  logFn('set agents.defaults.verboseDefault = "off" (the Mattermost draft and Activity carry tool progress)');
  return true;
}

function applyWorkspaceIdentityBootstrapPolicy(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void,
): boolean {
  if (env.GATEWAY_CLASS !== "shared" && !isIsolatedGatewayClassValue(env.GATEWAY_CLASS)) return false;
  const agents = ensureNullishObjectProperty(config, "agents");
  const defaults = agents ? ensureNullishObjectProperty(agents, "defaults") : null;
  if (!defaults) return false;
  const current = defaults.skipOptionalBootstrapFiles;
  // Leave invalid authored configuration for Native's normal validation.
  if (current !== undefined && !Array.isArray(current)) return false;
  if (Array.isArray(current) && current.includes("IDENTITY.md")) return false;
  // Identity restoration preserves authored bytes and intentional absence. Native
  // must not attest a generated IDENTITY.md that restoration will remove.
  defaults.skipOptionalBootstrapFiles = [...(current ?? []), "IDENTITY.md"];
  logFn("left IDENTITY.md creation to authored workspace identity restoration");
  return true;
}

export function applyPreBootPatches(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  logFn: (msg: string) => void = () => {},
  options: { stateStore?: LocalStateStoreKind } = {},
): boolean {
  const isolatedGateway = isIsolatedGatewayClassValue(env.GATEWAY_CLASS?.trim());
  return [
    applyAgentStoreDatabasePatch(config, env, options.stateStore),
    applyWorkspaceIdentityBootstrapPolicy(config, env, logFn),
    applyOpenClawBeta5CompatibilityPatch(config, logFn),
    isolatedGateway ? false : applyToolsProfilePatch(config, logFn),
    applyMattermostPreBootPatches(config, env, logFn),
    applySharedMattermostRoutingSafetyPatch(config, env, logFn),
    applyOpenClawComputerBrowserConfig(config, env),
    applyConnectorApprovalDelivery(config),
    applyAnthropicBaseUrlPatch(config, env, logFn),
    applyPlatformBrokerProviderPatch(config, env),
    applyPlatformModelAllowlist(config, env),
    applyMemorySearchPlatformEmbeddingsPatch(config, env, logFn),
    applyMemorySearchSchemaPatch(config, logFn),
    applyTypingModeDefault(config, logFn),
    applyVerboseDefault(config, logFn),
  ].some(Boolean);
}

const USER_STATE_STORE_LOG: Record<LocalStateStoreKind, string> = {
  absent: "User state family on PostgreSQL (fresh store)",
  anchor: "User state family on PostgreSQL (anchor present)",
  sqlite: "Retained SQLite state requires the native PostgreSQL port before startup",
};

export class GatewayStoreMigrationRequiredError extends Error {
  constructor(readonly family: string) {
    super(`Retained SQLite-configured Gateway stores cannot start under the PostgreSQL-only policy. Keep the Gateway stopped, preserve its current config and stores, run native openclaw doctor --fix --non-interactive, then openclaw database port --family ${family} --to postgres. Port every other SQLite-configured family individually before restarting; do not change engine selectors by hand.`);
  }
}

export function applyAgentStoreDatabasePatch(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  stateStore?: LocalStateStoreKind,
): boolean {
  if (env.GATEWAY_CLASS !== "shared" && !isIsolatedGatewayClassValue(env.GATEWAY_CLASS)) return false;
  const current = isPlainObject(config.database) ? config.database : {};
  const families = isPlainObject(current.families) ? current.families : {};
  let sqliteFamily: string | undefined;
  if (stateStore === "sqlite") sqliteFamily = "state";
  else if (Object.hasOwn(config, "database")) {
    sqliteFamily = ["state", "agent", "workboard", "logbook", "team-reports"].find(family => {
      const override = isPlainObject(families[family]) ? families[family].engine : undefined;
      return (override ?? current.engine ?? "sqlite") !== "postgres";
    });
  }
  if (sqliteFamily) {
    throw new GatewayStoreMigrationRequiredError(sqliteFamily);
  }
  const { families: _families, ...database } = current;
  const postgres = isPlainObject(current.postgres) ? current.postgres : {};
  const next = {
    ...database,
    engine: "postgres",
    postgres: {
      ...postgres,
      connection: { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" },
      schemaPrefix: "octogee",
    },
  };
  if (valueEqual(current, next)) return false;
  config.database = next;
  return true;
}

const PROTO_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function valueEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const FALLBACK_NAME = "Octogee Builder";
const FALLBACK_EMAIL_DOMAIN = "users.noreply.octogee.com";
const FALLBACK_GENERIC_LOCAL = "builder";

export function slugFromManagedAgentId(agentId: string): string | null {
  const m = /^octogee-(.+)-coach$/.exec(agentId);
  return m ? m[1] : null;
}

export function pickSoleTenantSlug(agentIds: readonly string[]): string | null {
  const slugs = new Set<string>();
  for (const id of agentIds) {
    const slug = slugFromManagedAgentId(id);
    if (slug) slugs.add(slug);
  }
  return slugs.size === 1 ? [...slugs][0] : null;
}

// eslint-disable-next-line no-control-regex -- matching control chars is the entire point: strip them to prevent gitconfig section injection via the tenant slug.
const SAFE_GITCONFIG_VALUE_RE = /[\x00-\x1F\x7F]/g;

function safeOrNull(v: string | undefined | null): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(SAFE_GITCONFIG_VALUE_RE, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function resolveGitIdentity(slug: string | null): { name: string; email: string } {
  const cleanSlug = safeOrNull(slug);
  return cleanSlug
    ? { name: cleanSlug, email: `${cleanSlug}@${FALLBACK_EMAIL_DOMAIN}` }
    : { name: FALLBACK_NAME, email: `${FALLBACK_GENERIC_LOCAL}@${FALLBACK_EMAIL_DOMAIN}` };
}

export function buildGitconfigContent(identity: {
  name: string;
  email: string;
}): string {
  return [
    "# Octogee-managed first-boot gitconfig seed.",
    "# Subsequent boots leave this file alone — edit freely.",
    "[user]",
    `\tname = ${identity.name}`,
    `\temail = ${identity.email}`,
    "[push]",
    "\tautoSetupRemote = true",
    "[init]",
    "\tdefaultBranch = main",
    "",
  ].join("\n");
}

export function hydrateGitIdentity(deps: {
  gitconfigPath: string;
  agentIds: readonly string[];
  fileExists: (p: string) => boolean;
  writeFile: (p: string, content: string) => void;
  logFn?: (msg: string) => void;
}): boolean {
  const log = deps.logFn ?? (() => {});

  let alreadyPresent = false;
  try {
    alreadyPresent = deps.fileExists(deps.gitconfigPath);
  } catch (e) {
    log(
      `gitconfig: fileExists check threw — treating as absent and proceeding: ${(e as Error).message}`,
    );
  }
  if (alreadyPresent) {
    return false;
  }

  const slug = pickSoleTenantSlug(deps.agentIds);
  const identity = resolveGitIdentity(slug);
  const content = buildGitconfigContent(identity);

  try {
    deps.writeFile(deps.gitconfigPath, content);
    log(
      `gitconfig: seeded ${deps.gitconfigPath} for ${identity.name} <${identity.email}>${
        slug ? ` (slug=${slug})` : " (no single tenant — generic identity)"
      }`,
    );
    return true;
  } catch (e) {
    log(
      `WARN: failed to write ${deps.gitconfigPath} — ${(e as Error).message} (boot continues)`,
    );
    return false;
  }
}

export function writeConfigAtomically(configPath: string, config: unknown): void {
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export async function materializeBrokerProfilesBeforeBoot(
  config: unknown,
  env: NodeJS.ProcessEnv,
  sweep: (agentIds: string[]) => Promise<{ materialized: number; deferred: string[] }>,
  logFn: (message: string) => void = log,
): Promise<void> {
  if (!shouldMaterializeAnthropicBrokerProfiles(env)) return;
  if (isIsolatedGatewayClassValue(env.GATEWAY_CLASS?.trim())) {
    logFn("model-ready: Isolated gateway broker profiles are materialized by the post-boot sweep");
    return;
  }
  const result = await sweep(agentIdsFromConfig(config));
  if (result.materialized > 0) {
    logFn(`model-ready broker profiles materialized for ${result.materialized} agent(s)`);
  }
  if (result.deferred.length > 0) {
    logFn(
      `model-ready: broker profile deferred for ${result.deferred.length} agent(s) until openclaw can accept the secrets apply`,
    );
  }
}

async function main(): Promise<void> {
  let configRaw: string;
  try {
    configRaw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      log("No openclaw.json found — skipping pre-boot config");
      return;
    }
    throw e;
  }
  const config = JSON.parse(configRaw);
  const stateStore = localStateStoreKind(localStateStorePath(openclawStateRoot(process.env)));
  if (clusterIsolatedGateway(process.env)) log(USER_STATE_STORE_LOG[stateStore]);

  let changed: boolean;
  try {
    changed = applyPreBootPatches(config, process.env, log, { stateStore });
  } catch (error) {
    if (process.argv.includes("--defer-builder-store-migration") && isIsolatedGatewayClassValue(process.env.GATEWAY_CLASS) &&
        error instanceof GatewayStoreMigrationRequiredError) {
      log("User stores require migration; preserving config for the held supervisor (startup remains blocked)");
      return;
    }
    throw error;
  }
  if (changed) {
    writeConfigAtomically(CONFIG_PATH, config);
    log("openclaw.json patched (env / stale-key cleanup)");
  } else {
    log("no changes needed");
  }

  await materializeBrokerProfilesBeforeBoot(config, process.env, (agentIds) =>
    materializeBrokerProfilesForAgents(agentIds, {
      logFn: log,
      secretsApply: { apply: (plan) => applyOpenClawSecretsPlan(plan, { log }) },
      ...platformBrokerCatalogOpts(process.env),
    }),
  );

  try {
    const homeDir = process.env.HOME ?? "/home/node";
    hydrateGitIdentity({
      gitconfigPath: path.join(homeDir, ".gitconfig"),
      agentIds: agentIdsFromConfig(config),
      fileExists: (p) => {
        try {
          fs.statSync(p);
          return true;
        } catch {
          return false;
        }
      },
      writeFile: (p, c) => fs.writeFileSync(p, c, { mode: 0o644 }),
      logFn: log,
    });
  } catch (e) {
    log(
      `WARN: gitconfig hydration step failed — ${(e as Error).message} (boot continues)`,
    );
  }
}

const isEntrypoint = process.argv[1] && process.argv[1].endsWith("pre-boot-config.ts") || process.argv[1]?.endsWith("pre-boot-config.js");
function exitPreBootWithError(error: unknown): never {
  runtimeLogger.error(`[pre-boot] Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (isEntrypoint) {
  main().catch(exitPreBootWithError);
}
