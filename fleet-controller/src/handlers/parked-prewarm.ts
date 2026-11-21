import {
  finishParkedGatewayPrewarm,
  parkedPrewarmInput,
  startParkedGatewayPrewarm,
} from "@octogee/core/isolated-gateway-lifecycle";
import type { PlatformStateStore, WatchAggregate, WatchEvent, WatchRecords } from "@octogee/core/platform-state";
import type { OperationStep } from "@octogee/shared/types/glm";
import type { OperationHandler } from "../operation-router.js";
import type { VmGatewayRuntime } from "../vm-gateway-runtime.js";

export interface ParkedPrewarmDeps {
  store: PlatformStateStore;
  readVmRuntime: () => VmGatewayRuntime | null;
  probeReady: (gatewayId: string, instanceId: string) => Promise<boolean>;
  requestReconcileTick: (gatewayId: string) => void;
  now: () => number;
  log?: (message: string) => void;
  timeoutMs?: number;
}

function phaseWake(deps: ParkedPrewarmDeps, gatewayId: string, uid: string) {
  let revision = 0;
  let settle: (() => void) | undefined;
  const wake = () => {
    revision += 1;
    settle?.();
  };
  const onError = (error: unknown) => {
    deps.log?.(`[parked-prewarm] ${gatewayId} state watch failed: ${String(error)}`);
  };
  const whenChanged = <A extends WatchAggregate>(signature: (record: WatchRecords[A]) => string) => {
    let previous: string | undefined;
    return (event: WatchEvent<A>) => {
      const next = event.kind === "snapshot" ? event.records.at(-1)
        : event.kind === "changes" ? event.changes.at(-1)?.record : null;
      const current = next ? signature(next) : undefined;
      if (event.kind !== "changes" || current !== previous) wake();
      previous = current;
    };
  };
  const roots = deps.store.watch({ aggregate: "gateways", filter: { gatewayId } }, {
    onEvent: whenChanged<"gateways">((root) => JSON.stringify([root.desiredStatus, root.desiredRelease, root.liveRelease, root.allocation?.generation])), onError,
  });
  const runtime = deps.store.watch({ aggregate: "fleetRegistry", filter: { gatewayId } }, {
    onEvent: whenChanged<"fleetRegistry">((record) => JSON.stringify([record.release, record.vm?.status, record.vm?.instanceId, record.heartbeat.status])), onError,
  });
  const owner = deps.store.watch({ aggregate: "builders", filter: { uid } }, {
    onEvent: whenChanged<"builders">((record) => JSON.stringify([record.gateway?.gatewayId, record.activationLease?.status, record.activationLease?.generation])), onError,
  });
  return {
    revision: () => revision,
    async wait(after: number, ms: number): Promise<void> {
      if (revision !== after) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => settle?.(), ms);
        settle = () => {
          clearTimeout(timer);
          settle = undefined;
          resolve();
        };
      });
    },
    close: () => Promise.all([roots.close(), runtime.close(), owner.close()]),
  };
}

export function createParkedPrewarmHandler(deps: ParkedPrewarmDeps): OperationHandler {
  return async (op, ctx) => {
    const { gatewayId, uid, generation, bootImageId } = parkedPrewarmInput(op);
    const runtime = deps.readVmRuntime();
    if (!runtime) throw new Error("Parked computer prewarm requires the GCE runtime");
    const existing = await deps.store.journal.operations.get(op.id);
    if (existing?.output?.prewarmState !== "booting" && existing?.output?.prewarmState !== "parked" && existing?.output?.prewarmState !== "handoff") {
      if (await runtime.prewarmBootImageId(gatewayId) !== bootImageId) {
        throw new Error("Parked computer prewarm boot image is no longer current");
      }
      const source = await runtime.prewarmVmObservation(gatewayId, uid);
      if (source?.status !== "SUSPENDED") {
        return { success: true, steps: [], output: { prewarmState: "ineligible" } };
      }
    }
    await ctx.assertActiveClaim?.();
    const started = await startParkedGatewayPrewarm(deps.store, op, deps.now());
    if (!("claim" in started)) return { success: true, steps: [], output: { prewarmState: started.state } };

    const { claim } = started;
    const deadline = deps.now() + (deps.timeoutMs ?? 20 * 60_000);
    let state = started.state;
    const steps: OperationStep[] = [...op.steps];
    const wake = phaseWake(deps, gatewayId, uid);

    try {
      deps.requestReconcileTick(gatewayId);
      while (deps.now() < deadline) {
        await ctx.assertActiveClaim?.();
        const revision = wake.revision();
        const [root, registry, owner] = await Promise.all([
          deps.store.gateways.roots.get(gatewayId),
          deps.store.fleetRegistry.get(gatewayId),
          deps.store.users.records.get(uid),
        ]);
        if (state === "handoff" && root?.ownerUid === uid && root.allocation?.generation !== generation &&
            owner?.activationLease?.targetGatewayId === gatewayId) {
          return { success: true, steps, output: { ...claim, prewarmState: "demand-won", bootImageId, instanceId: registry?.vm?.instanceId } };
        }
        if (state === "parked" && (root?.allocation?.generation !== generation ||
            (owner?.activationLease?.status === "requested" || owner?.gateway?.gatewayId === gatewayId))) {
          return { success: true, steps, output: { ...claim, prewarmState: "demand-won", bootImageId, instanceId: registry?.vm?.instanceId } };
        }
        if (state === "parked" && root?.desiredStatus === "paused" && registry?.vm?.status === "SUSPENDED") {
          const observed = await runtime.prewarmVmObservation(gatewayId, uid);
          if (observed?.status === "SUSPENDED" && observed.bootImageId === bootImageId) {
            return { success: true, steps, output: { ...claim, prewarmState: "parked", bootImageId, instanceId: observed.instanceId } };
          }
        }
        const instanceId = state === "booting" && root?.liveRelease === claim.release && registry?.release === claim.release &&
          registry.vm?.status === "RUNNING" ? registry.vm.instanceId : null;
        if (instanceId && await deps.probeReady(gatewayId, instanceId)) {
          const observed = await runtime.prewarmVmObservation(gatewayId, uid);
          if (observed?.status !== "RUNNING" || observed.instanceId !== instanceId) {
            await wake.wait(revision, Math.max(0, Math.min(5_000, deadline - deps.now())));
            continue;
          }
          if (observed.bootImageId !== bootImageId) throw new Error("Prewarm booted an image other than the requested image");
          const step = {
            name: "verify-prewarmed-computer", status: "done" as const, completedAt: deps.now(),
            detail: `instance=${instanceId} bootImage=${bootImageId}`,
          };
          await ctx.reportStep(step);
          steps.push(step);
          const finished = await finishParkedGatewayPrewarm(deps.store, op, deps.now(), "ready");
          if (finished === "demand-won") {
            return { success: true, steps, output: { ...claim, prewarmState: finished, bootImageId, instanceId: observed.instanceId } };
          }
          state = finished;
          if (state === "parked") deps.requestReconcileTick(gatewayId);
        }
        await wake.wait(revision, Math.max(0, Math.min(instanceId ? 5_000 : 30_000, deadline - deps.now())));
      }
      throw new Error("Timed out waiting for the prewarmed computer to reach a verified suspended state");
    } catch (error) {
      if (state === "booting" || state === "handoff") {
        await ctx.assertActiveClaim?.();
        await finishParkedGatewayPrewarm(deps.store, op, deps.now(), "rollback");
        deps.requestReconcileTick(gatewayId);
      }
      throw error;
    } finally {
      await wake.close();
    }
  };
}
