import { BackendFailureError, isPlatformStateError, type PlatformStateError } from "../errors.js";
import type {
  Stored,
  WatchAggregate,
  WatchChange,
  WatchCursor,
  WatchEvent,
  WatchListener,
  WatchRecords,
  WatchResyncReason,
  WatchSubscription,
} from "../store.js";
import type { ChangeNotifications } from "./notifications.js";
import type { PostgresContext } from "./session.js";
import { SqlParameters, type Row } from "./sql.js";
import { withReadSnapshot, type SnapshotQuery } from "./transaction.js";
import type { FilterKeys, PostgresWatchSource } from "./watch-sources.js";

export interface PostgresWatchTiming {
  readonly pollIntervalMs: number;
  readonly initialRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
}

export const DEFAULT_WATCH_TIMING: PostgresWatchTiming = {
  pollIntervalMs: 2_000,
  initialRetryDelayMs: 250,
  maxRetryDelayMs: 30_000,
};

const XID8_TEXT = /^\d{1,20}$/;
const XID8_MAX = 2n ** 64n - 1n;

const HORIZON = "SELECT pg_snapshot_xmin(pg_current_snapshot()) AS horizon";

class ListenerFailure {
  constructor(readonly cause: unknown) {}
}

interface PollResult {
  readonly resync?: WatchResyncReason;
  readonly horizon?: string;
  readonly keys?: readonly string[];
  readonly rows?: readonly Row[];
}

export interface PostgresWatchOptions {
  readonly context: PostgresContext;
  readonly notifications: ChangeNotifications;
  readonly timing: PostgresWatchTiming;
  readonly resumeFrom?: WatchCursor;
  readonly onSettled: () => void;
}

class PostgresWatch<A extends WatchAggregate> implements WatchSubscription {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private rejectClosed!: (error: unknown) => void;
  private stopping = false;
  private known = new Map<string, string>();
  private cursor: string | null = null;
  private resumeFrom: string | undefined;
  private snapshotDelivered = false;
  private pendingResync: WatchResyncReason | null = null;
  private notified = false;
  private wake: (() => void) | null = null;
  private retryDelayMs: number;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly source: PostgresWatchSource<A>,
    private readonly listener: WatchListener<A>,
    private readonly options: PostgresWatchOptions,
  ) {
    this.resumeFrom = options.resumeFrom;
    this.retryDelayMs = options.timing.initialRetryDelayMs;
    this.closed = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve;
      this.rejectClosed = reject;
    });
    this.unsubscribe = options.notifications.subscribe(source.aggregate, () => this.notify());
    void this.run();
  }

  close(): Promise<void> {
    this.stopping = true;
    this.notify();
    return this.closed;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    if (wake === null) this.notified = true;
    else wake();
  }

  private sleep(ms: number): Promise<void> {
    if (this.notified || this.stopping) {
      this.notified = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async step(): Promise<number | null> {
    try {
      if (this.cursor === null) await this.snapshot();
      else await this.poll();
      this.retryDelayMs = this.options.timing.initialRetryDelayMs;
      return this.cursor === null ? null : this.options.timing.pollIntervalMs;
    } catch (error) {
      if (error instanceof ListenerFailure) throw error;
      if (this.stopping) return null;
      await this.report(new BackendFailureError("postgresql", this.source.operation, { cause: error }));
      if (this.snapshotDelivered) {
        this.pendingResync = "backend-restart";
        this.cursor = null;
      }
      const delay = this.retryDelayMs;
      this.retryDelayMs = Math.min(delay * 2, this.options.timing.maxRetryDelayMs);
      return delay;
    }
  }

  private async run(): Promise<void> {
    let failure: { readonly error: unknown } | null = null;
    try {
      while (!this.stopping) {
        const delay = await this.step();
        if (delay !== null) await this.sleep(delay);
      }
    } catch (error) {
      failure = { error: error instanceof ListenerFailure ? error.cause : error };
    } finally {
      this.stopping = true;
      this.wake = null;
      this.unsubscribe();
      this.options.onSettled();
      if (failure === null) this.resolveClosed();
      else this.rejectClosed(failure.error);
    }
  }

  private async deliver(event: WatchEvent<A>): Promise<void> {
    if (this.stopping) return;
    try {
      await this.listener.onEvent(event);
    } catch (error) {
      throw new ListenerFailure(error);
    }
  }

  private async report(error: PlatformStateError): Promise<void> {
    if (this.stopping) return;
    try {
      this.listener.onError(error);
    } catch (listenerError) {
      throw new ListenerFailure(listenerError);
    }
  }

  private async decodeRows(rows: readonly Row[]): Promise<Map<string, Stored<WatchRecords[A]>>> {
    const records = new Map<string, Stored<WatchRecords[A]>>();
    for (const row of rows) {
      try {
        records.set(this.source.keyOf(row), this.source.decode(row));
      } catch (error) {
        if (!isPlatformStateError(error)) throw error;
        await this.report(error);
      }
    }
    return records;
  }

  private async resumeCheck(query: SnapshotQuery, resumeFrom: string | undefined): Promise<WatchResyncReason | null> {
    if (resumeFrom === undefined) return null;
    if (!XID8_TEXT.test(resumeFrom) || BigInt(resumeFrom) > XID8_MAX) return "cursor-expired";
    const [state] = await query(
      `SELECT s.horizon < $1::xid8 AS ahead,
              COALESCE((SELECT purged_through >= $1::xid8 FROM $schema.change_log_retention), false) AS expired
         FROM (${HORIZON}) s`,
      [resumeFrom],
    );
    if (state.expired === true) return "cursor-expired";
    if (state.ahead === true) return "backend-restart";
    return null;
  }

  private async snapshot(): Promise<void> {
    const resumeFrom = this.resumeFrom;
    const read = await withReadSnapshot(this.options.context, this.source.operation, async (query) => {
      const [head] = await query(`SELECT horizon::text AS horizon FROM (${HORIZON}) s`);
      const resync = await this.resumeCheck(query, resumeFrom);
      const parameters = new SqlParameters();
      const rows = await query(this.source.selectAll(parameters), parameters.values);
      return { horizon: head.horizon as string, resync, rows };
    });
    this.resumeFrom = undefined;
    const records = await this.decodeRows(read.rows);
    const resync = this.pendingResync ?? read.resync;
    this.pendingResync = null;
    if (resync !== null) await this.deliver({ kind: "resync", reason: resync });
    this.known = new Map([...records].map(([key, record]) => [key, JSON.stringify(record)]));
    this.cursor = read.horizon;
    this.snapshotDelivered = true;
    await this.deliver({ kind: "snapshot", records: [...records.values()], cursor: read.horizon as WatchCursor });
  }

  private candidateKeys(entries: readonly Row[]): string[] {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = entry.record_key as string;
      if (seen.has(key)) continue;
      const filterKeys = JSON.parse(entry.filter_keys as string) as FilterKeys;
      if (!this.known.has(key) && !this.source.mayMatch(filterKeys)) continue;
      seen.add(key);
      keys.push(key);
    }
    return keys;
  }

  private async poll(): Promise<void> {
    const cursor = this.cursor as string;
    const result = await withReadSnapshot<PollResult>(this.options.context, this.source.operation, async (query) => {
      const [head] = await query(
        `SELECT s.horizon::text AS horizon,
                s.horizon < $1::xid8 AS regressed,
                COALESCE((SELECT purged_through >= $1::xid8 FROM $schema.change_log_retention), false) AS expired
           FROM (${HORIZON}) s`,
        [cursor],
      );
      if (head.expired === true) return { resync: "cursor-expired" };
      if (head.regressed === true) return { resync: "backend-restart" };
      const horizon = head.horizon as string;
      if (horizon === cursor) return { horizon, keys: [], rows: [] };
      const recordKey = this.source.recordKey;
      const entries = await query(
        `SELECT record_key, filter_keys FROM $schema.change_log
          WHERE aggregate = $1::text AND txid >= $2::xid8 AND txid < $3::xid8${recordKey === undefined ? "" : " AND record_key = $4::text"}
          ORDER BY txid, seq`,
        recordKey === undefined ? [this.source.aggregate, cursor, horizon] : [this.source.aggregate, cursor, horizon, recordKey],
      );
      const keys = this.candidateKeys(entries);
      if (keys.length === 0) return { horizon, keys, rows: [] };
      const parameters = new SqlParameters();
      return { horizon, keys, rows: await query(this.source.selectKeys(keys, parameters), parameters.values) };
    });
    if (result.resync !== undefined) {
      this.pendingResync = result.resync;
      this.cursor = null;
      return;
    }
    const current = await this.decodeRows(result.rows ?? []);
    const changes: WatchChange<A>[] = [];
    for (const key of result.keys ?? []) {
      const record = current.get(key);
      if (record !== undefined) {
        const state = JSON.stringify(record);
        if (this.known.get(key) === state) continue;
        changes.push({ type: this.known.has(key) ? "modified" : "added", key, record });
        this.known.set(key, state);
      } else if (this.known.delete(key)) {
        changes.push({ type: "removed", key, record: null });
      }
    }
    const horizon = result.horizon as string;
    this.cursor = horizon;
    if (changes.length > 0) await this.deliver({ kind: "changes", changes, cursor: horizon as WatchCursor });
  }
}

export function watchPostgres<A extends WatchAggregate>(
  source: PostgresWatchSource<A>,
  listener: WatchListener<A>,
  options: PostgresWatchOptions,
): WatchSubscription {
  return new PostgresWatch(source, listener, options);
}
