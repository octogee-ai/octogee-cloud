import { isDeepStrictEqual } from "node:util";
import pg from "pg";

type OperatorRole = { name: string; oid: string };
type StoreSchema = { name: string; oid: string };
interface WriterScope {
  sourceGatewayId: string;
  schemas: string[];
  trustedOperators: OperatorRole[];
}
export interface HeldDatabaseWriterScope extends WriterScope {
  uid: string;
}
export interface HeldSharedDatabaseWriterScope {
  gatewayId: string;
  owners: { uid: string; schemas: string[] }[];
  trustedOperators: OperatorRole[];
}
export interface HeldDatabaseWriterBinding {
  databaseOid: string;
  ownerOid: string;
  roleOid: string;
  previousLimit: number;
  schemas: StoreSchema[];
}
type Current = () => Promise<void>;
type CheckBinding = (
  scope: HeldDatabaseWriterScope,
  binding: HeldDatabaseWriterBinding,
  current: Current,
) => Promise<void>;
export interface HeldReturnDatabaseBarrier {
  inspect(scope: HeldDatabaseWriterScope, current: Current): Promise<HeldDatabaseWriterBinding>;
  hold: CheckBinding;
  verify: CheckBinding;
  drainIdle: CheckBinding;
  restore: CheckBinding;
}
type Action = "inspect" | "hold" | "verify" | "drain-idle" | "restore";

const writersSql = `
WITH schemas AS MATERIALIZED (SELECT oid,nspowner,nspacl FROM pg_namespace WHERE nspowner=$1 AND ($3::text[] IS NULL OR nspname=ANY($3))),
relations AS MATERIALIZED (
  SELECT c.oid,c.relowner,c.relacl FROM pg_class c JOIN schemas n ON c.relnamespace=n.oid
  WHERE c.relkind IN ('r','p','S','v','m','f')
), grants AS (
  SELECT nspowner AS grantee FROM schemas
  UNION SELECT x.grantee FROM schemas n CROSS JOIN LATERAL aclexplode(n.nspacl) x WHERE x.privilege_type='CREATE'
  UNION SELECT relowner FROM relations
  UNION SELECT x.grantee FROM relations c CROSS JOIN LATERAL aclexplode(c.relacl) x
    WHERE x.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER','USAGE','MAINTAIN')
  UNION SELECT x.grantee FROM pg_attribute a JOIN relations c ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl) x
    WHERE x.privilege_type IN ('INSERT','UPDATE')
  UNION SELECT x.grantee FROM pg_proc p JOIN schemas n ON p.pronamespace=n.oid
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
    WHERE p.prosecdef AND x.privilege_type='EXECUTE'
  UNION SELECT oid FROM pg_roles WHERE rolsuper OR rolcreaterole OR rolname='pg_write_all_data'
)
SELECT r.oid::text AS oid,r.rolname AS name,r.rolsuper OR r.rolcreaterole AS administrator
FROM pg_roles r WHERE r.rolcanlogin AND r.oid<>$2 AND EXISTS (
  SELECT FROM grants g WHERE CASE WHEN g.grantee=0 THEN true ELSE
    r.oid=g.grantee OR pg_has_role(r.oid,g.grantee,'SET') OR pg_has_role(r.oid,g.grantee,'USAGE') END)
ORDER BY r.oid`;

async function assertWriters(
  client: pg.Client,
  scope: WriterScope,
  binding: HeldDatabaseWriterBinding,
  exactSchemas?: string[],
) {
  const { rows } = await client.query<OperatorRole & { administrator: boolean }>(writersSql, [
    binding.ownerOid,
    binding.roleOid,
    exactSchemas ?? null,
  ]);
  if (
    !scope.trustedOperators.length ||
    rows.some(
      (r) =>
        !r.administrator ||
        !scope.trustedOperators.some((role) => role.name === r.name && role.oid === r.oid),
    ) ||
    scope.trustedOperators.some(
      (role) => !rows.some((r) => r.oid === role.oid && r.name === role.name),
    )
  ) {
    throw new Error("Unexpected effective owner store writer or database operator");
  }
}

async function observe(
  client: pg.Client,
  source: string,
  owner: string,
  scope: WriterScope,
  exactSchemas?: string[],
) {
  const {
    rows: [role],
  } = await client.query<{ roleOid: string; ownerOid: string; databaseOid: string; limit: number }>(
    `
    SELECT s.oid::text AS "roleOid",o.oid::text AS "ownerOid",d.oid::text AS "databaseOid",s.rolconnlimit AS "limit"
    FROM pg_roles s,pg_roles o,pg_database d WHERE s.rolname=$1 AND o.rolname=$2 AND d.datname=current_database()
      AND s.rolcanlogin AND NOT(s.rolsuper OR s.rolcreaterole OR s.rolreplication OR o.rolcanlogin)
      AND pg_has_role(s.oid,o.oid,'USAGE') AND pg_has_role(s.oid,o.oid,'SET')`,
    [source, owner],
  );
  if (!role) throw new Error("Original isolated login or owner identity changed");
  const schemas = (
    await client.query<StoreSchema>(
      'SELECT nspname AS name,oid::text FROM pg_namespace WHERE nspowner=$1 AND ($2::text[] IS NULL OR nspname=ANY($2)) ORDER BY nspname COLLATE "C"',
      [role.ownerOid, exactSchemas ?? null],
    )
  ).rows;
  if (
    !schemas.length ||
    !isDeepStrictEqual(
      schemas.map((s) => s.name),
      [...scope.schemas].sort(),
    )
  )
    throw new Error("Original database schema roster changed");
  return {
    roleOid: role.roleOid,
    ownerOid: role.ownerOid,
    databaseOid: role.databaseOid,
    schemas,
    previousLimit: role.limit,
  };
}

function compareBinding(current: HeldDatabaseWriterBinding, expected: HeldDatabaseWriterBinding) {
  if (
    !Number.isInteger(expected.previousLimit) ||
    expected.previousLimit < -1 ||
    expected.previousLimit > 2147483647 ||
    expected.previousLimit === 0 ||
    !isDeepStrictEqual({ ...current, previousLimit: expected.previousLimit }, expected) ||
    (current.previousLimit !== 0 && current.previousLimit !== expected.previousLimit)
  )
    throw new Error("Held database role identity or connection limit changed");
}

async function assertSessions(
  client: pg.Client,
  binding: HeldDatabaseWriterBinding,
  drain: boolean,
) {
  if (drain) {
    await client.query(
      `SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE usesysid=$1
      AND datid=$2 AND backend_type='client backend' AND state='idle' AND xact_start IS NULL`,
      [binding.roleOid, binding.databaseOid],
    );
    await client.query("SELECT pg_stat_clear_snapshot()");
  }
  const {
    rows: [state],
  } = await client.query<{ busy: boolean }>(
    `SELECT EXISTS(SELECT FROM pg_stat_activity WHERE usesysid=$1)
    OR EXISTS(SELECT FROM pg_prepared_xacts WHERE database=current_database()) AS busy`,
    [binding.roleOid],
  );
  if (state.busy) throw new Error("Held database still has sessions or prepared transactions");
}

export function heldReturnDatabaseBarrier(
  adminDsn: string,
  roleFor: (kind: string, id: string) => string,
  credentialLock: string,
): HeldReturnDatabaseBarrier {
  const db = decodeURIComponent(new URL(adminDsn).pathname.slice(1));
  if (!db) throw new Error("Held database requires the exact agent store");
  async function run(
    scope: HeldDatabaseWriterScope,
    current: Current,
    action: Action,
    expected?: HeldDatabaseWriterBinding,
  ) {
    if (!scope.uid || !scope.sourceGatewayId)
      throw new Error("Incomplete held database owner and source");
    const source = roleFor("gateway", db + ":" + scope.sourceGatewayId);
    const owner = roleFor("builder", db + ":" + scope.uid);
    const client = new pg.Client({
      connectionString: adminDsn,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
    await current();
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path=pg_catalog");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query(credentialLock);
      await current();
      const binding = await observe(client, source, owner, scope);
      if (expected) compareBinding(binding, expected);
      await assertWriters(client, scope, binding);
      await apply(client, source, action, binding, expected);
      await current();
      await client.query("COMMIT");
      return binding;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      await client.end();
    }
  }
  return {
    inspect: (scope: HeldDatabaseWriterScope, current: Current) => run(scope, current, "inspect"),
    hold: (scope: HeldDatabaseWriterScope, binding: HeldDatabaseWriterBinding, current: Current) =>
      run(scope, current, "hold", binding).then(() => undefined),
    verify: (
      scope: HeldDatabaseWriterScope,
      binding: HeldDatabaseWriterBinding,
      current: Current,
    ) => run(scope, current, "verify", binding).then(() => undefined),
    drainIdle: (
      scope: HeldDatabaseWriterScope,
      binding: HeldDatabaseWriterBinding,
      current: Current,
    ) => run(scope, current, "drain-idle", binding).then(() => undefined),
    restore: (
      scope: HeldDatabaseWriterScope,
      binding: HeldDatabaseWriterBinding,
      current: Current,
    ) => run(scope, current, "restore", binding).then(() => undefined),
  };
}

async function apply(
  client: pg.Client,
  source: string,
  action: Action,
  binding: HeldDatabaseWriterBinding,
  expected?: HeldDatabaseWriterBinding,
) {
  if (action === "inspect") {
    if (binding.previousLimit === 0)
      throw new Error("Original login already has zero connection capacity");
    return;
  }
  if (!expected) throw new Error("Missing durable database writer binding");
  if (action === "hold" || action === "restore") {
    const limit = action === "hold" ? 0 : expected.previousLimit;
    if (binding.previousLimit !== limit)
      await client.query(`ALTER ROLE ${pg.escapeIdentifier(source)} CONNECTION LIMIT ${limit}`);
    return;
  }
  if (binding.previousLimit !== 0)
    throw new Error("Original database login still admits new connections");
  await assertSessions(client, binding, action === "drain-idle");
}

type RunWhileHeld = <T>(
  scope: HeldSharedDatabaseWriterScope,
  binding: HeldDatabaseWriterBinding,
  current: Current,
  work: (assertHeld: Current) => Promise<T>,
) => Promise<T>;

export interface HeldSharedDatabaseBarrier {
  inspect(scope: HeldSharedDatabaseWriterScope, current: Current): Promise<HeldDatabaseWriterBinding>;
  hold(scope: HeldSharedDatabaseWriterScope, binding: HeldDatabaseWriterBinding, current: Current): Promise<void>;
  drainIdle(scope: HeldSharedDatabaseWriterScope, binding: HeldDatabaseWriterBinding, current: Current): Promise<void>;
  restore(scope: HeldSharedDatabaseWriterScope, binding: HeldDatabaseWriterBinding, current: Current): Promise<void>;
  runWhileHeld: RunWhileHeld;
}

function retainedSharedScope(input: HeldSharedDatabaseWriterScope): WriterScope {
  const schemas = input.owners.flatMap(owner => owner.schemas);
  if (!/^shared-[a-z0-9]+$/.test(input.gatewayId) || input.owners.length !== 6 ||
      new Set(input.owners.map(owner => owner.uid)).size !== 6 || new Set(schemas).size !== schemas.length ||
      input.owners.some(owner => !owner.uid || !owner.schemas.length) ||
      schemas.some(schema => !/^[a-z_][a-z0-9_]{0,62}$/.test(schema))) {
    throw new Error("Shared store barrier requires the exact six retained owner inventories");
  }
  return { sourceGatewayId: input.gatewayId, schemas, trustedOperators: input.trustedOperators };
}

async function assertNoConcurrentOperators(client: pg.Client, scope: WriterScope, binding: HeldDatabaseWriterBinding) {
  await client.query("SELECT pg_stat_clear_snapshot()");
  const { rows: [result] } = await client.query<{ busy: boolean }>(`
    SELECT EXISTS(SELECT FROM pg_stat_activity WHERE datid=$1 AND pid<>pg_backend_pid()
      AND backend_type='client backend' AND usesysid=ANY($2::oid[])) AS busy
  `, [binding.databaseOid, scope.trustedOperators.map(role => role.oid)]);
  if (result?.busy !== false) throw new Error("Another privileged session is connected to the held Shared stores");
}

export function heldSharedDatabaseBarrier(
  adminDsn: string,
  roleFor: (kind: string, id: string) => string,
  credentialLock: string,
): HeldSharedDatabaseBarrier {
  const db = decodeURIComponent(new URL(adminDsn).pathname.slice(1));
  if (!db) throw new Error("Held Shared database requires the exact agent store");
  async function run<T>(input: HeldSharedDatabaseWriterScope, current: Current, options: {
    action: Action; expected?: HeldDatabaseWriterBinding; work?: (assertHeld: Current) => Promise<T>;
  }) {
    const scope = retainedSharedScope(input);
    const source = roleFor("gateway", db + ":" + scope.sourceGatewayId);
    const owner = roleFor("shared", db);
    const client = new pg.Client({ connectionString: adminDsn, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    await current();
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path=pg_catalog");
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query(credentialLock);
      const observeCurrent = async () => {
        await current();
        const binding = await observe(client, source, owner, scope, scope.schemas);
        if (options.expected) compareBinding(binding, options.expected);
        await assertWriters(client, scope, binding, scope.schemas);
        await assertNoConcurrentOperators(client, scope, binding);
        return binding;
      };
      const binding = await observeCurrent();
      await apply(client, source, options.action, binding, options.expected);
      const assertHeld = async () => assertSessions(client, await observeHeld(observeCurrent), false);
      const value = options.work ? await options.work(assertHeld) : undefined;
      if (options.work) await assertHeld();
      await current();
      await client.query("COMMIT");
      return { binding, value };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      await client.end();
    }
  }
  return {
    inspect: (scope, current) => run(scope, current, { action: "inspect" }).then(result => result.binding),
    hold: (scope, expected, current) => run(scope, current, { action: "hold", expected }).then(() => undefined),
    drainIdle: (scope, expected, current) => run(scope, current, { action: "drain-idle", expected }).then(() => undefined),
    restore: (scope, expected, current) => run(scope, current, { action: "restore", expected }).then(() => undefined),
    runWhileHeld: async (scope, expected, current, work) => {
      const result = await run(scope, current, { action: "verify", expected, work });
      return result.value!;
    },
  };
}

async function observeHeld(observeCurrent: () => Promise<HeldDatabaseWriterBinding>) {
  const binding = await observeCurrent();
  if (binding.previousLimit !== 0) throw new Error("Shared gateway login still admits new connections");
  return binding;
}
