import { createHash } from "node:crypto";
import type pg from "pg";
import { publicKeyIdentity } from "@octogee/core/gitea-naming";
import {
  GIT_KEY_CONDITION_TYPES,
  USER_PROVISIONING_CONDITION_TYPES,
  type GitKey,
  type GitKeyConditionType,
  type GitKeyHolderSummary,
  type GitKeyRelease,
  type GitKeySpec,
  type ProvisioningAttempt,
  type ProvisioningCondition,
  type ProvisioningConditionReason,
  type ProvisioningWorkState,
  type UserProvisioning,
  type UserProvisioningConditionType,
  type UserProvisioningDeletion,
  type UserProvisioningListQuery,
  type UserProvisioningOutputs,
  type UserProvisioningSpec,
} from "@octogee/shared/types/provisioning-service";
import { ApiError } from "../http/errors.js";
import { pendingConditions } from "../resources/conditions.js";
import { sameJson, type GitKeyHolder } from "../resources/validate.js";
import type { Database } from "./database.js";

export const DEFAULT_CHANGE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_WINDOW = "24 hours";

interface ProvisioningRow {
  uid: string;
  generation: number;
  resource_version: string;
  spec: UserProvisioningSpec;
  observed_generation: number;
  conditions: ProvisioningCondition<UserProvisioningConditionType>[];
  outputs: Omit<UserProvisioningOutputs, "credentials">;
  state: ProvisioningWorkState;
  due_at: Date;
  attempts: number;
  last_attempt_at: Date | null;
  lease_expires_at: Date | null;
  credential_names: string[] | null;
}

interface GitKeyRow {
  uid: string;
  gateway_id: string;
  holder: string;
  updated_at: Date;
  generation: number;
  resource_version: string;
  public_key: string;
  registered_public_key: string | null;
  deletion_requested_at: Date | null;
  observed_generation: number;
  conditions: ProvisioningCondition<GitKeyConditionType>[];
  refusals: number;
  retry_after: Date | null;
  adopt_requested: boolean;
}

export type WriteOutcome = "created" | "changed" | "unchanged";

export interface PageResult {
  items: UserProvisioning[];
  resourceVersion: string;
  nextPageToken?: string;
}

export type ChangesSince =
  | { kind: "expired" }
  | { kind: "changes"; items: UserProvisioning[]; deleted: UserProvisioningDeletion[]; resourceVersion: string };

export type RetryOutcome =
  | { kind: "retried"; resource: UserProvisioning }
  | { kind: "replayed"; status: number; body: unknown };

export function toResource(row: ProvisioningRow): UserProvisioning {
  const dueShown = row.state === "queued" || row.state === "retrying" || row.state === "idle";
  return {
    uid: row.uid,
    generation: row.generation,
    resourceVersion: String(row.resource_version),
    spec: row.spec,
    status: {
      observedGeneration: row.observed_generation,
      conditions: row.conditions,
      outputs: { ...row.outputs, credentials: [...(row.credential_names ?? [])].sort() as UserProvisioningOutputs["credentials"] },
      work: {
        state: row.state,
        attempts: row.attempts,
        nextAttemptAt: dueShown ? row.due_at.toISOString() : null,
        lastAttemptAt: row.last_attempt_at ? row.last_attempt_at.toISOString() : null,
      },
    },
  };
}

export function toGitKey(row: GitKeyRow): GitKey {
  return {
    uid: row.uid,
    gatewayId: row.gateway_id,
    holder: row.holder,
    generation: row.generation,
    resourceVersion: String(row.resource_version),
    deletionRequestedAt: row.deletion_requested_at ? row.deletion_requested_at.toISOString() : null,
    spec: { publicKey: row.public_key },
    status: {
      observedGeneration: row.observed_generation,
      conditions: row.conditions,
      nextAttemptAt: row.retry_after ? row.retry_after.toISOString() : null,
    },
  };
}

function whereClause(conditions: string[]): string {
  return conditions.length ? "WHERE " + conditions.join(" AND ") : "";
}

function encodePageToken(uid: string): string {
  return Buffer.from(JSON.stringify({ after: uid })).toString("base64url");
}

function decodePageToken(token: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { after?: unknown };
    if (typeof parsed.after === "string") return parsed.after;
  } catch {
    throw new ApiError(400, "invalid-request", "pageToken is not valid");
  }
  throw new ApiError(400, "invalid-request", "pageToken is not valid");
}

export class ProvisioningStore {
  constructor(readonly db: Database, readonly changeRetentionMs: number = DEFAULT_CHANGE_RETENTION_MS) {}

  private get selectResource(): string {
    const t = this.db.table;
    return `SELECT p.uid, p.generation, p.resource_version, p.spec, p.observed_generation, p.conditions, p.outputs,
        w.state, w.due_at, w.attempts, w.last_attempt_at, w.lease_expires_at,
        (SELECT array_agg(c.name ORDER BY c.name) FROM ${t("credentials")} c WHERE c.uid = p.uid) AS credential_names
      FROM ${t("provisionings")} p JOIN ${t("provisioning_work")} w ON w.uid = p.uid`;
  }

  async readResource(client: pg.ClientBase, uid: string): Promise<UserProvisioning | null> {
    const { rows } = await client.query<ProvisioningRow>(`${this.selectResource} WHERE p.uid = $1`, [uid]);
    return rows[0] ? toResource(rows[0]) : null;
  }

  async get(uid: string): Promise<UserProvisioning | null> {
    return this.readResource(this.db.pool as unknown as pg.ClientBase, uid);
  }

  async put(uid: string, spec: UserProvisioningSpec, expectedResourceVersion: string | undefined): Promise<{ outcome: WriteOutcome; resource: UserProvisioning }> {
    const t = this.db.table;
    return this.db.write(async (client, bumpVersion) => {
      const { rows } = await client.query<{ resource_version: string; generation: number; spec: UserProvisioningSpec }>(
        `SELECT resource_version, generation, spec FROM ${t("provisionings")} WHERE uid = $1 FOR UPDATE`, [uid]);
      const current = rows[0];
      if (expectedResourceVersion !== undefined && current?.resource_version !== expectedResourceVersion) {
        throw new ApiError(409, "precondition-failed", "expectedResourceVersion no longer holds");
      }
      if (current && sameJson(current.spec, spec)) {
        return { outcome: "unchanged" as const, resource: (await this.readResource(client, uid))! };
      }
      const version = await bumpVersion(uid);
      if (!current) {
        await client.query(
          `INSERT INTO ${t("provisionings")} (uid, generation, resource_version, spec, conditions, outputs) VALUES ($1, 1, $2, $3, $4, '{}'::jsonb)`,
          [uid, version.toString(), JSON.stringify(spec), JSON.stringify(pendingConditions(USER_PROVISIONING_CONDITION_TYPES, new Date()))]);
        await client.query(`INSERT INTO ${t("provisioning_work")} (uid, state, due_at) VALUES ($1, 'queued', now())`, [uid]);
        return { outcome: "created" as const, resource: (await this.readResource(client, uid))! };
      }
      await client.query(`UPDATE ${t("provisionings")} SET generation = generation + 1, resource_version = $2, spec = $3 WHERE uid = $1`,
        [uid, version.toString(), JSON.stringify(spec)]);
      await this.makeDue(client, uid);
      return { outcome: "changed" as const, resource: (await this.readResource(client, uid))! };
    });
  }

  private async makeDue(client: pg.ClientBase, uid: string): Promise<void> {
    await client.query(
      `UPDATE ${this.db.table("provisioning_work")}
         SET dirty = (state = 'running'),
             state = CASE WHEN state = 'running' THEN state ELSE 'queued' END,
             attempts = CASE WHEN state = 'running' THEN attempts ELSE 0 END,
             due_at = CASE WHEN state = 'running' THEN due_at ELSE now() END
       WHERE uid = $1`, [uid]);
  }

  private async makeIdleWorkDue(client: pg.ClientBase, uid: string): Promise<void> {
    await client.query(`UPDATE ${this.db.table("provisioning_work")} SET state = 'queued', due_at = now() WHERE uid = $1 AND state = 'idle'`, [uid]);
  }

  private async makeKeyWorkDue(client: pg.ClientBase, uid: string): Promise<void> {
    await client.query(
      `UPDATE ${this.db.table("provisioning_work")}
         SET dirty = dirty OR (state = 'running' AND NOT release_only),
             state = CASE WHEN state IN ('running', 'parked') THEN state ELSE 'queued' END,
             due_at = CASE WHEN state IN ('running', 'parked') THEN due_at ELSE now() END
       WHERE uid = $1`, [uid]);
  }

  async delete(uid: string): Promise<void> {
    const t = this.db.table;
    await this.db.write(async (client, bumpVersion) => {
      const { rows } = await client.query<{ running: boolean }>(
        `SELECT (w.state = 'running' AND w.lease_expires_at > now()) AS running
           FROM ${t("provisionings")} p JOIN ${t("provisioning_work")} w ON w.uid = p.uid WHERE p.uid = $1 FOR UPDATE OF p`, [uid]);
      if (!rows[0]) return;
      if (rows[0].running) throw new ApiError(409, "work-running", "an attempt is running for this user; ask again when it finishes");
      await client.query(`DELETE FROM ${t("provisionings")} WHERE uid = $1`, [uid]);
      const version = await bumpVersion(uid);
      await client.query(`INSERT INTO ${t("deletions")} (resource_version, uid) VALUES ($1, $2)`, [version.toString(), uid]);
    });
  }

  async retry(uid: string, expectedAttempts: number | undefined, idempotencyKey: string | undefined): Promise<RetryOutcome> {
    const t = this.db.table;
    const requestHash = createHash("sha256").update(JSON.stringify({ uid, expectedAttempts: expectedAttempts ?? null })).digest("hex");
    return this.db.write(async (client, bumpVersion) => {
      if (idempotencyKey !== undefined) {
        await client.query(`DELETE FROM ${t("idempotency")} WHERE created_at < now() - interval '${IDEMPOTENCY_WINDOW}'`);
        const { rows } = await client.query<{ request_hash: string; status: number; body: unknown }>(
          `SELECT request_hash, status, body FROM ${t("idempotency")} WHERE key = $1`, [idempotencyKey]);
        if (rows[0]) {
          if (rows[0].request_hash !== requestHash) throw new ApiError(409, "idempotency-conflict", "this Idempotency-Key was used with a different request");
          return { kind: "replayed" as const, status: rows[0].status, body: rows[0].body };
        }
      }
      const { rows } = await client.query<{ state: ProvisioningWorkState; attempts: number; release_only: boolean }>(
        `SELECT w.state, w.attempts, w.release_only FROM ${t("provisionings")} p JOIN ${t("provisioning_work")} w ON w.uid = p.uid WHERE p.uid = $1 FOR UPDATE OF p, w`, [uid]);
      const work = rows[0];
      if (!work) throw new ApiError(404, "not-found", "no provisioning for this user");
      if (expectedAttempts !== undefined && work.attempts !== expectedAttempts) {
        throw new ApiError(409, "precondition-failed", `expectedAttempts is ${expectedAttempts}; attempts is ${work.attempts}`);
      }
      const releasingParked = work.state === "running" && work.release_only;
      if (work.state !== "parked" && work.state !== "retrying" && !releasingParked) {
        throw new ApiError(409, "not-retryable", `work is ${work.state}; only parked or retrying work can be retried`);
      }
      const version = await bumpVersion(uid);
      await client.query(releasingParked
        ? `UPDATE ${t("provisioning_work")} SET dirty = true WHERE uid = $1`
        : `UPDATE ${t("provisioning_work")} SET state = 'queued', due_at = now(), attempts = CASE WHEN state = 'parked' THEN 0 ELSE attempts END WHERE uid = $1`, [uid]);
      await client.query(`UPDATE ${t("provisionings")} SET resource_version = $2 WHERE uid = $1`, [uid, version.toString()]);
      const resource = (await this.readResource(client, uid))!;
      if (idempotencyKey !== undefined) {
        await client.query(`INSERT INTO ${t("idempotency")} (key, request_hash, status, body) VALUES ($1, $2, 202, $3)`,
          [idempotencyKey, requestHash, JSON.stringify(resource)]);
      }
      return { kind: "retried" as const, resource };
    });
  }

  async list(query: UserProvisioningListQuery): Promise<PageResult> {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.pageToken !== undefined) {
      params.push(decodePageToken(query.pageToken));
      where.push(`p.uid > $${params.length}`);
    }
    if (query.ready !== undefined) {
      where.push(`${query.ready ? "" : "NOT "}EXISTS (SELECT 1 FROM jsonb_array_elements(p.conditions) c WHERE c->>'type' = 'Ready' AND c->>'status' = 'True')`);
    }
    if (query.reason !== undefined) {
      params.push(query.reason);
      where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(p.conditions) c WHERE c->>'reason' = $${params.length})`);
    }
    if (query.workState !== undefined) {
      params.push(query.workState);
      where.push(`w.state = $${params.length}`);
    }
    params.push(limit + 1);
    return this.db.read(async (client) => {
      const counter = await client.query<{ value: string }>(`SELECT value FROM ${this.db.table("counter")} WHERE id = 1`);
      const { rows } = await client.query<ProvisioningRow>(
        `${this.selectResource} ${whereClause(where)} ORDER BY p.uid LIMIT $${params.length}`, params);
      const page = rows.slice(0, limit).map(toResource);
      return {
        items: page,
        resourceVersion: String(counter.rows[0].value),
        ...(rows.length > limit ? { nextPageToken: encodePageToken(page[page.length - 1].uid) } : {}),
      };
    });
  }

  async changesSince(resourceVersion: bigint, limit: number): Promise<ChangesSince> {
    return this.db.read(async (client) => {
      const counter = await client.query<{ value: string; pruned_through: string }>(
        `SELECT value, pruned_through FROM ${this.db.table("counter")} WHERE id = 1`);
      const current = BigInt(counter.rows[0].value);
      if (resourceVersion < BigInt(counter.rows[0].pruned_through) || resourceVersion > current) return { kind: "expired" as const };
      const live = await client.query<ProvisioningRow>(
        `${this.selectResource} WHERE p.resource_version > $1 ORDER BY p.resource_version LIMIT $2`, [resourceVersion.toString(), limit + 1]);
      const gone = await client.query<{ uid: string; resource_version: string }>(
        `SELECT uid, resource_version FROM ${this.db.table("deletions")} WHERE resource_version > $1 ORDER BY resource_version LIMIT $2`,
        [resourceVersion.toString(), limit + 1]);
      const changes = [
        ...live.rows.map((row) => ({ version: BigInt(row.resource_version), item: toResource(row) })),
        ...gone.rows.map((row) => ({ version: BigInt(row.resource_version), deletion: { uid: row.uid, resourceVersion: String(row.resource_version) } })),
      ].sort((a, b) => (a.version < b.version ? -1 : 1));
      const page = changes.slice(0, limit);
      const items = page.flatMap((change) => ("item" in change ? [change.item] : []));
      const deleted = page.flatMap((change) => ("deletion" in change ? [change.deletion] : []));
      const through = changes.length > limit ? page[page.length - 1].version.toString() : current.toString();
      return { kind: "changes" as const, items, deleted, resourceVersion: through };
    });
  }

  async pruneChangeLog(): Promise<number> {
    const t = this.db.table;
    return this.db.write(async (client) => {
      const { rows } = await client.query<{ through: string | null; count: string }>(
        `WITH gone AS (DELETE FROM ${t("version_log")} WHERE written_at < now() - make_interval(secs => $1) RETURNING version)
         SELECT max(version) AS through, count(*) AS count FROM gone`, [this.changeRetentionMs / 1_000]);
      if (rows[0].through !== null) {
        await client.query(`UPDATE ${t("counter")} SET pruned_through = GREATEST(pruned_through, $1) WHERE id = 1`, [rows[0].through]);
        await client.query(`DELETE FROM ${t("deletions")} WHERE resource_version <= $1`, [rows[0].through]);
      }
      return Number(rows[0].count);
    });
  }

  async events(uid: string): Promise<ProvisioningAttempt[] | null> {
    const t = this.db.table;
    return this.db.read(async (client) => {
      const exists = await client.query(`SELECT 1 FROM ${t("provisionings")} WHERE uid = $1`, [uid]);
      if (exists.rowCount === 0) return null;
      const { rows } = await client.query<{ generation: number; started_at: Date; finished_at: Date; result: ProvisioningAttempt["result"]; reason: ProvisioningConditionReason | null; steps: ProvisioningAttempt["steps"] }>(
        `SELECT generation, started_at, finished_at, result, reason, steps FROM ${t("attempts")} WHERE uid = $1 ORDER BY id DESC LIMIT 50`, [uid]);
      return rows.map((row) => ({
        generation: row.generation,
        startedAt: row.started_at.toISOString(),
        finishedAt: row.finished_at.toISOString(),
        durationMs: row.finished_at.getTime() - row.started_at.getTime(),
        result: row.result,
        ...(row.reason ? { reason: row.reason } : {}),
        steps: row.steps,
      }));
    });
  }

  async putGitKey(uid: string, { holder, gatewayId }: GitKeyHolder, spec: GitKeySpec): Promise<{ outcome: WriteOutcome; key: GitKey }> {
    const t = this.db.table;
    return this.db.write(async (client, bumpVersion) => {
      const owner = await client.query(`SELECT 1 FROM ${t("provisionings")} WHERE uid = $1 FOR UPDATE`, [uid]);
      if (owner.rowCount === 0) throw new ApiError(404, "not-found", "no provisioning for this user");
      const { rows } = await client.query<GitKeyRow & { retry_due: boolean }>(
        `SELECT *, (retry_after IS NULL OR retry_after <= now()) AS retry_due FROM ${t("git_keys")} WHERE uid = $1 AND holder = $2 FOR UPDATE`, [uid, holder]);
      const current = rows[0];
      if (current && current.public_key === spec.publicKey && current.deletion_requested_at === null) {
        await client.query(`UPDATE ${t("git_keys")} SET updated_at = now(), adopt_requested = true WHERE uid = $1 AND holder = $2`, [uid, holder]);
        if (current.retry_due) await this.makeIdleWorkDue(client, uid);
        return { outcome: "unchanged" as const, key: toGitKey(current) };
      }
      const keyVersion = await bumpVersion(uid);
      const userVersion = await bumpVersion(uid);
      let written: GitKeyRow;
      if (!current) {
        written = (await client.query<GitKeyRow>(
          `INSERT INTO ${t("git_keys")} (uid, gateway_id, holder, generation, resource_version, public_key, conditions, adopt_requested) VALUES ($1, $2, $3, 1, $4, $5, $6, true) RETURNING *`,
          [uid, gatewayId, holder, keyVersion.toString(), spec.publicKey, JSON.stringify(pendingConditions(GIT_KEY_CONDITION_TYPES, new Date()))])).rows[0];
      } else {
        written = (await client.query<GitKeyRow>(
          `UPDATE ${t("git_keys")} SET generation = generation + 1, resource_version = $3, public_key = $4, deletion_requested_at = NULL,
              refusals = 0, retry_after = NULL, updated_at = now(), adopt_requested = true
            WHERE uid = $1 AND holder = $2 RETURNING *`, [uid, holder, keyVersion.toString(), spec.publicKey])).rows[0];
      }
      await client.query(`UPDATE ${t("provisionings")} SET resource_version = $2 WHERE uid = $1`, [uid, userVersion.toString()]);
      await this.makeKeyWorkDue(client, uid);
      return { outcome: current ? "changed" as const : "created" as const, key: toGitKey(written) };
    });
  }

  async deleteGitKey(uid: string, holder: string, expectedPublicKey: string | null): Promise<void> {
    const t = this.db.table;
    await this.db.write(async (client, bumpVersion) => {
      await client.query(`SELECT 1 FROM ${t("provisionings")} WHERE uid = $1 FOR UPDATE`, [uid]);
      const { rows } = await client.query<GitKeyRow>(
        `SELECT * FROM ${t("git_keys")} WHERE uid = $1 AND holder = $2 FOR UPDATE`, [uid, holder]);
      if (!rows[0] || rows[0].deletion_requested_at !== null) return;
      if (expectedPublicKey !== null && publicKeyIdentity(rows[0].public_key) !== publicKeyIdentity(expectedPublicKey)) {
        throw new ApiError(409, "precondition-failed", "the git key now holds another public key");
      }
      await this.markKeyForRelease(client, bumpVersion, uid, "holder", holder);
    });
  }

  private async markKeyForRelease(
    client: pg.PoolClient,
    bumpVersion: (uid: string) => Promise<bigint>,
    uid: string,
    column: "holder" | "gateway_id",
    value: string,
  ): Promise<void> {
    const t = this.db.table;
    const keyVersion = await bumpVersion(uid);
    const userVersion = await bumpVersion(uid);
    await client.query(
      `UPDATE ${t("git_keys")} SET deletion_requested_at = now(), resource_version = $3, updated_at = now()
        WHERE uid = $1 AND ${column} = $2 AND deletion_requested_at IS NULL`, [uid, value, keyVersion.toString()]);
    await client.query(`UPDATE ${t("provisionings")} SET resource_version = $2 WHERE uid = $1`, [uid, userVersion.toString()]);
    await this.makeKeyWorkDue(client, uid);
  }

  async releaseGitKeys(column: "holder" | "gateway_id", value: string): Promise<GitKeyRelease> {
    const t = this.db.table;
    return this.db.write(async (client, bumpVersion) => {
      const { rows: users } = await client.query<{ uid: string }>(
        `SELECT DISTINCT uid FROM ${t("git_keys")} WHERE ${column} = $1 AND deletion_requested_at IS NULL ORDER BY uid`, [value]);
      for (const { uid } of users) {
        await client.query(`SELECT 1 FROM ${t("provisionings")} WHERE uid = $1 FOR UPDATE`, [uid]);
        const held = await client.query(
          `SELECT 1 FROM ${t("git_keys")} WHERE uid = $1 AND ${column} = $2 AND deletion_requested_at IS NULL FOR UPDATE`, [uid, value]);
        if (held.rowCount === 0) continue;
        await this.markKeyForRelease(client, bumpVersion, uid, column, value);
      }
      const { rows } = await client.query<{ remaining: string }>(
        `SELECT count(*) AS remaining FROM ${t("git_keys")} WHERE ${column} = $1`, [value]);
      return { remaining: Number(rows[0].remaining) };
    });
  }

  async listGitKeyHolders(): Promise<GitKeyHolderSummary[]> {
    const { rows } = await this.db.pool.query<{ holder: string; gateway_id: string; rows: string; newest: Date }>(
      `SELECT holder, min(gateway_id) AS gateway_id, count(*) AS rows, max(updated_at) AS newest
         FROM ${this.db.table("git_keys")} GROUP BY holder ORDER BY holder`);
    return rows.map((row) => ({ holder: row.holder, gatewayId: row.gateway_id, rows: Number(row.rows), newestUpdatedAt: row.newest.toISOString() }));
  }
}

export type { GitKeyRow, ProvisioningRow };
