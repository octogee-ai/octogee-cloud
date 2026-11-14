import { isUserActivateOperationIdFor, isUserReturnOperationIdFor } from "@octogee/core/isolated-operation-ids";
import { OPERATOR_ISOLATED_GATEWAY_SOURCE } from "@octogee/core/operator-isolated-gateway";
import { sourceTransferBlocksRelease } from './lib/source-transfer-execution.js';
import type { SourceTransferExecution } from '@octogee/shared/types/glm';
import type { OperationPatch } from "@octogee/core/platform-state";
import type {
  UserMigrationV2State,
  OperationAttemptRecord,
  Operation,
  OperationStep,
  SchedulerHandoffState,
} from "@octogee/shared/types/glm";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import type { OperationResult } from "./operation-router.js";
import { MIGRATE_USER_KIND } from "./operation-kinds.js";

export type OperationFailureClassification = "transient" | "terminal";

export function isGatewayStartupUnavailable(error: string | undefined): boolean {
  return typeof error === "string" && /\b(?:agent \S+ (?:has not completed startup inspection and preparation|startup preparation was superseded)|gateway starting; retry shortly)\b/i.test(error);
}

export function isAgentStoreRetirementSessionDrain(error: unknown, gatewayId?: string): boolean {
  if (typeof error !== "string") return false;
  const match = /^agent-store credential retirement failed \(records preserved for retry\): Agent-store Gateway (\S+) still has database sessions$/.exec(error);
  const failedGatewayId = match?.[1];
  return isValidGatewayId(failedGatewayId) && (gatewayId === undefined || failedGatewayId === gatewayId);
}

// Explicit allowlist, terminal by default: "TRUE validation failures... fail
// immediately" is the safe default for a string-classified error. Only causes
// we recognize as environmental (network/K8s-API hiccups, timeouts, preemption)
// get an automatic retry.
const TRANSIENT_ERROR_PATTERNS: readonly RegExp[] = [
  /^source management health unconfirmed; outcome remains fenced$/,
  /^restore recovery Kubernetes outcome is unresolved$/,
  /^restore recovery images are not ready; outcome remains fenced$/,
  /rsync import port \d+ is already serving migrationId=/,
  /\btimed?\s?out\b/i,
  /\bsocket closed before connect response\b/i,
  /\bis held for migration\b/i,
  /\bquiesce did not drain\b/i,
  /\bScheduler runs are still draining\b/i,
  /\bexpected exactly one (ready|running) pod for transport=\S+; found \d+/i,
  /\boperation \S+ did not finish within \d+ms\b/i,
  /did not (warm|become ready|render|publish)/i,
  /durable desired revision did not materialize/i,
  /never published a heartbeat/i,
  /\bdeadline exceeded\b/i,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /\bfetch failed\b/i,
  /\bterminated\b/i,
  /\bpremature close\b/i,
  /\bunexpected end\b/i,
  /\btruncated\b/i,
  /\b14 UNAVAILABLE\b/i,
  /\b10 ABORTED: Too much contention on these documents\. Please try again\./,
  /\b(status|HTTP) (429|502|503|504)\b/,
  /\bdatabase is locked\b/i,
  /\bpreempt(ed|ion)?\b/i,
  /You must be logged in to the server \(Unauthorized\)/,
  /config unfreeze cleanup pending/i,
  /source unmount cleanup pending/i,
  /retirement config freeze failed/i,
  /system config writer lock is busy/i,
  /system config mutation unavailable: writer-lock-busy/i,
  /fleet will retry/i,
  /gateway .* is not migration-ready/i,
  /\[migration-http\] local SSH public key is missing for /i,
  /\[migration-activation:[^\]]+\] source has no applied fingerprint; converge it before migration/i,
];

export function classifyOperationFailure(
  error: string | undefined,
): OperationFailureClassification {
  if (!error) return "terminal";
  if (isGatewayStartupUnavailable(error) || isAgentStoreRetirementSessionDrain(error)) return "transient";
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(error))
    ? "transient"
    : "terminal";
}

export const MAX_OPERATION_ATTEMPTS = 3;
export const MAX_PREEMPTED_OPERATION_ATTEMPTS = 6;
export const MAX_OPERATION_ATTEMPT_HISTORY = 20;
export const MAX_OPERATOR_ISOLATED_GATEWAY_WAIT_ATTEMPTS = 30;
export const OPERATOR_ISOLATED_GATEWAY_WAIT_MS = 60_000;

// `completedAt` is a plain epoch number, which a native Firestore TTL policy
// cannot read; `expireAt` is its Timestamp twin. Terminal rows only — a row that
// can still change must never carry an expiry.
export const OPERATION_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60_000;

const CLEAR = { clear: true } as const;

function journalExpiry(now: number): number {
  return now + OPERATION_JOURNAL_RETENTION_MS;
}

const RETRY_BACKOFF_MS_BY_ATTEMPT: Readonly<Record<number, number>> = {
  1: 30_000,
  2: 120_000,
};
const RETRY_BACKOFF_MS_CAP = 480_000;

export function retryBackoffMs(attempt: number): number {
  return RETRY_BACKOFF_MS_BY_ATTEMPT[attempt] ?? RETRY_BACKOFF_MS_CAP;
}

export const MAX_REQUESTED_RETRY_DELAY_MS = 60 * 60_000;

function requestedRetryDelayMs(result: OperationResult): number {
  const requested = result.retryAfterMs;
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(requested, MAX_REQUESTED_RETRY_DELAY_MS);
}

export function shouldPersistClaimedOperationCompletion(input: {
  status: string;
  startedAt: unknown;
  claimedStartedAt: unknown;
}): boolean {
  return input.status === "running" && input.startedAt === input.claimedStartedAt;
}

export function operationFirstStartedAt(op: Pick<Operation,
  "status" | "firstStartedAt" | "startedAt" | "attempts" | "resumeCount" | "attemptHistory"
>, now: number): number | null {
  if (op.firstStartedAt !== undefined) return op.firstStartedAt;
  const neverClaimed = op.status === "pending" && op.startedAt === null &&
    !op.attempts && !op.resumeCount && !op.attemptHistory?.length;
  return neverClaimed ? now : null;
}

export function operationNeedsDurableUserMigrationV2Resume(op: {
  kind?: string;
  customerMigrationV2?: UserMigrationV2State;
  sourceTransferExecution?: SourceTransferExecution;
}): boolean {
  return op.kind === MIGRATE_USER_KIND && op.customerMigrationV2 !== undefined;
}

export function operationNeedsDurableRestartResume(op: {
  id?: string;
  kind?: string;
  origin?: string;
  input?: Record<string, unknown>;
  customerMigrationV2?: UserMigrationV2State;
  schedulerHandoff?: SchedulerHandoffState;
  schedulerHandoffReleased?: boolean;
  cutoverCommittedAt?: number;
  sourceTransferExecution?: SourceTransferExecution;
}): boolean {
  return migrationCutoverNeedsRecovery(op) ||
    op.schedulerHandoff?.forwardRecovery !== undefined ||
    sourceTransferBlocksRelease(op.sourceTransferExecution) || op.kind === "suspend-user" ||
    (op.kind === "restart-gateway" && (op.input?.restoreRecovery !== undefined || op.input?.sourceRecovery !== undefined)) ||
    op.kind === "erase-user" ||
    isLevelTriggeredUserReturn(op) ||
    operationNeedsDurableUserMigrationV2Resume(op);
}

export function supersededRollMigrationAction(op: {
  status: string;
  output?: Record<string, unknown>;
  sourceTransferExecution?: SourceTransferExecution;
}): "cancel" | "wait" | "done" {
  if (sourceTransferBlocksRelease(op.sourceTransferExecution)) return "wait";
  if (op.status === "running") return "wait";
  if (op.status === "pending") {
    const cleanup = op.output?.configCleanup;
    return cleanup !== null && typeof cleanup === "object" ? "wait" : "cancel";
  }
  return "done";
}

export interface OperationCompletionInput {
  op: {
    id?: string;
    kind?: string;
    origin?: string;
    input?: Record<string, unknown>;
    attempts?: number;
    attemptHistory?: OperationAttemptRecord[];
    startedAt?: number | null;
    output?: Record<string, unknown>;
    customerMigrationV2?: UserMigrationV2State;
    schedulerHandoff?: SchedulerHandoffState;
    schedulerHandoffReleased?: boolean;
    cutoverCommittedAt?: number;
    sourceTransferExecution?: SourceTransferExecution;
  };
  result: OperationResult;
  steps: OperationStep[];
  now: number;
}

export function verifiedDeletionCompletion(
  result: OperationResult,
): { deletionId: string; archiveId: string } | null {
  if (!result.success) return null;
  const value = result.output?.verifiedDeletion;
  if (!value || typeof value !== "object") return null;
  const deletionId = (value as { deletionId?: unknown }).deletionId;
  const archiveId = (value as { archiveId?: unknown }).archiveId;
  return typeof deletionId === "string" && typeof archiveId === "string"
    ? { deletionId, archiveId }
    : null;
}

function resultOutput(result: OperationResult): OperationPatch {
  return { output: result.output ?? CLEAR };
}

function successfulCompletion(
  input: OperationCompletionInput,
  persistedSteps: OperationStep[],
  attempts: number,
): OperationPatch {
  const scrubbedInput: OperationPatch = input.result.scrubInputOnSuccess
    ? { input: CLEAR, inputUid: CLEAR, createdBy: CLEAR, attemptHistory: CLEAR, steps: [] }
    : {};
  return {
    status: "succeeded",
    completedAt: input.now,
    expireAt: journalExpiry(input.now),
    attempts,
    steps: persistedSteps,
    error: CLEAR,
    rolledBack: false,
    nextAttemptAt: CLEAR,
    waitingOn: CLEAR,
    ...resultOutput(input.result),
    ...scrubbedInput,
  };
}

function recordOutput(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function hasLevelTriggeredFence(input: OperationCompletionInput): boolean {
  const { op, result } = input;
  if (recordOutput(result.output?.deletionBlocked)) return false;
  return recordOutput(result.output?.retirementFencePending) ||
    recordOutput(result.output?.deletionFencePending) ||
    recordOutput(result.output?.deletionCleanupRetry) ||
    op.kind === MIGRATE_USER_KIND && result.output?.gatewayCompatibilityPending === true ||
    op.kind === "suspend-user" ||
    op.kind === "erase-user";
}

function isLevelTriggeredUserReturn(op: OperationCompletionInput["op"]): boolean {
  const fromGatewayId = op.input?.fromGatewayId;
  return op.kind === MIGRATE_USER_KIND &&
    op.origin === "automatic" &&
    op.input?.source === "builder-activation-lease" &&
    isUserReturnOperationIdFor(op.id, fromGatewayId);
}

export function vmPreemptionError(role: "source" | "target", instanceName: string, cause: string): string {
  return `${role} computer ${instanceName} was preempted: ${cause}`;
}

function isVmPreemptionFailure(error: string): boolean {
  return /^(source|target) computer \S+ was preempted: /.test(error);
}

function isGatewayMigrationReadinessFailure(error: string): boolean {
  return /gateway .* is not migration-ready/i.test(error);
}

function isLevelTriggeredContinuousPlacement(
  op: OperationCompletionInput["op"],
): boolean {
  return op.kind === MIGRATE_USER_KIND &&
    op.origin === "automatic" &&
    op.input?.source === "continuous-placement-policy" &&
    typeof op.id === "string" &&
    /^placement-[a-f0-9]{32}$/.test(op.id);
}

function isFencedManagementHealthFailure(op: OperationCompletionInput["op"], error: string): boolean {
  const source = op.input?.sourceRecovery as { postgresAgentStores?: unknown } | undefined;
  const ownedSource = Array.isArray(source?.postgresAgentStores) && source.postgresAgentStores.length > 0;
  return op.kind === "restart-gateway" && ownedSource &&
    error === "source management health unconfirmed; outcome remains fenced";
}

interface FailureCompletionContext {
  error: string;
  classification: OperationFailureClassification;
  attemptHistory: OperationAttemptRecord[];
  levelTriggeredFence: boolean;
}

function failureClassification(input: OperationCompletionInput, error: string, levelTriggeredFence: boolean): OperationFailureClassification {
  if (input.result.failedAfterCutover === true) return "terminal";
  return levelTriggeredFence ? "transient" : classifyOperationFailure(error);
}

function failureCompletionContext(
  input: OperationCompletionInput,
  persistedSteps: OperationStep[],
  attempts: number,
): FailureCompletionContext {
  const error = input.result.error ?? "unknown error";
  const levelTriggeredFence = hasLevelTriggeredFence(input);
  const classification = failureClassification(input, error, levelTriggeredFence);
  const attemptRecord: OperationAttemptRecord = {
    attempt: attempts,
    startedAt: input.op.startedAt ?? input.now,
    completedAt: input.now,
    error,
    classification,
    steps: persistedSteps,
  };
  return {
    error,
    classification,
    levelTriggeredFence,
    attemptHistory: [...(input.op.attemptHistory ?? []), attemptRecord]
      .slice(-MAX_OPERATION_ATTEMPT_HISTORY),
  };
}

function isTargetNotServingYet(error: string): boolean {
  return /^placement rejected for \S+: (?:no-live-revision|revision-not-ready)(?: \(.+\))?$/.test(error) ||
    /^target gateway \S+ is not migration-ready/.test(error);
}

function failedOnGatewayNotServingYet(op: OperationCompletionInput["op"], error: string): boolean {
  return op.kind === MIGRATE_USER_KIND &&
    op.input?.source === OPERATOR_ISOLATED_GATEWAY_SOURCE &&
    isTargetNotServingYet(error);
}

function operatorIsolatedGatewayWaitExpired(
  input: OperationCompletionInput,
  persistedSteps: OperationStep[],
  attempts: number,
  failure: FailureCompletionContext,
): OperationPatch {
  const error = `isolated gateway ${String(input.op.input?.toGatewayId)} did not become ready within ` +
    `${MAX_OPERATOR_ISOLATED_GATEWAY_WAIT_ATTEMPTS} checks; last cause: ${failure.error}`;
  return failedCompletion(input, persistedSteps, attempts, { ...failure, error });
}

function readinessChecks(op: OperationCompletionInput["op"]): number {
  const counted = op.output?.isolatedGatewayReadinessChecks;
  return typeof counted === "number" && Number.isSafeInteger(counted) && counted > 0 ? counted : 0;
}

function operatorIsolatedGatewayWait(input: OperationCompletionInput, checks: number, cause: string): OperationPatch {
  return {
    status: "pending",
    startedAt: null,
    steps: [],
    expireAt: CLEAR,
    nextAttemptAt: input.now + OPERATOR_ISOLATED_GATEWAY_WAIT_MS,
    waitingOn: CLEAR,
    rolledBack: false,
    output: { isolatedGatewayReadinessChecks: checks },
    error: `waiting for isolated gateway ${String(input.op.input?.toGatewayId)} to become ready ` +
      `(check ${checks} of ${MAX_OPERATOR_ISOLATED_GATEWAY_WAIT_ATTEMPTS}): ${cause}`,
  };
}

function restartAbortedMigration(op: OperationCompletionInput["op"]): OperationPatch {
  return op.customerMigrationV2?.phase === "aborted"
    ? { customerMigrationV2: CLEAR }
    : {};
}

function pendingCompletion(
  input: OperationCompletionInput,
  attempts: number,
  failure: FailureCompletionContext,
): OperationPatch {
  const backoffMs = Math.max(retryBackoffMs(attempts), requestedRetryDelayMs(input.result));
  return {
    ...restartAbortedMigration(input.op),
    status: "pending",
    startedAt: null,
    steps: [],
    expireAt: CLEAR,
    attempts,
    attemptHistory: failure.attemptHistory,
    queuedAt: input.op.kind === MIGRATE_USER_KIND && input.result.rolledBack === true &&
      !recordOutput(input.result.output?.configCleanup) &&
      (input.op.customerMigrationV2 === undefined || input.op.customerMigrationV2.phase === "aborted")
      ? input.now : CLEAR,
    nextAttemptAt: input.now + backoffMs,
    waitingOn: CLEAR,
    error: `attempt ${attempts} failed (transient): ${failure.error} — retrying in ${Math.round(backoffMs / 1000)}s`,
    ...resultOutput(input.result),
  };
}

function failedCompletion(
  input: OperationCompletionInput,
  persistedSteps: OperationStep[],
  attempts: number,
  failure: FailureCompletionContext,
): OperationPatch {
  return {
    status: "failed",
    completedAt: input.now,
    expireAt: journalExpiry(input.now),
    attempts,
    attemptHistory: failure.attemptHistory,
    steps: persistedSteps,
    error: failure.error,
    rolledBack: input.result.rolledBack ?? false,
    nextAttemptAt: CLEAR,
    waitingOn: CLEAR,
    ...resultOutput(input.result),
  };
}

function failedAfterCutoverCompletion(
  input: OperationCompletionInput,
  persistedSteps: OperationStep[],
  attempts: number,
  failure: FailureCompletionContext,
): OperationPatch {
  if (input.op.kind !== MIGRATE_USER_KIND || input.op.schedulerHandoff === undefined) {
    throw new Error("only a user migration with a scheduler handoff can fail after its cutover");
  }
  return {
    ...failedCompletion(input, persistedSteps, attempts, failure),
    rolledBack: false,
    schedulerHandoffReleased: true,
    schedulerHandoffReleasedAt: input.now,
  };
}

// Decides, and builds the Firestore update for, what happens after a claimed
// op's handler returns. Success always completes. A failure retries (requeues
// to `pending` with backoff) when its cause classifies as transient AND the
// attempt cap hasn't been reached; otherwise it fails terminally with the
// cause. Every FAILED attempt — retried or terminal — is appended to
// attemptHistory (the live `steps` field resets on retry), so all prior
// attempts stay visible however the op ends.
export function buildOperationCompletionUpdate(
  input: OperationCompletionInput,
): OperationPatch {
  const { op, result, steps } = input;
  const persistedSteps = steps.length > 0 ? steps : result.steps;
  const attempts = (op.attempts ?? 0) + 1;
  if (sourceTransferBlocksRelease(op.sourceTransferExecution)) return {
    status:'pending',startedAt:null,completedAt:null,expireAt:CLEAR,steps:persistedSteps,
    nextAttemptAt:input.now+30_000,lastProgressAt:input.now,error:'source transfer termination not observed',
  };
  if (result.waitingForUserIdle === true) {
    if (op.kind !== MIGRATE_USER_KIND || result.success) throw new Error("only pending user migrations can wait for active user work");
    return {
      status: "pending", startedAt: null, completedAt: null, expireAt: CLEAR,
      steps: persistedSteps, nextAttemptAt: input.now + 15_000, lastProgressAt: input.now,
      waitingOn: "builder-idle", error: CLEAR, rolledBack: false,
    };
  }
  if (result.success) return successfulCompletion(input, persistedSteps, attempts);

  const failure = failureCompletionContext(input, persistedSteps, attempts);
  if (result.failedAfterCutover === true) return failedAfterCutoverCompletion(input, persistedSteps, attempts, failure);
  if (failedOnGatewayNotServingYet(op, failure.error)) {
    const checks = readinessChecks(op) + 1;
    return checks < MAX_OPERATOR_ISOLATED_GATEWAY_WAIT_ATTEMPTS
      ? operatorIsolatedGatewayWait(input, checks, failure.error)
      : operatorIsolatedGatewayWaitExpired(input, persistedSteps, attempts, failure);
  }
  const retryBeyondCap = retriesBeyondAttemptCap(op, failure, attempts);
  const retry = !needsSharedRollbackRecovery(input, persistedSteps) && shouldRetry(
    op,
    result,
    failure.classification,
    attempts,
    retryBeyondCap,
  );
  return retry
    ? pendingCompletion(input, attempts, failure)
    : failedCompletion(input, persistedSteps, attempts, failure);
}

function migrationCutoverNeedsRecovery(
  op: Pick<OperationCompletionInput["op"], "kind" | "cutoverCommittedAt" | "schedulerHandoff" | "schedulerHandoffReleased">,
): boolean {
  return op.kind === MIGRATE_USER_KIND &&
    (op.cutoverCommittedAt !== undefined || op.schedulerHandoff?.stageAfterCutover === true && op.schedulerHandoffReleased !== true);
}

function userActivationRolledBack(op: OperationCompletionInput["op"], result: OperationResult): boolean {
  return result.rolledBack === true && op.kind === MIGRATE_USER_KIND &&
    op.customerMigrationV2 === undefined && op.schedulerHandoff?.forwardRecovery === undefined &&
    op.input?.source === "builder-activation-lease" &&
    isUserActivateOperationIdFor(op.id, op.input.toGatewayId);
}

function retriesBeyondAttemptCap(op: OperationCompletionInput["op"], failure: FailureCompletionContext, attempts: number): boolean {
  return failure.levelTriggeredFence ||
    migrationCutoverNeedsRecovery(op) ||
    op.kind === MIGRATE_USER_KIND && failure.error.startsWith("migration cutover committed; destination recovery pending:") ||
    isFencedManagementHealthFailure(op, failure.error) ||
    (isVmPreemptionFailure(failure.error) && attempts < MAX_PREEMPTED_OPERATION_ATTEMPTS) ||
    (isLevelTriggeredUserReturn(op) && !isGatewayMigrationReadinessFailure(failure.error)) ||
    isLevelTriggeredContinuousPlacement(op);
}

function shouldRetry(
  op: OperationCompletionInput["op"],
  result: OperationResult,
  classification: OperationFailureClassification,
  attempts: number,
  retryBeyondCap: boolean,
): boolean {
  if (classification !== "transient") return false;
  if (userActivationRolledBack(op, result)) return false;
  const hasDurableCleanup =
    result.output?.configCleanup !== null &&
    typeof result.output?.configCleanup === "object";
  const activeMigration = op.customerMigrationV2;
  const hasActiveUserMigrationV2 = activeMigration !== undefined &&
    activeMigration.phase !== "complete" &&
    activeMigration.phase !== "aborted";
  return attempts < MAX_OPERATION_ATTEMPTS ||
    hasDurableCleanup ||
    retryBeyondCap ||
    hasActiveUserMigrationV2 ||
    op.schedulerHandoff?.forwardRecovery !== undefined;
}

function needsSharedRollbackRecovery(input: OperationCompletionInput, steps: OperationStep[]): boolean {
  return input.op.kind === MIGRATE_USER_KIND &&
    input.op.customerMigrationV2 === undefined &&
    typeof input.op.input?.fromGatewayId === "string" &&
    input.op.input.fromGatewayId.startsWith("shared-") &&
    input.result.rolledBack !== true &&
    (input.op.input.recoverSourceOnly === true || input.result.rolledBack === false &&
      steps.some((step) => step.name.startsWith("rollback:") && step.status === "failed"));
}
