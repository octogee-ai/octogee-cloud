import { isolatedRuntimeMutationFenced } from "@octogee/core/gateway-retirement-claim";
import { FenceMismatchError, type OperationPatch, type PlatformStateStore } from "@octogee/core/platform-state";
import type { Operation } from "@octogee/shared/types/glm";
import { MIGRATION_TRANSFER_LEASE_MS } from "@octogee/shared/types/fleet-controller";
import { operationNeedsDurableRestartResume } from "./operation-retry.js";
import { MIGRATE_USER_KIND, RETIRE_GATEWAY_KIND } from "./operation-kinds.js";
import { rearmOwnedLegacyMigration, recoverFailedLegacyMigrations } from "./legacy-migration-recovery.js";

export const REAPED_OPERATION_ERROR_PREFIX = "reaped: ";

export function isReapedOperationError(error: unknown): boolean {
  return typeof error === "string" && error.startsWith(REAPED_OPERATION_ERROR_PREFIX);
}

export interface StuckOpReaperDeps {
  store: PlatformStateStore;
  log: (msg: string) => void;
  now: () => number;
  stalenessMs: number;
  controllerStartedAt?: number;
}

export interface StuckOpReaperResult {
  scanned: number;
  reaped: number;
}

function readMillis(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function legacyMigrationGate(
  operationId: string,
  operation: Operation,
): { operationId: string; uid: string; fromGatewayId: string } | null {
  if (operation.kind !== "migrate-user" || operation.userMigrationV2) return null;
  const details = operation.input;
  if (!details || typeof details !== "object") return null;
  const uid = details.uid;
  const fromGatewayId = details.fromGatewayId;
  if (typeof uid !== "string" || uid.length === 0) return null;
  if (typeof fromGatewayId !== "string" || fromGatewayId.length === 0) return null;
  return { operationId, uid, fromGatewayId };
}

function operationIsStillStale(
  operation: Operation,
  now: number,
  stalenessMs: number,
): boolean {
  if (operation.status !== "running" || operationNeedsDurableRestartResume(operation)) return false;
  const anchorMs = Math.max(
    readMillis(operation.lastProgressAt) ?? 0,
    readMillis(operation.startedAt) ?? 0,
    readMillis(operation.createdAt) ?? 0,
  );
  return anchorMs > 0 && now - anchorMs >= operationStalenessBudget(operation, stalenessMs);
}

function operationStalenessBudget(operation: Operation, stalenessMs: number): number {
  const finalImportRunning = operation.kind === MIGRATE_USER_KIND &&
    operation.steps?.at(-1)?.name === "final-sync-state" && operation.steps.at(-1)?.status === "running";
  return finalImportRunning ? Math.max(stalenessMs, MIGRATION_TRANSFER_LEASE_MS + 60_000) : stalenessMs;
}

interface ReapResult {
  reaped: boolean;
  gateMessage?: string;
}

async function reapWithLegacyGateRecovery(input: {
  store: PlatformStateStore;
  operation: Operation;
  now: number;
  error: string;
  logLabel: string;
  stillReapable: (current: Operation) => boolean;
  recoveryAdmitted: (current: Operation) => boolean;
}): Promise<ReapResult> {
  const operationId = input.operation.id;
  const rearmed = await rearmOwnedLegacyMigration({ store: input.store, operationId, now: input.now, admitted: (current) => input.stillReapable(current) && input.recoveryAdmitted(current) });
  if (rearmed) return { reaped: true, gateMessage: `[${input.logLabel}] queued native source recovery for ${operationId}; source remains held` };
  const gate = legacyMigrationGate(operationId, input.operation);
  return input.store.transaction({ label: "stuck-op-reaper.reap" }, async (tx) => {
    const [current, owner] = await Promise.all([
      tx.journal.operations.get(operationId),
      gate ? tx.users.records.get(gate.uid) : null,
    ]);
    if (!current || !input.stillReapable(current)) return { reaped: false };
    if (owner && isolatedRuntimeMutationFenced(owner)) {
      return { reaped: false, gateMessage: `[${input.logLabel}] source assignment recovery blocked by unresolved user restore or source transfer` };
    }
    const releasedRecovery = current.input.recoverSourceOnly === true && current.schedulerHandoffReleased === true;
    await tx.journal.operations.patch(operationId, {
      status: "failed",
      completedAt: input.now,
      error: releasedRecovery ? "abandoned Shared migration rolled back; native source recovery completed" : input.error,
      ...(releasedRecovery ? { rolledBack: true, steps: [{ name: "recover-source", status: "done", startedAt: input.now, completedAt: input.now }] } : {}),
    }, { status: ["running"], startedAt: current.startedAt });
    return { reaped: true, gateMessage: releasedRecovery
      ? `[${input.logLabel}] recorded already acknowledged source recovery for ${operationId}; no native replay`
      : `[${input.logLabel}] source recovery remains unacknowledged for ${operationId}; assignment and marker unchanged` };
  });
}

async function reapUnfencedOperation(store: PlatformStateStore, operation: Operation, now: number, error: string): Promise<boolean> {
  try {
    await store.journal.operations.patch(operation.id, { status: "failed", completedAt: now, error },
      { status: ["running"], startedAt: operation.startedAt });
    return true;
  } catch (failure) {
    if (failure instanceof FenceMismatchError) return false;
    throw failure;
  }
}

export async function runStuckOpReaperTick(
  deps: StuckOpReaperDeps,
): Promise<StuckOpReaperResult> {
  await recoverFailedLegacyMigrations(deps);
  const running = await deps.store.journal.operations.listByStatus(["running"]);
  const now = deps.now();

  type StuckRow = { operation: Operation; ageMin: number };
  const stuck: StuckRow[] = [];
  for (const operation of running) {
    if (operationNeedsDurableRestartResume(operation)) continue;

    // Liveness = the most recent of (last step progress, claim, creation). A long or
    // resumed roll that is still stepping keeps lastProgressAt fresh and is NOT reaped;
    // only an op with no progress and no recent (re)claim past the budget is stuck.
    const anchorMs = Math.max(
      readMillis(operation.lastProgressAt) ?? 0,
      readMillis(operation.startedAt) ?? 0,
      readMillis(operation.createdAt) ?? 0,
    );
    if (anchorMs <= 0) continue;
    if (!operationIsStillStale(operation, now, deps.stalenessMs)) continue;
    stuck.push({ operation, ageMin: Math.round((now - anchorMs) / 60_000) });
  }


  const results = await Promise.allSettled(
    stuck.map(async ({ operation, ageMin }) => {
      try {
        const budgetMin = Math.round(operationStalenessBudget(operation, deps.stalenessMs) / 60_000);
        const error = `${REAPED_OPERATION_ERROR_PREFIX}op exceeded ${budgetMin}m running budget — controller likely restarted mid-op or the work hung past the inner deadlines`;
        const legacyResult = legacyMigrationGate(operation.id, operation) === null
          ? null
          : await reapWithLegacyGateRecovery({
              store: deps.store,
              operation,
              now,
              error,
              logLabel: "stuck-op-reaper",
              stillReapable: (current) => operationIsStillStale(current, now, deps.stalenessMs),
              recoveryAdmitted: (current) => claimedByPreviousController(current, deps.controllerStartedAt ?? 0),
            });
        if (legacyResult !== null) {
          if (legacyResult.gateMessage) deps.log(legacyResult.gateMessage);
          if (!legacyResult.reaped) return false;
        } else if (!await reapUnfencedOperation(deps.store, operation, now, error)) {
          deps.log(`[stuck-op-reaper] ${operation.id} changed before the reap; left as is`);
          return false;
        }
        deps.log(
          `[stuck-op-reaper] ⚠ reaped ${operation.id} (kind=${operation.kind ?? "?"}) after ${ageMin}m`,
        );
        return true;
      } catch (err) {
        deps.log(`[stuck-op-reaper] ⚠ ${operation.id} update failed: ${String(err)}`);
        throw err;
      }
    }),
  );
  const reaped = results.filter((r) => r.status === "fulfilled" && r.value).length;
  return { scanned: running.length, reaped };
}

export interface ControllerOrphanRecoveryDeps {
  store: PlatformStateStore;
  log: (msg: string) => void;
  now: () => number;
  controllerStartedAt: number;
}

export interface ControllerOrphanRecoveryResult {
  scanned: number;
  recovered: number;
}

export const CONTROLLER_ORPHANED_OPERATION_ERROR =
  `${REAPED_OPERATION_ERROR_PREFIX}controller restarted mid-op — the claiming controller exited, so no worker can finish it; failed at boot`;

const BOOT_RECOVERABLE_KINDS: ReadonlySet<string> = new Set([MIGRATE_USER_KIND, RETIRE_GATEWAY_KIND]);

function claimedByPreviousController(operation: Operation, controllerStartedAt: number): boolean {
  const claimedAt = readMillis(operation.startedAt);
  return operation.status === "running" &&
    BOOT_RECOVERABLE_KINDS.has(operation.kind) &&
    !operationNeedsDurableRestartResume(operation) &&
    claimedAt !== null &&
    claimedAt < controllerStartedAt;
}

const CLEAR = { clear: true } as const;

export const REARMED_RETIRE_OPERATION: OperationPatch = {
  status: "pending",
  startedAt: null,
  completedAt: null,
  steps: [],
  error: CLEAR,
  lastProgressAt: CLEAR,
  expireAt: CLEAR,
};

async function rearmOrphanedRetirement(
  deps: ControllerOrphanRecoveryDeps,
  operationId: string,
): Promise<boolean> {
  const rearmed = await deps.store.transaction({ label: "stuck-op-reaper.rearm-retirement" }, async (tx) => {
    const current = await tx.journal.operations.get(operationId);
    if (!current || !claimedByPreviousController(current, deps.controllerStartedAt)) return false;
    await tx.journal.operations.patch(operationId, REARMED_RETIRE_OPERATION, { status: ["running"], startedAt: current.startedAt });
    return true;
  });
  if (rearmed) {
    deps.log(
      `[boot-orphan-recovery] ⚠ re-armed orphaned ${operationId} (kind=${RETIRE_GATEWAY_KIND}) claimed by the previous controller; its teardown re-runs from the top`,
    );
  }
  return rearmed;
}

async function failOrphanedMigration(
  deps: ControllerOrphanRecoveryDeps,
  operation: Operation,
  now: number,
): Promise<boolean> {
  const result = await reapWithLegacyGateRecovery({
    store: deps.store,
    operation,
    now,
    error: CONTROLLER_ORPHANED_OPERATION_ERROR,
    logLabel: "boot-orphan-recovery",
    stillReapable: (current) => claimedByPreviousController(current, deps.controllerStartedAt),
    recoveryAdmitted: (current) => claimedByPreviousController(current, deps.controllerStartedAt),
  });
  if (result.gateMessage) deps.log(result.gateMessage);
  if (!result.reaped) return false;
  deps.log(
    `[boot-orphan-recovery] processed orphaned ${operation.id} (kind=${operation.kind}) claimed by the previous controller`,
  );
  return true;
}

export async function recoverControllerOrphanedOperations(
  deps: ControllerOrphanRecoveryDeps,
): Promise<ControllerOrphanRecoveryResult> {
  await recoverFailedLegacyMigrations(deps);
  const running = await deps.store.journal.operations.listByStatus(["running"]);
  const now = deps.now();
  let recovered = 0;
  for (const operation of running) {
    if (!claimedByPreviousController(operation, deps.controllerStartedAt)) continue;
    try {
      const didRecover = operation.kind === RETIRE_GATEWAY_KIND
        ? await rearmOrphanedRetirement(deps, operation.id)
        : await failOrphanedMigration(deps, operation, now);
      if (didRecover) recovered += 1;
    } catch (err) {
      deps.log(`[boot-orphan-recovery] ⚠ ${operation.id} recovery failed: ${String(err)}`);
    }
  }
  return { scanned: running.length, recovered };
}

export interface StartStuckOpReaperDeps extends StuckOpReaperDeps {
  intervalMs: number;
  runTick?: (deps: StuckOpReaperDeps) => Promise<StuckOpReaperResult>;
}

export function startStuckOpReaper(deps: StartStuckOpReaperDeps): () => void {
  const tick = deps.runTick ?? runStuckOpReaperTick;
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    (async () => {
      try {
        await tick(deps);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log(`[stuck-op-reaper] ⚠ tick failed — ${message}`);
      } finally {
        running = false;
      }
    })();
  }, deps.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
