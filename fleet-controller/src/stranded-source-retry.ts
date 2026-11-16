import { FleetMutationRefusedError, runNormalFleetMutation } from "@octogee/core/normal-fleet-mutation";
import { PlacementPreconditionFailed, type PlacementRefusalReason } from "@octogee/core/placement-refusal";
import type { OperationRecord, PlatformStateStore, Stored } from "@octogee/core/platform-state";
import {
  readStrandedSource,
  restoreStrandedSourceServing,
  strandedSourceRestoreOutcome,
  type StrandedSource,
  type StrandedSourceGatewayCalls,
} from "@octogee/core/stranded-source-restore";

export const STRANDED_SOURCE_RESTORE_ATTEMPTS = 12;
export const STRANDED_SOURCE_RESUMES_PER_PASS = 5;
const FIRST_BACKOFF_MS = 60_000;
const LONGEST_BACKOFF_MS = 30 * 60_000;
const HUNG_PASS_REPORT_MS = 15 * 60_000;
const ACTOR = "fleet-controller";
const REFUSALS_THAT_CAN_PASS_LATER: ReadonlySet<PlacementRefusalReason> = new Set([
  "fleet-state-changed",
  "migration-in-flight",
  "account-not-active",
  "source-gateway-paused",
]);

export interface StrandedSourceRetryDeps extends StrandedSourceGatewayCalls {
  store: PlatformStateStore;
  log: (message: string) => void;
  now: () => number;
}

export type StartStrandedSourceRetry = (failed: readonly Stored<OperationRecord>[]) => void;

export interface StrandedSourceRetry {
  start: StartStrandedSourceRetry;
  idle: () => Promise<void>;
}

interface Progress {
  failures: number;
  nextAttemptAt: number;
  waitChecks: number;
  settledRevision?: unknown;
}

export function strandedSourceRestoreBackoffMs(failures: number): number {
  return Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), LONGEST_BACKOFF_MS);
}

function rollbackReachedSourceIngress(operation: OperationRecord): boolean {
  return operation.kind === "migrate-user" && typeof operation.input.uid === "string" && Array.isArray(operation.steps) &&
    operation.steps.some((step) => step.name === "rollback:resume-ingress");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refusalOf(error: unknown): PlacementPreconditionFailed | null {
  if (error instanceof FleetMutationRefusedError) return refusalOf(error.refusal);
  return error instanceof PlacementPreconditionFailed ? error : null;
}

export function createStrandedSourceRetry(deps: StrandedSourceRetryDeps): StrandedSourceRetry {
  const progress = new Map<string, Progress>();
  const restoreDeps = {
    store: deps.store,
    resumeSourceIngress: deps.resumeSourceIngress,
    restoreSourceSchedules: deps.restoreSourceSchedules,
    log: deps.log,
    now: () => new Date(deps.now()),
  };

  const settle = (operation: Stored<OperationRecord>): void => {
    progress.set(operation.id, { failures: 0, nextAttemptAt: 0, waitChecks: 0, settledRevision: operation.revision });
  };

  const due = (operation: Stored<OperationRecord>): boolean => {
    const state = progress.get(operation.id);
    if (state === undefined) return true;
    if (state.settledRevision !== undefined) return state.settledRevision !== operation.revision;
    return state.failures < STRANDED_SOURCE_RESTORE_ATTEMPTS && deps.now() >= state.nextAttemptAt;
  };

  const refused = (operation: Stored<OperationRecord>, refusal: PlacementPreconditionFailed): void => {
    const state = progress.get(operation.id);
    const waited = (state?.waitChecks ?? 0) > 0;
    if (REFUSALS_THAT_CAN_PASS_LATER.has(refusal.reasonCode)) {
      const waitChecks = (state?.waitChecks ?? 0) + 1;
      progress.set(operation.id, {
        failures: state?.failures ?? 0,
        nextAttemptAt: deps.now() + strandedSourceRestoreBackoffMs(waitChecks),
        waitChecks,
      });
      if (!waited) {
        deps.log(`[stranded-source] ⚠ ${operation.id} is not restored automatically yet: ${refusal.message}; it is checked again after a wait that grows to ${LONGEST_BACKOFF_MS / 60_000} minutes`);
      }
      return;
    }
    settle(operation);
    if (refusal.reasonCode !== "source-not-stranded") {
      deps.log(`[stranded-source] ⚠ ${operation.id} is not restored automatically: ${refusal.message}`);
    } else if (waited) {
      deps.log(`[stranded-source] ${operation.id} no longer waits for an automatic restore: ${refusal.message}`);
    }
  };

  const stranded = async (operation: Stored<OperationRecord>): Promise<StrandedSource | null> => {
    let source: StrandedSource;
    try {
      source = await readStrandedSource(deps.store, operation.input.uid as string);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === null) throw error;
      refused(operation, refusal);
      return null;
    }
    const state = progress.get(operation.id);
    if (source.operationId !== operation.id) {
      settle(operation);
      if ((state?.waitChecks ?? 0) > 0) {
        deps.log(`[stranded-source] ${operation.id} no longer waits for an automatic restore: ${source.slug} is now held on ${source.gatewayId} by operation ${source.operationId}`);
      }
      return null;
    }
    if (state !== undefined && state.waitChecks > 0) {
      progress.set(operation.id, { ...state, waitChecks: 0 });
      deps.log(`[stranded-source] ${operation.id} no longer waits: its checks pass, restoring ${source.slug} on ${source.gatewayId}`);
    }
    return source;
  };

  const recordFailure = (operation: Stored<OperationRecord>, source: StrandedSource, error: unknown): void => {
    const failures = (progress.get(operation.id)?.failures ?? 0) + 1;
    const backoffMs = strandedSourceRestoreBackoffMs(failures);
    progress.set(operation.id, { failures, nextAttemptAt: deps.now() + backoffMs, waitChecks: 0 });
    const next = failures < STRANDED_SOURCE_RESTORE_ATTEMPTS
      ? `next attempt in ${Math.round(backoffMs / 1000)}s`
      : `no further automatic attempt until the fleet controller restarts; POST /users/${source.uid}/restore-serving repairs it`;
    deps.log(
      `[stranded-source] ❌ automatic restore of ${source.slug} on ${source.gatewayId} failed ` +
      `(attempt ${failures}/${STRANDED_SOURCE_RESTORE_ATTEMPTS}, operation ${operation.id}): ${errorMessage(error)}; ${next}`,
    );
  };

  const restore = async (operation: Stored<OperationRecord>, source: StrandedSource): Promise<void> => {
    const { uid, gatewayId, operationId: failedMoveId } = source;
    try {
      await runNormalFleetMutation(deps.store, {
        actor: ACTOR,
        forced: false,
        what: "restore stranded source to serving",
        why: "a failed move left the source closed",
        target: { uid, gatewayId },
        preActionStatus: { gatewayId, assignmentState: "quiescing", failedMoveId },
        mutation: { kind: "restore-source-serving", uid, gatewayId, failedMoveId, automatic: true },
        action: async () => {
          try {
            return await restoreStrandedSourceServing(restoreDeps, source);
          } catch (error) {
            if (error instanceof PlacementPreconditionFailed) throw new FleetMutationRefusedError(error);
            throw error;
          }
        },
        classifyResult: strandedSourceRestoreOutcome,
      });
      settle(operation);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === null) recordFailure(operation, source, error);
      else refused(operation, refusal);
    }
  };

  const longestOverdueFirst = (failed: readonly Stored<OperationRecord>[]): Stored<OperationRecord>[] =>
    [...failed].sort((left, right) => (progress.get(left.id)?.nextAttemptAt ?? 0) - (progress.get(right.id)?.nextAttemptAt ?? 0));

  const pass = async (failed: readonly Stored<OperationRecord>[]): Promise<void> => {
    const listed = new Set(failed.map((operation) => operation.id));
    for (const id of progress.keys()) {
      if (!listed.has(id)) progress.delete(id);
    }
    let resumesStarted = 0;
    for (const operation of longestOverdueFirst(failed)) {
      if (resumesStarted >= STRANDED_SOURCE_RESUMES_PER_PASS) return;
      try {
        if (!rollbackReachedSourceIngress(operation) || !due(operation)) continue;
        const source = await stranded(operation);
        if (source === null) continue;
        resumesStarted += 1;
        await restore(operation, source);
      } catch (error) {
        deps.log(`[stranded-source] ❌ ${operation.id} could not be checked for a stranded source: ${errorMessage(error)}`);
      }
    }
  };

  let running: Promise<void> | null = null;
  let passStartedAt = 0;
  let hungReportedAt = 0;
  const reportHungPass = (): void => {
    const now = deps.now();
    if (now - Math.max(passStartedAt, hungReportedAt) < HUNG_PASS_REPORT_MS) return;
    hungReportedAt = now;
    deps.log(
      `[stranded-source] ❌ the pass over failed moves has run for ${Math.round((now - passStartedAt) / 60_000)} minutes without ending; ` +
      `no other pass starts until it does`,
    );
  };
  return {
    start: (failed) => {
      if (running !== null) {
        reportHungPass();
        return;
      }
      passStartedAt = deps.now();
      hungReportedAt = 0;
      running = pass(failed)
        .catch((error: unknown) => deps.log(`[stranded-source] ❌ the pass over failed moves stopped: ${errorMessage(error)}`))
        .finally(() => { running = null; });
    },
    idle: () => running ?? Promise.resolve(),
  };
}
