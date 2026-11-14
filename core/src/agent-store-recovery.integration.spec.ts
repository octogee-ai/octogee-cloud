/* eslint-disable sonarjs/sql-queries -- Disposable fixture identifiers are escaped; values use query parameters. */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createMigrationClient } from "./fleet-migration-client.js";
import { createAgentStoreCredentialProvisioner, createAgentStoreOwnershipTransferer } from "./agent-store-credentials.js";

const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;
const roleFor = (kind: string, id: string) => `octogee_${kind}_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;

async function waitForQueuedTransfer(admin: pg.Client, applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'", [applicationName]);
    if (waiting.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("The exact fixture transfer did not queue behind the PostgreSQL advisory lock");
}

describe.skipIf(!dsn)("claimed PostgreSQL source recovery", () => {
  it.each(["queued-claim-loss", "commit-claim-loss", "success"] as const)("retains store identity and rolls back stale custody: %s", async scenario => {
    const nonce = randomUUID().replaceAll("-", "");
    const user = { uid: `recovery-${nonce}`, slug: `recovery-${nonce}` };
    const schema = `recovery_${nonce}`;
    const applicationName = `recovery-transfer-${nonce}`;
    const transferUrl = new URL(dsn!); transferUrl.searchParams.set("application_name", applicationName);
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const transfer = createAgentStoreOwnershipTransferer(transferUrl.toString(), async () => [{ schema, agentId: `octogee-${user.slug}-coach`, storeId }]);
    const sharedId = `recovery-shared-${nonce}`, isolatedId = `recovery-user-${nonce}`;
    const scope = decodeURIComponent(new URL(dsn!).pathname.slice(1));
    const fixtureRoles = [roleFor("gateway", `${scope}:${sharedId}`), roleFor("gateway", `${scope}:${isolatedId}`), roleFor("builder", `${scope}:${user.uid}`)];
    const admin = new pg.Client({ connectionString: dsn! });
    const blocker = new pg.Client({ connectionString: dsn! });
    await admin.connect(); await blocker.connect();
    let shared: pg.Client | undefined, source: pg.Client | undefined, moving: Promise<void> | undefined;
    let fixtureVerifiedFresh = false;
    const table = (name: string) => `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}`;
    const storeId = randomUUID(), history = '{"sessionId":"retained-session","messages":[{"role":"user","text":"exact retained bytes"}]}';
    try {
      const existing = await admin.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [fixtureRoles]);
      expect(existing.rows).toEqual([]);
      expect((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rows).toEqual([]);
      fixtureVerifiedFresh = true;
      shared = new pg.Client({ connectionString: await provision({ gatewayClass: "shared", gatewayId: sharedId, token: "synthetic-shared" }, async () => {}) });
      source = new pg.Client({ connectionString: await provision({ gatewayClass: "isolated", gatewayId: isolatedId, token: "synthetic-user", user }, async () => {}) });
      await shared.connect(); await source.connect();
      await shared.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      await shared.query(`CREATE TABLE ${table("schema_meta")} (meta_key TEXT, role TEXT, agent_id TEXT, store_id TEXT)`);
      await shared.query(`INSERT INTO ${table("schema_meta")} VALUES ('primary', 'agent', $1, $2)`, [`octogee-${user.slug}-coach`, storeId]);
      await shared.query(`CREATE TABLE ${table("openclaw_schema_meta")} (store TEXT, store_id TEXT)`);
      await shared.query(`INSERT INTO ${table("openclaw_schema_meta")} VALUES ('agent', $1)`, [storeId]);
      await shared.query(`CREATE TABLE ${table("session_nodes")} (session_key TEXT PRIMARY KEY, entry_json TEXT)`);
      await shared.query(`INSERT INTO ${table("session_nodes")} VALUES ('history', $1)`, [history]);
      await transfer(user, "isolated");
      const before = await admin.query("SELECT n.oid, r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = $1", [schema]);
      let current = true, checks = 0;
      const assertCurrent = vi.fn(async () => {
        checks++;
        if (!current || scenario === "commit-claim-loss" && checks === 2) throw new Error("exact recovery claim replaced");
      });
      if (scenario === "queued-claim-loss") {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('octogee-agent-store-credentials', 0))");
      }
      moving = transfer(user, "shared", assertCurrent);
      void moving.catch(() => {});
      if (scenario === "queued-claim-loss") {
        await waitForQueuedTransfer(admin, applicationName);
        expect(assertCurrent).not.toHaveBeenCalled();
        current = false;
        await blocker.query("COMMIT");
      }
      if (scenario === "success") {
        await moving;
        expect(assertCurrent).toHaveBeenCalledTimes(2);
        expect((await shared.query(`SELECT store_id FROM ${table("schema_meta")}`)).rows).toEqual([{ store_id: storeId }]);
        expect((await shared.query(`SELECT entry_json FROM ${table("session_nodes")}`)).rows).toEqual([{ entry_json: history }]);
        await expect(source.query(`SELECT * FROM ${table("session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
      } else {
        await expect(moving).rejects.toThrow("exact recovery claim replaced");
        const after = await admin.query("SELECT n.oid, r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = $1", [schema]);
        expect(after.rows).toEqual(before.rows);
        expect((await source.query(`SELECT store_id FROM ${table("schema_meta")}`)).rows).toEqual([{ store_id: storeId }]);
        expect((await source.query(`SELECT entry_json FROM ${table("session_nodes")}`)).rows).toEqual([{ entry_json: history }]);
        await expect(shared.query(`SELECT * FROM ${table("session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
        expect(assertCurrent).toHaveBeenCalledTimes(scenario === "queued-claim-loss" ? 1 : 2);
      }
      const remainingMemberships = await admin.query("SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid JOIN pg_roles member ON member.oid = m.member WHERE member.rolname = $1 AND parent.rolname = $2", [roleFor("shared", scope), fixtureRoles[2]]);
      expect(remainingMemberships.rows).toEqual([]);
    } finally {
      await blocker.query("ROLLBACK");
      await moving?.catch(() => {});
      await shared?.end(); await source?.end(); await blocker.end();
      try {
        if (fixtureVerifiedFresh) {
          await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
          const owner = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [fixtureRoles[2]]);
          if (owner.rowCount) await admin.query(`REVOKE CONNECT, CREATE ON DATABASE ${pg.escapeIdentifier(scope)} FROM ${pg.escapeIdentifier(fixtureRoles[2]!)}`);
          for (const role of fixtureRoles) await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(role)}`);
        }
      } finally { await admin.end(); }
    }
  }, 30_000);
});


describe.skipIf(!dsn)("native return PostgreSQL source resume", () => {
  it("removes old Shared access while preserving the canonical store UUID and history", async () => {
    const nonce = randomUUID().replaceAll("-", "");
    const user = { uid: `return-${nonce}`, slug: `return-${nonce}` };
    const schema = `return_${nonce}`, sharedId = `shared-${nonce}`, sourceId = `builder-${nonce}`;
    const scope = decodeURIComponent(new URL(dsn!).pathname.slice(1));
    const fixtureRoles = [roleFor("gateway", `${scope}:${sharedId}`), roleFor("gateway", `${scope}:${sourceId}`), roleFor("builder", `${scope}:${user.uid}`)];
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const transfer = createAgentStoreOwnershipTransferer(dsn!, async () => [{ schema, agentId: `octogee-${user.slug}-coach`, storeId }]);
    const admin = new pg.Client({ connectionString: dsn! });
    await admin.connect();
    let shared: pg.Client | undefined, source: pg.Client | undefined;
    let fixtureVerifiedFresh = false;
    const table = (name: string) => `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}`;
    const storeId = randomUUID(), history = '{"text":"retained native return history"}';
    try {
      expect((await admin.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [fixtureRoles])).rows).toEqual([]);
      expect((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rows).toEqual([]);
      fixtureVerifiedFresh = true;
      shared = new pg.Client({ connectionString: await provision({ gatewayClass: "shared", gatewayId: sharedId, token: "synthetic-shared" }, async () => {}) });
      source = new pg.Client({ connectionString: await provision({ gatewayClass: "isolated", gatewayId: sourceId, token: "synthetic-user", user }, async () => {}) });
      await shared.connect(); await source.connect();
      await shared.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      await shared.query(`CREATE TABLE ${table("schema_meta")} (meta_key TEXT, role TEXT, agent_id TEXT, store_id TEXT)`);
      await shared.query(`INSERT INTO ${table("schema_meta")} VALUES ('primary', 'agent', $1, $2)`, [`octogee-${user.slug}-coach`, storeId]);
      await shared.query(`CREATE TABLE ${table("openclaw_schema_meta")} (store TEXT, store_id TEXT)`);
      await shared.query(`INSERT INTO ${table("openclaw_schema_meta")} VALUES ('agent', $1)`, [storeId]);
      await shared.query(`CREATE TABLE ${table("session_nodes")} (entry_json TEXT)`);
      await shared.query(`INSERT INTO ${table("session_nodes")} VALUES ($1)`, [history]);
      const before = await admin.query("SELECT oid FROM pg_namespace WHERE nspname = $1", [schema]);
      expect((await shared.query(`SELECT store_id FROM ${table("schema_meta")}`)).rows).toEqual([{ store_id: storeId }]);
      const prepareAgentStores = vi.fn(async (gatewayId: string, slug: string) => {
        expect(gatewayId).toBe(sourceId); expect(slug).toBe(user.slug);
        await transfer(user, "isolated");
      });
      const fetch: typeof globalThis.fetch = vi.fn(async () => {
        expect(prepareAgentStores).toHaveBeenCalledOnce();
        await expect(shared!.query(`SELECT * FROM ${table("schema_meta")}`)).rejects.toMatchObject({ code: "42501" });
        return new Response(JSON.stringify({ resumed: true }));
      });
      const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const client = createMigrationClient({ privateKey, resolveGatewayUrl: () => "http://synthetic-source.invalid", fetch, prepareAgentStores,
        transferState: vi.fn() });
      await client.resume({ gatewayId: sourceId, slug: user.slug, migrationId: `return-${nonce}` });
      expect(fetch).toHaveBeenCalledOnce();
      expect((await source.query(`SELECT store_id FROM ${table("schema_meta")}`)).rows).toEqual([{ store_id: storeId }]);
      expect((await source.query(`SELECT entry_json FROM ${table("session_nodes")}`)).rows).toEqual([{ entry_json: history }]);
      expect((await admin.query("SELECT oid FROM pg_namespace WHERE nspname = $1", [schema])).rows).toEqual(before.rows);
    } finally {
      await shared?.end(); await source?.end();
      try {
        if (fixtureVerifiedFresh) {
          await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
          const owner = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [fixtureRoles[2]]);
          if (owner.rowCount) await admin.query(`REVOKE CONNECT, CREATE ON DATABASE ${pg.escapeIdentifier(scope)} FROM ${pg.escapeIdentifier(fixtureRoles[2]!)}`);
          for (const role of fixtureRoles) await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(role)}`);
        }
      } finally { await admin.end(); }
    }
  }, 30_000);
});
