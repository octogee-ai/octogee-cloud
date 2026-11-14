import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createAgentStoreCredentialProvisioner, createAgentStoreOwnershipTransferer } from "./agent-store-credentials.js";

const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;

function query(client: pg.Client, sql: string, values?: unknown[]) {
  return client.query(sql, values);
}

describe.skipIf(!dsn)("bound agent-store handoff", () => {
  it.each(["wrong-uuid", "wrong-agent", "foreign-owner", "duplicate-store", "locked-store"])("refuses %s without changing ownership", async scenario => {
    const suffix = randomUUID().replaceAll("-", ""), storeId = randomUUID();
    const user = { uid: suffix, slug: suffix }, schema = `handoff_${suffix}`, agentId = `octogee-${suffix}-coach`;
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const shared = new pg.Client({ connectionString: await provision({ gatewayClass: "shared", gatewayId: `shared-${suffix}`, token: "synthetic" }, async () => {}) });
    const admin = new pg.Client({ connectionString: dsn });
    await shared.connect(); await admin.connect();
    const inventory = [{ schema, storeId: scenario === "wrong-uuid" ? randomUUID() : storeId, agentId }];
    if (scenario === "duplicate-store") inventory.push(inventory[0]!);
    try {
      const creator = scenario === "foreign-owner" ? admin : shared;
      await query(creator, `CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      await query(creator, `CREATE TABLE ${pg.escapeIdentifier(schema)}.schema_meta (meta_key TEXT, role TEXT, agent_id TEXT)`);
      await query(creator, `INSERT INTO ${pg.escapeIdentifier(schema)}.schema_meta VALUES ('primary', 'agent', $1)`, [scenario === "wrong-agent" ? "octogee-foreign-coach" : agentId]);
      await query(creator, `CREATE TABLE ${pg.escapeIdentifier(schema)}.openclaw_schema_meta (store TEXT, store_id TEXT)`);
      await query(creator, `INSERT INTO ${pg.escapeIdentifier(schema)}.openclaw_schema_meta VALUES ('agent', $1)`, [storeId]);
      const before = await admin.query("SELECT nspowner FROM pg_namespace WHERE nspname = $1", [schema]);
      if (scenario === "locked-store") {
        await shared.query("BEGIN");
        await query(shared, `SELECT * FROM ${pg.escapeIdentifier(schema)}.schema_meta`);
      }
      const transfer = createAgentStoreOwnershipTransferer(dsn!, async () => inventory);
      if (scenario === "locked-store") await expect(transfer(user, "isolated")).rejects.toMatchObject({ code: "55P03" });
      else await expect(transfer(user, "isolated")).rejects.toThrow(/identity|owner|inventory/);
      expect((await admin.query("SELECT nspowner FROM pg_namespace WHERE nspname = $1", [schema])).rows).toEqual(before.rows);
    } finally {
      await shared.query("ROLLBACK");
      await query(admin, `DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      await shared.end(); await admin.end();
    }
  });

  it("moves only the recorded store while an unrelated Shared store has a reader", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const user = { uid: suffix, slug: suffix };
    const schema = `z_handoff_${suffix}`, other = `a_unrelated_${suffix}`, storeId = randomUUID();
    const agentId = `octogee-${suffix}-coach`;
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const shared = new pg.Client({ connectionString: await provision({ gatewayClass: "shared", gatewayId: `shared-${suffix}`, token: "synthetic" }, async () => {}) });
    const admin = new pg.Client({ connectionString: dsn });
    await shared.connect(); await admin.connect();
    let pending: Promise<void> | undefined;
    try {
      for (const [namespace, owner] of [[schema, agentId], [other, "octogee-unrelated-coach"]]) {
        await query(shared, `CREATE SCHEMA ${pg.escapeIdentifier(namespace!)}`);
        await query(shared, `CREATE TABLE ${pg.escapeIdentifier(namespace!)}.schema_meta (meta_key TEXT, role TEXT, agent_id TEXT)`);
        await query(shared, `INSERT INTO ${pg.escapeIdentifier(namespace!)}.schema_meta VALUES ('primary', 'agent', $1)`, [owner]);
        await query(shared, `CREATE TABLE ${pg.escapeIdentifier(namespace!)}.openclaw_schema_meta (store TEXT, store_id TEXT)`);
        await query(shared, `INSERT INTO ${pg.escapeIdentifier(namespace!)}.openclaw_schema_meta VALUES ('agent', $1)`, [storeId]);
      }
      await shared.query("BEGIN");
      await query(shared, `SELECT * FROM ${pg.escapeIdentifier(other)}.schema_meta`);
      const transfer = createAgentStoreOwnershipTransferer(dsn!, async () => [{ schema, storeId, agentId }]);
      pending = transfer(user, "isolated");
      const result = await Promise.race([pending.then(() => "moved"), new Promise<string>(resolve => setTimeout(() => resolve("blocked"), 1000))]);
      expect(result).toBe("moved");
      await transfer(user, "isolated");
      await shared.query("ROLLBACK");
      await expect(query(shared, `SELECT * FROM ${pg.escapeIdentifier(schema)}.schema_meta`)).rejects.toMatchObject({ code: "42501" });
      expect((await query(shared, `SELECT * FROM ${pg.escapeIdentifier(other)}.schema_meta`)).rowCount).toBe(1);
    } finally {
      await shared.query("ROLLBACK");
      await pending?.catch(() => {});
      for (const namespace of [schema, other]) await query(admin, `DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(namespace)} CASCADE`);
      await shared.end(); await admin.end();
    }
  });
});

const FLEET_CREDENTIAL_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended('octogee-agent-store-credentials', 0))";
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe.skipIf(!dsn)("agent-store handoff queued behind the fleet credential lock", () => {
  it.each([
    { outcome: "moves the store once the lock is released", storeLocked: false },
    { outcome: "still refuses a locked store within the relation lock budget", storeLocked: true },
  ])("$outcome", async ({ storeLocked }) => {
    const suffix = randomUUID().replaceAll("-", ""), storeId = randomUUID();
    const user = { uid: suffix, slug: suffix }, schema = `queued_${suffix}`, agentId = `octogee-${suffix}-coach`;
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const shared = new pg.Client({ connectionString: await provision({ gatewayClass: "shared", gatewayId: `shared-${suffix}`, token: "synthetic" }, async () => {}) });
    const admin = new pg.Client({ connectionString: dsn }), holder = new pg.Client({ connectionString: dsn });
    await shared.connect(); await admin.connect(); await holder.connect();
    let pending: Promise<void> | undefined;
    try {
      await query(shared, `CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      await query(shared, `CREATE TABLE ${pg.escapeIdentifier(schema)}.schema_meta (meta_key TEXT, role TEXT, agent_id TEXT)`);
      await query(shared, `INSERT INTO ${pg.escapeIdentifier(schema)}.schema_meta VALUES ('primary', 'agent', $1)`, [agentId]);
      await query(shared, `CREATE TABLE ${pg.escapeIdentifier(schema)}.openclaw_schema_meta (store TEXT, store_id TEXT)`);
      await query(shared, `INSERT INTO ${pg.escapeIdentifier(schema)}.openclaw_schema_meta VALUES ('agent', $1)`, [storeId]);
      if (storeLocked) {
        await shared.query("BEGIN");
        await query(shared, `SELECT * FROM ${pg.escapeIdentifier(schema)}.schema_meta`);
      }
      await holder.query("BEGIN");
      await holder.query(FLEET_CREDENTIAL_LOCK);
      const transfer = createAgentStoreOwnershipTransferer(dsn!, async () => [{ schema, storeId, agentId }]);
      pending = transfer(user, "isolated");
      const settled = pending.then(() => "moved", error => `failed:${error.code}`);
      expect(await Promise.race([settled, delay(3_000).then(() => "waiting")])).toBe("waiting");
      await holder.query("ROLLBACK");
      if (storeLocked) {
        await expect(pending).rejects.toMatchObject({ code: "55P03" });
      } else {
        await pending;
        await expect(query(shared, `SELECT * FROM ${pg.escapeIdentifier(schema)}.schema_meta`)).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await shared.query("ROLLBACK").catch(() => {});
      await holder.query("ROLLBACK").catch(() => {});
      await pending?.catch(() => {});
      await query(admin, `DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      await shared.end(); await holder.end(); await admin.end();
    }
  }, 15_000);
});
