import { MIGRATION_IMPORT_DESCRIPTOR_TIMEOUT_MS } from "@octogee/shared/types/fleet-controller";
import fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { createHash } from "node:crypto";
import { writeOpenClawConfig } from "@octogee/core/config";
import { mattermostAccountIdForAgentId } from "@octogee/shared/types/identity";
import * as path from "node:path";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { readPostgresAgentAnchor, queryAgentStore, type PostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { runOpenClaw, type OpenClawCommand } from "./openclaw-cli.js";
import { readOpenClawFileSnapshot, readPostgresAnchorSnapshot, sameOpenClawFileSnapshot } from "./openclaw-file-snapshot.js";

import { runWithSourceDoctorDiagnostics, type SourceDoctorDiagnosticContext } from "./source-doctor-diagnostics.js";

const DEFAULT_OPENCLAW_STATE_DIR = "/home/node/.openclaw";
const UNMATCHED_ROUTE_AGENT_ID = "octogee-unmatched-route";
const POSTGRES_DOCTOR_TIMEOUT_MS = 300_000;

async function assertCanonicalSources(agentIds: string[], root: string): Promise<void> {
  for (const agentId of agentIds) {
    if (agentId !== UNMATCHED_ROUTE_AGENT_ID && !/^octogee-[a-z0-9][a-z0-9_-]*-coach$/.test(agentId)) throw new Error("source Doctor agent identity is invalid");
    let directory = root;
    for (const part of ["agents", agentId, "agent"]) {
      directory = path.join(directory, part);
      if (!(await fs.lstat(directory)).isDirectory()) throw new Error(`source Doctor agent directory is not canonical: ${agentId}`);
    }
    const file = path.join(directory, "openclaw-agent.sqlite"), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`source Doctor agent store is not canonical: ${agentId}`);
  }
}

export interface PostgresSourceDoctorOptions {
  schedulerStateRecovery?: true;
  diagnostics?: SourceDoctorDiagnosticContext;
  env?: NodeJS.ProcessEnv;
  run?: OpenClawCommand;
  expectedSchemaVersion?: number;
  assertCurrent: () => Promise<void>;
  query?: typeof queryAgentStore;
  expectedAnchors?: readonly (PostgresAgentAnchor & { agentId: string })[];
}

interface SourceAgentStore { agentId: string; file: string; anchor: PostgresAgentAnchor; snapshot: ReturnType<typeof readOpenClawFileSnapshot> }

async function postgresSourceStores(agentIds: string[], env: NodeJS.ProcessEnv): Promise<SourceAgentStore[]> {
  if (agentIds.length === 0 || new Set(agentIds).size !== agentIds.length) throw new Error("source Doctor requires a unique nonempty agent roster");
  const root = await fs.realpath(env.OPENCLAW_STATE_DIR || env.OPENCLAW_DIR || DEFAULT_OPENCLAW_STATE_DIR);
  await assertCanonicalSources(agentIds, root);
  return agentIds.map(agentId => {
    const file = path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
    const snapshot = readOpenClawFileSnapshot(file);
    const anchor = readPostgresAnchorSnapshot(snapshot.bytes);
    if (!anchor) throw new Error(`source Doctor requires a PostgreSQL anchor: ${agentId}`);
    return { agentId, file, anchor, snapshot };
  });
}

export async function captureSourceDoctorServiceAnchor(env: NodeJS.ProcessEnv = process.env): Promise<(PostgresAgentAnchor & { agentId: string; sha256: string }) | null> {
  const root = await fs.realpath(env.OPENCLAW_STATE_DIR || env.OPENCLAW_DIR || DEFAULT_OPENCLAW_STATE_DIR);
  const configPath = env.OPENCLAW_CONFIG_PATH || path.join(root, "openclaw.json");
  const config = JSON.parse(readOpenClawFileSnapshot(configPath).bytes.toString("utf8"));
  const agentId = UNMATCHED_ROUTE_AGENT_ID;
  if (!config.agents?.entries?.[agentId] && !config.bindings?.some((binding: { agentId?: string }) => binding.agentId === agentId)) return null;
  const [store] = await postgresSourceStores([agentId], env);
  return { agentId, ...store!.anchor, sha256: createHash("sha256").update(store!.snapshot.bytes).digest("hex") };
}

async function includeSourceServiceStore(stores: SourceAgentStore[], input: PostgresSourceDoctorOptions): Promise<SourceAgentStore[]> {
  if (stores.some(store => store.agentId === UNMATCHED_ROUTE_AGENT_ID)) return stores;
  const env = input.env ?? process.env;
  const service = await captureSourceDoctorServiceAnchor(env);
  if (!service) return stores;
  const [store] = await postgresSourceStores([service.agentId], env);
  if (stores.some(candidate => candidate.anchor.storeId === store!.anchor.storeId || candidate.anchor.schema === store!.anchor.schema)) throw new Error("source Doctor service anchor aliases a user store");
  return [...stores, store!];
}

function assertRecordedSourceAnchors(stores: SourceAgentStore[], expected: PostgresSourceDoctorOptions["expectedAnchors"]): void {
  if (!expected || expected.length !== stores.length || new Set(expected.map(store => store.agentId)).size !== stores.length ||
      stores.some(store => !expected.some(anchor => anchor.agentId === store.agentId && anchor.storeId === store.anchor.storeId && anchor.schema === store.anchor.schema)) ||
      new Set(expected.map(store => store.storeId)).size !== stores.length || new Set(expected.map(store => store.schema)).size !== stores.length) {
    throw new Error("source Doctor PostgreSQL anchors do not match the captured owner roster");
  }
}

function assertSourceAnchors(stores: SourceAgentStore[]): void {
  for (const store of stores) {
    if (!sameOpenClawFileSnapshot(store.snapshot, readOpenClawFileSnapshot(store.file))) {
      throw new Error(`source Doctor original anchor bytes changed: ${store.agentId}`);
    }
  }
}

function positivePostgresInteger(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return Number(value);
  return NaN;
}

export function postgresSourceMetadataMatches(input: {
  rows: Array<Record<string, unknown>>; store: Pick<SourceAgentStore, "agentId" | "anchor">; expectedVersion: number; exact: boolean;
}): boolean {
  const { rows, store, expectedVersion, exact } = input, row = rows[0];
  const version = positivePostgresInteger(row?.version), ownerVersion = positivePostgresInteger(row?.schema_version);
  return [rows.length === 1, row?.store_id === store.anchor.storeId, row?.role === "agent", row?.agent_id === store.agentId,
    Number.isSafeInteger(version), version >= 1, ownerVersion === version,
    exact ? version === expectedVersion : version <= expectedVersion].every(Boolean);
}

async function verifyPostgresSourceMetadata(stores: SourceAgentStore[], input: PostgresSourceDoctorOptions & { expectedSchemaVersion: number }, exact: boolean): Promise<void> {
  if (!Number.isSafeInteger(input.expectedSchemaVersion) || input.expectedSchemaVersion < 1) throw new Error("source Doctor requires the installed Native agent schema version");
  for (const store of stores) {
    await input.assertCurrent();
    assertSourceAnchors(stores);
    const rows = await (input.query ?? queryAgentStore)(store.anchor,
      `SELECT physical.store_id, physical.version, owner.role, owner.agent_id, owner.schema_version
       FROM $schema.openclaw_schema_meta physical CROSS JOIN $schema.schema_meta owner
       WHERE physical.store = 'agent' AND owner.meta_key = 'primary'`);
    if (!postgresSourceMetadataMatches({ rows, store, expectedVersion: input.expectedSchemaVersion, exact })) {
      throw new Error(`source Doctor PostgreSQL identity/version metadata mismatch: ${store.agentId}`);
    }
    await input.assertCurrent();
    assertSourceAnchors(stores);
  }
}

export async function installedAgentSchemaVersion(privateRoot: string, agentId: string, input: PostgresSourceDoctorOptions): Promise<number> {
  const file = path.join(privateRoot, "absent-schema-probe.sqlite");
  await input.assertCurrent();
  const result = await (input.run ?? runOpenClaw)(["database", "preflight-agent", file, "--agent-id", agentId, "--json"], { env: {
    PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1", OPENCLAW_STATE_DIR: privateRoot,
  }, timeoutMs: MIGRATION_IMPORT_DESCRIPTOR_TIMEOUT_MS });
  await input.assertCurrent();
  let report: Record<string, unknown>;
  try { report = JSON.parse(result.stdout); } catch { throw new Error("Native agent schema descriptor is not JSON"); }
  if (result.code !== 1 || report.schema !== "openclaw.agent-schema-preflight.v1" || report.agentId !== agentId ||
      report.databasePath !== file || report.status !== "indeterminate" || report.foundVersion !== null || report.requiresWrite !== false ||
      !Number.isSafeInteger(report.targetVersion) || (report.targetVersion as number) < 1 ||
      (input.expectedSchemaVersion !== undefined && input.expectedSchemaVersion !== report.targetVersion)) {
    throw new Error("Native agent schema descriptor does not match the installed artifact");
  }
  return report.targetVersion as number;
}

export async function verifyPostgresSourceDoctorAgentStores(agentIds: string[], input: PostgresSourceDoctorOptions): Promise<void> {
  const selected = await postgresSourceStores(agentIds, input.env ?? process.env);
  assertRecordedSourceAnchors(selected, input.expectedAnchors);
  const stores = await includeSourceServiceStore(selected, input);
  const privateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "source-doctor-version-")));
  try {
    const expectedSchemaVersion = await installedAgentSchemaVersion(privateRoot, agentIds[0]!, input);
    await verifyPostgresSourceMetadata(stores, { ...input, expectedSchemaVersion }, true);
  } finally { await fs.rm(privateRoot, { recursive: true, force: true }); }
}

async function captureServingConfig(env: NodeJS.ProcessEnv) {
  const root = await fs.realpath(env.OPENCLAW_STATE_DIR || env.OPENCLAW_DIR || DEFAULT_OPENCLAW_STATE_DIR);
  const file = env.OPENCLAW_CONFIG_PATH || path.join(root, "openclaw.json");
  const snapshot = readOpenClawFileSnapshot(file);
  const config = JSON.parse(snapshot.bytes.toString("utf8"));
  if (config.agents?.ownership !== "explicit" || !config.agents.entries || typeof config.agents.entries !== "object" ||
      Array.isArray(config.agents.entries) || config.agents.list !== undefined) throw new Error("source Doctor requires canonical explicit agent entries");
  return { file, snapshot, config };
}

function sourceConfigObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function mattermostBindingOwners(config: Record<string, unknown>): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  if (!Array.isArray(config.bindings)) return owners;
  for (const value of config.bindings) {
    const binding = sourceConfigObject(value), match = sourceConfigObject(binding?.match);
    if (match?.channel !== "mattermost" || typeof match.accountId !== "string" || match.accountId === "*") continue;
    if (typeof binding?.agentId !== "string") throw new Error("source Doctor Mattermost account ownership is ambiguous");
    const agents = owners.get(match.accountId) ?? new Set<string>();
    agents.add(binding.agentId); owners.set(match.accountId, agents);
  }
  return owners;
}

interface MattermostSourceAccountPolicy {
  canonicalOwners: Map<string, string>; bindingOwners: Map<string, Set<string>>; servingAgents: Set<string>; channelDisabled: boolean;
}

function sourceMattermostAccount(accountId: string, value: unknown, policy: MattermostSourceAccountPolicy): Record<string, unknown> {
  const account = sourceConfigObject(value), owner = policy.canonicalOwners.get(accountId), bindings = policy.bindingOwners.get(accountId) ?? new Set<string>();
  if (!account || bindings.size > 1) throw new Error(`source Doctor Mattermost account ownership is ambiguous: ${accountId}`);
  if (owner) {
    if ([...bindings].some(agentId => agentId !== owner)) throw new Error(`source Doctor Mattermost account ownership conflicts: ${accountId}`);
    return policy.servingAgents.has(owner) ? account : { ...account, enabled: false };
  }
  const sharedDefault = bindings.size === 1 && bindings.has(UNMATCHED_ROUTE_AGENT_ID) && policy.servingAgents.has(UNMATCHED_ROUTE_AGENT_ID);
  if (account.enabled === false || policy.channelDisabled || sharedDefault) return account;
  throw new Error(`source Doctor Mattermost account ownership is unavailable: ${accountId}`);
}

function hasImplicitMattermostDefault(mattermost: Record<string, unknown>, accounts: Record<string, unknown> | null, env: NodeJS.ProcessEnv): boolean {
  const rootToken = typeof mattermost.botToken === "string" ? mattermost.botToken.trim() !== "" : sourceConfigObject(mattermost.botToken) !== null;
  const implicitCredentials = rootToken || Boolean(env.MATTERMOST_BOT_TOKEN?.trim());
  return implicitCredentials && (Boolean(typeof mattermost.baseUrl === "string" && mattermost.baseUrl.trim()) || Object.keys(accounts ?? {}).length === 0);
}

function sourceMattermostAccounts(config: Record<string, unknown>, servingAgents: Set<string>, knownAgents: Set<string>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const channels = sourceConfigObject(config.channels);
  if (channels?.mattermost === undefined) return config;
  const mattermost = sourceConfigObject(channels.mattermost);
  if (!mattermost) throw new Error("source Doctor Mattermost account ownership requires canonical channel config");
  const accounts = sourceConfigObject(mattermost.accounts);
  if (mattermost.accounts !== undefined && !accounts) throw new Error("source Doctor Mattermost account ownership requires canonical accounts");
  const canonicalOwners = new Map<string, string>();
  for (const agentId of knownAgents) {
    const accountId = mattermostAccountIdForAgentId(agentId);
    if (accountId) canonicalOwners.set(accountId, agentId);
  }
  const policy = { canonicalOwners, bindingOwners: mattermostBindingOwners(config), servingAgents, channelDisabled: mattermost.enabled === false };
  const projected = Object.fromEntries(Object.entries(accounts ?? {}).map(([id, account]) => [id, sourceMattermostAccount(id, account, policy)]));
  if (hasImplicitMattermostDefault(mattermost, accounts, env) && !Object.prototype.hasOwnProperty.call(projected, "default")) sourceMattermostAccount("default", {}, policy);
  return { ...config, channels: { ...channels, mattermost: { ...mattermost, ...(accounts ? { accounts: projected } : {}) } } };
}

function sourceServingConfig(config: Record<string, unknown>, stores: SourceAgentStore[], env: NodeJS.ProcessEnv): Record<string, unknown> {
  const agents = sourceConfigObject(config.agents)!, originalEntries = sourceConfigObject(agents.entries)!;
  const allowed = new Set(stores.map(store => store.agentId));
  const entries = Object.fromEntries(Object.entries(originalEntries).filter(([agentId]) => allowed.has(agentId)));
  if (Object.keys(entries).length === 0) throw new Error("source Doctor cannot start an empty authoritative roster");
  const servingAgents = new Set(Object.keys(entries)), knownAgents = new Set([...Object.keys(originalEntries), ...allowed]);
  const next = sourceMattermostAccounts({ ...config, agents: { ...agents, entries } }, servingAgents, knownAgents, env);
  if (Array.isArray(next.bindings)) next.bindings = next.bindings.filter(value => {
    const binding = sourceConfigObject(value);
    return typeof binding?.agentId !== "string" || servingAgents.has(binding.agentId);
  });
  return next;
}

async function narrowServingConfig(snapshot: Awaited<ReturnType<typeof captureServingConfig>>, stores: SourceAgentStore[], input: PostgresSourceDoctorOptions, next: Record<string, unknown>): Promise<void> {
  await input.assertCurrent();
  assertSourceAnchors(stores);
  if (!sameOpenClawFileSnapshot(snapshot.snapshot, readOpenClawFileSnapshot(snapshot.file))) throw new Error("source Doctor serving config changed during repair");
  if (JSON.stringify(next) === JSON.stringify(snapshot.config)) return;
  const temporary = snapshot.file + ".tmp";
  fsSync.writeFileSync(temporary, "", { flag: "wx", mode: snapshot.snapshot.mode });
  try { writeOpenClawConfig(next, snapshot.file); }
  finally { if (fsSync.existsSync(temporary)) fsSync.unlinkSync(temporary); }
  await input.assertCurrent();
  assertSourceAnchors(stores);
}

async function assertSchedulerSourceRoster(stores: SourceAgentStore[], input: PostgresSourceDoctorOptions): Promise<void> {
  if (!input.schedulerStateRecovery) return;
  if (!input.expectedAnchors) throw new Error("scheduler source Doctor requires the complete captured PostgreSQL roster");
  const env = input.env ?? process.env;
  const file = path.join(env.OPENCLAW_STATE_DIR || env.OPENCLAW_DIR || DEFAULT_OPENCLAW_STATE_DIR, "state/openclaw.sqlite");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.nlink !== 1 || await fs.realpath(file) !== path.resolve(file) || readPostgresAgentAnchor(file)) throw new Error("scheduler source Doctor requires canonical SQLite gateway state");
  const owners = new Set(stores.map(store => store.agentId));
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT DISTINCT agent_id FROM cron_jobs").all();
    if (rows.some(row => !owners.has(typeof row.agent_id === "string" && row.agent_id ? row.agent_id : UNMATCHED_ROUTE_AGENT_ID))) {
      throw new Error("scheduler source Doctor found cron jobs outside the captured source roster");
    }
  } finally { db.close(); }
}

export async function repairSourceDoctorAgentStores(agentIds: string[], input: PostgresSourceDoctorOptions): Promise<void> {
  const env = input.env ?? process.env;
  if (!env.OPENCLAW_AGENT_STORE_DSN?.trim()) throw new Error("source Doctor requires OPENCLAW_AGENT_STORE_DSN");
  const servingConfig = await captureServingConfig(env);
  const selected = await postgresSourceStores(agentIds, env);
  assertRecordedSourceAnchors(selected, input.expectedAnchors);
  const stores = await includeSourceServiceStore(selected, input);
  await assertSchedulerSourceRoster(stores, input);
  const servingProjection = sourceServingConfig(servingConfig.config, stores, env);
  for (const store of stores) {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = await fs.lstat(store.file + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (sidecar) throw new Error(`source Doctor PostgreSQL anchor is not closed: ${store.agentId}`);
    }
  }
  const home = env.HOME || os.homedir();
  const workspaces = [servingConfig.config.agents.defaults, ...Object.values(servingConfig.config.agents.entries)]
    .map(value => sourceConfigObject(value)?.workspace).filter((value): value is string => typeof value === "string")
    .map(value => value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
  await runWithSourceDoctorDiagnostics({ home,
    excludedRoots: [await fs.realpath(env.OPENCLAW_STATE_DIR || env.OPENCLAW_DIR || DEFAULT_OPENCLAW_STATE_DIR), servingConfig.file, ...workspaces],
    context: input.diagnostics, run: input.run ?? runOpenClaw,
  }, async ({ root: privateRoot, run, phase, seal }) => {
    const configPath = path.join(privateRoot, "openclaw.json");
    const expectedSchemaVersion = await phase("descriptor", () => installedAgentSchemaVersion(privateRoot, agentIds[0]!, { ...input, run }));
    const bound = { ...input, expectedSchemaVersion };
    await phase("pre-metadata", () => verifyPostgresSourceMetadata(stores, bound, false));
    const commandOptions = { env: {
      PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1",
      HOME: privateRoot, OPENCLAW_STATE_DIR: privateRoot, OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_AGENT_STORE_DSN: env.OPENCLAW_AGENT_STORE_DSN,
    } };
    const isolatedGateway = { mode: "local", bind: "loopback", port: 18799 };
    const bootstrap = "octogee-source-doctor-bootstrap";
    await fs.writeFile(configPath, JSON.stringify({ gateway: isolatedGateway, plugins: { enabled: false },
      agents: { ownership: "explicit", entries: { [bootstrap]: { workspace: path.join(privateRoot, "bootstrap-workspace") } } },
      database: { engine: "sqlite" },
    }), { mode: 0o600 });
    await input.assertCurrent();
    assertSourceAnchors(stores);
    let initialized;
    try { initialized = await phase("bootstrap", () => run(["setup", "--baseline", "--skip-bootstrap", "--json"], commandOptions)); }
    finally { await input.assertCurrent(); assertSourceAnchors(stores); }
    if (initialized.code !== 0) throw new Error(`source Doctor private initialization failed (exit ${initialized.code})`);
    await phase("copy-anchors", async () => {
      await fs.rm(path.join(privateRoot, "agents"), { recursive: true, force: true });
      const entries: Record<string, { workspace: string }> = {};
      for (const store of stores) {
        await input.assertCurrent();
        assertSourceAnchors(stores);
        const file = path.join(privateRoot, "agents", store.agentId, "agent", "openclaw-agent.sqlite");
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, store.snapshot.bytes, { flag: "wx", mode: 0o600 });
        entries[store.agentId] = { workspace: path.join(privateRoot, "workspaces", store.agentId) };
      }
      const initializedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
      await fs.writeFile(configPath, JSON.stringify({
        ...initializedConfig,
        gateway: isolatedGateway, plugins: { enabled: false },
        agents: { ownership: "explicit", entries },
        database: { engine: "sqlite", families: { agent: { engine: "postgres" } },
          postgres: { connection: { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" }, schemaPrefix: "octogee" } },
      }), { mode: 0o600 });
      await input.assertCurrent();
      assertSourceAnchors(stores);
    });
    const result = await phase("postgres-doctor", () => run(["doctor", "--fix", "--non-interactive"], {
      ...commandOptions, timeoutMs: POSTGRES_DOCTOR_TIMEOUT_MS,
    }));
    if (!input.schedulerStateRecovery) await seal(result);
    await input.assertCurrent();
    assertSourceAnchors(stores);
    if (result.code !== 0) throw new Error(`source PostgreSQL Doctor failed (exit ${result.code}); source remains fenced`);
    await phase("post-metadata", () => verifyPostgresSourceMetadata(stores, bound, true));
    await phase("serving-projection", () => narrowServingConfig(servingConfig, stores, bound, servingProjection));
    if (input.schedulerStateRecovery) {
      await input.assertCurrent();
      assertSourceAnchors(stores);
      await assertSchedulerSourceRoster(stores, input);
      const scheduler = await phase("source-scheduler-doctor", () => run(["doctor", "--fix", "--non-interactive"], {
        env, timeoutMs: POSTGRES_DOCTOR_TIMEOUT_MS,
      }));
      await seal(scheduler);
      await input.assertCurrent();
      assertSourceAnchors(stores);
      if (scheduler.code !== 0) throw new Error(`source scheduler Doctor failed (exit ${scheduler.code}); source remains fenced`);
      await phase("scheduler-post-metadata", () => verifyPostgresSourceMetadata(stores, bound, true));
    }
  });
}
