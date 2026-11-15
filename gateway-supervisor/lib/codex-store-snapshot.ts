import { isCodexDatabase } from "@octogee/core/agent-store-inventory";
export { isCodexDatabase } from "@octogee/core/agent-store-inventory";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { listSqliteStores } from "./agent-store-carry.js";
import { assertNotHeld, matchFiles, sqliteFamily } from "./held-files.js";

const exec = promisify(execFile);
const SNAPSHOTS = ".octogee-codex-snapshots";
export const CODEX_SNAPSHOT_EXCLUDE_ARG = `--exclude=/agents/*/agent/codex-home/${SNAPSHOTS}`;
export const CODEX_TEMP_EXCLUDE_ARG = "--exclude=/agents/*/agent/codex-home/tmp";
const BUDGET_MS = 5_000;
const MAX_BYTES = 64 * 1024 ** 2;
const MAX_TOTAL_BYTES = 128 * 1024 ** 2;
const MAX_STORES = 32;
type Log = (message: string) => void;
type Source = { cwd: string; path: string };
interface Artifact { sha256: string; size: number }
interface Options { log?: Log; signal?: AbortSignal; timeoutMs?: number }



export function isCodexTemporaryDirectory(relative: string): boolean {
  const parts = relative.split("/");
  return parts.length === 5 && parts[0] === "agents" && !!parts[1] &&
    parts[2] === "agent" && parts[3] === "codex-home" && parts[4] === "tmp";
}

export const CODEX_STORE_EXCLUDE_ARGS = ["", "-wal", "-shm", "-journal"].map(
  suffix => `--exclude=/agents/*/agent/codex-home/*.sqlite${suffix}`,
);

const WORKER = String.raw`
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, stat } from 'node:fs/promises';
const [source, target, max] = process.argv.slice(1);
const limit = Number(max);
if ((await stat(source)).size > limit) throw Error('database exceeds optional byte budget');
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec('PRAGMA busy_timeout=100');
  const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
  if (Number(db.prepare('PRAGMA page_count').get().page_count) * pageSize > limit) throw Error('database exceeds optional byte budget');
  if (target) await backup(db, target, { progress: ({ totalPages }) => {
    if (totalPages * pageSize > limit) throw Error('database exceeds optional byte budget');
  }});
} finally { db.close(); }
const file = target || source;
const verify = new DatabaseSync(file, { readOnly: true });
try {
  verify.exec('PRAGMA busy_timeout=100');
  if (verify.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok') throw Error('optional database integrity check failed');
} finally { verify.close(); }
const size = (await stat(file)).size;
if (size > limit) throw Error('database exceeds optional byte budget');
if (target) await chmod(target, 0o600);
const hash = createHash('sha256');
for await (const chunk of createReadStream(file)) hash.update(chunk);
process.stdout.write(JSON.stringify({ sha256: hash.digest('hex'), size }));
`;

function omitted(log: Log, relative: string, error: unknown): void {
  const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
  log(`[codex-store-snapshot] omitted optional database ${relative}: ${reason.slice(0, 240)}`);
}

async function removeOptional(file: string, log: Log): Promise<void> {
  try { await fs.rm(file, { recursive: true, force: true }); }
  catch (error) { omitted(log, "private snapshot staging cleanup", error); }
}

async function canonical(file: string): Promise<void> {
  if (await fs.realpath(file) !== path.resolve(file)) throw new Error("optional database path is not canonical");
  if (!(await fs.lstat(file)).isFile()) throw new Error("optional database is not a regular file");
}

async function runWorker(source: string, target: string, deadline: number, remainingBytes: number, signal?: AbortSignal): Promise<Artifact> {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new Error("optional database time budget exhausted");
  if (remainingBytes <= 0) throw new Error("optional database byte budget exhausted");
  await canonical(source);
  try {
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", WORKER, source, target, String(Math.min(MAX_BYTES, remainingBytes))], {
      timeout, killSignal: "SIGKILL", maxBuffer: 8192, signal,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_NO_WARNINGS: "1", UV_THREADPOOL_SIZE: "1", NODE_OPTIONS: "--jitless --max-old-space-size=64 --max-semi-space-size=4 --v8-pool-size=1" },
    });
    return JSON.parse(stdout) as Artifact;
  } catch (error) {
    signal?.throwIfAborted();
    const failure = error as { killed?: boolean; stderr?: string; code?: string };
    throw new Error(failure.killed ? "optional database time budget exhausted" :
      /(?:^|\n)(?:\w*Error)(?: \[[^\]]+\])?: ([^\n]+)/.exec(failure.stderr ?? "")?.[1] ??
      `optional database worker failed (${failure.code ?? "unknown"})`);
  }
}

export async function exportCodexStoreSnapshots(input: Options & { sources: readonly Source[]; exportRoot: string }): Promise<Source[]> {
  const log = input.log ?? console.warn;
  const deadline = Date.now() + (input.timeoutMs ?? BUDGET_MS);
  const directories = new Set<string>();
  let bytes = 0, count = 0;
  const visited = new Set<string>();
  for (const source of input.sources) {
    for (const file of await listSqliteStores(path.join(source.cwd, source.path))) {
      const relative = path.relative(source.cwd, file).split(path.sep).join("/");
      if (!isCodexDatabase(relative) || visited.has(relative)) continue;
      visited.add(relative);
      input.signal?.throwIfAborted();
      const directory = path.posix.join(path.posix.dirname(relative), SNAPSHOTS);
      const basename = path.posix.basename(relative);
      const output = path.join(input.exportRoot, directory, `${basename}.backup`);
      try {
        if (++count > MAX_STORES) throw new Error("optional database count budget exhausted");
        await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        const artifact = await runWorker(file, output, deadline, MAX_TOTAL_BYTES - bytes, input.signal);
        await fs.writeFile(`${output}.json`, JSON.stringify(artifact), { mode: 0o600 });
        bytes += artifact.size;
        directories.add(directory);
        log(`[codex-store-snapshot] preserved optional database ${relative} (${artifact.size} bytes)`);
      } catch (error) {
        for (const part of [...sqliteFamily(output), `${output}.json`]) await removeOptional(part, log);
        input.signal?.throwIfAborted();
        omitted(log, relative, error);
      }
    }
  }
  return [...directories].map(relative => ({ cwd: input.exportRoot, path: relative }));
}

async function codexHomes(root: string): Promise<string[]> {
  root = await fs.realpath(root);
  const agents = await fs.readdir(path.join(root, "agents"), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const homes: string[] = [];
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const relative = `agents/${agent.name}/agent/codex-home`;
    const home = path.join(root, relative);
    try {
      if ((await fs.lstat(home)).isDirectory() && await fs.realpath(home) === home) homes.push(relative);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return homes;
}

export async function omitStagedCodexTemporaryFiles(stageDir: string, log: Log): Promise<void> {
  for (const home of await codexHomes(stageDir)) {
    const relative = `${home}/tmp`;
    const temporary = path.join(stageDir, relative);
    try { await fs.lstat(temporary); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await fs.rm(temporary, { recursive: true, force: true });
    log(`[migration-rsync] omitted staged Codex temporary files: ${relative}`);
  }
}

export async function omitRawCodexDatabases(stageDir: string, log: Log): Promise<void> {
  for (const home of await codexHomes(stageDir)) {
    for (const entry of await fs.readdir(path.join(stageDir, home))) {
      const base = entry.replace(/-(?:wal|shm|journal)$/, "");
      if (!isCodexDatabase(`${home}/${base}`)) continue;
      try { await fs.rm(path.join(stageDir, home, entry), { force: true }); }
      catch (error) { omitted(log, `${home}/${entry}`, error); }
      omitted(log, `${home}/${entry}`, new Error("raw database family excluded from import"));
    }
  }
}

export interface PreparedCodexSnapshots { root: string; homes: string[] }

export async function discardCodexStoreSnapshots(prepared: PreparedCodexSnapshots | null, log: Log): Promise<void> {
  if (!prepared) return;
  await removeOptional(prepared.root, log);
}

export async function prepareCodexStoreSnapshots(stageDir: string, log: Log = console.warn): Promise<PreparedCodexSnapshots | null> {
  stageDir = await fs.realpath(stageDir);
  let root: string | null = null;
  const homes: string[] = [];
  for (const home of await codexHomes(stageDir)) {
    const directory = path.join(stageDir, home, SNAPSHOTS);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || await fs.realpath(directory) !== directory) throw new Error("invalid Codex snapshot directory");
      root ??= await fs.mkdtemp(path.join(path.dirname(stageDir), "codex-import-"));
      const destination = path.join(root, home);
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      await fs.rename(directory, path.join(destination, SNAPSHOTS));
      homes.push(home);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") omitted(log, home, error);
    }
  }
  return root ? { root, homes } : null;
}

interface ImportContext {
  importDir: string;
  procRoot: string;
  deadline: number;
  bytes: number;
  count: number;
  log: Log;
  signal?: AbortSignal;
}

async function assertNoRetainedJournal(destination: string): Promise<void> {
  for (const suffix of ["-wal", "-journal"]) {
    const stat = await fs.lstat(`${destination}${suffix}`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat && (!stat.isFile() || stat.size > 0)) throw new Error("retained optional database has a journal; leaving its family untouched");
  }
}

async function readSnapshotManifest(filename: string): Promise<Artifact> {
  const limit = 1024;
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("optional database manifest is not a regular file");
    if (stat.size > limit) throw new Error("optional database manifest too large");
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error("optional database manifest too large");
    return JSON.parse(bytes.toString("utf8", 0, size)) as Artifact;
  } finally {
    await file.close();
  }
}

async function installCodexSnapshot(context: ImportContext, directory: string, home: string, entry: string): Promise<void> {
  const basename = entry.slice(0, -7), relative = `${home}/${basename}`;
  if (++context.count > MAX_STORES) throw new Error("optional database count budget exhausted");
  if (!isCodexDatabase(relative)) throw new Error("invalid Codex snapshot database path");
  if (Date.now() >= context.deadline) throw new Error("optional database time budget exhausted");
  const file = path.join(directory, entry), manifest = `${file}.json`;
  const expected = await readSnapshotManifest(manifest);
  await canonical(file);
  if ((await fs.stat(file)).size > Math.min(MAX_BYTES, MAX_TOTAL_BYTES - context.bytes)) throw new Error("optional database exceeds byte budget");
  const destination = path.join(await fs.realpath(context.importDir), relative);
  const parent = path.dirname(destination);
  if (await fs.realpath(parent) !== parent) throw new Error("optional destination is not canonical");
  const landing = await fs.mkdtemp(path.join(parent, ".codex-import-"));
  try {
    const landed = path.join(landing, basename);
    await fs.copyFile(file, landed, fs.constants.COPYFILE_EXCL);
    await fs.chmod(landed, 0o600);
    const actual = await runWorker(landed, "", context.deadline, MAX_TOTAL_BYTES - context.bytes, context.signal);
    if (expected.sha256 !== actual.sha256 || expected.size !== actual.size) throw new Error("optional database checksum mismatch");
    context.bytes += actual.size;
    await assertNotHeld(matchFiles(sqliteFamily(destination)), context.procRoot);
    await assertNoRetainedJournal(destination);
    for (const sidecar of sqliteFamily(destination).slice(1)) await fs.rm(sidecar, { force: true });
    await fs.rename(landed, destination);
    context.log(`[codex-store-snapshot] restored optional database ${relative}`);
  } finally {
    await removeOptional(landing, context.log);
  }
}

export async function installCodexStoreSnapshots(input: Options & {
  prepared: PreparedCodexSnapshots | null; importDir: string; procRoot: string;
}): Promise<void> {
  if (!input.prepared) return;
  const context: ImportContext = {
    importDir: input.importDir, procRoot: input.procRoot, signal: input.signal,
    deadline: Date.now() + (input.timeoutMs ?? BUDGET_MS), bytes: 0, count: 0,
    log: input.log ?? console.warn,
  };
  try {
    for (const home of input.prepared.homes) {
      const directory = path.join(input.prepared.root, home, SNAPSHOTS);
      const entries = await fs.readdir(directory).catch(error => { omitted(context.log, home, error); return []; });
      for (const entry of entries.filter(entry => entry.endsWith(".backup"))) {
        input.signal?.throwIfAborted();
        try {
          await installCodexSnapshot(context, directory, home, entry);
        } catch (error) {
          input.signal?.throwIfAborted();
          omitted(context.log, `${home}/${entry.slice(0, -7)}`, error);
        }
      }
    }
  } finally {
    await discardCodexStoreSnapshots(input.prepared, context.log);
  }
}
