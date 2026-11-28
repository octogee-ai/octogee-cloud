import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const postgres = vi.hoisted(() => ({ database: undefined as DatabaseSync | undefined, schemas: [] as string[] }));

vi.mock("@octogee/core/agent-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@octogee/core/agent-postgres")>()),
  writeAgentStore: async (anchor: { schema: string }, write: (client: unknown, schema: string) => Promise<unknown>) => {
    const database = postgres.database!;
    postgres.schemas.push(anchor.schema);
    database.exec("BEGIN IMMEDIATE");
    try {
      const client = {
        query: async (sql: string, values: unknown[] = []) => {
          const statement = database.prepare(sql.replaceAll(`"${anchor.schema}".`, "").replace(/\$(\d+)/gu, "?$1"));
          return { rows: /^\s*SELECT/iu.test(sql) ? statement.all(...(values as never[])) : (statement.run(...(values as never[])), []) };
        },
      };
      const result = await write(client, `"${anchor.schema}"`);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },
}));

const { removeDepartedUserFileState } = await import("../lib/user-file-state.js");
const { clearDepartedWorkspaceState } = await import("../lib/departed-workspace-state.js");

const STATE_SCHEMA = `
  CREATE TABLE workspace_setup_state (workspace_key TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, setup_completed_at TEXT, attested_at_ms INTEGER);
  CREATE TABLE workspace_generated_bootstrap_hashes (workspace_key TEXT NOT NULL, filename TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (workspace_key, filename));
  CREATE TABLE workspace_path_aliases (alias_key TEXT PRIMARY KEY, alias_path TEXT NOT NULL, workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
`;

const roots: string[] = [];
afterEach(async () => {
  postgres.database?.close();
  postgres.database = undefined;
  postgres.schemas = [];
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function sharedGateway(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "departed-workspace-state-")));
  roots.push(root);
  await fs.mkdir(path.join(root, "state"), { recursive: true });
  return root;
}

function attest(database: DatabaseSync, key: string, workspace: string, generated: readonly string[]): void {
  database.prepare("INSERT INTO workspace_setup_state VALUES (?, ?, '2026-11-28T06:14:46.862Z', 1795846486937)").run(key, workspace);
  for (const filename of generated) database.prepare("INSERT INTO workspace_generated_bootstrap_hashes VALUES (?, ?, 'generated')").run(key, filename);
  database.prepare("INSERT INTO workspace_path_aliases VALUES (?, ?, ?, ?, 1)").run(`${key}-alias`, workspace, key, workspace);
}

async function attestSharedStay(root: string, database: DatabaseSync): Promise<{ project: string }> {
  const workspace = path.join(root, "customers", "alice");
  const project = path.join(workspace, "projects", "tidechart");
  await fs.mkdir(project, { recursive: true });
  for (const name of ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md"]) await fs.writeFile(path.join(project, name), `generated ${name}\n`);
  attest(database, "alice-root", workspace, ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md"]);
  attest(database, "alice-tidechart", project, ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md"]);
  attest(database, "alice-lookalike", path.join(root, "customers", "alice-two"), ["AGENTS.md"]);
  attest(database, "bob-root", path.join(root, "customers", "bob"), ["AGENTS.md"]);
  return { project };
}

async function returnArchivedProject(project: string): Promise<void> {
  await fs.mkdir(path.join(project, "public"), { recursive: true });
  for (const name of ["AGENTS.md", "SOUL.md", "USER.md"]) await fs.writeFile(path.join(project, name), `generated ${name}\n`);
  await fs.writeFile(path.join(project, "public", "index.html"), "<h1>Tide Chart</h1>\n");
}

function remainingKeys(database: DatabaseSync): Record<string, string[]> {
  const keys = (sql: string) => (database.prepare(sql).all() as Array<{ key: string }>).map(row => row.key).sort();
  return {
    setup: keys("SELECT workspace_key AS key FROM workspace_setup_state"),
    hashes: [...new Set(keys("SELECT workspace_key AS key FROM workspace_generated_bootstrap_hashes"))],
    aliases: keys("SELECT alias_key AS key FROM workspace_path_aliases"),
  };
}

const UNRELATED = { setup: ["alice-lookalike", "bob-root"], hashes: ["alice-lookalike", "bob-root"], aliases: ["alice-lookalike-alias", "bob-root-alias"] };

it("returns an archived project to the shared gateway it left without that gateway's earlier attestation (SQLite state)", async () => {
  const root = await sharedGateway();
  const database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
  database.exec(STATE_SCHEMA);
  const { project } = await attestSharedStay(root, database);
  database.close();

  await removeDepartedUserFileState("alice", { root, log: vi.fn() });
  await returnArchivedProject(project);

  const state = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), { readOnly: true });
  try { expect(remainingKeys(state)).toEqual(UNRELATED); } finally { state.close(); }
  expect((await fs.readdir(project)).sort()).toEqual(["AGENTS.md", "SOUL.md", "USER.md", "public"]);
});

it("returns an archived project to the shared gateway it left without that gateway's earlier attestation (PostgreSQL state)", async () => {
  const root = await sharedGateway();
  const anchor = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
  anchor.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)");
  anchor.prepare("INSERT INTO openclaw_engine_anchor VALUES ('52ba28d6-2b4b-4b51-8000-000000000000', 'postgres', 'octogee_state_52ba28d62b4b4b51')").run();
  anchor.close();
  postgres.database = new DatabaseSync(":memory:");
  postgres.database.exec(STATE_SCHEMA);
  const { project } = await attestSharedStay(root, postgres.database);

  await removeDepartedUserFileState("alice", { root, log: vi.fn() });
  await returnArchivedProject(project);

  expect(postgres.schemas).toEqual(["octogee_state_52ba28d62b4b4b51"]);
  expect(remainingKeys(postgres.database)).toEqual(UNRELATED);
});

it("keeps the attestation of a workspace that is still present", async () => {
  const root = await sharedGateway();
  const database = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
  database.exec(STATE_SCHEMA);
  await attestSharedStay(root, database);
  database.close();

  await expect(clearDepartedWorkspaceState({ root, slug: "alice", log: vi.fn() })).rejects.toThrow("departed workspace is still present");

  const state = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), { readOnly: true });
  try { expect(remainingKeys(state).setup).toEqual(["alice-lookalike", "alice-root", "alice-tidechart", "bob-root"]); } finally { state.close(); }
});

it("has nothing to clear on a gateway without a state store", async () => {
  const root = await sharedGateway();
  await expect(clearDepartedWorkspaceState({ root, slug: "alice", log: vi.fn() })).resolves.toEqual([]);
});
