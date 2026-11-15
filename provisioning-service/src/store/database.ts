import pg from "pg";

export type Queryable = Pick<pg.PoolClient, "query">;

export interface Database {
  pool: pg.Pool;
  schema: string;
  table(name: string): string;
  changeChannel: string;
  write<T>(work: (client: pg.PoolClient, bumpVersion: (uid: string) => Promise<bigint>) => Promise<T>): Promise<T>;
  read<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function openDatabase(options: { url: string; schema: string; max?: number; applicationName?: string }): Database {
  const pool = new pg.Pool({ connectionString: options.url, max: options.max ?? 10, application_name: options.applicationName ?? "provisioning-service" });
  const quoted = `"${options.schema}"`;
  const table = (name: string) => `${quoted}."${name}"`;
  const changeChannel = `${options.schema}_changes`;

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
    schema: options.schema,
    table,
    changeChannel,
    write: (work) => transaction("READ COMMITTED", async (client) => {
      await client.query(`SELECT value FROM ${table("counter")} WHERE id = 1 FOR UPDATE`);
      let notified = false;
      const bumpVersion = async (uid: string) => {
        const { rows } = await client.query<{ value: string }>(`UPDATE ${table("counter")} SET value = value + 1 WHERE id = 1 RETURNING value`);
        const version = BigInt(rows[0].value);
        await client.query(`INSERT INTO ${table("version_log")} (version, uid) VALUES ($1, $2)`, [version.toString(), uid]);
        if (!notified) {
          await client.query("SELECT pg_notify($1, '')", [changeChannel]);
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

export async function migrate(db: Database): Promise<void> {
  const t = db.table;
  const client = await db.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`${db.schema}:migrate`]);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS "${db.schema}";
      CREATE TABLE IF NOT EXISTS ${t("counter")} (
        id int PRIMARY KEY CHECK (id = 1),
        value bigint NOT NULL,
        pruned_through bigint NOT NULL DEFAULT 0
      );
      INSERT INTO ${t("counter")} (id, value) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS ${t("version_log")} (
        version bigint PRIMARY KEY,
        uid text NOT NULL,
        written_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ${t("provisionings")} (
        uid text PRIMARY KEY,
        generation integer NOT NULL,
        resource_version bigint NOT NULL,
        spec jsonb NOT NULL,
        observed_generation integer NOT NULL DEFAULT 0,
        conditions jsonb NOT NULL,
        outputs jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS provisionings_resource_version ON ${t("provisionings")} (resource_version);
      CREATE TABLE IF NOT EXISTS ${t("provisioning_work")} (
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
      CREATE INDEX IF NOT EXISTS provisioning_work_due ON ${t("provisioning_work")} (due_at) WHERE state <> 'parked';
      CREATE TABLE IF NOT EXISTS ${t("git_keys")} (
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
      CREATE TABLE IF NOT EXISTS ${t("credentials")} (
        uid text NOT NULL REFERENCES ${t("provisionings")} (uid) ON DELETE CASCADE,
        name text NOT NULL,
        ciphertext bytea NOT NULL,
        iv bytea NOT NULL,
        tag bytea NOT NULL,
        version integer NOT NULL,
        PRIMARY KEY (uid, name)
      );
      CREATE TABLE IF NOT EXISTS ${t("attempts")} (
        id bigserial PRIMARY KEY,
        uid text NOT NULL REFERENCES ${t("provisionings")} (uid) ON DELETE CASCADE,
        generation integer NOT NULL,
        started_at timestamptz NOT NULL,
        finished_at timestamptz NOT NULL,
        result text NOT NULL,
        reason text,
        steps jsonb NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attempts_by_user ON ${t("attempts")} (uid, id DESC);
      CREATE TABLE IF NOT EXISTS ${t("idempotency")} (
        key text PRIMARY KEY,
        request_hash text NOT NULL,
        status integer NOT NULL,
        body jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`${db.schema}:migrate`]).catch(() => undefined);
    client.release();
  }
}
