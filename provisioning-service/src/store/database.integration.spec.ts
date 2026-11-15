import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { capturingLogger, dropSchema, dsn } from "../test-support/harness.js";
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
});
