import { PROJECT_AGENT_WORKSPACE_PARTS, type ProjectAgentIdentity } from "@octogee/shared/types/project";
import { parseAgentId, projectAgentId } from "@octogee/shared/types/identity";
import { PLATFORM_MATTERMOST_BASE_URL } from "@octogee/shared/types/openclaw-mattermost-accounts";
import { platformOpenAiEmbeddingSecretId } from "@octogee/core/platform-embedding-refs";
import { applyComputerBrowserAgentPolicy } from "./openclaw-computer-browser.js";
import {
  USER_CODE_DENIED_TOOLS,
  USER_WORKFLOW_TOOLS as WORKSPACE_DEFAULT_AGENT_ALLOWED_TOOLS,
  PRODUCTIVITY_TOOL_NAMES,
  PROJECT_AGENT_ALLOWED_TOOLS,
  PROJECT_AGENT_DENIED_TOOLS,
} from "@octogee/core/system-config-invariants";
import {
  mattermostAccountSecretRef,
  type MattermostAccountSecretRef,
} from "./mattermost-account-secrets.js";
import { userClaimSlug } from "@octogee/shared/server/user-claim";

export {
  PLATFORM_EMBEDDING_SECRET_PREFIX,
  platformOpenAiEmbeddingSecretId,
  rebindPlatformEmbeddingRefs,
} from "@octogee/core/platform-embedding-refs";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";
export {
  PRODUCTIVITY_TOOL_NAMES,
  PROJECT_AGENT_ALLOWED_TOOLS,
  PROJECT_AGENT_DENIED_TOOLS,
  WORKSPACE_DEFAULT_AGENT_ALLOWED_TOOLS,
};

const PLATFORM_EMBEDDING_PROVIDER = "openai-compatible";
// In-cluster K8s Service DNS (llm-broker), same as the Helm default it
// mirrors; no cross-network hop, no plaintext-in-transit exposure.
// eslint-disable-next-line sonarjs/no-clear-text-protocols
const DEFAULT_OPENAI_EMBEDDINGS_BASE_URL = "http://llm-broker:3010/v1";
const DEFAULT_OPENAI_EMBEDDINGS_MODEL = "text-embedding-3-small";
const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;

export type AgentHostCodePolicy = "customer-restricted" | "builder-full";

function workspaceDefaultAgentTools(): Record<string, unknown> {
  return {
    profile: "coding",
    alsoAllow: WORKSPACE_DEFAULT_AGENT_ALLOWED_TOOLS,
    deny: [...USER_CODE_DENIED_TOOLS],
    fs: { workspaceOnly: true },
    toolsBySender: {},
  };
}

function normalizedNonEmpty(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function normalizedBaseUrl(value: string | undefined): string {
  let baseUrl = normalizedNonEmpty(value, DEFAULT_OPENAI_EMBEDDINGS_BASE_URL);
  while (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }
  return baseUrl;
}

export function platformOpenAiEmbeddingMemorySearch(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return {
    provider: PLATFORM_EMBEDDING_PROVIDER,
    remote: {
      baseUrl: normalizedBaseUrl(env.PLATFORM_OPENAI_BASE_URL),
      apiKey: {
        source: "exec",
        provider: "gcp-secret-manager",
        id: platformOpenAiEmbeddingSecretId(agentId),
      },
    },
    model: normalizedNonEmpty(env.OPENAI_EMBEDDINGS_MODEL, DEFAULT_OPENAI_EMBEDDINGS_MODEL),
  };
}

export function platformOpenAiEmbeddingsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return /^(1|true|yes|on)$/iu.test(env.OPENAI_EMBEDDINGS_ENABLED ?? "");
}

export interface ProjectRestoreInput {
  userSlug: string;
  projectSlug: string;
  giteaRepoName: string | null;
  provisioningState?: string;
}

export function projectsNeedingClone(
  inputs: readonly ProjectRestoreInput[],
  isProjectCloned: (userSlug: string, projectSlug: string) => boolean,
): ProjectRestoreInput[] {
  return inputs.filter((p) => {
    if (!p.giteaRepoName) return false;
    if (p.provisioningState !== undefined && p.provisioningState !== "active") return false;
    if (isProjectCloned(p.userSlug, p.projectSlug)) return false;
    return true;
  });
}

export interface UserAgentInput {
  uid: string;
  slug: string;
  customerDir: string;
  agentDir: string;
  defaultAgent: { name: string; emoji: string; model: string };
  customerMmUserId?: string | null;
  default?: boolean;
  memorySearch?: Record<string, unknown>;
  hostCode?: AgentHostCodePolicy;
}

export function buildUserAgent(
  c: UserAgentInput,
): Record<string, unknown> {
  const agentId = `octogee-${c.slug}-coach`;

  const agent: Record<string, unknown> = {
    id: agentId,
    name: `${c.defaultAgent.name} (${c.slug})`,
    workspace: c.customerDir,
    agentDir: c.agentDir,
    model: c.defaultAgent.model,
    identity: { name: c.defaultAgent.name, emoji: c.defaultAgent.emoji },
    // An isolated gateway agent inherits the gateway-level tools of the isolated
    // template; only a shared-gateway agent carries the user lockdown.
    ...(c.hostCode === "builder-full" ? {} : { tools: workspaceDefaultAgentTools() }),
  };
  if (c.default) {
    agent.default = true;
  }
  if (c.memorySearch) {
    agent.memory = { search: c.memorySearch };
  }
  return agent;
}

export interface DefaultAgentIdentity {
  name: string;
  emoji: string;
}

export interface DefaultAgentIdentityDefaults {
  name: string;
  emoji: string;
}

export function resolveDefaultAgentIdentity(
  custom: DefaultAgentIdentity | undefined,
  defaults: DefaultAgentIdentityDefaults,
): DefaultAgentIdentity {
  return {
    name: (custom?.name && custom.name.length > 0) ? custom.name : defaults.name,
    emoji: (custom?.emoji && custom.emoji.length > 0) ? custom.emoji : defaults.emoji,
  };
}

export interface MattermostAccountInput {
  uid: string;
  slug: string;
  customerMmUserId?: string | null;
  channels?: ReadonlyArray<BindingChannelInput>;
  agentProjects?: ReadonlySet<string>;
}

export interface MattermostAccountEntry {
  baseUrl: string;
  botToken: MattermostAccountSecretRef;
  dmPolicy?: "allowlist" | "disabled";
  allowFrom?: string[];
  groupAllowFrom?: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  threadSessionScope: "channel";
  groups?: Record<string, { requireMention?: boolean }> | null;

  commands?: {
    native: false;
  };
}

export function buildMattermostAccounts(
  users: ReadonlyArray<MattermostAccountInput>,
  defaultAgentTokens: ReadonlyMap<string, string>,
  warn: (msg: string) => void = () => {},
): Record<string, MattermostAccountEntry> {
  const accounts: Record<string, MattermostAccountEntry> = {};
  for (const c of users) {
    const token = defaultAgentTokens.get(c.uid);
    if (!token) continue;
    const ownerMmUserId = typeof c.customerMmUserId === "string" &&
        MATTERMOST_ID_RE.test(c.customerMmUserId)
      ? c.customerMmUserId
      : null;
    if (!ownerMmUserId) {
      warn(`Skipping ${c.slug}-coach Mattermost account: owner Mattermost id is unavailable`);
      continue;
    }
    const accountId = `${c.slug}-coach`;
    accounts[accountId] = {
      baseUrl: PLATFORM_MATTERMOST_BASE_URL,
      botToken: mattermostAccountSecretRef(accountId),
      dmPolicy: "disabled",
      allowFrom: [ownerMmUserId],
      groupAllowFrom: [ownerMmUserId],
      groupPolicy: "open",
      threadSessionScope: "channel",
      groups: null,
      commands: { native: false },
    };
  }
  return accounts;
}

export interface OpenClawBinding {
  agentId: string;
  match: {
    channel: "mattermost";
    accountId: string;
    peer?: { kind: "group"; id: string };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAccountBinding(value: unknown): value is OpenClawBinding {
  if (!isRecord(value) || typeof value.agentId !== "string") return false;
  const match = value.match;
  return isRecord(match) &&
    match.channel === "mattermost" &&
    typeof match.accountId === "string" &&
    match.peer === undefined;
}

function mattermostBindingKey(value: unknown): string | null {
  if (!isRecord(value) || typeof value.agentId !== "string") return null;
  const match = value.match;
  if (
    !isRecord(match) ||
    match.channel !== "mattermost" ||
    typeof match.accountId !== "string"
  ) {
    return null;
  }
  if (match.peer === undefined) {
    return `${match.accountId}\u0000${value.agentId}\u0000account`;
  }
  if (
    !isRecord(match.peer) ||
    typeof match.peer.kind !== "string" ||
    typeof match.peer.id !== "string"
  ) {
    return `${match.accountId}\u0000${value.agentId}\u0000malformed`;
  }
  return `${match.accountId}\u0000${value.agentId}\u0000${match.peer.kind}\u0000${match.peer.id}`;
}

export function mattermostAccountBindingsNeedActivation(
  current: readonly unknown[],
  desired: readonly OpenClawBinding[],
): boolean {
  return mattermostAccountBindingsNeedingActivation(current, desired).length > 0;
}

export function mattermostAccountBindingsNeedingActivation(
  current: readonly unknown[],
  desired: readonly OpenClawBinding[],
): string[] {
  const desiredAccountIds = new Set(
    desired.filter(isAccountBinding).map((binding) => binding.match.accountId),
  );
  const desiredAgentUsernames = new Set(desired.flatMap((binding) => {
    const parsed = parseAgentId(binding.agentId);
    return parsed.kind === "unknown" ? [] : [parsed.username];
  }));
  const desiredRoutes = new Set(desired.flatMap((binding) => {
    const key = mattermostBindingKey(binding);
    return key ? [key] : [];
  }));
  const currentRoutes = new Set(current.flatMap((binding) => {
    const key = mattermostBindingKey(binding);
    return key ? [key] : [];
  }));
  const needsActivation = new Set<string>();

  for (const binding of desired.filter(isAccountBinding)) {
    const key = mattermostBindingKey(binding)!;
    if (!currentRoutes.has(key)) needsActivation.add(binding.match.accountId);
  }
  for (const binding of current) {
    const key = mattermostBindingKey(binding);
    if (!key) continue;
    const accountId = key.slice(0, key.indexOf("\u0000"));
    const agentId = isRecord(binding) && typeof binding.agentId === "string"
      ? binding.agentId
      : "";
    const parsedAgentId = parseAgentId(agentId);
    const managedAgent = parsedAgentId.kind !== "unknown" &&
      desiredAgentUsernames.has(parsedAgentId.username);
    if (
      (desiredAccountIds.has(accountId) || managedAgent) &&
      !desiredRoutes.has(key)
    ) {
      needsActivation.add(accountId);
    }
  }
  return [...needsActivation].sort();
}

export const SAFE_DEFAULT_AGENT_ID = "octogee-unmatched-route";

export const SAFE_DEFAULT_AGENT_PORTABLE_STATE_PATHS = [
  { relativePath: `agents/${SAFE_DEFAULT_AGENT_ID}`, kind: "directory" },
  { relativePath: `workspace-${SAFE_DEFAULT_AGENT_ID}`, kind: "directory" },
  { relativePath: `workspaces/${SAFE_DEFAULT_AGENT_ID}`, kind: "directory" },
  { relativePath: `memory/${SAFE_DEFAULT_AGENT_ID}.sqlite`, kind: "file" },
  { relativePath: `memory/${SAFE_DEFAULT_AGENT_ID}.sqlite-wal`, kind: "file" },
  { relativePath: `memory/${SAFE_DEFAULT_AGENT_ID}.sqlite-shm`, kind: "file" },
] as const;

export function isSafeDefaultAgentPortableStatePath(relativePath: string): boolean {
  return SAFE_DEFAULT_AGENT_PORTABLE_STATE_PATHS.some((item) =>
    item.kind === "directory"
      ? relativePath === item.relativePath || relativePath.startsWith(`${item.relativePath}/`)
      : relativePath === item.relativePath);
}

export function buildSafeDefaultAgent(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const agent: Record<string, unknown> = {
    id: SAFE_DEFAULT_AGENT_ID,
    name: "Unmatched Mattermost route",
    workspace: `${env.OPENCLAW_DIR || "/home/node/.openclaw"}/workspace-${SAFE_DEFAULT_AGENT_ID}`,
    tools: {
      profile: "minimal",
      alsoAllow: [],
      deny: [...USER_CODE_DENIED_TOOLS],
      fs: { workspaceOnly: true },
      toolsBySender: {},
    },
  };
  applyComputerBrowserAgentPolicy(agent, env);
  return agent;
}

function prepareGatewayAgentEntry(agent: unknown): unknown {
  if (agent === null || typeof agent !== "object" || Array.isArray(agent)) return agent;
  const entry = structuredClone(agent as Record<string, unknown>);
  delete entry.default;
  applyComputerBrowserAgentPolicy(entry);
  return entry;
}

export function gatewayAgentRoster(
  agents: readonly unknown[],
  builderSlug: string = gatewayAgentRosterUserSlug(),
): unknown[] {
  const retained = agents
    .filter((agent) => !(
      agent !== null &&
      typeof agent === "object" &&
      !Array.isArray(agent) &&
      (agent as { id?: unknown }).id === SAFE_DEFAULT_AGENT_ID
    ));
  const withoutExistingDefault = retained.map(prepareGatewayAgentEntry);
  if (!builderSlug) return [buildSafeDefaultAgent(), ...withoutExistingDefault];
  return withoutExistingDefault;
}

export function gatewayAgentRosterUserSlug(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const gatewayClass = env.GATEWAY_CLASS?.trim();
  if (gatewayClass === "shared") return "";
  if (isIsolatedGatewayClassValue(gatewayClass)) return userClaimSlug(env) || "";
  return "";
}

export interface ProjectAgentState {
  status?: string | null;
  identity?: ProjectAgentIdentity;
  projectId: string;
  enabled: boolean;
  mmUserId: string | null;
  token: string | null;
}

// A project agent is ACTIVE (routable, gets an agent entry + account +
// bindings) only once it is enabled AND its MM bot PAT is minted. Everything
// keys off this one predicate so the config can never half-include an agent.
export function activeAgentProjectIds(
  projectAgents: ReadonlyArray<ProjectAgentState>,
): Set<string> {
  return new Set(
    projectAgents
      .filter((p) => p.enabled && p.status !== "error" && typeof p.token === "string" && p.token.length > 0)
      .map((p) => p.projectId),
  );
}

export interface ProjectAgentsBuildInput {
  slug: string;
  customerDir: string;
  agentsDir: string;
  defaultAgent: { name: string; emoji: string; model: string | { primary: string; fallbacks: string[] } };
  projectAgents: ReadonlyArray<ProjectAgentState>;
  ownerMmUserId?: string | null;
  hostCode?: AgentHostCodePolicy;
  githubWorkspaces?: ReadonlyMap<string, { checkoutReady: boolean; sandboxMode?: unknown; sandbox?: Record<string, unknown>; defaultCwd?: unknown }>;
}

function projectAgentLocation(input: ProjectAgentsBuildInput, projectId: string): Record<string, unknown> {
  const checkout = `${input.customerDir}/projects/${projectId}`;
  const github = input.githubWorkspaces?.get(projectId);
  if (!github) return { workspace: checkout };
  const workspace = `${input.customerDir}/${PROJECT_AGENT_WORKSPACE_PARTS.join("/")}/${projectId}`;
  const location: Record<string, unknown> = { workspace };
  if (github.checkoutReady && input.hostCode === "builder-full" && github.sandboxMode === "off") location.cwd = checkout;
  else if (github.defaultCwd) location.cwd = workspace;
  if (github.sandbox) location.sandbox = github.sandbox;
  return location;
}

export function buildProjectAgents(input: ProjectAgentsBuildInput): Array<Record<string, unknown>> {
  const active = activeAgentProjectIds(input.projectAgents);
  return input.projectAgents
    .filter((p) => active.has(p.projectId))
    .map((p) => {
      const agentId = projectAgentId(input.slug, p.projectId);
      const identity = { name: p.identity?.name ?? p.projectId[0].toUpperCase() + p.projectId.slice(1), emoji: p.identity?.emoji ?? "🤖" };
      const ownerToolPolicy = workspaceDefaultAgentTools();
      return {
        id: agentId,
        name: `${identity.name} (${input.slug}/${p.projectId})`,
        ...projectAgentLocation(input, p.projectId),
        agentDir: `${input.agentsDir}/${agentId}/agent`,
        model: input.defaultAgent.model,
        identity,
        ...(input.hostCode === "builder-full" ? {} : {
          tools: {
            ...ownerToolPolicy,
            profile: "minimal",
            alsoAllow: PROJECT_AGENT_ALLOWED_TOOLS,
            deny: PROJECT_AGENT_DENIED_TOOLS,
            exec: { mode: "deny", host: "node" },
            fs: { workspaceOnly: true },
            toolsBySender: { "*": { deny: [...PRODUCTIVITY_TOOL_NAMES] } },
          },
        }),
      };
    });
}

export function buildProjectAgentAccounts(
  slug: string,
  projectAgents: ReadonlyArray<ProjectAgentState>,
  ownerMmUserId?: string | null,
): Record<string, MattermostAccountEntry> {
  if (typeof ownerMmUserId !== "string" || !MATTERMOST_ID_RE.test(ownerMmUserId)) return {};
  const active = activeAgentProjectIds(projectAgents);
  const accounts: Record<string, MattermostAccountEntry> = {};
  for (const p of projectAgents) {
    if (!active.has(p.projectId) || !p.token) continue;
    const accountId = `${slug}-proj-${p.projectId}`;
    accounts[accountId] = {
      baseUrl: PLATFORM_MATTERMOST_BASE_URL,
      botToken: mattermostAccountSecretRef(accountId),
      allowFrom: [ownerMmUserId],
      groupAllowFrom: [ownerMmUserId],
      dmPolicy: "disabled",
      groupPolicy: "open",
      threadSessionScope: "channel",
      commands: { native: false },
    };
  }
  return accounts;
}

export interface BindingChannelInput {
  channelId: string;
  scope?: "workspace" | "project";
  kind?: string;
  projectId?: string;
}

export function buildUserBindings(
  users: ReadonlyArray<{
    slug: string;
    channels: ReadonlyArray<BindingChannelInput>;
    agentProjects?: ReadonlySet<string>;
  }>,
): OpenClawBinding[] {
  return users.flatMap((c) => {
    const userDefaultAgentId = `octogee-${c.slug}-coach`;
    const defaultAgentAccountId = `${c.slug}-coach`;
    const projectIds = [...(c.agentProjects ?? [])].sort();
    const accountBindings: OpenClawBinding[] = [
      {
        agentId: userDefaultAgentId,
        match: {
          channel: "mattermost",
          accountId: defaultAgentAccountId,
        },
      },
      ...projectIds.map((projectId) => ({
        agentId: projectAgentId(c.slug, projectId),
        match: {
          channel: "mattermost" as const,
          accountId: `${c.slug}-proj-${projectId}`,
        },
      })),
    ];
    const peerBindings = c.channels.filter((binding) => binding.kind !== "admin" &&
      (binding.scope !== "project" || (binding.projectId !== undefined && c.agentProjects?.has(binding.projectId)))).map((binding) => {
      const projectAgent =
        binding.scope === "project" &&
        binding.projectId !== undefined &&
        c.agentProjects?.has(binding.projectId) === true;
      return {
        agentId: projectAgent
          ? projectAgentId(c.slug, binding.projectId!)
          : userDefaultAgentId,
        match: {
          channel: "mattermost" as const,
          accountId: projectAgent ? `${c.slug}-proj-${binding.projectId}` : defaultAgentAccountId,
          peer: { kind: "group" as const, id: binding.channelId },
        },
      };
    });
    return [...accountBindings, ...peerBindings];
  });
}
