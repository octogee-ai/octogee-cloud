import type {
  Operation,
  OperationStep,
  StepStatus,
} from "@octogee/shared/types/glm";
import type { GatewayLifecycleStatus } from "@octogee/shared/types/gateway-releases";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";

// recycle-gateway — a REAL pod reroll, distinct from restart-gateway (which is
// an in-process OpenClaw RPC restart that leaves the pod, restartCount, and the
// emptyDir untouched).
//
// It works THROUGH desired state, not around it: set glmGateways/{id}.
// desiredStatus = "paused" (the level-triggered reconciler scales the
// deployment to 0), wait for the pod to drain, then restore "running" (the
// reconciler brings up a FRESH pod). Driving the reconciler instead of calling
// scaleDeployment out-of-band is essential — the reconciler holds desired=1 and
// reacts to every glmGateways write, so an out-of-band scale-to-0 would be
// fought back up to 1 mid-drain (a race). Because the default pool is emptyDir,
// the fresh pod starts with a cleared /home/node/.openclaw and the entrypoint's
// boot-sync re-materializes BYOS + user state from the durable stores. On
// ANY failure after pausing, desiredStatus is restored to "running" so the
// gateway is never left wedged offline.

export interface RecycleGatewayDeps {
  readDesiredStatus: (gatewayId: string) => Promise<GatewayLifecycleStatus | null>;
  setDesiredStatus: (gatewayId: string, status: GatewayLifecycleStatus) => Promise<void>;
  readServingRevisionId: (gatewayId: string) => Promise<string | null>;
  readAvailableReplicas: (revisionId: string) => Promise<number | null>;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  drainTimeoutMs: number;
  readyTimeoutMs: number;
  pollIntervalMs: number;
}

interface RecycleGatewayInput {
  gatewayId?: unknown;
}

export function createRecycleGatewayHandler(deps: RecycleGatewayDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    const input = op.input as RecycleGatewayInput;
    const gatewayId = typeof input.gatewayId === "string" ? input.gatewayId : undefined;
    if (!gatewayId) {
      return { steps: [], success: false, error: "missing gatewayId in op.input" };
    }

    const prior = await deps.readDesiredStatus(gatewayId);
    if (prior !== "running") {
      return {
        steps: [],
        success: false,
        error: `gateway ${gatewayId} is ${prior ?? "absent"}, not running — only a running gateway can be recycled`,
      };
    }
    const revisionId = await deps.readServingRevisionId(gatewayId);
    if (!revisionId) {
      return {
        steps: [],
        success: false,
        error: `gateway ${gatewayId} has no validated serving revision`,
      };
    }

    try {
      await deps.setDesiredStatus(gatewayId, "paused");

      const drain = await pollStep({
        deps,
        ctx,
        stepName: "drain",
        gatewayId,
        revisionId,
        timeoutMs: deps.drainTimeoutMs,
        ready: (available) => available === 0,
        timeoutMessage: `gateway ${gatewayId} did not drain to 0 replicas`,
      });
      if (!drain.ok) {
        await restoreRunning(deps, gatewayId);
        return { steps: [], success: false, error: drain.errorMsg };
      }

      await deps.setDesiredStatus(gatewayId, "running");

      const restore = await pollStep({
        deps,
        ctx,
        stepName: "restore",
        gatewayId,
        revisionId,
        timeoutMs: deps.readyTimeoutMs,
        ready: (available) => available !== null && available >= 1,
        timeoutMessage: `gateway ${gatewayId} did not become ready after reroll`,
      });
      if (!restore.ok) {
        // desiredStatus is already "running" — the reconciler keeps trying.
        return { steps: [], success: false, error: restore.errorMsg };
      }

      deps.log(`[recycle-gateway] ${gatewayId} rerolled — fresh pod up, boot-sync restored state`);
      return { steps: [], success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await restoreRunning(deps, gatewayId);
      return { steps: [], success: false, error: message };
    }
  };
}

async function restoreRunning(deps: RecycleGatewayDeps, gatewayId: string): Promise<void> {
  try {
    await deps.setDesiredStatus(gatewayId, "running");
  } catch (err) {
    deps.log(
      `[recycle-gateway] FAILED to restore ${gatewayId} to running after a recycle error — ` +
        `gateway may be wedged paused, operator attention needed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface PollResult {
  ok: boolean;
  errorMsg?: string;
}

async function pollStep(args: {
  deps: RecycleGatewayDeps;
  ctx: OperationContext;
  stepName: string;
  gatewayId: string;
  revisionId: string;
  timeoutMs: number;
  ready: (available: number | null) => boolean;
  timeoutMessage: string;
}): Promise<PollResult> {
  const { deps, ctx, stepName, revisionId, timeoutMs, ready, timeoutMessage } = args;
  const startedAt = deps.now();
  await reportStep(ctx, { name: stepName, status: "running", startedAt });

  const deadline = startedAt + timeoutMs;
  for (;;) {
    if (ready(await deps.readAvailableReplicas(revisionId))) {
      await reportStep(ctx, { name: stepName, status: "done", startedAt, completedAt: deps.now() });
      return { ok: true };
    }
    if (deps.now() >= deadline) {
      await reportStep(ctx, {
        name: stepName,
        status: "failed",
        startedAt,
        completedAt: deps.now(),
        error: timeoutMessage,
      });
      return { ok: false, errorMsg: timeoutMessage };
    }
    await deps.wait(deps.pollIntervalMs);
  }
}

async function reportStep(
  ctx: OperationContext,
  step: OperationStep & { status: StepStatus },
): Promise<void> {
  await ctx.reportStep(step);
}
