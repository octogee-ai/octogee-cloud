import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { localStateStoreKind, localStateStorePath, openclawStateRoot } from "../lib/openclaw-state-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stateRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-store-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "state"));
  return root;
}

describe("openclawStateRoot", () => {
  it("prefers OPENCLAW_STATE_DIR, then OPENCLAW_DIR, then the home default", () => {
    expect(openclawStateRoot({ OPENCLAW_STATE_DIR: " /s ", OPENCLAW_DIR: "/o" })).toBe("/s");
    expect(openclawStateRoot({ OPENCLAW_DIR: "/o" })).toBe("/o");
    expect(openclawStateRoot({ HOME: "/home/u" })).toBe("/home/u/.openclaw");
  });
});

describe("localStateStoreKind", () => {
  it("tells an absent store, a PostgreSQL anchor and SQLite state data apart", () => {
    const root = stateRoot();
    const file = localStateStorePath(root);
    expect(localStateStoreKind(file)).toBe("absent");

    const anchor = new DatabaseSync(file);
    anchor.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)");
    anchor.prepare("INSERT INTO openclaw_engine_anchor VALUES ('92c817cc-770f-466d-b4a6-4e9b02998363', 'postgres', 'octogee_state_92c817cc770f466d')").run();
    anchor.close();
    expect(localStateStoreKind(file)).toBe("anchor");

    fs.rmSync(file);
    const sqlite = new DatabaseSync(file);
    sqlite.exec("CREATE TABLE cron_jobs (id TEXT)");
    sqlite.close();
    expect(localStateStoreKind(file)).toBe("sqlite");
  });
});
