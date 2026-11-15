/* eslint-disable sonarjs/sql-queries -- Disposable fixture identifiers are escaped; values use query parameters. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

const previous = process.env.OCTOGEE_TEST_OPENCLAW_PREVIOUS_BIN;
const previousSha = process.env.OCTOGEE_TEST_OPENCLAW_PREVIOUS_SHA;
const binary = process.env.OCTOGEE_TEST_OPENCLAW_BIN;
const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;
const repo = path.resolve(import.meta.dirname, "../..");
const sourceSha = JSON.parse(readFileSync(path.join(repo, "gateway/openclaw-tarball/current.json"), "utf8")).sourceSha as string;

describe.skipIf(!previous || !previousSha || !binary || !dsn)("OpenClaw pin roll over retained PostgreSQL state", () => {
  it("completes state the oldest retained pin created once, keeping its setup rows", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "octogee-pin-roll-"));
    const state = path.join(home, ".openclaw");
    mkdirSync(state);
    const file = path.join(state, "openclaw.json");
    const { database } = JSON.parse(readFileSync(path.join(repo, "gateway/openclaw.isolated.template.json"), "utf8"));
    const prefix = `pin_roll_${path.basename(home).slice(-6).toLowerCase()}`;
    const likePrefix = prefix.replaceAll("_", "\\_");
    database.postgres.schemaPrefix = prefix;
    writeFileSync(file, JSON.stringify({ database }));
    const env = { ...process.env, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: file,
      OPENCLAW_OFFLINE: "1", OPENCLAW_NO_RESPAWN: "1", OPENCLAW_AGENT_STORE_DSN: dsn };
    const openclaw = (bin: string, args: string[]) => {
      const result = spawnSync(bin, args, { env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/schema drift/u);
      return result.stdout;
    };
    const writeAgent = (bin: string, agentId: string) => {
      const patch = path.join(home, `${agentId}.json`);
      writeFileSync(patch, JSON.stringify({ agents: { entries: { [agentId]: { name: agentId, workspace: path.join(state, `workspace-${agentId}`) } } } }));
      openclaw(bin, ["config", "patch", "--file", patch, "--replace-path", `agents.entries.${agentId}`]);
    };
    const client = new pg.Client({ connectionString: dsn });
    await client.connect();
    const stateStore = async () => {
      const namespaces = await client.query<{ nspname: string }>("SELECT nspname FROM pg_namespace WHERE nspname LIKE $1", [`${likePrefix}\\_state\\_%`]);
      expect(namespaces.rows).toHaveLength(1);
      const schema = client.escapeIdentifier(namespaces.rows[0].nspname);
      const column = await client.query(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'workspace_setup_state' AND column_name = 'bootstrap_deferred'",
        [namespaces.rows[0].nspname]);
      const seal = await client.query<{ version: number; ddl_hash: string }>(
        `SELECT version::integer AS version, ddl_hash FROM ${schema}.openclaw_schema_meta`);
      const setup = await client.query(`SELECT workspace_key, workspace_path, version, bootstrap_seeded_at, setup_completed_at FROM ${schema}.workspace_setup_state ORDER BY workspace_key`);
      expect(seal.rows).toHaveLength(1);
      return { column: column.rows, seal: seal.rows[0], setup: setup.rows };
    };
    try {
      expect((await client.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")).rows).toEqual([{ rolsuper: false }]);
      expect(previousSha).not.toBe(sourceSha);
      expect(openclaw(previous!, ["--version"])).toContain(`(${previousSha!.slice(0, 7)})`);
      expect(openclaw(binary!, ["--version"])).toContain(`(${sourceSha.slice(0, 7)})`);
      openclaw(previous!, ["setup", "--baseline"]);
      writeAgent(previous!, "retained");
      const retained = await stateStore();
      expect(retained.setup).not.toHaveLength(0);
      writeAgent(binary!, "octogee-unmatched-route");
      const completed = await stateStore();
      writeAgent(binary!, "second-start");
      expect(completed.column).toEqual([{ data_type: "bigint", is_nullable: "YES", column_default: null }]);
      expect(completed.setup).toEqual(retained.setup);
      expect(completed.seal.version).toBeGreaterThanOrEqual(retained.seal.version);
      const changedSchema = completed.seal.version !== retained.seal.version || retained.column.length === 0;
      expect(completed.seal.ddl_hash !== retained.seal.ddl_hash).toBe(changedSchema);
      expect(await stateStore()).toEqual(completed);
    } finally {
      const created = await client.query<{ nspname: string }>("SELECT nspname FROM pg_namespace WHERE nspname LIKE $1", [`${likePrefix}\\_%`]);
      for (const { nspname } of created.rows) await client.query(`DROP SCHEMA ${client.escapeIdentifier(nspname)} CASCADE`);
      await client.end();
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);
});
