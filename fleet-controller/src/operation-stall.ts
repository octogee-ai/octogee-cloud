import { createServiceLogger } from "@octogee/shared/server/service-logger";
import {
  isOperationStallParked,
  type Operation,
  type OperationStallPark,
  type OperationStallReason,
} from "@octogee/shared/types/glm";
import { buildOperationAuditIntent, OPERATION_AUDIT_RETENTION_MS } from "@octogee/core/operation-audit";
import {
  operationsQueuedBehind,
  PARKED_OPERATION_WAITING_ON,
  stallObservationStart,
  type QueuedBehindOperation,
} from "@octogee/core/operation-stall-park";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { MAX_OPERATION_ATTEMPTS, MAX_OPERATION_ATTEMPT_HISTORY } from "./operation-retry.js";
import { MIGRATE_USER_KIND } from "./operation-kinds.js";
import { recordStalledOperations } from "./metrics.js";

const eventLogger = createServiceLogger("cowboy");

export const OPERATION_STALL_RECORD_SCHEMA = "octogee.operation-stall.v1" as const;
export const STALLED_OPERATION_REPEATED_FAILURES = MAX_OPERATION_ATTEMPTS;
export const STALLED_OPERATION_HOLD_MS = 30 * 60_000;
export const STALLED_OPERATION_OBSERVE_MS = 60_000;

const STALL_OBSERVED_KINDS: ReadonlySet<string> = new Set(["rollout", MIGRATE_USER_KIND]);
const ACTOR = "fleet-controller";

export interface OperationStall {
  operationId: string;
  kind: string;
  status: string;
  reason: OperationStallReason;
  repeatedError: string | null;
  consecutiveFailures: number;
  consecutiveFailuresTruncated: boolean;
  lastError: string | null;
  attempts: number;
  observedSince: number;
  stuckSince: number;
  parkedAt: number | null;
  stuckForMs: number;
  queuedBehind: QueuedBehindOperation[];
  uid: string | null;
  gatewayId: string | null;
  fromGatewayId: string | null;
  toGatewayId: string | null;
}

export interface OperationStallRecord extends Omit<OperationStall, "observedSince" | "stuckSince" | "parkedAt"> {
  schema: typeof OPERATION_STALL_RECORD_SCHEMA;
  recordType: "operation_stall";
  observedAt: string;
  namespace: string;
  stuckSince: string;
  parked: boolean;
  parkedAt: string | null;
  auditId: string | null;
}

function inputString(op: Operation, key: string): string | null {
  const value = op.input?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

type ObservedOperation = Operation & { observedSince: number };

function trailingIdenticalFailures(op: ObservedOperation): { error: string; startedAt: number; count: number; truncated: boolean } | null {
  const retained = op.attemptHistory ?? [];
  const history = retained.filter((attempt) => attempt.startedAt >= op.observedSince);
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
  const truncated = count === retained.length && retained.length >= MAX_OPERATION_ATTEMPT_HISTORY;
  return { error: last.error, startedAt: truncated ? Math.min(op.observedSince, startedAt) : startedAt, count, truncated };
}

function observed(op: Operation): ObservedOperation | null {
  const observedSince = stallObservationStart(op);
  if (!STALL_OBSERVED_KINDS.has(op.kind) || (op.status !== "pending" && op.status !== "running") ||
      observedSince === null || (op.attempts ?? 0) === 0 || op.output?.gatewayCompatibilityPending === true) return null;
  return { ...op, observedSince };
}

function stallTarget(op: Operation): Pick<OperationStall, "uid" | "gatewayId" | "fromGatewayId" | "toGatewayId"> {
  return {
    uid: inputString(op, "uid"),
    gatewayId: inputString(op, "gatewayId"),
    fromGatewayId: inputString(op, "fromGatewayId"),
    toGatewayId: inputString(op, "toGatewayId"),
  };
}

type StallCause = Pick<OperationStall, "reason" | "repeatedError" | "consecutiveFailures" | "consecutiveFailuresTruncated" | "stuckSince">;

function parkedCause(park: OperationStallPark): StallCause {
  return { reason: park.reason, repeatedError: park.repeatedError, consecutiveFailures: park.consecutiveFailures,
    consecutiveFailuresTruncated: false, stuckSince: park.stuckSince };
}

function stallCause(op: ObservedOperation, behind: readonly QueuedBehindOperation[], now: number): StallCause | null {
  const streak = trailingIdenticalFailures(op);
  const failures = { consecutiveFailures: streak?.count ?? 0, consecutiveFailuresTruncated: streak?.truncated ?? false };
  if (streak !== null && streak.count >= STALLED_OPERATION_REPEATED_FAILURES) {
    return { reason: "repeated-failure", repeatedError: streak.error, ...failures, stuckSince: streak.startedAt };
  }
  if (behind.length > 0 && now - op.observedSince >= STALLED_OPERATION_HOLD_MS) {
    return { reason: "holding-queue", repeatedError: null, ...failures, stuckSince: op.observedSince };
  }
  return null;
}

export function findStalledOperations(active: readonly Operation[], now: number): OperationStall[] {
  return active.flatMap((candidate) => {
    const op = observed(candidate);
    if (op === null) return [];
    const behind = operationsQueuedBehind(op, active);
    const park = isOperationStallParked(op) ? op.stallPark ?? null : null;
    const cause = park ? parkedCause(park) : stallCause(op, behind, now);
    if (cause === null) return [];
    return [{
      operationId: op.id,
      kind: op.kind,
      status: op.status,
      ...cause,
      lastError: op.attemptHistory?.at(-1)?.error ?? null,
      attempts: op.attempts ?? 0,
      observedSince: op.observedSince,
      parkedAt: park?.parkedAt ?? null,
      stuckForMs: now - cause.stuckSince,
      queuedBehind: behind,
      ...stallTarget(op),
    }];
  });
}

function stallWhy(stall: OperationStall): string {
  if (stall.reason === "holding-queue") {
    return `it has held ${stall.queuedBehind.length} conflicting operation(s) for over ${Math.round(STALLED_OPERATION_HOLD_MS / 60_000)} minutes`;
  }
  const atLeast = stall.consecutiveFailuresTruncated ? "at least " : "";
  return `the same failure repeated ${atLeast}${stall.consecutiveFailures} times`;
}

export function operationParkAuditKey(stall: Pick<OperationStall, "operationId" | "observedSince">): string {
  return `operation-parked:${stall.operationId}:${stall.observedSince}`;
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

function parkRecord(stall: OperationStall, auditId: string, now: number): OperationStallPark {
  return {
    parkedAt: now, reason: stall.reason, repeatedError: stall.repeatedError, lastError: stall.lastError,
    attempts: stall.attempts, consecutiveFailures: stall.consecutiveFailures, stuckSince: stall.stuckSince,
    queuedBehind: stall.queuedBehind.map((queued) => queued.id), auditId,
  };
}

async function parkStalledOperation(deps: StalledOperationObserverDeps, stall: OperationStall, now: number): Promise<string | null> {
  const audit = buildOperationAuditIntent({
    actor: ACTOR,
    forced: false,
    what: "park a fleet operation that is not making progress",
    why: `${stallWhy(stall)}: ${stall.repeatedError ?? stall.lastError ?? "no error recorded"}`,
    target: { operationId: stall.operationId, kind: stall.kind, uid: stall.uid, gatewayId: stall.gatewayId,
      fromGatewayId: stall.fromGatewayId, toGatewayId: stall.toGatewayId },
    preActionStatus: { status: stall.status, attempts: stall.attempts, lastError: stall.lastError,
      queuedBehind: stall.queuedBehind.map((queued) => queued.id) },
    mutation: { kind: "park-operation", operationId: stall.operationId, reason: stall.reason, observedSince: stall.observedSince },
    idempotencyKey: operationParkAuditKey(stall),
    now: () => now,
  });
  return deps.store.transaction({ label: "operation-stall.park" }, async (tx) => {
    const current = await tx.journal.operations.get(stall.operationId);
    if (current === null || current.status !== "pending" || current.startedAt !== null || isOperationStallParked(current) ||
        (current.attempts ?? 0) !== stall.attempts || await tx.journal.getRecord(audit.id) !== null) return null;
    await tx.journal.operations.patch(stall.operationId, {
      stallPark: parkRecord(stall, audit.id, now),
      waitingOn: PARKED_OPERATION_WAITING_ON,
      nextAttemptAt: { clear: true },
    }, { status: ["pending"], startedAt: null });
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

function stallRecord(stall: OperationStall, namespace: string, auditId: string | null, now: number): OperationStallRecord {
  const { observedSince: _observedSince, stuckSince, parkedAt, ...rest } = stall;
  return {
    schema: OPERATION_STALL_RECORD_SCHEMA,
    recordType: "operation_stall",
    observedAt: new Date(now).toISOString(),
    namespace,
    ...rest,
    stuckSince: new Date(stuckSince).toISOString(),
    parked: parkedAt !== null,
    parkedAt: parkedAt === null ? null : new Date(parkedAt).toISOString(),
    auditId,
  };
}

async function parkAndReport(deps: StalledOperationObserverDeps, stall: OperationStall, now: number): Promise<OperationStall> {
  try {
    const auditId = await parkStalledOperation(deps, stall, now);
    if (auditId === null) return stall;
    const parked = { ...stall, parkedAt: now };
    (deps.emit ?? emitStallRecord)(stallRecord(parked, deps.namespace, auditId, now));
    return parked;
  } catch (error) {
    deps.log(`[operation-stall] ❌ ${stall.operationId} could not be parked: ${error instanceof Error ? error.message : String(error)}`);
    (deps.emit ?? emitStallRecord)(stallRecord(stall, deps.namespace, null, now));
    return stall;
  }
}

export async function runStalledOperationObserverTick(deps: StalledOperationObserverDeps): Promise<OperationStall[]> {
  const active = await deps.store.journal.operations.listByStatus(["pending", "running"]);
  const now = deps.now();
  const stalls: OperationStall[] = [];
  for (const stall of findStalledOperations(active, now)) {
    stalls.push(stall.parkedAt === null && stall.status === "pending" ? await parkAndReport(deps, stall, now) : stall);
  }
  recordStalledOperations(stalls.map((stall) => ({
    operationId: stall.operationId, kind: stall.kind, reason: stall.reason,
    state: stall.parkedAt === null ? "retrying" : "parked", queuedOperations: stall.queuedBehind.length,
  })));
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
