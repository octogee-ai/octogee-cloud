import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  clearSqliteSidecars,
  findUnreadableStore,
  isSqliteVolatileArtifactPath,
  listSqliteStores,
  SQLITE_CARRY_EXCLUDE_ARGS,
  SQLITE_SIDECAR_EXCLUDE_ARGS,
} from "../lib/agent-store-carry.js";

let root: string;

function agentDir(slug: string): string {
  return path.join(root, "agents", `octogee-${slug}-coach`, "agent");
}

function storePath(slug: string): string {
  return path.join(agentDir(slug), "openclaw-agent.sqlite");
}

function seedStore(slug: string, rows: readonly string[]): string {
  fs.mkdirSync(agentDir(slug), { recursive: true });
  const dbPath = storePath(slug);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE IF NOT EXISTS transcript_events(body TEXT)");
  for (const row of rows) db.prepare("INSERT INTO transcript_events VALUES (?)").run(row);
  db.close();
  return dbPath;
}

function appendRows(dbPath: string, rows: readonly string[]): Buffer {
  const db = new DatabaseSync(dbPath);
  for (const row of rows) db.prepare("INSERT INTO transcript_events VALUES (?)").run(row);
  const wal = fs.readFileSync(`${dbPath}-wal`);
  db.close();
  return wal;
}

function readRowCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT count(*) AS c FROM transcript_events").get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-store-carry-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("listSqliteStores", () => {
  it("finds nested stores and ignores their wal/shm siblings", async () => {
    const dbPath = seedStore("chris", ["a"]);
    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(64));
    fs.writeFileSync(`${dbPath}-shm`, Buffer.alloc(64));

    expect(await listSqliteStores(root)).toEqual([dbPath]);
  });

  it("ignores openclaw's volatile reindex and generation artifacts beside a store", async () => {
    const dbPath = seedStore("chris", ["a"]);
    for (const name of [
      "openclaw-agent.sqlite.reindex-lock.sqlite",
      "openclaw-agent.sqlite.reindex-lock.sqlite-journal",
      "openclaw-agent.sqlite.generation-lock.sqlite",
      "openclaw-agent.sqlite.generation-writer.sqlite",
      "openclaw-agent.sqlite.memory-reindex-611ae28b-1ffd-43f7-b70f-2b7682886f4d",
      "openclaw-agent.sqlite.memory-reindex-611ae28b-1ffd-43f7-b70f-2b7682886f4d-wal",
      "openclaw-agent.sqlite.backup-611ae28b-1ffd-43f7-b70f-2b7682886f4d",
    ]) {
      fs.writeFileSync(path.join(agentDir("chris"), name), Buffer.alloc(64));
    }
    expect(await listSqliteStores(root)).toEqual([dbPath]);
  });

  it("ignores openclaw doctor's retained pre-migration backups beside a store", async () => {
    const dbPath = seedStore("chris", ["a"]);
    const stamp = "pre-startup-migration-331ddc36-f8a4-4c66-bd6b-e0c626343f93";
    const backupDir = path.join(agentDir("chris"), `openclaw-agent.sqlite.${stamp}.postgres.bak`);
    fs.mkdirSync(backupDir);
    for (const name of ["anchor.sqlite", "database.sqlite", "manifest.json"]) {
      fs.writeFileSync(path.join(backupDir, name), Buffer.alloc(64));
    }
    fs.writeFileSync(path.join(agentDir("chris"), `openclaw-agent.sqlite.${stamp}.bak`), Buffer.alloc(64));
    fs.writeFileSync(path.join(agentDir("chris"), `openclaw-agent.sqlite.${stamp}.scoped.bak`), Buffer.alloc(64));

    expect(await listSqliteStores(root)).toEqual([dbPath]);
  });

  it("returns nothing for a path that does not exist", async () => {
    expect(await listSqliteStores(path.join(root, "absent"))).toEqual([]);
  });
});

describe("findUnreadableStore", () => {
  it("names a carried store that does not open", async () => {
    fs.mkdirSync(agentDir("chris"), { recursive: true });
    const carried = storePath("chris");
    fs.writeFileSync(carried, "this is not a database");

    const unreadable = await findUnreadableStore({
      storePaths: [carried],
      relativeTo: root,
    });

    expect(unreadable?.path).toBe(
      path.join("agents", "octogee-chris-coach", "agent", "openclaw-agent.sqlite"),
    );
  });

  it("passes a store carried without sidecars", async () => {
    const carried = seedStore("chris", ["one", "two"]);

    expect(await findUnreadableStore({ storePaths: [carried], relativeTo: root })).toBeNull();
  });
});

describe("clearSqliteSidecars", () => {
  it("removes a stale wal that would otherwise replay over the carried file", async () => {
    const carried = seedStore("chris", ["one"]);
    const staleWal = appendRows(carried, ["two"]);
    appendRows(carried, ["three", "four", "five"]);
    const leftAlone = seedStore("dana", []);
    fs.copyFileSync(carried, leftAlone);
    fs.writeFileSync(`${leftAlone}-wal`, staleWal);
    fs.writeFileSync(`${carried}-wal`, staleWal);
    fs.writeFileSync(`${carried}-shm`, Buffer.alloc(32768));

    const removed = await clearSqliteSidecars([carried]);

    expect(removed).toEqual([`${carried}-wal`, `${carried}-shm`]);
    expect(readRowCount(carried)).toBe(5);
    expect(readRowCount(leftAlone)).toBeLessThan(5);
  });
});

describe("SQLITE_SIDECAR_EXCLUDE_ARGS", () => {
  it("excludes both sidecar suffixes from a copy set", () => {
    expect(SQLITE_SIDECAR_EXCLUDE_ARGS).toEqual([
      "--exclude=*.sqlite-wal",
      "--exclude=*.sqlite-shm",
    ]);
  });
});

describe("SQLITE_CARRY_EXCLUDE_ARGS", () => {
  it("excludes the sidecars and openclaw's exact volatile shapes from a copy set", () => {
    const uuid = "????????-????-????-????-????????????";
    expect(SQLITE_CARRY_EXCLUDE_ARGS).toEqual([
      ...SQLITE_SIDECAR_EXCLUDE_ARGS,
      "--exclude=*.sqlite.reindex-lock.sqlite*",
      "--exclude=*.sqlite.generation-lock.sqlite*",
      "--exclude=*.sqlite.generation-writer.sqlite*",
      `--exclude=*.sqlite.memory-reindex-${uuid}*`,
      `--exclude=*.sqlite.backup-${uuid}*`,
      `--exclude=*.sqlite.tmp-${uuid}*`,
      `--exclude=*.sqlite.pre-startup-migration-${uuid}*`,
    ]);
  });
});

describe("isSqliteVolatileArtifactPath", () => {
  it("matches only openclaw's uuid-stamped temp copies, never a workspace file that resembles one", () => {
    expect(isSqliteVolatileArtifactPath("openclaw-agent.sqlite.backup-611ae28b-1ffd-43f7-b70f-2b7682886f4d")).toBe(true);
    expect(isSqliteVolatileArtifactPath("openclaw-agent.sqlite.memory-reindex-611ae28b-1ffd-43f7-b70f-2b7682886f4d-wal")).toBe(true);
    expect(isSqliteVolatileArtifactPath("openclaw-agent.sqlite.reindex-lock.sqlite-journal")).toBe(true);
    expect(isSqliteVolatileArtifactPath("cache.sqlite.backup-2026")).toBe(false);
    expect(isSqliteVolatileArtifactPath("notes.sqlite.tmp-draft")).toBe(false);
    expect(isSqliteVolatileArtifactPath("openclaw-agent.sqlite")).toBe(false);
  });
});
