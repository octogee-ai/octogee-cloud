import type { PlatformUserRecord, OperationRecord, PlatformStateStore, Stored, UntypedRecord } from "@octogee/core/platform-state";
import type { Operation, SchedulerHandoffState } from "@octogee/shared/types/glm";
import type { SchedulerMigrationRequestBody } from "@octogee/shared/types/fleet-controller";
import { userActivationSourceRecoveryPending } from "./legacy-migration-recovery.js";
import { queuedSharedMigrationOwnsSourceInStore } from './lib/queued-shared-migration.js';

export interface SchedulerHandoffReleaseDeps {
  store: PlatformStateStore;
  gatewayExists: (gatewayId: string) => Promise<boolean>;
  scheduler: (
    gatewayId: string,
    request: Pick<SchedulerMigrationRequestBody, "migrationId" | "slug" | "phase" | "agentIds" | "snapshot" | "retainNonportable">,
  ) => Promise<{ agentIds: string[]; snapshot?: unknown }>;
  log: (msg: string) => void;
  now: () => number;
}

function isHandoff(value: unknown): value is SchedulerHandoffState {
  if (!value || typeof value !== "object") return false;
  const handoff = value as Record<string, unknown>;
  return ["migrationId", "fromGatewayId", "toGatewayId", "uid", "slug"]
    .every((key) => typeof handoff[key] === "string" && handoff[key] !== "");
}

const UNSETTLED_OPERATION_STATUSES: ReadonlySet<unknown> = new Set(["pending", "running", "failed"]);

export function schedulerHandoffAwaitingRelease(operation: UntypedRecord | undefined): boolean {
  if (operation && userActivationSourceRecoveryPending(operation as Operation)) return true;
  return operation?.schedulerHandoffReleased === false &&
    UNSETTLED_OPERATION_STATUSES.has(operation.status) &&
    isHandoff(operation.schedulerHandoff);
}

type HandoffProgress = "never-held" | "held" | "staged" | "cut-over";

function handoffProgress(operation: UntypedRecord): HandoffProgress {
  if (typeof operation.cutoverCommittedAt === "number") return "cut-over";
  const steps = Array.isArray(operation.steps) ? operation.steps as Array<{ name?: unknown; status?: unknown }> : [];
  if (!steps.some((step) => step.name === "quiesce-source")) return "never-held";
  if ((operation.schedulerHandoff as SchedulerHandoffState).stageAfterCutover) return "held";
  return steps.some((step) => step.name === "final-sync-state" || step.name === "stage-scheduler") ? "staged" : "held";
}

type ListedOperation = Stored<OperationRecord>;

function committedOwnerMatches(op: OperationRecord, owner: Stored<PlatformUserRecord> | null, handoff: SchedulerHandoffState): boolean {
  return op.kind === "migrate-user" && op.input?.uid === handoff.uid &&
    op.input.fromGatewayId === handoff.fromGatewayId && op.input.toGatewayId === handoff.toGatewayId &&
    owner?.gateway?.gatewayId === handoff.toGatewayId;
}

async function retryCommittedHandoff(deps: SchedulerHandoffReleaseDeps, listed: ListedOperation): Promise<boolean> {
  return deps.store.transaction({ label: "scheduler-handoff-release.retry-committed" }, async tx => {
    const op = await tx.journal.operations.get(listed.id);
    if (!op || op.revision !== listed.revision) return false;
    const handoff = op.schedulerHandoff as SchedulerHandoffState;
    const owner = await tx.users.records.get(handoff.uid);
    const matches = op.status === "failed" && op.schedulerHandoffReleased === false && op.cancellationRequestedAt === undefined &&
      committedOwnerMatches(op, owner, handoff);
    if (!matches) return false;
    await tx.journal.operations.patch(op.id, { status: "pending", startedAt: null, completedAt: null, nextAttemptAt: deps.now(), expireAt: { clear: true } },
      { revision: listed.revision });
    return true;
  });
}

async function rollBackHandoff(
  deps: SchedulerHandoffReleaseDeps,
  handoff: SchedulerHandoffState,
  progress: "held" | "staged",
): Promise<void> {
  const request = { migrationId: handoff.migrationId, slug: handoff.slug };
  if (progress === "staged" && await deps.gatewayExists(handoff.toGatewayId)) {
    await deps.scheduler(handoff.toGatewayId, { ...request, phase: "abort" });
  }
  if (await deps.gatewayExists(handoff.fromGatewayId)) await deps.scheduler(handoff.fromGatewayId, { ...request, phase: "resume" });
}

async function acknowledgeCurrentHandoff(
  deps: SchedulerHandoffReleaseDeps,
  listed: ListedOperation,
): Promise<boolean> {
  const releasedAt = deps.now();
  return deps.store.transaction({ label: "scheduler-handoff-release.acknowledge" }, async (tx) => {
    const current = await tx.journal.operations.get(listed.id);
    if (!current || current.revision !== listed.revision) return false;
    await tx.journal.operations.patch(listed.id, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: releasedAt },
      { revision: listed.revision });
    return true;
  });
}

function sourceRecoveryOwns(operation: UntypedRecord, id: string): boolean {
  return userActivationSourceRecoveryPending({ ...operation, id } as Operation) ||
    operation.input?.recoverSourceOnly === true && typeof operation.cutoverCommittedAt !== "number";
}

async function releaseUnclaimedPreTransportHandoff(deps: SchedulerHandoffReleaseDeps, listed: ListedOperation): Promise<boolean> {
  return deps.store.transaction({ label: "scheduler-handoff-release.pre-transport" }, async tx => {
    const row = await tx.journal.operations.get(listed.id);
    if (!row || row.revision !== listed.revision) return false;
    if (row.schedulerHandoff?.forwardRecovery !== undefined || row.schedulerHandoffReleased !== false ||
        !await queuedSharedMigrationOwnsSourceInStore(tx, row, row.id)) return false;
    await tx.journal.operations.patch(row.id, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: deps.now() },
      { revision: listed.revision });
    return true;
  });
}

export async function releaseAbandonedSchedulerHandoffs(
  deps: SchedulerHandoffReleaseDeps,
): Promise<{ released: number }> {
  const unreleased = await deps.store.journal.operations.listUnreleasedSchedulerHandoffs(["failed", "pending"]);
  let released = 0;
  for (const operation of unreleased) {
    try {
      if (await releaseHandoff(deps, operation)) released += 1;
    } catch (error) {
      deps.log(`[scheduler-handoff-release] ⚠ ${operation.id} release failed; source stays closed until the next pass: ${String(error)}`);
    }
  }
  return { released };
}

async function releaseHandoff(deps: SchedulerHandoffReleaseDeps, operation: ListedOperation): Promise<boolean> {
  if (operation.status !== 'pending') return releaseFailedHandoff(deps, operation);
  if (!await releaseUnclaimedPreTransportHandoff(deps, operation)) return false;
  deps.log(`[scheduler-handoff-release] released pre-transport retry ${operation.id}; source ownership unchanged`);
  return true;
}

async function releaseFailedHandoff(deps: SchedulerHandoffReleaseDeps, operation: ListedOperation): Promise<boolean> {
  const id = operation.id;
  if (operation.schedulerHandoff?.forwardRecovery !== undefined ||
      ["sourceQuiesced", "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete"].includes(operation.userMigrationV2?.phase ?? "")) {
    deps.log(`[scheduler-handoff-release] ${id} requires forward recovery; source stays fenced`);
    return false;
  }
  if (sourceRecoveryOwns(operation, id)) return false;
  const handoff = operation.schedulerHandoff;
  if (!isHandoff(handoff)) {
    deps.log(`[scheduler-handoff-release] ⚠ ${id} has no valid scheduler handoff; leaving it pending`);
    return false;
  }
  const progress = handoffProgress(operation);
  if (progress === 'cut-over') {
    const queued = await retryCommittedHandoff(deps, operation);
    deps.log(`[scheduler-handoff-release] ${id} committed handoff ${queued ? 'queued for claimed recovery' : 'changed authority; recovery withheld'}`);
    return false;
  }
  try {
    if (progress !== 'never-held') await rollBackHandoff(deps, handoff, progress);
  } catch (error) {
    deps.log(`[scheduler-handoff-release] ⚠ ${id} ${handoff.migrationId} not released; source stays closed until the next pass: ` +
      `${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (!await acknowledgeCurrentHandoff(deps, operation)) {
    deps.log(`[scheduler-handoff-release] ${id} changed during rollback release; acknowledgment withheld`);
    return false;
  }
  deps.log(`[scheduler-handoff-release] released (${progress}) ${handoff.migrationId} slug=${handoff.slug} ` +
    `source=${handoff.fromGatewayId} target=${handoff.toGatewayId} op=${id}`);
  return true;
}

export function startSchedulerHandoffRelease(
  deps: SchedulerHandoffReleaseDeps & { intervalMs: number },
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    releaseAbandonedSchedulerHandoffs(deps)
      .catch((error: unknown) => deps.log(`[scheduler-handoff-release] ⚠ pass failed: ${String(error)}`))
      .finally(() => { running = false; });
  }, deps.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
