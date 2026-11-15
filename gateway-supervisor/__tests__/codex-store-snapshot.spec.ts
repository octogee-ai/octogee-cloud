import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exportCodexStoreSnapshots, installCodexStoreSnapshots, isCodexDatabase, omitRawCodexDatabases, prepareCodexStoreSnapshots } from "../lib/codex-store-snapshot.js";
import { sourceTransferRsyncArgs } from "../lib/source-transfer-rsync.js";

const roots: string[] = [];
const home = "agents/octogee-alice-coach/agent/codex-home";
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-snapshot-")));
  roots.push(root);
  const source = path.join(root, "source"), stage = path.join(root, "stage"), target = path.join(root, "target"), proc = path.join(root, "proc");
  for (const p of [source, stage, target]) await fs.mkdir(path.join(p, home), { recursive: true });
  await fs.mkdir(proc);
  const sources = [{ cwd: source, path: "agents/octogee-alice-coach" }];
  const log = vi.fn();
  return { root, source, stage, target, proc, sources, log, exportRoot: stage };
}
function database(file: string, value = "goal state") {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE goals(value TEXT)");
  db.prepare("INSERT INTO goals VALUES (?)").run(value);
  return db;
}
async function install(f: Awaited<ReturnType<typeof fixture>>) {
  const prepared = await prepareCodexStoreSnapshots(f.stage);
  await installCodexStoreSnapshots({ prepared, importDir: f.target, procRoot: f.proc, log: f.log });
}

it("backs up committed WAL contents, restores verified state, and leaves the live source untouched", async () => {
  const f = await fixture(), file = path.join(f.source, home, "goals_1.sqlite");
  const db = database(file);
  try {
    const before = await fs.readFile(file), wal = await fs.readFile(`${file}-wal`);
    const carried = await exportCodexStoreSnapshots(f);
    expect(carried).toHaveLength(1);
    await install(f);
    const restored = new DatabaseSync(path.join(f.target, home, "goals_1.sqlite"), { readOnly: true });
    expect(restored.prepare("SELECT value FROM goals").get()?.value).toBe("goal state");
    restored.close();
    expect(await fs.readFile(file)).toEqual(before);
    expect(await fs.readFile(`${file}-wal`)).toEqual(wal);
    expect((await fs.stat(path.join(f.target, home, "goals_1.sqlite"))).mode & 0o777).toBe(0o600);
  } finally { db.close(); }
});

it("omits a corrupt optional database without preventing a healthy database from transferring", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.source, home, "goals_1.sqlite"), "not a database");
  database(path.join(f.source, home, "state_5.sqlite")).close();
  await exportCodexStoreSnapshots(f);
  await install(f);
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("omitted optional database " + home + "/goals_1.sqlite"));
  await expect(fs.stat(path.join(f.target, home, "goals_1.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.stat(path.join(f.target, home, "state_5.sqlite"))).toBeTruthy();
});

it("bounds a locked optional database attempt and continues without a partial artifact", async () => {
  const f = await fixture(), file = path.join(f.source, home, "goals_1.sqlite");
  const db = database(file);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
  try {
    const started = Date.now();
    expect(await exportCodexStoreSnapshots({ ...f, timeoutMs: 150 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining("omitted optional database"));
    expect(await fs.readdir(path.join(f.stage, home, ".octogee-codex-snapshots"))).toEqual([]);
  } finally { db.exec("ROLLBACK"); db.close(); }
});

it("uses a total time budget and preserves cancellation as an operation failure", async () => {
  const f = await fixture();
  database(path.join(f.source, home, "goals_1.sqlite")).close();
  expect(await exportCodexStoreSnapshots({ ...f, timeoutMs: 0 })).toEqual([]);
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("time budget exhausted"));
  await expect(exportCodexStoreSnapshots({ ...f, signal: AbortSignal.abort() })).rejects.toThrow();
});

it("omits oversized and symlinked optional databases without reading outside the managed home", async () => {
  const f = await fixture();
  const file = path.join(f.source, home, "goals_1.sqlite");
  await fs.writeFile(file, "");
  await fs.truncate(file, 65 * 1024 ** 2);
  expect(await exportCodexStoreSnapshots(f)).toEqual([]);
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("exceeds optional byte budget"));
  const outside = path.join(f.root, "outside.sqlite");
  database(outside).close();
  await fs.rm(file);
  await fs.symlink(outside, file);
  expect(await exportCodexStoreSnapshots(f)).toEqual([]);
});

it("skips an altered optional snapshot and preserves existing destination state", async () => {
  const f = await fixture();
  database(path.join(f.source, home, "goals_1.sqlite"), "incoming").close();
  database(path.join(f.target, home, "goals_1.sqlite"), "retained").close();
  await exportCodexStoreSnapshots(f);
  const artifact = path.join(f.stage, home, ".octogee-codex-snapshots/goals_1.sqlite.backup");
  const corrupt = new DatabaseSync(artifact); corrupt.exec("DELETE FROM goals"); corrupt.close();
  await install(f);
  const db = new DatabaseSync(path.join(f.target, home, "goals_1.sqlite"));
  expect(db.prepare("SELECT value FROM goals").get()?.value).toBe("retained"); db.close();
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("checksum mismatch"));
});

it("skips an optional snapshot with a symlinked manifest", async () => {
  const f = await fixture();
  database(path.join(f.source, home, "goals_1.sqlite")).close();
  await exportCodexStoreSnapshots(f);
  const filename = path.join(f.stage, home, ".octogee-codex-snapshots/goals_1.sqlite.backup.json");
  const outside = path.join(f.root, "manifest.json");
  await fs.rename(filename, outside);
  await fs.symlink(outside, filename);

  await install(f);

  await expect(fs.stat(path.join(f.target, home, "goals_1.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("omitted optional database"));
});

it("does not replace an optional database still held by a destination process", async () => {
  const f = await fixture(), destination = path.join(f.target, home, "goals_1.sqlite");
  database(path.join(f.source, home, "goals_1.sqlite"), "incoming").close();
  database(destination, "retained").close();
  await fs.mkdir(path.join(f.proc, "123/fd"), { recursive: true });
  await fs.symlink(destination, path.join(f.proc, "123/fd/4"));
  await exportCodexStoreSnapshots(f); await install(f);
  const db = new DatabaseSync(destination); expect(db.prepare("SELECT value FROM goals").get()?.value).toBe("retained"); db.close();
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("still held open"));
});

it("retains an existing destination journal rather than risking its committed state", async () => {
  const f = await fixture(), destination = path.join(f.target, home, "goals_1.sqlite");
  database(path.join(f.source, home, "goals_1.sqlite"), "incoming").close();
  database(destination, "retained").close();
  const before = await fs.readFile(destination);
  await fs.writeFile(`${destination}-wal`, "retained committed journal");
  await exportCodexStoreSnapshots(f); await install(f);
  expect(await fs.readFile(destination)).toEqual(before);
  expect(await fs.readFile(`${destination}-wal`, "utf8")).toBe("retained committed journal");
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("leaving its family untouched"));
});

it("logs and skips optional snapshot I/O failures", async () => {
  const f = await fixture();
  database(path.join(f.source, home, "goals_1.sqlite")).close();
  await exportCodexStoreSnapshots(f);
  const prepared = await prepareCodexStoreSnapshots(f.stage, f.log);
  expect(prepared).not.toBeNull();
  await fs.rm(prepared!.root, { recursive: true });
  await expect(installCodexStoreSnapshots({ prepared, importDir: f.target, procRoot: f.proc, log: f.log })).resolves.toBeUndefined();
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("omitted optional database"));
  const invalid = path.join(f.stage, home, ".octogee-codex-snapshots");
  await fs.writeFile(invalid, "invalid snapshot directory");
  expect(await prepareCodexStoreSnapshots(f.stage, f.log)).toBeNull();
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("invalid Codex snapshot directory"));
});

it("excludes only managed Codex database families from rsync and keeps credentials, transcripts and project databases", async () => {
  const f = await fixture();
  for (const name of ["goals_1.sqlite", "goals_1.sqlite-wal", "goals_1.sqlite-shm", "goals_1.sqlite-journal", "auth.json", "session.jsonl"]) await fs.writeFile(path.join(f.source, home, name), "fixture");
  await fs.mkdir(path.join(f.source, "customers/alice/project"), { recursive: true });
  await fs.writeFile(path.join(f.source, "customers/alice/project/data.sqlite"), "user database");
  const sources = [...f.sources, { cwd: f.source, path: "customers/alice" }];
  const args = sourceTransferRsyncArgs(sources, "/unused", "unused").filter(x => x.startsWith("--exclude="));
  execFileSync("rsync", ["-a", "--relative", ...args, ...sources.map(s => s.path), `${f.target}/`], { cwd: f.source });
  expect(await fs.readdir(path.join(f.target, home))).toEqual(["auth.json", "session.jsonl"]);
  expect(await fs.readFile(path.join(f.target, "customers/alice/project/data.sqlite"), "utf8")).toBe("user database");
  expect(isCodexDatabase("agents/a/agent/openclaw-agent.sqlite")).toBe(false);
  expect(isCodexDatabase(`${home}/openclaw-agent.sqlite`)).toBe(false);
  expect(isCodexDatabase("customers/alice/project/data.sqlite")).toBe(false);
});

it("strips unverified received Codex families without touching required OpenClaw state", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.stage, home, "goals_1.sqlite"), "raw");
  await fs.writeFile(path.join(f.stage, home, "goals_1.sqlite-wal"), "raw journal");
  const required = path.join(f.stage, home, "..", "openclaw-agent.sqlite");
  await fs.writeFile(required, "required");
  await omitRawCodexDatabases(f.stage, f.log);
  expect(await fs.readdir(path.join(f.stage, home))).toEqual([]);
  expect(await fs.readFile(required, "utf8")).toBe("required");
});

it("does not export retained Codex temporary helpers while preserving durable homes and workspace context", async () => {
  const f = await fixture();
  const temporary = path.join(f.source, home, "tmp/arg0/codex-arg0l58nfp");
  await fs.mkdir(temporary, { recursive: true });
  await fs.symlink("/usr/local/lib/node_modules/@openai/codex/bin/codex", path.join(temporary, "apply_patch"));
  for (const name of ["auth.json", "config.toml", "session.jsonl"]) await fs.writeFile(path.join(f.source, home, name), name);
  const context = "customers/alice/.codex/tmp/context.txt";
  await fs.mkdir(path.dirname(path.join(f.source, context)), { recursive: true });
  await fs.writeFile(path.join(f.source, context), "durable user context");
  const sources = [...f.sources, { cwd: f.source, path: "customers/alice" }];
  const args = sourceTransferRsyncArgs(sources, "/unused", "unused").filter(arg => arg.startsWith("--exclude="));
  execFileSync("rsync", ["-a", "--relative", ...args, ...sources.map(source => source.path), `${f.target}/`], { cwd: f.source });
  await expect(fs.lstat(path.join(f.target, home, "tmp"))).rejects.toMatchObject({ code: "ENOENT" });
  for (const name of ["auth.json", "config.toml", "session.jsonl"]) expect(await fs.readFile(path.join(f.target, home, name), "utf8")).toBe(name);
  expect(await fs.readFile(path.join(f.target, context), "utf8")).toBe("durable user context");
  expect(await fs.readlink(path.join(temporary, "apply_patch"))).toBe("/usr/local/lib/node_modules/@openai/codex/bin/codex");
});
