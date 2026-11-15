import { configuredUserPortableStatePlanFromConfig, type OpenclawConfig } from "@octogee/core/local-default-agent-wired";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const V9FS_SUPER_MAGIC = 0x01021997;
const SQLITE_BUSY_TIMEOUT_MS = 30_000;

export interface OpenClawSqliteJournalPreflightOptions {
  stateDir: string;
  configPath?: string;
  filesystemType?: (filename: string) => number;
  busyTimeoutMs?: number;
}

function canonicalDirectory(filename: string): boolean {
  const info = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isDirectory() || fs.realpathSync.native(filename) !== filename) {
    throw new Error(`OpenClaw journal preflight requires a canonical directory: ${filename}`);
  }
  return true;
}

function configuredAgentDirectories(options: OpenClawSqliteJournalPreflightOptions): string[] {
  const configPath = options.configPath ?? path.join(options.stateDir, "openclaw.json");
  if (!fs.existsSync(configPath)) return [];
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as OpenclawConfig;
  const agentDirOnly = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const record = entry as Record<string, unknown>;
    return { id: record.id, ...(Object.hasOwn(record, "agentDir") ? { agentDir: record.agentDir } : {}) };
  };
  const agents = config.agents;
  const plan = configuredUserPortableStatePlanFromConfig({
    agents: {
      list: Array.isArray(agents?.list) ? agents.list.map(agentDirOnly) : agents?.list,
      entries: agents?.entries && Object.fromEntries(Object.entries(agents.entries).map(([id, entry]) => [id, agentDirOnly(entry)])),
    },
  } as OpenclawConfig, path.resolve(options.stateDir));
  return plan.agentDirs;
}

function existingStores(root: string, configuredDirs: readonly string[]): string[] {
  const candidates: string[] = [];
  const stateDir = path.join(root, "state");
  if (canonicalDirectory(stateDir)) {
    candidates.push(path.join(stateDir, "openclaw.sqlite"), path.join(stateDir, "openclaw-quarantine.sqlite"));
  }
  const agentsDir = path.join(root, "agents");
  if (canonicalDirectory(agentsDir)) {
    for (const name of fs.readdirSync(agentsDir).sort()) {
      const directory = path.join(agentsDir, name);
      if (fs.lstatSync(directory).isFile()) continue;
      if (!canonicalDirectory(directory)) continue;
      const agentDir = path.join(directory, "agent");
      if (canonicalDirectory(agentDir)) candidates.push(path.join(agentDir, "openclaw-agent.sqlite"));
    }
  }
  for (const relative of configuredDirs) {
    const directory = path.join(root, relative);
    if (canonicalDirectory(directory)) candidates.push(path.join(directory, "openclaw-agent.sqlite"));
  }
  return [...new Set(candidates)].filter((filename) => {
    const info = fs.lstatSync(filename, { throwIfNoEntry: false });
    if (!info) return false;
    if (!info.isFile() || fs.realpathSync.native(filename) !== filename) {
      throw new Error(`OpenClaw journal preflight requires a canonical regular file: ${filename}`);
    }
    return true;
  });
}

function requireCanonicalSidecars(filename: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = filename + suffix;
    const info = fs.lstatSync(sidecar, { throwIfNoEntry: false });
    if (info && (!info.isFile() || fs.realpathSync.native(sidecar) !== sidecar)) {
      throw new Error(`OpenClaw journal preflight requires a canonical regular sidecar: ${sidecar}`);
    }
  }
}

function convertWalStore(filename: string, timeout: number): boolean {
  requireCanonicalSidecars(filename);
  const uri = pathToFileURL(filename);
  uri.searchParams.set("mode", "rw");
  const db = new DatabaseSync(uri.href);
  try {
    db.exec(`PRAGMA busy_timeout = ${timeout}; PRAGMA trusted_schema = OFF;`);
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") return false;
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("OpenClaw database integrity check failed");
    }
    const mode = db.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode;
    if (mode !== "delete") throw new Error(`OpenClaw database retained journal mode ${String(mode)}`);
    return true;
  } catch (error) {
    throw new Error(`OpenClaw journal preflight failed for ${filename}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    db.close();
  }
}

export function prepareOpenClawSqliteJournals(
  options: OpenClawSqliteJournalPreflightOptions,
): { converted: string[] } {
  const root = fs.realpathSync.native(path.resolve(options.stateDir));
  const filesystemType = options.filesystemType ?? ((filename: string) => fs.statfsSync(filename).type);
  const timeout = options.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 0) throw new Error("Invalid OpenClaw journal busy timeout");
  const converted: string[] = [];
  for (const filename of existingStores(root, configuredAgentDirectories(options))) {
    if (filesystemType(filename) !== V9FS_SUPER_MAGIC) continue;
    if (convertWalStore(filename, timeout)) converted.push(filename);
  }
  return { converted };
}
