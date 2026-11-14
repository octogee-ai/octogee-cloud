export type PlatformAggregate =
  | "operation"
  | "operation-audit"
  | "gateway-recovery-receipt"
  | "gateway"
  | "gateway-release"
  | "gateway-assignment"
  | "gateway-vm-runtime"
  | "fleet-registry"
  | "shared-pool-scaler"
  | "platform-release"
  | "migration-transfer-task"
  | "orchestrator-config"
  | "platform-config"
  | "writer-quiescence"
  | "mattermost-admin"
  | "builder"
  | "builder-agent"
  | "placement-receipt"
  | "schedule-transfer"
  | "agent-store"
  | "user-account"
  | "agent-model-selection"
  | "session-model-audit"
  | "model-credential"
  | "subscription-link"
  | "subscription-flow"
  | "workspace"
  | "workspace-member"
  | "workspace-project"
  | "workspace-project-member"
  | "workspace-channel"
  | "activity-receipt"
  | "builder-agent-identity"
  | "channel-identity"
  | "builder-secret"
  | "gateway-ticket"
  | "control-ticket"
  | "control-session"
  | "gateway-access-audit"
  | "model-broker-token"
  | "model-broker-gateway-token"
  | "customer-deletion-job"
  | "anonymous-operational-archive"
  | "agent-import"
  | "agent-import-pointer"
  | "model-broker-usage";

export type PlatformStateBackend = "firestore" | "postgresql";

export type FenceName =
  | "revision"
  | "status"
  | "startedAt"
  | "updatedAt"
  | "epoch"
  | "generation"
  | "leaseId"
  | "retirementVersion"
  | "latestRelease"
  | "runtimeRestartFence"
  | "actionClaimId"
  | "actionSequence"
  | "actionStartedAt"
  | "attemptId"
  | "absent"
  | "present";

export interface RecordKey {
  readonly aggregate: PlatformAggregate;
  readonly key: string;
}

export type UnsupportedOperationReason =
  | "read-after-write"
  | "write-in-read-only-transaction"
  | "backend-capability";

export type PlatformStateError =
  | FenceMismatchError
  | MissingRecordError
  | AlreadyExistsError
  | DuplicateRecordError
  | UnsupportedOperationError
  | ContentionExhaustedError
  | MalformedRecordError
  | BackendFailureError;

function describeRecord(record: RecordKey): string {
  return `${record.aggregate} ${JSON.stringify(record.key)}`;
}

function describeValue(value: unknown): string {
  if (value === undefined) return "absent";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export class FenceMismatchError extends Error {
  readonly code = "fence-mismatch" as const;

  constructor(
    readonly record: RecordKey,
    readonly fence: FenceName,
    readonly expected: unknown,
    readonly actual: unknown,
  ) {
    super(`${describeRecord(record)} fence ${fence} expected ${describeValue(expected)}, found ${describeValue(actual)}`);
    this.name = "FenceMismatchError";
  }
}

export class MissingRecordError extends Error {
  readonly code = "missing-record" as const;

  constructor(readonly record: RecordKey, options?: ErrorOptions) {
    super(`${describeRecord(record)} does not exist`, options);
    this.name = "MissingRecordError";
  }
}

export class AlreadyExistsError extends Error {
  readonly code = "already-exists" as const;

  constructor(readonly record: RecordKey, options?: ErrorOptions) {
    super(`${describeRecord(record)} already exists`, options);
    this.name = "AlreadyExistsError";
  }
}

export class DuplicateRecordError extends Error {
  readonly code = "duplicate-record" as const;

  constructor(
    readonly aggregate: PlatformAggregate,
    readonly lookup: string,
    readonly value: string,
    readonly keysFound: readonly string[],
  ) {
    super(`${aggregate} lookup ${lookup} = ${JSON.stringify(value)} matched ${keysFound.length} records: ${keysFound.join(", ")}`);
    this.name = "DuplicateRecordError";
  }
}

export class UnsupportedOperationError extends Error {
  readonly code = "unsupported-operation" as const;

  constructor(
    readonly backend: PlatformStateBackend,
    readonly operation: string,
    readonly reason: UnsupportedOperationReason,
  ) {
    super(`${backend} platform state store cannot run ${operation}: ${reason}`);
    this.name = "UnsupportedOperationError";
  }
}

export class ContentionExhaustedError extends Error {
  readonly code = "contention-exhausted" as const;

  constructor(
    readonly backend: PlatformStateBackend,
    readonly transactionLabel: string,
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(`${backend} transaction ${transactionLabel} gave up after ${attempts} contended attempts`, options);
    this.name = "ContentionExhaustedError";
  }
}

export class MalformedRecordError extends Error {
  readonly code = "malformed-record" as const;

  constructor(readonly record: RecordKey, readonly detail: string) {
    super(`${describeRecord(record)} is malformed: ${detail}`);
    this.name = "MalformedRecordError";
  }
}

export class BackendFailureError extends Error {
  readonly code = "backend-failure" as const;

  constructor(
    readonly backend: PlatformStateBackend,
    readonly operation: string,
    options: ErrorOptions,
  ) {
    super(`${backend} platform state store failed during ${operation}: ${describeCause(options.cause)}`, options);
    this.name = "BackendFailureError";
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : describeValue(cause);
}

const PLATFORM_STATE_ERROR_CLASSES = [
  FenceMismatchError,
  MissingRecordError,
  AlreadyExistsError,
  DuplicateRecordError,
  UnsupportedOperationError,
  ContentionExhaustedError,
  MalformedRecordError,
  BackendFailureError,
] as const;

export function isPlatformStateError(error: unknown): error is PlatformStateError {
  return PLATFORM_STATE_ERROR_CLASSES.some((errorClass) => error instanceof errorClass);
}
