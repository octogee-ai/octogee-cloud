import { isDeepStrictEqual } from "node:util";
import type {
  PlatformUserRecord,
  FleetRegistryRecord,
  FleetRegistryVmHome,
  GatewayAssignment,
  GatewayRoot,
  OperationRecord,
  PlatformStateStore,
  PlatformStateTransaction,
  Stored,
} from "@octogee/core/platform-state";
import { legacyForwardRecoveryMatches } from "@octogee/core/fleet-state";
import { nativeReturnSourceIdentity, nativeReturnSourceState, type NativeReturnSourceState } from "./native-return-source-fence.js";
import { awaitHomeCheckpoint, readHomeCheckpointCompletedAt } from "./home-checkpoint.js";
import type { GatewayVmClient } from "./compute-vm.js";
import { nativeSchedulerRetirementForReturn } from "./native-scheduler-retirement.js";

export interface NativeVmReturnInput {
  fromGatewayId: string;
  toGatewayId: string;
  uid: string;
  slug: string;
  operationId: string;
  claimedStartedAt: number | null;
}

export type NativeSourcePark = { mode: "suspend" } | { mode: "stop"; reason: string };

export interface NativeReturnPark {
  parked: "suspended" | "stopped";
  stopReason?: string;
}

export interface NativeVmReturn {
  checkpointRequested: boolean;
  requestCheckpoint: () => Promise<void>;
  awaitCheckpoint: () => Promise<void>;
  release: () => Promise<void>;
  releaseWriterHold: () => Promise<void>;
  sourceVmStatus: () => Promise<string | null>;
  park: (park: NativeSourcePark) => Promise<NativeReturnPark>;
  acknowledgeCompletedSchedulerHandoff: () => Promise<void>;
}

type NativeReturnDeps = {
  store: PlatformStateStore;
  vm: Pick<GatewayVmClient, "describe" | "stop">;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

type Runtime = Stored<FleetRegistryRecord> | null;

function assertOwner(data: GatewayRoot | null, input: NativeVmReturnInput): void {
  if (data?.gatewayClass !== "isolated" ||
      data.ownerUid !== input.uid || data.builderSlug !== input.slug) {
    throw new Error(`native computer return ${input.fromGatewayId}: source ownership changed`);
  }
}

function returnRequest(runtime: Runtime, operationId: string): number | null {
  const home = runtime?.vmHome;
  if (home?.returnOperationId !== operationId) return null;
  if (typeof home.checkpointRequestedAt !== "number") throw new Error("native return checkpoint request is missing");
  return home.checkpointRequestedAt;
}

async function patchSourceHome(tx: PlatformStateTransaction, source: Stored<FleetRegistryRecord>, vmHome: FleetRegistryVmHome): Promise<void> {
  await tx.fleetRegistry.patch(source.gatewayId, { vmHome }, { revision: source.revision });
}

async function claimCheckpoint(deps: NativeReturnDeps, input: NativeVmReturnInput): Promise<number> {
  return deps.store.transaction({ label: "native-computer-return.claim-checkpoint" }, async (tx) => {
    const [source, user, root, operation] = await Promise.all([
      tx.fleetRegistry.get(input.fromGatewayId), tx.users.records.get(input.uid),
      tx.gateways.roots.get(input.fromGatewayId), tx.journal.operations.get(input.operationId),
    ]);
    if (!precutoverOperationMatches(operation, input) ||
        operation?.cancellationRequestedAt !== undefined && !forwardRecoveryMatches(operation, input)) {
      throw new Error("native return checkpoint claim authority changed");
    }
    assertOwner(root, input);
    if (source?.runtime !== "gce-vm" || !source.vm) throw new Error("native computer runtime changed");
    if (user?.gateway?.gatewayId !== input.fromGatewayId) {
      throw new Error("native computer return assignment changed before checkpoint");
    }
    const existing = returnRequest(source, input.operationId);
    if (existing !== null) return existing;
    if (source.vmHome?.checkpointRequestedAt != null) throw new Error("native computer has another checkpoint request");
    const requestedAt = deps.now();
    await patchSourceHome(tx, source, {
      ...source.vmHome,
      returnOperationId: input.operationId,
      checkpointRequestedAt: requestedAt,
      parkRequestedAt: requestedAt,
    });
    return requestedAt;
  });
}

const RETURN_HOLD_FIELDS: readonly string[] = ["returnOperationId", "checkpointRequestedAt", "parkRequestedAt"];

function releasedReturnHold(source: Stored<FleetRegistryRecord>): FleetRegistryVmHome {
  return Object.fromEntries(Object.entries(source.vmHome ?? {}).filter(([field]) => !RETURN_HOLD_FIELDS.includes(field)));
}

async function releaseUncommittedCheckpoint(deps: NativeReturnDeps, input: NativeVmReturnInput, requestedAt: number | null): Promise<void> {
  await deps.store.transaction({ label: "native-computer-return.release-checkpoint" }, async (tx) => {
    const [source, root, operation, user] = await Promise.all([
      tx.fleetRegistry.get(input.fromGatewayId), tx.gateways.roots.get(input.fromGatewayId),
      tx.journal.operations.get(input.operationId), tx.users.records.get(input.uid),
    ]);
    assertOwner(root, input);
    if (operation?.schedulerHandoff?.forwardRecovery !== undefined) {
      throw new Error("native return crossed the final transfer boundary and must roll forward");
    }
    if (!precutoverOperationMatches(operation, input) || user?.gateway?.gatewayId !== input.fromGatewayId) {
      throw new Error("native return checkpoint release authority changed");
    }
    const held = returnRequest(source, input.operationId);
    if (held === null) return;
    if (held !== requestedAt) throw new Error("native return checkpoint release authority changed");
    await patchSourceHome(tx, source!, releasedReturnHold(source!));
  });
}

export async function releaseNativeReturnSourceRecoveryHold(deps: NativeReturnDeps, input: NativeVmReturnInput): Promise<void> {
  const source = await deps.store.fleetRegistry.get(input.fromGatewayId);
  if (source?.runtime !== "gce-vm") throw new Error("native return source recovery runtime changed");
  const home = source.vmHome;
  if ((home?.returnOperationId !== undefined || home?.checkpointRequestedAt !== undefined) && home?.returnOperationId !== input.operationId) {
    throw new Error("native return source recovery retains a foreign checkpoint hold");
  }
  await releaseUncommittedCheckpoint(deps, input, returnRequest(source, input.operationId));
}

async function releaseCommittedWriterHold(deps: NativeReturnDeps, input: NativeVmReturnInput, requestedAt: number | null): Promise<void> {
  await deps.store.transaction({ label: "native-computer-return.release-writer-hold" }, async (tx) => {
    const [source, roots, operation, user, assignment] = await Promise.all([
      tx.fleetRegistry.get(input.fromGatewayId), tx.gateways.roots.getMany([input.fromGatewayId, input.toGatewayId]),
      tx.journal.operations.get(input.operationId), tx.users.records.get(input.uid),
      tx.gateways.assignments.get(input.toGatewayId, input.uid),
    ]);
    if (returnRequest(source, input.operationId) === null) return;
    const root = roots.get(input.fromGatewayId) ?? null;
    assertOwner(root, input);
    const exact = returnRequest(source, input.operationId) === requestedAt && committedOperationMatches(operation, input) &&
      user?.gateway?.gatewayId === input.toGatewayId && roots.get(input.toGatewayId)?.gatewayClass === "shared" &&
      sharedAssignmentMatches(assignment, input) && sourceCheckpointMatches(source, input) && root?.desiredStatus === "running";
    if (!exact) throw new Error("native return writer hold release authority changed");
    await patchSourceHome(tx, source!, releasedReturnHold(source!));
  });
}

function forwardRecoveryMatches(op: OperationRecord | null, input: NativeVmReturnInput): boolean {
  return op?.schedulerHandoff?.slug === input.slug && legacyForwardRecoveryMatches(input.operationId, {
    uid: input.uid, fromGatewayId: input.fromGatewayId, toGatewayId: input.toGatewayId,
  }, { ...op.schedulerHandoff });
}

function currentOperationMatches(op: OperationRecord | null, input: NativeVmReturnInput): boolean {
  return op?.kind === "migrate-user" && op.status === "running" &&
    typeof input.claimedStartedAt === "number" && op.startedAt === input.claimedStartedAt &&
    op.input?.uid === input.uid && op.input.fromGatewayId === input.fromGatewayId && op.input.toGatewayId === input.toGatewayId;
}

function precutoverOperationMatches(op: OperationRecord | null, input: NativeVmReturnInput): boolean {
  return currentOperationMatches(op, input) && op?.cutoverCommittedAt === undefined;
}

function committedOperationMatches(op: OperationRecord | null, input: NativeVmReturnInput): boolean {
  return currentOperationMatches(op, input) && typeof op?.cutoverCommittedAt === "number" && op.cutoverCommittedAt > 0;
}

function sharedAssignmentMatches(assignment: GatewayAssignment | null, input: NativeVmReturnInput): boolean {
  return assignment?.uid === input.uid && assignment.gatewayId === input.toGatewayId &&
    assignment.slug === input.slug && assignment.state === "serving";
}

function returnHoldMatches(runtime: Runtime, input: NativeVmReturnInput): boolean {
  const home = runtime?.vmHome;
  const requestedAt = returnRequest(runtime, input.operationId);
  return (home?.returnOperationId === undefined || home.returnOperationId === input.operationId) &&
    (requestedAt === null || home?.checkpointAcknowledgedAt === requestedAt && (home?.lastCheckpoint?.completedAt ?? 0) >= requestedAt);
}

function sourceCheckpointMatches(runtime: Runtime, input: NativeVmReturnInput): boolean {
  const checkpoint = runtime?.vmHome?.lastCheckpoint;
  if (runtime?.runtime !== "gce-vm" || typeof runtime.vm?.instanceId !== "string" ||
      checkpoint?.instanceId !== runtime.vm.instanceId || typeof checkpoint?.completedAt !== "number") return false;
  return returnHoldMatches(runtime, input);
}

type SourceIdentity = NonNullable<ReturnType<typeof nativeReturnSourceIdentity>>;
type PauseIntent = { requestStop: string | null } | { parkedAs: SourceIdentity; clearStop: boolean };

type StopRequest = { operationId: string; reason: string; claimedAt?: number };

function readStopRequest(source: Runtime): StopRequest | null {
  const request = source?.vmStopOnPark as Partial<StopRequest> | undefined;
  if (request === undefined) return null;
  if (typeof request?.operationId !== "string" || typeof request.reason !== "string" ||
      (request.claimedAt !== undefined && typeof request.claimedAt !== "number")) throw new Error("vmStopOnPark request is malformed");
  return request as StopRequest;
}

type PauseRecords = {
  user: Stored<PlatformUserRecord> | null;
  desired: Stored<GatewayRoot> | null;
  source: Runtime;
  operation: Stored<OperationRecord> | null;
  target: Stored<GatewayRoot> | null;
  assignment: Stored<GatewayAssignment> | null;
};

async function readPauseRecords(tx: PlatformStateTransaction, input: NativeVmReturnInput): Promise<PauseRecords> {
  const [user, roots, source, operation, assignment] = await Promise.all([
    tx.users.records.get(input.uid), tx.gateways.roots.getMany([input.fromGatewayId, input.toGatewayId]),
    tx.fleetRegistry.get(input.fromGatewayId), tx.journal.operations.get(input.operationId),
    tx.gateways.assignments.get(input.toGatewayId, input.uid),
  ]);
  return {
    user, source, operation, assignment,
    desired: roots.get(input.fromGatewayId) ?? null,
    target: roots.get(input.toGatewayId) ?? null,
  };
}

async function pauseCommittedSource(deps: NativeReturnDeps, input: NativeVmReturnInput, intent: PauseIntent): Promise<StopRequest | null> {
  return deps.store.transaction({ label: "native-computer-return.pause-source" }, async (tx) => {
    const records = await readPauseRecords(tx, input);
    const { user, desired, source } = records;
    assertOwner(desired, input);
    if (!pauseAuthorityMatches(input, records, intent)) throw new Error("native return source pause authority changed");
    const retirement = nativeSchedulerRetirementForReturn(input, user, source, records.operation);
    if (retirement && user!.fences.pendingNativeSchedulerRetirement === undefined) {
      await tx.users.records.setFence(input.uid, "pendingNativeSchedulerRetirement", retirement, "absent");
    }
    if (desired!.desiredStatus !== "paused") {
      await tx.gateways.roots.patch(input.fromGatewayId, { desiredStatus: "paused", updatedAt: deps.now(), updatedBy: input.operationId }, { revision: desired!.revision });
    }
    const token = readStopRequest(source);
    const claimed = token?.claimedAt !== undefined ? token : null;
    const stopOnPark = stopOnParkUpdate(input, intent, claimed);
    if (stopOnPark) await tx.fleetRegistry.patch(input.fromGatewayId, { vmStopOnPark: stopOnPark }, { revision: source!.revision });
    return claimed;
  });
}

function pauseAuthorityMatches(input: NativeVmReturnInput, records: PauseRecords, intent: PauseIntent): boolean {
  const { user, desired, source, operation, target, assignment } = records;
  return user?.gateway?.gatewayId === input.toGatewayId && target?.gatewayClass === "shared" &&
    sharedAssignmentMatches(assignment, input) && committedOperationMatches(operation, input) &&
    sourceCheckpointMatches(source, input) && ["running", "paused"].includes(desired?.desiredStatus ?? "") &&
    (!("parkedAs" in intent) || isDeepStrictEqual(intent.parkedAs, nativeReturnSourceIdentity(source ?? undefined, desired ?? undefined)));
}

function stopOnParkUpdate(input: NativeVmReturnInput, intent: PauseIntent, claimed: StopRequest | null): { operationId: string; reason: string } | { clear: true } | null {
  if ("requestStop" in intent) {
    if (claimed) return null;
    return intent.requestStop === null ? { clear: true } : { operationId: input.operationId, reason: intent.requestStop };
  }
  return intent.clearStop ? { clear: true } : null;
}

async function acknowledgeCompletedSchedulerHandoff(deps: NativeReturnDeps, input: NativeVmReturnInput): Promise<void> {
  await deps.store.transaction({ label: "native-computer-return.acknowledge-scheduler-handoff" }, async tx => {
    const { user, desired, source, operation, target, assignment } = await readPauseRecords(tx, input);
    assertOwner(desired, input);
    if (!committedOperationMatches(operation, input) || user?.gateway?.gatewayId !== input.toGatewayId ||
        target?.gatewayClass !== "shared" || !sharedAssignmentMatches(assignment, input) ||
        desired?.desiredStatus !== "paused" || !sourceCheckpointMatches(source, input) ||
        returnRequest(source, input.operationId) !== null) {
      throw new Error("native scheduler handoff completion authority changed");
    }
    const pending = nativeSchedulerRetirementForReturn(input, user, source, operation);
    if (pending) {
      await tx.users.records.setFence(input.uid, "pendingNativeSchedulerRetirement", {
        ...pending, completedAt: deps.now(), cutoverCommittedAt: operation!.cutoverCommittedAt,
      }, user.fences.pendingNativeSchedulerRetirement ?? "absent");
    }
  });
}

async function parkCommittedSource(deps: NativeReturnDeps, input: NativeVmReturnInput, park: NativeSourcePark): Promise<NativeReturnPark> {
  const stopReason = await pauseForPark(deps, input, park);
  const deadline = deps.now() + (deps.timeoutMs ?? 300_000);
  let observed = await parkedSourceState(deps, input);
  let stoppedSuspended = false;
  while (observed.state === "running" || (stopReason !== null && observed.state === "suspended")) {
    if (deps.now() >= deadline) throw new Error(`native return source ${stopReason === null ? "park" : "stop"} timed out`);
    if (observed.state === "suspended" && observed.identity && !stoppedSuspended) {
      await stopSuspendedSource(deps, input, observed.identity);
      stoppedSuspended = true;
    }
    await deps.wait(Math.min(5_000, deadline - deps.now()));
    observed = await parkedSourceState(deps, input);
  }
  await pauseCommittedSource(deps, input, { parkedAs: observed.identity!, clearStop: stopReason !== null });
  return stopReason === null ? { parked: observed.state === "suspended" ? "suspended" : "stopped" } : { parked: "stopped", stopReason };
}

async function pauseForPark(deps: NativeReturnDeps, input: NativeVmReturnInput, park: NativeSourcePark): Promise<string | null> {
  const requested = park.mode === "stop" ? park.reason : null;
  const inFlight = await pauseCommittedSource(deps, input, { requestStop: requested });
  return requested ?? (inFlight ? `a claimed stop of ${inFlight.operationId} is in flight: ${inFlight.reason}` : null);
}

async function stopSuspendedSource(deps: NativeReturnDeps, input: NativeVmReturnInput, identity: SourceIdentity): Promise<void> {
  if (await claimSuspendedSourceStop(deps, input)) await deps.vm.stop(identity.instanceName, identity.zone);
}

async function claimSuspendedSourceStop(deps: NativeReturnDeps, input: NativeVmReturnInput): Promise<boolean> {
  return deps.store.transaction({ label: "native-computer-return.claim-source-stop" }, async (tx) => {
    const [source, operation] = await Promise.all([
      tx.fleetRegistry.get(input.fromGatewayId), tx.journal.operations.get(input.operationId),
    ]);
    if (!committedOperationMatches(operation, input)) throw new Error("native return source stop authority changed");
    const token = readStopRequest(source);
    if (token?.operationId !== input.operationId) return false;
    if (token.claimedAt === undefined) {
      await tx.fleetRegistry.patch(input.fromGatewayId, { vmStopOnPark: { ...token, claimedAt: deps.now() } }, { revision: source!.revision });
    }
    return true;
  });
}

async function parkedSourceState(deps: NativeReturnDeps, input: NativeVmReturnInput): Promise<{ state: NativeReturnSourceState; identity: SourceIdentity | null }> {
  const [source, desired] = await Promise.all([
    deps.store.fleetRegistry.get(input.fromGatewayId),
    deps.store.gateways.roots.get(input.fromGatewayId),
  ]);
  assertOwner(desired, input);
  const identity = nativeReturnSourceIdentity(source ?? undefined, desired ?? undefined);
  return { state: identity ? await nativeReturnSourceState(deps.vm, identity) : "running", identity };
}

async function sourceVmStatus(deps: NativeReturnDeps, input: NativeVmReturnInput): Promise<string | null> {
  const vm = (await deps.store.fleetRegistry.get(input.fromGatewayId))?.vm;
  if (!vm || ![vm.instanceName, vm.zone, vm.instanceId].every(v => typeof v === "string" && v.length > 0)) {
    throw new Error(`native return source ${input.fromGatewayId} has no recorded computer`);
  }
  const current = await deps.vm.describe(vm.instanceName, vm.zone);
  if (current === null) return null;
  if (current.instanceId !== vm.instanceId) throw new Error(`native return source computer ${vm.instanceName} was replaced`);
  return current.status;
}

export async function prepareNativeVmReturn(
  deps: NativeReturnDeps,
  input: NativeVmReturnInput,
): Promise<NativeVmReturn | null> {
  const [source, roots] = await Promise.all([
    deps.store.fleetRegistry.get(input.fromGatewayId),
    deps.store.gateways.roots.getMany([input.toGatewayId, input.fromGatewayId]),
  ]);
  if (source?.runtime !== "gce-vm") return null;
  const target = roots.get(input.toGatewayId);
  if (!target) throw new Error(`native computer return target is unavailable: ${input.toGatewayId}`);
  if (target.gatewayClass !== "shared") return null;
  assertOwner(roots.get(input.fromGatewayId) ?? null, input);
  let requestedAt = returnRequest(source, input.operationId);
  return {
    checkpointRequested: requestedAt !== null,
    requestCheckpoint: async () => {
      requestedAt = await claimCheckpoint(deps, input);
    },
    awaitCheckpoint: async () => {
      if (requestedAt === null) return;
      const result = await awaitHomeCheckpoint({
        ...deps,
        readHomeCheckpointCompletedAt: (gatewayId) => readHomeCheckpointCompletedAt(deps.store, gatewayId),
      }, { gatewayId: input.fromGatewayId, requestedAt });
      if (result.outcome !== "completed") throw new Error(`native computer checkpoint ${result.outcome}; source retained`);
    },
    release: () => releaseUncommittedCheckpoint(deps, input, requestedAt),
    releaseWriterHold: () => releaseCommittedWriterHold(deps, input, requestedAt),
    sourceVmStatus: () => sourceVmStatus(deps, input),
    park: (park) => parkCommittedSource(deps, input, park),
    acknowledgeCompletedSchedulerHandoff: () => acknowledgeCompletedSchedulerHandoff(deps, input),
  };
}
