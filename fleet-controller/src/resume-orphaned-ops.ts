import { PARKED_PREWARM_KIND } from "@octogee/core/isolated-gateway-lifecycle";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import type { Operation } from "@octogee/shared/types/glm";
import { PARKED_PREWARM_CONCURRENCY } from "./operation-queue.js";

export interface ResumeOrphanedOpsDeps {
  store: Pick<PlatformStateRepositories, "journal">;
  log: (msg: string) => void;
  // Kinds safe to re-drive idempotently after a controller restart. The blue/green
  // rollout is the one that spans minutes and, if abandoned after its pre-migrate
  // repoint, leaves a split pool — so it must survive a restart.
  resumableKinds: ReadonlySet<string>;
  resumableOperation?: (op: Operation) => boolean;
  // Re-adopt the orphaned running op (bump heartbeat + resumeCount) and re-run its
  // handler from persisted progress. Supplied by the controller wiring.
  redrive: (op: Operation) => Promise<void>;
}

export interface ResumeOrphanedOpsResult {
  scanned: number;
  resumed: number;
}

// On boot the controller is the sole replica, so any op still marked `running` was
// orphaned by the previous instance exiting mid-op (deploy/restart/crash) — the
// `running` glmOperations record outlived the process driving it. For resumable
// kinds, re-drive it instead of leaving it for the stuck-op reaper: a reaped roll
// that already repointed the shared pointer at its (still-empty) target strands the
// users on the source pool. Re-driving is safe because the orchestrator is
// idempotent (spawn=set, migrate reads the shrinking source-assignment, repoint=set,
// retire=ensure-gone).
export async function resumeOrphanedRunningOps(
  deps: ResumeOrphanedOpsDeps,
): Promise<ResumeOrphanedOpsResult> {
  const running = await deps.store.journal.operations.listByStatus(["running"]);
  const prewarms: Operation[] = [];
  let resumed = 0;
  async function flushPrewarms() {
    await Promise.all(prewarms.splice(0).map(redrive));
  }
  async function redrive(op: Operation) {
    deps.log(
      `[resume-orphaned-ops] re-driving orphaned running op=${op.id} kind=${op.kind} (controller restarted mid-op)`,
    );
    try {
      await deps.redrive(op);
      resumed += 1;
    } catch (err) {
      deps.log(
        `[resume-orphaned-ops] ⚠ re-drive op=${op.id} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const op of running) {
    if (!deps.resumableKinds.has(op.kind)) continue;
    if (deps.resumableOperation && !deps.resumableOperation(op)) continue;
    if (!scopedPrewarm(op)) {
      await flushPrewarms();
      await redrive(op);
      continue;
    }
    if (prewarms.length === PARKED_PREWARM_CONCURRENCY ||
      prewarms.some(pending => pending.input.uid === op.input.uid || pending.input.gatewayId === op.input.gatewayId)) {
      await flushPrewarms();
    }
    prewarms.push(op);
  }
  await flushPrewarms();
  return { scanned: running.length, resumed };
}

function scopedPrewarm(op: Operation): boolean {
  return op.kind === PARKED_PREWARM_KIND && typeof op.input.uid === "string" && op.input.uid.length > 0 &&
    typeof op.input.gatewayId === "string" && op.input.gatewayId.length > 0;
}
