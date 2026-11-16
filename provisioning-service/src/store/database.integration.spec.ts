import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { capturingLogger, dropSchema, dsn } from "../__tests__/harness.js";
import { migrate, openDatabase, type Database } from "./database.js";

describe.skipIf(!dsn)("schema migration", { timeout: 30_000 }, () => {
  const schema = `ps_test_${randomBytes(6).toString("hex")}`;
  const opened: Database[] = [];
  const open = () => {
    const db = openDatabase({ connection: { connectionString: dsn }, schema, log: capturingLogger() });
    opened.push(db);
    return db;
  };

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
    await dropSchema(schema);
  });

  it("lets replicas starting together migrate once, and is a no-op on a database this build already wrote", async () => {
    const results = await Promise.all([migrate(open()), migrate(open()), migrate(open())]);
    expect(results.filter((result) => result.from === 0)).toHaveLength(1);
    expect(results.every((result) => result.to === results[0].to)).toBe(true);
    expect(await migrate(open())).toEqual({ from: results[0].to, to: results[0].to });
  });

  it("refuses a schema newer than this build", async () => {
    const db = open();
    const { to } = await migrate(db);
    await db.pool.query(`UPDATE ${db.table("schema_version")} SET version = $1`, [to + 1]);
    await expect(migrate(db)).rejects.toThrow(`schema version ${to + 1} is newer than this build knows`);
  });

  it("refuses to move to keys held per pod while any git key row exists, and changes nothing", async () => {
    const db = open();
    await migrate(db);
    await db.pool.query(`ALTER TABLE ${db.table("git_keys")} DROP CONSTRAINT git_keys_pkey, DROP COLUMN holder, ADD PRIMARY KEY (uid, gateway_id)`);
    await db.pool.query(`UPDATE ${db.table("schema_version")} SET version = 2`);
    await db.pool.query(
      `INSERT INTO ${db.table("provisionings")} (uid, generation, resource_version, spec, outputs, conditions) VALUES ('u1', 1, 1, '{}', '{}', '[]')`);
    await db.pool.query(
      `INSERT INTO ${db.table("git_keys")} (uid, gateway_id, generation, resource_version, public_key, conditions) VALUES ('u1', 'gateway-a', 1, 1, 'ssh-ed25519 AAAA', '[]')`);

    await expect(migrate(db)).rejects.toThrow("cannot migrate existing git key rows");
    expect((await db.pool.query(`SELECT version FROM ${db.table("schema_version")}`)).rows[0].version).toBe(2);
    expect((await db.pool.query(`SELECT count(*)::int AS rows FROM ${db.table("git_keys")}`)).rows[0].rows).toBe(1);
  });
});
