/* eslint-disable sonarjs/sql-queries -- Synthetic fixture identifiers are escaped; SQL values use query parameters. */
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentStoreCredentialProvisioner, createAgentStoreCredentialRevoker, createAgentStoreOwnershipTransferer, assertNoUserAgentStores, eraseUserAgentStores, type AgentStoreErasureTarget } from "./agent-store-credentials.js";
import { readAuthProfileStore, readAuthProfileState, writeAuthProfileStore, deleteAuthProfileStore, sharedAuthStoreUsable } from "./auth-profile-store.js";
import { purgeUserOauthRuntimeArtifacts } from "./byosub-restore.js";
import { assertTrustedAgentStoreRoutines } from "./agent-store-routines.js";

const nativeTriggerBodies = {
  openclaw_session_conversations_trigger: `
BEGIN
  UPDATE session_conversations SET route_context_json = NULL WHERE session_id = NEW.session_id AND conversation_id = NEW.conversation_id AND role = NEW.role;
  RETURN NULL;
END;
`,
  openclaw_session_entry_snapshots_trigger: `
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1 WHERE session_key = OLD.session_key;
  ELSIF TG_OP = 'INSERT' THEN
    UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1 WHERE session_key = NEW.session_key;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE session_nodes SET snapshot_revision = snapshot_revision + 1 WHERE session_key IN (OLD.session_key, NEW.session_key);
  END IF;
  RETURN NULL;
END;
`,
};

async function createNativeTriggers(client: pg.Client, schema: string) {
  await client.query(`SET search_path = ${pg.escapeIdentifier(schema)}`);
  for (const [name, body] of Object.entries(nativeTriggerBodies)) {
    await client.query(`CREATE FUNCTION ${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS ${pg.escapeLiteral(body)}`);
  }
}

const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;
const roleFor = (kind: string, id: string) => `octogee_${kind}_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe.skipIf(!dsn)("PostgreSQL agent store", () => {
  it("reads, restores, and removes shared auth in PostgreSQL state without changing its runtime state or legacy agent store", async () => {
    const client = new pg.Client({ connectionString: dsn }); await client.connect();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-state-pg-auth-")); roots.push(root);
    const main = path.join(root, "agents/main/agent"), storeId = randomUUID(), schema = "auth_state_" + randomUUID().replaceAll("-", "");
    const table = (name: string) => `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}`;
    const previous = process.env.OPENCLAW_AGENT_STORE_DSN; process.env.OPENCLAW_AGENT_STORE_DSN = dsn;
    try {
      await client.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      await client.query(`CREATE TABLE ${table("openclaw_schema_meta")} (store TEXT PRIMARY KEY, store_id TEXT NOT NULL)`);
      await client.query(`INSERT INTO ${table("openclaw_schema_meta")} VALUES ('state', $1)`, [storeId]);
      await client.query(`CREATE TABLE ${table("config_machine_state")} (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms BIGINT NOT NULL)`);
      await client.query(`INSERT INTO ${table("config_machine_state")} VALUES ('auth.sharedStore', $1, 1), ('authProfiles.store', $2, 1), ('authProfiles.state', $3, 1), ('fixture.history', $4, 1)`, [JSON.stringify({ location: "state-db" }), JSON.stringify({ profiles: { original: "synthetic" } }), JSON.stringify({ state: "retained" }), JSON.stringify({ history: "retained" })]);
      await fs.mkdir(path.join(root, "state"), { recursive: true }); await fs.mkdir(main, { recursive: true });
      const anchor = new DatabaseSync(path.join(root, "state/openclaw.sqlite"));
      anchor.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)");
      anchor.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(storeId, schema); anchor.close();
      const stale = new DatabaseSync(path.join(main, "openclaw-agent.sqlite"));
      stale.exec("CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at BIGINT NOT NULL)");
      stale.prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)").run(JSON.stringify({ profiles: { stale: "synthetic" } })); stale.close();
      expect(await sharedAuthStoreUsable(root)).toBe(true);
      expect(await readAuthProfileStore(main)).toEqual({ profiles: { original: "synthetic" } });
      expect(await readAuthProfileState(main)).toEqual({ state: "retained" });
      await writeAuthProfileStore(main, { profiles: { restored: "synthetic" } });
      expect(await readAuthProfileStore(main)).toEqual({ profiles: { restored: "synthetic" } });
      await deleteAuthProfileStore(main);
      expect(await readAuthProfileStore(main)).toBeNull();
      expect(await readAuthProfileState(main)).toEqual({ state: "retained" });
      expect((await client.query(`SELECT value_json FROM ${table("config_machine_state")} WHERE state_key = 'fixture.history'`)).rows).toEqual([{ value_json: JSON.stringify({ history: "retained" }) }]);
      const legacy = new DatabaseSync(path.join(main, "openclaw-agent.sqlite"), { readOnly: true });
      try { expect(JSON.parse((legacy.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'").get() as { store_json: string }).store_json)).toEqual({ profiles: { stale: "synthetic" } }); } finally { legacy.close(); }
      await client.query(`INSERT INTO ${table("config_machine_state")} VALUES ('authProfiles.store', $1, 1)`, ['{"synthetic-private-token":']);
      await expect(readAuthProfileStore(main)).rejects.toThrow("PostgreSQL auth profile payload is not valid JSON");
      await client.query(`UPDATE ${table("config_machine_state")} SET value_json = $1 WHERE state_key = 'auth.sharedStore'`, [JSON.stringify({ location: "legacy-main" })]);
      expect(await sharedAuthStoreUsable(root)).toBe(true);
      expect(await readAuthProfileStore(main)).toEqual({ profiles: { stale: "synthetic" } });
      await writeAuthProfileStore(main, { profiles: { legacy: "synthetic" } });
      expect(await readAuthProfileStore(main)).toEqual({ profiles: { legacy: "synthetic" } });
      await deleteAuthProfileStore(main); expect(await readAuthProfileStore(main)).toBeNull();
      await client.query(`UPDATE ${table("config_machine_state")} SET value_json = $1 WHERE state_key = 'auth.sharedStore'`, [JSON.stringify({ location: "state-db" })]);
      await client.query(`UPDATE ${table("openclaw_schema_meta")} SET store_id = $1 WHERE store = 'state'`, [randomUUID()]);
      await expect(readAuthProfileStore(main)).rejects.toThrow("state store identity");
      await client.query(`UPDATE ${table("openclaw_schema_meta")} SET store_id = $1 WHERE store = 'state'`, [storeId]);
      await client.query(`REVOKE SELECT ON ${table("config_machine_state")} FROM CURRENT_USER`);
      try {
        await expect(sharedAuthStoreUsable(root)).rejects.toMatchObject({ code: "42501" });
        await expect(readAuthProfileStore(main)).rejects.toMatchObject({ code: "42501" });
      } finally { await client.query(`GRANT SELECT ON ${table("config_machine_state")} TO CURRENT_USER`); }
      await client.query(`UPDATE ${table("config_machine_state")} SET value_json = $1 WHERE state_key = 'auth.sharedStore'`, ['{"location":"foreign"}']);
      await expect(sharedAuthStoreUsable(root)).rejects.toThrow("shared auth ownership");
      await expect(readAuthProfileStore(main)).rejects.toThrow("shared auth ownership");
      await expect(writeAuthProfileStore(main, {})).rejects.toThrow("shared auth ownership");
      await expect(deleteAuthProfileStore(main)).rejects.toThrow("shared auth ownership");
      await client.query(`DELETE FROM ${table("config_machine_state")} WHERE state_key = 'auth.sharedStore'`);
      await fs.rm(path.join(main, "openclaw-agent.sqlite"));
      expect(await sharedAuthStoreUsable(root)).toBe(false);
      expect(await readAuthProfileStore(main)).toBeNull();
      await client.query(`DROP TABLE ${table("config_machine_state")}`);
      await expect(sharedAuthStoreUsable(root)).rejects.toMatchObject({ code: "42P01" });
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_AGENT_STORE_DSN; else process.env.OPENCLAW_AGENT_STORE_DSN = previous;
      await client.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`); await client.end();
    }
  });
  it("erases only immutable due-deletion targets and reconciles a committed drop without adopting replacements", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const user = { uid: `erase-${suffix}`, slug: `erase-${suffix}` };
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const sharedDsn = await provision({ gatewayClass: "shared", gatewayId: `shared-erase-${suffix}`, token: "synthetic-shared" }, async () => {});
    const shared = new pg.Client({ connectionString: sharedDsn });
    const admin = new pg.Client({ connectionString: dsn! });
    await shared.connect(); await admin.connect();
    const schema = `erase_${suffix}`, other = `other_${suffix}`;
    const object = (namespace: string, name: string) => `${pg.escapeIdentifier(namespace)}.${pg.escapeIdentifier(name)}`;
    const create = async (namespace: string, agentId: string, creator = shared) => {
      await creator.query(`CREATE SCHEMA ${pg.escapeIdentifier(namespace)}`);
      await creator.query(`CREATE TABLE ${object(namespace, "openclaw_schema_meta")} (store TEXT PRIMARY KEY, version BIGINT, store_id TEXT)`);
      await creator.query(`INSERT INTO ${object(namespace, "openclaw_schema_meta")} VALUES ('agent', 1, $1)`, [randomUUID()]);
      await creator.query(`CREATE TABLE ${object(namespace, "schema_meta")} (meta_key TEXT PRIMARY KEY, role TEXT, agent_id TEXT)`);
      await creator.query(`INSERT INTO ${object(namespace, "schema_meta")} VALUES ('primary', 'agent', $1)`, [agentId]);
      await creator.query(`CREATE TABLE ${object(namespace, "history")} (id BIGINT PRIMARY KEY, body TEXT)`);
      await creator.query(`INSERT INTO ${object(namespace, "history")} VALUES (1, 'retained-history')`);
    };
    let bound: readonly AgentStoreErasureTarget[] | undefined;
    const effects = { stopped: true, current: true, claims: 0, stoppedGateways: ["shared-test"] };
    const guards = {
      assertCurrent: async () => { effects.claims++; if (!effects.current) throw new Error("deletion claim lost"); },
      assertWritersStopped: async () => {
        if (!effects.stopped) throw new Error("retained runtime exists");
        return effects.stoppedGateways;
      },
      bindTargets: async (targets: readonly AgentStoreErasureTarget[]) => bound ??= targets,
    };
    try {
      await create(schema, `octogee-${user.slug}-coach`);
      await create(other, "octogee-other-coach");
      await shared.query(`CREATE FUNCTION ${object(schema, "sync_history")}() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`);
      await shared.query(`CREATE TRIGGER memory_index_chunks_vec_sync AFTER INSERT ON ${object(schema, "history")} FOR EACH ROW EXECUTE FUNCTION ${object(schema, "sync_history")}()`);
      await shared.query(`ALTER TABLE ${object(schema, "history")} ALTER COLUMN body SET DEFAULT 'created'`);
      await shared.query(`ALTER TABLE ${object(schema, "history")} ADD CHECK (id > 0)`);
      await shared.query(`CREATE SEQUENCE ${object(schema, "history_id")}`);
      await shared.query(`ALTER TABLE ${object(schema, "history")} ALTER COLUMN id SET DEFAULT nextval(${pg.escapeLiteral(object(schema, "history_id"))}::regclass)`);
      await shared.query(`CREATE TEXT SEARCH CONFIGURATION ${object(schema, "native_search")} (COPY = pg_catalog.simple)`);
      effects.stopped = false;
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("retained runtime");
      expect(bound).toBeUndefined();
      effects.stopped = true;
      effects.current = false;
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("claim lost");
      effects.current = true;
      await shared.query(`CREATE VIEW ${object(other, "foreign_reference")} AS SELECT * FROM ${object(schema, "history")}`);
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("dependency");
      expect(bound).toHaveLength(1);
      await shared.query(`DROP VIEW ${object(other, "foreign_reference")}`);
      await shared.query(`CREATE TRIGGER foreign_trigger AFTER INSERT ON ${object(other, "history")} FOR EACH ROW EXECUTE FUNCTION ${object(schema, "sync_history")}()`);
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("dependency");
      await shared.query(`DROP TRIGGER foreign_trigger ON ${object(other, "history")}`);
      await shared.query(`GRANT USAGE ON SCHEMA ${pg.escapeIdentifier(schema)} TO PUBLIC`);
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("schema grants");
      await shared.query(`REVOKE USAGE ON SCHEMA ${pg.escapeIdentifier(schema)} FROM PUBLIC`);
      await expect(eraseUserAgentStores(dsn!, user, { ...guards, bindTargets: async targets => {
        const result = await guards.bindTargets(targets); effects.current = false; return result;
      } })).rejects.toThrow("claim lost");
      expect((await shared.query(`SELECT body FROM ${object(schema, "history")}`)).rowCount).toBe(1);
      effects.current = true;
      let checks = 0;
      await expect(eraseUserAgentStores(dsn!, user, { ...guards, assertCurrent: async () => {
        await guards.assertCurrent();
        if (++checks !== 2) return;
        await shared.query(`CREATE TRIGGER concurrent_foreign_trigger AFTER INSERT ON ${object(other, "history")} FOR EACH ROW EXECUTE FUNCTION ${object(schema, "sync_history")}()`);
      } })).rejects.toThrow("depend");
      expect((await shared.query(`SELECT body FROM ${object(schema, "history")}`)).rowCount).toBe(1);
      expect((await shared.query("SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'concurrent_foreign_trigger' AND tgrelid = $1::regclass", [object(other, "history")])).rowCount).toBe(1);
      await shared.query(`DROP TRIGGER concurrent_foreign_trigger ON ${object(other, "history")}`);
      await eraseUserAgentStores(dsn!, user, guards);
      await expect(assertNoUserAgentStores(dsn!, user)).resolves.toBeUndefined();
      expect((await shared.query(`SELECT body FROM ${object(other, "history")}`)).rows).toEqual([{ body: "retained-history" }]);
      await eraseUserAgentStores(dsn!, user, guards);
      await create(schema, `octogee-${user.slug}-coach`);
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("changed");
      expect((await shared.query(`SELECT body FROM ${object(schema, "history")}`)).rowCount).toBe(1);
      bound = undefined;
      const isolatedGateway = `user-erase-${suffix}`;
      const userDsn = await provision({ gatewayClass: "isolated", gatewayId: isolatedGateway, token: "synthetic-user", user }, async () => {});
      await admin.query(`DROP SCHEMA ${pg.escapeIdentifier(schema)} CASCADE`);
      const userClient = new pg.Client({ connectionString: userDsn }); await userClient.connect();
      try { await create(schema, `octogee-${user.slug}-coach`, userClient); } finally { await userClient.end(); }
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("user Gateway login");
      expect(bound).toBeUndefined();
      effects.stoppedGateways.push(isolatedGateway);
      await eraseUserAgentStores(dsn!, user, guards);
      await expect(assertNoUserAgentStores(dsn!, user)).resolves.toBeUndefined();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(other)} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      await shared.end(); await admin.end();
    }
  });

  it("erases a retired claimed user's agent and global stores while preserving Shared system and foreign user stores", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const user = { uid: `erase-system-${suffix}`, slug: `erase-system-${suffix}` };
    const gatewayId = `user-erase-system-${suffix}`;
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const sharedDsn = await provision({ gatewayClass: "shared", gatewayId: `shared-system-${suffix}`, token: "synthetic-shared" }, async () => {});
    const unownedDsn = await provision({ gatewayClass: "isolated", gatewayId, token: "synthetic-user" }, async () => {});
    const shared = new pg.Client({ connectionString: sharedDsn }), unowned = new pg.Client({ connectionString: unownedDsn });
    const admin = new pg.Client({ connectionString: dsn! });
    await shared.connect(); await unowned.connect(); await admin.connect();
    const names = Object.fromEntries(["coach", "unmatched", "state", "foreign", "sharedDefaultAgent", "sharedUnmatched", "sharedState", "sharedForeign"]
      .map(name => [name, `erase_${name.toLowerCase()}_${suffix}`])) as Record<string, string>;
    const object = (namespace: string, name: string) => `${pg.escapeIdentifier(namespace)}.${pg.escapeIdentifier(name)}`;
    const create = async (creator: pg.Client, namespace: string, family: "agent" | "state", agentId: string | null) => {
      await creator.query(`CREATE SCHEMA ${pg.escapeIdentifier(namespace)}`);
      await creator.query(`CREATE TABLE ${object(namespace, "openclaw_schema_meta")} (store TEXT PRIMARY KEY, version BIGINT, store_id TEXT)`);
      await creator.query(`INSERT INTO ${object(namespace, "openclaw_schema_meta")} VALUES ($1, 1, $2)`, [family, randomUUID()]);
      await creator.query(`CREATE TABLE ${object(namespace, "schema_meta")} (meta_key TEXT PRIMARY KEY, role TEXT, agent_id TEXT)`);
      await creator.query(`INSERT INTO ${object(namespace, "schema_meta")} VALUES ('primary', $1, $2)`, [family === "state" ? "global" : "agent", agentId]);
      await creator.query(`CREATE TABLE ${object(namespace, "history")} (body TEXT)`);
      await creator.query(`INSERT INTO ${object(namespace, "history")} VALUES ('retained-history')`);
    };
    let bound: readonly AgentStoreErasureTarget[] | undefined;
    const stopped: string[] = [];
    const guards = {
      assertCurrent: async () => undefined,
      assertWritersStopped: async () => stopped,
      bindTargets: async (targets: readonly AgentStoreErasureTarget[]) => bound ??= targets,
    };
    let claimed: pg.Client | undefined;
    try {
      await create(unowned, names.unmatched!, "agent", "octogee-unmatched-route");
      await create(unowned, names.state!, "state", null);
      const userDsn = await provision({ gatewayClass: "isolated", gatewayId, token: "synthetic-user", user }, async () => {});
      claimed = new pg.Client({ connectionString: userDsn }); await claimed.connect();
      await create(claimed, names.coach!, "agent", `octogee-${user.slug}-coach`);
      await create(shared, names.sharedDefaultAgent!, "agent", `octogee-${user.slug}-proj-project-coach`);
      await create(shared, names.sharedUnmatched!, "agent", "octogee-unmatched-route");
      await create(shared, names.sharedState!, "state", null);
      await create(shared, names.sharedForeign!, "agent", "octogee-other-coach");
      await create(claimed, names.foreign!, "agent", "octogee-other-coach");
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("foreign user data");
      expect(bound).toBeUndefined();
      await claimed.query(`DROP SCHEMA ${pg.escapeIdentifier(names.foreign!)} CASCADE`);
      await claimed.query(`UPDATE ${object(names.state!, "openclaw_schema_meta")} SET store = 'workboard'`);
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("identity is unavailable");
      await claimed.query(`UPDATE ${object(names.state!, "openclaw_schema_meta")} SET store = 'state'`);
      await claimed.query(`UPDATE ${object(names.state!, "schema_meta")} SET agent_id = $1`, [`octogee-${user.slug}-coach`]);
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("identity is unavailable");
      await claimed.query(`UPDATE ${object(names.state!, "schema_meta")} SET agent_id = NULL`);
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("user Gateway login");
      expect(bound).toBeUndefined();
      stopped.push(gatewayId);
      await admin.query(`CREATE VIEW ${object(names.sharedForeign!, "foreign_reference")} AS SELECT * FROM ${object(names.state!, "history")}`);
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("dependency");
      await admin.query(`DROP VIEW ${object(names.sharedForeign!, "foreign_reference")}`);
      await claimed.query(`CREATE FUNCTION ${object(names.state!, "foreign_owned")}() RETURNS integer LANGUAGE SQL AS 'SELECT 1'`);
      const { rows: [{ current_user: administrator }] } = await admin.query("SELECT current_user");
      await admin.query(`ALTER FUNCTION ${object(names.state!, "foreign_owned")}() OWNER TO ${pg.escapeIdentifier(administrator)}`);
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("routine privileges");
      await admin.query(`DROP FUNCTION ${object(names.state!, "foreign_owned")}()`);
      const savedStateId = bound!.find(target => target.namespace === names.state)!.storeId;
      await claimed.query(`UPDATE ${object(names.state!, "openclaw_schema_meta")} SET store_id = $1`, [randomUUID()]);
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("changed");
      await claimed.query(`UPDATE ${object(names.state!, "openclaw_schema_meta")} SET store_id = $1`, [savedStateId]);
      for (const name of ["coach", "unmatched", "state", "sharedDefaultAgent"]) {
        expect((await admin.query(`SELECT body FROM ${object(names[name]!, "history")}`)).rowCount).toBe(1);
      }
      await eraseUserAgentStores(dsn!, user, guards);
      expect(bound).toHaveLength(4);
      expect(bound).toEqual(expect.arrayContaining([
        expect.objectContaining({ namespace: names.unmatched, family: "agent", role: "agent", agentId: "octogee-unmatched-route" }),
        expect.objectContaining({ namespace: names.state, family: "state", role: "global", agentId: null }),
      ]));
      await expect(assertNoUserAgentStores(dsn!, user)).resolves.toBeUndefined();
      for (const name of ["sharedUnmatched", "sharedState", "sharedForeign"]) {
        expect((await shared.query(`SELECT body FROM ${object(names[name]!, "history")}`)).rows).toEqual([{ body: "retained-history" }]);
      }
      await eraseUserAgentStores(dsn!, user, guards);
      await create(claimed, names.state!, "state", null);
      await expect(eraseUserAgentStores(dsn!, user, guards)).rejects.toThrow("changed");
      expect((await claimed.query(`SELECT body FROM ${object(names.state!, "history")}`)).rowCount).toBe(1);
    } finally {
      for (const namespace of Object.values(names)) await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(namespace)} CASCADE`);
      await claimed?.end(); await unowned.end(); await shared.end(); await admin.end();
    }
  });

  it("erases a user whose retired Gateway left only a disabled login, under an administrator held by a setup login", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const user = { uid: `retired-${suffix}`, slug: `retired-${suffix}` };
    const gatewayId = `user-retired-${suffix}`;
    const scope = decodeURIComponent(new URL(dsn!).pathname.slice(1));
    const id = pg.escapeIdentifier;
    const owner = roleFor("builder", `${scope}:${user.uid}`), login = roleFor("gateway", `${scope}:${gatewayId}`);
    const controller = `controller_${suffix}`;
    const controllerUrl = new URL(dsn!); controllerUrl.username = controller; controllerUrl.password = "";
    const controllerDsn = controllerUrl.toString();
    const schema = `retired_${suffix}`;
    const setup = new pg.Client({ connectionString: dsn! }); await setup.connect();
    const { rows: [{ current_user: setupLogin }] } = await setup.query("SELECT current_user");
    await createAgentStoreCredentialProvisioner(dsn!, dsn!)({ gatewayClass: "shared", gatewayId: `shared-retired-${suffix}`, token: "synthetic-shared" }, async () => {});
    await setup.query(`CREATE ROLE ${id(controller)} LOGIN CREATEROLE`);
    await setup.query(`GRANT ${id(controller)} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`);
    await setup.query(`GRANT ${id(roleFor("shared", scope))} TO ${id(controller)} WITH ADMIN OPTION`);
    await setup.query(`GRANT CONNECT, CREATE ON DATABASE ${id(scope)} TO ${id(controller)} WITH GRANT OPTION`);
    const administrator = new pg.Client({ connectionString: controllerDsn });
    const stopped = [`shared-source-${suffix}`];
    const guards = {
      assertCurrent: async () => undefined,
      assertWritersStopped: async () => stopped,
      bindTargets: async (targets: readonly AgentStoreErasureTarget[]) => targets,
    };
    try {
      const gatewayDsn = await createAgentStoreCredentialProvisioner(controllerDsn, controllerDsn)({ gatewayClass: "isolated", gatewayId, token: "synthetic-user", user }, async () => {});
      const gateway = new pg.Client({ connectionString: gatewayDsn }); await gateway.connect();
      try {
        await gateway.query(`CREATE SCHEMA ${id(schema)}`);
        await gateway.query(`CREATE TABLE ${id(schema)}.openclaw_schema_meta (store TEXT PRIMARY KEY, version BIGINT, store_id TEXT)`);
        await gateway.query(`INSERT INTO ${id(schema)}.openclaw_schema_meta VALUES ('agent', 1, $1)`, [randomUUID()]);
        await gateway.query(`CREATE TABLE ${id(schema)}.schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, agent_id TEXT)`);
        await gateway.query(`INSERT INTO ${id(schema)}.schema_meta VALUES ('primary', 'agent', $1)`, [`octogee-${user.slug}-coach`]);
      } finally { await gateway.end(); }
      const retainedLogin = (role: string) => ({ name: "AgentStoreErasureRetainedLoginError",
        message: `Agent-store erasure retains a user Gateway login without proved runtime retirement: ${role}` });
      await expect(eraseUserAgentStores(controllerDsn, user, guards)).rejects.toMatchObject(retainedLogin(login));

      await createAgentStoreCredentialRevoker(controllerDsn)(gatewayId, async () => {});
      await administrator.connect();
      await administrator.query(`GRANT ${id(owner)} TO ${id(setupLogin)}`);
      await expect(eraseUserAgentStores(controllerDsn, user, guards)).rejects.toMatchObject(retainedLogin(setupLogin));
      await administrator.query(`REVOKE ${id(owner)} FROM ${id(setupLogin)}`);

      await eraseUserAgentStores(controllerDsn, user, guards);
      await expect(assertNoUserAgentStores(controllerDsn, user)).resolves.toBeUndefined();
      expect((await setup.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rowCount).toBe(0);
    } finally {
      await administrator.end();
      await setup.query(`DROP SCHEMA IF EXISTS ${id(schema)} CASCADE`);
      await setup.query(`REVOKE CONNECT, CREATE ON DATABASE ${id(scope)} FROM ${id(controller)} CASCADE`);
      await setup.query(`REVOKE ${id(roleFor("shared", scope))} FROM ${id(controller)} CASCADE`);
      await setup.query(`REVOKE ${id(controller)} FROM CURRENT_USER`);
      await setup.end();
    }
  });

  it("hands tenant ownership between Shared and user logins without exposing another user's store", async () => {
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const transfer = createAgentStoreOwnershipTransferer(dsn!, async user => [{ schema: user.slug === "alice" ? aliceSchema : bobSchema, agentId: `octogee-${user.slug}-coach`, storeId: user.slug === "alice" ? aliceStoreId : bobStoreId }]);
    const aliceUser = { uid: "alice-uid", slug: "alice" };
    const sharedDsn = await provision({ gatewayClass: "shared", gatewayId: "shared-test", token: "synthetic-shared-password" }, async () => {});
    const admin = new pg.Client({ connectionString: dsn! });
    await admin.connect();
    const shared = new pg.Client({ connectionString: sharedDsn });
    await shared.connect();
    const suffix = randomUUID().replaceAll("-", "");
    const aliceSchema = `octogee_agent_${suffix}`, aliceStoreId = randomUUID();
    const bobSchema = `octogee_agent_b${suffix}`, bobStoreId = randomUUID();
    const rogueSchema = `octogee_agent_r${suffix}`;
    const unownedSchema = `octogee_agent_u${suffix}`;
    const object = (schema: string, table: string) => `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(table)}`;
    try {
      for (const [schema, agentId] of [[aliceSchema, "octogee-alice-coach"], [bobSchema, "octogee-bob-coach"]]) {
        await shared.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema!)}`);
        await shared.query(`CREATE TABLE ${object(schema!, "openclaw_schema_meta")} (
          store TEXT PRIMARY KEY, version BIGINT NOT NULL, store_id TEXT NOT NULL,
          fingerprint TEXT, ddl_hash TEXT, server_major BIGINT)`);
        await shared.query(`INSERT INTO ${object(schema!, "openclaw_schema_meta")} (store, version, store_id) VALUES ('agent', 1, $1)`, [schema === aliceSchema ? aliceStoreId : bobStoreId]);
        await shared.query(`CREATE TABLE ${object(schema!, "schema_meta")} (meta_key TEXT, role TEXT, agent_id TEXT)`);
        await shared.query(`INSERT INTO ${object(schema!, "schema_meta")} VALUES ('primary', 'agent', $1)`, [agentId]);
        await shared.query(`CREATE TABLE ${object(schema!, "session_nodes")} (session_key TEXT PRIMARY KEY, entry_json TEXT)`);
        await shared.query(`INSERT INTO ${object(schema!, "session_nodes")} VALUES ('history', '{"providerOverride":"openai-codex","modelOverride":"unsafe-model","sessionId":"original-session"}')`);
        await shared.query(`CREATE TABLE ${object(schema!, "auth_profile_store")} (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at BIGINT)`);
        await shared.query(`CREATE TABLE ${object(schema!, "cache_entries")} (scope TEXT, expires_at BIGINT, key TEXT)`);
        await shared.query(`CREATE INDEX idx_agent_cache_expiry ON ${object(schema!, "cache_entries")} (scope, expires_at NULLS FIRST, key) WHERE expires_at IS NOT NULL`);
        await shared.query(`INSERT INTO ${object(schema!, "cache_entries")} VALUES ('retained', 1, 'history')`);
      }
      const unownedId = `unowned-${suffix}`;
      const unownedDsn = await provision({ gatewayClass: "isolated", gatewayId: unownedId, token: "synthetic-unowned-password" }, async () => {});
      const unowned = new pg.Client({ connectionString: unownedDsn }); await unowned.connect();
      try {
        await expect(unowned.query(`SELECT * FROM ${object(bobSchema, "session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
        await unowned.query(`CREATE SCHEMA ${pg.escapeIdentifier(unownedSchema)}`);
        await unowned.query(`CREATE TABLE ${object(unownedSchema, "schema_meta")} (meta_key TEXT, role TEXT, agent_id TEXT)`);
        await unowned.query(`INSERT INTO ${object(unownedSchema, "schema_meta")} VALUES ('primary', 'state', NULL)`);
        await unowned.query(`CREATE TABLE ${object(unownedSchema, "control_state")} (value TEXT)`);
        await unowned.query(`INSERT INTO ${object(unownedSchema, "control_state")} VALUES ('preserve-unclaimed-state')`);
        await unowned.query(`CREATE TABLE ${object(unownedSchema, "state_leases")} (scope TEXT COLLATE "C" NOT NULL, lease_key TEXT COLLATE "C" NOT NULL, owner TEXT COLLATE "C" NOT NULL, expires_at BIGINT, heartbeat_at BIGINT, payload_json TEXT COLLATE "C", created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (scope, lease_key))`);
        await unowned.query(`CREATE INDEX idx_state_leases_owner ON ${object(unownedSchema, "state_leases")} ((owner) ASC NULLS FIRST)`);
        await unowned.query(`INSERT INTO ${object(unownedSchema, "state_leases")} VALUES ('gateway', 'primary', 'preserved-owner', NULL, NULL, NULL, 0, 0)`);
        const claimedDsn = await provision({ gatewayClass: "isolated", gatewayId: unownedId, token: "synthetic-unowned-password", user: { uid: "alice-uid", slug: "alice" } }, async () => {});
        expect(claimedDsn).toBe(unownedDsn);
        await transfer(aliceUser, "isolated");
        expect((await unowned.query(`SELECT * FROM ${object(aliceSchema, "session_nodes")}`)).rowCount).toBe(1);
        expect((await unowned.query(`SELECT key FROM ${object(aliceSchema, "cache_entries")}`)).rows).toEqual([{ key: "history" }]);
        await expect(shared.query(`SELECT * FROM ${object(aliceSchema, "cache_entries")}`)).rejects.toMatchObject({ code: "42501" });
        const claimed = new pg.Client({ connectionString: claimedDsn }); await claimed.connect();
        try {
          expect((await claimed.query(`SELECT * FROM ${object(unownedSchema, "control_state")}`)).rows).toEqual([{ value: "preserve-unclaimed-state" }]);
          expect((await claimed.query(`SELECT owner FROM ${object(unownedSchema, "state_leases")}`)).rows).toEqual([{ owner: "preserved-owner" }]);
        }
        finally { await claimed.end(); }
      } finally { await unowned.end(); }
      const aliceDsn = await provision({ gatewayClass: "isolated", gatewayId: "native-alice", token: "synthetic-alice-password", user: { uid: "alice-uid", slug: "alice" } }, async () => {});
      const alice = new pg.Client({ connectionString: aliceDsn });
      await alice.connect();
      try {
        await expect(alice.query(`SELECT * FROM ${object(bobSchema, "session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
        await alice.query(`ALTER TABLE ${object(aliceSchema, "session_nodes")} ADD COLUMN handoff_check TEXT`);
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-pg-auth-")); roots.push(root);
        const agentDir = path.join(root, "agents/octogee-alice-coach/agent");
        await fs.mkdir(agentDir, { recursive: true });
        const anchor = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
        anchor.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
        anchor.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(randomUUID(), aliceSchema);
        anchor.close();
        const previous = process.env.OPENCLAW_AGENT_STORE_DSN;
        process.env.OPENCLAW_AGENT_STORE_DSN = aliceDsn;
        try {
          const profile = { version: 1, profiles: { "anthropic:default": { type: "api_key", provider: "anthropic", key: "synthetic-key" } } };
          await writeAuthProfileStore(agentDir, profile);
          expect(await readAuthProfileStore(agentDir)).toEqual(profile);
          const result = await purgeUserOauthRuntimeArtifacts({ openclawDir: root, homeDir: root, agentIds: ["octogee-alice-coach"], allowedModelRefs: ["anthropic/safe"], allowedProviderIds: ["anthropic"] });
          expect(result.resetSessions).toBe(1);
          const { rows: [row] } = await alice.query(`SELECT entry_json FROM ${object(aliceSchema, "session_nodes")} WHERE session_key = 'history'`);
          expect(JSON.parse(row.entry_json)).toMatchObject({ sessionId: "original-session" });
          expect(JSON.parse(row.entry_json).providerOverride).toBeUndefined();
          await deleteAuthProfileStore(agentDir);
          expect(await readAuthProfileStore(agentDir)).toBeNull();
        } finally {
          if (previous === undefined) delete process.env.OPENCLAW_AGENT_STORE_DSN;
          else process.env.OPENCLAW_AGENT_STORE_DSN = previous;
        }
        await expect(shared.query(`SELECT entry_json FROM ${object(aliceSchema, "session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
        const { rows } = await alice.query(`SELECT entry_json FROM ${object(aliceSchema, "session_nodes")}`);
        expect(rows).toHaveLength(1);
        await alice.query(`CREATE SCHEMA ${pg.escapeIdentifier(rogueSchema)}`);
        await alice.query(`CREATE TABLE ${object(rogueSchema, "schema_meta")} (untrusted TEXT)`);
        const secondDsn = await provision({ gatewayClass: "isolated", gatewayId: "builder-alice", token: "synthetic-other-alice-password", user: { uid: "alice-uid", slug: "alice" } }, async () => {});
        const second = new pg.Client({ connectionString: secondDsn }); await second.connect();
        try { expect((await second.query(`SELECT entry_json FROM ${object(aliceSchema, "session_nodes")}`)).rows).toEqual(rows); }
        finally { await second.end(); }
        await expect(provision({ gatewayClass: "isolated", gatewayId: "native-alice", token: "changed", user: { uid: "bob-uid", slug: "bob" } }, async () => {})).rejects.toThrow("identity changed");
        await expect(assertNoUserAgentStores(dsn!, { uid: "alice-uid", slug: "alice" })).rejects.toThrow("PostgreSQL agent stores remain");
        await expect(assertNoUserAgentStores(dsn!, { uid: "charlie-uid", slug: "charlie" })).resolves.toBeUndefined();
        await expect(shared.query(`SELECT * FROM ${object(aliceSchema, "session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
        expect((await shared.query(`SELECT * FROM ${object(bobSchema, "session_nodes")}`)).rowCount).toBe(1);
        await provision({ gatewayClass: "isolated", gatewayId: "builder-bob", token: "synthetic-bob-password", user: { uid: "bob-uid", slug: "bob" } }, async () => {});
        await transfer({ uid: "bob-uid", slug: "bob" }, "isolated");
        for (const schema of [aliceSchema, bobSchema, unownedSchema]) {
          const table = schema === unownedSchema ? "control_state" : "session_nodes";
          await expect(shared.query(`SELECT * FROM ${object(schema, table)}`)).rejects.toMatchObject({ code: "42501" });
          await expect(shared.query(`DELETE FROM ${object(schema, table)}`)).rejects.toMatchObject({ code: "42501" });
        }
        const { rows: [{ current_user: owner }] } = await alice.query("SELECT current_user");
        const { rows: [{ current_user: sharedRole }] } = await shared.query("SELECT current_user");
        await admin.query(`GRANT ${pg.escapeIdentifier(owner)} TO ${pg.escapeIdentifier(sharedRole)}`);
        await provision({ gatewayClass: "shared", gatewayId: "shared-test", token: "synthetic-shared-password" }, async () => {});
        await expect(shared.query(`SELECT * FROM ${object(unownedSchema, "control_state")}`)).rejects.toMatchObject({ code: "42501" });
        await expect(shared.query(`SET ROLE ${pg.escapeIdentifier(owner)}`)).rejects.toMatchObject({ code: "42501" });
        await transfer(aliceUser, "shared");
        await transfer(aliceUser, "isolated");
        await expect(shared.query(`SELECT * FROM ${object(aliceSchema, "session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
        await alice.query(`DROP SCHEMA ${pg.escapeIdentifier(rogueSchema)} CASCADE`);
        await alice.query(`ALTER TABLE ${object(aliceSchema, "session_nodes")} ADD COLUMN snapshot_revision BIGINT NOT NULL DEFAULT 0`);
        await alice.query(`CREATE TABLE ${object(aliceSchema, "session_entry_snapshots")} (session_key TEXT)`);
        await createNativeTriggers(alice, aliceSchema);
        await alice.query(`CREATE TRIGGER session_entry_snapshots_after_insert AFTER INSERT ON ${object(aliceSchema, "session_entry_snapshots")} FOR EACH ROW EXECUTE FUNCTION ${object(aliceSchema, "openclaw_session_entry_snapshots_trigger")}()`);
        await transfer(aliceUser, "shared");
        await transfer(aliceUser, "shared");
        await shared.query(`INSERT INTO ${object(aliceSchema, "session_entry_snapshots")} VALUES ('history')`);
        expect((await shared.query(`SELECT snapshot_revision FROM ${object(aliceSchema, "session_nodes")}`)).rows).toEqual([{ snapshot_revision: '1' }]);
        const functionAcl = await admin.query("SELECT a.grantee FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, LATERAL aclexplode(p.proacl) a WHERE n.nspname = $1 AND p.proname = 'openclaw_session_entry_snapshots_trigger' AND a.grantee <> p.proowner", [aliceSchema]);
        expect(functionAcl.rows).toEqual([]);
        expect((await shared.query(`SELECT entry_json FROM ${object(aliceSchema, "session_nodes")}`)).rows).toEqual(rows);
        await shared.query(`ALTER TABLE ${object(aliceSchema, "session_nodes")} ADD COLUMN shared_adoption TEXT`);
        await shared.query(`UPDATE ${object(aliceSchema, "session_nodes")} SET shared_adoption = 'returned'`);
        for (const [schema, table] of [[unownedSchema, "control_state"], [bobSchema, "session_nodes"]]) {
          await expect(shared.query(`SELECT * FROM ${object(schema!, table!)}`)).rejects.toMatchObject({ code: "42501" });
          await expect(shared.query(`DELETE FROM ${object(schema!, table!)}`)).rejects.toMatchObject({ code: "42501" });
        }
        await expect(alice.query(`SELECT * FROM ${object(aliceSchema, "session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
        await expect(shared.query(`SET ROLE ${pg.escapeIdentifier(owner)}`)).rejects.toMatchObject({ code: "42501" });
        await transfer(aliceUser, "isolated");
        await transfer(aliceUser, "isolated");
        expect((await alice.query(`SELECT shared_adoption FROM ${object(aliceSchema, "session_nodes")}`)).rows).toEqual([{ shared_adoption: "returned" }]);
        await expect(shared.query(`SELECT * FROM ${object(aliceSchema, "session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
        await expect(shared.query(`DELETE FROM ${object(aliceSchema, "session_nodes")}`)).rejects.toMatchObject({ code: "42501" });
      } finally { await alice.end(); }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(unownedSchema)} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(rogueSchema)} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(aliceSchema)} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(bobSchema)} CASCADE`);
      await shared.end();
      await admin.end();
    }
  });

  it.each(["definer", "definer-and-grants", "schema-public", "schema-login", "table-public", "table-login", "column-login", "routine-login", "default-grants", "view", "rls", "invoker-trigger", "modified-native-trigger", "changed-search-path", "unknown-native-trigger", "external-default", "external-generated", "external-check", "external-index", "domain-type", "builtin-default", "external-partition", "metadata-type"])("rejects a User-planted %s before Shared ownership", async attack => {
    const suffix = randomUUID().replaceAll("-", "");
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const transfer = createAgentStoreOwnershipTransferer(dsn!, async () => [{ schema, agentId: `octogee-${user.slug}-coach`, storeId }]);
    const user = { uid: `attacker-${suffix}`, slug: `attacker-${suffix}` };
    const sharedDsn = await provision({ gatewayClass: "shared", gatewayId: `shared-${suffix}`, token: "synthetic-shared" }, async () => {});
    const userDsn = await provision({ gatewayClass: "isolated", gatewayId: `builder-${suffix}`, token: "synthetic-user", user }, async () => {});
    const admin = new pg.Client({ connectionString: dsn! });
    const shared = new pg.Client({ connectionString: sharedDsn });
    const source = new pg.Client({ connectionString: userDsn });
    await admin.connect(); await shared.connect(); await source.connect();
    const schema = `octogee_attack_${suffix}`, storeId = randomUUID();
    const victim = `octogee_victim_${suffix}`;
    const auxiliary = `octogee_aux_${suffix}`;
    const object = (namespace: string, name: string) => `${pg.escapeIdentifier(namespace)}.${pg.escapeIdentifier(name)}`;
    const sourceLogin = pg.escapeIdentifier(decodeURIComponent(new URL(userDsn).username));
    try {
      await shared.query(`CREATE SCHEMA ${pg.escapeIdentifier(victim)}`);
      await shared.query(`CREATE TABLE ${object(victim, "auth_profile_store")} (secret TEXT)`);
      await shared.query(`INSERT INTO ${object(victim, "auth_profile_store")} VALUES ('synthetic-victim-secret')`);
      await source.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      await source.query(`CREATE TABLE ${object(schema, "schema_meta")} (meta_key TEXT, role TEXT, agent_id TEXT)`);
      await source.query(`INSERT INTO ${object(schema, "schema_meta")} VALUES ('primary', 'agent', $1)`, [`octogee-${user.slug}-coach`]);
      await source.query(`CREATE TABLE ${object(schema, "openclaw_schema_meta")} (store TEXT, store_id TEXT)`);
      await source.query(`INSERT INTO ${object(schema, "openclaw_schema_meta")} VALUES ('agent', $1)`, [storeId]);
      await source.query(`CREATE FUNCTION ${object(schema, "steal")}() RETURNS TEXT LANGUAGE plpgsql ${attack.startsWith("definer") ? "SECURITY DEFINER" : "SECURITY INVOKER"} AS $body$ BEGIN RETURN (SELECT secret FROM ${object(victim, "auth_profile_store")} LIMIT 1); END $body$`);
      if (attack === "metadata-type") {
        await source.query(`CREATE SCHEMA ${pg.escapeIdentifier(auxiliary)}`);
        await source.query(`CREATE TYPE ${object(auxiliary, "metadata")} AS ENUM ('primary')`);
        await source.query(`ALTER TABLE ${object(schema, "schema_meta")} ALTER COLUMN meta_key TYPE ${object(auxiliary, "metadata")} USING meta_key::${object(auxiliary, "metadata")}`);
      }
      if (attack.startsWith("external-") || attack === "domain-type" || attack === "builtin-default") {
        await source.query(`DROP FUNCTION ${object(schema, "steal")}()`);
        await source.query(`CREATE SCHEMA ${pg.escapeIdentifier(auxiliary)}`);
        await source.query(`GRANT USAGE ON SCHEMA ${pg.escapeIdentifier(auxiliary)} TO PUBLIC`);
        await source.query(`CREATE FUNCTION ${object(auxiliary, "leak")}(payload TEXT) RETURNS TEXT LANGUAGE plpgsql ${["external-generated", "external-index"].includes(attack) ? "IMMUTABLE" : "VOLATILE"} AS $body$ DECLARE secret TEXT; BEGIN SELECT v.secret INTO secret FROM ${object(victim, "auth_profile_store")} v LIMIT 1; PERFORM pg_notify('octogee_attack', secret); RETURN secret; END $body$`);
        await source.query(`CREATE TABLE ${object(schema, "auth_profile_store")} (store_key TEXT ${attack === "external-partition" ? "" : "PRIMARY KEY"}, store_json TEXT, updated_at BIGINT) ${attack === "external-partition" ? "PARTITION BY RANGE (updated_at)" : ""}`);
        const external = {
          "external-default": `ALTER TABLE ${object(schema, "auth_profile_store")} ADD COLUMN injected TEXT DEFAULT ${object(auxiliary, "leak")}(NULL)`,
          "external-generated": `ALTER TABLE ${object(schema, "auth_profile_store")} ADD COLUMN injected TEXT GENERATED ALWAYS AS (${object(auxiliary, "leak")}(store_json)) STORED`,
          "external-check": `ALTER TABLE ${object(schema, "auth_profile_store")} ADD CHECK (${object(auxiliary, "leak")}(store_json) IS NOT NULL)`,
          "external-index": `CREATE INDEX injected ON ${object(schema, "auth_profile_store")} (${object(auxiliary, "leak")}(store_json))`,
          "builtin-default": `ALTER TABLE ${object(schema, "auth_profile_store")} ADD COLUMN injected BOOLEAN DEFAULT (pg_notify('octogee_attack', query_to_xml('SELECT secret FROM ${object(victim, "auth_profile_store")}', false, false, '')::TEXT) IS NULL)`,
        } as Record<string, string>;
        if (attack === "external-partition") {
          await source.query(`CREATE TABLE ${object(auxiliary, "partition")} PARTITION OF ${object(schema, "auth_profile_store")} FOR VALUES FROM (MINVALUE) TO (MAXVALUE)`);
          await source.query(`CREATE FUNCTION ${object(auxiliary, "notify")}() RETURNS TRIGGER LANGUAGE plpgsql AS $body$ BEGIN PERFORM ${object(auxiliary, "leak")}(NEW.store_json); RETURN NEW; END $body$`);
          await source.query(`CREATE TRIGGER planted AFTER INSERT ON ${object(auxiliary, "partition")} FOR EACH ROW EXECUTE FUNCTION ${object(auxiliary, "notify")}()`);
        } else if (attack === "domain-type") {
          await source.query(`CREATE DOMAIN ${object(auxiliary, "injected")} AS TEXT CHECK (${object(auxiliary, "leak")}(VALUE) IS NOT NULL)`);
          await source.query(`ALTER TABLE ${object(schema, "auth_profile_store")} ADD COLUMN injected ${object(auxiliary, "injected")}`);
        } else await source.query(external[attack]!);
      }
      if (attack === "invoker-trigger") {
        await source.query(`CREATE FUNCTION ${object(schema, "plant")}() RETURNS TRIGGER LANGUAGE plpgsql AS $body$ BEGIN PERFORM pg_notify('octogee_attack', (SELECT secret FROM ${object(victim, "auth_profile_store")} LIMIT 1)); RETURN NEW; END $body$`);
        await source.query(`CREATE TRIGGER planted AFTER UPDATE ON ${object(schema, "schema_meta")} FOR EACH ROW EXECUTE FUNCTION ${object(schema, "plant")}()`);
      }
      if (attack === "modified-native-trigger" || attack === "changed-search-path" || attack === "unknown-native-trigger") {
        await createNativeTriggers(source, schema);
        if (attack === "modified-native-trigger") await source.query(`CREATE OR REPLACE FUNCTION ${object(schema, "openclaw_session_entry_snapshots_trigger")}() RETURNS TRIGGER LANGUAGE plpgsql AS 'BEGIN PERFORM pg_notify(''octogee_attack'', ''leaked''); RETURN NEW; END'`);
        else if (attack === "unknown-native-trigger") await source.query(`CREATE TRIGGER session_entry_snapshots_after_insert AFTER INSERT ON ${object(schema, "schema_meta")} FOR EACH ROW EXECUTE FUNCTION ${object(schema, "openclaw_session_entry_snapshots_trigger")}()`);
        else await source.query(`ALTER FUNCTION ${object(schema, "openclaw_session_entry_snapshots_trigger")}() SET search_path = ${pg.escapeIdentifier(victim)}`);
        await source.query(`DROP FUNCTION ${object(schema, "steal")}()`);
      }
      const attacks: Record<string, string> = {
        "schema-public": `GRANT USAGE ON SCHEMA ${pg.escapeIdentifier(schema)} TO PUBLIC`,
        "schema-login": `GRANT USAGE ON SCHEMA ${pg.escapeIdentifier(schema)} TO ${sourceLogin}`,
        "table-public": `GRANT SELECT ON ${object(schema, "schema_meta")} TO PUBLIC`,
        "table-login": `GRANT SELECT ON ${object(schema, "schema_meta")} TO ${sourceLogin}`,
        "column-login": `GRANT SELECT (agent_id) ON ${object(schema, "schema_meta")} TO ${sourceLogin}`,
        "routine-login": `GRANT EXECUTE ON FUNCTION ${object(schema, "steal")}() TO ${sourceLogin}`,
        "default-grants": `ALTER DEFAULT PRIVILEGES IN SCHEMA ${pg.escapeIdentifier(schema)} GRANT SELECT ON TABLES TO ${sourceLogin}`,
        view: `CREATE VIEW ${object(schema, "injected_view")} AS SELECT 1`,
        rls: `ALTER TABLE ${object(schema, "schema_meta")} ENABLE ROW LEVEL SECURITY`,
      };
      if (attack === "definer-and-grants") {
        await source.query(`GRANT USAGE ON SCHEMA ${pg.escapeIdentifier(schema)} TO PUBLIC, ${sourceLogin}`);
        await source.query(`GRANT EXECUTE ON FUNCTION ${object(schema, "steal")}() TO ${sourceLogin}`);
      } else if (attacks[attack]) await source.query(attacks[attack]);
      await expect(transfer(user, "shared")).rejects.toThrow("unsafe agent-store schema");
      if (!["modified-native-trigger", "changed-search-path", "unknown-native-trigger", "domain-type", "builtin-default"].includes(attack) && !attack.startsWith("external-")) await expect(source.query(`SELECT ${object(schema, "steal")}()`)).rejects.toMatchObject({ code: "42501" });
      await expect(shared.query(`SELECT * FROM ${object(schema, "schema_meta")}`)).rejects.toMatchObject({ code: "42501" });
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(victim)} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(auxiliary)} CASCADE`);
      await source.end(); await shared.end(); await admin.end();
    }
  });

  it("blocks concurrent function and ACL changes until ownership commits", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const user = { uid: `race-${suffix}`, slug: `race-${suffix}` };
    const provision = createAgentStoreCredentialProvisioner(dsn!, dsn!);
    const transfer = createAgentStoreOwnershipTransferer(dsn!, async () => [{ schema, agentId: `octogee-${user.slug}-coach`, storeId }]);
    await provision({ gatewayClass: "shared", gatewayId: `shared-race-${suffix}`, token: "synthetic-shared" }, async () => {});
    const sourceDsn = await provision({ gatewayClass: "isolated", gatewayId: `race-${suffix}`, token: "synthetic-source", user }, async () => {});
    const admin = new pg.Client({ connectionString: dsn! });
    const source = new pg.Client({ connectionString: sourceDsn });
    const racer = new pg.Client({ connectionString: sourceDsn });
    await admin.connect(); await source.connect(); await racer.connect();
    const schema = `octogee_race_${suffix}`, storeId = randomUUID();
    const object = (name: string) => `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(name)}`;
    let moving: Promise<void> | undefined;
    try {
      await source.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      await source.query(`CREATE TABLE ${object("schema_meta")} (meta_key TEXT, role TEXT, agent_id TEXT)`);
      await source.query(`INSERT INTO ${object("schema_meta")} VALUES ('primary', 'agent', $1)`, [`octogee-${user.slug}-coach`]);
      await source.query(`CREATE TABLE ${object("openclaw_schema_meta")} (store TEXT, store_id TEXT)`);
      await source.query(`INSERT INTO ${object("openclaw_schema_meta")} VALUES ('agent', $1)`, [storeId]);
      await source.query(`CREATE SEQUENCE ${object("sequence")}`);
      await createNativeTriggers(source, schema);
      await source.query("BEGIN");
      await source.query(`ALTER FUNCTION ${object("openclaw_session_entry_snapshots_trigger")}() COST 100`);
      moving = transfer(user, "shared");
      void moving.catch(() => {});
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const activity = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND position($1 IN query) > 0 AND query LIKE 'ALTER FUNCTION%openclaw_session_entry_snapshots_trigger%'", [schema]);
        if (activity.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await racer.query("SET lock_timeout = '100ms'");
      for (const mutation of [
        `ALTER FUNCTION ${object("openclaw_session_conversations_trigger")}() SECURITY DEFINER`,
        `GRANT SELECT ON ${object("schema_meta")} TO PUBLIC`,
        `GRANT SELECT (agent_id) ON ${object("schema_meta")} TO PUBLIC`,
        `GRANT USAGE ON SCHEMA ${pg.escapeIdentifier(schema)} TO PUBLIC`,
        `GRANT USAGE ON SEQUENCE ${object("sequence")} TO PUBLIC`,
      ]) await expect(racer.query(mutation)).rejects.toMatchObject({ code: "55P03" });
      await source.query("ROLLBACK");
      await moving;
      await expect(source.query(`SELECT * FROM ${object("schema_meta")}`)).rejects.toMatchObject({ code: "42501" });
    } finally {
      await source.query("ROLLBACK");
      await moving?.catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      await racer.end(); await source.end(); await admin.end();
    }
  });

  it.each([
    { table: "cache_entries", name: "idx_agent_cache_expiry", unique: false, keys: "scope, expires_at, key", column: "expires_at" },
    { table: "session_nodes", name: "idx_agent_session_nodes_archived_at", unique: false, keys: "archived_at, session_key", column: "archived_at" },
    { table: "session_nodes", name: "idx_agent_session_nodes_label", unique: false, keys: "label, session_key", column: "label" },
    { table: "session_nodes", name: "idx_agent_session_nodes_status", unique: false, keys: "status, session_key", column: "status" },
    { table: "session_transcript_active_events", name: "idx_agent_transcript_active_messages", unique: true, keys: "session_id, message_position", column: "message_position" },
    { table: "session_windows", name: "idx_agent_session_windows_conversation", unique: false, keys: "primary_conversation_id", column: "primary_conversation_id" },
    { table: "transcript_event_identities", name: "idx_agent_transcript_message_idempotency", unique: true, keys: "session_id, message_idempotency_key", column: "message_idempotency_key" },
])("admits PostgreSQL native $name null ordering and refuses changed predicates", async fixture => {
    const pool = new pg.Pool({ connectionString: dsn, max: 1 });
    const client = await pool.connect();
    const schema = `null_order_${randomUUID().replaceAll("-", "")}`;
    const table = `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(fixture.table)}`;
    const index = `${pg.escapeIdentifier(schema)}.${pg.escapeIdentifier(fixture.name)}`;
    const columns = fixture.keys.split(", ").map(column => `${pg.escapeIdentifier(column)} TEXT`).join(", ");
    const keys = fixture.keys.split(", ").map(column => pg.escapeIdentifier(column));
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      await client.query(`CREATE TABLE ${table} (${columns})`);
      for (const ordering of ["NULLS FIRST", "NULLS LAST"]) {
        const ordered = keys.map(key => key === pg.escapeIdentifier(fixture.column) ? `${key} ${ordering}` : key).join(", ");
        await client.query(`CREATE ${fixture.unique ? "UNIQUE " : ""}INDEX ${pg.escapeIdentifier(fixture.name)} ON ${table} (${ordered}) WHERE ${pg.escapeIdentifier(fixture.column)} IS NOT NULL`);
        await expect(assertTrustedAgentStoreRoutines(client, schema)).resolves.toBeUndefined();
        await client.query(`DROP INDEX ${index}`);
      }
      await client.query(`CREATE ${fixture.unique ? "UNIQUE " : ""}INDEX ${pg.escapeIdentifier(fixture.name)} ON ${table} (${keys.join(", ")}) WHERE ${pg.escapeIdentifier(fixture.column)} IS NULL`);
      await expect(assertTrustedAgentStoreRoutines(client, schema)).rejects.toThrow(`untrusted expression index:${fixture.table}:${fixture.name}`);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });

  it("admits Native-declared ACP nullability and indexes but rejects a CHECK disguised as NOT NULL", async () => {
    const pool = new pg.Pool({ connectionString: dsn, max: 1 }), client = await pool.connect();
    const schema = `acp_order_${randomUUID().replaceAll("-", "")}`, table = `${pg.escapeIdentifier(schema)}.acp_parent_stream_events`;
    try {
      await client.query("BEGIN"); await client.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      await client.query(`CREATE TABLE ${table} (session_id TEXT, run_id TEXT, seq BIGINT, PRIMARY KEY (session_id, run_id, seq))`);
      await client.query(`CREATE INDEX idx_agent_acp_parent_stream_run ON ${table} (run_id NULLS FIRST, seq NULLS FIRST)`);
      await expect(assertTrustedAgentStoreRoutines(client, schema)).resolves.toBeUndefined();
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT acp_parent_stream_events_pkey`);
      await expect(assertTrustedAgentStoreRoutines(client, schema)).resolves.toBeUndefined();
      await client.query(`ALTER TABLE ${table} ALTER COLUMN seq DROP NOT NULL`);
      await expect(assertTrustedAgentStoreRoutines(client, schema)).resolves.toBeUndefined();
      await client.query(`ALTER TABLE ${table} ADD CONSTRAINT acp_parent_stream_events_seq_not_null CHECK (seq > 0)`);
      await expect(assertTrustedAgentStoreRoutines(client, schema)).rejects.toThrow("untrusted expression constraint:acp_parent_stream_events:acp_parent_stream_events_seq_not_null");
    } finally { await client.query("ROLLBACK");client.release();await pool.end(); }
  });

  it.each([1536, 3072])("admits PostgreSQL's actual %i-dimensional projection and refuses a changed expression", async dimensions => {
    const pool = new pg.Pool({ connectionString: process.env.OCTOGEE_TEST_POSTGRES_DSN, max: 1 });
    const client = await pool.connect();
    const schema = `projection_${randomUUID().replaceAll("-", "")}`;
    const table = `${pg.escapeIdentifier(schema)}.memory_index_chunks_vec`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
      await client.query(`CREATE TABLE ${table} (embedding public.vector(${dimensions}), embedding_bits bit(${dimensions}) GENERATED ALWAYS AS (CASE WHEN public.vector_norm(embedding) > 0 THEN public.binary_quantize(embedding)::bit(${dimensions}) ELSE NULL END) STORED)`);
      await expect(assertTrustedAgentStoreRoutines(client, schema)).resolves.toBeUndefined();
      await client.query(`ALTER TABLE ${table} DROP COLUMN embedding_bits`);
      await client.query(`ALTER TABLE ${table} ADD COLUMN embedding_bits bit(${dimensions}) GENERATED ALWAYS AS (CASE WHEN public.vector_norm(embedding) > 1 THEN public.binary_quantize(embedding)::bit(${dimensions}) ELSE NULL END) STORED`);
      await expect(assertTrustedAgentStoreRoutines(client, schema)).rejects.toThrow("untrusted expression default:memory_index_chunks_vec:embedding_bits");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});
