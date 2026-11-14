import { createHash } from "node:crypto";
import {
  OPERATION_AUDIT_RECORD_TYPE,
  OPERATION_AUDIT_SCHEMA_VERSION,
  type OperationAuditAliasOutcome,
  type OperationAuditAliasPlan,
  type OperationAuditPartialOutcome,
  type OperationAuditRecord,
  type OperationAuditReleaseRolloutLinkage,
  type OperationAuditTestProvenance,
  isOperationAuditRecord,
  isOperationAuditRow,
  type GlmOperationRecord,
} from "@octogee/shared/types/glm";
import { MalformedRecordError } from "./platform-state/errors.js";
import type { JournalRepositories, OperationAuditPatch } from "./platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";

export interface OperationAuditIntentInput {
  actor: string;
  forced: boolean;
  what: string;
  why: string;
  target: Record<string, unknown>;
  preActionStatus: Record<string, unknown>;
  mutation: Record<string, unknown>;
  idempotencyKey?: string;
  aliasPlan?: OperationAuditAliasPlan[];
  releaseRollout?: OperationAuditReleaseRolloutLinkage;
  testProvenance?: OperationAuditTestProvenance;
  now?: () => number;
}

export interface OperationAuditIntent {
  id: string;
  document: Omit<OperationAuditRecord, "id">;
}

export interface RecordedOperationAuditIntent {
  auditId: string;
  disposition: "created" | "existing";
  status: OperationAuditRecord["status"];
}

export interface OperationAuditActionClaim {
  auditId: string;
  claimId: string;
  externalIdempotencyKey: string;
  recovery: boolean;
}

export interface ClaimOperationAuditActionInput {
  claimId: string;
  now?: () => number;
}

export interface RecoverOperationAuditActionInput {
  auditId: string;
  expectedClaimId: string;
  recoveryClaimId: string;
  externalIdempotencyKey: string;
  staleAfterMs: number;
  now: () => number;
}

export class OperationAuditMissingError extends Error {
  constructor(auditId: string) {
    super(`operation audit ${auditId} does not exist`);
    this.name = "OperationAuditMissingError";
  }
}

export class OperationAuditRecordTypeError extends Error {
  constructor(auditId: string) {
    super(`operation journal row ${auditId} is not an audit record`);
    this.name = "OperationAuditRecordTypeError";
  }
}

export class OperationAuditSchemaError extends Error {
  constructor(auditId: string, options?: ErrorOptions) {
    super(`operation audit ${auditId} has an unsupported or malformed schema`, options);
    this.name = "OperationAuditSchemaError";
  }
}

export class OperationAuditRecoveryContractError extends Error {
  constructor(auditId: string) {
    super(`operation audit ${auditId} recovery must use the audit ID as its external idempotency key`);
    this.name = "OperationAuditRecoveryContractError";
  }
}

export class OperationAuditClaimNotStaleError extends Error {
  constructor(auditId: string, claimId: string, staleAt: number) {
    super(`operation audit ${auditId} claim ${claimId} is not stale until ${staleAt}`);
    this.name = "OperationAuditClaimNotStaleError";
  }
}

export class OperationAuditStateError extends Error {
  constructor(auditId: string, actual: string, expected: string) {
    super(`operation audit ${auditId} is ${actual}; expected ${expected}`);
    this.name = "OperationAuditStateError";
  }
}

export class OperationAuditIdempotencyConflictError extends Error {
  constructor(readonly auditId: string) {
    super(`operation audit ${auditId} conflicts with its deterministic idempotency key`);
    this.name = "OperationAuditIdempotencyConflictError";
  }
}

function canonicalizeMutation(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("operation audit mutation contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("operation audit mutation contains a cycle");
    ancestors.add(value);
    const serialized = `[${value.map((item) => canonicalizeMutation(item, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return serialized;
  }
  if (typeof value !== "object") {
    throw new Error(`operation audit mutation contains unsupported ${typeof value}`);
  }
  if (ancestors.has(value)) throw new Error("operation audit mutation contains a cycle");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("operation audit mutation contains a non-plain object");
  }
  const record = value as Record<string, unknown>;
  ancestors.add(value);
  const serialized = `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeMutation(record[key], ancestors)}`)
    .join(",")}}`;
  ancestors.delete(value);
  return serialized;
}

export function operationAuditMutationFingerprint(mutation: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeMutation(mutation)).digest("hex");
}

export function operationAuditDocumentId(idempotencyKey: string): string {
  if (idempotencyKey.length === 0) throw new Error("operation audit idempotency key is required");
  return `audit-${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

export function buildOperationAuditIntent(opts: OperationAuditIntentInput): OperationAuditIntent {
  const now = opts.now ?? Date.now;
  const mutationFingerprint = operationAuditMutationFingerprint(opts.mutation);
  const idempotencyKey = opts.idempotencyKey ?? mutationFingerprint;
  return {
    id: operationAuditDocumentId(idempotencyKey),
    document: {
      recordType: OPERATION_AUDIT_RECORD_TYPE,
      schemaVersion: OPERATION_AUDIT_SCHEMA_VERSION,
      status: "recorded",
      lifecycleStage: "intent-recorded",
      idempotencyKey,
      mutationFingerprint,
      mutation: opts.mutation,
      actor: opts.actor,
      forced: opts.forced,
      what: opts.what,
      why: opts.why,
      target: opts.target,
      preActionStatus: opts.preActionStatus,
      aliasPlan: opts.aliasPlan ?? [],
      ...(opts.releaseRollout ? { releaseRollout: opts.releaseRollout } : {}),
      ...(opts.testProvenance ? { testProvenance: opts.testProvenance } : {}),
      createdAt: now(),
      completedAt: null,
    },
  };
}

function assertMatchingAuditIntent(
  auditId: string,
  data: Record<string, unknown> | undefined,
  intent: OperationAuditIntent,
): OperationAuditRecord {
  if (!isOperationAuditRow(data)) throw new OperationAuditIdempotencyConflictError(auditId);
  if (!isOperationAuditRecord(data)) throw new OperationAuditSchemaError(auditId);
  if (
    data.idempotencyKey !== intent.document.idempotencyKey ||
    data.mutationFingerprint !== operationAuditMutationFingerprint(intent.document.mutation)
  ) {
    throw new OperationAuditIdempotencyConflictError(auditId);
  }
  return { ...data, id: auditId };
}

async function readJournalRow(
  journal: JournalRepositories,
  auditId: string,
): Promise<Stored<GlmOperationRecord> | null> {
  try {
    return await journal.getRecord(auditId);
  } catch (error) {
    if (error instanceof MalformedRecordError) throw new OperationAuditSchemaError(auditId, { cause: error });
    throw error;
  }
}

export async function stageOperationAuditIntentInStore(
  transaction: PlatformStateTransaction,
  intent: OperationAuditIntent,
): Promise<RecordedOperationAuditIntent> {
  const existing = await readJournalRow(transaction.journal, intent.id);
  if (existing === null) {
    await transaction.journal.audits.create({ ...intent.document, id: intent.id });
    return { auditId: intent.id, disposition: "created", status: "recorded" };
  }
  const audit = assertMatchingAuditIntent(intent.id, { ...existing }, intent);
  return { auditId: intent.id, disposition: "existing", status: audit.status };
}

export async function recordOperationAuditIntent(
  store: PlatformStateStore,
  opts: OperationAuditIntentInput,
): Promise<RecordedOperationAuditIntent> {
  const intent = buildOperationAuditIntent(opts);
  return store.transaction({ label: "operation-audit.record-intent" }, (transaction) =>
    stageOperationAuditIntentInStore(transaction, intent),
  );
}

async function requireOperationAuditRecord(
  journal: JournalRepositories,
  auditId: string,
): Promise<OperationAuditRecord> {
  const row = await readJournalRow(journal, auditId);
  if (row === null) throw new OperationAuditMissingError(auditId);
  if (!isOperationAuditRow(row)) throw new OperationAuditRecordTypeError(auditId);
  return row as OperationAuditRecord;
}

export async function claimOperationAuditAction(
  store: PlatformStateStore,
  auditId: string,
  opts: ClaimOperationAuditActionInput,
): Promise<OperationAuditActionClaim> {
  if (opts.claimId.length === 0) throw new Error("operation audit action claim ID is required");
  return store.transaction({ label: "operation-audit.claim" }, async (transaction) => {
    const audit = await requireOperationAuditRecord(transaction.journal, auditId);
    if (audit.status !== "recorded" || audit.lifecycleStage !== "intent-recorded") {
      throw new OperationAuditStateError(
        auditId,
        `${audit.status}/${audit.lifecycleStage}`,
        "recorded/intent-recorded",
      );
    }
    const now = opts.now ?? Date.now;
    await transaction.journal.audits.patch(
      auditId,
      {
        status: "in-progress",
        lifecycleStage: "action-started",
        actionClaimId: opts.claimId,
        actionStartedAt: now(),
        actionRecoveryCount: 0,
      },
      { status: ["recorded"] },
    );
    return { auditId, claimId: opts.claimId, externalIdempotencyKey: auditId, recovery: false };
  });
}

export type FinishOperationAuditInput =
  | { outcome: "completed"; expectedClaimId: string; aliasOutcomes?: OperationAuditAliasOutcome[]; releaseRollout?: OperationAuditReleaseRolloutLinkage; now?: () => number }
  | { outcome: "partial"; expectedClaimId: string; aliasOutcomes?: OperationAuditAliasOutcome[]; partialOutcome: OperationAuditPartialOutcome; releaseRollout?: OperationAuditReleaseRolloutLinkage; now?: () => number }
  | { outcome: "failed"; expectedClaimId: string; aliasOutcomes?: OperationAuditAliasOutcome[]; partialOutcome?: OperationAuditPartialOutcome; releaseRollout?: OperationAuditReleaseRolloutLinkage; error: string; now?: () => number };

export const OPERATION_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60_000;

function completionPatch(opts: FinishOperationAuditInput): OperationAuditPatch {
  const completedAt = (opts.now ?? Date.now)();
  const expireAt = completedAt + OPERATION_AUDIT_RETENTION_MS;
  if (opts.outcome === "failed") {
    return {
      status: "failed",
      lifecycleStage: "action-failed",
      outcome: "failed",
      ...(opts.aliasOutcomes ? { aliasOutcomes: opts.aliasOutcomes } : {}),
      ...(opts.partialOutcome ? { partialOutcome: opts.partialOutcome } : {}),
      ...(opts.releaseRollout ? { releaseRollout: opts.releaseRollout } : {}),
      error: opts.error,
      completedAt,
      expireAt,
    };
  }
  return {
    status: "completed",
    lifecycleStage: opts.outcome === "partial" ? "action-partial" : "action-completed",
    outcome: opts.outcome,
    ...(opts.aliasOutcomes ? { aliasOutcomes: opts.aliasOutcomes } : {}),
    ...(opts.outcome === "partial" ? { partialOutcome: opts.partialOutcome } : {}),
    ...(opts.releaseRollout ? { releaseRollout: opts.releaseRollout } : {}),
    completedAt,
    expireAt,
  };
}

export async function finishOperationAudit(
  store: PlatformStateStore,
  auditId: string,
  opts: FinishOperationAuditInput,
): Promise<void> {
  await store.transaction({ label: "operation-audit.finish" }, async (transaction) => {
    const audit = await requireOperationAuditRecord(transaction.journal, auditId);
    if (audit.status !== "in-progress" || audit.lifecycleStage !== "action-started") {
      throw new OperationAuditStateError(
        auditId,
        `${audit.status}/${audit.lifecycleStage}`,
        "in-progress/action-started",
      );
    }
    if (audit.actionClaimId !== opts.expectedClaimId) {
      throw new OperationAuditStateError(
        auditId,
        `claim ${String(audit.actionClaimId)}`,
        `claim ${opts.expectedClaimId}`,
      );
    }
    await transaction.journal.audits.patch(auditId, completionPatch(opts), { actionClaimId: opts.expectedClaimId });
  });
}

async function runClaimedOperationAuditAction<T>(
  store: PlatformStateStore,
  claim: OperationAuditActionClaim,
  action: (claim: OperationAuditActionClaim) => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await action(claim);
  } catch (error) {
    try {
      await finishOperationAudit(store, claim.auditId, {
        expectedClaimId: claim.claimId,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (completionError) {
      throw new AggregateError(
        [error, completionError],
        `operation audit ${claim.auditId} action failed and its failure could not be recorded`,
      );
    }
    throw error;
  }
  await finishOperationAudit(store, claim.auditId, {
    expectedClaimId: claim.claimId,
    outcome: "completed",
  });
  return result;
}

export async function runWithOperationAuditIntent<T>(
  store: PlatformStateStore,
  opts: OperationAuditIntentInput,
  claimOpts: ClaimOperationAuditActionInput,
  action: (claim: OperationAuditActionClaim) => Promise<T>,
): Promise<T> {
  const audit = await recordOperationAuditIntent(store, opts);
  const claim = await claimOperationAuditAction(store, audit.auditId, claimOpts);
  return runClaimedOperationAuditAction(store, claim, action);
}

export async function resumeOperationAuditAction<T>(
  store: PlatformStateStore,
  opts: RecoverOperationAuditActionInput,
  action: (claim: OperationAuditActionClaim) => Promise<T>,
): Promise<T> {
  if (opts.externalIdempotencyKey !== opts.auditId) {
    throw new OperationAuditRecoveryContractError(opts.auditId);
  }
  if (
    opts.expectedClaimId.length === 0 ||
    opts.recoveryClaimId.length === 0 ||
    opts.expectedClaimId === opts.recoveryClaimId
  ) {
    throw new Error("operation audit recovery requires distinct non-empty claim IDs");
  }
  if (!Number.isFinite(opts.staleAfterMs) || opts.staleAfterMs <= 0) {
    throw new Error("operation audit recovery requires a positive finite stale lease duration");
  }
  const claim = await store.transaction({ label: "operation-audit.resume" }, async (transaction) => {
    const audit = await requireOperationAuditRecord(transaction.journal, opts.auditId);
    if (audit.status !== "in-progress" || audit.lifecycleStage !== "action-started") {
      throw new OperationAuditStateError(
        opts.auditId,
        `${audit.status}/${audit.lifecycleStage}`,
        "in-progress/action-started",
      );
    }
    if (audit.actionClaimId !== opts.expectedClaimId) {
      throw new OperationAuditStateError(
        opts.auditId,
        `claim ${String(audit.actionClaimId)}`,
        `claim ${opts.expectedClaimId}`,
      );
    }
    const now = opts.now();
    if (!Number.isFinite(now)) throw new Error("operation audit recovery requires a finite current time");
    const staleAt = audit.actionStartedAt! + opts.staleAfterMs;
    if (now < staleAt) {
      throw new OperationAuditClaimNotStaleError(opts.auditId, audit.actionClaimId, staleAt);
    }
    await transaction.journal.audits.patch(
      opts.auditId,
      {
        actionClaimId: opts.recoveryClaimId,
        actionStartedAt: now,
        actionRecoveryCount: (audit.actionRecoveryCount ?? 0) + 1,
      },
      { actionClaimId: opts.expectedClaimId, actionStartedAt: audit.actionStartedAt },
    );
    return {
      auditId: opts.auditId,
      claimId: opts.recoveryClaimId,
      externalIdempotencyKey: opts.auditId,
      recovery: true,
    } satisfies OperationAuditActionClaim;
  });
  return runClaimedOperationAuditAction(store, claim, action);
}
