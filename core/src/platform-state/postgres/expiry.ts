import type { PlatformAggregate } from "../errors.js";
import type { ExpirySweepResult } from "../store.js";
import type { PostgresContext } from "./session.js";
import { runPostgresTransaction } from "./transaction.js";

export const CHANGE_LOG_RETENTION_MS = 24 * 60 * 60 * 1_000;

interface ExpiringTable {
  readonly table: string;
  readonly aggregate: PlatformAggregate;
  readonly key: string;
  readonly expiry: string;
}

const OPERATIONS: ExpiringTable = { table: "operations", aggregate: "operation", key: "id", expiry: "expire_at" };
const OPERATION_AUDITS: ExpiringTable = { table: "operation_audits", aggregate: "operation-audit", key: "id", expiry: "expire_at" };
const MODEL_BROKER_USAGE_EVENTS: ExpiringTable = {
  table: "model_broker_usage_events", aggregate: "model-broker-usage", key: "event_id", expiry: "expires_at",
};
const SUBSCRIPTION_FLOWS: ExpiringTable = {
  table: "subscription_flows", aggregate: "subscription-flow", key: "flow_id", expiry: "expire_at",
};
const CONNECT_FLOWS: ExpiringTable = {
  table: "connect_flows", aggregate: "connect-flow", key: "flow_id", expiry: "expire_at",
};
const ACCESS_GRANTS: readonly ExpiringTable[] = [
  { table: "gateway_tickets", aggregate: "gateway-ticket", key: "ticket_id", expiry: "expires_at" },
  { table: "gateway_ticket_mint_log", aggregate: "gateway-ticket", key: "id", expiry: "expires_at" },
  { table: "control_tickets", aggregate: "control-ticket", key: "ticket_hash", expiry: "expires_at" },
  { table: "control_sessions", aggregate: "control-session", key: "session_hash", expiry: "expires_at" },
];

async function deleteExpired(context: PostgresContext, target: ExpiringTable, now: number, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  const label = `sweepExpired ${target.table}`;
  return runPostgresTransaction(context, { label }, async (session) => {
    const rows = await session.write(
      label,
      { aggregate: target.aggregate, key: "expired" },
      `DELETE FROM $schema.${target.table}
        WHERE ${target.key} IN (
          SELECT ${target.key} FROM $schema.${target.table}
           WHERE ${target.expiry} < $1::bigint
           ORDER BY ${target.expiry}
           LIMIT $2::integer)
        RETURNING 1 AS deleted`,
      [now, limit],
    );
    return rows.length;
  });
}

async function purgeChangeLog(context: PostgresContext, now: number): Promise<void> {
  const label = "sweepExpired change_log";
  await runPostgresTransaction(context, { label }, async (session) => {
    await session.execute(
      `WITH purged AS (
         DELETE FROM $schema.change_log
          WHERE committed_at < $1::bigint AND txid < pg_snapshot_xmin(pg_current_snapshot())
          RETURNING txid)
       INSERT INTO $schema.change_log_retention (id, purged_through)
       SELECT true, max(txid) FROM purged HAVING count(*) > 0
       ON CONFLICT (id) DO UPDATE
         SET purged_through = GREATEST($schema.change_log_retention.purged_through, EXCLUDED.purged_through)`,
      [now - CHANGE_LOG_RETENTION_MS],
    );
  });
}

export async function sweepExpiredPostgresState(context: PostgresContext, now: number, limit: number): Promise<ExpirySweepResult> {
  const operations = await deleteExpired(context, OPERATIONS, now, limit);
  const operationAudits = await deleteExpired(context, OPERATION_AUDITS, now, limit);
  let accessGrants = 0;
  for (const target of ACCESS_GRANTS) accessGrants += await deleteExpired(context, target, now, limit - accessGrants);
  const modelBrokerUsageEvents = await deleteExpired(context, MODEL_BROKER_USAGE_EVENTS, now, limit);
  const subscriptionFlows = await deleteExpired(context, SUBSCRIPTION_FLOWS, now, limit);
  const connectFlows = await deleteExpired(context, CONNECT_FLOWS, now, limit);
  await purgeChangeLog(context, now);
  return { operations, operationAudits, accessGrants, modelBrokerUsageEvents, subscriptionFlows, connectFlows };
}
