import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenClawSqliteJournals } from "../lib/openclaw-sqlite-journal-preflight.js";
import { buildSafeDefaultAgent, SAFE_DEFAULT_AGENT_ID } from "../lib/openclaw-config-users.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function stateRoot(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "octogee-journal-preflight-")));
  roots.push(root);
  return root;
}
function store(root: string, relative: string): string {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE durable_state(value TEXT); INSERT INTO durable_state VALUES ('keep-me');");
  db.close();
  return filename;
}
function readStore(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return { mode: db.prepare("PRAGMA journal_mode").get()?.journal_mode, values: db.prepare("SELECT value FROM durable_state").all() }; }
  finally { db.close(); }
}
const nineP = () => 0x01021997;

describe("OpenClaw quiescent journal preflight", () => {
  it.each(["list", "entries"])("prepares the generated safe default agent's existing store with an omitted agentDir in agents.%s", (format) => {
    const root = stateRoot(), agent = buildSafeDefaultAgent();
    expect(Object.hasOwn(agent, "agentDir")).toBe(false);
    const filename = store(root, `agents/${SAFE_DEFAULT_AGENT_ID}/agent/openclaw-agent.sqlite`);
    const custom = store(root, "agents/coach/runtime/openclaw-agent.sqlite");
    const coach = { id: "coach", agentDir: path.dirname(custom) };
    const agents = format === "list" ? { list: [agent, coach] } : { entries: { [SAFE_DEFAULT_AGENT_ID]: agent, coach } };
    fs.writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({ agents }));
    expect(prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: nineP }).converted).toEqual([filename, custom]);
    for (const storePath of [filename, custom]) expect(readStore(storePath)).toEqual({ mode: "delete", values: [{ value: "keep-me" }] });
  });

  it.each(["", null, 12])("keeps an explicitly malformed agentDir strict: %s", (agentDir) => {
    const root = stateRoot(), filename = store(root, "agents/coach/agent/openclaw-agent.sqlite");
    fs.writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({ agents: { list: [{ id: "coach", agentDir }] } }));
    expect(() => prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: nineP })).toThrow(/agentDir must be a non-empty string/);
    expect(readStore(filename).mode).toBe("wal");
  });

  it("fails on corrupt existing state for the generated default agent without an explicit directory", () => {
    const root = stateRoot(), filename = path.join(root, "agents", SAFE_DEFAULT_AGENT_ID, "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const corrupt = Buffer.from("not a sqlite database"); fs.writeFileSync(filename, corrupt);
    fs.writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({ agents: { list: [buildSafeDefaultAgent()] } }));
    expect(() => prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: nineP })).toThrow(/not a database/);
    expect(fs.readFileSync(filename)).toEqual(corrupt);
  });

  it("converts global and agent WAL stores before readers and preserves durable rows", () => {
    const root = stateRoot();
    const global = store(root, "state/openclaw.sqlite");
    const quarantine = store(root, "state/openclaw-quarantine.sqlite");
    const agent = store(root, "agents/octogee-unmatched-route/agent/openclaw-agent.sqlite");
    const codex = path.join(root, "agents/octogee-unmatched-route/agent/codex-home/state_5.sqlite");
    fs.mkdirSync(path.dirname(codex), { recursive: true }); fs.writeFileSync(codex, "non-Octogee database");
    const result = prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: nineP });
    expect(result.converted).toEqual([global, quarantine, agent]);
    for (const filename of [global, quarantine, agent]) expect(readStore(filename)).toEqual({ mode: "delete", values: [{ value: "keep-me" }] });
    expect(fs.readFileSync(codex, "utf8")).toBe("non-Octogee database");
    expect(prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: nineP }).converted).toEqual([]);
  });

  it("prepares explicit canonical agent directories through a state-root alias", () => {
    const root = stateRoot(), aliasRoot = stateRoot(), alias = path.join(aliasRoot, "state-link");
    fs.symlinkSync(root, alias);
    const filename = store(root, "agents/operator/runtime/openclaw-agent.sqlite");
    fs.writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({ agents: { list: [
      { id: "operator", agentDir: path.join(alias, "agents/operator/runtime"), workspace: "/work/materialized/project" },
    ] } }));
    expect(prepareOpenClawSqliteJournals({ stateDir: alias, filesystemType: nineP }).converted).toEqual([filename]);
    expect(readStore(filename).values).toEqual([{ value: "keep-me" }]);
  });

  it("leaves native local filesystems in WAL mode", () => {
    const root = stateRoot(), filename = store(root, "agents/octogee-coach/agent/openclaw-agent.sqlite");
    expect(prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: () => 0xef53 }).converted).toEqual([]);
    expect(readStore(filename).mode).toBe("wal");
  });

  it("fails while a retained WAL reader prevents conversion and succeeds once it closes", () => {
    const root = stateRoot(), filename = store(root, "agents/octogee-unmatched-route/agent/openclaw-agent.sqlite");
    const reader = new DatabaseSync(filename, { readOnly: true });
    reader.prepare("SELECT value FROM durable_state").all();
    try {
      expect(() => prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: nineP, busyTimeoutMs: 1 })).toThrow(/locked/);
      expect(reader.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    } finally { reader.close(); }
    expect(prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: nineP }).converted).toEqual([filename]);
    expect(readStore(filename).values).toEqual([{ value: "keep-me" }]);
  });

  it("keeps malformed OpenClaw state strict and preserves its bytes", () => {
    const root = stateRoot(), filename = path.join(root, "state/openclaw.sqlite");
    fs.mkdirSync(path.dirname(filename)); const corrupt = Buffer.from("not a sqlite database"); fs.writeFileSync(filename, corrupt);
    expect(() => prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: nineP })).toThrow();
    expect(fs.readFileSync(filename)).toEqual(corrupt);
  });

  it("rejects aliases to files outside the owned state root", () => {
    const root = stateRoot(), other = stateRoot(), outside = store(other, "openclaw.sqlite");
    fs.mkdirSync(path.join(root, "state")); fs.symlinkSync(outside, path.join(root, "state/openclaw.sqlite"));
    expect(() => prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: nineP })).toThrow(/canonical regular/);
    expect(readStore(outside).mode).toBe("wal");
  });

  it("rejects a sidecar alias before opening or converting an owned store", () => {
    const root = stateRoot(), other = stateRoot(), filename = store(root, "state/openclaw.sqlite");
    const outside = path.join(other, "wal"); fs.writeFileSync(outside, "outside-state");
    fs.symlinkSync(outside, `${filename}-wal`);
    expect(() => prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: nineP })).toThrow(/canonical regular sidecar/);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside-state");
    fs.unlinkSync(`${filename}-wal`);
    expect(readStore(filename).mode).toBe("wal");
  });

  it("does not recreate a store that disappears before existing-file open", () => {
    const root = stateRoot(), filename = store(root, "state/openclaw.sqlite");
    expect(() => prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: () => {
      fs.unlinkSync(filename); return nineP();
    } })).toThrow(/unable to open/);
    expect(fs.existsSync(filename)).toBe(false);
  });

  it("does not create stores in an empty state root", () => {
    const root = stateRoot();
    expect(prepareOpenClawSqliteJournals({ stateDir: root, filesystemType: nineP }).converted).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
