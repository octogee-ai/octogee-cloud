/* eslint-disable sonarjs/sql-queries -- The disposable schema and role identifiers use pg.escapeIdentifier. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  createAgentStoreCredentialProvisioner,
  createHeldReturnDatabaseBarrier,
} from "./agent-store-credentials.js";

const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;
describe.skipIf(!dsn)("held return database writer", () => {
  it("retains the schema, holds only its original exact login, detects existing sessions and restores its original limit", async () => {
    const gatewayId = "offline-" + randomUUID();
    const uid = "owner-" + randomUUID();
    const schema = "held_" + randomUUID().replaceAll("-", "");
    const quotedSchema = pg.escapeIdentifier(schema);
    const admin = new pg.Client({ connectionString: dsn });
    await admin.connect();
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const connect = await provision(
      { gatewayId, gatewayClass: "isolated", user: { uid, slug: uid }, token: "fixture" },
      async () => {},
    );
    const original = new pg.Client({ connectionString: connect });
    const neighbor = new pg.Client({
      connectionString: await provision(
        {
          gatewayId: "neighbor-" + randomUUID(),
          gatewayClass: "isolated",
          user: { uid: "neighbor", slug: "neighbor" },
          token: "fixture",
        },
        async () => {},
      ),
    });
    await Promise.all([original.connect(), neighbor.connect()]);
    try {
      await original.query(`CREATE SCHEMA ${quotedSchema}`);
      await original.query(
        `CREATE TABLE ${quotedSchema}.notes(id integer); INSERT INTO ${quotedSchema}.notes VALUES(7)`,
      );
      const login = decodeURIComponent(new URL(connect).username);
      await admin.query(`ALTER ROLE ${pg.escapeIdentifier(login)} CONNECTION LIMIT 3`);
      const operator = (
        await admin.query(
          "SELECT oid::text,rolname AS name FROM pg_roles WHERE rolname=current_user",
        )
      ).rows[0];
      const scope = {
        uid,
        sourceGatewayId: gatewayId,
        schemas: [schema],
        trustedOperators: [operator],
      };
      const barrier = createHeldReturnDatabaseBarrier(dsn!);
      const current = async () => {};
      const binding = await barrier.inspect(scope, current);
      expect(binding.previousLimit).toBe(3);
      await expect(barrier.hold(scope, { ...binding, roleOid: "1" }, current)).rejects.toThrow(
        /identity/,
      );
      await barrier.hold(scope, binding, current);
      await expect(barrier.verify(scope, binding, current)).rejects.toThrow(/sessions/);
      await expect(new pg.Client({ connectionString: connect }).connect()).rejects.toMatchObject({
        code: "53300",
      });
      await expect(neighbor.query("SELECT 1")).resolves.toBeDefined();
      await original.query("BEGIN");
      await expect(barrier.drainIdle(scope, binding, current)).rejects.toThrow(/sessions/);
      await original.query("ROLLBACK");
      original.on("error", () => {});
      const disconnected = new Promise<void>((resolve) => original.once("end", resolve));
      await barrier.drainIdle(scope, binding, current);
      await disconnected;
      await barrier.hold(scope, binding, current);
      await barrier.verify(scope, binding, current);
      await expect(
        barrier.restore(scope, binding, async () => {
          throw new Error("stale operation");
        }),
      ).rejects.toThrow("stale operation");
      const outsider = (await neighbor.query("SELECT session_user AS name")).rows[0].name;
      await admin.query(
        `GRANT INSERT(id) ON ${quotedSchema}.notes TO ${pg.escapeIdentifier(outsider)}`,
      );
      await expect(barrier.verify(scope, binding, current)).rejects.toThrow(/writer/);
      await admin.query(
        `REVOKE INSERT(id) ON ${quotedSchema}.notes FROM ${pg.escapeIdentifier(outsider)}`,
      );
      await barrier.restore(scope, binding, current);
      await barrier.restore(scope, binding, current);
      const resumed = new pg.Client({ connectionString: connect });
      await resumed.connect();
      try {
        expect((await resumed.query(`SELECT * FROM ${quotedSchema}.notes`)).rows).toEqual([
          { id: 7 },
        ]);
        await resumed.query(`INSERT INTO ${quotedSchema}.notes VALUES(8)`);
      } finally {
        await resumed.end();
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await Promise.allSettled([original.end(), neighbor.end(), admin.end()]);
    }
  });
});
