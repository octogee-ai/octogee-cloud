import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { assertPlatformCutoverImported } from "../migrate-from-environment.js";
import { migratePlatformState } from "../migrate.js";
import { PLATFORM_STATE_MIGRATIONS } from "../migrations.js";
import { createPostgresPlatformStateStore } from "../store.js";
import { dsn, newPool, newSchemaName, operation } from "./fixtures/harness.js";

const LATEST = PLATFORM_STATE_MIGRATIONS[PLATFORM_STATE_MIGRATIONS.length - 1].version;
const ALL_VERSIONS = PLATFORM_STATE_MIGRATIONS.map((migration) => migration.version);

describe.skipIf(!dsn)("migratePlatformState", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function isolated(): { pool: pg.Pool; schema: string } {
    const pool = newPool();
    const schema = newSchemaName();
    cleanups.push(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      await pool.end();
    });
    return { pool, schema };
  }

  async function tables(pool: pg.Pool, schema: string): Promise<string[]> {
    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema],
    );
    return rows.map((row) => row.table_name);
  }

  async function runtimeRole(admin: pg.Pool, schema: string): Promise<{ role: string; runtime: pg.Pool }> {
    const role = `platform_runtime_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE ROLE ${pg.escapeIdentifier(role)} LOGIN PASSWORD 'localonly'`);
    const url = new URL(dsn as string);
    url.username = role;
    url.password = "localonly";
    const runtime = new pg.Pool({ connectionString: url.toString(), max: 4 });
    cleanups.push(async () => {
      await runtime.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      await admin.query(`DROP ROLE ${pg.escapeIdentifier(role)}`);
    });
    return { role, runtime };
  }

  it("gives the runtime role enough access to drive the store", async () => {
    const { pool, schema } = isolated();
    const { role, runtime } = await runtimeRole(pool, schema);

    await migratePlatformState(pool, { schema, runtimeRole: role });

    const store = createPostgresPlatformStateStore({ pool: runtime, schema });
    const record = operation();
    await store.journal.operations.create(record);
    await expect(store.journal.operations.get(record.id)).resolves.toMatchObject({ id: record.id });
    await store.close();
  });

  it("lets the runtime role read the deployment target but never change it", async () => {
    const { pool, schema } = isolated();
    const { role, runtime } = await runtimeRole(pool, schema);
    const table = `${pg.escapeIdentifier(schema)}.platform_deployment_target`;

    await migratePlatformState(pool, { schema, deploymentTargetId: "test-central", runtimeRole: role });

    await expect(runtime.query(`SELECT target_id FROM ${table}`)).resolves.toMatchObject({ rows: [{ target_id: "test-central" }] });
    await expect(runtime.query(`UPDATE ${table} SET target_id = 'prod-central'`)).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
  });

  it("holds production shipment until its bound database has a completed nonempty import", async () => {
    const { pool, schema } = isolated();
    const ledger = pg.escapeIdentifier(`${schema}_cutover`);
    await migratePlatformState(pool, { schema, deploymentTargetId: "prod-central" });
    const requireImport = () => assertPlatformCutoverImported(pool, "prod-central", "octogee", schema);
    await expect(requireImport()).rejects.toThrow("no completed platform state import for prod-central");
    try {
      await pool.query(`CREATE SCHEMA ${ledger};
        CREATE TABLE ${ledger}.import_ledger (
          singleton boolean PRIMARY KEY DEFAULT true, target_id text, source_project text, row_count bigint, completed_at bigint
        )`);
      await pool.query(`INSERT INTO ${ledger}.import_ledger (target_id, source_project, row_count, completed_at) VALUES ('prod-central', 'octogee-test', 10, 1000)`);
      await expect(requireImport()).rejects.toThrow("no completed platform state import for prod-central");
      await pool.query(`UPDATE ${ledger}.import_ledger SET source_project = 'octogee', row_count = 0`);
      await expect(requireImport()).rejects.toThrow("no completed platform state import for prod-central");
      await pool.query(`UPDATE ${ledger}.import_ledger SET row_count = 10`);
      await expect(requireImport()).resolves.toBeUndefined();
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${ledger} CASCADE`);
    }
  });

  it("keeps schema changes and migration history away from the runtime role", async () => {
    const { pool, schema } = isolated();
    const { role, runtime } = await runtimeRole(pool, schema);
    const qualified = pg.escapeIdentifier(schema);

    await migratePlatformState(pool, { schema, runtimeRole: role });

    await expect(runtime.query(`CREATE TABLE ${qualified}.intruder (id int)`)).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`DROP TABLE ${qualified}.operations`)).rejects.toMatchObject({ code: "42501" });
    await expect(runtime.query(`DELETE FROM ${qualified}.platform_state_migrations`)).rejects.toMatchObject({ code: "42501" });
  });

  it("extends runtime access to tables added by later migrations", async () => {
    const { pool, schema } = isolated();
    const { role, runtime } = await runtimeRole(pool, schema);

    await migratePlatformState(pool, { schema, through: 1, runtimeRole: role });
    await migratePlatformState(pool, { schema, runtimeRole: role });

    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name <> 'platform_state_migrations'",
      [schema],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const { table_name: table } of rows) {
      await expect(runtime.query(`SELECT 1 FROM ${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(table)} LIMIT 1`)).resolves.toBeDefined();
    }
  });

  it("applies nothing when the runtime role does not exist", async () => {
    const { pool, schema } = isolated();

    await expect(migratePlatformState(pool, { schema, runtimeRole: "no_such_role" })).rejects.toMatchObject({ code: "42704" });

    expect(await tables(pool, schema)).toEqual([]);
  });

  it("applies every migration once and records each in the migrations table", async () => {
    const { pool, schema } = isolated();

    const first = await migratePlatformState(pool, { schema });
    const second = await migratePlatformState(pool, { schema });

    expect(first).toEqual({ applied: ALL_VERSIONS, version: LATEST });
    expect(second).toEqual({ applied: [], version: LATEST });
    const { rows } = await pool.query(
      `SELECT version, name FROM ${pg.escapeIdentifier(schema)}.platform_state_migrations ORDER BY version`,
    );
    expect(rows).toEqual(PLATFORM_STATE_MIGRATIONS.map(({ version, name }) => ({ version, name })));
  });

  it("adds Meta token and pointer support without changing existing tokens", async () => {
    const { pool, schema } = isolated();
    const table = pg.escapeIdentifier(schema);
    await migratePlatformState(pool, { schema, through: 10 });
    const insertToken = (provider: string, hash: string) => pool.query(
      `INSERT INTO ${table}.model_broker_tokens
        (token_hash, gateway_id, provider, purpose, secret_name, created_at, rail_policy)
        VALUES ($1, 'g1', $2, 'model', 'fixture', 1, '{}')`,
      [hash, provider],
    );
    await insertToken("openai", "a".repeat(64));
    await expect(insertToken("meta", "b".repeat(64))).rejects.toMatchObject({ code: "23514" });

    await migratePlatformState(pool, { schema });
    await insertToken("meta", "b".repeat(64));
    await pool.query(
      `INSERT INTO ${table}.model_broker_gateway_tokens
        (pointer_key, gateway_id, provider, secret_name, token_hash, updated_at)
        VALUES ('g1:meta', 'g1', 'meta', 'fixture', $1, 2)`,
      ["b".repeat(64)],
    );
    const { rows } = await pool.query(`SELECT provider FROM ${table}.model_broker_tokens ORDER BY token_hash`);
    expect(rows).toEqual([{ provider: "openai" }, { provider: "meta" }]);
    await expect(insertToken("unknown", "c".repeat(64))).rejects.toMatchObject({ code: "23514" });
  });

  it("creates every platform table, the change log outbox, and its retention watermark", async () => {
    const { pool, schema } = isolated();

    await migratePlatformState(pool, { schema });

    const created = await tables(pool, schema);
    expect(created).toEqual(
      expect.arrayContaining([
        "operations",
        "operation_audits",
        "gateway_recovery_receipts",
        "gateways",
        "users",
        "user_agents",
        "agent_stores",
        "workspaces",
        "workspace_project_members",
        "gateway_ticket_mint_log",
        "gateway_tickets",
        "change_log",
        "change_log_retention",
        "platform_state_migrations",
      ]),
    );
    const { rows: triggers } = await pool.query(
      `SELECT count(*)::int AS count FROM information_schema.triggers WHERE trigger_schema = $1 AND trigger_name LIKE '%\\_change'`,
      [schema],
    );
    expect(triggers[0].count).toBeGreaterThan(0);
  });

  it("names no product or hosting provider in any schema object", async () => {
    const { pool, schema } = isolated();
    await migratePlatformState(pool, { schema });

    const { rows } = await pool.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = $1
       UNION SELECT column_name FROM information_schema.columns WHERE table_schema = $1
       UNION SELECT indexname FROM pg_indexes WHERE schemaname = $1
       UNION SELECT c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1
       UNION SELECT t.tgname FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace
             WHERE n.nspname = $1 AND NOT t.tgisinternal
       UNION SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1`,
      [schema],
    );

    expect(rows.map((row) => row.name).filter((name) => /builder|customer|mattermost|gitea/.test(name)).sort()).toEqual([]);
  });

  it("keeps external user IDs out of the user tables", async () => {
    const { pool, schema } = isolated();
    await migratePlatformState(pool, { schema });

    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'channel_host_user_id' ORDER BY table_name",
      [schema],
    );

    expect(rows.map((row) => row.table_name)).toEqual(["user_secrets", "workspace_members"]);
  });

  it("rewrites the removed xs size to s on gateways and sizing profiles, and adds the gateway's sizing profile", async () => {
    const { pool, schema } = isolated();
    const table = pg.escapeIdentifier(schema);
    await migratePlatformState(pool, { schema, through: 16 });
    const insertGateway = (gatewayId: string, sizingTier: string | null) => pool.query(
      `INSERT INTO ${table}.gateways
        (gateway_id, created_at, created_by, updated_at, updated_by, latest_release, desired_release, desired_status,
         config_schema_version, gateway_class, image_profile, sizing_tier)
        VALUES ($1, 1, 'fixture', 1, 'fixture', 0, 0, 'running', 1, 'isolated', 'isolated', $2)`,
      [gatewayId, sizingTier],
    );
    await insertGateway("g-xs", "xs");
    await insertGateway("g-m", "m");
    await insertGateway("g-none", null);
    const pod = { isolation: "isolated", sizingTier: "xs", computer: { runtime: "cluster", homeSizeGiB: 10 }, fallbackStorageGb: null };
    const shared = { isolation: "shared" };
    const pro = { isolation: "isolated", sizingTier: "m", computer: { runtime: "cluster", homeSizeGiB: 50 }, fallbackStorageGb: 500 };
    await pool.query(
      `INSERT INTO ${table}.orchestrator_config (id, sizing_profiles) VALUES ('orchestrator', $1)`,
      [JSON.stringify({ pod, shared, pro })],
    );

    await migratePlatformState(pool, { schema });

    const gateways = await pool.query(`SELECT gateway_id, sizing_tier, sizing_profile FROM ${table}.gateways ORDER BY gateway_id`);
    expect(gateways.rows).toEqual([
      { gateway_id: "g-m", sizing_tier: "m", sizing_profile: null },
      { gateway_id: "g-none", sizing_tier: null, sizing_profile: null },
      { gateway_id: "g-xs", sizing_tier: "s", sizing_profile: null },
    ]);
    const config = await pool.query(`SELECT sizing_profiles FROM ${table}.orchestrator_config`);
    expect(config.rows[0].sizing_profiles).toEqual({ pod: { ...pod, sizingTier: "s" }, shared, pro });
  });

  it("refuses to fold an xs sizing profile into s beside a profile on the same runtime with other computer settings", async () => {
    const { pool, schema } = isolated();
    const table = pg.escapeIdentifier(schema);
    await migratePlatformState(pool, { schema, through: 16 });
    const pod = (sizingTier: string, homeSizeGiB: number) =>
      ({ isolation: "isolated", sizingTier, computer: { runtime: "cluster", homeSizeGiB }, fallbackStorageGb: null });
    await pool.query(
      `INSERT INTO ${table}.orchestrator_config (id, sizing_profiles) VALUES ('orchestrator', $1)`,
      [JSON.stringify({ small: pod("xs", 10), roomy: pod("s", 20), other: pod("m", 30) })],
    );

    await expect(migratePlatformState(pool, { schema })).rejects.toThrow(
      "sizing profiles small and roomy would share size s on one runtime with different computer settings",
    );

    const { rows } = await pool.query(`SELECT max(version)::int AS version FROM ${table}.platform_state_migrations`);
    expect(rows).toEqual([{ version: 16 }]);
    const config = await pool.query(`SELECT sizing_profiles->'small'->>'sizingTier' AS tier FROM ${table}.orchestrator_config`);
    expect(config.rows).toEqual([{ tier: "xs" }]);
  });

  it("stops at the requested version and resumes from it", async () => {
    const { pool, schema } = isolated();

    const partial = await migratePlatformState(pool, { schema, through: 1 });
    expect(partial).toEqual({ applied: [1], version: 1 });
    expect(await tables(pool, schema)).not.toContain("change_log");

    const rest = await migratePlatformState(pool, { schema });
    expect(rest).toEqual({ applied: ALL_VERSIONS.slice(1), version: LATEST });
    expect(await tables(pool, schema)).toContain("change_log");
  });

  it("rejects an unknown target version without touching the database", async () => {
    const { pool, schema } = isolated();

    await expect(migratePlatformState(pool, { schema, through: 99 })).rejects.toThrow(RangeError);
    expect(await tables(pool, schema)).toEqual([]);
  });

  it("serializes concurrent migrators so the schema is applied exactly once", async () => {
    const { pool, schema } = isolated();

    const results = await Promise.all([
      migratePlatformState(pool, { schema }),
      migratePlatformState(pool, { schema }),
      migratePlatformState(pool, { schema }),
    ]);

    expect(results.map((result) => result.applied.length).sort()).toEqual([0, 0, ALL_VERSIONS.length]);
    expect(results.every((result) => result.version === LATEST)).toBe(true);
  });

  it("rolls back a failed migration so nothing half-applied is recorded", async () => {
    const { pool, schema } = isolated();
    await migratePlatformState(pool, { schema, through: 1 });
    await pool.query(`CREATE TABLE ${pg.escapeIdentifier(schema)}.change_log (blocker integer)`);

    await expect(migratePlatformState(pool, { schema })).rejects.toThrow(/change_log/);

    const { rows } = await pool.query(
      `SELECT version FROM ${pg.escapeIdentifier(schema)}.platform_state_migrations ORDER BY version`,
    );
    expect(rows).toEqual([{ version: 1 }]);
    const { rows: functions } = await pool.query(
      "SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = 'record_change'",
      [schema],
    );
    expect(functions[0].count).toBe(0);
  });
});
