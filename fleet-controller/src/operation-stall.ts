import { createServiceLogger } from "@octogee/shared/server/service-logger";
import type { Operation } from "@octogee/shared/types/glm";
import { serialFleetOperationsConflict } from "@octogee/core/fleet-operation-lock";
import { buildOperationAuditIntent, OPERATION_AUDIT_RETENTION_MS } from "@octogee/core/operation-audit";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { MAX_OPERATION_ATTEMPTS, WAITING_FOR_ISOLATED_GATEWAY } from "./operation-retry.js";
import { MIGRATE_USER_KIND } from "./operation-kinds.js";
import { recordStalledOperations } from "./metrics.js";

const eventLogger = createServiceLogger("cowboy");

export const OPERATION_STALL_RECORD_SCHEMA = "octogee.operation-stall.v1" as const;
export const STALLED_OPERATION_REPEATED_FAILURES = MAX_OPERATION_ATTEMPTS;
export const STALLED_OPERATION_HOLD_MS = 30 * 60_000;
export const STALLED_OPERATION_OBSERVE_MS = 60_000;

const STALL_OBSERVED_KINDS: ReadonlySet<string> = new Set(["rollout", MIGRATE_USER_KIND]);
const SELF_WAITS: ReadonlySet<string> = new Set(["builder-idle", "home-archive-provider", WAITING_FOR_ISOLATED_GATEWAY]);
const ACTOR = "fleet-controller";

export type OperationStallReason = "repeated-failure" | "holding-queue";

export interface QueuedBehindOperation {
  id: string;
  kind: string;
  waitingOn: string;
}

export interface OperationStall {
  operationId: string;
  kind: string;
  status: string;
  reason: OperationStallReason;
  repeatedError: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  attempts: number;
  firstStartedAt: number;
  stuckSince: number;
  stuckForMs: number;
  queuedBehind: QueuedBehindOperation[];
  uid: string | null;
  gatewayId: string | null;
  fromGatewayId: string | null;
  toGatewayId: string | null;
}

export interface OperationStallRecord extends Omit<OperationStall, "firstStartedAt" | "stuckSince"> {
  schema: typeof OPERATION_STALL_RECORD_SCHEMA;
  recordType: "operation_stall";
  observedAt: string;
  namespace: string;
  stuckSince: string;
  auditId: string;
}

function inputString(op: Operation, key: string): string | null {
  const value = op.input?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function trailingIdenticalFailures(op: Operation): { error: string; startedAt: number; count: number } | null {
  const history = op.attemptHistory ?? [];
  const last = history.at(-1);
  if (last === undefined || last.classification !== "transient") return null;
  let count = 0;
  let startedAt = last.startedAt;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const attempt = history[index];
    if (attempt.classification !== "transient" || attempt.error !== last.error) break;
    count += 1;
    startedAt = attempt.startedAt;
  }
  return { error: last.error, startedAt, count };
}

function queuedBehind(op: Operation, active: readonly Operation[]): QueuedBehindOperation[] {
  return active.flatMap((other) => {
    const waitingOn = other.waitingOn;
    if (other.id === op.id || other.status !== "pending" || typeof waitingOn !== "string" || waitingOn.length === 0 ||
        SELF_WAITS.has(waitingOn) || !serialFleetOperationsConflict(op, other)) return [];
    return [{ id: other.id, kind: other.kind, waitingOn }];
  });
}

function observedForStall(op: Operation): op is Operation & { firstStartedAt: number } {
  return STALL_OBSERVED_KINDS.has(op.kind) && (op.status === "pending" || op.status === "running") &&
    typeof op.firstStartedAt === "number" && (op.attempts ?? 0) > 0 && op.output?.gatewayCompatibilityPending !== true;
}

export function findStalledOperations(active: readonly Operation[], now: number): OperationStall[] {
  return active.flatMap((op) => {
    if (!observedForStall(op)) return [];
    const streak = trailingIdenticalFailures(op);
    const behind = queuedBehind(op, active);
    const repeated = streak !== null && streak.count >= STALLED_OPERATION_REPEATED_FAILURES;
    const holding = behind.length > 0 && now - op.firstStartedAt >= STALLED_OPERATION_HOLD_MS;
    if (!repeated && !holding) return [];
    const stuckSince = repeated ? streak.startedAt : op.firstStartedAt;
    return [{
      operationId: op.id,
      kind: op.kind,
      status: op.status,
      reason: repeated ? "repeated-failure" : "holding-queue",
      repeatedError: repeated ? streak.error : null,
      consecutiveFailures: streak?.count ?? 0,
      lastError: op.attemptHistory?.at(-1)?.error ?? null,
      attempts: op.attempts ?? 0,
      firstStartedAt: op.firstStartedAt,
      stuckSince,
      stuckForMs: now - stuckSince,
      queuedBehind: behind,
      uid: inputString(op, "uid"),
      gatewayId: inputString(op, "gatewayId"),
      fromGatewayId: inputString(op, "fromGatewayId"),
      toGatewayId: inputString(op, "toGatewayId"),
    }];
  });
}

export function operationStallAuditKey(stall: Pick<OperationStall, "operationId" | "firstStartedAt">): string {
  return `operation-stalled:${stall.operationId}:${stall.firstStartedAt}`;
}

export interface StalledOperationObserverDeps {
  store: PlatformStateStore;
  namespace: string;
  now: () => number;
  log: (message: string) => void;
  emit?: (record: OperationStallRecord) => void;
}

function emitStallRecord(record: OperationStallRecord): void {
  eventLogger.error("Fleet operation stalled", { ...record });
}

async function journalStallOnset(deps: StalledOperationObserverDeps, stall: OperationStall, now: number): Promise<string | null> {
  const audit = buildOperationAuditIntent({
    actor: ACTOR,
    forced: false,
    what: "Report a fleet operation that is not making progress",
    why: stall.reason === "repeated-failure"
      ? `the same failure repeated ${stall.consecutiveFailures} times`
      : `it has held ${stall.queuedBehind.length} conflicting operation(s) for over ${Math.round(STALLED_OPERATION_HOLD_MS / 60_000)} minutes`,
    target: { operationId: stall.operationId, kind: stall.kind, uid: stall.uid, gatewayId: stall.gatewayId,
      fromGatewayId: stall.fromGatewayId, toGatewayId: stall.toGatewayId },
    preActionStatus: { status: stall.status, attempts: stall.attempts, lastError: stall.lastError,
      queuedBehind: stall.queuedBehind.map((queued) => queued.id) },
    mutation: { kind: "operation-stalled", operationId: stall.operationId, reason: stall.reason, firstStartedAt: stall.firstStartedAt },
    idempotencyKey: operationStallAuditKey(stall),
    now: () => now,
  });
  return deps.store.transaction({ label: "operation-stall.journal" }, async (tx) => {
    if (await tx.journal.getRecord(audit.id) !== null) return null;
    await tx.journal.audits.create({
      ...audit.document,
      id: audit.id,
      status: "completed",
      lifecycleStage: "action-completed",
      outcome: "completed",
      actionClaimId: audit.id,
      actionStartedAt: now,
      actionRecoveryCount: 0,
      completedAt: now,
      expireAt: now + OPERATION_AUDIT_RETENTION_MS,
    });
    return audit.id;
  });
}

function stallRecord(stall: OperationStall, namespace: string, auditId: string, now: number): OperationStallRecord {
  const { firstStartedAt: _firstStartedAt, stuckSince, ...rest } = stall;
  return {
    schema: OPERATION_STALL_RECORD_SCHEMA,
    recordType: "operation_stall",
    observedAt: new Date(now).toISOString(),
    namespace,
    ...rest,
    stuckSince: new Date(stuckSince).toISOString(),
    auditId,
  };
}

export async function runStalledOperationObserverTick(deps: StalledOperationObserverDeps): Promise<OperationStall[]> {
  const active = await deps.store.journal.operations.listByStatus(["pending", "running"]);
  const now = deps.now();
  const stalls = findStalledOperations(active, now);
  recordStalledOperations(stalls.map((stall) => ({
    operationId: stall.operationId, kind: stall.kind, reason: stall.reason, queuedOperations: stall.queuedBehind.length,
  })));
  for (const stall of stalls) {
    try {
      const auditId = await journalStallOnset(deps, stall, now);
      if (auditId !== null) (deps.emit ?? emitStallRecord)(stallRecord(stall, deps.namespace, auditId, now));
    } catch (error) {
      deps.log(`[operation-stall] ❌ ${stall.operationId} stall could not be journaled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return stalls;
}

export function startStalledOperationObserver(deps: StalledOperationObserverDeps & { intervalMs: number }): () => void {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    runStalledOperationObserverTick(deps)
      .catch((error) => deps.log(`[operation-stall] ❌ tick failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = false; });
  }, deps.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
