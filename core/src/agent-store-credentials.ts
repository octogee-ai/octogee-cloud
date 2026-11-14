import { assertTrustedAgentStoreRoutines } from "./agent-store-routines.js";
import { createHash } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";

const identifier = pg.escapeIdentifier;
const literal = pg.escapeLiteral;
const AGENT_STORE_SEARCH_PATH = "SET LOCAL search_path = pg_catalog";
const AGENT_STORE_CREDENTIAL_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended('octogee-agent-store-credentials', 0))";
const AGENT_STORE_CREDENTIAL_LOCK_WAIT = "SET LOCAL lock_timeout = '60s'";
const AGENT_STORE_RELATION_LOCK_WAIT = "SET LOCAL lock_timeout = '2s'";
const AGENT_STORE_HANDOFF_STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = '30s'";
const roleFor = (kind: string, id: string) => `octogee_${kind}_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;

export interface AgentStoreGatewayIdentity {
  gatewayId: string;
  gatewayClass: "shared" | "isolated";
  token: string;
  user?: { uid: string; slug: string };
}

type SchemaRelation = { relname: string; relkind: string; seqcache: string | null };

function lockSchemaRelation(schema: string, source: string, object: SchemaRelation, columns: string[]): string[] {
  const statements: string[] = [];
  if (object.relkind === "S") {
    const cache = String(object.seqcache);
    if (!/^\d+$/.test(cache) || BigInt(cache) <= 0n) throw new Error(`unsafe agent-store schema ${schema}: invalid sequence cache`);
    statements.push(`ALTER SEQUENCE ${identifier(schema)}.${identifier(object.relname)} CACHE ${cache}`);
  } else if (object.relkind === "r" || object.relkind === "p") {
    statements.push(`LOCK TABLE ${identifier(schema)}.${identifier(object.relname)} IN ACCESS EXCLUSIVE MODE`);
  } else {
    throw new Error(`unsafe agent-store schema ${schema}: unsupported relation kind`);
  }
  const kind = object.relkind === "S" ? "SEQUENCE" : "TABLE";
  statements.push(`GRANT ALL ON ${kind} ${identifier(schema)}.${identifier(object.relname)} TO ${identifier(source)}`);
  if (kind === "TABLE" && columns.length) {
    statements.push(`GRANT SELECT (${columns.map(identifier).join(", ")}) ON ${identifier(schema)}.${identifier(object.relname)} TO ${identifier(source)}`);
  }
  return statements;
}

async function transferSchemaOwnership(client: PoolClient, schema: string, owner: string, family: "agent" | "neutral"): Promise<void> {
  const objects = await client.query<SchemaRelation>("SELECT c.relname, c.relkind, s.seqcache FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_sequence s ON s.seqrelid = c.oid WHERE n.nspname = $1 AND c.relkind IN ('r','p','S','v','m','f') ORDER BY c.relkind = 'S'", [schema]);
  const functions = await client.query("SELECT p.oid::regprocedure::text AS signature, p.procost FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind = 'f' ORDER BY p.oid", [schema]);
  if (family === "agent") {
    const { rows: [{ rolname: source }] } = await client.query("SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = $1", [schema]);
    await client.query(`GRANT ALL ON SCHEMA ${identifier(schema)} TO ${identifier(source)}`);
    const columns = await client.query<{ relname: string; attname: string }>("SELECT c.relname, a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum", [schema]);
    const locks = objects.rows.flatMap(object => lockSchemaRelation(schema, source, object,
      columns.rows.filter(column => column.relname === object.relname).map(column => column.attname)));
    if (locks.length) await client.query(locks.join(";\n"));
    const functionLocks = functions.rows.map(({ signature, procost }) => {
      if (!Number.isFinite(procost) || procost <= 0) throw new Error(`unsafe agent-store schema ${schema}: invalid function cost`);
      return `ALTER FUNCTION ${signature} COST ${procost}`;
    });
    if (functionLocks.length) await client.query(functionLocks.join(";\n"));
    await assertSafeSchemaOwnershipTransfer(client, schema);
    await assertTrustedAgentStoreRoutines(client, schema);
  }
  const changes = [`ALTER SCHEMA ${identifier(schema)} OWNER TO ${identifier(owner)}`];
  for (const object of objects.rows) {
    const kind = object.relkind === "S" ? "SEQUENCE" : "TABLE";
    changes.push(`ALTER ${kind} ${identifier(schema)}.${identifier(object.relname)} OWNER TO ${identifier(owner)}`);
  }
  for (const { signature } of functions.rows) {
    changes.push(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`, `ALTER FUNCTION ${signature} OWNER TO ${identifier(owner)}`);
  }
  const configurations = await client.query("SELECT cfgname FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace WHERE n.nspname = $1", [schema]);
  for (const { cfgname } of configurations.rows) changes.push(`ALTER TEXT SEARCH CONFIGURATION ${identifier(schema)}.${identifier(cfgname)} OWNER TO ${identifier(owner)}`);
  await client.query(changes.join(";\n"));
}

async function assertSafeSchemaOwnershipTransfer(client: Pick<PoolClient, "query">, schema: string): Promise<void> {
  const unsafe = await client.query(`
    WITH namespace AS (SELECT oid, nspowner, nspacl FROM pg_catalog.pg_namespace WHERE nspname = $1),
    relations AS (SELECT c.* FROM pg_catalog.pg_class c JOIN namespace n ON n.oid = c.relnamespace)
    SELECT 'schema grants' AS reason FROM namespace n, LATERAL pg_catalog.aclexplode(n.nspacl) a WHERE a.grantee <> n.nspowner
    UNION ALL SELECT 'relation grants' FROM relations r, LATERAL pg_catalog.aclexplode(r.relacl) a WHERE a.grantee <> r.relowner
    UNION ALL SELECT 'column grants' FROM relations r JOIN pg_catalog.pg_attribute c ON c.attrelid = r.oid, LATERAL pg_catalog.aclexplode(c.attacl) a WHERE a.grantee <> r.relowner
    UNION ALL SELECT 'routine privileges' FROM pg_catalog.pg_proc p JOIN namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef OR p.prokind <> 'f' OR p.proowner <> n.nspowner
        OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee <> p.proowner AND (a.grantee <> 0 OR a.privilege_type <> 'EXECUTE' OR a.is_grantable))
    UNION ALL SELECT 'relation ownership or execution' FROM relations r JOIN namespace n ON n.oid = r.relnamespace
      WHERE r.relowner <> n.nspowner OR r.relkind NOT IN ('r', 'S', 'i') OR r.relrowsecurity OR r.relforcerowsecurity
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = r.oid OR i.inhparent = r.oid)
    UNION ALL SELECT 'rewrite rules' FROM pg_catalog.pg_rewrite w JOIN relations r ON r.oid = w.ev_class
    UNION ALL SELECT 'external trigger function' FROM pg_catalog.pg_trigger t JOIN relations r ON r.oid = t.tgrelid JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND p.pronamespace <> r.relnamespace
    UNION ALL SELECT 'default grants' FROM pg_catalog.pg_default_acl d JOIN namespace n ON n.oid = d.defaclnamespace
    LIMIT 1`, [schema]);
  if (unsafe.rowCount) throw new Error(`unsafe agent-store schema ${schema}: ${unsafe.rows[0].reason}`);
}

export interface AgentStoreHandoffIdentity {
  agentId: string;
  storeId: string;
  schema: string;
}

async function assertAgentStoreIdentity(client: PoolClient, store: AgentStoreHandoffIdentity): Promise<void> {
  const { schema } = store;
  const tables = await client.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname IN ('schema_meta', 'openclaw_schema_meta') AND c.relkind = 'r'", [schema]);
  if (tables.rowCount !== 2) throw new Error(`Agent-store identity is missing in ${schema}`);
  await client.query(`LOCK TABLE ${identifier(schema)}.schema_meta, ${identifier(schema)}.openclaw_schema_meta IN ACCESS EXCLUSIVE MODE`);
  await client.query("SET LOCAL row_security = off");
  const types = await client.query("SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND ((c.relname = 'schema_meta' AND a.attname IN ('meta_key', 'role', 'agent_id')) OR (c.relname = 'openclaw_schema_meta' AND a.attname IN ('store', 'store_id'))) AND a.atttypid <> 'pg_catalog.text'::regtype", [schema]);
  if (types.rowCount) throw new Error(`unsafe agent-store schema ${schema}: untrusted metadata type`);
  const metadata = await client.query(`SELECT agent_id FROM ${identifier(schema)}.schema_meta WHERE meta_key = 'primary' AND role = 'agent'`);
  const engine = await client.query(`SELECT store, store_id FROM ${identifier(schema)}.openclaw_schema_meta`);
  if (metadata.rowCount !== 1 || metadata.rows[0].agent_id !== store.agentId || engine.rowCount !== 1 ||
      engine.rows[0].store !== 'agent' || engine.rows[0].store_id !== store.storeId) {
    throw new Error(`Agent-store identity changed in ${schema}`);
  }
}

async function transferStores(client: PoolClient, source: string, owner: string, stores: readonly AgentStoreHandoffIdentity[]): Promise<void> {
  for (const store of [...stores].sort((left, right) => left.schema.localeCompare(right.schema))) {
    const current = await client.query("SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = $1", [store.schema]);
    if (current.rows[0]?.rolname !== source && current.rows[0]?.rolname !== owner) throw new Error(`Agent-store owner changed in ${store.schema}`);
    await assertAgentStoreIdentity(client, store);
    if (current.rows[0].rolname === owner) continue;
    await transferSchemaOwnership(client, store.schema, owner, "agent");
  }
}

async function claimNeutralStores(client: PoolClient, neutral: string, owner: string): Promise<void> {
  const schemas = await client.query("SELECT n.nspname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname = $1", [neutral]);
  for (const { nspname } of schemas.rows) await transferSchemaOwnership(client, nspname, owner, "neutral");
}

async function isolateSharedRole(client: PoolClient, sharedRole: string): Promise<void> {
  const memberships = await client.query("SELECT parent.rolname FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid JOIN pg_roles member ON member.oid = m.member WHERE member.rolname = $1", [sharedRole]);
  for (const { rolname } of memberships.rows) await client.query(`REVOKE ${identifier(rolname)} FROM ${identifier(sharedRole)}`);
}

async function ensureRole(client: PoolClient, name: string): Promise<void> {
  const existing = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  if (!existing.rowCount) await client.query(`CREATE ROLE ${identifier(name)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
}

async function grantGatewayOwner(client: PoolClient, login: string, owner: string, unclaimedRole: string, claimed: boolean): Promise<void> {
  const memberships = await client.query("SELECT parent.rolname FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid JOIN pg_roles member ON member.oid = m.member WHERE member.rolname = $1", [login]);
  for (const row of memberships.rows) {
    if (row.rolname !== owner && !(claimed && row.rolname === unclaimedRole)) throw new Error("Agent-store Gateway identity changed; issue credentials for a new Gateway ID");
  }
  if (claimed && memberships.rows.some(row => row.rolname === unclaimedRole)) {
    await client.query(`GRANT ${identifier(owner)} TO ${identifier(unclaimedRole)}`);
    await client.query(`REVOKE ${identifier(unclaimedRole)} FROM ${identifier(login)}`);
  }
  await client.query(`GRANT ${identifier(owner)} TO ${identifier(login)}`);
}

export function createAgentStoreCredentialProvisioner(adminDsn: string, clientDsn: string) {
  const clientUrl = new URL(clientDsn);
  const adminUrl = new URL(adminDsn);
  if (clientUrl.pathname !== adminUrl.pathname || !clientUrl.pathname.slice(1)) {
    throw new Error("Agent-store administration and Gateway URLs must select the same database");
  }
  const scope = decodeURIComponent(clientUrl.pathname.slice(1));
  const sharedRole = roleFor("shared", scope);
  const pool = new pg.Pool({ connectionString: adminDsn, max: 2, connectionTimeoutMillis: 10_000, allowExitOnIdle: true });
  pool.on("error", error => console.error("Agent-store credential connection failed", error.message));
  return async (identity: AgentStoreGatewayIdentity, assertCurrent: () => Promise<void>): Promise<string> => {
    if (!identity.gatewayId || !identity.token || (identity.user && (!identity.user.uid || !identity.user.slug))) {
      throw new Error("Agent-store credentials require a complete Gateway identity");
    }
    const login = roleFor("gateway", `${scope}:${identity.gatewayId}`);
    const unclaimedRole = roleFor("unclaimed", `${scope}:${identity.gatewayId}`);
    let owner = identity.gatewayClass === "shared" ? sharedRole : unclaimedRole;
    if (identity.user) owner = roleFor("builder", `${scope}:${identity.user.uid}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(AGENT_STORE_SEARCH_PATH);
      await client.query(AGENT_STORE_CREDENTIAL_LOCK);
      await assertCurrent();
      const { rows: [{ current_user: admin, current_database: database }] } = await client.query("SELECT current_user, current_database()");
      await ensureRole(client, sharedRole);
      await ensureRole(client, owner);
      await ensureRole(client, login);
      await client.query(`GRANT ${identifier(sharedRole)} TO ${identifier(admin)} WITH INHERIT TRUE, SET TRUE`);
      await client.query(`GRANT ${identifier(owner)} TO ${identifier(admin)} WITH INHERIT TRUE, SET TRUE`);
      await isolateSharedRole(client, sharedRole);
      await client.query(`GRANT CONNECT, CREATE ON DATABASE ${identifier(database)} TO ${identifier(owner)}`);
      await grantGatewayOwner(client, login, owner, unclaimedRole, Boolean(identity.user));
      await client.query(`ALTER ROLE ${identifier(login)} LOGIN PASSWORD ${literal(identity.token)}`);
      await client.query(`ALTER ROLE ${identifier(login)} SET role = ${literal(owner)}`);
      if (identity.user) {
        await claimNeutralStores(client, unclaimedRole, owner);
      }
      await assertCurrent();
      await client.query("COMMIT");
      const url = new URL(clientUrl);
      url.username = login;
      url.password = identity.token;
      return url.toString();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  };
}

export function createAgentStoreCredentialRevoker(adminDsn: string) {
  const scope = decodeURIComponent(new URL(adminDsn).pathname.slice(1));
  if (!scope) throw new Error("Agent-store credential retirement requires a database");
  const pool = new pg.Pool({ connectionString: adminDsn, max: 2, connectionTimeoutMillis: 10_000, allowExitOnIdle: true });
  pool.on("error", error => console.error("Agent-store credential retirement connection failed", error.message));
  return async (gatewayId: string, assertCurrent: () => Promise<void>): Promise<void> => {
    if (!gatewayId) throw new Error("Agent-store credential retirement requires a Gateway identity");
    const login = roleFor("gateway", `${scope}:${gatewayId}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(AGENT_STORE_SEARCH_PATH);
      await client.query(AGENT_STORE_CREDENTIAL_LOCK);
      await assertCurrent();
      const role = await client.query("SELECT oid FROM pg_roles WHERE rolname = $1", [login]);
      if (role.rowCount) {
        await terminateGatewaySessions(client, gatewayId, login, role.rows[0].oid);
        await client.query(`ALTER ROLE ${identifier(login)} NOLOGIN`);
      }
      await assertCurrent();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  };
}

const GATEWAY_SESSION_DRAIN_TIMEOUT_MS = 5_000;
const OTHER_SESSIONS_OF_ROLE = "FROM pg_stat_activity WHERE usesysid = $1 AND pid <> pg_backend_pid()";

async function roleHasOtherSessions(client: PoolClient, roleOid: number): Promise<boolean> {
  await client.query("SELECT pg_stat_clear_snapshot()");
  return (await client.query(`SELECT 1 ${OTHER_SESSIONS_OF_ROLE} LIMIT 1`, [roleOid])).rowCount === 1;
}

async function terminateGatewaySessions(client: PoolClient, gatewayId: string, login: string, roleOid: number): Promise<void> {
  if (await roleHasOtherSessions(client, roleOid)) {
    await client.query(`GRANT ${identifier(login)} TO CURRENT_USER WITH SET TRUE`);
    await client.query(`SET LOCAL ROLE ${identifier(login)}`);
    await client.query(`SELECT pg_terminate_backend(pid) ${OTHER_SESSIONS_OF_ROLE}`, [roleOid]);
    await client.query("RESET ROLE");
    await client.query(`REVOKE ${identifier(login)} FROM CURRENT_USER`);
  }
  const deadline = Date.now() + GATEWAY_SESSION_DRAIN_TIMEOUT_MS;
  while (await roleHasOtherSessions(client, roleOid)) {
    if (Date.now() >= deadline) throw new Error(`Agent-store Gateway ${gatewayId} still has database sessions`);
    await client.query("SELECT pg_sleep(0.1)");
  }
}

export function createAgentStoreCredentialRetirementVerifier(adminDsn: string) {
  const scope = decodeURIComponent(new URL(adminDsn).pathname.slice(1));
  if (!scope) throw new Error("Agent-store retirement verification requires a database");
  const pool = new pg.Pool({ connectionString: adminDsn, max: 2, connectionTimeoutMillis: 10_000, query_timeout: 5_000, allowExitOnIdle: true });
  pool.on("error", error => console.error("Agent-store retirement verification connection failed", error.message));
  return async (gatewayId: string, assertCurrent: () => Promise<void>): Promise<boolean> => {
    if (!gatewayId) throw new Error("Agent-store retirement verification requires a Gateway identity");
    const login = roleFor("gateway", `${scope}:${gatewayId}`), client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(AGENT_STORE_SEARCH_PATH);
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('octogee-agent-store-credentials', 0)) AS acquired");
      if (lock.rows[0]?.acquired !== true) { await client.query("ROLLBACK"); return false; }
      await assertCurrent();
      const role = await client.query("SELECT oid, rolcanlogin FROM pg_roles WHERE rolname = $1", [login]);
      const sessions = await client.query("SELECT 1 FROM pg_stat_activity WHERE usename = $1 OR usesysid = $2 LIMIT 1", [login, role.rows[0]?.oid ?? null]);
      await assertCurrent();
      await client.query("COMMIT");
      return !role.rows.some(row => row.rolcanlogin) && sessions.rowCount === 0;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  };
}

export function createAgentStoreOwnershipTransferer(
  adminDsn: string,
  readStores: (user: { uid: string; slug: string }) => Promise<readonly AgentStoreHandoffIdentity[]>,
) {
  const scope = decodeURIComponent(new URL(adminDsn).pathname.slice(1));
  if (!scope) throw new Error("Agent-store ownership transfer requires a database");
  const sharedRole = roleFor("shared", scope);
  const pool = new pg.Pool({ connectionString: adminDsn, max: 2, connectionTimeoutMillis: 10_000, allowExitOnIdle: true });
  pool.on("error", error => console.error("Agent-store ownership connection failed", error.message));
  return async (user: { uid: string; slug: string }, target: "shared" | "isolated", assertCurrent?: () => Promise<void>): Promise<void> => {
    if (!user.uid || !user.slug) throw new Error("Agent-store ownership transfer requires a complete user identity");
    const owner = roleFor("builder", `${scope}:${user.uid}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(AGENT_STORE_SEARCH_PATH);
      await client.query(AGENT_STORE_CREDENTIAL_LOCK_WAIT);
      await client.query(AGENT_STORE_CREDENTIAL_LOCK);
      await client.query(AGENT_STORE_RELATION_LOCK_WAIT);
      await client.query(AGENT_STORE_HANDOFF_STATEMENT_TIMEOUT);
      await assertCurrent?.();
      const stores = await readStores(user);
      if (new Set(stores.map(store => store.schema)).size !== stores.length ||
          new Set(stores.map(store => store.storeId)).size !== stores.length ||
          new Set(stores.map(store => store.agentId)).size !== stores.length ||
          stores.some(store => !agentIdBelongsToSlug(store.agentId, user.slug) ||
            !/^[a-z_][a-z0-9_]{0,62}$/.test(store.schema) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(store.storeId))) {
        throw new Error("Agent-store handoff inventory is invalid or ambiguous");
      }
      const { rows: [{ current_user: admin }] } = await client.query("SELECT current_user");
      await ensureRole(client, sharedRole);
      await ensureRole(client, owner);
      await client.query(`GRANT ${identifier(sharedRole)} TO ${identifier(admin)} WITH INHERIT TRUE, SET TRUE`);
      await client.query(`GRANT ${identifier(owner)} TO ${identifier(admin)} WITH INHERIT TRUE, SET TRUE`);
      await isolateSharedRole(client, sharedRole);
      await transferStores(client, target === "shared" ? owner : sharedRole, target === "shared" ? sharedRole : owner, stores);
      await assertCurrent?.();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  };
}

export async function assertNoUserAgentStores(adminDsn: string, user: { uid: string; slug: string }): Promise<void> {
  if (!user.uid || !user.slug) throw new Error("Agent-store verification requires a complete user identity");
  const scope = decodeURIComponent(new URL(adminDsn).pathname.slice(1));
  const owner = roleFor("builder", `${scope}:${user.uid}`);
  const shared = roleFor("shared", scope);
  const client = new pg.Client({ connectionString: adminDsn, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query("SET search_path = pg_catalog");
    const namespaces = await client.query("SELECT n.nspname, r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE r.rolname = ANY($1::text[]) OR ((r.rolname LIKE 'octogee_gateway_%' OR r.rolname LIKE 'octogee_unclaimed_%') AND r.oid IN (SELECT m.member FROM pg_auth_members m JOIN pg_roles parent ON parent.oid = m.roleid WHERE parent.rolname = $2))", [[owner, shared], owner]);
    for (const { nspname, rolname } of namespaces.rows) {
      if (rolname === shared) {
        const isAgent = await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'schema_meta' AND c.relkind = 'r'", [nspname]);
        if (!isAgent.rowCount) continue;
        // eslint-disable-next-line sonarjs/sql-queries -- The schema identifier is escaped; metadata filters are constants.
        const metadata = await client.query(`SELECT agent_id FROM ${identifier(nspname)}.schema_meta WHERE meta_key = 'primary' AND role = 'agent'`);
        if (!metadata.rows.length || !agentIdBelongsToSlug(metadata.rows[0].agent_id, user.slug)) continue;
      }
      throw new Error(`PostgreSQL agent stores remain for user ${user.slug}; explicit database erasure is required before account deletion can complete`);
    }
  } finally { await client.end(); }
}

type AgentStoreErasureIdentity =
  | { family: "agent"; role: "agent"; storeId: string; agentId: string }
  | { family: "state"; role: "global"; storeId: string; agentId: null };

export type AgentStoreErasureTarget = AgentStoreErasureIdentity & {
  namespace: string;
  namespaceOid: string;
  owner: string;
};

export class AgentStoreErasureRetainedLoginError extends Error {
  override readonly name: string = "AgentStoreErasureRetainedLoginError";
}

export interface AgentStoreErasureCustody {
  assertCurrent(): Promise<void>;
  assertWritersStopped(targets: readonly AgentStoreErasureTarget[]): Promise<readonly string[]>;
  bindTargets(targets: readonly AgentStoreErasureTarget[]): Promise<readonly AgentStoreErasureTarget[]>;
}

async function assertAgentErasureMetadataTypes(client: pg.Client, namespace: string): Promise<void> {
  const unsafeTypes = await client.query(`
    SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped
      AND ((c.relname = 'schema_meta' AND a.attname IN ('meta_key', 'role', 'agent_id'))
        OR (c.relname = 'openclaw_schema_meta' AND a.attname IN ('store', 'store_id')))
      AND a.atttypid <> 'pg_catalog.text'::regtype`, [namespace]);
  if (unsafeTypes.rowCount) throw new Error(`Agent-store erasure metadata type changed: ${namespace}`);
}

async function agentStoreErasureIdentity(client: pg.Client, namespace: string): Promise<AgentStoreErasureIdentity> {
  const metadataTables = await client.query(`
    SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'r' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relname IN ('schema_meta', 'openclaw_schema_meta')`, [namespace]);
  if (metadataTables.rowCount !== 2) throw new Error(`Agent-store erasure metadata is unavailable: ${namespace}`);
  await assertAgentErasureMetadataTypes(client, namespace);
  const identity = await client.query(`SELECT store, store_id FROM ${identifier(namespace)}.openclaw_schema_meta`);
  const agent = await client.query(`SELECT role, agent_id FROM ${identifier(namespace)}.schema_meta WHERE meta_key = 'primary'`);
  const store = identity.rows[0], primary = agent.rows[0];
  if (identity.rowCount !== 1 || typeof store.store_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(store.store_id) ||
      agent.rowCount !== 1) {
    throw new Error(`Agent-store erasure identity is unavailable: ${namespace}`);
  }
  if (store.store === "agent" && primary.role === "agent" && typeof primary.agent_id === "string") {
    return { family: "agent", role: "agent", storeId: store.store_id, agentId: primary.agent_id };
  }
  if (store.store === "state" && primary.role === "global" && primary.agent_id === null) {
    return { family: "state", role: "global", storeId: store.store_id, agentId: null };
  }
  throw new Error(`Agent-store erasure identity is unavailable: ${namespace}`);
}

function erasureIdentityBelongsToUser(identity: AgentStoreErasureIdentity, slug: string, sharedOwner: boolean): boolean {
  if (identity.family === "agent") {
    return identity.role === "agent" && (agentIdBelongsToSlug(identity.agentId, slug) ||
      (!sharedOwner && identity.agentId === "octogee-unmatched-route"));
  }
  return !sharedOwner && identity.family === "state" && identity.role === "global" && identity.agentId === null;
}

async function discoverAgentStoreErasureTargets(client: pg.Client, user: { uid: string; slug: string }, owner: string, shared: string): Promise<AgentStoreErasureTarget[]> {
  const candidates = await client.query(`
    SELECT n.nspname, n.oid::text AS oid, r.rolname FROM pg_catalog.pg_namespace n
    JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
    WHERE r.rolname = ANY($1::text[]) OR ((r.rolname LIKE 'octogee_gateway_%' OR r.rolname LIKE 'octogee_unclaimed_%')
      AND r.oid IN (SELECT m.member FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles parent ON parent.oid = m.roleid WHERE parent.rolname = $2))
    ORDER BY n.nspname`, [[owner, shared], owner]);
  const targets: AgentStoreErasureTarget[] = [];
  for (const row of candidates.rows) {
    if (row.rolname === shared) {
      const agentTable = await client.query(`SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'schema_meta' AND c.relkind = 'r'`, [row.nspname]);
      if (!agentTable.rowCount) continue;
      await assertAgentErasureMetadataTypes(client, row.nspname);
      const metadata = await client.query(`SELECT agent_id FROM ${identifier(row.nspname)}.schema_meta WHERE meta_key = 'primary' AND role = 'agent'`);
      if (!metadata.rows.some(row => agentIdBelongsToSlug(row.agent_id, user.slug))) continue;
    }
    const identity = await agentStoreErasureIdentity(client, row.nspname);
    if (!erasureIdentityBelongsToUser(identity, user.slug, row.rolname === shared)) {
      throw new Error(`Agent-store erasure found foreign user data: ${row.nspname}`);
    }
    targets.push({ namespace: row.nspname, namespaceOid: row.oid, owner: row.rolname, ...identity });
  }
  return targets;
}

function sameErasureTarget(left: AgentStoreErasureTarget, right: AgentStoreErasureTarget): boolean {
  return left.namespace === right.namespace && left.namespaceOid === right.namespaceOid && left.owner === right.owner &&
    left.family === right.family && left.role === right.role && left.storeId === right.storeId && left.agentId === right.agentId;
}

async function assertAgentStoreErasureDependencies(client: pg.Client, target: AgentStoreErasureTarget): Promise<void> {
  const dependencies = await client.query(`
    WITH RECURSIVE removed(classid, objid, objsubid) AS (
      SELECT 'pg_catalog.pg_namespace'::regclass::oid, $1::oid, 0
      UNION
      SELECT d.classid, d.objid, d.objsubid FROM pg_catalog.pg_depend d JOIN removed r
        ON d.refclassid = r.classid AND d.refobjid = r.objid AND (r.objsubid = 0 OR d.refobjsubid = r.objsubid)
    )
    SELECT i.type, i.identity FROM removed r
    CROSS JOIN LATERAL pg_catalog.pg_identify_object(r.classid, r.objid, r.objsubid) i
    LEFT JOIN pg_catalog.pg_namespace owned_namespace ON owned_namespace.oid = CASE
      WHEN r.classid = 'pg_catalog.pg_trigger'::regclass THEN
        (SELECT c.relnamespace FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE t.oid = r.objid)
      WHEN r.classid = 'pg_catalog.pg_attrdef'::regclass THEN
        (SELECT c.relnamespace FROM pg_catalog.pg_attrdef a JOIN pg_catalog.pg_class c ON c.oid = a.adrelid WHERE a.oid = r.objid)
      WHEN r.classid = 'pg_catalog.pg_rewrite'::regclass THEN
        (SELECT c.relnamespace FROM pg_catalog.pg_rewrite w JOIN pg_catalog.pg_class c ON c.oid = w.ev_class WHERE w.oid = r.objid)
      WHEN r.classid = 'pg_catalog.pg_constraint'::regclass THEN
        (SELECT c.connamespace FROM pg_catalog.pg_constraint c WHERE c.oid = r.objid)
    END
    WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
      AND d.classid = r.classid AND d.objid = r.objid AND d.deptype = 'o'
      AND d.refobjid <> (SELECT nspowner FROM pg_catalog.pg_namespace WHERE oid = $1::oid))
    OR (NOT (r.classid = 'pg_catalog.pg_namespace'::regclass AND r.objid = $1::oid)
      AND (COALESCE(i.schema, owned_namespace.nspname) IS DISTINCT FROM $2)
      AND NOT (r.classid = 'pg_catalog.pg_class'::regclass AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_class t JOIN pg_catalog.pg_class b ON b.reltoastrelid = t.oid
        WHERE b.relnamespace = $1::oid AND (t.oid = r.objid OR r.objid IN (
          SELECT indexrelid FROM pg_catalog.pg_index WHERE indrelid = t.oid)))))
    LIMIT 1`, [target.namespaceOid, target.namespace]);
  if (dependencies.rowCount) throw new Error(`Agent-store erasure has an external or foreign-owned dependency: ${target.namespace}`);
}

export async function eraseUserAgentStores(adminDsn: string, user: { uid: string; slug: string }, custody: AgentStoreErasureCustody): Promise<void> {
  if (!user.uid || !user.slug) throw new Error("Agent-store erasure requires a complete user identity");
  const scope = decodeURIComponent(new URL(adminDsn).pathname.slice(1));
  if (!scope) throw new Error("Agent-store erasure requires a database");
  const owner = roleFor("builder", `${scope}:${user.uid}`), shared = roleFor("shared", scope);
  const client = new pg.Client({ connectionString: adminDsn, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(AGENT_STORE_SEARCH_PATH);
    await client.query("SET LOCAL row_security = off");
    await client.query(AGENT_STORE_CREDENTIAL_LOCK);
    await custody.assertCurrent();
    const discovered = await discoverAgentStoreErasureTargets(client, user, owner, shared);
    const assertStopped = async (targets: readonly AgentStoreErasureTarget[], gateways: readonly string[]) => {
      if (!targets.some(target => target.owner !== shared)) return;
      const logins = await client.query(`WITH RECURSIVE members(oid) AS (
        SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1
        UNION SELECT m.member FROM pg_catalog.pg_auth_members m JOIN members parent ON parent.oid = m.roleid
        WHERE m.member <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user))
        SELECT r.rolname FROM members m JOIN pg_catalog.pg_roles r ON r.oid = m.oid WHERE r.rolcanlogin ORDER BY r.rolname`, [owner]);
      const stoppedLogins = new Set(gateways.map(id => roleFor("gateway", `${scope}:${id}`)));
      const retained = logins.rows.map(row => row.rolname as string).filter(name => !stoppedLogins.has(name));
      if (retained.length) throw new AgentStoreErasureRetainedLoginError(`Agent-store erasure retains a user Gateway login without proved runtime retirement: ${retained.join(", ")}`);
    };
    let stoppedGateways = discovered.length ? await custody.assertWritersStopped(discovered) : [];
    if (discovered.length) await assertStopped(discovered, stoppedGateways);
    const bound = await custody.bindTargets(discovered);
    if (discovered.some(target => !bound.some(existing => sameErasureTarget(existing, target)))) {
      throw new Error("Agent-store erasure target changed after deletion admission");
    }
    if (bound.length && !discovered.length) stoppedGateways = await custody.assertWritersStopped(bound);
    if (bound.length) await assertStopped(bound, stoppedGateways);
    for (const target of bound) {
      if (!erasureIdentityBelongsToUser(target, user.slug, target.owner === shared)) throw new Error("Agent-store erasure target changed");
      await dropBoundAgentStore(client, target, discovered, async () => {
        await assertStopped(bound, stoppedGateways);
        await custody.assertCurrent();
      });
    }
    if (bound.length) await assertStopped(bound, await custody.assertWritersStopped(bound));
    await custody.assertCurrent();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { await client.end(); }
}

async function erasureNamespaceExists(client: pg.Client, target: AgentStoreErasureTarget): Promise<boolean> {
  const namespace = await client.query(`SELECT n.nspname, n.oid::text AS oid, r.rolname FROM pg_catalog.pg_namespace n
    JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner WHERE n.oid = $1::oid OR n.nspname = $2`, [target.namespaceOid, target.namespace]);
  if (namespace.rowCount === 0) return false;
  const row = namespace.rows[0];
  if (namespace.rowCount !== 1 || row.nspname !== target.namespace || row.oid !== target.namespaceOid || row.rolname !== target.owner) {
    throw new Error("Agent-store erasure target changed before cleanup");
  }
  return true;
}

async function dropBoundAgentStore(client: pg.Client, target: AgentStoreErasureTarget, discovered: readonly AgentStoreErasureTarget[], assertCurrent: () => Promise<void>): Promise<void> {
  if (!await erasureNamespaceExists(client, target)) return;
  if (!discovered.some(current => sameErasureTarget(current, target))) throw new Error("Agent-store erasure target ownership changed");
  const relations = await client.query(`SELECT relname FROM pg_catalog.pg_class WHERE relnamespace = $1::oid AND relkind IN ('r', 'p') ORDER BY oid`, [target.namespaceOid]);
  for (const relation of relations.rows) {
    await client.query(`LOCK TABLE ${identifier(target.namespace)}.${identifier(relation.relname)} IN ACCESS EXCLUSIVE MODE`);
  }
  const identity = await agentStoreErasureIdentity(client, target.namespace);
  if (!sameErasureTarget(target, { ...target, ...identity })) throw new Error("Agent-store erasure target identity changed");
  await assertSafeSchemaOwnershipTransfer(client, target.namespace);
  await assertAgentStoreErasureDependencies(client, target);
  await assertCurrent();
  if (!await erasureNamespaceExists(client, target)) throw new Error("Agent-store erasure target changed while locking");
  await dropAgentStoreObjectsRestricted(client, target, relations.rows.map(row => row.relname));
}

async function dropAgentStoreObjectsRestricted(client: pg.Client, target: AgentStoreErasureTarget, tables: readonly string[]): Promise<void> {
  const qualified = (name: string) => `${identifier(target.namespace)}.${identifier(name)}`;
  if (tables.length) await client.query(`DROP TABLE ${tables.map(qualified).join(", ")} RESTRICT`);
  const functions = await client.query("SELECT p.oid::regprocedure::text AS signature FROM pg_catalog.pg_proc p WHERE p.pronamespace = $1::oid AND p.prokind = 'f' ORDER BY p.oid", [target.namespaceOid]);
  if (functions.rowCount) await client.query(`DROP FUNCTION ${functions.rows.map(row => row.signature).join(", ")} RESTRICT`);
  const sequences = await client.query("SELECT relname FROM pg_catalog.pg_class WHERE relnamespace = $1::oid AND relkind = 'S' ORDER BY oid", [target.namespaceOid]);
  if (sequences.rowCount) await client.query(`DROP SEQUENCE ${sequences.rows.map(row => qualified(row.relname)).join(", ")} RESTRICT`);
  const configurations = await client.query("SELECT cfgname FROM pg_catalog.pg_ts_config WHERE cfgnamespace = $1::oid ORDER BY oid", [target.namespaceOid]);
  for (const row of configurations.rows) await client.query(`DROP TEXT SEARCH CONFIGURATION ${qualified(row.cfgname)} RESTRICT`);
  await client.query(`DROP SCHEMA ${identifier(target.namespace)} RESTRICT`);
}
