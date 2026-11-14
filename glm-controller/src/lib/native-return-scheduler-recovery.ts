import { isDeepStrictEqual } from "node:util";
import { builderReturnOperationId, isUserReturnOperationIdFor } from "@octogee/core/user-activation-lease";
import { MigrationRpcError, type MigrationClient } from "@octogee/core/fleet-migration-client";
import { runNormalFleetMutation } from "@octogee/core/normal-fleet-mutation";
import type { PlatformUserRecord, FleetRegistryRecord, GatewayRoot, OperationRecord, PlatformStateStore, Stored } from "@octogee/core/platform-state";
import { readSchedulerMigrationIdentity } from "@octogee/shared/types/glm";
import { parseAgentId } from "@octogee/shared/types/identity";
import type { NativeVmReturnInput } from "./native-vm-return.js";

interface SchedulerHold { agentId: string; migrationId: string; operationId: string }
type RecoveryInput = NativeVmReturnInput & { sourceEpoch: number; hold: SchedulerHold };
export type RecoverAbandonedNativeScheduler = (
  input: RecoveryInput, scheduler: MigrationClient["scheduler"], assertActiveClaim: () => Promise<void>,
) => Promise<void>;

function ownsAgent(slug: string, agentId: string): boolean {
  const agent = parseAgentId(agentId);
  return agent.kind !== "unknown" && agent.username === slug;
}

export function reportedAbandonedNativeScheduler(
  error: unknown, scope: { gatewayId: string; slug: string; operationId: string },
): SchedulerHold | null {
  if (!(error instanceof MigrationRpcError) || error.status !== 500 ||
      !error.message.startsWith(`/quiesce/${scope.gatewayId}: 500 `)) return null;
  const details = error.details as { error?: unknown; message?: unknown } | undefined;
  if (details?.error !== "quiesce failed" || typeof details.message !== "string") return null;
  const match = /^Cron agent (\S+) is held for migration (mig-(builder-return-[a-z0-9-]+):scheduler:\d+:claim:\d+)$/.exec(details.message);
  if (!match || !ownsAgent(scope.slug, match[1]) || match[3] === scope.operationId ||
      !readSchedulerMigrationIdentity(match[3], match[2])) return null;
  return { agentId: match[1], migrationId: match[2], operationId: match[3] };
}

interface CurrentVm {
  instanceName: string;
  instanceId: string;
  zone: string;
  internalIp: string;
  homeId: string;
  homeSource: string;
}

interface SchedulerRecoveryDeps {
  store: PlatformStateStore;
  verifyRetiredTarget(gatewayId: string, assertCurrent: () => Promise<void>): Promise<boolean>;
  oldSourceAbsent(gatewayId: string): Promise<boolean>;
  verifyVm(computer: CurrentVm, input: RecoveryInput): Promise<boolean>;
}

function nativeReturnScope(op: OperationRecord | null, uid: string, slug: string): op is OperationRecord & {
  input: { fromGatewayId: string; toGatewayId: string };
} {
  if (!op) return false;
  return [
    op.kind === "migrate-user", op.origin === "automatic", op.createdBy === "glm-controller-placement-policy",
    op.inputUid === uid, op.input.uid === uid, op.input.userSlug === slug, op.input.source === "builder-activation-lease",
    typeof op.input.fromGatewayId === "string", typeof op.input.toGatewayId === "string",
    op.gatewayId === op.input.toGatewayId,
    op.cutoverCommittedAt === undefined, op.userMigrationV2 === undefined, op.sourceTransferExecution === undefined,
    op.cancellationRequestedAt === undefined, op.restoreAttempt === undefined, op.schedulerHandoffLost === undefined,
  ].every(Boolean);
}

function priorAbandonedReturn(op: Stored<OperationRecord> | null, input: RecoveryInput, generation: number) {
  if (!nativeReturnScope(op, input.uid, input.slug)) return null;
  const { fromGatewayId: source, toGatewayId: target } = op.input;
  const handoff = op.schedulerHandoff;
  const priorGeneration = Number(op.id.split("-g").at(-1));
  if (!handoff || !isUserReturnOperationIdFor(op.id, source) || !Number.isSafeInteger(priorGeneration)) return null;
  return [
    /^shared-[a-z0-9]+$/.test(target), source !== input.fromGatewayId, priorGeneration < generation,
    op.status === "failed", typeof op.completedAt === "number", Number(op.completedAt) < Number(input.claimedStartedAt),
    op.schedulerHandoffReleased === true, handoff.stageAfterCutover !== true,
    handoff.fromGatewayId === source, handoff.toGatewayId === target, handoff.uid === input.uid, handoff.slug === input.slug,
    handoff.migrationId === input.hold.migrationId, readSchedulerMigrationIdentity(op.id, handoff.migrationId) !== null,
    handoff.forwardRecovery?.schemaVersion === 1, handoff.forwardRecovery?.phase === "source-flushed",
  ].every(Boolean) ? { source, target, revision: op.revision } : null;
}

function activeReturnMatches(op: OperationRecord, input: RecoveryInput): boolean {
  const { uid, slug, fromGatewayId: source, toGatewayId: target } = input;
  const handoff = op.schedulerHandoff;
  if (!handoff) return false;
  return [
    op.status === "running", op.startedAt === input.claimedStartedAt, op.input.fromGatewayId === source,
    op.input.toGatewayId === target, handoff.fromGatewayId === source, handoff.toGatewayId === target,
    handoff.uid === uid, handoff.slug === slug, handoff.migrationId !== input.hold.migrationId,
    readSchedulerMigrationIdentity(op.id, handoff.migrationId)?.claimStartedAt === op.startedAt,
    handoff.forwardRecovery === undefined, op.schedulerHandoffReleased === false,
  ].every(Boolean);
}

function owningLeaseMatches(user: PlatformUserRecord, root: GatewayRoot, input: RecoveryInput): boolean {
  const { uid, slug, fromGatewayId: source, operationId } = input;
  const { activationLease: lease, fences } = user;
  const { allocation } = root;
  if (!lease || !allocation || !fences.migration) return false;
  return [
    user.gateway?.gatewayId === source, user.slug === slug, lease.status === "returning",
    lease.targetGatewayId === source, lease.returnOperationId === operationId,
    builderReturnOperationId(source, lease.generation) === operationId,
    Object.keys(fences).every(name => name === "migration"),
    fences.migration.operationId === operationId, fences.migration.state === "moving",
    (fences.migration.phase ?? "transferring") === "transferring",
    root.gatewayClass === "isolated", root.ownerUid === uid, root.builderSlug === slug, root.desiredStatus === "running",
    root.runtimeRestartFence === undefined, root.retirementClaim == null, root.liveRelease === root.desiredRelease,
    allocation.kind === "disposable-builder", allocation.claimedByUid === uid,
    allocation.leaseId === lease.leaseId, allocation.generation === lease.generation,
  ].every(Boolean);
}

function currentVm(user: PlatformUserRecord, runtime: FleetRegistryRecord): CurrentVm {
  const home = user.home.homeDisk;
  const { vm, vmHome = {} } = runtime;
  const checkpointHeld = [vmHome.returnOperationId, vmHome.checkpointRequestedAt, vmHome.parkRequestedAt].some(value => value !== undefined);
  if (runtime.runtime !== "gce-vm" || !vm || vm.status !== "RUNNING" || !vm.instanceName || !vm.instanceId ||
      !vm.zone || !vm.internalIp || typeof home?.id !== "string" || typeof home.source !== "string" || checkpointHeld) {
    throw new Error("abandoned scheduler VM or checkpoint custody changed");
  }
  return { instanceName: vm.instanceName, instanceId: vm.instanceId, zone: vm.zone, internalIp: vm.internalIp,
    homeId: home.id, homeSource: home.source };
}

async function readAuthority(store: PlatformStateStore, input: RecoveryInput) {
  const { uid, slug, fromGatewayId: source, operationId, hold } = input;
  return store.transaction({ label: "native-return-scheduler-recovery.authority", readOnly: true }, async tx => {
    const [user, op, old, root, runtime, assignment, assigned, active] = await Promise.all([
      tx.users.records.get(uid), tx.journal.operations.get(operationId), tx.journal.operations.get(hold.operationId),
      tx.gateways.roots.get(source), tx.fleetRegistry.get(source), tx.gateways.assignments.get(source, uid),
      tx.gateways.assignments.listAll(), tx.journal.operations.listForUid(uid, { statuses: ["pending", "running"] }),
    ]);
    if (!user?.activationLease || !root || !runtime || !assignment || !nativeReturnScope(op, uid, slug)) {
      throw new Error("abandoned scheduler return authority is unavailable");
    }
    const previous = priorAbandonedReturn(old, input, user.activationLease.generation);
    if (!previous || !activeReturnMatches(op, input) || !owningLeaseMatches(user, root, input)) {
      throw new Error("abandoned scheduler return authority changed");
    }
    const [oldRoot, oldRuntime] = await Promise.all([tx.gateways.roots.get(previous.source), tx.fleetRegistry.get(previous.source)]);
    const matches = [
      oldRoot === null, oldRuntime === null,
      assignment.state === "quiescing", assignment.epoch === input.sourceEpoch,
      assignment.slug === slug, assignment.updatedByOperationId === operationId,
      assigned.filter(row => row.uid === uid).length === 1,
      active.length === 1, active[0]?.id === operationId,
    ].every(Boolean);
    if (!matches) throw new Error("abandoned scheduler source or assignment changed");
    return { previous, computer: currentVm(user, runtime), liveRelease: root.liveRelease };
  });
}

export function createAbandonedNativeSchedulerRecovery(deps: SchedulerRecoveryDeps): RecoverAbandonedNativeScheduler {
  return async (input, scheduler, assertActiveClaim) => {
    if (input.claimedStartedAt === null || !ownsAgent(input.slug, input.hold.agentId)) throw new Error("abandoned scheduler claim is invalid");
    const read = async () => { await assertActiveClaim(); return readAuthority(deps.store, input); };
    const observed = await read();
    const assertCurrent = async () => {
      if (!isDeepStrictEqual(observed, await read())) throw new Error("abandoned scheduler authority changed");
    };
    const verifyPhysical = async () => {
      if (!await deps.oldSourceAbsent(observed.previous.source) ||
          !await deps.verifyRetiredTarget(observed.previous.target, assertCurrent) ||
          !await deps.verifyVm(observed.computer, input)) throw new Error("abandoned scheduler physical custody is unverified");
      await assertCurrent();
    };
    await verifyPhysical();
    await runNormalFleetMutation(deps.store, {
      actor: "cowboy", forced: false, what: "resume an abandoned Native Builder scheduler",
      why: "The current return reported the exact prior uncommitted scheduler hold on the retained VM",
      target: { uid: input.uid, gatewayId: input.fromGatewayId, operationId: input.operationId },
      preActionStatus: { ...observed, previousOperationId: input.hold.operationId },
      mutation: { kind: "resume-abandoned-native-scheduler", migrationId: input.hold.migrationId },
      action: async () => {
        await verifyPhysical();
        const reply = await scheduler({ gatewayId: input.fromGatewayId, slug: input.slug, migrationId: input.hold.migrationId, phase: "resume" });
        if (reply.operationId !== input.hold.migrationId || reply.phase !== "resume" || !reply.drained ||
            !reply.agentIds.includes(input.hold.agentId) || !reply.agentIds.every(agent => ownsAgent(input.slug, agent))) {
          throw new Error("abandoned scheduler resume acknowledgement changed");
        }
        await assertCurrent();
      },
    });
  };
}
