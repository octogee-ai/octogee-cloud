/* eslint-disable sonarjs/sql-queries -- Synthetic fixture identifiers are escaped; SQL values use query parameters. */
import { describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createAgentStoreCredentialProvisioner } from "./agent-store-credentials.js";

const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;
const resetSql = readFileSync(new URL("./agent-store-reset.sql", import.meta.url), "utf8");
const id = pg.escapeIdentifier;

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
    const admin = new pg.Client({ connectionString: dsn! });
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
      await waitForOtherAdministratorSessionsToClose(admin);

      const results = await admin.query(resetSql) as unknown as pg.QueryResult[];

      expect(results.at(-1)?.rows).toEqual([{ "?column?": `OCTOGEE_AGENT_STORE_RESET=${new URL(dsn!).pathname.slice(1)}` }]);
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
    const admin = new pg.Client({ connectionString: dsn! });
    await shared.connect(); await admin.connect();
    try {
      const login = await roleName(shared, "SELECT session_user AS rolname");
      await shared.end();
      await admin.query(`CREATE ROLE ${id(foreign)} NOLOGIN`);
      await admin.query(`GRANT CONNECT ON DATABASE ${id(new URL(dsn!).pathname.slice(1))} TO ${id(foreign)}`);
      await waitForOtherAdministratorSessionsToClose(admin);

      await expect(admin.query(resetSql)).rejects.toThrow(`grants roles the fleet did not create: ${foreign}`);
      const { rows: [state] } = await admin.query<{ rolcanlogin: boolean }>("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [login]);
      expect(state).toEqual({ rolcanlogin: true });
    } finally {
      await admin.query(`REVOKE CONNECT ON DATABASE ${id(new URL(dsn!).pathname.slice(1))} FROM ${id(foreign)}`);
      await admin.query(`DROP ROLE IF EXISTS ${id(foreign)}`);
      await Promise.allSettled([shared.end(), admin.end()]);
    }
  });
});
