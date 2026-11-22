import { dualReadIsolatedProfileImage } from "@octogee/shared/types/gateway-releases";
import {
  bootRepairedParkedGateway,
  finishParkedGatewayPrewarm,
  guestReleaseInstalled,
  GUEST_RELEASE_MODE,
  isFreshParkedPrewarmRecovery,
  parkedPrewarmInput,
  startParkedGatewayPrewarm,
} from "@octogee/core/isolated-gateway-lifecycle";
import { isDeepStrictEqual } from "node:util";
import type { FleetRegistryRecord, GatewayRoot, PlatformStateStore, PlatformUserRecord, WatchAggregate, WatchEvent, WatchRecords } from "@octogee/core/platform-state";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import type { ParkedPrewarmVmObservation, VmGatewayRuntime } from "../vm-gateway-runtime.js";

const PREWARM_TIMEOUT_MS = 20 * 60_000;
const VERIFY_PREWARM_STEP = "verify-prewarmed-computer";
const PARKED = "parked";
const DEMAND_WON = "demand-won";

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
    onEvent: whenChanged<"fleetRegistry">((record) => JSON.stringify([record.release, record.vm?.status, record.vm?.instanceId, record.heartbeat.status, record.vmBootRecovery?.observedAt, record.vmImages?.observedAt])), onError,
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
type Phase = "booting" | "repairing" | "repair-parking" | typeof PARKED | "handoff";
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

function prewarmResult(run: PrewarmRun, prewarmState: typeof PARKED | typeof DEMAND_WON, instanceId?: string | null): OperationResult {
  return {
    success: true, steps: run.steps,
    output: { ...run.claim, prewarmState, bootImageId: run.claim.guestDisks?.bootImageId ?? run.request.bootImageId, instanceId,
      ...(run.claim.guestDisks ? { homeDiskId: run.claim.guestDisks.homeDiskId, bootDiskId: run.claim.guestDisks.bootDiskId } : {}) },
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

function observePrewarmVm(run: Pick<PrewarmRun, "runtime" | "request">): Promise<ParkedPrewarmVmObservation | null> {
  const { gatewayId, uid, mode } = run.request;
  return mode === GUEST_RELEASE_MODE ? run.runtime.prewarmVmObservation(gatewayId, uid, true) : run.runtime.prewarmVmObservation(gatewayId, uid);
}

function verifyPrewarmDisks(run: PrewarmRun, observed: ParkedPrewarmVmObservation): void {
  if (run.request.mode === GUEST_RELEASE_MODE) {
    if (!run.claim.guestDisks || observed.instanceId !== run.claim.previousInstanceId ||
      !isDeepStrictEqual(observed.guestDisks, run.claim.guestDisks)) throw new Error("Guest release changed the original VM or its disks");
  } else if (observed.bootImageId !== run.request.bootImageId) {
    throw new Error("Prewarm booted an image other than the requested image");
  }
}

function livePrewarmInstance(state: State, release: number): string | null {
  const { root, registry } = state;
  if (root?.liveRelease !== release || registry?.release !== release || registry.vm?.status !== "RUNNING") return null;
  return registry.vm.instanceId;
}

async function publishVerifiedGuestAgent(run: PrewarmRun, instanceId: string): Promise<void> {
  if (run.request.mode !== GUEST_RELEASE_MODE) return;
  await run.ctx.assertActiveClaim?.();
  const { gatewayId, uid, payload } = run.request;
  const image = payload.profileImages ? dualReadIsolatedProfileImage(payload.profileImages) : payload;
  await run.runtime.updateGuestAgentImage(gatewayId, uid, instanceId, `${image.imageRepository}:${image.imageTag}`);
}

async function verifiedCandidateVm(run: PrewarmRun, state: State): Promise<string | null> {
  const { gatewayId } = run.request;
  const instanceId = livePrewarmInstance(state, run.claim.release);
  if (!instanceId) return null;
  if (run.request.mode === GUEST_RELEASE_MODE &&
      !guestReleaseInstalled(run.request.payload, instanceId, state.registry?.vmImages, run.op.startedAt ?? run.op.createdAt)) return null;
  if (!await run.deps.probeReady(gatewayId, instanceId)) return null;
  const observed = await observePrewarmVm(run);
  if (observed?.status !== "RUNNING" || observed.instanceId !== instanceId) return null;
  verifyPrewarmDisks(run, observed);
  await publishVerifiedGuestAgent(run, instanceId);
  await recordVerifiedStep(run, VERIFY_PREWARM_STEP, instanceId, observed.bootImageId);
  return instanceId;
}

function ownerHasDemand(state: State, gatewayId: string) {
  return state.owner?.activationLease?.status === "requested" || state.owner?.gateway?.gatewayId === gatewayId;
}

function prewarmVerificationRecorded(run: PrewarmRun, observed: ParkedPrewarmVmObservation): boolean {
  if (run.request.mode === GUEST_RELEASE_MODE && Number.isSafeInteger(run.claim.guestVerifiedAt)) return true;
  const proof = `instance=${observed.instanceId} bootImage=${observed.bootImageId}`;
  return run.steps.some(step => step.name === VERIFY_PREWARM_STEP && step.status === "done" && step.detail === proof);
}

async function parkedCandidateResult(run: PrewarmRun, state: State): Promise<OperationResult | null> {
  const { gatewayId, generation } = run.request;
  const { root, registry } = state;
  if (root?.allocation?.generation !== generation || ownerHasDemand(state, gatewayId)) {
    return prewarmResult(run, DEMAND_WON, registry?.vm?.instanceId);
  }
  if (root.desiredStatus !== "paused" || registry?.vm?.status !== "SUSPENDED") return null;
  const observed = await observePrewarmVm(run);
  if (observed?.status !== "SUSPENDED") return null;
  verifyPrewarmDisks(run, observed);
  if (!prewarmVerificationRecorded(run, observed)) {
    throw new Error("Computer suspended without readiness verification for this instance and boot image");
  }
  return prewarmResult(run, PARKED, observed.instanceId);
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
  return taken ? prewarmResult(run, DEMAND_WON, state.registry?.vm?.instanceId) : "handoff";
}

async function assertPrewarmSourceAssignment(run: PrewarmRun, owner: State["owner"]): Promise<void> {
  if (owner?.activationLease?.status === "requested") return;
  const { sourceGatewayId, sourceAssignmentEpoch } = run.claim;
  const assignment = await run.deps.store.gateways.assignments.get(sourceGatewayId, run.request.uid);
  if (owner?.gateway?.gatewayId !== sourceGatewayId || assignment?.state !== "serving" || assignment.epoch !== sourceAssignmentEpoch) {
    throw new Error("Shared assignment changed during parked computer upgrade");
  }
}

async function progressPhase(run: PrewarmRun, phase: Phase, state: State): Promise<Phase | OperationResult> {
  const { deps, op } = run;
  if (phase === PARKED) return await parkedCandidateResult(run, state) ?? phase;
  if (phase === "handoff") return handoffProgress(run, state);
  await assertPrewarmSourceAssignment(run, state.owner);
  if (phase === "repair-parking") {
    if (!await authorizedRepairPark(run, state)) return phase;
    const next = await bootRepairedParkedGateway(deps.store, op, deps.now());
    return next === DEMAND_WON ? prewarmResult(run, next, state.registry?.vm?.instanceId) : next;
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
  return next === DEMAND_WON ? prewarmResult(run, next, instanceId) : next;
}

async function readPrewarmState(run: Pick<PrewarmRun, "deps" | "request">): Promise<State> {
  const { gatewayId, uid } = run.request;
  const store = run.deps.store;
  const [root, registry, owner] = await Promise.all([
    store.gateways.roots.get(gatewayId), store.fleetRegistry.get(gatewayId), store.users.records.get(uid),
  ]);
  return { root, registry, owner };
}

async function rejectedBootResult(run: PrewarmRun, root: State["root"]): Promise<OperationResult | null> {
  if (root?.desiredStatus === "running" && root.allocation?.generation === run.request.generation) return null;
  const output = (await run.deps.store.journal.operations.get(run.op.id))?.output;
  if (typeof output?.prewarmBootRejection !== "string") return null;
  run.deps.requestReconcileTick(run.request.gatewayId);
  if (output.prewarmState === DEMAND_WON) return { success: true, steps: run.steps, output };
  if (output.prewarmState !== PARKED) throw new Error("Rejected parked boot did not roll back");
  return { success: false, error: output.prewarmBootRejection, steps: run.steps, rolledBack: true, output };
}

async function drivePrewarm(run: PrewarmRun, initialPhase: Phase): Promise<OperationResult> {
  const { deps, op, ctx } = run;
  const { gatewayId, uid } = run.request;
  const deadline = deps.now() + (deps.timeoutMs ?? PREWARM_TIMEOUT_MS);
  const wake = phaseWake(deps, gatewayId, uid);
  let phase = initialPhase;
  try {
    deps.requestReconcileTick(gatewayId);
    while (deps.now() < deadline) {
      await ctx.assertActiveClaim?.();
      const revision = wake.revision();
      const state = await readPrewarmState(run);
      const next = await rejectedBootResult(run, state.root) ?? await progressPhase(run, phase, state);
      if (typeof next !== "string") return next;
      if (phase !== next) deps.requestReconcileTick(gatewayId);
      phase = next;
      const checkingLive = ["booting", "repairing"].includes(phase) && state.registry?.vm?.status === "RUNNING";
      await wake.wait(revision, Math.max(0, Math.min(checkingLive ? 5_000 : 30_000, deadline - deps.now())));
    }
    throw new Error("Timed out waiting for the prewarmed computer to reach a verified suspended state");
  } catch (error) {
    if (phase !== PARKED) {
      await ctx.assertActiveClaim?.();
      await finishParkedGatewayPrewarm(deps.store, op, deps.now(), "rollback");
      deps.requestReconcileTick(gatewayId);
    }
    throw error;
  } finally {
    await wake.close();
  }
}

function ownsParkedComputer(root: GatewayRoot | null, request: PrewarmRun["request"]): root is GatewayRoot {
  return root?.gatewayClass === "isolated" && root.desiredStatus === "paused" && root.ownerUid === request.uid &&
    root.allocation?.generation === request.generation && root.retirementClaim == null;
}

async function waitForParkedRetry(run: Pick<PrewarmRun, "deps" | "ctx" | "runtime" | "request">): Promise<ParkedPrewarmVmObservation | null> {
  const { deps, ctx, request } = run;
  const { gatewayId, uid } = request;
  const deadline = deps.now() + (deps.timeoutMs ?? PREWARM_TIMEOUT_MS);
  const wake = phaseWake(deps, gatewayId, uid);
  try {
    while (deps.now() < deadline) {
      await ctx.assertActiveClaim?.();
      const revision = wake.revision();
      const state = await readPrewarmState(run);
      if (!ownsParkedComputer(state.root, request) || (request.mode !== GUEST_RELEASE_MODE && ownerHasDemand(state, gatewayId))) return null;
      const vm = state.registry?.vm;
      if (vm?.status === "SUSPENDED" && vm.instanceId && state.root.liveRelease === state.root.desiredRelease) {
        const observed = await observePrewarmVm(run);
        if (observed?.status === "SUSPENDED" && observed.instanceId === vm.instanceId) return observed;
      }
      await wake.wait(revision, Math.max(0, Math.min(5_000, deadline - deps.now())));
    }
    throw new Error("Timed out waiting for the replacement computer to be recorded as suspended");
  } finally {
    await wake.close();
  }
}

async function retryIfStillSuspending(store: PlatformStateStore, request: PrewarmRun["request"], vmStatus?: string): Promise<void> {
  const { gatewayId } = request;
  const [root, registry] = await Promise.all([store.gateways.roots.get(gatewayId), store.fleetRegistry.get(gatewayId)]);
  const status = vmStatus ?? registry?.vm?.status;
  if (ownsParkedComputer(root, request) && (status === "RUNNING" || status === "SUSPENDING")) {
    throw new Error("Parked computer is still suspending");
  }
}

async function startingVm(run: Pick<PrewarmRun, "deps" | "ctx" | "op" | "runtime" | "request">) {
  if ((run.op.attempts ?? 0) > 0) return waitForParkedRetry(run);
  const { deps, request } = run;
  const source = await observePrewarmVm(run);
  if (source?.status === "SUSPENDED") return source;
  await retryIfStillSuspending(deps.store, request, source?.status);
  return null;
}

async function readStartingPrewarm(run: Pick<PrewarmRun, "deps" | "ctx" | "op" | "runtime" | "request">): Promise<
  { source: ParkedPrewarmVmObservation } | OperationResult
> {
  const { request, runtime } = run;
  if (request.mode !== GUEST_RELEASE_MODE) {
    const publishedImageId = await runtime.prewarmBootImageId(request.gatewayId);
    if (publishedImageId !== request.bootImageId) {
      return { success: true, steps: [], output: { prewarmState: "superseded", bootImageId: request.bootImageId, publishedImageId } };
    }
  }
  const source = await startingVm(run);
  return source ? { source } : { success: true, steps: [], output: { prewarmState: "ineligible" } };
}

function originalPrewarmVm(source: ParkedPrewarmVmObservation, request: PrewarmRun["request"]) {
  return {
    instanceId: source.instanceId, bootImageId: source.bootImageId,
    needsRepair: request.mode !== GUEST_RELEASE_MODE && source.bootImageId !== request.bootImageId && !source.recoveryReady,
    ...(source.guestDisks ? { guestDisks: source.guestDisks } : {}),
  };
}

export function createParkedPrewarmHandler(deps: ParkedPrewarmDeps): OperationHandler {
  return async (op, ctx) => {
    const request = parkedPrewarmInput(op);
    const runtime = deps.readVmRuntime();
    if (!runtime) throw new Error("Parked computer prewarm requires the GCE runtime");
    const existing = await deps.store.journal.operations.get(op.id);
    let source;
    if (existing?.output?.prewarmState === undefined) {
      const starting = await readStartingPrewarm({ deps, op, ctx, runtime, request });
      if (!("source" in starting)) return starting;
      source = starting.source;
    }
    await ctx.assertActiveClaim?.();
    const started = await startParkedGatewayPrewarm(deps.store, op, deps.now(), source && originalPrewarmVm(source, request));
    if (!("claim" in started)) return { success: true, steps: [], output: {
      ...(started.state === DEMAND_WON && typeof existing?.output?.prewarmBootRejection === "string" ? existing.output : {}),
      prewarmState: started.state,
    } };
    return drivePrewarm({ deps, op, ctx, runtime, request, claim: started.claim, steps: [...op.steps] }, started.state);
  };
}
