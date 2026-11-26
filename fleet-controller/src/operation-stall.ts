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
import type { PlatformStateStore, PlatformStateTransaction } from "@octogee/core/platform-state";
import { MAX_OPERATION_ATTEMPTS, MAX_OPERATION_ATTEMPT_HISTORY } from "./operation-retry.js";
import { MIGRATE_USER_KIND } from "./operation-kinds.js";
import { recordStalledOperations } from "./metrics.js";

const eventLogger = createServiceLogger("cowboy");

export const OPERATION_STALL_RECORD_SCHEMA = "octogee.operation-stall.v1" as const;
export const STALLED_OPERATION_REPEATED_FAILURES = MAX_OPERATION_ATTEMPTS;
export const STALLED_OPERATION_HOLD_MS = 30 * 60_000;
export const STALLED_OPERATION_PARK_AFTER_MS = 30 * 60_000;
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
  stalledSince: number;
  parkedAt: number | null;
  stuckForMs: number;
  queuedBehind: QueuedBehindOperation[];
  uid: string | null;
  gatewayId: string | null;
  fromGatewayId: string | null;
  toGatewayId: string | null;
}

export interface OperationStallRecord extends Omit<OperationStall, "observedSince" | "stuckSince" | "stalledSince" | "parkedAt"> {
  schema: typeof OPERATION_STALL_RECORD_SCHEMA;
  recordType: "operation_stall";
  observedAt: string;
  namespace: string;
  stuckSince: string;
  stalledSince: string;
  parkAt: string;
  parked: boolean;
  parkedAt: string | null;
  auditId: string | null;
}

function inputString(op: Operation, key: string): string | null {
  const value = op.input?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

type ObservedOperation = Operation & { observedSince: number };

interface FailureStreak { error: string; startedAt: number; reachedBoundAt: number | null; count: number; truncated: boolean }

function trailingIdenticalFailures(op: ObservedOperation): FailureStreak | null {
  const retained = op.attemptHistory ?? [];
  const history = retained.filter((attempt) => attempt.startedAt >= op.observedSince);
  const last = history.at(-1);
  if (last === undefined || last.classification !== "transient") return null;
  let first = history.length - 1;
  while (first > 0 && history[first - 1].classification === "transient" && history[first - 1].error === last.error) first -= 1;
  const count = history.length - first;
  const truncated = count === retained.length && retained.length >= MAX_OPERATION_ATTEMPT_HISTORY;
  const bound = history[first + STALLED_OPERATION_REPEATED_FAILURES - 1];
  return {
    error: last.error,
    startedAt: truncated ? Math.min(op.observedSince, history[first].startedAt) : history[first].startedAt,
    reachedBoundAt: bound === undefined ? null : bound.completedAt,
    count,
    truncated,
  };
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

type StallCause = Pick<OperationStall,
  "reason" | "repeatedError" | "consecutiveFailures" | "consecutiveFailuresTruncated" | "stuckSince" | "stalledSince">;

function parkedCause(park: OperationStallPark): StallCause {
  return { reason: park.reason, repeatedError: park.repeatedError, consecutiveFailures: park.consecutiveFailures,
    consecutiveFailuresTruncated: false, stuckSince: park.stuckSince, stalledSince: park.stalledSince };
}

function stallCause(op: ObservedOperation, behind: readonly QueuedBehindOperation[], now: number): StallCause | null {
  const streak = trailingIdenticalFailures(op);
  const failures = { consecutiveFailures: streak?.count ?? 0, consecutiveFailuresTruncated: streak?.truncated ?? false };
  if (streak?.reachedBoundAt != null) {
    return { reason: "repeated-failure", repeatedError: streak.error, ...failures, stuckSince: streak.startedAt,
      stalledSince: streak.reachedBoundAt };
  }
  if (behind.length > 0 && now - op.observedSince >= STALLED_OPERATION_HOLD_MS) {
    return { reason: "holding-queue", repeatedError: null, ...failures, stuckSince: op.observedSince,
      stalledSince: op.observedSince + STALLED_OPERATION_HOLD_MS };
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

function stallAuditFields(stall: OperationStall) {
  return {
    target: { operationId: stall.operationId, kind: stall.kind, uid: stall.uid, gatewayId: stall.gatewayId,
      fromGatewayId: stall.fromGatewayId, toGatewayId: stall.toGatewayId },
    preActionStatus: { status: stall.status, attempts: stall.attempts, lastError: stall.lastError,
      queuedBehind: stall.queuedBehind.map((queued) => queued.id) },
  };
}

export function operationStallAuditKey(stall: Pick<OperationStall, "operationId" | "stalledSince">): string {
  return `operation-stalled:${stall.operationId}:${stall.stalledSince}`;
}

export function operationParkAuditKey(stall: Pick<OperationStall, "operationId" | "stalledSince">): string {
  return `operation-parked:${stall.operationId}:${stall.stalledSince}`;
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

type OperationAuditIntent = ReturnType<typeof buildOperationAuditIntent>;

async function createCompletedAudit(tx: PlatformStateTransaction, audit: OperationAuditIntent, now: number): Promise<void> {
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
}

async function journalStallOnset(deps: StalledOperationObserverDeps, stall: OperationStall, now: number): Promise<string | null> {
  const audit = buildOperationAuditIntent({
    actor: ACTOR,
    forced: false,
    what: "report a fleet operation that is not making progress",
    why: `${stallWhy(stall)}; it parks if it stays stalled for ${Math.round(STALLED_OPERATION_PARK_AFTER_MS / 60_000)} minutes`,
    ...stallAuditFields(stall),
    mutation: { kind: "operation-stalled", operationId: stall.operationId, reason: stall.reason, stalledSince: stall.stalledSince },
    idempotencyKey: operationStallAuditKey(stall),
    now: () => now,
  });
  return deps.store.transaction({ label: "operation-stall.journal" }, async (tx) => {
    if (await tx.journal.getRecord(audit.id) !== null) return null;
    await createCompletedAudit(tx, audit, now);
    return audit.id;
  });
}

function parkRecord(stall: OperationStall, auditId: string, now: number): OperationStallPark {
  return {
    parkedAt: now, reason: stall.reason, repeatedError: stall.repeatedError, lastError: stall.lastError,
    attempts: stall.attempts, consecutiveFailures: stall.consecutiveFailures, stuckSince: stall.stuckSince,
    stalledSince: stall.stalledSince, queuedBehind: stall.queuedBehind.map((queued) => queued.id), auditId,
  };
}

async function parkStalledOperation(deps: StalledOperationObserverDeps, stall: OperationStall, now: number): Promise<string | null> {
  const audit = buildOperationAuditIntent({
    actor: ACTOR,
    forced: false,
    what: "park a fleet operation that is not making progress",
    why: `${stallWhy(stall)} and it stayed stalled for ${Math.round((now - stall.stalledSince) / 60_000)} minutes: ${stall.repeatedError ?? stall.lastError ?? "no error recorded"}`,
    ...stallAuditFields(stall),
    mutation: { kind: "park-operation", operationId: stall.operationId, reason: stall.reason, stalledSince: stall.stalledSince },
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
    await createCompletedAudit(tx, audit, now);
    return audit.id;
  });
}

function stallRecord(stall: OperationStall, namespace: string, auditId: string | null, now: number): OperationStallRecord {
  const { observedSince: _observedSince, stuckSince, stalledSince, parkedAt, ...rest } = stall;
  return {
    schema: OPERATION_STALL_RECORD_SCHEMA,
    recordType: "operation_stall",
    observedAt: new Date(now).toISOString(),
    namespace,
    ...rest,
    stuckSince: new Date(stuckSince).toISOString(),
    stalledSince: new Date(stalledSince).toISOString(),
    parkAt: new Date(stalledSince + STALLED_OPERATION_PARK_AFTER_MS).toISOString(),
    parked: parkedAt !== null,
    parkedAt: parkedAt === null ? null : new Date(parkedAt).toISOString(),
    auditId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function reportStallOnset(deps: StalledOperationObserverDeps, stall: OperationStall, now: number): Promise<void> {
  try {
    const auditId = await journalStallOnset(deps, stall, now);
    if (auditId !== null) (deps.emit ?? emitStallRecord)(stallRecord(stall, deps.namespace, auditId, now));
  } catch (error) {
    deps.log(`[operation-stall] ❌ ${stall.operationId} stall could not be journaled: ${errorMessage(error)}`);
    (deps.emit ?? emitStallRecord)(stallRecord(stall, deps.namespace, null, now));
  }
}

async function parkAndReport(deps: StalledOperationObserverDeps, stall: OperationStall, now: number): Promise<OperationStall> {
  try {
    const auditId = await parkStalledOperation(deps, stall, now);
    if (auditId === null) return stall;
    const parked = { ...stall, parkedAt: now };
    (deps.emit ?? emitStallRecord)(stallRecord(parked, deps.namespace, auditId, now));
    return parked;
  } catch (error) {
    deps.log(`[operation-stall] ❌ ${stall.operationId} could not be parked: ${errorMessage(error)}`);
    return stall;
  }
}

async function advanceStall(deps: StalledOperationObserverDeps, stall: OperationStall, now: number): Promise<OperationStall> {
  if (stall.parkedAt !== null) return stall;
  await reportStallOnset(deps, stall, now);
  if (stall.status !== "pending" || now - stall.stalledSince < STALLED_OPERATION_PARK_AFTER_MS) return stall;
  return parkAndReport(deps, stall, now);
}

export async function runStalledOperationObserverTick(deps: StalledOperationObserverDeps): Promise<OperationStall[]> {
  const active = await deps.store.journal.operations.listByStatus(["pending", "running"]);
  const now = deps.now();
  const stalls: OperationStall[] = [];
  for (const stall of findStalledOperations(active, now)) stalls.push(await advanceStall(deps, stall, now));
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
      .catch((error) => deps.log(`[operation-stall] ❌ tick failed: ${errorMessage(error)}`))
      .finally(() => { running = false; });
  }, deps.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
