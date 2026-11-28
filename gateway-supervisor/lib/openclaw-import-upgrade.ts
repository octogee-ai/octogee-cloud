import { MIGRATION_IMPORT_DOCTOR_PHASE_TIMEOUT_MS } from "@octogee/shared/types/fleet-controller";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { queryAgentStore } from "@octogee/core/agent-postgres";
import { readImageAgentSchemaVersion } from "./openclaw-agent-schema-descriptor.js";
import { installedAgentSchemaVersion, postgresSourceMetadataMatches } from "./openclaw-source-doctor.js";
import { runOpenClaw, type OpenClawCommand } from "./openclaw-cli.js";
import { readOpenClawFileSnapshot, readPostgresAnchorSnapshot, sameOpenClawFileSnapshot } from "./openclaw-file-snapshot.js";

interface BaselineFileEntry {
  relativePath: string;
  bytes: Buffer;
  mode: number;
}

interface CachedBaseline {
  initialized: Record<string, unknown>;
  files: readonly BaselineFileEntry[];
}

const descriptorCache = new WeakMap<OpenClawCommand, Promise<number>>();
const baselineCache = new WeakMap<OpenClawCommand, CachedBaseline>();
const METADATA_BATCH_SIZE = 4;
const ISOLATED_UPGRADE_GATEWAY = { mode: "local", bind: "loopback", port: 18799 } as const;

async function snapshotBaselineFiles(root: string, current = root, files: BaselineFileEntry[] = []): Promise<BaselineFileEntry[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    const relativePath = path.relative(root, full);
    if (relativePath === "agents" || relativePath === "openclaw.json") continue;
    if (entry.isDirectory()) {
      await snapshotBaselineFiles(root, full, files);
    } else if (entry.isFile()) {
      const stat = await fs.lstat(full);
      files.push({ relativePath, bytes: await fs.readFile(full), mode: stat.mode & 0o777 });
    }
  }
  return files;
}

async function restoreBaselineFiles(root: string, files: readonly BaselineFileEntry[]): Promise<void> {
  for (const file of files) {
    const target = path.join(root, file.relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, file.bytes, { mode: file.mode || 0o600, flag: "wx" });
  }
}

async function cachedDevelopmentProbe(root: string, agentId: string, run: OpenClawCommand, env: NodeJS.ProcessEnv, assertCurrent: () => Promise<void>): Promise<number> {
  await assertCurrent();
  let descriptor = descriptorCache.get(run);
  if (!descriptor) {
    descriptor = installedAgentSchemaVersion(root, agentId, { assertCurrent, run, env });
    descriptorCache.set(run, descriptor);
    descriptor.catch(() => { if (descriptorCache.get(run) === descriptor) descriptorCache.delete(run); });
  }
  const version = await descriptor;
  await assertCurrent();
  return version;
}

export interface ImportedAgentStore {
  agentId: string;
  anchorPath: string;
  storeId: string;
  schema: string;
}

function assertValidRoster(stores: readonly ImportedAgentStore[]): void {
  if (!stores.length || new Set(stores.map(store => store.agentId)).size !== stores.length ||
      new Set(stores.map(store => store.storeId)).size !== stores.length ||
      new Set(stores.map(store => store.schema)).size !== stores.length ||
      stores.some(store => !/^[a-z0-9][a-z0-9_-]*$/u.test(store.agentId))) {
    throw new Error("import upgrade requires a unique valid agent roster");
  }
}

export async function upgradeImportedAgentStores(input: {
  stores: readonly ImportedAgentStore[];
  allowUpgrade?: boolean;
  log: (message: string) => void;
  assertCurrent: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  run?: OpenClawCommand;
  signal?: AbortSignal;
  query?: typeof queryAgentStore;
}): Promise<void> {
  const phase = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      const result = await action();
      input.log(`[import-upgrade] phase=${name} status=done durationMs=${Date.now() - started}`);
      return result;
    } catch (error) {
      input.log(`[import-upgrade] phase=${name} status=failed durationMs=${Date.now() - started}`);
      throw error;
    }
  };
  const env = input.env ?? process.env;
  if (!env.OPENCLAW_AGENT_STORE_DSN?.trim()) throw new Error("import upgrade requires a PostgreSQL DSN");
  assertValidRoster(input.stores);
  const captured = await Promise.all(input.stores.map(async store => {
    if (!path.isAbsolute(store.anchorPath)) throw new Error(`import upgrade anchor is not canonical: ${store.agentId}`);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = await fs.lstat(store.anchorPath + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (sidecar) throw new Error(`import upgrade anchor is not closed: ${store.agentId}`);
    }
    const snapshot = readOpenClawFileSnapshot(store.anchorPath);
    const anchor = readPostgresAnchorSnapshot(snapshot.bytes);
    if (!anchor || anchor.storeId !== store.storeId || anchor.schema !== store.schema) throw new Error(`import upgrade anchor identity mismatch: ${store.agentId}`);
    return { ...store, snapshot };
  }));
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    await input.assertCurrent();
    for (const store of captured) {
      if (!sameOpenClawFileSnapshot(store.snapshot, readOpenClawFileSnapshot(store.anchorPath))) throw new Error(`import upgrade anchor changed: ${store.agentId}`);
    }
    input.signal?.throwIfAborted();
  };
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "import-upgrade-")));
  try {
    const configPath = path.join(root, "openclaw.json");
    const run = input.run ?? runOpenClaw;
    const expectedSchemaVersion = await phase("descriptor", async () => {
      const version = await readImageAgentSchemaVersion();
      return version ?? cachedDevelopmentProbe(root, captured[0]!.agentId, run, env, assertCurrent);
    });
    const verifyMetadata = async (exact: boolean) => {
      const readVersion = async (store: typeof captured[number]) => {
        const rows = await (input.query ?? queryAgentStore)({ storeId: store.storeId, schema: store.schema },
          `SELECT physical.store_id, physical.version, owner.role, owner.agent_id, owner.schema_version
           FROM $schema.openclaw_schema_meta physical CROSS JOIN $schema.schema_meta owner
           WHERE physical.store = 'agent' AND owner.meta_key = 'primary'`);
        const metadataStore = { ...store, anchor: { storeId: store.storeId, schema: store.schema }, file: store.anchorPath };
        if (!postgresSourceMetadataMatches({ rows, store: metadataStore, expectedVersion: expectedSchemaVersion, exact })) {
          throw new Error(`import upgrade PostgreSQL identity/version metadata mismatch: ${store.agentId}`);
        }
        return Number(rows[0]!.version);
      };
      await assertCurrent();
      let needsUpgrade = false;
      try {
        for (let offset = 0; offset < captured.length; offset += METADATA_BATCH_SIZE) {
          const versions = await Promise.all(captured.slice(offset, offset + METADATA_BATCH_SIZE).map(readVersion));
          needsUpgrade ||= versions.some(version => version < expectedSchemaVersion);
        }
      } finally {
        await assertCurrent();
      }
      return needsUpgrade;
    };
    if (!await phase("pre-metadata", () => verifyMetadata(false))) {
      input.log("[import-upgrade] upgrade=skipped schemas=current");
      return;
    }
    if (input.allowUpgrade === false) {
      throw new Error("User import requires the source and target to use the same current agent schema; source retained");
    }
    input.log("[import-upgrade] upgrade=required schemas=older");
    const options = { env: { PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1", HOME: root,
      OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_NO_RESPAWN: "1", OPENCLAW_AGENT_STORE_DSN: env.OPENCLAW_AGENT_STORE_DSN },
      signal: input.signal, timeoutMs: MIGRATION_IMPORT_DOCTOR_PHASE_TIMEOUT_MS };
    const runPrivate = async (args: string[], phase: string) => {
      await assertCurrent();
      let result;
      try { result = await run(args, options); }
      finally { await assertCurrent(); }
      if (result.code !== 0) throw new Error(`import ${phase} failed (exit ${result.code})`);
    };
    const cachedBaseline = baselineCache.get(run);
    let initialized: Record<string, unknown>;
    if (cachedBaseline) {
      await phase("bootstrap", async () => {
        await assertCurrent();
        await restoreBaselineFiles(root, cachedBaseline.files);
        await assertCurrent();
      });
      initialized = cachedBaseline.initialized;
    } else {
      await fs.writeFile(configPath, JSON.stringify({ gateway: ISOLATED_UPGRADE_GATEWAY, plugins: { enabled: false },
        agents: { ownership: "explicit", entries: { "octogee-import-upgrade-bootstrap": { workspace: path.join(root, "bootstrap-workspace") } } },
        database: { engine: "sqlite" } }), { mode: 0o600 });
      await phase("bootstrap", () => runPrivate(["setup", "--baseline", "--skip-bootstrap", "--json"], "bootstrap setup"));
      initialized = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
      await fs.rm(path.join(root, "agents"), { recursive: true, force: true });
      const files = await snapshotBaselineFiles(root);
      baselineCache.set(run, { initialized, files });
    }
    const entries: Record<string, { workspace: string }> = {};
    for (const store of captured) {
      const file = path.join(root, "agents", store.agentId, "agent", "openclaw-agent.sqlite");
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, store.snapshot.bytes, { mode: 0o600, flag: "wx" });
      entries[store.agentId] = { workspace: path.join(root, "workspaces", store.agentId) };
    }
    await fs.writeFile(configPath, JSON.stringify({ ...initialized, gateway: ISOLATED_UPGRADE_GATEWAY, plugins: { enabled: false },
      agents: { ownership: "explicit", entries }, database: { engine: "sqlite", families: { agent: { engine: "postgres" } },
        postgres: { connection: { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" }, schemaPrefix: "octogee" } } }), { mode: 0o600 });
    await assertCurrent();
    let fast;
    try { fast = await phase("doctor", () => run(["doctor", "--fix", "--non-interactive", "--skip-recovery-backups"], options)); }
    finally { await assertCurrent(); }
    if (fast.code !== 0) {
      input.log(`[import-upgrade] fast Doctor failed (exit ${fast.code}); retrying full Doctor`);
      try {
        await phase("full-doctor", () => runPrivate(["doctor", "--fix", "--non-interactive"], "full PostgreSQL repair"));
        await phase("post-metadata", () => verifyMetadata(true));
      } catch (error) {
        input.log(`[import-upgrade] full Doctor repair failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      input.log("[import-upgrade] full Doctor repair completed and metadata verified");
    } else {
      await phase("post-metadata", () => verifyMetadata(true));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
