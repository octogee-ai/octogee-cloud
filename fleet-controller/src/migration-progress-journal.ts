import type { PlatformStateStore } from "@octogee/core/platform-state";
import { isMigrationProgressRecord, type MigrationProgressRecord, type Operation } from "@octogee/shared/types/glm";

export interface ProgressJournalDeps {
  store: PlatformStateStore;
  log: (message: string) => void;
  now?: () => number;
}

function sameAttempt(a: MigrationProgressRecord, b: MigrationProgressRecord): boolean {
  return a.migrationId === b.migrationId && (a.attempt ?? 0) === (b.attempt ?? 0);
}

export function compactProgress(existing: unknown, event: MigrationProgressRecord): MigrationProgressRecord[] {
  const current = Array.isArray(existing) ? existing.filter(isMigrationProgressRecord) : [];
  return [
    ...current.filter((record) => sameAttempt(record, event) && record.phase !== event.phase),
    event,
  ];
}

export async function journalOperationProgress(
  deps: ProgressJournalDeps,
  claimed: Operation,
  event: MigrationProgressRecord,
): Promise<void> {
  const discardedStatus = await deps.store.transaction({ label: "migration-progress.operation" }, async (transaction) => {
    const fresh = await transaction.journal.operations.get(claimed.id);
    if (fresh?.status !== "running" || fresh.startedAt !== claimed.startedAt) return fresh?.status ?? "missing";
    await transaction.journal.operations.patch(
      claimed.id,
      { progress: compactProgress(fresh.progress, event), lastProgressAt: (deps.now ?? Date.now)() },
      { status: ["running"], startedAt: claimed.startedAt },
    );
    return null;
  });
  if (discardedStatus !== null) {
    deps.log(`[glm-controller] op=${claimed.id} progress ${event.phase}:${event.status} discarded because this attempt no longer owns a running operation (status=${discardedStatus})`);
  }
}

export async function journalHandoffProgress(
  deps: ProgressJournalDeps,
  input: { gatewayId: string; uid: string },
  event: MigrationProgressRecord,
): Promise<void> {
  const recorded = await deps.store.transaction({ label: "migration-progress.handoff" }, async (transaction) => {
    const fresh = await transaction.gateways.assignments.get(input.gatewayId, input.uid);
    if (fresh === null) return false;
    await transaction.gateways.assignments.patch(
      input.gatewayId,
      input.uid,
      { handoffProgress: compactProgress(fresh.handoffProgress, event) },
      { epoch: fresh.epoch },
    );
    return true;
  });
  if (!recorded) {
    deps.log(`[glm-controller] handoff progress ${event.phase}:${event.status} discarded because gateways/${input.gatewayId}/assignments/${input.uid} is gone`);
  }
}
