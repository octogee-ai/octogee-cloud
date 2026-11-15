import { PROJECT_AGENT_WORKSPACE_PARTS } from "@octogee/shared/types/project";
import { isValidProjectId, projectAgentId } from "@octogee/shared/types/identity";
import { userAgentRosterPatch, userConfigReplacePaths } from "./apply-config-patch.js";
import { buildUserBindings, type BindingChannelInput } from "./openclaw-config-users.js";
import { mattermostAccountSecretRef } from "./mattermost-account-secrets.js";

type ConfigEntry = Record<string, unknown>;

export function configuredUserManagedProjectIds(current: unknown, slug: string, authoritativeIds: readonly string[]): string[] {
  const managed = new Set(authoritativeIds);
  for (const id of managed) {
    if (!isValidProjectId(id)) throw new Error(`invalid managed project ID: ${id}`);
  }
  const prefix = `${slug}-proj-`;
  const accounts = record(record(record(record(current).channels).mattermost).accounts);
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!accountId.startsWith(prefix)) continue;
    const projectId = accountId.slice(prefix.length);
    if (!isValidProjectId(projectId)) continue;
    const token = record(account).botToken;
    if (token === null || typeof token !== "object" || Array.isArray(token)) continue;
    const secret = record(token);
    const canonical = mattermostAccountSecretRef(accountId);
    if (Object.keys(secret).length === 3 && secret.source === canonical.source && secret.provider === canonical.provider && secret.id === canonical.id) {
      managed.add(projectId);
    }
  }
  return [...managed];
}

export interface ConfiguredUserProjectAgentInput {
  slug: string;
  managedProjectIds: readonly string[];
  activationProjectIds: readonly string[];
  projectAgentEntries: readonly ConfigEntry[];
  projectAccounts: Record<string, unknown>;
  channels: readonly BindingChannelInput[];
  ownerMmUserId: string | null | undefined;
}

export interface ConfiguredUserProjectAgentPatch {
  patch: {
    agents: ReturnType<typeof userAgentRosterPatch>;
    bindings: unknown[];
    channels: { mattermost: { accounts: Record<string, unknown> } };
    commands?: { ownerAllowFrom: string[] };
  };
  replacePaths: string[];
  retiredAgentIds: string[];
}

function record(value: unknown): ConfigEntry {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("project reconciliation expected a config object");
  return value as ConfigEntry;
}

const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;

export function validOwnerMmUserId(slug: string, ownerMmUserId: string | null | undefined): string {
  if (typeof ownerMmUserId !== "string" || !MATTERMOST_ID_RE.test(ownerMmUserId)) {
    throw new Error(`owner Mattermost id is unavailable for ${slug}`);
  }
  return ownerMmUserId;
}

function withOwnerAuthority(account: ConfigEntry, slug: string, ownerMmUserId: string | null | undefined): ConfigEntry {
  if (account.allowFrom !== undefined) return account;
  return { ...account, allowFrom: [validOwnerMmUserId(slug, ownerMmUserId)] };
}

function defaultAgentOwnerAuthority(current: unknown, slug: string, ownerMmUserId: string | null | undefined): Record<string, ConfigEntry> {
  const accountId = `${slug}-coach`;
  const defaultAgent = record(record(record(record(current).channels).mattermost).accounts)[accountId];
  if (defaultAgent === undefined || record(defaultAgent).allowFrom !== undefined) return {};
  return { [accountId]: { allowFrom: [validOwnerMmUserId(slug, ownerMmUserId)] } };
}

export function userOwnerCommandsPatch(
  current: unknown,
  slug: string,
  ownerMmUserId: string | null | undefined,
): { ownerAllowFrom: string[] } | undefined {
  if (record(record(current).commands).ownerAllowFrom !== undefined) return undefined;
  return { ownerAllowFrom: [`mattermost:${validOwnerMmUserId(slug, ownerMmUserId)}`] };
}

export interface ConfiguredUserOwnerAuthorityPatch {
  commands?: { ownerAllowFrom: string[] };
  channels?: { mattermost: { accounts: Record<string, ConfigEntry> } };
}

export function configuredUserOwnerAuthorityPatch(
  current: unknown,
  slug: string,
  ownerMmUserId: string | null | undefined,
): ConfiguredUserOwnerAuthorityPatch {
  const commands = userOwnerCommandsPatch(current, slug, ownerMmUserId);
  const accounts = defaultAgentOwnerAuthority(current, slug, ownerMmUserId);
  return {
    ...(commands ? { commands } : {}),
    ...(Object.keys(accounts).length > 0 ? { channels: { mattermost: { accounts } } } : {}),
  };
}

export function configuredUserWorkspacePatch(
  current: unknown,
  slug: string,
  ownerMmUserId: string | null | undefined,
  channels: readonly BindingChannelInput[],
): ConfiguredUserOwnerAuthorityPatch & { bindings?: unknown[] } {
  const bindings = projectBindings(current, {
    slug, ownerMmUserId, channels: channels.filter(channel => channel.scope === "workspace"),
    managedProjectIds: [], activationProjectIds: [], projectAgentEntries: [], projectAccounts: {},
  }, new Set(), new Set());
  return {
    ...configuredUserOwnerAuthorityPatch(current, slug, ownerMmUserId),
    ...(bindings !== record(current).bindings && bindings.length > 0 ? { bindings } : {}),
  };
}

function currentRoster(current: unknown): ConfigEntry[] {
  const agents = record(record(current).agents);
  if (agents.entries !== undefined) {
    return Object.entries(record(agents.entries)).map(([id, entry]) => ({ ...record(entry), id }));
  }
  return Array.isArray(agents.list) ? agents.list.map(record) : [];
}

function projectScope(input: ConfiguredUserProjectAgentInput) {
  const managed = new Map(input.managedProjectIds.map((id) => [projectAgentId(input.slug, id), id]));
  const accounts = new Set(input.managedProjectIds.map((id) => `${input.slug}-proj-${id}`));
  for (const account of Object.keys(input.projectAccounts)) {
    if (!accounts.has(account)) throw new Error(`unmanaged project account: ${account}`);
  }
  for (const id of input.activationProjectIds) {
    if (!managed.has(projectAgentId(input.slug, id))) throw new Error(`unmanaged project activation: ${id}`);
  }
  const active = new Set<string>();
  for (const entry of input.projectAgentEntries) {
    const id = managed.get(String(entry.id));
    if (!id) throw new Error(`unmanaged project agent: ${String(entry.id)}`);
    if (!input.projectAccounts[`${input.slug}-proj-${id}`]) {
      throw new Error(`project agent account is missing: ${id}`);
    }
    active.add(id);
  }
  for (const id of input.managedProjectIds) {
    if (input.projectAccounts[`${input.slug}-proj-${id}`] && !active.has(id)) throw new Error(`project agent entry is missing: ${id}`);
  }
  return { managed, accounts, active };
}

function projectBindings(current: unknown, input: ConfiguredUserProjectAgentInput, replaced: ReadonlySet<string>, active: ReadonlySet<string>): unknown[] {
  const agentIds = new Set([...replaced].map((id) => projectAgentId(input.slug, id)));
  const accountIds = new Set([...replaced].map((id) => `${input.slug}-proj-${id}`));
  const projectChannelIds = new Set(input.channels.filter(channel => channel.scope === "project").map(channel => channel.channelId));
  const channelIds = new Set(input.channels.filter((channel) => channel.scope === "project" && replaced.has(channel.projectId ?? "")).map((channel) => channel.channelId));
  const before = record(current).bindings;
  const bindings: unknown[] = Array.isArray(before) ? before : [];
  const kept = bindings.filter((binding) => {
    const entry = record(binding);
    const match = record(entry.match);
    const defaultAgentProjectRoute = projectChannelIds.has(String(record(match.peer).id)) &&
      (entry.agentId === `octogee-${input.slug}-coach` || match.accountId === `${input.slug}-coach`);
    return match.channel !== "mattermost" || !(defaultAgentProjectRoute || agentIds.has(String(entry.agentId)) || accountIds.has(String(match.accountId)) || channelIds.has(String(record(match.peer).id)));
  });
  const desired = buildUserBindings([{ slug: input.slug, channels: input.channels, agentProjects: active }]);
  const activeAgentIds = new Set([...active].map(id => projectAgentId(input.slug, id)));
  const projectRoutes = desired.filter((binding) => agentIds.has(binding.agentId) ||
    (activeAgentIds.has(binding.agentId) && binding.match.peer !== undefined && !kept.some(existing => {
      const match = record(record(existing).match);
      const peer = record(match.peer);
      return match.channel === binding.match.channel && match.accountId === binding.match.accountId &&
        peer.kind === binding.match.peer?.kind && peer.id === binding.match.peer?.id;
    })));
  const workspaceChannelIds = new Set(input.channels.filter((channel) => channel.scope === "workspace").map((channel) => channel.channelId));
  const routedPeers = new Set([...kept, ...projectRoutes].map((binding) => {
    const match = record(record(binding).match);
    return `${String(match.accountId)}:${String(record(match.peer).id)}`;
  }));
  const defaultAgentWorkspaceRoutes = desired.filter((binding) =>
    binding.agentId === `octogee-${input.slug}-coach` &&
    workspaceChannelIds.has(binding.match.peer?.id ?? "") &&
    !routedPeers.has(`${binding.match.accountId}:${binding.match.peer?.id}`));
  const next = [...kept, ...projectRoutes, ...defaultAgentWorkspaceRoutes];
  const sorted = (items: unknown[]) => JSON.stringify(items.map((item) => JSON.stringify(item)).sort());
  return sorted(next) === sorted(bindings) ? bindings : next;
}

export function configuredUserProjectAgentPatch(current: unknown, input: ConfiguredUserProjectAgentInput): ConfiguredUserProjectAgentPatch {
  const { managed, accounts, active } = projectScope(input);
  const roster = currentRoster(current);
  const existingAgents = new Map(roster.map((entry) => [String(entry.id), entry]));
  const existingAccounts = record(record(record(record(current).channels).mattermost).accounts);
  const activating = new Set(input.activationProjectIds.map((id) => projectAgentId(input.slug, id)));
  const entries = input.projectAgentEntries.map((entry) => {
    const existing = existingAgents.get(String(entry.id));
    const retained = existing && !activating.has(String(entry.id)) ? existing : { ...entry, ...existing };
    const result: ConfigEntry = { ...retained, id: entry.id, name: entry.name, identity: entry.identity };
    const workspaceSuffix = `/${PROJECT_AGENT_WORKSPACE_PARTS.join("/")}/${managed.get(String(entry.id))}`;
    if ([existing?.workspace, entry.workspace].some(workspace => typeof workspace === "string" && workspace.endsWith(workspaceSuffix))) {
      result.workspace = entry.workspace;
      if (entry.cwd !== undefined) result.cwd = entry.cwd;
      else if (result.cwd !== undefined) {
        if (record(record(current).agents).entries !== undefined) result.cwd = null;
        else delete result.cwd;
      }
    }
    return result;
  });
  const desiredAgents = new Map(entries.map((entry) => [String(entry.id), entry]));
  const fullRoster = [...roster.map((entry) => desiredAgents.get(String(entry.id)) ?? entry), ...entries.filter((entry) => !existingAgents.has(String(entry.id)))];
  const replaced = new Set(input.activationProjectIds);
  const accountPatch: Record<string, unknown> = {};
  for (const id of input.managedProjectIds) {
    const accountId = `${input.slug}-proj-${id}`;
    if (!active.has(id)) {
      accountPatch[accountId] = null;
      replaced.add(id);
      continue;
    }
    const desired = record(input.projectAccounts[accountId]);
    const existing = existingAccounts[accountId];
    const account = existing && !replaced.has(id) ? record(existing) : { ...desired, ...record(existing), botToken: desired.botToken };
    accountPatch[accountId] = withOwnerAuthority(account, input.slug, input.ownerMmUserId);
    if (!existingAccounts[accountId] || !existingAgents.has(projectAgentId(input.slug, id))) replaced.add(id);
  }
  const ownerAuthority = configuredUserOwnerAuthorityPatch(current, input.slug, input.ownerMmUserId);
  Object.assign(accountPatch, ownerAuthority.channels?.mattermost.accounts);
  const isKeyed = record(record(current).agents).entries !== undefined;
  return {
    patch: {
      agents: userAgentRosterPatch(current, input.slug, isKeyed ? entries : fullRoster),
      bindings: projectBindings(current, input, replaced, active),
      channels: { mattermost: { accounts: accountPatch } },
      ...(ownerAuthority.commands ? { commands: ownerAuthority.commands } : {}),
    },
    replacePaths: userConfigReplacePaths(current, input.slug).filter((path) => path === "bindings" || [...accounts].some((id) => path.startsWith(`channels.mattermost.accounts.${id}.`))),
    retiredAgentIds: roster.filter((entry) => managed.has(String(entry.id)) && !desiredAgents.has(String(entry.id))).map((entry) => String(entry.id)),
  };
}
