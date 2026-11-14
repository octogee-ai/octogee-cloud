import { isDeepStrictEqual } from "node:util";
import { builderReturnOperationId } from "@octogee/core/isolated-operation-ids";
import { isolatedRuntimeMutationFenced } from "@octogee/core/gateway-retirement-claim";
import type {
  UserActivationLease,
  PlatformUserRecord,
  FleetRegistryRecord,
  GatewayAssignment,
  GatewayRoot,
  OperationRecord,
  PlatformStateStore,
  PlatformStateTransaction,
  Stored,
} from "@octogee/core/platform-state";
import { readSchedulerMigrationIdentity, type Operation } from "@octogee/shared/types/glm";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { AgentStoreHandoffAuthority, PrepareMigrationAgentStores } from "./migration-agent-stores.js";
import type { OperationContext, OperationResult } from "./operation-router.js";
import type { NativeVmReturnInput } from "./lib/native-vm-return.js";

export interface NativeReturnRecoveryIntent {
  leaseId: string;
  generation: number;
  sourceEpoch: number;
  failedAt: number;
  schedulerMigrationId: string;
  sourceVm: { instanceName: string; instanceId: string; zone: string };
  targetRetirement: { operationId: string; version: number; createdAt: number; completedAt: number };
  completedAt?: number;
}
export interface NativeReturnRecoveryRequest { uid: string; operationId: string; requestedAt: number; requestedBy: string }
export class NativeReturnRecoveryConflict extends Error {}
interface RecoveryDeps {
  store: PlatformStateStore;
  now(): number;
  log(message: string): void;
  verifyRetiredTarget(gatewayId: string, assertCurrent: () => Promise<void>): Promise<boolean>;
  releaseSourceHold(input: NativeVmReturnInput): Promise<void>;
  prepareSourceStores: PrepareMigrationAgentStores;
  sourceClient(gatewayId: string, authority: AgentStoreHandoffAuthority): Promise<MigrationClient>;
}
interface RecoveryScope { uid: string; sourceId: string; targetId: string; slug: string }
function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new NativeReturnRecoveryConflict(message);
}
function identity(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value); }
function safeInteger(value: unknown): value is number { return Number.isSafeInteger(value); }
function returnLeaseMatches(user: PlatformUserRecord, scope: RecoveryScope, operationId: string): user is PlatformUserRecord & { activationLease: UserActivationLease } {
  const lease = user.activationLease;
  if (lease === null || !Number.isSafeInteger(lease.generation) || lease.generation < 1) return false;
  return [user.gateway?.gatewayId === scope.sourceId, user.slug === scope.slug,
    lease.status === "returning", lease.targetGatewayId === scope.sourceId, lease.returnOperationId === operationId,
    identity(lease.leaseId), operationId === builderReturnOperationId(scope.sourceId, lease.generation)].every(Boolean);
}
function ownedSourceMatches(source: GatewayRoot | null, scope: RecoveryScope, lease: UserActivationLease): boolean {
  if (source === null) return false;
  const allocation = source.allocation;
  return [source.gatewayId === scope.sourceId, source.gatewayClass === "builder",
    source.ownerUid === scope.uid, source.builderSlug === scope.slug, source.desiredStatus === "running",
    (source.liveRelease ?? 0) > 0, source.liveRelease === source.desiredRelease, source.latestRelease === source.desiredRelease,
    source.runtimeRestartFence === undefined, source.retirementClaim == null,
    allocation?.kind === "disposable-builder", allocation?.claimedByUid === scope.uid,
    allocation?.leaseId === lease.leaseId, allocation?.generation === lease.generation].every(Boolean);
}
function sourceLeaseMatches(user: Stored<PlatformUserRecord> | null, source: GatewayRoot | null, scope: RecoveryScope, operationId: string): boolean {
  if (user === null || !returnLeaseMatches(user, scope, operationId)) return false;
  const migration = user.fences.migration;
  return ownedSourceMatches(source, scope, user.activationLease) &&
    !isolatedRuntimeMutationFenced(user) &&
    (!user.accountLifecycle?.status || user.accountLifecycle.status === "active") &&
    (migration === undefined || migration.operationId === operationId);
}
function retirementRootMatches(root: GatewayRoot | null, gatewayId: string, version: number): boolean {
  if (root === null) return true;
  const claim = root.retirementClaim;
  return [root.gatewayClass === "shared", root.ownerUid == null, root.desiredStatus === "retired", root.retirementVersion === version,
    claim?.operationId === `shared-pool-retire-${gatewayId}`, claim?.version === version, claim?.phase === "claimed"].every(Boolean);
}
function retirementMatches(root: GatewayRoot | null, operation: OperationRecord | null, gatewayId: string, failedAt: number): boolean {
  if (operation === null) return false;
  const input = operation.input ?? {}, version = input.retirementClaimVersion;
  const { createdAt, completedAt } = operation;
  if (!safeInteger(version) || !safeInteger(createdAt) || !safeInteger(completedAt)) return false;
  return [retirementRootMatches(root, gatewayId, version), operation.kind === "retire-gateway", operation.status === "succeeded", operation.gatewayId === gatewayId,
    input.gatewayId === gatewayId, input.source === "shared-pool-scaler", input.retainData !== true, input.retainServiceAccount !== true,
    version > 0, createdAt >= failedAt, completedAt >= createdAt,
    ["helm-uninstall", "revoke-agent-store-credentials"].every(name => operation.steps?.some(step => step.name === name && step.status === "done"))].every(Boolean);
}
function terminalFailureReceipt(operation: OperationRecord): boolean {
  const { startedAt, completedAt } = operation;
  return operation.status === "failed" && operation.rolledBack === false && safeInteger(startedAt) && startedAt > 0 &&
    safeInteger(completedAt) && completedAt >= startedAt;
}
function recoveryPhase(operation: OperationRecord, claimedStartedAt?: number) {
  const input = operation.input;
  const prior = input.nativeReturnSourceRecovery as NativeReturnRecoveryIntent | undefined;
  requireState(prior === undefined || prior !== null && typeof prior === "object", "native return recovery intent is malformed");
  requireState(input.recoverSourceOnly === undefined || input.recoverSourceOnly === true && prior !== undefined, "native return recovery mode is malformed");
  const failedAt = prior?.failedAt ?? operation.completedAt;
  requireState(safeInteger(failedAt) && failedAt > 0, "native return recovery failure receipt is unavailable");
  requireState(claimedStartedAt === undefined ? terminalFailureReceipt(operation) :
    operation.status === "running" && operation.startedAt === claimedStartedAt && input.recoverSourceOnly === true, "native return recovery claim changed");
  return { prior, failedAt };
}
function assignmentMatches(assignment: GatewayAssignment | null, scope: RecoveryScope, operationId: string): assignment is GatewayAssignment {
  if (assignment === null) return false;
  return [assignment.uid === scope.uid, assignment.gatewayId === scope.sourceId, assignment.slug === scope.slug,
    Number.isSafeInteger(assignment.epoch), assignment.epoch > 0,
    assignment.state === "serving" || assignment.state === "quiescing" && assignment.updatedByOperationId === operationId].every(Boolean);
}
function sourceVmIdentity(runtime: FleetRegistryRecord | null, sourceId: string, operationId: string): NativeReturnRecoveryIntent["sourceVm"] | null {
  if (runtime === null) return null;
  const home = runtime.vmHome ?? {};
  const instanceName = runtime.vm?.instanceName, instanceId = runtime.vm?.instanceId, zone = runtime.vm?.zone;
  const custody = [runtime.gatewayId === sourceId, runtime.runtime === "gce-vm",
    home.returnOperationId === undefined || home.returnOperationId === operationId,
    home.checkpointRequestedAt === undefined || home.returnOperationId === operationId].every(Boolean);
  return custody && identity(instanceName) && identity(instanceId) && identity(zone) ? { instanceName, instanceId, zone } : null;
}
function handoffMatches(operation: OperationRecord, scope: RecoveryScope): boolean {
  const handoff = operation.schedulerHandoff;
  return [handoff?.uid === scope.uid, handoff?.slug === scope.slug, handoff?.fromGatewayId === scope.sourceId,
    handoff?.toGatewayId === scope.targetId, handoff?.stageAfterCutover !== true].every(Boolean);
}
function assertCapturedIntent(prior: NativeReturnRecoveryIntent | undefined, intent: NativeReturnRecoveryIntent, claimedStartedAt?: number): void {
  if (prior) {
    const { completedAt, ...captured } = prior;
    requireState(completedAt === undefined || Number.isSafeInteger(completedAt), "native return recovery completion is malformed");
    requireState(isDeepStrictEqual(captured, intent), "native return recovery captured authority changed");
  }
  if (claimedStartedAt !== undefined) requireState(prior !== undefined, "native return recovery intent is unavailable");
}

function releasedCleanupRetryMatches(
  operation: OperationRecord,
  scheduler: NonNullable<ReturnType<typeof readSchedulerMigrationIdentity>>,
): boolean {
  const handoff = operation.schedulerHandoff;
  const latest = operation.attemptHistory?.at(-1);
  const held = operation.attemptHistory?.at(-2);
  const releasedAt = operation.schedulerHandoffReleasedAt;
  if (!handoff || !latest || !held || !safeInteger(releasedAt)) return false;
  const lastHeldStep = held.steps.at(-1);
  return [
    operation.schedulerHandoffReleased === true, releasedAt >= latest.completedAt,
    handoff.forwardRecovery === undefined, handoff.sourceRecovery === undefined,
    operation.steps?.length === 0, latest.steps.length === 0,
    latest.attempt === operation.attempts, latest.startedAt === operation.startedAt,
    latest.completedAt === operation.completedAt, latest.error === operation.error,
    latest.error.startsWith(`/unmount/${handoff.toGatewayId}: `),
    held.attempt === scheduler.attempt, latest.attempt === held.attempt + 1,
    held.startedAt === scheduler.claimStartedAt,
    held.startedAt <= held.completedAt, held.completedAt <= latest.startedAt,
    lastHeldStep?.name === "quiesce-source", lastHeldStep?.status === "failed",
  ].every(Boolean);
}

function assertInitialFailureScheduler(operation: OperationRecord, operationId: string, prior: NativeReturnRecoveryIntent | undefined): void {
  if (prior) return;
  const scheduler = readSchedulerMigrationIdentity(operationId, operation.schedulerHandoff?.migrationId);
  requireState(scheduler !== null && (
    scheduler.attempt === operation.attempts && scheduler.claimStartedAt === operation.startedAt ||
    releasedCleanupRetryMatches(operation, scheduler)
  ),
    "native return recovery scheduler failure claim changed");
}
async function readAuthority(tx: PlatformStateTransaction, uid: string, operationId: string, claimedStartedAt?: number) {
  const operation = await tx.journal.operations.get(operationId);
  const input = operation?.input ?? {};
  requireState(operation !== null && operation.kind === "migrate-user" && identity(input.fromGatewayId) && identity(input.toGatewayId) && identity(input.builderSlug), "native return recovery operation scope is unavailable");
  requireState([operation.origin === "automatic", operation.createdBy === "glm-controller-placement-policy", operation.inputUid === uid,
    input.uid === uid, input.source === "builder-activation-lease", operation.gatewayId === input.toGatewayId,
    operation.cutoverCommittedAt === undefined, operation.cancellationRequestedAt === undefined, operation.customerMigrationV2 === undefined,
    operation.sourceTransferExecution === undefined, operation.restoreAttempt === undefined, operation.schedulerHandoffLost === undefined, input.sourceTransferMode === undefined,
    readSchedulerMigrationIdentity(operationId, operation.schedulerHandoff?.migrationId) !== null].every(Boolean), "native return recovery operation custody changed");
  const { prior, failedAt } = recoveryPhase(operation, claimedStartedAt);
  assertInitialFailureScheduler(operation, operationId, prior);
  const scope: RecoveryScope = { uid, sourceId: input.fromGatewayId, targetId: input.toGatewayId, slug: input.builderSlug };
  const { sourceId, targetId } = scope;
  const retirementId = `shared-pool-retire-${targetId}`;
  const [user, source, runtime, assignment, targetAssignment, targetRoot, retirement, active] = await Promise.all([
    tx.users.records.get(uid), tx.gateways.roots.get(sourceId), tx.fleetRegistry.get(sourceId), tx.gateways.assignments.get(sourceId, uid),
    tx.gateways.assignments.get(targetId, uid), tx.gateways.roots.get(targetId),
    tx.journal.operations.get(retirementId), tx.journal.operations.listByStatus(["pending", "running"]),
  ]);
  requireState(sourceLeaseMatches(user, source, scope, operationId), "native return recovery source lease changed");
  const sourceVm = sourceVmIdentity(runtime, sourceId, operationId);
  requireState(assignmentMatches(assignment, scope, operationId) && targetAssignment === null && sourceVm !== null && handoffMatches(operation, scope),
    "native return recovery assignment or scheduler custody changed");
  requireState(!active.some(candidate => candidate.id !== operationId && competingOperation(candidate, uid, sourceId, targetId)), "native return recovery has competing work");
  requireState(retirementMatches(targetRoot, retirement, targetId, failedAt), "native return target retirement is incomplete");
  const lease = user!.activationLease!, handoff = operation.schedulerHandoff!, retired = retirement!;
  const intent: NativeReturnRecoveryIntent = { leaseId: lease.leaseId, generation: lease.generation, sourceEpoch: assignment.epoch, failedAt,
    schedulerMigrationId: handoff.migrationId,
    sourceVm,
    targetRetirement: { operationId: retirementId, version: retired.input.retirementClaimVersion as number, createdAt: retired.createdAt, completedAt: retired.completedAt as number } };
  assertCapturedIntent(prior, intent, claimedStartedAt);
  return { ...scope, operation, prior, intent, assignment };
}
function competingOperation(operation: OperationRecord, uid: string, sourceId: string, targetId: string): boolean {
  const input = operation.input ?? {};
  return input.uid === uid || [input.gatewayId, input.fromGatewayId, input.toGatewayId, input.sourceGatewayId, input.targetGatewayId].some(id => id === sourceId || id === targetId);
}
export function createNativeReturnSourceRecoveryOwner(deps: RecoveryDeps) {
  const read = (uid: string, operationId: string, claim?: number) =>
    deps.store.transaction({ label: "native-return-source-recovery.read", readOnly: true }, tx => readAuthority(tx, uid, operationId, claim));
  const request = async (input: NativeReturnRecoveryRequest): Promise<boolean> => {
    try {
      requireState(identity(input.uid) && identity(input.operationId) && Number.isSafeInteger(input.requestedAt) && input.requestedAt > 0, "native return recovery request identity is invalid");
      const captured = await read(input.uid, input.operationId);
      const assertCurrent = async () => { const current = await read(input.uid, input.operationId); requireState(isDeepStrictEqual(current.intent, captured.intent), "native return recovery request changed"); };
      if (!await deps.verifyRetiredTarget(captured.targetId, assertCurrent)) {
        deps.log(`[native-return-recovery] refused ${input.operationId}: retired target physical or PostgreSQL proof is incomplete`);
        return false;
      }
      await deps.store.transaction({ label: "native-return-source-recovery.request" }, async tx => {
        const current = await readAuthority(tx, input.uid, input.operationId);
        requireState(isDeepStrictEqual(current.intent, captured.intent), "native return recovery request changed");
        await tx.journal.operations.patch(input.operationId, { status: "pending", startedAt: null, completedAt: null, steps: [],
          input: { ...current.operation.input, recoverSourceOnly: true, nativeReturnSourceRecovery: captured.intent },
          sourceRecoveryRequestedAt: input.requestedAt, sourceRecoveryRequestedBy: input.requestedBy,
          error: { clear: true }, expireAt: { clear: true }, nextAttemptAt: input.requestedAt },
        { status: [current.operation.status], startedAt: current.operation.startedAt });
      });
      return true;
    } catch (error) {
      if (!(error instanceof NativeReturnRecoveryConflict)) throw error;
      deps.log(`[native-return-recovery] refused ${input.operationId}: ${error.message}`); return false;
    }
  };
  const recover = async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    try {
      requireState(typeof op.input.uid === "string" && typeof op.startedAt === "number" && ctx.assertActiveClaim, "native return recovery requires an active claim");
      const uid = op.input.uid, claim = op.startedAt, assertClaim = ctx.assertActiveClaim;
      const assertCurrent = async () => { await assertClaim(); return read(uid, op.id, claim); };
      const captured = await assertCurrent();
      const assertSourceCurrent = async () => { await assertCurrent(); };
      const assertRetired = async () => { await assertCurrent(); requireState(await deps.verifyRetiredTarget(captured.targetId, async () => { await assertCurrent(); }), "native return target runtime or PostgreSQL login remains live"); await assertCurrent(); };
      await assertRetired();
      const recordedCompletion = captured.prior?.completedAt;
      if (recordedCompletion !== undefined) return completedResult({ ...captured.intent, completedAt: recordedCompletion });
      const step = async (name: string, work: () => Promise<unknown>) => {
        await assertRetired(); await ctx.reportStep({ name, status: "running", startedAt: deps.now() });
        await assertRetired(); await work(); await assertRetired(); await ctx.reportStep({ name, status: "done", completedAt: deps.now() });
      };
      const nativeInput = { fromGatewayId: captured.sourceId, toGatewayId: captured.targetId, uid, slug: captured.slug, operationId: op.id, claimedStartedAt: claim };
      await step("recover-native-source-hold", () => deps.releaseSourceHold(nativeInput));
      await step("recover-native-source-ownership", () => deps.prepareSourceStores(captured.sourceId, captured.slug, { expectedUserUid: uid, assertCurrent: assertSourceCurrent }));
      const client = await deps.sourceClient(captured.sourceId, { expectedUserUid: uid, assertCurrent: assertSourceCurrent });
      await step("recover-native-source-scheduler", () => client.scheduler({ gatewayId: captured.sourceId, migrationId: captured.intent.schedulerMigrationId, slug: captured.slug, phase: "resume" }));
      await step("recover-native-source-ingress", () => client.resume({ gatewayId: captured.sourceId, migrationId: `mig-${op.id}`, slug: captured.slug }));
      await assertRetired();
      const completedAt = await deps.store.transaction({ label: "native-return-source-recovery.complete" }, async tx => {
        const current = await readAuthority(tx, uid, op.id, claim);
        if (current.prior?.completedAt !== undefined) return current.prior.completedAt;
        const at = deps.now();
        const receipt = { ...captured.intent, completedAt: at, uid, slug: captured.slug, operationId: op.id,
          sourceGatewayId: captured.sourceId, targetGatewayId: captured.targetId, claimStartedAt: claim };
        const priorReceipts = Array.isArray(current.operation.nativeReturnSourceRecoveryReceipts) ? current.operation.nativeReturnSourceRecoveryReceipts : [];
        await tx.gateways.assignments.patch(current.sourceId, uid, { state: "serving", updatedByOperationId: op.id, updatedAt: at }, { epoch: current.assignment.epoch });
        await tx.users.records.setFence(uid, "migration", { clear: true });
        await tx.journal.operations.patch(op.id, { schedulerHandoffReleased: true, schedulerHandoffReleasedAt: at,
          input: { ...current.operation.input, nativeReturnSourceRecovery: { ...current.prior, completedAt: at } },
          nativeReturnSourceRecoveryReceipts: [...priorReceipts, receipt].slice(-20) },
        { status: ["running"], startedAt: claim });
        return at;
      });
      return completedResult({ ...captured.intent, completedAt });
    } catch (error) {
      return { steps: [], success: false, rolledBack: false, error: `native return source recovery pending: status 503: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  return { request, recover };
}
function completedResult(intent: NativeReturnRecoveryIntent): OperationResult {
  return { steps: [], success: false, rolledBack: true, error: "native return source recovery completed", output: { nativeReturnSourceRecovery: intent } };
}
