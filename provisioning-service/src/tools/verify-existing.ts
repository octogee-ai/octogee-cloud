import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { computeWorkspaceDisplayName } from "@octogee/shared/types/display-names";
import { GIT_REPOSITORY_ROLES, type GitRepositoryRole } from "@octogee/shared/types/provisioning-service";

import type { ChatHost } from "../hosts/chat-host.js";
import { createMattermostChatHost, type HostLog } from "../hosts/chat-host-mattermost.js";
import type { GitHost, GitRepositoryKind } from "../hosts/git-host.js";
import { createGiteaGitHostAdapter } from "../hosts/git-host-gitea.js";
import { createWriteGuard, type GuardedWrite, type WriteGuard } from "./write-guard.js";

export const USAGE = `Usage: node dist/src/tools/verify-existing.js <users.json>

Confirms every listed user's chat host and git host resources through the
provisioning service's real adapters without writing anything: every request
other than GET is answered locally and never reaches a host. Each user runs
twice, once with the stored ids and once discovering the chat resources. Both
paths honor a recorded agent bot ID.
Exits 1 when any resource would be created, a stored id differs from the one
found by name, or a step fails.

Environment, the names the provisioning service reads:
  PROVISIONING_CHAT_HOST_URL, PROVISIONING_CHAT_HOST_ADMIN_TOKEN,
  PROVISIONING_CHAT_HOST_ADMIN_USER_ID, PROVISIONING_CHAT_CONTROL_COMMAND_URL,
  PROVISIONING_GIT_HOST_URL (the git host root; the API is under /api/v1),
  PROVISIONING_GIT_HOST_ADMIN_TOKEN

users.json is the output of this query against the platform database:
  SELECT json_agg(json_build_object(
    'uid', u.uid, 'slug', u.slug, 'email', COALESCE(a.email, ''),
    'stored', json_build_object(
      'chatUserId', cu.external_user_id, 'teamId', w.channel_host_team_id,
      'generalChannelId', g.channel_host_channel_id,
      'agentChannelId', c.channel_host_channel_id,
      'agentBotUserId', ca.external_user_id)))
  FROM users u
  LEFT JOIN user_accounts a ON a.uid = u.uid
  LEFT JOIN workspaces w ON w.slug = u.slug
  LEFT JOIN channel_identities cu ON cu.owner_kind = 'user' AND cu.owner_id = u.uid
    AND cu.channel_provider = 'managed' AND cu.channel_installation = 'default'
  LEFT JOIN channel_identities ca ON ca.owner_kind = 'agent' AND ca.owner_id = u.uid
    AND ca.channel_provider = 'managed' AND ca.channel_installation = 'default'
  LEFT JOIN workspace_channels g ON g.workspace_slug = u.slug AND g.project_slug = '' AND g.channel_id = 'general'
  LEFT JOIN workspace_channels c ON c.workspace_slug = u.slug AND c.project_slug = '' AND c.channel_id = 'coach-dm'
  WHERE u.admitted AND u.slug IS NOT NULL;

Optional per user: "displayName": {"first", "last"}, "agentChannel" (default
true), "repositories" (default ["workspace", "project-coaches"]),
"systemConfigRepository" (default false).`;

export interface StoredIds {
  chatUserId?: string | null;
  teamId?: string | null;
  generalChannelId?: string | null;
  agentChannelId?: string | null;
  agentBotUserId?: string | null;
}

export interface ExistingUser {
  uid: string;
  slug: string;
  email?: string;
  displayName?: { first: string; last: string };
  agentChannel?: boolean;
  repositories?: GitRepositoryRole[];
  systemConfigRepository?: boolean;
  stored?: StoredIds;
}

export type RunKind = "stored ids" | "no ids";

export interface RunReport {
  run: RunKind;
  found: Record<string, string>;
  wouldCreate: string[];
  mismatches: string[];
  writes: string[];
  errors: string[];
}

export interface UserReport {
  slug: string;
  runs: RunReport[];
}

export interface VerifySettings {
  chatHostUrl: string;
  chatHostAdminToken: string;
  chatHostAdminUserId: string | null;
  chatControlCommandUrl: string;
  gitHostUrl: string;
  gitHostAdminToken: string;
  fetch?: typeof fetch;
}

const silentLog: HostLog = { info: () => undefined, error: () => undefined };

const present = (value: string | null | undefined): string | undefined => (value ? value : undefined);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostsFor(settings: VerifySettings): { chat: ChatHost; git: GitHost; chatGuard: WriteGuard; gitGuard: WriteGuard } {
  const base = settings.fetch ?? fetch;
  const chatGuard = createWriteGuard(base, "chat");
  const gitGuard = createWriteGuard(base, "git");
  const chat = createMattermostChatHost({
    baseUrl: settings.chatHostUrl,
    adminToken: settings.chatHostAdminToken,
    adminUserId: settings.chatHostAdminUserId,
    controlCommandUrl: settings.chatControlCommandUrl,
    fetch: chatGuard.fetch,
    log: silentLog,
  });
  const git = createGiteaGitHostAdapter({
    apiBaseUrl: `${settings.gitHostUrl}/api/v1`,
    adminToken: settings.gitHostAdminToken,
    fetch: gitGuard.fetch,
    log: silentLog,
  });
  return { chat, git, chatGuard, gitGuard };
}

async function classifyWrites(host: string, writes: GuardedWrite[], report: RunReport): Promise<void> {
  for (const write of writes) {
    if (!write.create) {
      report.writes.push(`${host} ${write.method} ${write.path}`);
      continue;
    }
    const label = `${write.create.kind} ${write.create.name}`;
    try {
      if (await write.create.exists()) report.writes.push(`${host} create of existing ${label}`);
      else report.wouldCreate.push(label);
    } catch (error) {
      report.errors.push(message(error));
    }
  }
}

function compare(report: RunReport, resource: string, stored: string | null | undefined, found: string): void {
  report.found[resource] = found;
  if (stored && stored !== found) report.mismatches.push(`${resource}: stored ${stored}, found ${found}`);
}

async function step<T>(report: RunReport, name: string, body: () => Promise<T>): Promise<T | null> {
  try {
    return await body();
  } catch (error) {
    report.errors.push(`${name}: ${message(error)}`);
    return null;
  }
}

async function verifyChat(chat: ChatHost, user: ExistingUser, useStored: boolean, report: RunReport, signal: AbortSignal): Promise<void> {
  const stored = user.stored ?? {};
  const known = (value: string | null | undefined) => (useStored ? present(value) : undefined);
  const first = user.displayName?.first ?? "";
  const account = await step(report, "chat account", () => chat.ensureUser({
    uid: user.uid,
    slug: user.slug,
    email: user.email ?? "",
    displayName: { first, last: user.displayName?.last ?? "" },
    avatarUrl: null,
    knownUserId: known(stored.chatUserId),
  }, signal));
  if (!account) return;
  compare(report, "chat account", stored.chatUserId, account.userId);
  const team = await step(report, "chat team", () => chat.ensureTeam({
    slug: user.slug,
    displayName: computeWorkspaceDisplayName({ slug: user.slug, firstName: first, vibe: null }),
    userId: account.userId,
    knownTeamId: known(stored.teamId),
  }, signal));
  if (!team) return;
  compare(report, "chat team", stored.teamId, team.teamId);
  const channels = await step(report, "chat channels", () => chat.ensureChannels({
    slug: user.slug,
    ownerFirstName: first || user.slug,
    teamId: team.teamId,
    userId: account.userId,
    agentChannel: user.agentChannel ?? true,
    known: { general: known(stored.generalChannelId), agent: known(stored.agentChannelId) },
  }, signal));
  if (!channels) return;
  compare(report, "general channel", stored.generalChannelId, channels.general);
  if (channels.agent) compare(report, "agent channel", stored.agentChannelId, channels.agent);
  const bot = await step(report, "chat agent bot", () => chat.ensureAgentBot({
    slug: user.slug,
    ownerFirstName: first || user.slug,
    teamId: team.teamId,
    generalChannelId: channels.general,
    agentChannelId: channels.agent,
    existingBotUserId: present(stored.agentBotUserId),
  }, signal));
  if (bot) compare(report, "agent bot", stored.agentBotUserId, bot.botUserId);
}

async function verifyGit(git: GitHost, user: ExistingUser, report: RunReport, signal: AbortSignal): Promise<void> {
  const owner = await step(report, "git owner", () => git.ensureOwner({ slug: user.slug }, signal));
  if (!owner) return;
  report.found["git owner"] = owner.owner;
  const kinds: GitRepositoryKind[] = [
    ...(user.repositories ?? [...GIT_REPOSITORY_ROLES]),
    ...(user.systemConfigRepository ? ["system-config" as const] : []),
  ];
  for (const kind of kinds) {
    const repository = await step(report, `git repository ${kind}`, () => git.ensureRepository({ owner: owner.owner, kind }, signal));
    if (repository) report.found[`git repository ${kind}`] = "present";
  }
  const keys = await step(report, "git keys", () => git.listKeys({ owner: owner.owner, holders: [] }, signal));
  if (keys) report.found["git keys"] = String(keys.length);
}

export async function verifyUser(user: ExistingUser, settings: VerifySettings, signal: AbortSignal): Promise<UserReport> {
  const runs: RunReport[] = [];
  for (const run of ["stored ids", "no ids"] as const) {
    const { chat, git, chatGuard, gitGuard } = hostsFor(settings);
    const report: RunReport = { run, found: {}, wouldCreate: [], mismatches: [], writes: [], errors: [] };
    await Promise.all([
      verifyChat(chat, user, run === "stored ids", report, signal),
      verifyGit(git, user, report, signal),
    ]);
    await classifyWrites("chat", chatGuard.writes, report);
    await classifyWrites("git", gitGuard.writes, report);
    runs.push(report);
  }
  return { slug: user.slug, runs };
}

export function reportFails(report: UserReport): boolean {
  return report.runs.some((run) => run.wouldCreate.length > 0 || run.mismatches.length > 0 || run.errors.length > 0);
}

export function formatReport(report: UserReport): string {
  const lines = [`== ${report.slug} ==`];
  for (const run of report.runs) {
    lines.push(`  [${run.run}]`);
    for (const [resource, value] of Object.entries(run.found)) lines.push(`    found         ${resource}: ${value}`);
    for (const entry of run.wouldCreate) lines.push(`    WOULD CREATE  ${entry}`);
    for (const entry of run.mismatches) lines.push(`    ID MISMATCH   ${entry}`);
    for (const entry of run.errors) lines.push(`    STEP FAILED   ${entry}`);
    for (const entry of run.writes) lines.push(`    would write   ${entry}`);
  }
  return lines.join("\n");
}

function isUser(value: unknown): value is ExistingUser {
  const candidate = value as Partial<ExistingUser> | null;
  return typeof candidate?.uid === "string" && candidate.uid.length > 0 && typeof candidate.slug === "string" && candidate.slug.length > 0;
}

export function parseUsers(raw: string): ExistingUser[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isUser)) throw new Error("users file must be a JSON array of objects with uid and slug");
  return parsed;
}

function setting(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function settingsFromEnvironment(env: NodeJS.ProcessEnv): VerifySettings {
  return {
    chatHostUrl: withoutTrailingSlashes(setting(env, "PROVISIONING_CHAT_HOST_URL")),
    chatHostAdminToken: setting(env, "PROVISIONING_CHAT_HOST_ADMIN_TOKEN"),
    chatHostAdminUserId: env.PROVISIONING_CHAT_HOST_ADMIN_USER_ID?.trim() || null,
    chatControlCommandUrl: setting(env, "PROVISIONING_CHAT_CONTROL_COMMAND_URL"),
    gitHostUrl: withoutTrailingSlashes(setting(env, "PROVISIONING_GIT_HOST_URL")),
    gitHostAdminToken: setting(env, "PROVISIONING_GIT_HOST_ADMIN_TOKEN"),
  };
}

async function main(argv: string[]): Promise<number> {
  const file = argv[0];
  if (!file || file === "--help") {
    process.stderr.write(`${USAGE}\n`);
    return file ? 0 : 2;
  }
  const settings = settingsFromEnvironment(process.env);
  const users = parseUsers(await readFile(file, "utf8"));
  let failing = 0;
  for (const user of users) {
    const report = await verifyUser(user, settings, AbortSignal.timeout(120_000));
    process.stdout.write(`${formatReport(report)}\n`);
    if (reportFails(report)) failing += 1;
  }
  process.stdout.write(`${users.length} users verified, ${failing} with findings\n`);
  return failing > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
    process.stderr.write(`verify-existing failed: ${message(error)}\n`);
    process.exit(2);
  });
}
