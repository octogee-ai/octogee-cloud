/* eslint-disable sonarjs/sql-queries -- Synthetic fixture identifiers are escaped; SQL values use query parameters. */
import { describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAgentStoreCredentialProvisioner } from "./agent-store-credentials.js";

const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;
const resetSql = fileURLToPath(new URL("./agent-store-reset.sql", import.meta.url));
const id = pg.escapeIdentifier;
const LOCKS_PER_DROPPED_TABLE = 8;

function runReset(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", dsn!, "-f", resetSql], { encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function connected(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  client.on("error", () => {});
  return client;
}

async function closeAdministrator(admin: pg.Client): Promise<void> {
  await waitForOtherAdministratorSessionsToClose(admin);
  await admin.end();
}

async function sharedLockTableCapacity(admin: pg.Client): Promise<number> {
  const { rows: [{ capacity }] } = await admin.query<{ capacity: number }>(`SELECT current_setting('max_locks_per_transaction')::int
    * (current_setting('max_connections')::int + current_setting('autovacuum_max_workers')::int + current_setting('max_worker_processes')::int
       + current_setting('max_wal_senders')::int + current_setting('max_prepared_transactions')::int + 1) AS capacity`);
  return capacity;
}

async function provisionSharedGateway(suffix: string, index: number): Promise<{ login: string; owner: string; schema: string; client: pg.Client }> {
  const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
  const gatewayDsn = await provision({ gatewayClass: "shared", gatewayId: `shared-${index}-${suffix}`, token: `synthetic-${index}` }, async () => {});
  const client = await connected(gatewayDsn);
  const schema = `shared_${index}_${suffix}`;
  await client.query(`CREATE SCHEMA ${id(schema)}`);
  return {
    login: await roleName(client, "SELECT session_user AS rolname"),
    owner: await roleName(client, "SELECT current_user AS rolname"),
    schema,
    client,
  };
}

async function createTables(client: pg.Client, schema: string, count: number): Promise<void> {
  await client.query(`DO $fixture$
    BEGIN
      FOR i IN 1..${count} LOOP
        EXECUTE format('CREATE TABLE %I.%I (store TEXT PRIMARY KEY, payload JSONB)', ${pg.escapeLiteral(schema)}, 'store_' || i);
      END LOOP;
    END
    $fixture$`);
}

async function waitForOtherAdministratorSessionsToClose(admin: pg.Client): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    await admin.query("SELECT pg_stat_clear_snapshot()");
    const { rows: [{ count }] } = await admin.query<{ count: string }>(
      "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename = current_user",
    );
    if (count === "0") return;
    if (Date.now() > deadline) throw new Error("administrator sessions did not close");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function fleetRoles(admin: pg.Client, names: readonly string[]): Promise<string[]> {
  const { rows } = await admin.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname", [names]);
  return rows.map((row) => row.rolname);
}

async function roleName(client: pg.Client, query: string): Promise<string> {
  const { rows: [row] } = await client.query<{ rolname: string }>(query);
  return row.rolname;
}

describe.skipIf(!dsn)("agent-store reset", { timeout: 60_000 }, () => {
  it("removes every fleet role and agent schema while keeping the database, its owner and its extensions", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const sharedDsn = await provision({ gatewayClass: "shared", gatewayId: `shared-reset-${suffix}`, token: "synthetic-shared" }, async () => {});
    const userDsn = await provision(
      { gatewayClass: "isolated", gatewayId: `user-reset-${suffix}`, token: "synthetic-user", user: { uid: `uid-${suffix}`, slug: `reset${suffix}` } },
      async () => {},
    );
    const shared = new pg.Client({ connectionString: sharedDsn });
    const user = new pg.Client({ connectionString: userDsn });
    let admin = new pg.Client({ connectionString: dsn! });
    await shared.connect(); await user.connect(); await admin.connect();
    shared.on("error", () => {});
    user.on("error", () => {});
    try {
      await shared.query(`CREATE SCHEMA ${id(`shared_${suffix}`)}`);
      await shared.query(`CREATE TABLE ${id(`shared_${suffix}`)}.openclaw_schema_meta (store TEXT PRIMARY KEY)`);
      await user.query(`CREATE SCHEMA ${id(`user_${suffix}`)}`);
      await user.query(`CREATE TABLE ${id(`user_${suffix}`)}.openclaw_schema_meta (store TEXT PRIMARY KEY)`);
      await admin.query(`CREATE SCHEMA ${id(`administrator_${suffix}`)}`);
      const roles = [
        await roleName(shared, "SELECT session_user AS rolname"),
        await roleName(shared, "SELECT current_user AS rolname"),
        await roleName(user, "SELECT session_user AS rolname"),
        await roleName(user, "SELECT current_user AS rolname"),
      ];
      const { rows: [before] } = await admin.query<{ owner: string }>(
        "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()",
      );
      await closeAdministrator(admin);

      const reset = runReset();

      expect(reset.status, reset.stderr).toBe(0);
      expect(reset.stdout.trim()).toBe(`OCTOGEE_AGENT_STORE_RESET=${new URL(dsn!).pathname.slice(1)}`);
      admin = await connected(dsn!);
      expect(await fleetRoles(admin, roles)).toEqual([]);
      const { rows: schemas } = await admin.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)", [[`shared_${suffix}`, `user_${suffix}`, `administrator_${suffix}`]]);
      expect(schemas).toEqual([]);
      const { rows: [after] } = await admin.query<{ owner: string; extensions: string }>(
        "SELECT pg_get_userbyid(datdba) AS owner, (SELECT count(*) FROM pg_extension WHERE extname IN ('unaccent', 'pg_trgm', 'vector')) AS extensions FROM pg_database WHERE datname = current_database()",
      );
      expect(after).toEqual({ owner: before.owner, extensions: "3" });
      await expect(shared.query("SELECT 1")).rejects.toThrow();
      await expect(user.query("SELECT 1")).rejects.toThrow();
    } finally {
      await Promise.allSettled([shared.end(), user.end(), admin.end()]);
    }
  });

  it("refuses before changing anything when the database grants a role the fleet did not create", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const foreign = `agent_store_reset_foreign_${suffix}`;
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const sharedDsn = await provision({ gatewayClass: "shared", gatewayId: `shared-refuse-${suffix}`, token: "synthetic-shared" }, async () => {});
    const shared = new pg.Client({ connectionString: sharedDsn });
    let admin = new pg.Client({ connectionString: dsn! });
    await shared.connect(); await admin.connect();
    try {
      const login = await roleName(shared, "SELECT session_user AS rolname");
      await shared.end();
      await admin.query(`CREATE ROLE ${id(foreign)} NOLOGIN`);
      await admin.query(`GRANT CONNECT ON DATABASE ${id(new URL(dsn!).pathname.slice(1))} TO ${id(foreign)}`);
      await closeAdministrator(admin);

      const reset = runReset();

      expect(reset.status).toBe(3);
      expect(reset.stderr).toContain(`grants roles the fleet did not create: ${foreign}`);
      admin = await connected(dsn!);
      const { rows: [state] } = await admin.query<{ rolcanlogin: boolean }>("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [login]);
      expect(state).toEqual({ rolcanlogin: true });
    } finally {
      await admin.query(`REVOKE CONNECT ON DATABASE ${id(new URL(dsn!).pathname.slice(1))} FROM ${id(foreign)}`);
      await admin.query(`DROP ROLE IF EXISTS ${id(foreign)}`);
      await Promise.allSettled([shared.end(), admin.end()]);
    }
  });

  it("drops a fleet larger than the shared lock table one gateway at a time", { timeout: 240_000 }, async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    let admin = await connected(dsn!);
    const gateways = 12;
    const tablesPerGateway = Math.ceil((3 * await sharedLockTableCapacity(admin)) / LOCKS_PER_DROPPED_TABLE / gateways);
    const fleet = [];
    try {
      for (let index = 0; index < gateways; index += 1) {
        const gateway = await provisionSharedGateway(suffix, index);
        await createTables(gateway.client, gateway.schema, tablesPerGateway);
        await gateway.client.end();
        fleet.push(gateway);
      }
      await closeAdministrator(admin);

      const reset = runReset();

      expect(reset.stderr).not.toContain("out of shared memory");
      expect(reset.status, reset.stderr).toBe(0);
      admin = await connected(dsn!);
      expect(await fleetRoles(admin, fleet.flatMap(({ login, owner }) => [login, owner]))).toEqual([]);
      const { rows: schemas } = await admin.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)", [fleet.map(({ schema }) => schema)]);
      expect(schemas).toEqual([]);
    } finally {
      await Promise.allSettled([admin.end(), ...fleet.map(({ client }) => client.end())]);
    }
  });

  it("finishes a reset that an earlier pass left partly done and still refuses a foreign role", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const foreign = `agent_store_reset_foreign_${suffix}`;
    const database = id(new URL(dsn!).pathname.slice(1));
    let admin = await connected(dsn!);
    const fleet = [];
    try {
      for (let index = 0; index < 3; index += 1) {
        const gateway = await provisionSharedGateway(suffix, index);
        await createTables(gateway.client, gateway.schema, 2);
        await gateway.client.end();
        fleet.push(gateway);
      }
      const [dropped, ...remaining] = fleet;
      const remainingRoles = [...new Set(remaining.flatMap(({ login, owner }) => [login, owner]))];
      await admin.query(`GRANT ${id(dropped.owner)}, ${id(dropped.login)} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`);
      await admin.query(`DROP SCHEMA ${id(dropped.schema)} CASCADE`);
      await admin.query(`DROP OWNED BY ${id(dropped.login)} CASCADE; DROP ROLE ${id(dropped.login)}`);
      for (const role of remainingRoles) await admin.query(`ALTER ROLE ${id(role)} NOLOGIN`);
      await admin.query(`CREATE ROLE ${id(foreign)} NOLOGIN`);
      await admin.query(`GRANT CONNECT ON DATABASE ${database} TO ${id(foreign)}`);
      await closeAdministrator(admin);

      const refused = runReset();

      expect(refused.status).toBe(3);
      expect(refused.stderr).toContain(`grants roles the fleet did not create: ${foreign}`);
      admin = await connected(dsn!);
      expect((await fleetRoles(admin, remainingRoles)).sort()).toEqual([...remainingRoles].sort());
      await admin.query(`REVOKE CONNECT ON DATABASE ${database} FROM ${id(foreign)}`);
      await admin.query(`DROP ROLE ${id(foreign)}`);
      await closeAdministrator(admin);

      const reset = runReset();

      expect(reset.status, reset.stderr).toBe(0);
      admin = await connected(dsn!);
      expect(await fleetRoles(admin, fleet.flatMap(({ login, owner }) => [login, owner]))).toEqual([]);
      const { rows: schemas } = await admin.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)", [fleet.map(({ schema }) => schema)]);
      expect(schemas).toEqual([]);
    } finally {
      if (admin) {
        await admin.query(`REVOKE CONNECT ON DATABASE ${database} FROM ${id(foreign)}`).catch(() => {});
        await admin.query(`DROP ROLE IF EXISTS ${id(foreign)}`).catch(() => {});
      }
      await Promise.allSettled([admin.end(), ...fleet.map(({ client }) => client.end())]);
    }
  });
});
