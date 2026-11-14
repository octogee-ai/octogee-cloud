import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const tmp: string[] = [];
const originalEnv = { ...process.env };
const postgresDsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;

function mkHome(config: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "byosub-syncback-home-"));
  tmp.push(home);
  const openclaw = path.join(home, ".openclaw");
  fs.mkdirSync(openclaw, { recursive: true });
  fs.writeFileSync(path.join(openclaw, "openclaw.json"), JSON.stringify(config));
  return home;
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("byosub-syncback-runner loadTargets", () => {
  it("does not attempt Firestore discovery on shared gateways", async () => {
    process.env.HOME = mkHome({
      agents: {
        list: [{ id: "octogee-tester19-coach" }],
      },
    });
    process.env.GATEWAY_ID = "default-green";
    process.env.GATEWAY_CLASS = "shared";

    const firebaseImport = vi.fn();
    vi.doMock("../lib/firebase.js", () => {
      firebaseImport();
      throw new Error("shared gateways must not import firebase");
    });

    const { loadTargets } = await import("../entrypoints/byosub-syncback-runner.js");

    await expect(loadTargets()).resolves.toEqual([]);
    expect(firebaseImport).not.toHaveBeenCalled();
  });
});

const DEFAULT_AGENT = "octogee-tester19-coach";
const PROJECT_AGENT = "octogee-tester19-proj-garden-coach";

const jwt = (claims: Record<string, unknown>) =>
  "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".sig";

function codexStore(refresh: string, iat: number): unknown {
  return {
    version: 1,
    profiles: {
      "openai:octogee-chatgpt": {
        type: "oauth",
        provider: "openai",
        access: jwt({ iat, exp: iat + 864_000 }),
        refresh,
        expires: (iat + 864_000) * 1000,
      },
    },
  };
}

function writeSharedStore(home: string, store: unknown): void {
  const dir = path.join(home, ".openclaw", "state");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw.sqlite"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
  );
  const upsert = db.prepare(
    "INSERT INTO config_machine_state VALUES (?, ?, 1) ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json",
  );
  upsert.run("auth.sharedStore", JSON.stringify({ location: "state-db" }));
  upsert.run("authProfiles.store", JSON.stringify(store));
  db.close();
}

function writeAgentStore(home: string, agentId: string, store: unknown): void {
  const dir = path.join(home, ".openclaw", "agents", agentId, "agent");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
  db.exec(
    "CREATE TABLE auth_profile_store (store_key TEXT NOT NULL PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  );
  db.prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)").run(JSON.stringify(store));
  db.close();
}

function writeStaleCodexHomeAuth(home: string, agentId: string): void {
  const authPath = path.join(home, ".openclaw", "agents", agentId, "agent", "codex-home", "auth.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "stale", refresh_token: "r0" } }));
}

function userHome(): string {
  const home = mkHome({
    agents: { entries: { [DEFAULT_AGENT]: {}, [PROJECT_AGENT]: {}, "../../not-an-agent": {} } },
  });
  process.env.HOME = home;
  process.env.GATEWAY_ID = "tester19-m-abc";
  process.env.GATEWAY_CLASS = "isolated";
  return home;
}

it.skipIf(!postgresDsn)("syncs rotated credentials from a PostgreSQL shared state anchor without using stale agent stores", async () => {
  const pg = createRequire(path.resolve(__dirname, "../../core/package.json"))("pg");
  const client = new pg.Client({ connectionString: postgresDsn });
  await client.connect();
  const home = userHome(), openclaw = path.join(home, ".openclaw");
  const schema = "shared_auth_" + randomUUID().replaceAll("-", ""), storeId = randomUUID();
  const table = (name: string) => `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}`;
  try {
    await client.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
    await client.query(`CREATE TABLE ${table("openclaw_schema_meta")} (store TEXT PRIMARY KEY, store_id TEXT NOT NULL)`);
    await client.query(`INSERT INTO ${table("openclaw_schema_meta")} VALUES ('state', $1)`, [storeId]);
    await client.query(`CREATE TABLE ${table("config_machine_state")} (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms BIGINT NOT NULL)`);
    await client.query(`INSERT INTO ${table("config_machine_state")} VALUES ('auth.sharedStore', $1, 1), ('authProfiles.store', $2, 1)`, [JSON.stringify({ location: "state-db" }), JSON.stringify(codexStore("r1-pg", 1_789_736_218))]);
    fs.mkdirSync(path.join(openclaw, "state"));
    const anchor = new DatabaseSync(path.join(openclaw, "state/openclaw.sqlite"));
    anchor.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)");
    anchor.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(storeId, schema); anchor.close();
    writeAgentStore(home, "main", codexStore("stale-main", 1_789_736_200));
    writeAgentStore(home, DEFAULT_AGENT, codexStore("stale-coach", 1_789_736_200));
    writeAgentStore(home, PROJECT_AGENT, codexStore("stale-project", 1_789_736_200));
    process.env.OPENCLAW_AGENT_STORE_DSN = postgresDsn;
    const { push, sweepOnce } = await loadRunner();
    const first = await sweepOnce(new Map());
    expect(pushedTokens(push).map(({ agentId, refresh }) => ({ agentId, refresh }))).toEqual([{ agentId: DEFAULT_AGENT, refresh: "r1-pg" }]);
    push.mockClear();
    const second = await sweepOnce(first.prev);
    expect(push).not.toHaveBeenCalled();
    await client.query(`UPDATE ${table("config_machine_state")} SET value_json = $1 WHERE state_key = 'authProfiles.store'`, [JSON.stringify(codexStore("r2-pg", 1_789_740_000))]);
    await sweepOnce(second.prev);
    expect(pushedTokens(push).map(({ agentId, refresh }) => ({ agentId, refresh }))).toEqual([{ agentId: DEFAULT_AGENT, refresh: "r2-pg" }]);
    push.mockClear();
    await client.query(`UPDATE ${table("openclaw_schema_meta")} SET store_id = $1 WHERE store = 'state'`, [randomUUID()]);
    await expect(sweepOnce(second.prev)).rejects.toThrow("state store identity");
    expect(push).not.toHaveBeenCalled();
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
    await client.end();
  }
});

async function loadRunner() {
  const push = vi.fn(async () => ({ changed: true, destroyed: 0 }));
  vi.doMock("../lib/byot-sync-runtime.js", () => ({ brokerPushByosubCred: push }));
  const { sweepOnce } = await import("../entrypoints/byosub-syncback-runner.js");
  return { push, sweepOnce };
}

function pushedTokens(push: ReturnType<typeof vi.fn>): Array<{ agentId: string; refresh: string; lastRefresh: string }> {
  return push.mock.calls.map(([agentId, provider, payload]) => {
    expect(provider).toBe("openai");
    const parsed = JSON.parse(payload as string);
    return { agentId: agentId as string, refresh: parsed.tokens.refresh_token, lastRefresh: parsed.last_refresh };
  });
}

describe("byosub-syncback-runner sweepOnce", () => {
  it("pushes the rotated credential from OpenClaw's shared auth store under the defaultAgent, ignoring codex-home auth.json", async () => {
    const home = userHome();
    writeStaleCodexHomeAuth(home, DEFAULT_AGENT);
    writeSharedStore(home, codexStore("r1", 1_789_736_218));
    const { push, sweepOnce } = await loadRunner();

    const first = await sweepOnce(new Map());
    expect(pushedTokens(push)).toEqual([
      { agentId: DEFAULT_AGENT, refresh: "r1", lastRefresh: "2026-09-18T12:56:58.000Z" },
    ]);

    push.mockClear();
    const second = await sweepOnce(first.prev);
    expect(push).not.toHaveBeenCalled();

    writeSharedStore(home, codexStore("r2", 1_789_740_000));
    await sweepOnce(second.prev);
    expect(pushedTokens(push)).toEqual([
      { agentId: DEFAULT_AGENT, refresh: "r2", lastRefresh: "2026-09-18T14:00:00.000Z" },
    ]);
  });

  it("reads each agent's own auth store when OpenClaw has no shared store", async () => {
    const home = userHome();
    writeStaleCodexHomeAuth(home, DEFAULT_AGENT);
    writeAgentStore(home, DEFAULT_AGENT, codexStore("r1", 1_789_736_218));
    const { push, sweepOnce } = await loadRunner();

    await sweepOnce(new Map());

    expect(pushedTokens(push)).toEqual([
      { agentId: DEFAULT_AGENT, refresh: "r1", lastRefresh: "2026-09-18T12:56:58.000Z" },
    ]);
  });

  it("pushes nothing while the auth store holds no ChatGPT credential", async () => {
    const home = userHome();
    writeStaleCodexHomeAuth(home, DEFAULT_AGENT);
    writeSharedStore(home, { version: 1, profiles: {} });
    const { push, sweepOnce } = await loadRunner();

    await sweepOnce(new Map());

    expect(push).not.toHaveBeenCalled();
  });
});
