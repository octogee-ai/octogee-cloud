import {
  bootRepairedParkedGateway,
  finishParkedGatewayPrewarm,
  isFreshParkedPrewarmRecovery,
  parkedPrewarmInput,
  startParkedGatewayPrewarm,
} from "@octogee/core/isolated-gateway-lifecycle";
import type { FleetRegistryRecord, GatewayRoot, PlatformStateStore, PlatformUserRecord, WatchAggregate, WatchEvent, WatchRecords } from "@octogee/core/platform-state";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
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
      let next: WatchRecords[A] | null | undefined;
      if (event.kind === "snapshot") next = event.records.at(-1);
      if (event.kind === "changes") next = event.changes.at(-1)?.record;
      const current = next ? signature(next) : undefined;
      if (event.kind !== "changes" || current !== previous) wake();
      previous = current;
    };
  };
  const roots = deps.store.watch({ aggregate: "gateways", filter: { gatewayId } }, {
    onEvent: whenChanged<"gateways">((root) => JSON.stringify([root.desiredStatus, root.desiredRelease, root.liveRelease, root.allocation?.generation])), onError,
  });
  const runtime = deps.store.watch({ aggregate: "fleetRegistry", filter: { gatewayId } }, {
    onEvent: whenChanged<"fleetRegistry">((record) => JSON.stringify([record.release, record.vm?.status, record.vm?.instanceId, record.heartbeat.status, record.vmBootRecovery?.observedAt])), onError,
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

type Claim = Extract<Awaited<ReturnType<typeof startParkedGatewayPrewarm>>, { claim: unknown }>["claim"];
type Phase = "booting" | "repairing" | "repair-parking" | "parked" | "handoff";
type State = {
  root: GatewayRoot | null;
  registry: FleetRegistryRecord | null;
  owner: PlatformUserRecord | null;
};
interface PrewarmRun {
  deps: ParkedPrewarmDeps;
  ctx: OperationContext;
  op: Operation;
  runtime: VmGatewayRuntime;
  request: ReturnType<typeof parkedPrewarmInput>;
  claim: Claim;
  steps: OperationStep[];
}

function prewarmResult(run: PrewarmRun, prewarmState: "parked" | "demand-won", instanceId?: string | null): OperationResult {
  return {
    success: true, steps: run.steps,
    output: { ...run.claim, prewarmState, bootImageId: run.request.bootImageId, instanceId },
  };
}

async function recordVerifiedStep(run: PrewarmRun, name: string, instanceId: string, bootImageId: string) {
  const step = { name, status: "done" as const, completedAt: run.deps.now(), detail: `instance=${instanceId} bootImage=${bootImageId}` };
  await run.ctx.reportStep(step);
  run.steps = [...run.steps.filter((existing) => existing.name !== name), step];
}

function originalVmIsRunning(run: PrewarmRun, state: State): boolean {
  return state.root?.liveRelease === run.claim.previousRelease &&
    state.registry?.vm?.instanceId === run.claim.previousInstanceId && state.registry.vm.status === "RUNNING";
}

async function originalVmRecovered(run: PrewarmRun, state: State): Promise<boolean> {
  const { gatewayId, uid } = run.request;
  const { previousInstanceId } = run.claim;
  if (!state.registry || !originalVmIsRunning(run, state)) return false;
  const operation = await run.deps.store.journal.operations.get(run.op.id);
  if (!isFreshParkedPrewarmRecovery(state.registry.vmBootRecovery, previousInstanceId, operation?.output?.repairStartedAt) ||
      !await run.deps.probeReady(gatewayId, previousInstanceId)) return false;
  const observed = await run.runtime.prewarmVmObservation(gatewayId, uid);
  if (observed?.status !== "RUNNING" || observed.instanceId !== previousInstanceId) return false;
  if (observed.bootImageId !== operation?.output?.previousBootImageId) throw new Error("Original VM boot image changed during recovery");
  await recordVerifiedStep(run, "verify-original-boot-recovery", previousInstanceId, observed.bootImageId);
  return true;
}

async function verifiedCandidateVm(run: PrewarmRun, state: State): Promise<string | null> {
  const { gatewayId, uid, bootImageId } = run.request;
  const { root, registry } = state;
  const release = run.claim.release;
  if (root?.liveRelease !== release || registry?.release !== release || registry.vm?.status !== "RUNNING" ||
      !registry.vm.instanceId || !await run.deps.probeReady(gatewayId, registry.vm.instanceId)) return null;
  const observed = await run.runtime.prewarmVmObservation(gatewayId, uid);
  if (observed?.status !== "RUNNING" || observed.instanceId !== registry.vm.instanceId) return null;
  if (observed.bootImageId !== bootImageId) throw new Error("Prewarm booted an image other than the requested image");
  await recordVerifiedStep(run, "verify-prewarmed-computer", observed.instanceId, bootImageId);
  return observed.instanceId;
}

function ownerHasDemand(state: State, gatewayId: string) {
  return state.owner?.activationLease?.status === "requested" || state.owner?.gateway?.gatewayId === gatewayId;
}

async function parkedCandidateResult(run: PrewarmRun, state: State): Promise<OperationResult | null> {
  const { gatewayId, uid, generation, bootImageId } = run.request;
  const { root, registry } = state;
  if (root?.allocation?.generation !== generation || ownerHasDemand(state, gatewayId)) {
    return prewarmResult(run, "demand-won", registry?.vm?.instanceId);
  }
  if (root.desiredStatus !== "paused" || registry?.vm?.status !== "SUSPENDED") return null;
  const observed = await run.runtime.prewarmVmObservation(gatewayId, uid);
  return observed?.status === "SUSPENDED" && observed.bootImageId === bootImageId ? prewarmResult(run, "parked", observed.instanceId) : null;
}

async function authorizedRepairPark(run: PrewarmRun, state: State): Promise<boolean> {
  if (state.owner?.activationLease?.status === "requested") return true;
  if (state.registry?.vm?.status !== "SUSPENDED") return false;
  const { gatewayId, uid } = run.request;
  const observed = await run.runtime.prewarmVmObservation(gatewayId, uid);
  return observed?.status === "SUSPENDED" && observed.instanceId === run.claim.previousInstanceId;
}

function handoffProgress(run: PrewarmRun, state: State): Phase | OperationResult {
  const { uid, gatewayId, generation } = run.request;
  const taken = state.root?.ownerUid === uid && state.root.allocation?.generation !== generation &&
    state.owner?.activationLease?.targetGatewayId === gatewayId;
  return taken ? prewarmResult(run, "demand-won", state.registry?.vm?.instanceId) : "handoff";
}

async function progressPhase(run: PrewarmRun, phase: Phase, state: State): Promise<Phase | OperationResult> {
  const { deps, op } = run;
  if (phase === "parked") return await parkedCandidateResult(run, state) ?? phase;
  if (phase === "handoff") return handoffProgress(run, state);
  if (state.owner?.activationLease?.status !== "requested") {
    const { sourceGatewayId, sourceAssignmentEpoch } = run.claim;
    const assignment = await deps.store.gateways.assignments.get(sourceGatewayId, run.request.uid);
    if (state.owner?.gateway?.gatewayId !== sourceGatewayId || assignment?.state !== "serving" || assignment.epoch !== sourceAssignmentEpoch) {
      throw new Error("Shared assignment changed during parked computer upgrade");
    }
  }
  if (phase === "repair-parking") {
    if (!await authorizedRepairPark(run, state)) return phase;
    const next = await bootRepairedParkedGateway(deps.store, op, deps.now());
    return next === "demand-won" ? prewarmResult(run, next, state.registry?.vm?.instanceId) : next;
  }
  let instanceId: string | null;
  if (phase === "repairing") {
    if (!await originalVmRecovered(run, state)) return phase;
    instanceId = run.claim.previousInstanceId;
  } else {
    instanceId = await verifiedCandidateVm(run, state);
    if (!instanceId) return phase;
  }
  const next = await finishParkedGatewayPrewarm(deps.store, op, deps.now(), phase === "repairing" ? "repaired" : "ready");
  return next === "demand-won" ? prewarmResult(run, next, instanceId) : next;
}

async function readPrewarmState(run: PrewarmRun): Promise<State> {
  const { gatewayId, uid } = run.request;
  const store = run.deps.store;
  const [root, registry, owner] = await Promise.all([
    store.gateways.roots.get(gatewayId), store.fleetRegistry.get(gatewayId), store.users.records.get(uid),
  ]);
  return { root, registry, owner };
}

async function drivePrewarm(run: PrewarmRun, initialPhase: Phase): Promise<OperationResult> {
  const { deps, op, ctx } = run;
  const { gatewayId, uid } = run.request;
  const deadline = deps.now() + (deps.timeoutMs ?? 20 * 60_000);
  const wake = phaseWake(deps, gatewayId, uid);
  let phase = initialPhase;
  try {
    deps.requestReconcileTick(gatewayId);
    while (deps.now() < deadline) {
      await ctx.assertActiveClaim?.();
      const revision = wake.revision();
      const state = await readPrewarmState(run);
      const next = await progressPhase(run, phase, state);
      if (typeof next !== "string") return next;
      if (phase !== next) deps.requestReconcileTick(gatewayId);
      phase = next;
      const checkingLive = ["booting", "repairing"].includes(phase) && state.registry?.vm?.status === "RUNNING";
      await wake.wait(revision, Math.max(0, Math.min(checkingLive ? 5_000 : 30_000, deadline - deps.now())));
    }
    throw new Error("Timed out waiting for the prewarmed computer to reach a verified suspended state");
  } catch (error) {
    if (phase !== "parked") {
      await ctx.assertActiveClaim?.();
      await finishParkedGatewayPrewarm(deps.store, op, deps.now(), "rollback");
      deps.requestReconcileTick(gatewayId);
    }
    throw error;
  } finally {
    await wake.close();
  }
}

export function createParkedPrewarmHandler(deps: ParkedPrewarmDeps): OperationHandler {
  return async (op, ctx) => {
    const request = parkedPrewarmInput(op);
    const { gatewayId, uid, bootImageId } = request;
    const runtime = deps.readVmRuntime();
    if (!runtime) throw new Error("Parked computer prewarm requires the GCE runtime");
    const existing = await deps.store.journal.operations.get(op.id);
    let source;
    if (existing?.output?.prewarmState === undefined) {
      const publishedImageId = await runtime.prewarmBootImageId(gatewayId);
      if (publishedImageId !== bootImageId) {
        return { success: true, steps: [], output: { prewarmState: "superseded", bootImageId, publishedImageId } };
      }
      source = await runtime.prewarmVmObservation(gatewayId, uid);
      if (source?.status !== "SUSPENDED") {
        const [root, registry] = await Promise.all([deps.store.gateways.roots.get(gatewayId), deps.store.fleetRegistry.get(gatewayId)]);
        const status = source?.status ?? registry?.vm?.status;
        if (root?.gatewayClass === "isolated" && root.desiredStatus === "paused" && root.ownerUid === uid &&
            root.allocation?.generation === request.generation && (status === "RUNNING" || status === "SUSPENDING")) {
          throw new Error("Parked computer is still suspending");
        }
        return { success: true, steps: [], output: { prewarmState: "ineligible" } };
      }
    }
    await ctx.assertActiveClaim?.();
    const started = await startParkedGatewayPrewarm(deps.store, op, deps.now(), source ? {
      instanceId: source.instanceId, bootImageId: source.bootImageId,
      needsRepair: source.bootImageId !== bootImageId && !source.recoveryReady,
    } : undefined);
    if (!("claim" in started)) return { success: true, steps: [], output: { prewarmState: started.state } };
    return drivePrewarm({ deps, op, ctx, runtime, request, claim: started.claim, steps: [...op.steps] }, started.state);
  };
}
