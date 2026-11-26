import { applyPreBootPatches } from "../entrypoints/pre-boot-config.js";
import { localStateStoreKind, localStateStorePath } from "./openclaw-state-store.js";
import { agentIdsFromConfig } from "@octogee/core/byosub-restore";
import { runOpenClaw, type OpenClawCommand } from "./openclaw-cli.js";
import { redactSecrets } from "@octogee/shared/types/secret-redaction";
import { clearMountedMarker } from "./local-default-agent-wired.js";
import { disableSystemConfigWatch, isSystemConfigRuntimeProjection } from "./system-config-watch-state.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as fs from "fs";
import * as path from "path";

import { acquireSystemConfigSyncLeaseSync } from "@octogee/core/system-config-mutation-lease";

import { isValidUsername, parseAgentId, workspaceDefaultAgentId } from "@octogee/shared/types/identity";
import { DEFAULT_USER_AGENT_MODEL_REF } from "@octogee/shared/types/platform-config";
import { SAFE_DEFAULT_AGENT_ID, buildSafeDefaultAgent } from "./openclaw-config-users.js";
import {
  log as defaultLog,
  AGENTS_DIR,
  CUSTOMERS_DIR,
  OPENCLAW_DIR,
  TEMPLATES_DIR,
  GIT_SSH_HOST,
} from "./config.js";
import {
  generateUserSshKey,
  gitExec,
  userSshKeyPath,
  setRepoSshCommand,
} from "./git.js";
import {
  systemConfigRepoName,
  workspaceGiteaOrg,
} from "./gitea-naming.js";
import { brokeredGitHost } from "./gitea-admin-broker-client.js";
import { systemConfigFingerprint } from "./system-config-watcher.js";
import {
  mattermostAccountSecretRef,
  updateMattermostAccountSecrets,
} from "./mattermost-account-secrets.js";
import {
  PlatformInvariantPolicyError,
  assertPlatformInvariants,
  reconcilePlatformInvariants,
  reconcilePlatformProjections,
} from "./system-config-invariants.js";
import {
  USER_CODE_DENIED_TOOLS,
  reconcileIsolatedGatewayAgentEntry,
} from "@octogee/core/system-config-invariants";
import {
  attributedCommitArgs,
  convergeSystemConfigToRemoteCommit,
  recoverSystemConfigHead,
  type SystemConfigCommitSource,
  type SystemConfigRecoveryResult,
  type SystemConfigRemoteConvergenceOptions,
  type SystemConfigRemoteConvergenceResult,
} from "./system-config-recovery.js";
import {
  readSystemConfigStatus,
  updateSystemConfigStatus,
} from "./system-config-status.js";
import {
  assertSystemConfigGitignore,
  assertSystemConfigMetadata,
  CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION,
  readSystemConfigCommitBlob,
  SYSTEM_CONFIG_LEGACY_MAC_STATE_CLEANUP,
  SYSTEM_CONFIG_SCHEMA_VERSION_HOST_CODE_LOCKDOWN_LIFTED,
  SYSTEM_CONFIG_SCHEMA_VERSION_MAC_LANE_REMOVED,
  SYSTEM_CONFIG_SCHEMA_VERSION_USER_AGENT_SHARED_FENCE_LIFTED,
  type ReadSystemConfigCommitBlob,
  type SystemConfigDurableFilename,
  SYSTEM_CONFIG_DURABLE_FILENAMES,
} from "./system-config-durable-files.js";
import { userClaimSlug } from "@octogee/shared/server/user-claim";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

type UnknownRecord = Record<string, unknown>;

function acceptRuntimeManagedConfig(): void {
  return;
}

const SYSTEM_CONFIG_PATHSPEC_ARGS = ["openclaw.json", ".octogee.json", ".gitignore"];
const SYSTEM_CONFIG_GITIGNORE = "*.bak\n*.tmp\n";
const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;
const OPENCLAW_CONFIG_FILENAME = "openclaw.json";
const SYSTEM_CONFIG_METADATA_FILENAME = ".octogee.json";
const SYSTEM_CONFIG_GITIGNORE_FILENAME = ".gitignore";
const GIT_REV_PARSE_HEAD = ["rev-parse", "HEAD"];
const MAIN_REF = "refs/heads/main";
const ACCEPTED_HEAD_UNAVAILABLE = "accepted-head-unavailable";
const VALIDATION_RESTORE_FAILED = "validation-restore-failed";

function fingerprintContents(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export interface SystemConfigRestoreResult {
  skipped?: string;
  seeded: boolean;
  restored: boolean;
  configPath?: string;
}

export interface SystemConfigSyncResult {
  skipped?: string;
  committed: boolean;
  pushed: boolean;
  pending?: boolean;
  processedFingerprint?: string;
  rejected?: boolean;
  errorCode?: string;
  policyPaths?: string[];
  acceptedCommit?: string;
  configHash?: string;
}

interface SystemConfigRestoreOptions {
  openclawDir?: string;
  templatePath?: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  recover?: typeof recoverSystemConfigHead;
  validateConfig?: (configPath: string) => void;
}

export interface SystemConfigSyncOptions {
  openclawDir?: string;
  now?: () => Date;
  log?: (msg: string) => void;
  gitExec?: typeof gitExec;
  setRepoSshCommand?: typeof setRepoSshCommand;
  userSshKeyPath?: typeof userSshKeyPath;
  validateConfig?: (configPath: string) => void;
  durablePolicy?: boolean;
  env?: NodeJS.ProcessEnv;
  source?: SystemConfigCommitSource;
  lockHeld?: boolean;
  readCommitBlob?: ReadSystemConfigCommitBlob;
  expectedRemoteCommit?: string;
  convergeRemoteCommit?: (
    options: SystemConfigRemoteConvergenceOptions,
  ) => SystemConfigRemoteConvergenceResult;
}

interface SystemConfigAuditOptions {
  openclawDir?: string;
  gitExec?: typeof gitExec;
  userSshKeyPath?: typeof userSshKeyPath;
}

export interface SystemConfigAuditResult {
  state: "clean" | "dirty" | "error" | "unavailable";
  needsSync: boolean;
  head?: string;
  remoteHead?: string;
  headTree?: string;
  indexTree?: string;
  worktreeDirty?: boolean;
  configHash?: string;
  errorCode?: string;
}

export function systemConfigDir(openclawDir = OPENCLAW_DIR): string {
  return path.join(openclawDir, "system_config");
}

export function systemConfigPath(openclawDir = OPENCLAW_DIR): string {
  return path.join(systemConfigDir(openclawDir), OPENCLAW_CONFIG_FILENAME);
}

function remoteUrl(slug: string): string {
  return `git@${GIT_SSH_HOST}:${workspaceGiteaOrg(slug)}/${systemConfigRepoName()}.git`;
}

function atomicWrite(filePath: string, contents: string | Buffer, mode = 0o600): void {
  const staging = fs.mkdtempSync(path.join(path.dirname(filePath), ".octogee-config-"));
  try {
    const pending = path.join(staging, "pending");
    fs.writeFileSync(pending, contents, { flag: "wx", mode });
    fs.renameSync(pending, filePath);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function readSystemConfigMetadata(filePath: string): UnknownRecord | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const metadata = asRecord(value);
    if (!metadata || !Number.isInteger(metadata.schemaVersion)) {
      throw new Error("schemaVersion must be an integer");
    }
    if (metadata.pendingStateCleanup !== undefined &&
        metadata.pendingStateCleanup !== SYSTEM_CONFIG_LEGACY_MAC_STATE_CLEANUP) {
      throw new Error("pendingStateCleanup is invalid");
    }
    return metadata;
  } catch {
    throw new Error(`[system_config] invalid system_config metadata at ${filePath}`);
  }
}

function recordString(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function legacyMacAgentIds(env: NodeJS.ProcessEnv): Set<string> {
  const ids = new Set(["${OPERATOR_AGENT_ID}", "octogee-ops-${GATEWAY_ID}"]);
  for (const value of [
    env.OPERATOR_AGENT_ID,
    env.GATEWAY_ID,
    userClaimSlug(env) ?? undefined,
    env.OPERATOR_AGENT_SLUG,
  ]) {
    if (!value) continue;
    ids.add(value.startsWith("octogee-ops-") ? value : `octogee-ops-${value}`);
  }
  return ids;
}

function isLegacyMacAgent(agent: UnknownRecord, exactIds: ReadonlySet<string>): boolean {
  const id = recordString(agent, "id");
  if (exactIds.has(id)) return true;
  const identity = asRecord(agent.identity);
  return id.startsWith("octogee-ops-") &&
    recordString(identity ?? {}, "name") === "Mac" &&
    recordString(agent, "workspace") === "/home/node/.openclaw/workspace/ops";
}

// 2026.7.2 rewrites `agents.list` into keyed `agents.entries` at pre-boot, so a
// list-only reader would leave the legacy Mac lane rostered forever. Both forms
// are swept: the migration leaves the pre-migration list behind, and a removal
// that clears only one of them puts the agent back on the next normalization.
function removeLegacyMacAgents(
  agents: UnknownRecord | null,
  env: NodeJS.ProcessEnv,
): { changed: boolean; removedIds: Set<string> } {
  const removedIds = new Set<string>();
  const exactIds = legacyMacAgentIds(env);
  let changed = false;

  const entries = asRecord(agents?.entries);
  if (entries) {
    for (const [id, value] of Object.entries(entries)) {
      const agent = asRecord(value);
      if (!agent || !isLegacyMacAgent({ ...agent, id }, exactIds)) continue;
      delete entries[id];
      removedIds.add(id);
      changed = true;
    }
  }

  if (Array.isArray(agents?.list)) {
    const kept = agents.list.filter((entry) => {
      const agent = asRecord(entry);
      if (!agent || !isLegacyMacAgent(agent, exactIds)) return true;
      const id = recordString(agent, "id");
      if (id) removedIds.add(id);
      return false;
    });
    if (kept.length !== agents.list.length) {
      agents.list = kept;
      changed = true;
    }
  }

  return { changed, removedIds };
}

function removeLegacyMacBindings(
  config: UnknownRecord,
  legacyIds: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(config.bindings)) return false;
  const kept = config.bindings.filter((entry) => {
    const binding = asRecord(entry);
    return binding === null || !legacyIds.has(recordString(binding, "agentId"));
  });
  const changed = kept.length !== config.bindings.length;
  if (changed) config.bindings = kept;
  return changed;
}

function removeDefaultMattermostAccount(
  mattermost: UnknownRecord | null,
  accounts: UnknownRecord | null,
  removeDefaultAccount: boolean,
): boolean {
  let defaultChanged = false;
  if (removeDefaultAccount && accounts && Object.prototype.hasOwnProperty.call(accounts, "default")) {
    delete accounts.default;
    defaultChanged = true;
  }
  if (removeDefaultAccount && mattermost?.defaultAccount === "default") {
    delete mattermost.defaultAccount;
    defaultChanged = true;
  }
  return defaultChanged;
}

function removeLegacyMattermostTokens(
  mattermost: UnknownRecord | null,
): boolean {
  let tokenChanged = false;
  for (const key of ["botToken", "token"]) {
    if (mattermost?.[key] === "${MM_BOT_TOKEN}") {
      delete mattermost[key];
      tokenChanged = true;
    }
  }
  return tokenChanged;
}

function removeLegacyMattermostConfig(
  config: UnknownRecord,
): boolean {
  const mattermost = asRecord(asRecord(config.channels)?.mattermost);
  const accounts = asRecord(mattermost?.accounts);
  const defaultAccount = asRecord(accounts?.default);
  const commands = asRecord(defaultAccount?.commands);
  const removeDefaultAccount = mattermost?.defaultAccount === "default" &&
    defaultAccount?.botToken === "${MM_BOT_TOKEN}" &&
    Object.keys(defaultAccount).sort().join(",") === "botToken,commands" &&
    commands?.native === false &&
    Object.keys(commands).length === 1;
  const defaultChanged = removeDefaultMattermostAccount(
    mattermost,
    accounts,
    removeDefaultAccount,
  );
  const tokenChanged = removeLegacyMattermostTokens(mattermost);
  return defaultChanged || tokenChanged;
}

/** The roster entry to mutate, whichever shape openclaw is storing. 2026.7.2
 *  migrates `agents.list` into keyed `agents.entries`, where the key is the id
 *  and the entry carries none. */
function rosterAgentEntry(agents: UnknownRecord | null, agentId: string): UnknownRecord | null {
  const entries = asRecord(agents?.entries);
  if (entries) return asRecord(entries[agentId]);
  return Array.isArray(agents?.list)
    ? asRecord(agents.list.find((entry) => asRecord(entry)?.id === agentId))
    : null;
}

function selectUserDefaultAgent(
  agents: UnknownRecord | null,
  env: NodeJS.ProcessEnv,
): boolean {
  const userSlug = userClaimSlug(env);
  if (!userSlug || agents?.ownership === "explicit") return false;
  const defaultAgent = rosterAgentEntry(agents, `octogee-${userSlug}-coach`);
  if (!defaultAgent || defaultAgent.default === true) return false;
  defaultAgent.default = true;
  return true;
}

export function removeLegacyMacConfig(
  config: UnknownRecord,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const agents = asRecord(config.agents);
  const removed = removeLegacyMacAgents(agents, env);
  const bindingIds = new Set([...legacyMacAgentIds(env), ...removed.removedIds]);
  const bindingsChanged = removeLegacyMacBindings(config, bindingIds);
  const mattermostChanged = removeLegacyMattermostConfig(config);
  const userDefaultAgentChanged = selectUserDefaultAgent(agents, env);
  return removed.changed || bindingsChanged || mattermostChanged || userDefaultAgentChanged;
}

export function removeLegacyMacState(
  openclawDir: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const agentId of legacyMacAgentIds(env)) {
    if (!agentId.startsWith("octogee-ops-") || agentId.includes("${")) continue;
    fs.rmSync(path.join(openclawDir, "agents", agentId), { recursive: true, force: true });
    for (const suffix of [".sqlite", ".sqlite-wal", ".sqlite-shm"]) {
      fs.rmSync(path.join(openclawDir, "memory", `${agentId}${suffix}`), { force: true });
    }
  }
}

function deleteWhenExactly(record: UnknownRecord | null, key: string, expected: unknown): boolean {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return false;
  if (!isDeepStrictEqual(record[key], expected)) return false;
  delete record[key];
  return true;
}

function deleteWhenEmpty(parent: UnknownRecord | null, key: string): void {
  const child = asRecord(parent?.[key]);
  if (parent && child && Object.keys(child).length === 0) delete parent[key];
}

function withoutTools(value: unknown, removed: readonly string[]): { list: unknown[]; changed: boolean } | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter((tool) => !removed.includes(tool as string));
  return { list, changed: list.length !== value.length };
}

function liftHostCodeToolFences(tools: UnknownRecord | null): boolean {
  if (!tools) return false;
  let changed = false;
  const deny = withoutTools(tools.deny, USER_CODE_DENIED_TOOLS);
  if (deny?.changed) {
    changed = true;
    if (deny.list.length === 0) delete tools.deny;
    else tools.deny = deny.list;
  }
  changed = deleteWhenExactly(tools, "exec", { mode: "deny" }) || changed;
  changed = deleteWhenExactly(tools, "elevated", { enabled: false }) || changed;
  changed = deleteWhenExactly(asRecord(tools.fs), "workspaceOnly", true) || changed;
  deleteWhenEmpty(tools, "fs");
  changed = deleteWhenExactly(asRecord(tools.sessions), "visibility", "self") || changed;
  deleteWhenEmpty(tools, "sessions");
  const subagentTools = asRecord(asRecord(tools.subagents)?.tools);
  const subagentDeny = withoutTools(subagentTools?.deny, ["exec", "process"]);
  if (subagentTools && subagentDeny?.changed) {
    changed = true;
    if (subagentDeny.list.length === 0) delete subagentTools.deny;
    else subagentTools.deny = subagentDeny.list;
  }
  deleteWhenEmpty(asRecord(tools.subagents), "tools");
  deleteWhenEmpty(tools, "subagents");
  return changed;
}

function liftUserDefaultAgentToolFences(config: UnknownRecord, env: NodeJS.ProcessEnv): boolean {
  const slug = userClaimSlug(env);
  if (!slug) return false;
  const defaultAgent = rosterAgentEntry(asRecord(config.agents), `octogee-${slug}-coach`);
  if (!defaultAgent) return false;
  const changed = liftHostCodeToolFences(asRecord(defaultAgent.tools));
  deleteWhenEmpty(defaultAgent, "tools");
  return changed;
}

function liftUserAgentToolFences(config: UnknownRecord, env: NodeJS.ProcessEnv): boolean {
  const slug = userClaimSlug(env);
  if (!slug) return false;
  const agents = asRecord(config.agents);
  if (!agents) return false;
  let changed = false;
  const lift = (agentId: string, agent: UnknownRecord): UnknownRecord => {
    const parsed = parseAgentId(agentId);
    if (
      (parsed.kind !== "project" && parsed.kind !== "coach") ||
      parsed.username !== slug
    ) return agent;
    const reconciled = reconcileIsolatedGatewayAgentEntry(agentId, agent);
    if (!isDeepStrictEqual(reconciled, agent)) changed = true;
    return reconciled;
  };
  if (Array.isArray(agents.list)) {
    agents.list = agents.list.map((entry) => {
      const agent = asRecord(entry);
      const agentId = agent ? recordString(agent, "id") : "";
      return agent && agentId ? lift(agentId, agent) : entry;
    });
  }
  const entries = asRecord(agents.entries);
  if (entries) {
    for (const [agentId, entry] of Object.entries(entries)) {
      const agent = asRecord(entry);
      if (agent) entries[agentId] = lift(agentId, agent);
    }
  }
  return changed;
}

function liftGatewayCommandFences(config: UnknownRecord): boolean {
  let changed = false;
  const gateway = asRecord(config.gateway);
  if (deleteWhenExactly(gateway, "terminal", { enabled: false })) {
    gateway!.terminal = { enabled: true };
    changed = true;
  }
  const commands = asRecord(config.commands);
  for (const command of ["bash", "config", "mcp", "plugins", "debug"]) {
    changed = deleteWhenExactly(commands, command, false) || changed;
  }
  return changed;
}

function liftAutomationFences(config: UnknownRecord): boolean {
  let changed = deleteWhenExactly(asRecord(config.cron), "triggers", { enabled: false });
  deleteWhenEmpty(config, "cron");
  const skills = asRecord(config.skills);
  changed = deleteWhenExactly(skills, "load", {}) || changed;
  changed = deleteWhenExactly(skills, "workshop", {
    autonomous: { mode: "off" },
    approvalPolicy: "pending",
    allowSymlinkTargetWrites: false,
  }) || changed;
  deleteWhenEmpty(config, "skills");
  return changed;
}

function liftCodexGate(config: UnknownRecord): boolean {
  const plugins = asRecord(config.plugins);
  const entries = asRecord(plugins?.entries);
  let changed = false;
  if (deleteWhenExactly(entries, "codex", {
    enabled: false,
    config: { appServer: { sandbox: "workspace-write", approvalPolicy: "never" } },
  })) {
    entries!.codex = { enabled: true };
    changed = true;
  }
  if (plugins && Array.isArray(plugins.allow) && !plugins.allow.includes("codex") &&
      asRecord(entries?.codex)?.enabled === true) {
    plugins.allow = [...plugins.allow, "codex"];
    changed = true;
  }
  return changed;
}

// One-time roll-forward for durable user configs seeded before user
// gateways ran at full power. The owner's agent and project agents drop any
// tools block carrying the shared host-code fence (deny exec+process with
// workspaceOnly or exec.mode=deny), including a User-authored one of that
// shape; that whole-block check runs before the field-level agent lift strips
// its signature. Every other removal matches the exact shape the platform stamped.
export function liftPlatformHostCodeLockdown(
  config: UnknownRecord,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const changes = [
    liftHostCodeToolFences(asRecord(config.tools)),
    liftUserAgentToolFences(config, env),
    liftUserDefaultAgentToolFences(config, env),
    liftGatewayCommandFences(config),
    liftAutomationFences(config),
    liftCodexGate(config),
  ];
  return changes.includes(true);
}

const ISOLATED_BROWSER_DEFAULTS: Readonly<UnknownRecord> = {
  enabled: true,
  defaultProfile: "openclaw",
  headless: true,
  noSandbox: true,
  evaluateEnabled: true,
  executablePath: "/usr/bin/chromium",
};

function stringListIncludes(value: unknown, item: string): boolean {
  return Array.isArray(value) && value.includes(item);
}

function addStringListItem(record: UnknownRecord, key: string, item: string): boolean {
  const current = record[key];
  if (Array.isArray(current)) {
    if (current.includes(item)) return false;
    record[key] = [...current, item];
    return true;
  }
  if (current !== undefined) return false;
  record[key] = [item];
  return true;
}

function isolatedBrowserExplicitlyDisabled(config: UnknownRecord): boolean {
  const browser = asRecord(config.browser);
  const tools = asRecord(config.tools);
  const plugins = asRecord(config.plugins);
  const browserPlugin = asRecord(asRecord(plugins?.entries)?.browser);
  return browser?.enabled === false ||
    plugins?.enabled === false ||
    browserPlugin?.enabled === false ||
    stringListIncludes(tools?.deny, "browser");
}

function enableIsolatedBrowser(config: UnknownRecord): boolean {
  if (isolatedBrowserExplicitlyDisabled(config)) return false;
  let changed = false;
  let browser = asRecord(config.browser);
  if (!browser) {
    browser = structuredClone(ISOLATED_BROWSER_DEFAULTS);
    config.browser = browser;
    changed = true;
  } else {
    for (const [key, value] of Object.entries(ISOLATED_BROWSER_DEFAULTS)) {
      if (browser[key] !== undefined) continue;
      browser[key] = value;
      changed = true;
    }
  }

  const tools = asRecord(config.tools) ?? {};
  if (!asRecord(config.tools)) config.tools = tools;
  changed = addStringListItem(tools, "alsoAllow", "browser") || changed;

  const plugins = asRecord(config.plugins) ?? {};
  if (!asRecord(config.plugins)) config.plugins = plugins;
  changed = addStringListItem(plugins, "allow", "browser") || changed;
  const entries = asRecord(plugins.entries) ?? {};
  if (!asRecord(plugins.entries)) plugins.entries = entries;
  const browserPlugin = asRecord(entries.browser);
  if (!browserPlugin) {
    entries.browser = { enabled: true };
    changed = true;
  } else if (browserPlugin.enabled === undefined) {
    browserPlugin.enabled = true;
    changed = true;
  }
  return changed;
}

async function ensureIdentityAndRepo(slug: string, log: (msg: string) => void): Promise<void> {
  const pubKey = generateUserSshKey(slug);
  await brokeredGitHost.registerKey(slug, pubKey);
  await brokeredGitHost.ensureOwner(slug);
  await brokeredGitHost.ensureRepo(slug, { kind: "system-config" });
  log(`[system_config] broker ensured Gitea user/org/${systemConfigRepoName()} for ${slug}`);
}

function retainedSeedGitStateMatches(repoDir: string, keyPath: string): boolean {
  if (gitExec(repoDir, ["ls-remote", "origin", MAIN_REF], keyPath) !== "") return false;
  const head = gitExec(repoDir, GIT_REV_PARSE_HEAD, keyPath);
  if (!head || !GIT_SHA_RE.test(head)) return false;
  if (gitExec(repoDir, ["symbolic-ref", "--short", "HEAD"], keyPath) !== "main") return false;
  if (gitExec(repoDir, ["rev-list", "--count", "HEAD"], keyPath) !== "1") return false;
  if (gitExec(repoDir, ["log", "-1", "--pretty=%s"], keyPath) !== "initial system_config openclaw template") {
    return false;
  }
  if (gitExec(repoDir, ["status", "--porcelain", "--", ...SYSTEM_CONFIG_PATHSPEC_ARGS], keyPath) !== "") {
    return false;
  }
  const tracked = gitExec(
    repoDir,
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"],
    keyPath,
  );
  const expected = [
    SYSTEM_CONFIG_GITIGNORE_FILENAME,
    SYSTEM_CONFIG_METADATA_FILENAME,
    OPENCLAW_CONFIG_FILENAME,
  ].sort().join("\n");
  return tracked !== null && tracked.split("\n").sort().join("\n") === expected;
}

function seedConfigContents(templatePath: string, env: NodeJS.ProcessEnv): string {
  const template = fs.readFileSync(templatePath, "utf-8");
  const value = JSON.parse(template) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return template.endsWith("\n") ? template : `${template}\n`;
  }
  reconcilePlatformInvariants(value as UnknownRecord, env);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function retainedSeedFilesMatch(
  repoDir: string,
  templatePath: string,
  env: NodeJS.ProcessEnv,
): boolean {
  try {
    const configContents = fs.readFileSync(path.join(repoDir, OPENCLAW_CONFIG_FILENAME), "utf8");
    const config = JSON.parse(configContents);
    if (!asRecord(config)) return false;
    if (configContents !== seedConfigContents(templatePath, env)) return false;
    const metadata = readSystemConfigMetadata(path.join(repoDir, SYSTEM_CONFIG_METADATA_FILENAME));
    return metadata?.schemaVersion === CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION &&
      metadata.lastMigration === "initial" &&
      fs.readFileSync(path.join(repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), "utf8") ===
        SYSTEM_CONFIG_GITIGNORE;
  } catch {
    return false;
  }
}

function retryRetainedInitialSeedPush(
  slug: string,
  repoDir: string,
  templatePath: string,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void,
): boolean {
  const keyPath = userSshKeyPath(slug);
  if (!retainedSeedGitStateMatches(repoDir, keyPath)) return false;
  if (!retainedSeedFilesMatch(repoDir, templatePath, env)) return false;
  if (gitExec(repoDir, ["push", "-u", "origin", "main"], keyPath) === null) {
    log(`[system_config] retained initial push retry failed for ${slug}/${systemConfigRepoName()}`);
    return false;
  }
  log(`[system_config] recovered retained initial commit for ${slug}/${systemConfigRepoName()}`);
  return true;
}

function restoreIsolatedRuntimeProjection(
  slug: string, dir: string, env: NodeJS.ProcessEnv, sshKey: string, log: (msg: string) => void,
): boolean {
  if (!isIsolatedGatewayClassValue(env.GATEWAY_CLASS) || userClaimSlug(env) !== slug ||
      !isSystemConfigRuntimeProjection(path.dirname(dir), slug)) return true;
  if (gitExec(dir, ["merge-base", "--is-ancestor", "HEAD", "origin/main"], sshKey) === null ||
      gitExec(dir, ["restore", "--source=HEAD", "--staged", "--worktree", "--", OPENCLAW_CONFIG_FILENAME, SYSTEM_CONFIG_METADATA_FILENAME], sshKey) === null) {
    log(`[system_config] could not restore accepted config over runtime projection for ${slug}`);
    return false;
  }
  return true;
}

function refreshSystemConfigRepo(
  slug: string, dir: string, templatePath: string, env: NodeJS.ProcessEnv, log: (msg: string) => void,
): boolean {
  setRepoSshCommand(dir, slug);
  const sshKey = userSshKeyPath(slug);
  if (gitExec(dir, ["fetch", "origin", "main"], sshKey) === null) {
    if (retryRetainedInitialSeedPush(slug, dir, templatePath, env, log)) return true;
    if (
      gitExec(dir, ["ls-remote", "origin", MAIN_REF], sshKey) === "" &&
      gitExec(dir, ["rev-parse", "--verify", "HEAD"], sshKey) === null
    ) {
      return true;
    }
    log(`[system_config] fetch failed for ${slug}/${systemConfigRepoName()}`);
    return false;
  }
  if (!restoreIsolatedRuntimeProjection(slug, dir, env, sshKey, log)) return false;
  if (gitExec(dir, ["merge", "--ff-only", "origin/main"], sshKey) === null) {
    log(`[system_config] reused checkout is not a fast-forward for ${slug}/${systemConfigRepoName()}`);
    return false;
  }
  return true;
}

function cloneOrReuseSystemConfigRepo(
  slug: string,
  dir: string,
  templatePath: string,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void,
): boolean {
  if (fs.existsSync(path.join(dir, ".git"))) {
    return refreshSystemConfigRepo(slug, dir, templatePath, env, log);
  }
  if (fs.existsSync(dir)) {
    log(`[system_config] ${dir} exists but is not a git repo; leaving it untouched`);
    return false;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const sshKey = userSshKeyPath(slug);
  const result = gitExec(path.dirname(dir), ["clone", remoteUrl(slug), path.basename(dir)], sshKey);
  if (result === null) {
    log(`[system_config] clone failed for ${slug}/${systemConfigRepoName()}`);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      log(`[system_config] failed to remove partial checkout ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
  gitExec(dir, ["config", "user.email", `${slug}@octogee.com`]);
  gitExec(dir, ["config", "user.name", `Octo (${slug})`]);
  setRepoSshCommand(dir, slug);
  log(`[system_config] cloned ${slug}/${systemConfigRepoName()} -> ${dir}`);
  return true;
}

const LEGACY_IMPLICIT_AGENT_ID = "main";

type RosterEntry = { id: string; entry: UnknownRecord };

function readRosterEntries(agents: UnknownRecord): { form: "entries" | "list"; roster: RosterEntry[] } {
  const entries = asRecord(agents.entries);
  if (entries) {
    return {
      form: "entries",
      roster: Object.entries(entries).map(([id, entry]) => ({ id, entry: { ...(asRecord(entry) ?? {}) } })),
    };
  }
  const list = Array.isArray(agents.list) ? agents.list : [];
  const roster = list.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    const { id, ...rest } = record;
    return typeof id === "string" && id ? [{ id, entry: rest }] : [];
  });
  return { form: roster.length > 0 ? "list" : "entries", roster };
}

function writeRosterEntries(agents: UnknownRecord, form: "entries" | "list", roster: RosterEntry[]): void {
  if (form === "list") {
    delete agents.entries;
    agents.list = roster.map(({ id, entry }) => ({ id, ...entry }));
    return;
  }
  delete agents.list;
  agents.entries = Object.fromEntries(roster.map(({ id, entry }) => [id, entry]));
}

function repointAgentDefault(holder: UnknownRecord, key: string, from: string, to: string): boolean {
  const target = asRecord(holder[key]);
  if (!target || target.agentId !== from) return false;
  target.agentId = to;
  return true;
}

// OpenClaw materializes its implicit `main` agent the first time a roster-less
// config gains an explicit roster, and the hello's default agent is the first
// roster entry. A fresh user therefore boots with its agent already first and
// the model-less anchor last, so Model Setup never sees `main`. A rostered config
// without its agent was detached by a return: OpenClaw fences that agent id until
// the import's agents.create claims it, so the restore never re-declares it.
export function ensureUserRosterLeadsWithDefaultAgent(config: UnknownRecord, slug: string): boolean {
  const agents = asRecord(config.agents) ?? {};
  config.agents = agents;
  const userDefaultAgentId = workspaceDefaultAgentId(slug);
  const { form, roster } = readRosterEntries(agents);
  const before = JSON.stringify({ ownership: agents.ownership, ids: roster.map((item) => item.id) });

  const kept = roster.filter((item) => item.id !== LEGACY_IMPLICIT_AGENT_ID);
  const defaultAgent = kept.find((item) => item.id === userDefaultAgentId) ?? (kept.length === 0 ? seedUserDefaultAgent(slug, userDefaultAgentId) : undefined);
  if (defaultAgent && defaultAgent.entry.model === undefined) defaultAgent.entry.model = DEFAULT_USER_AGENT_MODEL_REF;
  const { id: _anchorId, ...anchorSeed } = buildSafeDefaultAgent();
  const anchor = kept.find((item) => item.id === SAFE_DEFAULT_AGENT_ID) ?? { id: SAFE_DEFAULT_AGENT_ID, entry: anchorSeed };
  const others = kept.filter((item) => item.id !== userDefaultAgentId && item.id !== SAFE_DEFAULT_AGENT_ID);
  const ordered = [...(defaultAgent ? [defaultAgent] : []), ...others, anchor];
  writeRosterEntries(agents, form, ordered);
  agents.ownership = "explicit";
  const defaultsChanged = reconcileUserRosterDefaults(config, agents, defaultAgent ? userDefaultAgentId : SAFE_DEFAULT_AGENT_ID);

  const after = JSON.stringify({ ownership: agents.ownership, ids: ordered.map((item) => item.id) });
  return before !== after || defaultsChanged;
}

function seedUserDefaultAgent(slug: string, userDefaultAgentId: string): RosterEntry {
  return {
    id: userDefaultAgentId,
    entry: {
      workspace: path.join(CUSTOMERS_DIR, slug),
      agentDir: path.join(AGENTS_DIR, userDefaultAgentId, "agent"),
      model: DEFAULT_USER_AGENT_MODEL_REF,
    },
  };
}

function reconcileUserRosterDefaults(config: UnknownRecord, agents: UnknownRecord, defaultAgentId: string): boolean {
  const defaults = asRecord(agents.defaults) ?? {};
  agents.defaults = defaults;
  let changed = false;
  if (asRecord(defaults.authInheritance)?.agentId !== SAFE_DEFAULT_AGENT_ID) {
    defaults.authInheritance = { agentId: SAFE_DEFAULT_AGENT_ID };
    changed = true;
  }
  const systemAgent = asRecord(defaults.systemAgent) ?? {};
  if (defaultAgentId !== SAFE_DEFAULT_AGENT_ID && systemAgent.agentId !== defaultAgentId) {
    defaults.systemAgent = { ...systemAgent, agentId: defaultAgentId };
    changed = true;
  }
  return repointAgentDefault(config, "talk", LEGACY_IMPLICIT_AGENT_ID, defaultAgentId) || changed;
}

function ensureUserRosterAtPath(configPath: string, slug: string, log: (msg: string) => void): void {
  const contents = fs.readFileSync(configPath, "utf8");
  const value = readTrackedConfigObject(contents);
  if (!value) return;
  if (!ensureUserRosterLeadsWithDefaultAgent(value, slug)) return;
  atomicWrite(configPath, `${JSON.stringify(value, null, 2)}\n`);
  log(`[system_config] User roster now leads with ${workspaceDefaultAgentId(slug)} and keeps ${SAFE_DEFAULT_AGENT_ID} last`);
}

const PLATFORM_DRIVEN_CHECKPOINT_SOURCES: ReadonlySet<SystemConfigCommitSource> = new Set([
  "migration-checkpoint",
  "migration-restore",
  "boot-migration",
  "recovery",
]);

function platformDrivenCheckpoint(context: Pick<SystemConfigSyncContext, "opts">): boolean {
  return context.opts.durablePolicy === true &&
    PLATFORM_DRIVEN_CHECKPOINT_SOURCES.has(context.opts.source ?? "auto-watch");
}

export function reconcilePlatformProjectionsAtPath(
  context: Pick<SystemConfigSyncContext, "repoConfigPath" | "env" | "slug" | "log">,
  readConfig: (configPath: string) => string = (configPath) => fs.readFileSync(configPath, "utf8"),
): void {
  let contents: string;
  let value: unknown;
  try {
    contents = readConfig(context.repoConfigPath);
    value = JSON.parse(contents);
  } catch {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { changedPaths } = reconcilePlatformProjections(value as UnknownRecord, context.env);
  if (changedPaths.length === 0) return;
  if (readConfig(context.repoConfigPath) !== contents) {
    context.log(
      `[system_config] ${context.slug}: skipped projection reconcile — config changed while reconciling (${changedPaths.join(", ")})`,
    );
    return;
  }
  atomicWrite(context.repoConfigPath, `${JSON.stringify(value, null, 2)}\n`);
  context.log(
    `[system_config] ${context.slug}: reconciled platform-owned projections before checkpoint (${changedPaths.join(", ")})`,
  );
}

function reconcilePlatformInvariantsAtPath(configPath: string, env: NodeJS.ProcessEnv): void {
  const contents = fs.readFileSync(configPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  reconcilePlatformInvariants(value as UnknownRecord, env);
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (next !== contents) atomicWrite(configPath, next);
}

function seedSystemConfigIfMissing(
  slug: string,
  repoDir: string,
  templatePath: string,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void,
): boolean {
  const configPath = path.join(repoDir, OPENCLAW_CONFIG_FILENAME);
  if (gitExec(repoDir, ["symbolic-ref", "HEAD", MAIN_REF]) === null) {
    throw new Error(`[system_config] initial branch selection failed for ${slug}`);
  }
  fs.writeFileSync(configPath, seedConfigContents(templatePath, env), { encoding: "utf-8", flag: "wx", mode: 0o600 });
  atomicWrite(path.join(repoDir, SYSTEM_CONFIG_METADATA_FILENAME), `${JSON.stringify({
    schemaVersion: CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION,
    lastMigration: "initial",
  }, null, 2)}\n`);
  ensureSystemConfigGitignore(repoDir);
  const staged = gitExec(repoDir, ["add", ...SYSTEM_CONFIG_PATHSPEC_ARGS]);
  if (staged === null) {
    throw new Error(`[system_config] initial stage failed for ${slug}`);
  }
  const committed = gitExec(repoDir, ["commit", "-m", "initial system_config openclaw template"]);
  if (committed === null) {
    throw new Error(`[system_config] initial commit failed for ${slug}`);
  }
  const pushed = gitExec(repoDir, ["push", "-u", "origin", "main"], userSshKeyPath(slug));
  if (pushed === null) {
    throw new Error(`[system_config] initial push failed for ${slug}`);
  }
  log(`[system_config] seeded ${slug}/${systemConfigRepoName()} with openclaw.json template`);
  return true;
}

function repositoryHasHead(slug: string, repoDir: string): boolean {
  return gitExec(
    repoDir,
    ["rev-parse", "--verify", "HEAD"],
    userSshKeyPath(slug),
  ) !== null;
}

function recoverRestoredSystemConfig(
  slug: string,
  openclawDir: string,
  repoDir: string,
  env: NodeJS.ProcessEnv,
  opts: SystemConfigRestoreOptions,
): SystemConfigRecoveryResult {
  return (opts.recover ?? recoverSystemConfigHead)({
    slug,
    openclawDir,
    repoDir,
    configPath: path.join(repoDir, OPENCLAW_CONFIG_FILENAME),
    env,
    validateConfig: opts.validateConfig ?? acceptRuntimeManagedConfig,
  });
}

export function extractLegacyMattermostAccountSecrets(config: UnknownRecord): Record<string, string> {
  const accounts = asRecord(asRecord(asRecord(config.channels)?.mattermost)?.accounts);
  if (!accounts) return {};
  const secrets: Record<string, string> = {};
  for (const [accountId, value] of Object.entries(accounts)) {
    const account = asRecord(value);
    if (
      !account ||
      typeof account.botToken !== "string" ||
      account.botToken.length === 0 ||
      account.botToken === "${MM_BOT_TOKEN}"
    ) continue;
    secrets[accountId] = account.botToken;
    account.botToken = mattermostAccountSecretRef(accountId);
  }
  return secrets;
}

function trackedSchemaVersion(metadata: UnknownRecord | undefined): number | undefined {
  const schemaVersion = metadata?.schemaVersion;
  if (schemaVersion === undefined) return undefined;
  if (!Number.isInteger(schemaVersion) || (schemaVersion as number) < 0 ||
      (schemaVersion as number) > CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION) {
    throw new Error(`[system_config] unsupported schemaVersion ${String(schemaVersion)}`);
  }
  return schemaVersion as number;
}

function ensureSystemConfigGitignore(repoDir: string): void {
  const gitignorePath = path.join(repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME);
  try { fs.writeFileSync(gitignorePath, SYSTEM_CONFIG_GITIGNORE, { encoding: "utf-8", flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

function readTrackedConfigObject(contents: string): UnknownRecord | null {
  try {
    const parsed = JSON.parse(contents) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as UnknownRecord
      : null;
  } catch {
    return null;
  }
}

async function reconcileTrackedOpenClawConfig(
  repoConfigPath: string,
  openclawDir: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const repoDir = path.dirname(repoConfigPath);
  const metadataPath = path.join(repoDir, SYSTEM_CONFIG_METADATA_FILENAME);
  const metadata = readSystemConfigMetadata(metadataPath);
  const schemaVersion = trackedSchemaVersion(metadata);
  if (schemaVersion === CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION) {
    ensureSystemConfigGitignore(repoDir);
    return false;
  }
  const before = fs.readFileSync(repoConfigPath, "utf-8");
  const tracked = readTrackedConfigObject(before);
  if (!tracked) return false;

  const macLaneRemoved = schemaVersion !== undefined &&
    schemaVersion >= SYSTEM_CONFIG_SCHEMA_VERSION_MAC_LANE_REMOVED;
  const hostCodeLockdownLifted = schemaVersion !== undefined &&
    schemaVersion >= SYSTEM_CONFIG_SCHEMA_VERSION_HOST_CODE_LOCKDOWN_LIFTED;
  const userAgentSharedFenceLifted = schemaVersion !== undefined &&
    schemaVersion >= SYSTEM_CONFIG_SCHEMA_VERSION_USER_AGENT_SHARED_FENCE_LIFTED;
  if (!macLaneRemoved) {
    removeLegacyMacConfig(tracked, env);
    const secrets = extractLegacyMattermostAccountSecrets(tracked);
    if (Object.keys(secrets).length > 0) await updateMattermostAccountSecrets(openclawDir, { set: secrets });
  }
  if (!hostCodeLockdownLifted) liftPlatformHostCodeLockdown(tracked, env);
  if (!userAgentSharedFenceLifted) liftUserAgentToolFences(tracked, env);
  enableIsolatedBrowser(tracked);
  const after = `${JSON.stringify(tracked, null, 2)}\n`;
  if (after !== before) atomicWrite(repoConfigPath, after);
  const keepPendingCleanup = !macLaneRemoved || metadata?.pendingStateCleanup !== undefined;
  atomicWrite(metadataPath, `${JSON.stringify({
    schemaVersion: CURRENT_SYSTEM_CONFIG_SCHEMA_VERSION,
    lastMigration: "lift-builder-agent-shared-host-code-fence",
    ...(keepPendingCleanup ? { pendingStateCleanup: SYSTEM_CONFIG_LEGACY_MAC_STATE_CLEANUP } : {}),
  }, null, 2)}\n`);
  ensureSystemConfigGitignore(repoDir);
  return true;
}

export async function reconcileSystemConfigSchema(
  openclawDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return reconcileTrackedOpenClawConfig(
    systemConfigPath(openclawDir),
    openclawDir,
    env,
  );
}

// Durable system_config exists only for isolated gateways, whose seed is the
// full-power user template; the shared template remains the explicit
// override for tooling that seeds a shared-gateway-shaped config on purpose.
export function defaultSystemConfigTemplatePath(env: NodeJS.ProcessEnv = process.env): string {
  const gatewayDir = path.join(TEMPLATES_DIR, "..", "gateway");
  return isIsolatedGatewayClassValue(env.GATEWAY_CLASS)
    ? path.join(gatewayDir, "openclaw.isolated.template.json")
    : path.join(gatewayDir, "openclaw.template.json");
}

export async function restoreSystemConfigForSlug(
  slug: string,
  opts: SystemConfigRestoreOptions = {},
): Promise<SystemConfigRestoreResult> {
  const log = opts.log ?? defaultLog;
  if (!isValidUsername(slug)) {
    return { skipped: "invalid-builder-slug", seeded: false, restored: false };
  }

  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  const result = await restoreSystemConfigCheckout(slug, systemConfigDir(openclawDir), openclawDir, opts, log);
  if (result.restored) log(`[system_config] active openclaw.json is ${slug}/${systemConfigRepoName()}/openclaw.json`);
  return result;
}

async function restoreSystemConfigCheckout(
  slug: string,
  repoDir: string,
  openclawDir: string,
  opts: SystemConfigRestoreOptions,
  log: (msg: string) => void,
): Promise<SystemConfigRestoreResult> {
  const env = opts.env ?? process.env;
  const templatePath = opts.templatePath ?? defaultSystemConfigTemplatePath(env);

  await ensureIdentityAndRepo(slug, log);
  if (!cloneOrReuseSystemConfigRepo(slug, repoDir, templatePath, env, log)) {
    return { skipped: "checkout-unavailable", seeded: false, restored: false };
  }

  const configPath = path.join(repoDir, OPENCLAW_CONFIG_FILENAME);
  let seeded = false;
  if (!fs.existsSync(configPath)) {
    if (repositoryHasHead(slug, repoDir)) {
      const recovery = recoverRestoredSystemConfig(slug, openclawDir, repoDir, env, opts);
      if (recovery.outcome === "unavailable") {
        return { skipped: "accepted-head-unavailable", seeded: false, restored: false };
      }
    } else {
      seeded = seedSystemConfigIfMissing(slug, repoDir, templatePath, env, log);
    }
  }
  try {
    await reconcileTrackedOpenClawConfig(configPath, openclawDir, env);
  } catch (error) {
    log(`[system_config] schema reconciliation deferred to accepted-head recovery: ${error instanceof Error ? error.message : String(error)}`);
    const recovery = recoverRestoredSystemConfig(slug, openclawDir, repoDir, env, opts);
    if (recovery.outcome === "unavailable") {
      return { skipped: "accepted-head-unavailable", seeded: false, restored: false };
    }
    await reconcileTrackedOpenClawConfig(configPath, openclawDir, env);
  }
  if (isIsolatedGatewayClassValue(env.GATEWAY_CLASS)) ensureUserRosterAtPath(configPath, slug, log);
  reconcilePlatformInvariantsAtPath(configPath, env);
  return { seeded, restored: true, configPath };
}

export function acquireSystemConfigSyncLock(openclawDir: string): (() => void) | null {
  const lease = acquireSystemConfigSyncLeaseSync({ openclawDir });
  return lease ? () => lease.release() : null;
}

function remoteHeadFromLsRemote(output: string | null): string | null {
  if (output === null) return null;
  const head = output.trim().split(/\s+/)[0] ?? "";
  return GIT_SHA_RE.test(head) ? head : null;
}

export function readDurableSystemConfigHeadForSlug(
  slug: string,
  opts: {
    openclawDir?: string;
    gitExec?: typeof gitExec;
    userSshKeyPath?: typeof userSshKeyPath;
  } = {},
): string {
  if (!isValidUsername(slug)) {
    throw new Error(`invalid user slug: ${slug}`);
  }
  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  const execGit = opts.gitExec ?? gitExec;
  const keyPath = (opts.userSshKeyPath ?? userSshKeyPath)(slug);
  const head = remoteHeadFromLsRemote(
    execGit(
      openclawDir,
      ["ls-remote", remoteUrl(slug), MAIN_REF],
      keyPath,
    ),
  );
  if (!head) {
    throw new Error(`durable system config head unavailable for ${slug}`);
  }
  return head;
}

function inspectRemoteRelation(
  repoDir: string,
  keyPath: string,
  execGit: typeof gitExec,
): { relation: "equal" | "local-ahead" | "conflict" | "unavailable"; head?: string; remoteHead?: string } {
  const head = execGit(repoDir, GIT_REV_PARSE_HEAD, keyPath);
  const remoteHead = remoteHeadFromLsRemote(
    execGit(repoDir, ["ls-remote", "origin", MAIN_REF], keyPath),
  );
  if (!head || !GIT_SHA_RE.test(head) || !remoteHead) return { relation: "unavailable" };
  if (head === remoteHead) return { relation: "equal", head, remoteHead };
  const mergeBase = execGit(repoDir, ["merge-base", head, remoteHead], keyPath);
  if (mergeBase === remoteHead) return { relation: "local-ahead", head, remoteHead };
  return { relation: "conflict", head, remoteHead };
}

function recordSyncError(
  openclawDir: string,
  errorCode: string,
  now: () => Date,
  patch: { rejected?: boolean } = {},
): void {
  const current = readSystemConfigStatus(openclawDir);
  const at = now().toISOString();
  updateSystemConfigStatus(openclawDir, {
    state: "error",
    dirtySince: current.dirtySince ?? at,
    lastErrorCode: errorCode,
    lastErrorAt: at,
    ...(patch.rejected ? { rejectedCount: (current.rejectedCount ?? 0) + 1 } : {}),
  }, now);
}

function recordSyncSuccess(
  openclawDir: string,
  acceptedCommit: string,
  configHash: string,
  env: NodeJS.ProcessEnv,
  now: () => Date,
): void {
  updateSystemConfigStatus(openclawDir, {
    state: "clean",
    acceptedCommit,
    configHash: `sha256:${configHash}`,
    dirtySince: null,
    lastSyncedAt: now().toISOString(),
    lastErrorCode: null,
    lastErrorAt: null,
    openclawVersion: env.OPENCLAW_VERSION?.trim() || "unknown",
    watcherState: "running",
  }, now);
}

interface SystemConfigSyncContext {
  slug: string;
  opts: SystemConfigSyncOptions;
  pushWhenClean: boolean;
  log: (message: string) => void;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  openclawDir: string;
  repoDir: string;
  repoConfigPath: string;
  initialFingerprint: string;
  execGit: typeof gitExec;
  keyPath: string;
}

// Converge a remote-ahead checkout by rebasing onto origin/main. The remote is
// the durable source of truth (GATEWAY-SIMPLE-ROLL-SPEC): during a surge roll
// the predecessor pod's final flush can land after this pod cloned, and this
// pull is what absorbs it. A true content conflict aborts the rebase and leaves
// the checkout untouched for the typed non-fast-forward error path.
function pullRebaseRemote(context: SystemConfigSyncContext): boolean {
  const pulled = context.execGit(context.repoDir, ["pull", "--rebase", "origin", "main"], context.keyPath);
  if (pulled !== null) return true;
  context.execGit(context.repoDir, ["rebase", "--abort"], context.keyPath);
  context.log(
    `[system_config] ${context.slug}: pull --rebase could not converge with origin/main`,
  );
  return false;
}

function syncStatusFailure(context: SystemConfigSyncContext): SystemConfigSyncResult {
  if (context.opts.durablePolicy) {
    recordSyncError(context.openclawDir, "status-check-failed", context.now);
  }
  context.log(`[system_config] ${context.slug}: prestop status check failed`);
  return {
    skipped: "status-failed",
    committed: false,
    pushed: false,
    ...(context.opts.durablePolicy ? { errorCode: "status-check-failed" } : {}),
    ...(context.pushWhenClean ? {
      pending: true,
      processedFingerprint: context.initialFingerprint,
    } : {}),
  };
}

function syncCleanSystemConfig(context: SystemConfigSyncContext): SystemConfigSyncResult {
  if (!context.pushWhenClean) {
    context.log(`[system_config] ${context.slug}: no openclaw.json changes to flush`);
    return { committed: false, pushed: false };
  }
  let pushed = context.execGit(context.repoDir, ["push", "origin", "main"], context.keyPath);
  if (pushed === null && pullRebaseRemote(context)) {
    pushed = context.execGit(context.repoDir, ["push", "origin", "main"], context.keyPath);
  }
  if (pushed === null) {
    if (context.opts.durablePolicy) {
      recordSyncError(context.openclawDir, "push-failed", context.now);
    }
    context.log(`[system_config] ${context.slug}: pending push retry failed`);
    return {
      committed: false,
      pushed: false,
      pending: true,
      ...(context.opts.durablePolicy ? { errorCode: "push-failed" } : {}),
      processedFingerprint: context.initialFingerprint,
    };
  }
  // The heal pull may have fast-forwarded openclaw.json — fingerprint the
  // content that is actually accepted now, not the pre-pull snapshot.
  const acceptedFingerprint = systemConfigFingerprint(context.repoConfigPath);
  const acceptedCommit = context.execGit(context.repoDir, GIT_REV_PARSE_HEAD, context.keyPath);
  if (context.opts.durablePolicy && (!acceptedCommit || !GIT_SHA_RE.test(acceptedCommit))) {
    recordSyncError(context.openclawDir, ACCEPTED_HEAD_UNAVAILABLE, context.now);
    return {
      committed: false,
      pushed: true,
      pending: true,
      errorCode: ACCEPTED_HEAD_UNAVAILABLE,
      processedFingerprint: acceptedFingerprint,
    };
  }
  if (context.opts.durablePolicy && acceptedCommit && GIT_SHA_RE.test(acceptedCommit)) {
    recordSyncSuccess(
      context.openclawDir,
      acceptedCommit,
      acceptedFingerprint,
      context.env,
      context.now,
    );
  }
  return {
    committed: false,
    pushed: true,
    pending: false,
    processedFingerprint: acceptedFingerprint,
    ...(acceptedCommit && GIT_SHA_RE.test(acceptedCommit) ? {
      acceptedCommit,
      configHash: acceptedFingerprint,
    } : {}),
  };
}

type CandidateValidationResult =
  | { validatedFingerprint: string; validatedDurableFingerprint: string }
  | { result: SystemConfigSyncResult };

function durableFilesFingerprint(repoDir: string): string {
  const hash = createHash("sha256");
  for (const filename of [
    OPENCLAW_CONFIG_FILENAME,
    SYSTEM_CONFIG_METADATA_FILENAME,
    SYSTEM_CONFIG_GITIGNORE_FILENAME,
  ]) {
    hash.update(filename);
    const filePath = path.join(repoDir, filename);
    if (fs.existsSync(filePath)) hash.update(fs.readFileSync(filePath));
    else hash.update("<missing>");
  }
  return hash.digest("hex");
}

function durableDirtyPaths(status: string): Set<string> {
  return new Set(status.split("\n").map((line) => line.trim().slice(2).trim()).filter(Boolean));
}

type AcceptedDurableSet = ReadonlyMap<SystemConfigDurableFilename, Buffer>;

function acceptedCommitBlobReader(context: SystemConfigSyncContext): ReadSystemConfigCommitBlob {
  return context.opts.readCommitBlob ??
    (context.opts.gitExec
      ? ((_repoDir, commit, filename) => {
          const contents = context.execGit(
            context.repoDir,
            ["show", `${commit}:${filename}`],
            context.keyPath,
          );
          return contents === null ? null : Buffer.from(contents);
        })
      : readSystemConfigCommitBlob);
}

function loadAcceptedDurableSet(context: SystemConfigSyncContext): AcceptedDurableSet | null {
  const readBlob = acceptedCommitBlobReader(context);
  const accepted = new Map<SystemConfigDurableFilename, Buffer>();
  for (const filename of SYSTEM_CONFIG_DURABLE_FILENAMES) {
    const contents = readBlob(context.repoDir, "HEAD", filename);
    if (contents === null) return null;
    accepted.set(filename, contents);
  }
  return accepted;
}

function writeAcceptedDirtyFiles(
  context: SystemConfigSyncContext,
  dirtyPaths: ReadonlySet<string>,
  accepted: AcceptedDurableSet,
): boolean {
  for (const filename of SYSTEM_CONFIG_DURABLE_FILENAMES) {
    if (!dirtyPaths.has(filename)) continue;
    const contents = accepted.get(filename);
    if (!contents) return false;
    atomicWrite(path.join(context.repoDir, filename), contents);
  }
  return true;
}

function rejectedDeletionResult(context: SystemConfigSyncContext): SystemConfigSyncResult {
  const durablePaths = new Set([
    OPENCLAW_CONFIG_FILENAME,
    SYSTEM_CONFIG_METADATA_FILENAME,
    SYSTEM_CONFIG_GITIGNORE_FILENAME,
  ]);
  const deletedDurableFingerprint = durableFilesFingerprint(context.repoDir);
  const accepted = loadAcceptedDurableSet(context);
  if (durableFilesFingerprint(context.repoDir) !== deletedDurableFingerprint) {
    return changedRejectedCandidateResult(
      context,
      "openclaw-json-missing",
      undefined,
      context.initialFingerprint,
    );
  }
  if (accepted === null || !writeAcceptedDirtyFiles(context, durablePaths, accepted)) {
    recordSyncError(context.openclawDir, VALIDATION_RESTORE_FAILED, context.now, {
      rejected: true,
    });
    context.log(`[system_config] ${context.slug}: deleted config restore failed`);
    return {
      skipped: VALIDATION_RESTORE_FAILED,
      committed: false,
      pushed: false,
      rejected: true,
      errorCode: VALIDATION_RESTORE_FAILED,
    };
  }
  recordSyncError(context.openclawDir, "openclaw-json-missing", context.now, {
    rejected: true,
  });
  context.log(`[system_config] ${context.slug}: rejected config deletion and restored accepted durable set`);
  return {
    committed: false,
    pushed: false,
    rejected: true,
    errorCode: "openclaw-json-missing",
    processedFingerprint: systemConfigFingerprint(context.repoConfigPath),
  };
}

interface RejectedCandidateContext {
  context: SystemConfigSyncContext;
  candidateContents: Buffer;
  candidateFingerprint: string;
  candidateDurableFingerprint: string;
  dirtyPaths: ReadonlySet<string>;
  error: unknown;
}

function changedRejectedCandidateResult(
  context: SystemConfigSyncContext,
  errorCode: string,
  policyPaths: string[] | undefined,
  candidateFingerprint: string,
): SystemConfigSyncResult {
  recordSyncError(context.openclawDir, errorCode, context.now, { rejected: true });
  context.log(`[system_config] ${context.slug}: rejected durable files changed before restore; scheduling another pass`);
  return {
    committed: false,
    pushed: false,
    pending: true,
    rejected: true,
    errorCode,
    ...(policyPaths ? { policyPaths } : {}),
    processedFingerprint: candidateFingerprint,
  };
}

function rejectedCandidateResult(input: RejectedCandidateContext): SystemConfigSyncResult {
  const {
    context,
    candidateContents,
    candidateFingerprint,
    candidateDurableFingerprint,
    dirtyPaths,
    error,
  } = input;
  const stamp = context.now().toISOString().replace(/[:.]/g, "-");
  const rejectedDir = path.join(context.openclawDir, "rejected_config");
  fs.mkdirSync(rejectedDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(rejectedDir, `openclaw.${stamp}.json`), candidateContents, {
    mode: 0o600,
  });
  const errorCode = error instanceof PlatformInvariantPolicyError
    ? error.code
    : "validation-failed";
  const policyPaths = error instanceof PlatformInvariantPolicyError ? error.paths : undefined;
  if (durableFilesFingerprint(context.repoDir) !== candidateDurableFingerprint) {
    return changedRejectedCandidateResult(
      context,
      errorCode,
      policyPaths,
      candidateFingerprint,
    );
  }
  const accepted = loadAcceptedDurableSet(context);
  if (durableFilesFingerprint(context.repoDir) !== candidateDurableFingerprint) {
    return changedRejectedCandidateResult(
      context,
      errorCode,
      policyPaths,
      candidateFingerprint,
    );
  }
  if (accepted === null || !writeAcceptedDirtyFiles(context, dirtyPaths, accepted)) {
    if (context.opts.durablePolicy) {
      recordSyncError(context.openclawDir, VALIDATION_RESTORE_FAILED, context.now, {
        rejected: true,
      });
    }
    context.log(`[system_config] ${context.slug}: validation failed and accepted config restore failed`);
    return {
      skipped: VALIDATION_RESTORE_FAILED,
      committed: false,
      pushed: false,
      rejected: true,
      errorCode: VALIDATION_RESTORE_FAILED,
    };
  }
  recordSyncError(context.openclawDir, errorCode, context.now, { rejected: true });
  const policySuffix = policyPaths ? `: ${policyPaths.join(", ")}` : "";
  context.log(`[system_config] ${context.slug}: rejected config restored (${errorCode}${policySuffix})`);
  return {
    committed: false,
    pushed: false,
    rejected: true,
    errorCode,
    ...(policyPaths ? { policyPaths } : {}),
    processedFingerprint: systemConfigFingerprint(context.repoConfigPath),
  };
}

function validateCandidate(
  context: SystemConfigSyncContext,
  dirtyPaths: ReadonlySet<string>,
): CandidateValidationResult {
  const candidateContents = fs.readFileSync(context.repoConfigPath);
  const candidateFingerprint = fingerprintContents(candidateContents);
  const candidateDurableFingerprint = durableFilesFingerprint(context.repoDir);
  try {
    const parsed = JSON.parse(candidateContents.toString("utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("openclaw.json must contain an object");
    }
    if (context.opts.durablePolicy) assertPlatformInvariants(parsed as UnknownRecord, context.env);
    if (dirtyPaths.has(SYSTEM_CONFIG_METADATA_FILENAME)) {
      assertSystemConfigMetadata(
        fs.readFileSync(path.join(context.repoDir, SYSTEM_CONFIG_METADATA_FILENAME), "utf8"),
      );
    }
    if (dirtyPaths.has(SYSTEM_CONFIG_GITIGNORE_FILENAME)) {
      assertSystemConfigGitignore(
        fs.readFileSync(path.join(context.repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), "utf8"),
      );
    }
    (context.opts.validateConfig ?? acceptRuntimeManagedConfig)(context.repoConfigPath);
    return {
      validatedFingerprint: systemConfigFingerprint(context.repoConfigPath),
      validatedDurableFingerprint: durableFilesFingerprint(context.repoDir),
    };
  } catch (error) {
    return {
      result: rejectedCandidateResult({
        context,
        candidateContents,
        candidateFingerprint,
        candidateDurableFingerprint,
        dirtyPaths,
        error,
      }),
    };
  }
}

function committedPushFailure(
  context: SystemConfigSyncContext,
  source: SystemConfigCommitSource,
  stagedFingerprint: string,
): SystemConfigSyncResult {
  if (context.opts.durablePolicy) {
    const afterFailure = inspectRemoteRelation(context.repoDir, context.keyPath, context.execGit);
    const errorCode = afterFailure.relation === "conflict"
      ? "non-fast-forward-conflict"
      : "push-failed";
    recordSyncError(context.openclawDir, errorCode, context.now);
    context.log(`[system_config] ${context.slug}: ${source} push failed (${errorCode})`);
    return {
      committed: true,
      pushed: false,
      pending: true,
      errorCode,
      ...(afterFailure.head ? { acceptedCommit: afterFailure.head } : {}),
      ...(context.pushWhenClean ? { processedFingerprint: stagedFingerprint } : {}),
    };
  }
  context.log(`[system_config] ${context.slug}: ${source} push failed`);
  return {
    committed: true,
    pushed: false,
    pending: true,
    ...(context.pushWhenClean ? { processedFingerprint: stagedFingerprint } : {}),
  };
}

// processedFingerprint stays the STAGED fingerprint deliberately: an edit that
// raced the commit leaves the live file differing from it, so the watcher's
// post-sync check schedules another pass instead of silently absorbing the
// edit. A heal-pull rebase that merged remote content converges the same way —
// the next pass finds a clean tree and records the post-pull content.
function committedPushSuccess(
  context: SystemConfigSyncContext,
  source: SystemConfigCommitSource,
  stagedFingerprint: string,
): SystemConfigSyncResult {
  const acceptedCommit = context.execGit(context.repoDir, GIT_REV_PARSE_HEAD, context.keyPath);
  if (context.opts.durablePolicy && (!acceptedCommit || !GIT_SHA_RE.test(acceptedCommit))) {
    recordSyncError(context.openclawDir, ACCEPTED_HEAD_UNAVAILABLE, context.now);
    return {
      committed: true,
      pushed: true,
      pending: true,
      errorCode: ACCEPTED_HEAD_UNAVAILABLE,
      ...(context.pushWhenClean ? { processedFingerprint: stagedFingerprint } : {}),
    };
  }
  if (context.opts.durablePolicy && acceptedCommit && GIT_SHA_RE.test(acceptedCommit)) {
    recordSyncSuccess(
      context.openclawDir,
      acceptedCommit,
      stagedFingerprint,
      context.env,
      context.now,
    );
  }
  context.log(`[system_config] ${context.slug}: ${source} pushed openclaw.json changes`);
  return {
    committed: true,
    pushed: true,
    ...(context.pushWhenClean ? { pending: false, processedFingerprint: stagedFingerprint } : {}),
    ...(acceptedCommit && GIT_SHA_RE.test(acceptedCommit) ? {
      acceptedCommit,
      configHash: stagedFingerprint,
    } : {}),
  };
}

function commitValidatedCandidate(
  context: SystemConfigSyncContext,
  validatedFingerprint: string,
  validatedDurableFingerprint: string,
): SystemConfigSyncResult {
  const staged = context.execGit(
    context.repoDir,
    ["add", ...SYSTEM_CONFIG_PATHSPEC_ARGS],
    context.keyPath,
  );
  if (staged === null) {
    if (context.opts.durablePolicy) {
      recordSyncError(context.openclawDir, "stage-failed", context.now);
    }
    context.log(`[system_config] ${context.slug}: staging openclaw.json failed`);
    return {
      skipped: "stage-failed",
      committed: false,
      pushed: false,
      ...(context.opts.durablePolicy ? { errorCode: "stage-failed" } : {}),
      ...(context.pushWhenClean ? {
        pending: true,
        processedFingerprint: validatedFingerprint,
      } : {}),
    };
  }
  const stagedFingerprint = systemConfigFingerprint(context.repoConfigPath);
  if (
    stagedFingerprint !== validatedFingerprint ||
    durableFilesFingerprint(context.repoDir) !== validatedDurableFingerprint
  ) {
    context.log(`[system_config] ${context.slug}: openclaw.json changed while staging; scheduling another pass`);
    return {
      committed: false,
      pushed: false,
      pending: true,
      processedFingerprint: validatedFingerprint,
    };
  }
  const source = context.opts.source ?? "auto-watch";
  const committed = context.execGit(
    context.repoDir,
    attributedCommitArgs(
      `${source}: sync openclaw config ${context.now().toISOString()}`,
      source,
      context.env,
      context.opts.expectedRemoteCommit,
    ),
    context.keyPath,
  );
  if (committed === null) {
    if (context.opts.durablePolicy) {
      recordSyncError(context.openclawDir, "commit-failed", context.now);
    }
    context.log(`[system_config] ${context.slug}: ${source} commit failed`);
    return {
      committed: false,
      pushed: false,
      ...(context.opts.durablePolicy ? { errorCode: "commit-failed" } : {}),
      ...(context.pushWhenClean ? { pending: true, processedFingerprint: stagedFingerprint } : {}),
    };
  }
  let pushed = context.execGit(context.repoDir, ["push", "origin", "main"], context.keyPath);
  if (pushed === null && pullRebaseRemote(context)) {
    pushed = context.execGit(context.repoDir, ["push", "origin", "main"], context.keyPath);
  }
  return pushed === null
    ? committedPushFailure(context, source, stagedFingerprint)
    : committedPushSuccess(context, source, stagedFingerprint);
}

function syncPreparedSystemConfig(context: SystemConfigSyncContext): SystemConfigSyncResult {
  const { repoConfigPath, repoDir, execGit, keyPath } = context;
  if (!fs.existsSync(repoConfigPath)) {
    return rejectedDeletionResult(context);
  }
  if (platformDrivenCheckpoint(context)) reconcilePlatformProjectionsAtPath(context);
  const dirty = execGit(repoDir, ["status", "--porcelain", "--", ...SYSTEM_CONFIG_PATHSPEC_ARGS], keyPath);
  if (dirty === null) return syncStatusFailure(context);
  if (dirty.length === 0) return syncCleanSystemConfig(context);
  const dirtyPaths = durableDirtyPaths(dirty);
  const validation = validateCandidate(context, dirtyPaths);
  if ("result" in validation) return validation.result;
  return commitValidatedCandidate(
    context,
    validation.validatedFingerprint,
    validation.validatedDurableFingerprint,
  );
}

function convergeExpectedRemoteSystemConfig(
  slug: string,
  opts: SystemConfigSyncOptions,
  context: Pick<SystemConfigSyncContext, "openclawDir" | "repoDir" | "repoConfigPath" | "env" | "execGit" | "keyPath" | "now">,
): SystemConfigSyncResult | null {
  if (!opts.expectedRemoteCommit) return null;
  const convergence = (opts.convergeRemoteCommit ?? convergeSystemConfigToRemoteCommit)({
    slug,
    openclawDir: context.openclawDir,
    repoDir: context.repoDir,
    configPath: context.repoConfigPath,
    expectedCommit: opts.expectedRemoteCommit,
    env: context.env,
    gitExec: opts.gitExec,
    validateConfig: opts.validateConfig ?? acceptRuntimeManagedConfig,
    keyPath: context.keyPath,
    readCommitBlob: opts.readCommitBlob,
  });
  if (convergence.outcome !== "unavailable") return null;
  if (opts.durablePolicy) {
    recordSyncError(context.openclawDir, convergence.errorCode, context.now);
  }
  (opts.log ?? defaultLog)(
    `[system_config] ${slug}: migration convergence failed (${convergence.errorCode})`,
  );
  return {
    committed: false,
    pushed: false,
    pending: true,
    errorCode: convergence.errorCode,
  };
}

function syncSystemConfigUnlocked(
  slug: string,
  opts: SystemConfigSyncOptions,
  pushWhenClean: boolean,
): SystemConfigSyncResult {
  if (!isValidUsername(slug)) {
    return { skipped: "invalid-builder-slug", committed: false, pushed: false };
  }
  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  const repoDir = systemConfigDir(openclawDir);
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    return { skipped: "checkout-unavailable", committed: false, pushed: false };
  }
  const repoConfigPath = systemConfigPath(openclawDir);
  const configureSsh = opts.setRepoSshCommand ?? setRepoSshCommand;
  configureSsh(repoDir, slug);
  const execGit = opts.gitExec ?? gitExec;
  const keyPath = (opts.userSshKeyPath ?? userSshKeyPath)(slug);
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const convergenceFailure = convergeExpectedRemoteSystemConfig(slug, opts, {
    openclawDir,
    repoDir,
    repoConfigPath,
    env,
    execGit,
    keyPath,
    now,
  });
  if (convergenceFailure) return convergenceFailure;
  return syncPreparedSystemConfig({
    slug,
    opts,
    pushWhenClean,
    log: opts.log ?? defaultLog,
    now,
    env,
    openclawDir,
    repoDir,
    repoConfigPath,
    initialFingerprint: systemConfigFingerprint(repoConfigPath),
    execGit,
    keyPath,
  });
}

function syncSystemConfig(
  slug: string,
  opts: SystemConfigSyncOptions,
  pushWhenClean: boolean,
): SystemConfigSyncResult {
  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  if (!isValidUsername(slug) || !fs.existsSync(openclawDir)) {
    return syncSystemConfigUnlocked(slug, opts, pushWhenClean);
  }
  if (opts.lockHeld === true) {
    return syncSystemConfigUnlocked(slug, opts, pushWhenClean);
  }
  const releaseLock = acquireSystemConfigSyncLock(openclawDir);
  if (!releaseLock) {
    const configPath = systemConfigPath(openclawDir);
    return {
      skipped: "sync-locked",
      committed: false,
      pushed: false,
      pending: true,
      processedFingerprint: systemConfigFingerprint(configPath),
    };
  }
  try {
    return syncSystemConfigUnlocked(slug, opts, pushWhenClean);
  } finally {
    releaseLock();
  }
}

interface SystemConfigAuditGitState {
  head: string | null;
  remoteHead: string | null;
  headTree: string | null;
  indexTree: string | null;
  worktree: string | null;
  configHash: string;
}

interface CompleteSystemConfigAuditGitState extends SystemConfigAuditGitState {
  head: string;
  remoteHead: string;
  headTree: string;
  indexTree: string;
  worktree: string;
}

function readSystemConfigAuditGitState(
  repoDir: string,
  configPath: string,
  keyPath: string,
  execGit: typeof gitExec,
): SystemConfigAuditGitState {
  return {
    head: execGit(repoDir, GIT_REV_PARSE_HEAD, keyPath),
    headTree: execGit(repoDir, ["rev-parse", "HEAD^{tree}"], keyPath),
    indexTree: execGit(repoDir, ["write-tree"], keyPath),
    worktree: execGit(repoDir, ["status", "--porcelain", "--", ...SYSTEM_CONFIG_PATHSPEC_ARGS], keyPath),
    remoteHead: remoteHeadFromLsRemote(
      execGit(repoDir, ["ls-remote", "origin", MAIN_REF], keyPath),
    ),
    configHash: systemConfigFingerprint(configPath),
  };
}

function unavailableAuditResult(state: SystemConfigAuditGitState): SystemConfigAuditResult {
  return {
    state: "error",
    needsSync: true,
    ...(state.head ? { head: state.head } : {}),
    ...(state.remoteHead ? { remoteHead: state.remoteHead } : {}),
    ...(state.headTree ? { headTree: state.headTree } : {}),
    ...(state.indexTree ? { indexTree: state.indexTree } : {}),
    configHash: state.configHash,
    errorCode: "git-audit-unavailable",
  };
}

function completeAuditGitState(
  state: SystemConfigAuditGitState,
): state is CompleteSystemConfigAuditGitState {
  return Boolean(
    state.head &&
    state.remoteHead &&
    state.headTree &&
    state.indexTree &&
    state.worktree !== null,
  );
}

function auditNeedsSync(
  state: CompleteSystemConfigAuditGitState,
  statusHash: string | undefined,
): boolean {
  return state.worktree.length > 0 ||
    state.indexTree !== state.headTree ||
    state.head !== state.remoteHead ||
    (statusHash !== undefined && statusHash !== `sha256:${state.configHash}`);
}

function auditHasRemoteConflict(
  repoDir: string,
  keyPath: string,
  execGit: typeof gitExec,
  head: string,
  remoteHead: string,
): boolean {
  if (head === remoteHead) return false;
  return execGit(repoDir, ["merge-base", head, remoteHead], keyPath) !== remoteHead;
}

export function auditSystemConfigForSlug(
  slug: string,
  opts: SystemConfigAuditOptions = {},
): SystemConfigAuditResult {
  if (!isValidUsername(slug)) return { state: "unavailable", needsSync: false, errorCode: "invalid-builder-slug" };
  const openclawDir = opts.openclawDir ?? OPENCLAW_DIR;
  const repoDir = systemConfigDir(openclawDir);
  const configPath = systemConfigPath(openclawDir);
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    return { state: "unavailable", needsSync: false, errorCode: "checkout-unavailable" };
  }
  if (!fs.existsSync(configPath)) {
    return { state: "error", needsSync: true, errorCode: "openclaw-json-missing" };
  }
  const execGit = opts.gitExec ?? gitExec;
  const keyPath = (opts.userSshKeyPath ?? userSshKeyPath)(slug);
  const gitState = readSystemConfigAuditGitState(repoDir, configPath, keyPath, execGit);
  if (!completeAuditGitState(gitState)) return unavailableAuditResult(gitState);
  const { head, remoteHead, headTree, indexTree, worktree, configHash } = gitState;
  if (auditHasRemoteConflict(repoDir, keyPath, execGit, head, remoteHead)) {
    return {
      state: "error",
      needsSync: true,
      head,
      remoteHead,
      headTree,
      indexTree,
      worktreeDirty: worktree.length > 0,
      configHash,
      errorCode: "non-fast-forward-conflict",
    };
  }
  const status = readSystemConfigStatus(openclawDir);
  const worktreeDirty = worktree.length > 0;
  const needsSync = auditNeedsSync(gitState, status.configHash);
  return {
    state: needsSync ? "dirty" : "clean",
    needsSync,
    head,
    remoteHead,
    headTree,
    indexTree,
    worktreeDirty,
    configHash,
  };
}

export function pushDirtySystemConfigForSlug(
  slug: string,
  opts: SystemConfigSyncOptions = {},
): SystemConfigSyncResult {
  return syncSystemConfig(slug, opts, false);
}

export function syncSystemConfigForSlug(
  slug: string,
  opts: SystemConfigSyncOptions = {},
): SystemConfigSyncResult {
  return syncSystemConfig(slug, opts, true);
}

export class SystemConfigCheckpointError extends Error {
  readonly code = "durable-system-config-checkpoint-failed";

  constructor(readonly result: SystemConfigSyncResult) {
    super(`durable system config checkpoint failed: ${result.errorCode ?? result.skipped ?? ACCEPTED_HEAD_UNAVAILABLE}`);
    this.name = "SystemConfigCheckpointError";
  }
}

export function checkpointDurableSystemConfigForSlug(
  slug: string,
  opts: SystemConfigSyncOptions = {},
  sync: typeof syncSystemConfigForSlug = syncSystemConfigForSlug,
): SystemConfigSyncResult {
  if (isSystemConfigRuntimeProjection(opts.openclawDir ?? OPENCLAW_DIR, slug)) {
    const acceptedCommit = readDurableSystemConfigHeadForSlug(slug, { openclawDir: opts.openclawDir, gitExec: opts.gitExec });
    (opts.log ?? defaultLog)(`[system_config] ${slug}: config publication is paused; retaining accepted commit ${acceptedCommit}`);
    return { committed: false, pushed: true, acceptedCommit };
  }
  const result = sync(slug, {
    ...opts,
    durablePolicy: true,
    source: opts.source ?? (opts.expectedRemoteCommit ? "migration-checkpoint" : "auto-watch"),
  });
  if (!result.pushed || result.pending || result.rejected || result.skipped ||
      result.errorCode || !result.acceptedCommit) {
    throw new SystemConfigCheckpointError(result);
  }
  return result;
}


export function readAcceptedUserConfig(openclawDir: string, env: NodeJS.ProcessEnv = process.env): UnknownRecord {
  const bytes = readSystemConfigCommitBlob(systemConfigDir(openclawDir), "HEAD", OPENCLAW_CONFIG_FILENAME);
  const config = bytes && readTrackedConfigObject(bytes.toString("utf8"));
  if (!config) throw new Error("Isolated prelaunch requires its accepted system config");
  reconcilePlatformInvariants(config, env);
  return config;
}

export type GatewayClassPolicyCommand = (configPath: string, env: NodeJS.ProcessEnv) => Promise<void>;

export function runGatewayClassPolicy(configPath: string, env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const policy = env.GATEWAY_CLASS_POLICY_PATH ?? "/octogee/gateway/apply-gateway-class-policy.mjs";
    execFile(process.execPath, [policy], { env: { ...env, OPENCLAW_CONFIG_PATH: configPath }, timeout: timeoutMs }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const detail = redactSecrets(String(stderr).trim()).slice(0, 2000);
      reject(new Error(`Gateway class policy failed for the isolated prelaunch config${detail ? ": " + detail : ""}`));
    });
  });
}

async function applyIsolatedClassPolicy(
  openclawDir: string, config: UnknownRecord, env: NodeJS.ProcessEnv, policy: GatewayClassPolicyCommand,
): Promise<UnknownRecord> {
  const temporary = fs.mkdtempSync(path.join(openclawDir, ".prelaunch-policy-"));
  try {
    const configPath = path.join(temporary, OPENCLAW_CONFIG_FILENAME);
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    await policy(configPath, { ...env, GATEWAY_CLASS: "isolated", OPENCLAW_DIR: openclawDir });
    const applied = readTrackedConfigObject(fs.readFileSync(configPath, "utf8"));
    if (!applied) throw new Error("Gateway class policy left an unreadable isolated prelaunch config");
    return applied;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export async function prepareIsolatedPrelaunchConfig(
  openclawDir: string, slug: string, env: NodeJS.ProcessEnv = process.env, run: OpenClawCommand = runOpenClaw,
  policy: GatewayClassPolicyCommand = runGatewayClassPolicy,
): Promise<void> {
  await disableSystemConfigWatch(openclawDir, slug, { runtimeProjection: true });
  clearMountedMarker(path.join(openclawDir, "customers"), slug);
  const accepted = readAcceptedUserConfig(openclawDir, env);
  applyPreBootPatches(accepted, env, defaultLog, { stateStore: localStateStoreKind(localStateStorePath(openclawDir)) });
  const config = await applyIsolatedClassPolicy(openclawDir, accepted, env, policy);
  const acceptedAgentIds = agentIdsFromConfig(config);
  const { id: _id, ...agent } = buildSafeDefaultAgent({ ...env, OPENCLAW_DIR: openclawDir });
  const agents = asRecord(config.agents) ?? {};
  delete agents.list;
  agents.entries = { [SAFE_DEFAULT_AGENT_ID]: agent };
  agents.ownership = "explicit";
  agents.defaults = { ...asRecord(agents.defaults), authInheritance: { agentId: SAFE_DEFAULT_AGENT_ID }, systemAgent: { agentId: SAFE_DEFAULT_AGENT_ID } };
  config.agents = agents;
  config.bindings = [];
  for (const channel of Object.values(asRecord(config.channels) ?? {})) {
    const entry = asRecord(channel);
    if (entry) {
      entry.enabled = false;
      for (const account of Object.values(asRecord(entry.accounts) ?? {})) {
        const configured = asRecord(account);
        if (configured) configured.enabled = false;
      }
    }
  }
  config.cron = { ...asRecord(config.cron), enabled: false };
  if (asRecord(config.talk)) config.talk = { ...asRecord(config.talk), agentId: SAFE_DEFAULT_AGENT_ID };
  await writeIsolatedPrelaunchConfig(openclawDir, config, acceptedAgentIds, env, run);
}

async function writeIsolatedPrelaunchConfig(
  openclawDir: string, config: UnknownRecord, acceptedAgentIds: string[], env: NodeJS.ProcessEnv, run: OpenClawCommand,
): Promise<void> {
  const agents = asRecord(config.agents)!;
  delete config.meta;
  const current = readTrackedConfigObject(fs.readFileSync(systemConfigPath(openclawDir), "utf8"));
  if (!current) throw new Error("Isolated prelaunch requires a readable current config");
  const entries = asRecord(agents.entries)!;
  for (const id of new Set([...acceptedAgentIds, ...agentIdsFromConfig(current)])) if (id !== SAFE_DEFAULT_AGENT_ID) entries[id] = null;
  for (const key of Object.keys(current)) if (key !== "meta" && !(key in config)) config[key] = null;
  for (const key of Object.keys(asRecord(current.agents) ?? {})) {
    if (key !== "list" && !(key in agents)) agents[key] = null;
  }
  const replacePaths = [
    ...Object.keys(config).filter(key => key !== "agents" && config[key] !== null),
    ...Object.keys(agents).filter(key => key !== "entries" && agents[key] !== null).map(key => `agents.${key}`),
    `agents.entries.${SAFE_DEFAULT_AGENT_ID}`,
  ];
  const temporary = fs.mkdtempSync(path.join(openclawDir, ".prelaunch-config-"));
  try {
    const patchFile = path.join(temporary, "patch.json");
    fs.writeFileSync(patchFile, JSON.stringify(config), { mode: 0o600 });
    const result = await run(["config", "patch", "--file", patchFile, "--allow-size-drop",
      ...replacePaths.flatMap(key => ["--replace-path", key])], {
      env: { ...env, OPENCLAW_STATE_DIR: openclawDir, OPENCLAW_CONFIG_PATH: systemConfigPath(openclawDir) },
    });
    if (result.code !== 0) {
      const diagnostic = redactSecrets(result.stderr?.trim() ?? "").slice(0, 2000);
      const detail = diagnostic ? ": " + diagnostic : "";
      throw new Error(`Native isolated prelaunch config write failed (exit ${result.code})${detail}`);
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
