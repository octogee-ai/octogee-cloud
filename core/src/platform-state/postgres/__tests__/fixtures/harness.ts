import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { PlatformStateError } from "../../../errors.js";
import type { GatewayRecoveryReceipt, OperationAuditRow, OperationRecord } from "../../../operations.js";
import type { PlatformStateStore, WatchAggregate, WatchEvent, WatchListener } from "../../../store.js";
import { migratePlatformState } from "../../migrate.js";
import { DEFAULT_RETRY_POLICY, DirectPostgresSession, type PlatformStateLogger, type PostgresContext } from "../../session.js";
import { poolRunner, runQuery, type Row } from "../../sql.js";
import { createPostgresPlatformStateStore, type PostgresPlatformStateStoreOptions } from "../../store.js";
import { runPostgresTransaction } from "../../transaction.js";

export const dsn = process.env.OCTOGEE_TEST_POSTGRES_DSN;

export interface LogEntry {
  readonly level: "warn" | "error";
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type StoreOverrides = Omit<PostgresPlatformStateStoreOptions, "pool" | "schema" | "logger">;

export const FAST_TIMINGS: StoreOverrides = {
  watchTiming: { pollIntervalMs: 100, initialRetryDelayMs: 20, maxRetryDelayMs: 200 },
  notificationTiming: { initialReconnectDelayMs: 20, maxReconnectDelayMs: 200 },
};

export interface PlatformStateHarness {
  readonly pool: pg.Pool;
  readonly schema: string;
  readonly applicationName: string;
  readonly logs: LogEntry[];
  readonly poolErrors: Error[];
  readonly context: PostgresContext;
  readonly session: DirectPostgresSession;
  readonly store: PlatformStateStore;
  openStore(overrides?: StoreOverrides): PlatformStateStore;
  query(text: string, values?: readonly unknown[]): Promise<readonly Row[]>;
  terminate(target: "idle in transaction" | "listen"): Promise<number>;
  dispose(): Promise<void>;
}

export function newSchemaName(): string {
  return `platform_test_${randomUUID().replaceAll("-", "")}`;
}

export function newPool(applicationName = `platform-state-${randomUUID()}`): pg.Pool {
  return new pg.Pool({ connectionString: dsn, max: 12, application_name: applicationName });
}

export async function createHarness(overrides: StoreOverrides = FAST_TIMINGS): Promise<PlatformStateHarness> {
  const applicationName = `platform-state-${randomUUID()}`;
  const pool = newPool(applicationName);
  const poolErrors: Error[] = [];
  pool.on("error", (error) => poolErrors.push(error));
  const schema = newSchemaName();
  await migratePlatformState(pool, { schema });
  const logs: LogEntry[] = [];
  const logger: PlatformStateLogger = {
    warn: (message, detail) => logs.push({ level: "warn", message, detail }),
    error: (message, detail) => logs.push({ level: "error", message, detail }),
  };
  const stores: PlatformStateStore[] = [];
  const openStore = (storeOverrides: StoreOverrides = overrides) => {
    const store = createPostgresPlatformStateStore({ pool, schema, logger, ...storeOverrides });
    stores.push(store);
    return store;
  };
  const context: PostgresContext = {
    pool,
    schema: pg.escapeIdentifier(schema),
    retry: { ...DEFAULT_RETRY_POLICY, ...overrides.retry },
    logger,
  };
  const run = poolRunner(pool);
  return {
    pool,
    schema,
    applicationName,
    logs,
    poolErrors,
    context,
    session: new DirectPostgresSession(context, runPostgresTransaction),
    store: openStore(),
    openStore,
    query: (text, values = []) => runQuery(run, context.schema, text, values),
    async terminate(target) {
      const predicate = target === "listen" ? "query LIKE 'LISTEN %'" : "state = 'idle in transaction'";
      const rows = await runQuery(
        run,
        context.schema,
        `SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
          WHERE application_name = $1::text AND pid <> pg_backend_pid() AND ${predicate}`,
        [applicationName],
      );
      return rows.length;
    },
    async dispose() {
      const closing = await Promise.allSettled(stores.map((store) => store.close()));
      await pool.end();
      const cleanup = newPool(`${applicationName}-cleanup`);
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(schema)} CASCADE`);
      } finally {
        await cleanup.end();
      }
      const failure = closing.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure !== undefined) throw failure.reason;
    },
  };
}

export function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: `op-${randomUUID()}`,
    kind: "rollout",
    status: "pending",
    createdBy: "operator:test",
    createdAt: 1_000,
    startedAt: null,
    completedAt: null,
    input: {},
    steps: [],
    ...overrides,
  };
}

export function auditId(idempotencyKey: string): string {
  return `audit-${createHash("sha256").update(idempotencyKey, "utf8").digest("hex")}`;
}

export function audit(overrides: Partial<OperationAuditRow> = {}): OperationAuditRow {
  const idempotencyKey = overrides.idempotencyKey ?? `key-${randomUUID()}`;
  return {
    id: auditId(idempotencyKey),
    recordType: "audit",
    schemaVersion: 1,
    status: "recorded",
    lifecycleStage: "intent-recorded",
    idempotencyKey,
    mutationFingerprint: "fingerprint-1",
    mutation: { kind: "alias-flip" },
    actor: "operator:test",
    forced: false,
    what: "flip alias",
    why: "test",
    target: { gatewayId: "g1" },
    preActionStatus: { status: "running" },
    aliasPlan: [{ alias: "preview", intendedTarget: "g2", expectedTarget: null }],
    createdAt: 1_000,
    completedAt: null,
    ...overrides,
  };
}

export function claimedAudit(overrides: Partial<OperationAuditRow> = {}): OperationAuditRow {
  return audit({
    status: "in-progress",
    lifecycleStage: "action-started",
    actionClaimId: "claim-1",
    actionStartedAt: 2_000,
    actionRecoveryCount: 0,
    ...overrides,
  });
}

export function receipt(overrides: Partial<GatewayRecoveryReceipt> = {}): GatewayRecoveryReceipt {
  return {
    id: `builder-recover-${randomUUID()}`,
    kind: "recover-unreachable-disposable",
    status: "pending",
    createdBy: "operator:test",
    createdAt: 1_000,
    startedAt: null,
    completedAt: null,
    input: { uid: "uid-1" },
    steps: [],
    gatewayId: "g1",
    inputUid: "uid-1",
    ...overrides,
  };
}

export interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

export function gate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

export function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  const all = gate();
  return () => {
    arrived += 1;
    if (arrived === parties) all.open();
    return all.opened;
  };
}

export interface RecordingListener<A extends WatchAggregate> extends WatchListener<A> {
  readonly events: WatchEvent<A>[];
  readonly errors: PlatformStateError[];
}

export function recordingListener<A extends WatchAggregate>(
  onEvent: (event: WatchEvent<A>, index: number) => void | Promise<void> = () => undefined,
): RecordingListener<A> {
  const events: WatchEvent<A>[] = [];
  const errors: PlatformStateError[] = [];
  return {
    events,
    errors,
    async onEvent(event) {
      events.push(event);
      await onEvent(event, events.length - 1);
    },
    onError(error) {
      errors.push(error);
    },
  };
}
