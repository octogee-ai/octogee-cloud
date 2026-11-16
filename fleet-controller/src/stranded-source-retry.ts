import { FleetMutationRefusedError, runNormalFleetMutation } from "@octogee/core/normal-fleet-mutation";
import { PlacementPreconditionFailed } from "@octogee/core/placement-refusal";
import type { OperationRecord, PlatformStateStore, Stored } from "@octogee/core/platform-state";
import {
  readStrandedSource,
  restoreStrandedSourceServing,
  type ResumeSourceIngress,
  type StrandedSource,
} from "@octogee/core/stranded-source-restore";

export const STRANDED_SOURCE_RESTORE_ATTEMPTS = 12;
const FIRST_BACKOFF_MS = 60_000;
const LONGEST_BACKOFF_MS = 30 * 60_000;
const ACTOR = "fleet-controller";

export interface StrandedSourceRetryDeps {
  store: PlatformStateStore;
  resumeSourceIngress: ResumeSourceIngress;
  log: (message: string) => void;
  now: () => number;
}

export type StrandedSourceRetry = (failed: readonly Stored<OperationRecord>[]) => Promise<void>;

interface Attempts {
  failures: number;
  nextAttemptAt: number;
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
  const attempts = new Map<string, Attempts>();
  const restoreDeps = { store: deps.store, resumeSourceIngress: deps.resumeSourceIngress, log: deps.log, now: () => new Date(deps.now()) };

  const settle = (operation: Stored<OperationRecord>): void => {
    attempts.set(operation.id, { failures: 0, nextAttemptAt: 0, settledRevision: operation.revision });
  };

  const due = (operation: Stored<OperationRecord>): boolean => {
    const state = attempts.get(operation.id);
    if (state === undefined) return true;
    if (state.settledRevision !== undefined) return state.settledRevision !== operation.revision;
    return state.failures < STRANDED_SOURCE_RESTORE_ATTEMPTS && deps.now() >= state.nextAttemptAt;
  };

  const stranded = async (operation: Stored<OperationRecord>): Promise<StrandedSource | null> => {
    try {
      const source = await readStrandedSource(deps.store, operation.input.uid as string);
      if (source.operationId === operation.id) return source;
      settle(operation);
      return null;
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === null) throw error;
      if (refusal.reasonCode === "migration-in-flight") return null;
      settle(operation);
      if (refusal.reasonCode !== "source-not-stranded") {
        deps.log(`[stranded-source] ⚠ ${operation.id} is not restored automatically: ${refusal.message}`);
      }
      return null;
    }
  };

  const recordFailure = (operation: Stored<OperationRecord>, source: StrandedSource, error: unknown): void => {
    const failures = (attempts.get(operation.id)?.failures ?? 0) + 1;
    const backoffMs = strandedSourceRestoreBackoffMs(failures);
    attempts.set(operation.id, { failures, nextAttemptAt: deps.now() + backoffMs });
    const next = failures < STRANDED_SOURCE_RESTORE_ATTEMPTS
      ? `next attempt in ${Math.round(backoffMs / 1000)}s`
      : `no further automatic attempt until the fleet controller restarts; POST /users/${source.uid}/restore-serving repairs it`;
    deps.log(
      `[stranded-source] ❌ automatic restore of ${source.slug} on ${source.gatewayId} failed ` +
      `(attempt ${failures}/${STRANDED_SOURCE_RESTORE_ATTEMPTS}, operation ${operation.id}): ${errorMessage(error)}; ${next}`,
    );
  };

  const restore = async (operation: Stored<OperationRecord>, source: StrandedSource): Promise<void> => {
    const { uid, gatewayId } = source;
    try {
      await runNormalFleetMutation(deps.store, {
        actor: ACTOR,
        forced: false,
        what: "restore stranded source to serving",
        why: "a failed move left the source closed",
        target: { uid, gatewayId },
        preActionStatus: { gatewayId, assignmentState: "quiescing", failedMoveId: operation.id },
        mutation: { kind: "restore-source-serving", uid, gatewayId, failedMoveId: operation.id, automatic: true },
        action: async () => {
          try {
            return await restoreStrandedSourceServing(restoreDeps, { uid });
          } catch (error) {
            if (error instanceof PlacementPreconditionFailed) throw new FleetMutationRefusedError(error);
            throw error;
          }
        },
      });
      settle(operation);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === null) {
        recordFailure(operation, source, error);
        return;
      }
      deps.log(`[stranded-source] ⚠ automatic restore of ${source.slug} on ${gatewayId} refused at the write (operation ${operation.id}): ${refusal.message}`);
    }
  };

  return async (failed) => {
    const listed = new Set(failed.map((operation) => operation.id));
    for (const id of attempts.keys()) {
      if (!listed.has(id)) attempts.delete(id);
    }
    for (const operation of failed) {
      if (!rollbackReachedSourceIngress(operation) || !due(operation)) continue;
      try {
        const source = await stranded(operation);
        if (source !== null) await restore(operation, source);
      } catch (error) {
        deps.log(`[stranded-source] ❌ ${operation.id} could not be checked for a stranded source: ${errorMessage(error)}`);
      }
    }
  };
}
