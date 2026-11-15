import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  ProvisioningAttempt,
  ProvisioningCondition,
  ProvisioningConditionReason,
  ProvisioningWorkState,
  UserProvisioningConditionType,
} from "@octogee/shared/types/provisioning-service";
import { LeaseLostError } from "../hosts/credential-store.js";
import type { HostErrorKind } from "../hosts/host-error.js";
import type { Logger } from "../logger.js";
import type { Database } from "../store/database.js";

export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
export const MAX_TRANSIENT_ATTEMPTS = 12;
export const RESYNC_AFTER_MS = 6 * 60 * 60 * 1_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 10 * 60 * 1_000;

export function backoffMs(failedAttempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(failedAttempts - 1, 0);
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.min(exponent, 20), BACKOFF_CAP_MS);
  return Math.round(base * (0.8 + 0.4 * random()));
}

export interface Claim {
  uid: string;
  leaseToken: string;
  takeover: boolean;
  claimedAt: number;
}

export type AttemptOutcome =
  | { kind: "succeeded" }
  | { kind: "failed"; errorKind: HostErrorKind; reason: ProvisioningConditionReason; message: string };

export interface FinishInput {
  generation: number;
  conditions: ProvisioningCondition<UserProvisioningConditionType>[];
  attempt: Omit<ProvisioningAttempt, "result" | "durationMs">;
  outcome: AttemptOutcome;
}

export interface FinishResult {
  state: ProvisioningWorkState;
  attempts: number;
}

export interface QueueOptions {
  holder: string;
  log: Logger;
  leaseMs?: number;
  resyncAfterMs?: number;
  random?: () => number;
}

export class WorkQueue {
  readonly leaseMs: number;
  private readonly resyncAfterMs: number;
  private readonly random: () => number;

  constructor(private readonly db: Database, private readonly options: QueueOptions) {
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.resyncAfterMs = options.resyncAfterMs ?? RESYNC_AFTER_MS;
    this.random = options.random ?? Math.random;
  }

  async claim(limit: number): Promise<Claim[]> {
    if (limit <= 0) return [];
    const t = this.db.table;
    const claimedAt = Date.now();
    return this.db.write(async (client, bumpVersion) => {
      const { rows } = await client.query<{ uid: string; state: ProvisioningWorkState; attempts: number; generation: number }>(
        `SELECT w.uid, w.state, w.attempts, p.generation FROM ${t("provisioning_work")} w JOIN ${t("provisionings")} p ON p.uid = w.uid
          WHERE w.due_at <= now()
            AND (w.state IN ('queued', 'retrying', 'idle') OR (w.state = 'running' AND w.lease_expires_at < now()))
          ORDER BY w.due_at LIMIT $1 FOR UPDATE OF w SKIP LOCKED`, [limit]);
      const claims: Claim[] = [];
      for (const row of rows) {
        const takeover = row.state === "running";
        if (takeover && row.attempts + 1 >= MAX_TRANSIENT_ATTEMPTS) {
          await this.parkUnfinished(client, row, await bumpVersion(row.uid));
          continue;
        }
        const leaseToken = randomUUID();
        await client.query(
          `UPDATE ${t("provisioning_work")}
              SET state = 'running', lease_holder = $2, lease_token = $3, lease_expires_at = now() + make_interval(secs => $4),
                  attempts = attempts + $5, dirty = false, last_attempt_at = now()
            WHERE uid = $1`, [row.uid, this.options.holder, leaseToken, this.leaseMs / 1_000, takeover ? 1 : 0]);
        const version = await bumpVersion(row.uid);
        await client.query(`UPDATE ${t("provisionings")} SET resource_version = $2 WHERE uid = $1`, [row.uid, version.toString()]);
        claims.push({ uid: row.uid, leaseToken, takeover, claimedAt });
      }
      return claims;
    });
  }

  private async parkUnfinished(client: pg.PoolClient, row: { uid: string; attempts: number; generation: number }, version: bigint): Promise<void> {
    const t = this.db.table;
    const attempts = row.attempts + 1;
    await client.query(
      `UPDATE ${t("provisioning_work")}
          SET state = 'parked', attempts = $2, dirty = false, lease_holder = NULL, lease_token = NULL, lease_expires_at = NULL,
              last_error_reason = NULL, last_error_message = 'attempts repeatedly ended without finishing'
        WHERE uid = $1`, [row.uid, attempts]);
    await client.query(`UPDATE ${t("provisionings")} SET resource_version = $2 WHERE uid = $1`, [row.uid, version.toString()]);
    const now = new Date().toISOString();
    await this.recordAttempt(client, row.uid, { generation: row.generation, startedAt: now, finishedAt: now, result: "parked", steps: [] });
    this.options.log.error("provisioning work parked at claim after repeated unfinished attempts", { uid: row.uid, attempts });
  }

  async heartbeat(uid: string, leaseToken: string): Promise<boolean> {
    const result = await this.db.pool.query(
      `UPDATE ${this.db.table("provisioning_work")} SET lease_expires_at = now() + make_interval(secs => $3)
        WHERE uid = $1 AND lease_token = $2 AND state = 'running'`, [uid, leaseToken, this.leaseMs / 1_000]);
    return result.rowCount === 1;
  }

  async fenced<T>(uid: string, leaseToken: string, work: (client: pg.PoolClient, bumpVersion: () => Promise<bigint>) => Promise<T>): Promise<T> {
    const t = this.db.table;
    return this.db.write(async (client, bumpVersion) => {
      await client.query(`SELECT 1 FROM ${t("provisionings")} WHERE uid = $1 FOR UPDATE`, [uid]);
      const lease = await client.query(
        `SELECT 1 FROM ${t("provisioning_work")} WHERE uid = $1 AND lease_token = $2 AND state = 'running' FOR UPDATE`, [uid, leaseToken]);
      if (lease.rowCount === 0) throw new LeaseLostError(uid);
      return work(client, () => bumpVersion(uid));
    });
  }

  async finish(uid: string, leaseToken: string, input: FinishInput): Promise<FinishResult> {
    const t = this.db.table;
    return this.fenced(uid, leaseToken, async (client, bumpVersion) => {
      const { rows } = await client.query<{ attempts: number; dirty: boolean }>(
        `SELECT attempts, dirty FROM ${t("provisioning_work")} WHERE uid = $1`, [uid]);
      const { attempts, dirty } = rows[0];
      let next: FinishResult & { delayMs: number; errorReason: string | null; errorMessage: string | null };
      if (input.outcome.kind === "succeeded") {
        next = { state: dirty ? "queued" : "idle", attempts: 0, delayMs: dirty ? 0 : this.resyncAfterMs, errorReason: null, errorMessage: null };
      } else {
        const failed = attempts + 1;
        const error = { errorReason: input.outcome.reason, errorMessage: input.outcome.message };
        if (dirty) next = { state: "queued", attempts: 0, delayMs: 0, ...error };
        else if (input.outcome.errorKind === "terminal" || failed >= MAX_TRANSIENT_ATTEMPTS) next = { state: "parked", attempts: failed, delayMs: 0, ...error };
        else next = { state: "retrying", attempts: failed, delayMs: backoffMs(failed, this.random), ...error };
      }
      await client.query(
        `UPDATE ${t("provisioning_work")}
            SET state = $2, attempts = $3, due_at = now() + make_interval(secs => $4), dirty = false,
                lease_holder = NULL, lease_token = NULL, lease_expires_at = NULL,
                last_error_reason = $5, last_error_message = $6,
                last_success_at = CASE WHEN $7 THEN now() ELSE last_success_at END
          WHERE uid = $1`,
        [uid, next.state, next.attempts, next.delayMs / 1_000, next.errorReason, next.errorMessage, input.outcome.kind === "succeeded"]);
      const version = await bumpVersion();
      await client.query(
        `UPDATE ${t("provisionings")} SET resource_version = $2, observed_generation = $3, conditions = $4 WHERE uid = $1`,
        [uid, version.toString(), input.generation, JSON.stringify(input.conditions)]);
      let result: ProvisioningAttempt["result"] = "failed";
      if (input.outcome.kind === "succeeded") result = "succeeded";
      else if (next.state === "parked") result = "parked";
      await this.recordAttempt(client, uid, { ...input.attempt, result });
      return { state: next.state, attempts: next.attempts };
    });
  }

  async recordLeaseLost(uid: string, attempt: Omit<ProvisioningAttempt, "result" | "durationMs">): Promise<void> {
    await this.db.write(async (client) => {
      const exists = await client.query(`SELECT 1 FROM ${this.db.table("provisionings")} WHERE uid = $1`, [uid]);
      if (exists.rowCount === 1) await this.recordAttempt(client, uid, { ...attempt, result: "lease-lost" });
    });
  }

  private async recordAttempt(client: pg.PoolClient, uid: string, attempt: Omit<ProvisioningAttempt, "durationMs">): Promise<void> {
    const t = this.db.table;
    await client.query(
      `INSERT INTO ${t("attempts")} (uid, generation, started_at, finished_at, result, reason, steps) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uid, attempt.generation, attempt.startedAt, attempt.finishedAt, attempt.result, attempt.reason ?? null, JSON.stringify(attempt.steps)]);
    await client.query(
      `DELETE FROM ${t("attempts")} WHERE uid = $1 AND id NOT IN (SELECT id FROM ${t("attempts")} WHERE uid = $1 ORDER BY id DESC LIMIT 50)`, [uid]);
  }

  async snapshot(): Promise<{ states: Record<ProvisioningWorkState, number>; oldestDueSeconds: number; generationLagSeconds: number; expiredLeases: number }> {
    const t = this.db.table;
    const { rows } = await this.db.pool.query<{ state: ProvisioningWorkState; count: string }>(
      `SELECT state, count(*) AS count FROM ${t("provisioning_work")} GROUP BY state`);
    const states = { queued: 0, running: 0, retrying: 0, parked: 0, idle: 0 } satisfies Record<ProvisioningWorkState, number>;
    for (const row of rows) states[row.state] = Number(row.count);
    const aggregate = await this.db.pool.query<{ oldest_due: number | null; lag: number | null; expired: string }>(
      `SELECT
         (SELECT EXTRACT(EPOCH FROM now() - min(due_at))::float FROM ${t("provisioning_work")} WHERE state IN ('queued', 'retrying') AND due_at <= now()) AS oldest_due,
         (SELECT EXTRACT(EPOCH FROM now() - min(w.last_attempt_at))::float FROM ${t("provisioning_work")} w JOIN ${t("provisionings")} p ON p.uid = w.uid
            WHERE p.observed_generation < p.generation) AS lag,
         (SELECT count(*) FROM ${t("provisioning_work")} WHERE state = 'running' AND lease_expires_at < now()) AS expired`);
    const row = aggregate.rows[0];
    return { states, oldestDueSeconds: row.oldest_due ?? 0, generationLagSeconds: row.lag ?? 0, expiredLeases: Number(row.expired) };
  }
}
