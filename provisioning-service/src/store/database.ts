import pg from "pg";


export interface Database {
  pool: pg.Pool;
  connection: DatabaseConnection;
  schema: string;
  table(name: string): string;
  write<T>(work: (client: pg.PoolClient, bumpVersion: (uid: string) => Promise<bigint>) => Promise<T>): Promise<T>;
  read<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DatabaseConnection = pg.ClientConfig & { max?: number };

export function openDatabase(options: { connection: DatabaseConnection; schema: string; log: { error(message: string, fields?: Record<string, unknown>): void } }): Database {
  const pool = new pg.Pool({ ...options.connection, application_name: "provisioning-service" });
  pool.on("error", (error) => options.log.error("database connection failed", { error: error.message }));
  const quoted = `"${options.schema}"`;
  const table = (name: string) => `${quoted}."${name}"`;

  async function transaction<T>(isolation: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    pool,
    connection: options.connection,
    schema: options.schema,
    table,
    write: (work) => transaction("READ COMMITTED", async (client) => {
      await client.query(`SELECT value FROM ${table("counter")} WHERE id = 1 FOR UPDATE`);
      let notified = false;
      const bumpVersion = async (uid: string) => {
        const { rows } = await client.query<{ value: string }>(`UPDATE ${table("counter")} SET value = value + 1 WHERE id = 1 RETURNING value`);
        const version = BigInt(rows[0].value);
        await client.query(`INSERT INTO ${table("version_log")} (version, uid) VALUES ($1, $2)`, [version.toString(), uid]);
        if (!notified) {
          await client.query("SELECT pg_notify('provisioning_service_changes', '')");
          notified = true;
        }
        return version;
      };
      return work(client, bumpVersion);
    }),
    read: (work) => transaction("REPEATABLE READ READ ONLY", work),
    close: () => pool.end(),
  };
}

const MIGRATIONS: readonly ((table: (name: string) => string) => string)[] = [
  (t) => `
    CREATE TABLE ${t("counter")} (
      id int PRIMARY KEY CHECK (id = 1),
      value bigint NOT NULL,
      pruned_through bigint NOT NULL DEFAULT 0
    );
    INSERT INTO ${t("counter")} (id, value) VALUES (1, 0);
    CREATE TABLE ${t("version_log")} (
      version bigint PRIMARY KEY,
      uid text NOT NULL,
      written_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${t("deletions")} (
      resource_version bigint PRIMARY KEY,
      uid text NOT NULL,
      deleted_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${t("provisionings")} (
      uid text PRIMARY KEY,
      generation integer NOT NULL,
      resource_version bigint NOT NULL,
      spec jsonb NOT NULL,
      observed_generation integer NOT NULL DEFAULT 0,
      conditions jsonb NOT NULL,
      outputs jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX provisionings_resource_version ON ${t("provisionings")} (resource_version);
    CREATE TABLE ${t("provisioning_work")} (
      uid text PRIMARY KEY REFERENCES ${t("provisionings")} (uid) ON DELETE CASCADE,
      state text NOT NULL CHECK (state IN ('queued', 'running', 'retrying', 'parked', 'idle')),
      due_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      dirty boolean NOT NULL DEFAULT false,
      lease_holder text,
      lease_token text,
      lease_expires_at timestamptz,
      last_error_reason text,
      last_error_message text,
      last_attempt_at timestamptz,
      last_success_at timestamptz
    );
    CREATE INDEX provisioning_work_due ON ${t("provisioning_work")} (due_at) WHERE state <> 'parked';
    CREATE TABLE ${t("git_keys")} (
      uid text NOT NULL REFERENCES ${t("provisionings")} (uid) ON DELETE CASCADE,
      gateway_id text NOT NULL,
      generation integer NOT NULL,
      resource_version bigint NOT NULL,
      public_key text NOT NULL,
      registered_public_key text,
      deletion_requested_at timestamptz,
      observed_generation integer NOT NULL DEFAULT 0,
      conditions jsonb NOT NULL,
      PRIMARY KEY (uid, gateway_id)
    );
    CREATE TABLE ${t("credentials")} (
      uid text NOT NULL REFERENCES ${t("provisionings")} (uid) ON DELETE CASCADE,
      name text NOT NULL,
      ciphertext bytea NOT NULL,
      iv bytea NOT NULL,
      tag bytea NOT NULL,
      version integer NOT NULL,
      PRIMARY KEY (uid, name)
    );
    CREATE TABLE ${t("attempts")} (
      id bigserial PRIMARY KEY,
      uid text NOT NULL REFERENCES ${t("provisionings")} (uid) ON DELETE CASCADE,
      generation integer NOT NULL,
      started_at timestamptz NOT NULL,
      finished_at timestamptz NOT NULL,
      result text NOT NULL,
      reason text,
      steps jsonb NOT NULL
    );
    CREATE INDEX attempts_by_user ON ${t("attempts")} (uid, id DESC);
    CREATE TABLE ${t("idempotency")} (
      key text PRIMARY KEY,
      request_hash text NOT NULL,
      status integer NOT NULL,
      body jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `,
  (t) => `
    ALTER TABLE ${t("git_keys")}
      ADD COLUMN refusals integer NOT NULL DEFAULT 0,
      ADD COLUMN retry_after timestamptz;
  `,
  (t) => `
    DELETE FROM ${t("git_keys")};
    ALTER TABLE ${t("git_keys")}
      DROP CONSTRAINT git_keys_pkey,
      ADD COLUMN holder text NOT NULL,
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
      ADD PRIMARY KEY (uid, holder);
    CREATE INDEX git_keys_by_holder ON ${t("git_keys")} (holder);
    CREATE INDEX git_keys_by_gateway ON ${t("git_keys")} (gateway_id);
    CREATE INDEX git_keys_pending_release ON ${t("git_keys")} (uid) WHERE deletion_requested_at IS NOT NULL;
    ALTER TABLE ${t("provisioning_work")} ADD COLUMN release_only boolean NOT NULL DEFAULT false;
    ALTER TABLE ${t("git_keys")} ADD COLUMN adopt_requested boolean NOT NULL DEFAULT false;
  `,
];

export async function migrate(db: Database): Promise<{ from: number; to: number }> {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${db.schema}:migrate`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${db.schema}"`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${db.table("schema_version")} (id int PRIMARY KEY CHECK (id = 1), version integer NOT NULL)`);
    await client.query(`INSERT INTO ${db.table("schema_version")} (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`);
    const { rows } = await client.query<{ version: number }>(`SELECT version FROM ${db.table("schema_version")} WHERE id = 1`);
    const from = rows[0].version;
    if (from > MIGRATIONS.length) throw new Error(`schema version ${from} is newer than this build knows (${MIGRATIONS.length})`);
    for (let version = from; version < MIGRATIONS.length; version += 1) {
      await client.query(MIGRATIONS[version](db.table));
    }
    await client.query(`UPDATE ${db.table("schema_version")} SET version = $1 WHERE id = 1`, [MIGRATIONS.length]);
    await client.query("COMMIT");
    return { from, to: MIGRATIONS.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
