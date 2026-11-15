import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listSqliteStores } from "./agent-store-carry.js";
import { assertNotHeld, matchFiles, sqliteFamily } from "./held-files.js";
import { exportCodexStoreSnapshots, isCodexDatabase } from "./codex-store-snapshot.js";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";

export const AGENT_STORE_BASENAME = "openclaw-agent.sqlite";
export const AGENT_SNAPSHOT_DIRNAME = ".octogee-snapshot";
export const AGENT_IMPORT_DIRNAME = ".octogee-import";

export const LIVE_AGENT_STORE_EXCLUDE_ARGS = [
  `--exclude=${AGENT_STORE_BASENAME}`,
  `--exclude=${AGENT_STORE_BASENAME}-*`,
];

export interface PortableAgentStore {
  agentId: string;
  agentDir: string;
  sourceAgentDir: string;
}

function posixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function agentIdOfStateRelativePath(relative: string): string | null {
  const segments = relative.split("/");
  return segments[0] === "agents" && segments.length >= 3 ? segments[1]! : null;
}

export async function findPortableAgentStores(
  sources: ReadonlyArray<{ cwd: string; path: string }>,
): Promise<PortableAgentStore[]> {
  const byAgent = new Map<string, PortableAgentStore>();
  for (const source of sources) {
    for (const store of await listSqliteStores(path.join(source.cwd, source.path))) {
      const relative = posixRelative(source.cwd, store);
      if (isCodexDatabase(relative)) continue;
      const agentId = agentIdOfStateRelativePath(relative);
      if (agentId === null) continue;
      if (path.posix.basename(relative) !== AGENT_STORE_BASENAME) {
        throw new Error(`unexpected OpenClaw SQLite store in agent state: ${relative}`);
      }
      const agentDir = path.posix.dirname(relative);
      const sourceAgentDir = path.resolve(path.dirname(store));
      const existing = byAgent.get(agentId);
      if (existing && existing.sourceAgentDir !== sourceAgentDir) {
        throw new Error(`agent ${agentId} has more than one database: ${existing.sourceAgentDir}, ${sourceAgentDir}`);
      }
      byAgent.set(agentId, { agentId, agentDir, sourceAgentDir });
    }
  }
  return [...byAgent.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
}

const ANCHOR_CONCURRENCY = 4;

async function mapConcurrently<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failures = new Map<number, unknown>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failures.size === 0 && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index]!);
      } catch (error) {
        failures.set(index, error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ANCHOR_CONCURRENCY, items.length) }, worker));
  const errors = [...failures.entries()].sort(([left], [right]) => left - right).map(([, error]) => error);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, errors.map((error) => error instanceof Error ? error.message : String(error)).join("; "));
  }
  return results;
}

export async function exportAgentStoreSnapshots(
  input: {
    signal?: AbortSignal;
    sources: ReadonlyArray<{ cwd: string; path: string }>;
    exportRoot: string;
    log?: (message: string) => void;
    detachAgent?: (agentId: string) => Promise<void>;
  },
): Promise<Array<{ cwd: string; path: string }>> {
  const stores = await findPortableAgentStores(input.sources);
  if (stores.length === 0) return exportCodexStoreSnapshots(input);
  const carried: Array<{ cwd: string; path: string }> = [];
  for (const store of stores) {
    const file = path.join(store.sourceAgentDir, AGENT_STORE_BASENAME);
    const anchor = readPostgresAgentAnchor(file);
    input.signal?.throwIfAborted();
    if (!anchor) throw new Error("SQLite agent handoff is unsupported after the PostgreSQL cutover");
    if (!input.detachAgent) throw new Error(`PostgreSQL agent ${store.agentId} must be detached before handoff`);
    await input.detachAgent(store.agentId);
    for (const suffix of ["-wal", "-journal"]) {
      const sidecar = await fs.stat(file + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (sidecar && sidecar.size > 0) throw new Error(`PostgreSQL agent ${store.agentId} anchor is not closed`);
    }
    const relative = path.posix.join(store.agentDir, AGENT_SNAPSHOT_DIRNAME);
    const directory = path.join(input.exportRoot, relative, "postgres-anchor");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const artifact = path.join(directory, SNAPSHOT_ARTIFACT_BASENAME);
    await fs.copyFile(file, artifact, fs.constants.COPYFILE_EXCL);
    await fs.chmod(artifact, 0o600);
    await fs.writeFile(path.join(directory, SNAPSHOT_MANIFEST_BASENAME), JSON.stringify({
      schemaVersion: 1,
      database: { role: "agent", agentId: store.agentId, engine: "postgres", ...anchor },
      artifact: { path: SNAPSHOT_ARTIFACT_BASENAME, sha256: await sha256OfFile(artifact), sizeBytes: (await fs.stat(artifact)).size },
    }), { mode: 0o600 });
    carried.push({ cwd: input.exportRoot, path: relative });
  }
  return [...carried, ...await exportCodexStoreSnapshots(input)];
}

export interface StagedAgentSnapshot {
  agentId: string;
  agentDir: string;
  snapshotDir: string;
}

export async function findStagedAgentSnapshots(stageDir: string): Promise<StagedAgentSnapshot[]> {
  const found: StagedAgentSnapshot[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.name !== AGENT_SNAPSHOT_DIRNAME) {
        await walk(absolute);
        continue;
      }
      const agentDir = posixRelative(stageDir, dir);
      const agentId = agentIdOfStateRelativePath(`${agentDir}/${AGENT_STORE_BASENAME}`);
      if (agentId === null) throw new Error(`staged agent snapshot outside agent state: ${agentDir}`);
      const snapshots = (await fs.readdir(absolute, { withFileTypes: true })).filter((item) => item.isDirectory());
      if (snapshots.length !== 1) {
        throw new Error(`staged agent ${agentId} must carry exactly one snapshot (found ${snapshots.length})`);
      }
      if (found.some((item) => item.agentId === agentId)) {
        throw new Error(`staged agent ${agentId} carries more than one snapshot directory`);
      }
      found.push({ agentId, agentDir, snapshotDir: path.join(absolute, snapshots[0]!.name) });
    }
  }
  await walk(stageDir);
  return found.sort((left, right) => left.agentId.localeCompare(right.agentId));
}

export async function findStagedLiveAgentStores(stageDir: string): Promise<string[]> {
  const live: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.name === AGENT_STORE_BASENAME || entry.name.startsWith(`${AGENT_STORE_BASENAME}-`)) {
        live.push(posixRelative(stageDir, absolute));
      }
    }
  }
  await walk(stageDir);
  return live.sort();
}

const SNAPSHOT_ARTIFACT_BASENAME = "database.sqlite";
const SNAPSHOT_MANIFEST_BASENAME = "manifest.json";

interface SnapshotManifestArtifact {
  sha256: string;
  sizeBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function manifestArtifactFor(manifest: unknown, agentId: string): SnapshotManifestArtifact | null {
  if (!isRecord(manifest) || manifest.schemaVersion !== 1) return null;
  const { database, artifact } = manifest;
  if (!isRecord(database) || database.role !== "agent" || database.agentId !== agentId) return null;
  if (!isRecord(artifact) || artifact.path !== SNAPSHOT_ARTIFACT_BASENAME) return null;
  if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) return null;
  if (typeof artifact.sizeBytes !== "number" || !Number.isSafeInteger(artifact.sizeBytes)) return null;
  return { sha256: artifact.sha256, sizeBytes: artifact.sizeBytes };
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function landAgentAnchor(snapshot: StagedAgentSnapshot, restoredPath: string): Promise<void> {
  const mismatch = () => new Error(`carried snapshot of ${snapshot.agentId} does not match its manifest`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(snapshot.snapshotDir, SNAPSHOT_MANIFEST_BASENAME), "utf8"));
  } catch {
    throw mismatch();
  }
  const expected = manifestArtifactFor(manifest, snapshot.agentId);
  if (!expected) throw mismatch();
  await fs.copyFile(path.join(snapshot.snapshotDir, SNAPSHOT_ARTIFACT_BASENAME), restoredPath, fs.constants.COPYFILE_EXCL);
  await fs.chmod(restoredPath, 0o600);
  const { size } = await fs.stat(restoredPath);
  if (size !== expected.sizeBytes || await sha256OfFile(restoredPath) !== expected.sha256) {
    await fs.rm(restoredPath, { force: true });
    throw mismatch();
  }
}

export interface PreparedAgentStore {
  agentId: string;
  restoredPath: string;
  destinationPath: string;
}

export interface PreparedAgentStores {
  landingRoot: string | null;
  stores: PreparedAgentStore[];
}

export async function prepareAgentStoreSnapshots(
  input: {
    signal?: AbortSignal;
    stageDir: string;
    importDir: string;
    migrationId: string;
    log?: (message: string) => void;
  },
): Promise<PreparedAgentStores> {
  const snapshots = await findStagedAgentSnapshots(input.stageDir);
  if (snapshots.length === 0) return { landingRoot: null, stores: [] };
  const importRoot = path.join(input.importDir, AGENT_IMPORT_DIRNAME);
  const landingRoot = path.join(importRoot, input.migrationId);
  await fs.mkdir(importRoot, { recursive: true, mode: 0o700 });
  await fs.rm(landingRoot, { recursive: true, force: true });
  await fs.mkdir(landingRoot, { mode: 0o700 });
  const stores = await mapConcurrently(snapshots, async (snapshot) => {
    const restoredDir = path.join(landingRoot, ...snapshot.agentDir.split("/"));
    await fs.mkdir(restoredDir, { recursive: true, mode: 0o700 });
    const restoredPath = path.join(restoredDir, AGENT_STORE_BASENAME);
    const artifact = path.join(snapshot.snapshotDir, SNAPSHOT_ARTIFACT_BASENAME);
    const anchor = readPostgresAgentAnchor(artifact);
    input.signal?.throwIfAborted();
    if (!anchor) throw new Error("SQLite agent handoff is unsupported after the PostgreSQL cutover");
    await landAgentAnchor(snapshot, restoredPath);
    await fs.rm(path.dirname(snapshot.snapshotDir), { recursive: true, force: true });
    const store: PreparedAgentStore = {
      agentId: snapshot.agentId,
      restoredPath,
      destinationPath: path.join(input.importDir, ...snapshot.agentDir.split("/"), AGENT_STORE_BASENAME),
    };
    return store;
  });
  input.log?.(`[agent-store-snapshot] restored ${stores.length} carried agent database(s)`);
  return { landingRoot, stores };
}

async function existingFamilyFiles(databasePath: string): Promise<string[]> {
  const existing: string[] = [];
  for (const file of sqliteFamily(databasePath)) {
    try {
      await fs.lstat(file);
      existing.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return existing;
}

export async function installPreparedAgentStores(input: {
  prepared: PreparedAgentStores;
  releaseAgent: (agentId: string) => Promise<void>;
  procRoot: string;
  log?: (message: string) => void;
}): Promise<void> {
  for (const store of input.prepared.stores) {
    const occupied = await existingFamilyFiles(store.destinationPath);
    if (occupied.length > 0) {
      input.log?.(`[agent-store-snapshot] releasing ${store.agentId} before replacing its database`);
      await input.releaseAgent(store.agentId);
      const family = sqliteFamily(store.destinationPath);
      const destination = readPostgresAgentAnchor(store.destinationPath);
      const incoming = readPostgresAgentAnchor(store.restoredPath);
      const sameAnchor = destination !== null && incoming !== null &&
        destination.storeId === incoming.storeId && destination.schema === incoming.schema;
      await assertNotHeld(matchFiles(family), input.procRoot, { ignoreReadOnlyConnections: sameAnchor });
      if (sameAnchor) await assertNotHeld(matchFiles(family.slice(1)), input.procRoot);
      for (const file of family) await fs.rm(file, { force: true });
    }
    await fs.mkdir(path.dirname(store.destinationPath), { recursive: true, mode: 0o700 });
    await fs.rename(store.restoredPath, store.destinationPath);
    await fs.chmod(store.destinationPath, 0o600);
  }
  if (input.prepared.landingRoot) await fs.rm(input.prepared.landingRoot, { recursive: true, force: true });
}

export function isAgentSnapshotArtifact(storePath: string): boolean {
  return storePath.split(path.sep).includes(AGENT_SNAPSHOT_DIRNAME);
}
