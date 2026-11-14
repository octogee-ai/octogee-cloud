/* eslint-disable sonarjs/sql-queries -- Disposable fixture identifiers are escaped; values use query parameters. */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createAgentStoreCredentialProvisioner, createAgentStoreCredentialRevoker, createAgentStoreCredentialRetirementVerifier } from "./agent-store-credentials.js";

const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;
const roleFor = (kind: string, id: string) => `octogee_${kind}_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;

describe.skipIf(!dsn)("retired Gateway PostgreSQL login", () => {
  it("refuses boundedly under a held credential lock without issuing a proof or creating a role", async () => {
    const gatewayId = `retirement-lock-${randomUUID()}`;
    const scope = decodeURIComponent(new URL(dsn!).pathname.slice(1));
    const login = roleFor("gateway", `${scope}:${gatewayId}`);
    const blocker = new pg.Client({ connectionString: dsn });
    await blocker.connect();
    let pending: Promise<boolean> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('octogee-agent-store-credentials', 0))");
      const assertCurrent = vi.fn(async () => {});
      pending = createAgentStoreCredentialRetirementVerifier(dsn!)(gatewayId, assertCurrent);
      const unavailable = new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("retirement proof waited on the held credential lock")), 1000); timer.unref(); });
      expect(await Promise.race([pending, unavailable])).toBe(false);
      expect(assertCurrent).not.toHaveBeenCalled();
      expect((await blocker.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [login])).rows).toEqual([]);
    } finally {
      await blocker.query("ROLLBACK");
      await pending?.catch(() => {});
      await blocker.end();
    }
  }, 5000);

  it("disables only the stopped Gateway login, preserves ownership, terminates its lingering sessions and rejects stale issuance", async () => {
    const gatewayId = `retirement-${randomUUID()}`;
    const user = { uid: gatewayId, slug: gatewayId };
    const scope = decodeURIComponent(new URL(dsn!).pathname.slice(1));
    const login = roleFor("gateway", `${scope}:${gatewayId}`);
    const owner = roleFor("builder", `${scope}:${user.uid}`);
    const schema = `retirement_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Client({ connectionString: dsn });
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const revoke = createAgentStoreCredentialRevoker(dsn!);
    const verify = createAgentStoreCredentialRetirementVerifier(dsn!);
    const identity = { gatewayId, gatewayClass: "isolated" as const, user, token: "synthetic-retirement" };
    const neighbourGatewayId = `retirement-neighbour-${randomUUID()}`;
    const neighbourLogin = roleFor("gateway", `${scope}:${neighbourGatewayId}`);
    let active: pg.Client | undefined;
    let neighbour: pg.Client | undefined;
    await admin.connect();
    try {
      const url = await provision(identity, async () => {});
      active = new pg.Client({ connectionString: url });
      active.on("error", () => {});
      await active.connect();
      await active.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      neighbour = new pg.Client({ connectionString: await provision({ ...identity, gatewayId: neighbourGatewayId }, async () => {}) });
      await neighbour.connect();
      const before = await admin.query("SELECT oid, nspowner FROM pg_namespace WHERE nspname = $1", [schema]);
      const membershipsBefore = await admin.query("SELECT roleid, member, grantor, admin_option, inherit_option, set_option FROM pg_auth_members WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = $1) ORDER BY grantor", [login]);
      expect(await verify(gatewayId, async () => {})).toBe(false);
      const disconnected = new Promise<void>(resolve => active!.once("end", resolve));
      await revoke(gatewayId, async () => {});
      await disconnected;
      active = undefined;
      expect((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [login])).rows[0].rolcanlogin).toBe(false);
      expect((await admin.query("SELECT 1 FROM pg_stat_activity WHERE usename = $1", [login])).rowCount).toBe(0);
      expect((await neighbour.query("SELECT 1 AS alive")).rows[0].alive).toBe(1);
      expect((await admin.query("SELECT roleid, member, grantor, admin_option, inherit_option, set_option FROM pg_auth_members WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = $1) ORDER BY grantor", [login])).rows).toEqual(membershipsBefore.rows);
      expect(await verify(gatewayId, async () => {})).toBe(true);
      await admin.query(`ALTER ROLE ${pg.escapeIdentifier(login)} LOGIN`);
      expect(await verify(gatewayId, async () => {})).toBe(false);
      let checks = 0;
      await expect(revoke(gatewayId, async () => { if (++checks === 2) throw new Error("claim lost"); })).rejects.toThrow("claim lost");
      expect((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [login])).rows[0].rolcanlogin).toBe(true);
      await revoke(gatewayId, async () => {});
      await revoke(gatewayId, async () => {});
      expect((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [login])).rows[0].rolcanlogin).toBe(false);
      expect(await verify(gatewayId, async () => {})).toBe(true);
      await expect(verify(gatewayId, async () => { throw new Error("retirement proof changed"); })).rejects.toThrow("retirement proof changed");
      expect((await admin.query("SELECT oid, nspowner FROM pg_namespace WHERE nspname = $1", [schema])).rows).toEqual(before.rows);
      expect((await admin.query("SELECT 1 FROM pg_auth_members m JOIN pg_roles p ON p.oid = m.roleid JOIN pg_roles c ON c.oid = m.member WHERE p.rolname = $1 AND c.rolname = $2", [owner, login])).rowCount).toBe(1);
      await expect(provision(identity, async () => { throw new Error("Gateway retired"); })).rejects.toThrow("Gateway retired");
      checks = 0;
      await expect(provision(identity, async () => { if (++checks === 2) throw new Error("Gateway retired before commit"); })).rejects.toThrow("Gateway retired before commit");
      expect((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [login])).rows[0].rolcanlogin).toBe(false);
      const blocker = new pg.Client({ connectionString: dsn });
      await blocker.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('octogee-agent-store-credentials', 0))");
        const queuedUrl = new URL(dsn!);
        queuedUrl.searchParams.set("application_name", gatewayId);
        const delayedProvision = createAgentStoreCredentialProvisioner(queuedUrl.toString(), dsn!);
        let retired = false;
        pending = delayedProvision(identity, async () => { if (retired) throw new Error("queued issuer lost custody"); }).then(() => "unexpected issuance", error => error.message);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'", [gatewayId]);
          if (result.rowCount) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        retired = true;
        await blocker.query("COMMIT");
        expect(await pending).toBe("queued issuer lost custody");
        expect((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [login])).rows[0].rolcanlogin).toBe(false);
      } finally {
        await blocker.query("ROLLBACK");
        await pending;
        await blocker.end();
      }
      await admin.query(`DROP ROLE ${pg.escapeIdentifier(login)}`);
      expect(await verify(gatewayId, async () => {})).toBe(true);
      await revoke(`absent-${gatewayId}`, async () => {});
    } finally {
      await active?.end();
      await neighbour?.end();
      await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(neighbourLogin)}`);
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      const remaining = await admin.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [[login, owner]]);
      if (remaining.rowCount) await admin.query(`DROP OWNED BY ${remaining.rows.map(row => pg.escapeIdentifier(row.rolname)).join(", ")}`);
      await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(login)}, ${pg.escapeIdentifier(owner)}`);
      await admin.end();
    }
  });
});
