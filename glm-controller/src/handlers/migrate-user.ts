import { sourceTransferBlocksRelease } from '../lib/source-transfer-execution.js';
import type { RetainedSourceContext } from '../lib/retained-source-transfer.js';
import type { MigrationProgressRecord, SourceTransferExecution } from '@octogee/shared/types/glm';
import type { PrepareMigrationAgentStores } from "../migration-agent-stores.js";
import { createMigrationProgress } from "../migration-progress.js";
import { withLogContext } from "@octogee/shared/server/service-logger";
import type { WorkspaceMigrationPhase } from "@octogee/shared/types/workspace-migration";
import { operationScopedLog, withOperationLogScope } from "../operation-log-scope.js";
import {
  attemptMayHoldSourceIngress,
  attemptNeverHeldSource,
  userActivationSourceRecoveryPending,
  releasedUserActivationSourceRecovery,
  legacyAttemptNeverQuiesced,
} from "../legacy-migration-recovery.js";
import { PendingUserRestoreError } from "../operation-context.js";
import {
  ADD_USER_DEADLINE_MS,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  MIGRATION_VERIFY_DEFAULT_AGENT_ATTACH_IN_PROGRESS,
  type MigrationProgressRequestBody,
  type ScheduleTransferDoc,
} from "@octogee/shared/types/fleet-controller";
import type { NativeVmReturn, NativeVmReturnInput, NativeReturnPark, NativeSourcePark } from "../lib/native-vm-return.js";
import type { NativeSchedulerRetirementInput } from "../lib/native-scheduler-retirement.js";
import { reportedAbandonedNativeScheduler, type RecoverAbandonedNativeScheduler } from "../lib/native-return-scheduler-recovery.js";
import {
  heldSchedulerMigration,
  releaseSchedulerCustody,
  type SchedulerCustodyOwner,
  type SchedulerFenceOutcome,
} from "@octogee/core/scheduler-custody";
import type {
  UserMigrationV2GatewayRootFence,
  UserMigrationV2State,
  GatewayClass,
  Operation,
  OperationStep,
  SchedulerHandoffState,
  StepStatus,
} from "@octogee/shared/types/glm";
import { resolveOperationOrigin, readSchedulerMigrationIdentity } from "@octogee/shared/types/glm";
import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";
import { vmPreemptionError } from "../operation-retry.js";
import { MigrationDrainPendingError, MigrationRpcError, MigrationTransportError, type MigrationClient } from "@octogee/core/fleet-migration-client";
import { sharedRecoveryTargetCleaned, type WorkspaceMigrationPreparationParams, type WorkspaceMigrationRecoveryParams, type WorkspaceMigrationSourcePreparationParams } from "@octogee/core/fleet-state";
import {
  advanceUserMigrationV2,
  beginUserMigrationV2Abort,
  classifyUserMigrationV2Error,
  isUserMigrationV2ForwardOnly,
  userMigrationV2GatewayRootFenceEqual,
  type UserMigrationV2CutoverFence,
} from "@octogee/core/user-migration-v2";
import {
  isTargetSchedulerNotReady,
  restoreScheduleTransfer,
  runMigration,
  type CutoverCommit,
  type MigrationRunnerDeps,
  type MigrationRunnerResult,
  type ReportedStep,
  type ScheduleRestoreFailure,
  type ScheduleRestoreRecord,
  type TargetSystemConfigConvergence,
} from "@octogee/core/fleet-migration-runner";

const RETAINED_POD = "retained-pod";
const RELEASED_ISOLATED_TARGET_ERROR = "User activation target released before cutover; source recovery required";
const DEFAULT_AGENT_ATTACH_POLL_MS = 5_000;
export const FRESH_TARGET_CONFIG_COMMIT_WAIT_MS = 120_000;
const TARGET_CONFIG_COMMIT_POLL_MS = 5_000;

// At most one migration per target gateway at a time. Enforced durably, before
// this handler ever runs, by the operation queue in index.ts (operation-queue.ts
// scopes migrate-customer exclusivity by toGatewayId); a conflicting request is
// queued there, not rejected here.

export interface UserGatewayInfo {
  slug: string;
  currentGatewayId: string;
}

export interface SourcePlacement {
  release: number;
  gatewayClass?: GatewayClass;
  epoch?: number;
  assignmentMode?: "assigned" | "unassigned-live";
  rootUpdatedAt?: number;
}

type PlacementResolution =
  | { ok: true; release: number | null; gatewayClass: GatewayClass }
  | { ok: false; reason: string; blocker?: string };

export interface MigrateUserDeps {
  reportMigrationProgress: (gatewayId: string, event: MigrationProgressRequestBody) => Promise<void>;
  recordMigrationProgress: (input: { operation: Operation; event: MigrationProgressRecord }) => Promise<void>;
  recoverNativeReturnSource?: OperationHandler;
  recoverAbandonedNativeScheduler?: RecoverAbandonedNativeScheduler;
  prepareNativeVmReturn: (input: NativeVmReturnInput) => Promise<NativeVmReturn | null>;
  retireNativeSchedulerBeforeStage: (input: NativeSchedulerRetirementInput, scheduler: MigrationClient["scheduler"]) => Promise<void>;
  readOperation: (operationId: string) => Promise<SchedulerCustodyOwner | null>;
  readUserAgentIds: (uid: string) => Promise<readonly string[]>;

  readUser: (uid: string) => Promise<UserGatewayInfo | null>;

  readUserSnapshot: (
    uid: string,
    toGatewayId: string,
  ) => Promise<FleetBrokerUserSnapshot | null>;

  readPrivateProjectAgentWorkspace?: (gatewayId: string, slug: string) => Promise<boolean | undefined>;

  readGatewaySystemConfigCommit: (gatewayId: string) => Promise<string | null>;
  readOpenClawBuild?: (gatewayId: string, release: number) => Promise<string | null>;

  commitCutover: (commit: CutoverCommit & { automatic?: boolean }) => Promise<void>;

  readScheduleTransfer: (uid: string, migrationId: string) => Promise<ScheduleTransferDoc | null>;
  saveScheduleTransfer: (uid: string, doc: ScheduleTransferDoc) => Promise<void>;
  recordScheduleRestore: (uid: string, migrationId: string, restore: ScheduleRestoreRecord) => Promise<void>;

  resolveGatewayUrl: (gatewayId: string, options?: { allowUnready: boolean }) => Promise<string>;

  buildClient: (resolveSync: (gatewayId: string) => string, retainedSource?: RetainedSourceContext) => MigrationClient;
  observeSourceTransfer?: (op: Operation) => Promise<SourceTransferExecution | undefined>;
  cleanupSourceTransfer?: (op:Operation,state:UserMigrationV2State) => Promise<void>;

  resolveSourcePlacement: (uid: string, currentGatewayId: string) => Promise<SourcePlacement | null>;
  resolveTargetPlacement: (toGatewayId: string) => Promise<PlacementResolution | null>;

  clearMigrationPreparation?: (input: WorkspaceMigrationPreparationParams) => Promise<void>;
  assertMigrationRecoveryAuthority?: (input: WorkspaceMigrationRecoveryParams) => Promise<void>;
  assertMigrationSourcePreparationAuthority?: (input: WorkspaceMigrationSourcePreparationParams) => Promise<void>;
  completeMigrationRecovery?: (input: WorkspaceMigrationRecoveryParams) => Promise<void>;
  prepareMigrationAgentStores?: PrepareMigrationAgentStores;
  prepareIsolatedRecoveryTarget?: (input: { recovery: WorkspaceMigrationRecoveryParams; targetGatewayId: string; migrationId: string; slug: string }) => Promise<void>;
  setMigrationPhase?: (input: { uid: string; sourceGatewayId: string; operationId: string; phase: WorkspaceMigrationPhase }) => Promise<void>;

  setAssignmentState: (input: {
    gatewayId: string;
    uid: string;
    state: "serving" | "quiescing" | "migrating";
    slug?: string;
    epoch?: number;
    updatedByOperationId?: string;
    createIfMissing?: boolean;
    automatic?: boolean;
  }) => Promise<void>;

  readGatewayRootFence: (
    gatewayId: string,
  ) => Promise<UserMigrationV2GatewayRootFence | null>;

  commitV2Cutover: (input: UserMigrationV2CutoverFence & {
    uid: string;
    slug: string;
    automatic?: boolean;
    claimStartedAt?: number;
  }) => Promise<void>;

  // Durable (V2) migration for isolated gateways; the legacy runner
  // covers shared-class users with no durable target footprint to fence.
  useDurableMigration: (
    fromGatewayId: string,
    toGatewayId: string,
    retainedNativeRelease?: number,
  ) => Promise<boolean>;

  findPreemptedVm: (gatewayId: string, sinceMs: number) => Promise<string | null>;

  genMigrationId: (operationId: string) => string;

  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

function isAbortPhase(phase: UserMigrationV2State["phase"]): boolean {
  return phase === "abortIntent" ||
    phase === "abortTargetUnmounted" ||
    phase === "aborted";
}

function v2RetryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `user migration V2 retry pending: status 503: ${message}`;
}

async function persistV2(
  ctx: OperationContext,
  state: UserMigrationV2State,
): Promise<void> {
  if (!ctx.persistUserMigrationV2) {
    throw new Error("user migration V2 requires durable operation state persistence");
  }
  await ctx.persistUserMigrationV2(state);
}

async function runOrdinaryMigrationV2(input: {
  op: Operation;
  ctx: OperationContext;
  deps: MigrateUserDeps;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
}): Promise<OperationResult> {
  const initialized = await initializeMigrationV2(input);
  if ("success" in initialized) return initialized;
  const execution = {
    input,
    state: initialized,
    scopeChanged: ordinaryV2ScopeChanged(input, initialized),
    progress: migrateUserProgress(input),
  };
  while (execution.state.phase !== "complete" && execution.state.phase !== "aborted") {
    const outcome = await runOrdinaryV2Iteration(execution);
    if (outcome === "stop") break;
    if (outcome !== "continue") return outcome;
  }
  if (execution.state.phase === "aborted") {
    return {
      steps: [],
      success: false,
      error: execution.state.abortReason ?? "user migration V2 aborted",
      rolledBack: true,
    };
  }
  return { steps: [], success: true, rolledBack: false };
}

interface OrdinaryV2Input {
  op: Operation;
  ctx: OperationContext;
  deps: MigrateUserDeps;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
}

interface OrdinaryV2Execution {
  progress: ReturnType<typeof createMigrationProgress>;
  input: OrdinaryV2Input;
  state: UserMigrationV2State;
  scopeChanged: boolean;
}

function assertRootOwner(
  root: UserMigrationV2GatewayRootFence | null,
  uid: string,
  slug: string,
  role: "source" | "target",
): asserts root is UserMigrationV2GatewayRootFence {
  if (!root || root.ownerUid !== uid || root.builderSlug !== slug) {
    throw new Error(
      `user migration V2 ${role} root ownership changed before initialization`,
    );
  }
}

async function initializeMigrationV2(
  input: OrdinaryV2Input,
): Promise<UserMigrationV2State | OperationResult> {
  const { op, ctx, deps, targets, uid, slug, migrationId } = input;
  if (targets.toRelease === null) {
    return { steps: [], success: false, error: "user migration V2 target has no release" };
  }
  if (op.userMigrationV2) return op.userMigrationV2;
  const [sourceRootFence, targetRootFence] = await Promise.all([
    deps.readGatewayRootFence(targets.fromGatewayId),
    deps.readGatewayRootFence(targets.toGatewayId),
  ]);
  assertRootOwner(sourceRootFence, uid, slug, "source");
  assertRootOwner(targetRootFence, uid, slug, "target");
  const state: UserMigrationV2State = {
    phase: "initialized",
    operationId: op.id,
    migrationId,
    uid,
    slug,
    sourceGatewayId: targets.fromGatewayId,
    sourceRelease: targets.fromRelease,
    sourceEpoch: targets.fromEpoch,
    sourceAssignmentMode: targets.sourceAssignmentMode,
    sourceRootFence,
    targetGatewayId: targets.toGatewayId,
    targetRelease: targets.toRelease,
    targetRootFence,
  };
  await persistV2(ctx, state);
  return state;
}

function ordinaryV2ScopeChanged(
  input: OrdinaryV2Input,
  state: UserMigrationV2State,
): boolean {
  const { op, targets, uid, slug, migrationId } = input;
  const declaredSourceGatewayId = typeof op.input.fromGatewayId === "string"
    ? op.input.fromGatewayId
    : null;
  return [
    state.operationId !== op.id,
    state.migrationId !== migrationId,
    state.uid !== uid,
    state.slug !== slug,
    state.sourceGatewayId !== targets.fromGatewayId,
    state.sourceRelease !== targets.fromRelease,
    state.sourceEpoch !== targets.fromEpoch,
    state.sourceAssignmentMode !== targets.sourceAssignmentMode,
    state.targetGatewayId !== targets.toGatewayId,
    state.targetRelease !== targets.toRelease,
    declaredSourceGatewayId !== null && declaredSourceGatewayId !== state.sourceGatewayId,
  ].some(Boolean);
}

async function cancellationResult(
  execution: OrdinaryV2Execution,
): Promise<OperationResult | null> {
  const { ctx, deps } = execution.input;
  const state = execution.state;
  if (sourceTransferBlocksRelease(await deps.observeSourceTransfer?.(execution.input.op))) return {steps:[],success:false,error:"source transfer observation pending: status 503",rolledBack:false};
  if (isAbortPhase(state.phase) || isUserMigrationV2ForwardOnly(state)) return null;
  if (!await ctx.cancellationRequested?.()) return null;
  if (state.phase === "initialized") {
    return { steps: [], success: false, error: "user migration cancelled before transfer" };
  }
  execution.state = beginUserMigrationV2Abort(
    state,
    "user migration superseded",
    deps.now(),
  );
  await persistV2(ctx, execution.state);
  return null;
}

async function ordinaryV2IterationFailure(
  execution: OrdinaryV2Execution,
  error: unknown,
): Promise<OperationResult | "continue"> {
  try {
    if (sourceTransferBlocksRelease(await execution.input.deps.observeSourceTransfer?.(execution.input.op))) return {steps:[],success:false,error:"source transfer observation pending: status 503",rolledBack:false};
  } catch {
    if (execution.input.op.input.sourceTransferMode === RETAINED_POD) return {steps:[],success:false,error:"source transfer observation unavailable: status 503",rolledBack:false};
  }
  if (error instanceof MigrationDrainPendingError) {
    return { steps: [], success: false, waitingForUserIdle: true, rolledBack: false };
  }
  const retryable = classifyUserMigrationV2Error(error) === "retry";
  if (retryable && !requiresSourceResumeBeforeRetry(execution.state.phase)) {
    return { steps: [], success: false, error: v2RetryError(error), rolledBack: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (isAbortPhase(execution.state.phase)) {
    return {
      steps: [],
      success: false,
      error: `user migration V2 retry pending: status 503: abort cleanup blocked: ${message}`,
      rolledBack: false,
    };
  }
  if (isUserMigrationV2ForwardOnly(execution.state)) {
    return {
      steps: [],
      success: false,
      error: `user migration V2 retry pending: status 503: roll-forward blocked: ${message}`,
      rolledBack: false,
    };
  }
  if (execution.state.phase === "initialized") {
    return { steps: [], success: false, error: message, rolledBack: false };
  }
  execution.state = beginUserMigrationV2Abort(
    execution.state,
    message,
    execution.input.deps.now(),
  );
  await persistV2(execution.input.ctx, execution.state);
  return "continue";
}

function requiresSourceResumeBeforeRetry(
  phase: UserMigrationV2State["phase"],
): boolean {
  return phase === "keysSynced" ||
    phase === "preSynced" ||
    phase === "sourceQuiesced" ||
    phase === "finalSynced";
}

async function runOrdinaryV2Iteration(
  execution: OrdinaryV2Execution,
): Promise<OperationResult | "continue" | "stop"> {
  if (execution.input.op.input.sourceTransferMode === RETAINED_POD) {
    if (!execution.input.ctx.assertActiveClaim) throw new Error('retained source requires active claim verification');
    await execution.input.ctx.assertActiveClaim(true);
  }
  let phase = execution.state.phase;
  await execution.progress.report(phase, "running");
  try {
    const cancelled = await cancellationResult(execution);
    if (cancelled || execution.state.phase !== phase) {
      await execution.progress.report(phase, "skipped");
      if (cancelled) return cancelled;
      phase = execution.state.phase;
      await execution.progress.report(phase, "running");
    }
    if (execution.scopeChanged && !isAbortPhase(execution.state.phase)) {
      throw new Error("durable user migration V2 scope changed");
    }
    if (execution.state.phase === "initialized") {
      await assertV2InitialBindings(execution.state, execution.input.deps);
    }
    if (isAbortPhase(execution.state.phase) && execution.input.op.input.sourceTransferMode===RETAINED_POD) {
      if (!execution.input.deps.cleanupSourceTransfer) throw new Error('retained source cleanup unavailable');
      await execution.input.deps.cleanupSourceTransfer(execution.input.op,execution.state);
    }
    const driverDeps = await buildV2DriverDeps(
      execution.state,
      execution.input.deps,
      execution.input.op,
      resolveOperationOrigin(execution.input.op.origin) === "automatic",
    );
    const next = await advanceUserMigrationV2(execution.state, {
      ...driverDeps,
      client: withImportProgress(driverDeps.client, execution.progress),
    });
    if (next === execution.state) {
      await execution.progress.report(phase, "pending");
      return "stop";
    }
    execution.state = next;
    await persistV2(execution.input.ctx, execution.state);
    await execution.progress.report(phase, "done");
    return "continue";
  } catch (error) {
    await execution.progress.report(phase, error instanceof MigrationDrainPendingError ? "pending" : "failed");
    return ordinaryV2IterationFailure(execution, error);
  }
}

async function assertV2InitialBindings(
  state: UserMigrationV2State,
  deps: MigrateUserDeps,
): Promise<void> {
  const [source, target, sourceRootFence, targetRootFence] = await Promise.all([
    deps.resolveSourcePlacement(state.uid, state.sourceGatewayId),
    deps.resolveTargetPlacement(state.targetGatewayId),
    deps.readGatewayRootFence(state.sourceGatewayId),
    deps.readGatewayRootFence(state.targetGatewayId),
  ]);
  const sourceIsExact = source !== null && [
    source.release === state.sourceRelease,
    (source.epoch ?? 0) === state.sourceEpoch,
    (source.assignmentMode ?? "assigned") === state.sourceAssignmentMode,
  ].every(Boolean);
  if (!sourceIsExact) {
    throw new Error("user migration V2 source placement changed before transfer");
  }
  const targetIsExact = target?.ok === true && target.release === state.targetRelease;
  if (!targetIsExact) {
    throw new Error("user migration V2 target placement changed before transfer");
  }
  if (
    !sourceRootFence ||
    !userMigrationV2GatewayRootFenceEqual(sourceRootFence, state.sourceRootFence)
  ) {
    throw new Error("user migration V2 source root changed before transfer");
  }
  if (
    !targetRootFence ||
    !userMigrationV2GatewayRootFenceEqual(targetRootFence, state.targetRootFence)
  ) {
    throw new Error("user migration V2 target root changed before transfer");
  }
}

const V2_SOURCE_TRANSPORT_PHASES = new Set<UserMigrationV2State["phase"]>([
  "initialized", "keysSynced", "preSynced",
]);
const V2_BOTH_TRANSPORT_PHASES = new Set<UserMigrationV2State["phase"]>([
  "sourceQuiesced", "cutover", "abortIntent",
]);
const V2_TARGET_TRANSPORT_PHASES = new Set<UserMigrationV2State["phase"]>([
  "finalSynced", "targetVerified", "sourceRetired",
]);

function v2PhaseTransportIds(state: UserMigrationV2State): string[] {
  if (V2_SOURCE_TRANSPORT_PHASES.has(state.phase)) return [state.sourceGatewayId];
  if (V2_BOTH_TRANSPORT_PHASES.has(state.phase)) {
    return [state.sourceGatewayId, state.targetGatewayId];
  }
  return V2_TARGET_TRANSPORT_PHASES.has(state.phase) ? [state.targetGatewayId] : [];
}

function requiredClaimStartedAt(op: Operation): number {
  if (typeof op.startedAt !== 'number' || !Number.isSafeInteger(op.startedAt) || op.startedAt <= 0) throw new Error('migration requires a current claim timestamp');
  return op.startedAt;
}

function claimSchedulerMigrationId(migrationId: string, op: Operation): string {
  return `${migrationId}:scheduler:${(op.attempts ?? 0) + 1}:claim:${requiredClaimStartedAt(op)}`;
}

async function buildV2DriverDeps(
  state: UserMigrationV2State,
  deps: MigrateUserDeps,
  op: Operation,
  automatic: boolean,
) {
  const claimFence = op.input.sourceTransferMode === RETAINED_POD ? {claimStartedAt: requiredClaimStartedAt(op)} : {};
  const transportIds = new Set([
    ...v2PhaseTransportIds(state),
    // Every source-driven push resolves the target URL too.
    state.targetGatewayId,
  ]);
  const urls = new Map<string, string>();
  await Promise.all([...transportIds].map(async (transportId) => {
    urls.set(transportId, await deps.resolveGatewayUrl(transportId));
  }));
  const client = schedulerRetirementClient(deps.buildClient((transportId) => {
    const url = urls.get(transportId);
    if (!url) {
      throw new Error(`migration client called with unexpected gatewayId: ${transportId}`);
    }
    return url;
  }, op.input.sourceTransferMode === RETAINED_POD ? {op,state} : undefined), deps,
  { uid: state.uid, slug: state.slug, gatewayId: state.targetGatewayId, operationId: op.id, claimedStartedAt: op.startedAt });
  return {
    client,
    setMigrationPhase: (phase: WorkspaceMigrationPhase) => deps.setMigrationPhase?.({ uid: state.uid, sourceGatewayId: state.sourceGatewayId, operationId: state.operationId, phase }) ?? Promise.resolve(),
    setSourceAssignmentState: (assignmentState: "serving" | "quiescing") =>
      deps.setAssignmentState({
        gatewayId: state.sourceGatewayId,
        uid: state.uid,
        state: assignmentState,
        slug: state.slug,
        epoch: state.sourceEpoch,
        updatedByOperationId: state.operationId,
        createIfMissing: state.sourceAssignmentMode === "unassigned-live",
        automatic,
      }),
    commitCutover: (fence: UserMigrationV2CutoverFence) =>
      deps.commitV2Cutover({ ...fence, uid: state.uid, slug: state.slug, automatic, ...claimFence }),
    now: deps.now,
    log: deps.log,
    wait: deps.sleep,
  };
}

interface MigrateUserInput {
  uid?: unknown;
  fromGatewayId?: unknown;
  toGatewayId?: unknown;
  source?: unknown;
}

function isControllerConvergenceSource(source: unknown): boolean {
  return source === "builder-activation-lease" ||
    source === "continuous-placement-policy";
}

function reportedStatusToStepStatus(reported: ReportedStep["status"]): StepStatus {
  if (reported === "running") return "running";
  if (reported === "done") return "done";
  if (reported === "skipped") return "skipped";
  return "failed";
}

function reportedToOperationStep(rep: ReportedStep, now: number): OperationStep {
  const status = reportedStatusToStepStatus(rep.status);
  const step: OperationStep = { name: rep.name, status };
  if (rep.status === "running") step.startedAt = now;
  else step.completedAt = now;
  if (rep.error) step.error = rep.error;
  return step;
}

interface MigrationTargets {
  toGatewayId: string;
  toGatewayClass: GatewayClass;
  fromGatewayId: string;
  fromGatewayClass?: GatewayClass;
  toRelease: number | null;
  fromRelease: number;
  fromEpoch: number;
  sourceAssignmentMode: "assigned" | "unassigned-live";
  sourceRootUpdatedAt?: number;
}

async function resolveMigrationTargets(
  deps: MigrateUserDeps,
  uid: string,
  user: UserGatewayInfo,
  toGatewayId: string,
): Promise<{ targets: MigrationTargets } | { error: string }> {
  if (user.currentGatewayId === toGatewayId) {
    return { error: `user already on ${toGatewayId}` };
  }
  const source = await deps.resolveSourcePlacement(uid, user.currentGatewayId);
  if (!source) {
    return {
      error: `source gateway ${user.currentGatewayId} has no durable placement`,
    };
  }
  const placement = await deps.resolveTargetPlacement(toGatewayId);
  if (placement === null) {
    return { error: `target gateway ${toGatewayId} has no durable placement` };
  }
  if (placement.ok === false) {
    const blocker = placement.blocker ? ` (${placement.blocker})` : "";
    return { error: `placement rejected for ${toGatewayId}: ${placement.reason}${blocker}` };
  }

  return {
    targets: {
      toGatewayId,
      toGatewayClass: placement.gatewayClass,
      fromGatewayId: user.currentGatewayId,
      ...(source.gatewayClass ? { fromGatewayClass: source.gatewayClass } : {}),
      toRelease: placement.release,
      fromRelease: source.release,
      fromEpoch: source.epoch ?? 0,
      sourceAssignmentMode: source.assignmentMode ?? "assigned",
      ...(source.rootUpdatedAt !== undefined ? { sourceRootUpdatedAt: source.rootUpdatedAt } : {}),
    },
  };
}

async function recordCutoverCommitted(
  deps: MigrateUserDeps,
  ctx: OperationContext,
): Promise<void> {
  if (!ctx.persistCutoverCommitted) return;
  try {
    await ctx.persistCutoverCommitted(deps.now());
  } catch (error) {
    deps.log(
      `[migrate-customer] ❌ cutover committed but could not be recorded — the serial lock stays held ` +
      `until this operation completes: ${errorMessage(error)}`,
    );
  }
}

function targetConvergence(sourceClass: GatewayClass | undefined): TargetSystemConfigConvergence {
  return sourceClass === "shared" ? "target-commit" : "source-commit";
}

function scheduleTransferDeps(
  deps: MigrateUserDeps,
  uid: string,
): Pick<MigrationRunnerDeps, "readScheduleTransfer" | "saveScheduleTransfer" | "recordScheduleRestore"> {
  return {
    readScheduleTransfer: (migrationId) => deps.readScheduleTransfer(uid, migrationId),
    saveScheduleTransfer: (doc) => deps.saveScheduleTransfer(uid, doc),
    recordScheduleRestore: (migrationId, restore) => deps.recordScheduleRestore(uid, migrationId, restore),
  };
}

async function readClaimedTargetSystemConfigCommit(
  deps: MigrateUserDeps,
  gatewayId: string,
  assertCurrent?: () => Promise<void>,
): Promise<string | null> {
  const commit = await deps.readGatewaySystemConfigCommit(gatewayId);
  await assertCurrent?.();
  return commit;
}

async function awaitTargetSystemConfigCommit(
  deps: MigrateUserDeps,
  gatewayId: string,
  assertCurrent?: () => Promise<void>,
): Promise<string | null> {
  const deadline = deps.now() + FRESH_TARGET_CONFIG_COMMIT_WAIT_MS;
  let commit = await readClaimedTargetSystemConfigCommit(deps, gatewayId, assertCurrent);
  if (commit) return commit;
  deps.log(`[migrate-customer] target ${gatewayId} has not accepted a system config commit yet; waiting up to ${FRESH_TARGET_CONFIG_COMMIT_WAIT_MS / 1000}s for its heartbeat`);
  while (deps.now() < deadline) {
    await deps.sleep(Math.min(TARGET_CONFIG_COMMIT_POLL_MS, deadline - deps.now()));
    commit = await readClaimedTargetSystemConfigCommit(deps, gatewayId, assertCurrent);
    if (commit) return commit;
  }
  return null;
}

function buildRunnerDeps(
  input: {
    deps: MigrateUserDeps;
    client: MigrationClient;
    ctx: OperationContext;
    automatic: boolean;
    operationId: string;
    uid: string;
    sourceGatewayId: string;
  },
): MigrationRunnerDeps {
  const { deps, client, ctx } = input;
  return {
    client,
    readCurrentGateway: async () => (await deps.readUser(input.uid))?.currentGatewayId ?? null,
    prepareRollbackTarget: async (gatewayId, slug) => {
      if (!deps.prepareMigrationAgentStores || !ctx.assertActiveClaim) throw new Error("Target cleanup requires claimed agent-store ownership preparation");
      await ctx.assertActiveClaim();
      await deps.prepareMigrationAgentStores(gatewayId, slug, { expectedUserUid: input.uid, assertCurrent: ctx.assertActiveClaim });
    },
    ...scheduleTransferDeps(deps, input.uid),
    setMigrationPhase: (phase) => deps.setMigrationPhase?.({ uid: input.uid, sourceGatewayId: input.sourceGatewayId, operationId: input.operationId, phase }) ?? Promise.resolve(),
    readTargetSystemConfigCommit: (gatewayId) => awaitTargetSystemConfigCommit(deps, gatewayId, ctx.assertActiveClaim),
    commitCutover: async (commit) => {
      await deps.commitCutover({ ...commit, automatic: input.automatic });
      await recordCutoverCommitted(deps, ctx);
    },
    setAssignmentState: (assignment) =>
      deps.setAssignmentState({
        ...assignment,
        updatedByOperationId: input.operationId,
        automatic: input.automatic,
      }),
    log: deps.log,
    reportStep: async (rep: ReportedStep) => {
      await ctx.reportStep(reportedToOperationStep(rep, deps.now()));
    },
  };
}

interface PreparedMigration {
  uid: string;
  toGatewayId: string;
  user: UserGatewayInfo;
  migrationId: string;
  targets: MigrationTargets;
  projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
  urls: Map<string, string>;
  sourcePreparationFenced?: true;
}

interface NativeReturnProvision {
  deps: MigrateUserDeps;
  ctx: OperationContext;
  op: Operation;
  operationId: string;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
  automatic: boolean;
  nativeReturn: NativeVmReturn;
}

type SourceAssignment = Omit<Parameters<MigrateUserDeps["setAssignmentState"]>[0], "state" | "createIfMissing">;

async function runNativeReturn(input: NativeReturnProvision): Promise<OperationResult> {
  const { deps, targets, uid, slug, migrationId, automatic } = input;
  const handoff = await persistNativeReturnHandoff(input);
  const assertClaim = input.ctx.assertActiveClaim;
  input = { ...input, ctx: { ...input.ctx, ...(assertClaim ? {
    assertActiveClaim: (allowCancelled = false) => assertClaim(allowCancelled || handoff.forwardRecovery !== undefined),
  } : {}) } };
  const progress = migrateUserProgress(input);
  const ctx = destinationProgressContext(input.ctx, progress);
  deps.log(
    `[migrate-customer] ${targets.fromGatewayId} → ${targets.toGatewayId} slug=${slug}: ` +
    "native-return",
  );
  const client = withImportProgress(await gatewayClient(deps, [targets.fromGatewayId, targets.toGatewayId]), progress);
  const step = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    await reportNativeReturnStep(deps, ctx, name, action);
  };
  const sourceAssignment: SourceAssignment = {
    gatewayId: targets.fromGatewayId,
    uid,
    slug,
    epoch: targets.fromEpoch,
    updatedByOperationId: input.operationId,
    automatic,
  };
  let sourceFenced = false;
  try {
    if (!handoff.forwardRecovery) {
      await deps.setMigrationPhase?.({ uid, sourceGatewayId: targets.fromGatewayId, operationId: input.operationId, phase: "preparing" });
      await step("keys-sync-state", () => client.transferState({
        migrationId, slug, fromGatewayId: targets.fromGatewayId, toGatewayId: targets.toGatewayId, mode: "keys",
      }));
      await deps.setMigrationPhase?.({ uid, sourceGatewayId: targets.fromGatewayId, operationId: input.operationId, phase: "waiting" });
      await step("wait-for-active-work", () => client.quiesce({ migrationId, gatewayId: targets.fromGatewayId, slug, timeoutMs: 30_000, stopMattermost: false }));
      await deps.setMigrationPhase?.({ uid, sourceGatewayId: targets.fromGatewayId, operationId: input.operationId, phase: "transferring" });
      await deps.setAssignmentState({
        ...sourceAssignment,
        state: "quiescing",
        createIfMissing: targets.sourceAssignmentMode === "unassigned-live",
      });
      sourceFenced = true;
    } else {
      await input.ctx.assertActiveClaim!(true);
      await step("keys-sync-state", () => client.transferState({
        migrationId, slug, fromGatewayId: targets.fromGatewayId, toGatewayId: targets.toGatewayId, mode: "keys",
      }));
    }
    await closeSourceForNativeReturnProvision(input, client, step, handoff);
    await step("cutover-firestore", async () => {
      await deps.commitCutover({
        uid,
        slug,
        toGatewayId: targets.toGatewayId,
        fromGatewayId: targets.fromGatewayId,
        flipMirror: targets.fromGatewayId !== targets.toGatewayId,
        automatic,
      });
      await recordCutoverCommitted(deps, ctx);
    });
  } catch (error) {
    if (handoff.forwardRecovery) {
      const current = await deps.readUser(uid);
      if (current?.currentGatewayId === targets.toGatewayId) {
        return completeNativeReturn(deps, ctx, input.nativeReturn, { ...targets, uid, migrationId, slug, handoff, operation: input.op });
      }
      return failure(`migration forward recovery pending: status 503: ${errorMessage(error)}`, false);
    }
    if (error instanceof MigrationDrainPendingError) {
      return deferNativeReturnProvision(input, client, sourceAssignment, handoff, sourceFenced);
    }
    const settled = await settleNativeReturnAfterFailure(input, ctx, input.nativeReturn, handoff);
    if (settled) return settled;
    return rollbackNativeReturnProvision({ deps, ctx, client, handoff, sourceAssignment, migrationId, slug, error, toGatewayId: targets.toGatewayId });
  }
  return completeNativeReturn(deps, ctx, input.nativeReturn, { ...targets, uid, migrationId, slug, handoff, operation: input.op });
}

async function deferNativeReturnProvision(
  input: NativeReturnProvision,
  client: MigrationClient,
  sourceAssignment: SourceAssignment,
  handoff: SchedulerHandoffState | null,
  sourceFenced: boolean,
): Promise<OperationResult> {
  const { deps, targets, uid, slug, migrationId, operationId } = input;
  await input.nativeReturn.release();
  if (sourceFenced && handoff) {
    const failure = await reopenSourceScheduler(deps, client, handoff, input.ctx);
    if (failure) return { steps: [], success: false, rolledBack: false, error: failure };
  }
  try {
    await runReleasedNativeSource(deps, input.ctx, targets.fromGatewayId, slug,
      () => client.resume({ migrationId, gatewayId: targets.fromGatewayId, slug }));
  } catch (error) {
    return failure(`native return deferral pending: ${errorMessage(error)}`, false);
  }
  if (sourceFenced) await restoreSourceServing(deps, { ...sourceAssignment, state: "serving", createIfMissing: false });
  await deps.setMigrationPhase?.({ uid, sourceGatewayId: targets.fromGatewayId, operationId, phase: "waiting" });
  return { steps: [], success: false, waitingForUserIdle: true, rolledBack: false };
}

async function closeSourceForNativeReturnProvision(
  input: NativeReturnProvision,
  client: MigrationClient,
  step: (name: string, action: () => Promise<unknown>) => Promise<void>,
  handoff: SchedulerHandoffState | null,
): Promise<void> {
  const { targets, slug, migrationId } = input;
  if (!handoff) throw new Error("native return requires a durable scheduler handoff");
  if (!handoff.forwardRecovery) {
    await quiesceNativeReturnSource(input, client, step, handoff);
    if (!input.nativeReturn.checkpointRequested) {
      await step("flush-source", () => client.flushGateway({
        migrationId,
        gatewayId: targets.fromGatewayId,
        slug,
        reason: "native-return",
      }));
    }
  }
  if (!input.ctx.assertActiveClaim || !input.ctx.persistSchedulerHandoff) {
    throw new Error("native return forward recovery requires strict claimed persistence");
  }
  await input.ctx.assertActiveClaim(handoff.forwardRecovery !== undefined);
  const placement = await input.deps.resolveSourcePlacement(input.uid, targets.fromGatewayId);
  const owner = await input.deps.readUser(input.uid);
  if (!placement || (placement.epoch ?? 0) !== targets.fromEpoch ||
      owner?.currentGatewayId !== targets.fromGatewayId || owner.slug !== slug) {
    throw new Error("native return forward recovery placement changed; source remains fenced");
  }
  assertForwardRecoveryScope(targets);
  handoff.forwardRecovery = {
    schemaVersion: 1, phase: "source-flushed", sourceEpoch: targets.fromEpoch,
  };
  await input.ctx.persistSchedulerHandoff(handoff);
  await step("transfer-agent-store", async () => {
    const transferred = await client.transferState({
      migrationId, slug, fromGatewayId: targets.fromGatewayId, toGatewayId: targets.toGatewayId,
      mode: "final", includeActivationManifest: true,
    });
    if (transferred.imported !== true || transferred.migrationId !== migrationId || transferred.slug !== slug) {
      throw new Error("Native PostgreSQL agent-store handoff was not confirmed");
    }
  });
  if (handoff) await step("stage-scheduler", () => stagePortableSchedules(input.deps, client, handoff));
  await input.deps.setMigrationPhase?.({
    uid: input.uid, sourceGatewayId: targets.fromGatewayId, operationId: input.operationId, phase: "checkpointing",
  });
  await step("request-native-checkpoint", input.nativeReturn.requestCheckpoint);
}

async function quiesceNativeReturnSource(
  input: NativeReturnProvision,
  client: MigrationClient,
  step: (name: string, action: () => Promise<unknown>) => Promise<void>,
  handoff: SchedulerHandoffState,
): Promise<void> {
  const { targets, slug, migrationId, uid, operationId, op, ctx } = input;
  const gatewayId = targets.fromGatewayId;
  const quiesce = () => client.quiesce({
    migrationId, gatewayId, slug, schedulerHandoff: true, schedulerMigrationId: handoff.migrationId, retainNonportable: true,
  });
  try {
    await step("quiesce-source", quiesce);
  } catch (error) {
    const hold = reportedAbandonedNativeScheduler(error, { gatewayId, slug, operationId });
    const recover = input.deps.recoverAbandonedNativeScheduler;
    const assertActiveClaim = ctx.assertActiveClaim;
    if (!hold || !recover || !assertActiveClaim) throw error;
    await step("recover-abandoned-native-scheduler", () => recover({
      fromGatewayId: gatewayId, toGatewayId: targets.toGatewayId, uid, slug, operationId,
      claimedStartedAt: op.startedAt, sourceEpoch: targets.fromEpoch, hold,
    }, client.scheduler, assertActiveClaim));
    await step("quiesce-source", quiesce);
  }
}

async function settleNativeReturnAfterFailure(
  input: NativeReturnProvision,
  ctx: OperationContext,
  native: NativeVmReturn,
  handoff: SchedulerHandoffState | null,
): Promise<OperationResult | null> {
  const { deps, targets, uid, slug, migrationId } = input;
  const current = await deps.readUser(uid);
  if (current?.currentGatewayId === targets.toGatewayId) {
    return completeNativeReturn(deps, ctx, native, { ...targets, uid, migrationId, slug, handoff, operation: input.op });
  }
  if (current?.currentGatewayId !== targets.fromGatewayId) {
    throw new Error("native return ownership changed; checkpoint retained");
  }
  await native.release();
  return null;
}

async function rollbackNativeReturnProvision(input: {
  deps: MigrateUserDeps;
  ctx: OperationContext;
  client: MigrationClient;
  handoff: SchedulerHandoffState | null;
  sourceAssignment: SourceAssignment;
  migrationId: string;
  slug: string;
  error: unknown;
  toGatewayId: string;
}): Promise<OperationResult> {
  const { deps, client, handoff, migrationId, slug } = input;
  try {
    await input.ctx.assertActiveClaim?.();
    await client.abortImport({ migrationId, gatewayId: input.toGatewayId, slug, mode: "final" });
    await client.unmount({ migrationId, gatewayId: input.toGatewayId, slug });
  } catch (error) {
    return failure(`${errorMessage(input.error)}; Target agent-store cleanup pending: ${errorMessage(error)}`, false);
  }
  const cause = errorMessage(input.error);
  if (handoff) {
    const abortFailed = await abortStagedSchedules(deps, client, handoff);
    if (abortFailed) return failure(`${cause}; ${abortFailed}`, false);
  }
  try {
    if (handoff) {
      const unreleased = await reopenSourceScheduler(deps, client, handoff, input.ctx);
      if (unreleased) return failure(`${cause}; ${unreleased}`, false);
    }
    await runReleasedNativeSource(deps, input.ctx, input.sourceAssignment.gatewayId, slug,
      () => client.resume({ migrationId, gatewayId: input.sourceAssignment.gatewayId, slug }));
    await restoreSourceServing(deps, { ...input.sourceAssignment, state: "serving", createIfMissing: false });
    return { steps: [], success: false, error: cause, rolledBack: true };
  } catch (error) {
    return failure(`${cause}; native return source recovery pending: ${errorMessage(error)}`, false);
  }
}

async function persistNativeReturnHandoff(input: {
  deps: MigrateUserDeps;
  ctx: OperationContext;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
  op: Operation;
}): Promise<SchedulerHandoffState> {
  if (!input.ctx.persistSchedulerHandoff) throw new Error("scheduler handoff persistence is required");
  const handoff: SchedulerHandoffState = input.op.schedulerHandoff?.forwardRecovery !== undefined ? input.op.schedulerHandoff : {
    migrationId: claimSchedulerMigrationId(input.migrationId, input.op),
    fromGatewayId: input.targets.fromGatewayId,
    toGatewayId: input.targets.toGatewayId,
    uid: input.uid,
    slug: input.slug,
  };
  await input.ctx.persistSchedulerHandoff({ ...handoff });
  return handoff;
}

async function gatewayClient(deps: MigrateUserDeps, gatewayIds: string[]): Promise<MigrationClient> {
  const urls = new Map(await Promise.all(
    gatewayIds.map(async (gatewayId) => [gatewayId, await deps.resolveGatewayUrl(gatewayId)] as const),
  ));
  return deps.buildClient((transportId) => {
    const url = urls.get(transportId);
    if (!url) throw new Error(`migration client called with unexpected gatewayId: ${transportId}`);
    return url;
  });
}

function schedulerRetirementClient(client: MigrationClient, deps: MigrateUserDeps, target: NativeSchedulerRetirementInput): MigrationClient {
  const scheduler: MigrationClient["scheduler"] = async request => {
    if (request.phase === "stage" && request.gatewayId === target.gatewayId) await retireTargetNativeScheduler(deps, client, target);
    return client.scheduler(request);
  };
  return { ...client, scheduler };
}

async function retireTargetNativeScheduler(deps: MigrateUserDeps, client: MigrationClient, input: NativeSchedulerRetirementInput): Promise<void> {
  await deps.retireNativeSchedulerBeforeStage(input, params => client.scheduler(params));
}

function retainedJobIds(snapshot: unknown): string[] {
  const ids = (snapshot as { retainedJobIds?: unknown } | null | undefined)?.retainedJobIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new Error("partial scheduler export did not report which host-bound jobs it retained");
  }
  return ids as string[];
}

async function stagePortableSchedules(
  deps: MigrateUserDeps,
  client: MigrationClient,
  handoff: SchedulerHandoffState,
): Promise<void> {
  const { migrationId, slug } = handoff;
  const exported = await client.scheduler({ migrationId, slug, gatewayId: handoff.fromGatewayId, phase: "export", retainNonportable: true });
  const retained = retainedJobIds(exported.snapshot);
  deps.log(
    `[migrate-customer] native return ${slug}: portable schedules of ${exported.agentIds.join(", ")} staged on ${handoff.toGatewayId}; ` +
    `host-bound jobs left dormant on ${handoff.fromGatewayId}: ${retained.length ? retained.join(", ") : "none"}`,
  );
  await client.scheduler({
    migrationId, slug, gatewayId: handoff.toGatewayId, phase: "stage", agentIds: exported.agentIds, snapshot: exported.snapshot,
  });
}

async function abortStagedSchedules(
  deps: MigrateUserDeps,
  client: MigrationClient,
  handoff: SchedulerHandoffState,
): Promise<string | null> {
  try {
    await client.scheduler({ migrationId: handoff.migrationId, slug: handoff.slug, gatewayId: handoff.toGatewayId, phase: "abort" });
    return null;
  } catch (abortError) {
    const message = `target scheduler abort unconfirmed on ${handoff.toGatewayId}, source left closed: ${errorMessage(abortError)}`;
    deps.log(`[migrate-customer] ⚠ native return ${handoff.slug}: ${message}`);
    return message;
  }
}

async function reopenSourceScheduler(
  deps: MigrateUserDeps,
  client: MigrationClient,
  handoff: SchedulerHandoffState,
  ctx: OperationContext,
): Promise<string | null> {
  try {
    const resume = () => client.scheduler({ migrationId: handoff.migrationId, slug: handoff.slug, gatewayId: handoff.fromGatewayId, phase: "resume" });
    await runReleasedNativeSource(deps, ctx, handoff.fromGatewayId, handoff.slug, resume);
    return null;
  } catch (resumeError) {
    const message = `scheduler fence ${handoff.migrationId} on ${handoff.fromGatewayId} not released: ${errorMessage(resumeError)}`;
    deps.log(`[migrate-customer] ⚠ native return ${handoff.slug}: ${message}`);
    return message;
  }
}

async function activateSharedSchedules(
  deps: MigrateUserDeps,
  ctx: OperationContext,
  handoff: SchedulerHandoffState,
): Promise<void> {
  await ctx.assertActiveClaim?.();
  const target = await gatewayClient(deps, [handoff.toGatewayId]);
  await target.scheduler({ migrationId: handoff.migrationId, slug: handoff.slug, gatewayId: handoff.toGatewayId, phase: "activate" });
}

function logFencedSchedulerRetirement(deps: MigrateUserDeps, handoff: SchedulerHandoffState, cause: string): void {
  deps.log(
    `[migrate-customer] ⚠ native return ${handoff.slug}: the VM's schedules were not retired before it parked; ` +
    `its exported copies stay fenced under ${handoff.migrationId} on ${handoff.fromGatewayId} for automatic retirement on the next native activation: ${cause}`,
  );
}

interface MigrationExecutionInput {
  deps: MigrateUserDeps;
  ctx: OperationContext;
  op: Operation;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
  automatic: boolean;
}

function migrateUserProgress(input: Pick<MigrationExecutionInput, "deps" | "op" | "slug" | "migrationId"> & {
  targets: Pick<MigrationTargets, "fromGatewayId" | "toGatewayId">;
}) {
  const { deps, op, targets, slug, migrationId } = input;
  const attempt = (op.attempts ?? 0) + 1;
  const scope = { operationId: op.id, migrationId, attempt, builderSlug: slug, category: "migration",
    gatewayId: targets.toGatewayId, sourceGateway: targets.fromGatewayId, targetGateway: targets.toGatewayId };
  return createMigrationProgress({
    now: deps.now,
    log: (message) => withLogContext(scope, () => deps.log(message)),
    send: (event) => deps.reportMigrationProgress(targets.toGatewayId, {
      ...event, migrationId, slug, source: targets.fromGatewayId,
    }),
    persist: (event) => deps.recordMigrationProgress({
      operation: op,
      event: { ...event, migrationId, slug, source: targets.fromGatewayId, attempt },
    }),
  });
}

function destinationProgressContext(ctx: OperationContext, progress: ReturnType<typeof createMigrationProgress>): OperationContext {
  return {
    ...ctx,
    reportStep: async (step) => {
      await ctx.reportStep(step);
      await progress.report(step.name, step.status, step.status === "running" ? step.startedAt : step.completedAt);
    },
  };
}

function withImportProgress(client: MigrationClient, progress: ReturnType<typeof createMigrationProgress>): MigrationClient {
  return {
    ...client,
    transferState: input => client.transferState(input.mode === "final" ? {
      ...input,
      reportImport: (status, at) => progress.report("target-import-and-activation", status, at),
    } : input),
  };
}

async function reportNativeReturnStep<T>(
  deps: MigrateUserDeps,
  ctx: OperationContext,
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  await ctx.reportStep(reportedToOperationStep({ name, status: "running" }, deps.now()));
  let result: T;
  try {
    result = await action();
  } catch (error) {
    await ctx.reportStep(reportedToOperationStep(
      { name, status: error instanceof MigrationDrainPendingError ? "skipped" : "failed", error: errorMessage(error) },
      deps.now(),
    ));
    throw error;
  }
  await ctx.reportStep(reportedToOperationStep({ name, status: "done" }, deps.now()));
  return result;
}

// The user stays quiescing (the edge answers 503) until a retry re-drives
// the migration, so a failure here is loud.
async function restoreSourceServing(
  deps: MigrateUserDeps,
  assignment: Parameters<MigrateUserDeps["setAssignmentState"]>[0],
): Promise<void> {
  try {
    await deps.setAssignmentState(assignment);
  } catch (error) {
    deps.log(
      `[migrate-customer] ❌ FAILED to restore assignment serving for uid=${assignment.uid} ` +
      `on ${assignment.gatewayId}: ${errorMessage(error)} — the user stays quiescing`,
    );
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: string, rolledBack?: false): OperationResult {
  return {
    steps: [],
    success: false,
    error,
    ...(rolledBack === false ? { rolledBack } : {}),
  };
}

function migrationRequest(input: MigrateUserInput):
  | { uid: string; toGatewayId: string }
  | { error: string } {
  if (typeof input.uid !== "string" || input.uid.length === 0) {
    return { error: "missing uid in op.input" };
  }
  if (typeof input.toGatewayId !== "string" || input.toGatewayId.length === 0) {
    return { error: "missing toGatewayId in op.input" };
  }
  return { uid: input.uid, toGatewayId: input.toGatewayId };
}

function durableMigrationTargets(state: UserMigrationV2State): MigrationTargets {
  return {
    toGatewayId: state.targetGatewayId,
    toGatewayClass: state.targetRootFence.gatewayClass,
    fromGatewayId: state.sourceGatewayId,
    toRelease: state.targetRelease,
    fromRelease: state.sourceRelease,
    fromEpoch: state.sourceEpoch,
    sourceAssignmentMode: state.sourceAssignmentMode,
  };
}

function terminalDurableMigrationResult(
  deps: MigrateUserDeps,
  op: Operation,
  input: MigrateUserInput,
  request: { uid: string; toGatewayId: string },
): OperationResult | null {
  const state = op.userMigrationV2;
  if (state?.phase !== "complete" && state?.phase !== "aborted") return null;
  const scopeChanged = [
    state.operationId !== op.id,
    state.migrationId !== deps.genMigrationId(op.id),
    state.uid !== request.uid,
    state.targetGatewayId !== request.toGatewayId,
    typeof input.fromGatewayId === "string" &&
      input.fromGatewayId !== state.sourceGatewayId,
  ].some(Boolean);
  if (scopeChanged) return failure("durable user migration V2 input changed");
  return state.phase === "complete"
    ? { steps: [], success: true, rolledBack: false }
    : {
        steps: [],
        success: false,
        error: state.abortReason ?? "user migration V2 aborted",
        rolledBack: true,
      };
}

function resumeDurableMigration(
  deps: MigrateUserDeps,
  op: Operation,
  ctx: OperationContext,
): Promise<OperationResult> | null {
  const state = op.userMigrationV2;
  if (!state) return null;
  return runOrdinaryMigrationV2({
    op,
    ctx,
    deps,
    targets: durableMigrationTargets(state),
    uid: state.uid,
    slug: state.slug,
    migrationId: state.migrationId,
  });
}

async function executeNativeReturn(input: MigrationExecutionInput & {
  durable: boolean;
  nativeReturn: NativeVmReturn;
}): Promise<OperationResult> {
  if (input.durable) throw new Error("native VM returns require a Shared target");
  return runNativeReturn({
    deps: input.deps,
    ctx: input.ctx,
    op: input.op,
    operationId: input.op.id,
    targets: input.targets,
    uid: input.uid,
    slug: input.slug,
    migrationId: input.migrationId,
    automatic: input.automatic,
    nativeReturn: input.nativeReturn,
  });
}

async function runReleasedNativeSource(
  deps: MigrateUserDeps,
  ctx: OperationContext,
  gatewayId: string,
  slug: string,
  call: () => Promise<unknown>,
): Promise<void> {
  const deadline = deps.now() + MIGRATION_QUIESCE_TIMEOUT_MS;
  while (true) {
    await ctx.assertActiveClaim?.();
    try {
      await call();
    } catch (error) {
      const unavailable = error instanceof MigrationTransportError ||
        (error instanceof MigrationRpcError && [502, 503, 504].includes(error.status ?? 0)) ||
        (error instanceof MigrationRpcError && error.status === 500 && /WS open failed|socket closed before connect response/i.test(error.message)) ||
        isTargetSchedulerNotReady(error);
      if (!unavailable) throw error;
      if (deps.now() >= deadline) {
        throw new Error(`native source ${gatewayId} did not resume after checkpoint release (timed out): ${errorMessage(error)}`);
      }
      deps.log(`native return ${slug}: waiting for released source ${gatewayId}: ${errorMessage(error)}`);
      await deps.sleep(Math.min(DEFAULT_AGENT_ATTACH_POLL_MS, deadline - deps.now()));
      continue;
    }
    await ctx.assertActiveClaim?.();
    return;
  }
}

async function completeNativeReturn(
  deps: MigrateUserDeps,
  ctx: OperationContext,
  native: NativeVmReturn,
  input: NativeReturnTarget & { handoff: SchedulerHandoffState | null; operation: Operation },
): Promise<OperationResult> {
  try {
    await reportNativeReturnStep(deps, ctx, "checkpoint-native-computer", native.awaitCheckpoint);
    try {
      await ctx.assertUserRestoreSettled?.();
    } catch (error) {
      if (!(error instanceof PendingUserRestoreError)) throw error;
      await resumeDispatchedSharedRestore(deps, ctx, input);
      await ctx.assertUserRestoreSettled?.();
    }
    await reportNativeReturnStep(deps, ctx, "release-native-writers", native.releaseWriterHold);
    const park = await closeLiveNativeSource(deps, ctx, native, input);
    const parked = await reportNativeReturnStep(deps, ctx, "park-native-computer", () => native.park(park));
    logNativePark(deps, input, parked);
    if (input.handoff) {
      const handoff = input.handoff;
      await reportNativeReturnStep(deps, ctx, "activate-scheduler", () => activateSharedSchedules(deps, ctx, handoff));
    }
    await reportNativeReturnStep(deps, ctx, "verify-target", () => verifyNativeReturnTarget(deps, input));
    await native.acknowledgeCompletedSchedulerHandoff();
    return { steps: [], success: true, rolledBack: false, output: { nativeSourcePark: { ...parked } } };
  } catch (error) {
    return failure(`native return completion pending: status 503: ${errorMessage(error)}`, false);
  }
}

async function closeLiveNativeSource(
  deps: MigrateUserDeps,
  ctx: OperationContext,
  native: NativeVmReturn,
  input: NativeReturnTarget & { handoff: SchedulerHandoffState | null },
): Promise<NativeSourcePark> {
  const { handoff, slug, fromGatewayId } = input;
  const status = await native.sourceVmStatus();
  if (status !== "RUNNING") {
    const reason = `source VM is ${status ?? "absent"}`;
    deps.log(`native return ${slug}: ${reason}; scheduler retire and unmount RPCs skipped`);
    if (handoff) logFencedSchedulerRetirement(deps, handoff, reason);
    return { mode: "stop", reason };
  }
  let schedulesRetired = false;
  try {
    const live = await gatewayClient(deps, [fromGatewayId]);
    if (handoff) {
      await reportNativeReturnStep(deps, ctx, "retire-source-scheduler", () => runReleasedNativeSource(deps, ctx, fromGatewayId, slug,
        () => live.scheduler({ migrationId: handoff.migrationId, slug, gatewayId: fromGatewayId, phase: "retire" })));
      schedulesRetired = true;
    }
    await reportNativeReturnStep(deps, ctx, "unmount-source", () => runReleasedNativeSource(deps, ctx, fromGatewayId, slug,
      () => live.unmount({ migrationId: input.migrationId, gatewayId: fromGatewayId, slug })));
    return { mode: "suspend" };
  } catch (error) {
    await ctx.assertActiveClaim?.();
    const reason = `live source cleanup failed: ${errorMessage(error)}`;
    deps.log(`[migrate-customer] ⚠ native return ${slug}: ${reason}; stopping ${fromGatewayId} instead of suspending it`);
    if (handoff && !schedulesRetired) logFencedSchedulerRetirement(deps, handoff, reason);
    return { mode: "stop", reason };
  }
}

function logNativePark(deps: MigrateUserDeps, input: NativeReturnTarget, parked: NativeReturnPark): void {
  deps.log(parked.stopReason === undefined
    ? `native return ${input.slug}: source ${input.fromGatewayId} ${parked.parked} for reuse`
    : `[migrate-customer] ⚠ native return ${input.slug}: source ${input.fromGatewayId} ${parked.parked} instead of suspended: ${parked.stopReason}`);
}

interface NativeReturnTarget {
  uid: string;
  fromGatewayId: string;
  toGatewayId: string;
  slug: string;
  migrationId: string;
}

async function withAssignedSharedRestoreFence(
  deps: MigrateUserDeps,
  ctx: OperationContext,
  input: NativeReturnTarget,
  work: () => Promise<void>,
): Promise<void> {
  if (!ctx.assertActiveClaim) throw new Error("Shared restore requires an active operation claim check");
  if (!ctx.withUserRestoreFence) throw new Error("Shared restore requires durable assignment coordination");
  const placement = await deps.resolveSourcePlacement(input.uid, input.toGatewayId);
  if (placement?.epoch === undefined) throw new Error("Shared restore requires an assigned epoch");
  await ctx.assertActiveClaim();
  await ctx.withUserRestoreFence({
    uid: input.uid, slug: input.slug, gatewayId: input.toGatewayId,
    fromGatewayId: input.fromGatewayId, assignmentEpoch: placement.epoch, resume: true,
  }, work);
  await ctx.assertActiveClaim();
  const owner = await deps.readUser(input.uid);
  if (owner?.slug !== input.slug || owner.currentGatewayId !== input.toGatewayId) {
    throw new Error("Shared restore owner changed before verification");
  }
}

async function resumeDispatchedSharedRestore(
  deps: MigrateUserDeps,
  ctx: OperationContext,
  input: NativeReturnTarget,
): Promise<void> {
  const url = await deps.resolveGatewayUrl(input.toGatewayId);
  const snapshot = await deps.readUserSnapshot(input.uid, input.toGatewayId);
  if (!snapshot || snapshot.uid !== input.uid || snapshot.slug !== input.slug ||
      snapshot.gatewayId !== input.toGatewayId || snapshot.status !== "complete") {
    throw new Error("Shared restore snapshot no longer proves the assigned complete owner");
  }
  await withAssignedSharedRestoreFence(deps, ctx, input, () => reportNativeReturnStep(deps, ctx, "restore-target", async () => {
    const result = await deps.buildClient(() => url).restoreTarget({
      migrationId: input.migrationId, gatewayId: input.toGatewayId,
      uid: input.uid, slug: input.slug, snapshot, resume: true,
    });
    if (result.restored !== true || result.migrationId !== input.migrationId || result.slug !== input.slug) {
      throw new Error("Shared restore did not confirm the matching migration");
    }
  }));
}

function defaultAgentAttachInProgress(error: unknown): boolean {
  return error instanceof MigrationRpcError && error.code === MIGRATION_VERIFY_DEFAULT_AGENT_ATTACH_IN_PROGRESS;
}

async function verifyNativeReturnTarget(
  deps: MigrateUserDeps,
  input: { toGatewayId: string; slug: string; migrationId: string },
): Promise<void> {
  const url = await deps.resolveGatewayUrl(input.toGatewayId);
  const client = deps.buildClient(() => url);
  const deadline = deps.now() + ADD_USER_DEADLINE_MS;
  for (;;) {
    try {
      const result = await client.verifyTarget({
        migrationId: input.migrationId, gatewayId: input.toGatewayId, slug: input.slug,
      });
      if (!result.ready) throw new Error(`Shared agent ${input.slug} is not ready`);
      return;
    } catch (error) {
      if (!defaultAgentAttachInProgress(error) || deps.now() >= deadline) throw error;
      deps.log(`native return ${input.slug}: ${input.toGatewayId} is still attaching the agent; verifying again`);
      await deps.sleep(DEFAULT_AGENT_ATTACH_POLL_MS);
    }
  }
}

async function finishNativeReturnAfterCutover(
  deps: MigrateUserDeps,
  op: Operation,
  ctx: OperationContext,
  user: UserGatewayInfo,
  request: { uid: string; toGatewayId: string },
): Promise<OperationResult | null> {
  if (typeof op.input.fromGatewayId !== "string") return null;
  const fromGatewayId = op.input.fromGatewayId;
  const native = await deps.prepareNativeVmReturn({
    fromGatewayId, toGatewayId: user.currentGatewayId, uid: request.uid, slug: user.slug, operationId: op.id, claimedStartedAt: op.startedAt,
  });
  if (!native) return null;
  const handoff = op.schedulerHandoff ?? null;
  if (handoff && (
    handoff.uid !== request.uid || handoff.slug !== user.slug ||
    handoff.fromGatewayId !== fromGatewayId || handoff.toGatewayId !== user.currentGatewayId
  )) {
    return failure("scheduler handoff scope changed after cutover", false);
  }
  const migrationId = deps.genMigrationId(op.id);
  const targets = { fromGatewayId, toGatewayId: user.currentGatewayId };
  const progressCtx = destinationProgressContext(ctx, migrateUserProgress({ deps, op, targets, slug: user.slug, migrationId }));
  return completeNativeReturn(deps, progressCtx, native, {
    uid: request.uid, ...targets, slug: user.slug, migrationId, handoff, operation: op,
  });
}

async function completeSchedulerHandoff(
  deps: MigrateUserDeps,
  op: Operation,
  ctx: OperationContext,
  user: UserGatewayInfo,
  request: { uid: string; toGatewayId: string },
): Promise<OperationResult> {
  const handoff = op.schedulerHandoff!;
  if (handoff.uid !== request.uid || handoff.slug !== user.slug || handoff.toGatewayId !== request.toGatewayId) {
    return failure("scheduler handoff scope changed after cutover", false);
  }
  const migrationId = deps.genMigrationId(op.id);
  if (handoff.stageAfterCutover && !handoff.forwardRecovery && handoff.fromGatewayId.startsWith("shared-")) {
    try {
      const client = await gatewayClient(deps, [handoff.toGatewayId]);
      await client.resume({ migrationId, gatewayId: handoff.toGatewayId, slug: handoff.slug, role: "target" });
      const expectedSystemConfigCommit = await awaitTargetSystemConfigCommit(deps, handoff.toGatewayId, ctx.assertActiveClaim);
      if (!expectedSystemConfigCommit) throw new Error(`target ${handoff.toGatewayId} has no accepted system config commit to converge ${handoff.slug} on`);
      await client.flushGateway({ migrationId, gatewayId: handoff.toGatewayId, slug: handoff.slug, reason: "migration-converge", expectedSystemConfigCommit });
    } catch (error) {
      return failure(`migration cutover committed; destination recovery pending: status 503: ${errorMessage(error)}`, false);
    }
  }
  const restored: ScheduleRestoreOutcome[] = [];
  try {
    if (handoff.scheduleTransfer) restored.push(await restoreSchedulesAfterCutover(deps, op, ctx, handoff, migrationId));
    else await finishLegacySchedulerHandoff(deps, op, handoff);
  } catch (error) {
    return failure(`migration cutover committed; destination recovery pending: status 503: ${errorMessage(error)}`, false);
  }
  await unmountSourceAfterCutover(deps, { migrationId, slug: handoff.slug, gatewayId: handoff.fromGatewayId });
  return scheduleRestoreResult(deps, op, handoff, restored);
}

type UnreleasedSchedulerFence = Extract<SchedulerFenceOutcome, { outcome: "kept" | "failed" }>;

interface ScheduleRestoreOutcome {
  unrestored: ScheduleRestoreFailure[];
  unreleased: UnreleasedSchedulerFence[];
}

function scheduleRestoreResult(
  deps: MigrateUserDeps, op: Operation, handoff: SchedulerHandoffState, restored: readonly ScheduleRestoreOutcome[],
): OperationResult {
  const gatewayId = handoff.toGatewayId;
  const unrestored = restored.flatMap(outcome => outcome.unrestored);
  const unreleased = restored.flatMap(outcome => outcome.unreleased);
  if (unrestored.length === 0 && unreleased.length === 0) return { steps: [], success: true, rolledBack: false };
  const output = {
    ...(unrestored.length > 0 ? { scheduleRestoreFailures: unrestored.map(({ name, agentId, sourceJobId, error }) =>
      ({ gatewayId, agentId, sourceJobId, job: name, error })) } : {}),
    ...(unreleased.length > 0
      ? { unreleasedSchedulerFences: unreleased.map(fence => ({ gatewayId, agentId: fence.agentId, holder: fence.holder, reason: fenceReason(fence) })) } : {}),
  };
  if (handoff.stageAfterCutover !== true) return { steps: [], success: true, rolledBack: false, output };
  const error = `schedules were not restored after the cutover onto ${gatewayId}: ` +
    `${unrestored.length} ${unrestored.length === 1 ? "schedule" : "schedules"} not restored, ` +
    `${unreleased.length} scheduler ${unreleased.length === 1 ? "fence" : "fences"} kept`;
  deps.log(`[migrate-customer] ❌ ${handoff.slug}: ${error} op=${op.id}`);
  return { steps: [], success: false, rolledBack: false, failedAfterCutover: true, error, output };
}

function fenceReason(fence: UnreleasedSchedulerFence): string {
  return fence.outcome === "kept" ? fence.reason : fence.error;
}

function legacySchedulerHandoffDeps(
  deps: MigrateUserDeps, op: Operation, ctx: OperationContext, handoff: SchedulerHandoffState, restored: ScheduleRestoreOutcome[],
): Pick<MigrationRunnerDeps, "finishLegacySchedulerHandoff"> {
  return { finishLegacySchedulerHandoff: async () => {
    if (handoff.scheduleTransfer) restored.push(await restoreSchedulesAfterCutover(deps, op, ctx, handoff, deps.genMigrationId(op.id)));
    else await finishLegacySchedulerHandoff(deps, op, handoff);
  } };
}

async function finishLegacySchedulerHandoff(deps: MigrateUserDeps, op: Operation, handoff: SchedulerHandoffState): Promise<void> {
  const { migrationId, slug, uid, fromGatewayId, toGatewayId } = handoff;
  const client = await gatewayClient(deps, [fromGatewayId, toGatewayId]);
  await retireTargetNativeScheduler(deps, client, { uid, slug, gatewayId: toGatewayId, operationId: op.id, claimedStartedAt: op.startedAt });
  try {
    if (handoff.stageAfterCutover && handoff.stagedAt === undefined) {
      const exported = await client.scheduler({ migrationId, slug, gatewayId: fromGatewayId, phase: "export" });
      await client.scheduler({ migrationId, slug, gatewayId: toGatewayId, phase: "stage",
        agentIds: exported.agentIds, snapshot: exported.snapshot, retainNonportable: true });
    }
    await client.scheduler({ migrationId, slug, gatewayId: fromGatewayId, phase: "retire" });
    await client.scheduler({ migrationId, slug, gatewayId: toGatewayId, phase: "activate" });
  } catch (error) {
    deps.log(`[migrate-customer] ⚠ legacy schedule transfer failed migrationId=${migrationId} slug=${slug}: ${errorMessage(error)} — target remains serving`);
  }
}

async function restoreSchedulesAfterCutover(
  deps: MigrateUserDeps,
  op: Operation,
  ctx: OperationContext,
  handoff: SchedulerHandoffState,
  migrationId: string,
): Promise<ScheduleRestoreOutcome> {
  const { uid, slug, toGatewayId } = handoff;
  const client = await gatewayClient(deps, [toGatewayId]);
  await retireTargetNativeScheduler(deps, client, { uid, slug, gatewayId: toGatewayId, operationId: op.id, claimedStartedAt: op.startedAt });
  const unreleased = handoff.stageAfterCutover ? await releaseTargetSchedulerCustody(deps, op, ctx, client, handoff) : [];
  const unrestored = await restoreScheduleTransfer({ client, log: deps.log, now: deps.now, ...scheduleTransferDeps(deps, uid) },
    { migrationId, slug, gatewayId: toGatewayId, custodyReleased: unreleased.length === 0 });
  const retryable = unrestored.filter(failure => failure.transient);
  if (handoff.stageAfterCutover && retryable.length > 0) {
    throw new Error(`${retryable.length} of ${unrestored.length} unrestored schedules on ${toGatewayId} may yet be restored: ${retryable[0].error}`);
  }
  return { unrestored: unrestored.map(failure => ({ ...failure, error: withUnreleasedFence(failure.error, unreleased) })), unreleased };
}

async function releaseTargetSchedulerCustody(
  deps: MigrateUserDeps, op: Operation, ctx: OperationContext, client: MigrationClient, handoff: SchedulerHandoffState,
): Promise<UnreleasedSchedulerFence[]> {
  const { uid, slug, toGatewayId } = handoff;
  const outcomes = await releaseSchedulerCustody({
    scheduler: params => client.scheduler(params),
    readOperation: deps.readOperation,
    assertOwner: async () => {
      await ctx.assertActiveClaim?.(true);
      const owner = await deps.readUser(uid);
      if (owner?.currentGatewayId !== toGatewayId) throw new Error(`${slug} is no longer assigned to ${toGatewayId}`);
    },
    log: deps.log,
  }, { uid, slug, gatewayId: toGatewayId, operationId: op.id, ownedSince: op.cutoverCommittedAt ?? deps.now() }, await deps.readUserAgentIds(uid));
  const unreleased = outcomes.filter((outcome): outcome is UnreleasedSchedulerFence => outcome.outcome === "kept" || outcome.outcome === "failed");
  const failed = unreleased.filter(fence => fence.outcome === "failed");
  const retryable = failed.filter(fence => fence.transient);
  if (retryable.length > 0) {
    throw new Error(retryable.map(fence => `scheduler fence of ${fence.agentId} on ${toGatewayId} was not released: ${fence.error}`).join("; "));
  }
  for (const fence of failed) {
    const heldBy = fence.holder ? ` held by ${fence.holder}` : "";
    deps.log(`[migrate-customer] ❌ ${slug}: could not release the scheduler fence of ${fence.agentId} on ${toGatewayId}${heldBy}: ${fence.error} op=${op.id}`);
  }
  return unreleased;
}

function withUnreleasedFence(error: string, unreleased: readonly UnreleasedSchedulerFence[]): string {
  const held = heldSchedulerMigration(error);
  const fence = held === null ? undefined : unreleased.find(candidate => candidate.agentId === held.agentId);
  if (fence === undefined) return error;
  return fence.outcome === "kept" ? `${error} (fence kept: ${fence.reason})` : `${error} (fence release failed: ${fence.error})`;
}

async function unmountSourceAfterCutover(
  deps: MigrateUserDeps,
  source: { migrationId: string; slug: string; gatewayId: string },
): Promise<void> {
  try {
    const client = await gatewayClient(deps, [source.gatewayId]);
    await client.unmount(source);
  } catch (error) {
    deps.log(
      `[migrate-customer] ⚠ unmount-source cleanup failed after durable cutover migrationId=${source.migrationId} ` +
      `slug=${source.slug} source=${source.gatewayId}: ${errorMessage(error)} — target remains serving`,
    );
  }
}

async function sharedRecoveryAuthority(deps: MigrateUserDeps, op: Operation, user: UserGatewayInfo, uid: string): Promise<WorkspaceMigrationRecoveryParams> {
  if (!deps.assertMigrationRecoveryAuthority || !deps.completeMigrationRecovery || typeof op.startedAt !== "number" || op.schedulerHandoff?.toGatewayId !== op.input.toGatewayId) {
    throw new Error("Shared migration recovery requires exact claimed authority");
  }
  const source = await deps.resolveSourcePlacement(uid, user.currentGatewayId);
  if (!source || source.assignmentMode !== "assigned" || source.epoch === undefined) throw new Error("Shared migration recovery source assignment disappeared");
  const handoff = op.schedulerHandoff!;
  const intent = handoff.sourceRecovery;
  if (op.input.recoverSourceOnly === true && (!intent || intent.migrationId !== handoff.migrationId || intent.sourceEpoch !== source.epoch || !Array.isArray(intent.steps))) {
    throw new Error("Shared migration recovery intent missing or changed");
  }
  const recovery = { uid, sourceGatewayId: user.currentGatewayId, operationId: op.id, sourceEpoch: source.epoch, claimStartedAt: op.startedAt };
  await deps.assertMigrationRecoveryAuthority(recovery);
  return recovery;
}

function ownershipCheckedSourceRecovery(op: Operation, previous: SchedulerHandoffState): boolean {
  return !op.userMigrationV2 && previous.fromGatewayId.startsWith("shared-") &&
    (previous.toGatewayId.startsWith("shared-") || userActivationSourceRecoveryPending(op));
}

async function cleanupPreviousSchedulerTarget(deps: MigrateUserDeps, op: Operation, ctx: OperationContext, previous: SchedulerHandoffState, input: {
  sharedScope: boolean; recovery?: WorkspaceMigrationRecoveryParams; assertNativeReturnCurrent?: () => Promise<void>;
}): Promise<void> {
  const { sharedScope, recovery, assertNativeReturnCurrent } = input;
  if (sharedScope && sharedRecoveryTargetCleaned(op.input, previous)) return;
  await assertNativeReturnCurrent?.();
  if (!previous.stageAfterCutover) await abortPreviousTargetAttempt(deps, previous, assertNativeReturnCurrent);
  if (userActivationSourceRecoveryPending(op) || op.input.recoverSourceOnly === true && op.input.source === "builder-activation-lease") {
    if (!recovery || !deps.prepareIsolatedRecoveryTarget) throw new Error("User source recovery target preparation is unavailable");
    await deps.assertMigrationRecoveryAuthority!(recovery);
    await deps.prepareIsolatedRecoveryTarget({ recovery, targetGatewayId: previous.toGatewayId, migrationId: deps.genMigrationId(op.id), slug: previous.slug });
    await deps.assertMigrationRecoveryAuthority!(recovery);
    if (previous.forwardRecovery || !attemptNeverHeldSource(op)) await prepareRecoveryAgentStores(deps, ctx, recovery, previous.toGatewayId, previous.slug);
    const targetUrl = await deps.resolveGatewayUrl(previous.toGatewayId, { allowUnready: true });
    const assertCurrent = activeRecoveryAuthority(deps, ctx, recovery);
    await assertCurrent();
    await deps.buildClient(() => targetUrl).unmount({ migrationId: deps.genMigrationId(op.id), slug: previous.slug, gatewayId: previous.toGatewayId });
    await assertCurrent();
    return;
  }
  if (sharedScope || assertNativeReturnCurrent) await abortSharedTargetLeftovers(deps, op, previous.slug, previous.toGatewayId, assertNativeReturnCurrent);
}

function activeRecoveryAuthority(
  deps: MigrateUserDeps,
  ctx: OperationContext,
  recovery: WorkspaceMigrationRecoveryParams,
): () => Promise<void> {
  const assertActiveClaim = ctx.assertActiveClaim;
  if (!assertActiveClaim) throw new Error("Shared migration recovery requires an active operation claim");
  return async () => {
    await assertActiveClaim();
    await deps.assertMigrationRecoveryAuthority!(recovery);
  };
}

async function prepareRecoveryAgentStores(
  deps: MigrateUserDeps,
  ctx: OperationContext,
  recovery: WorkspaceMigrationRecoveryParams,
  gatewayId: string,
  slug: string,
): Promise<void> {
  if (!deps.prepareMigrationAgentStores) throw new Error("Agent-store recovery requires ownership preparation");
  const assertCurrent = activeRecoveryAuthority(deps, ctx, recovery);
  await assertCurrent();
  await deps.prepareMigrationAgentStores(gatewayId, slug, { expectedUserUid: recovery.uid, assertCurrent });
  await assertCurrent();
}

async function previousNativeReturnCleanupAuthority(
  deps: MigrateUserDeps,
  op: Operation,
  ctx: OperationContext,
  previous: SchedulerHandoffState,
): Promise<(() => Promise<void>) | undefined> {
  if (ownershipCheckedSourceRecovery(op, previous)) return undefined;
  const request = { fromGatewayId: previous.fromGatewayId, toGatewayId: previous.toGatewayId,
    uid: previous.uid, slug: previous.slug, operationId: op.id, claimedStartedAt: op.startedAt };
  if (!await deps.prepareNativeVmReturn(request)) return undefined;
  const assertActiveClaim = ctx.assertActiveClaim;
  if (!assertActiveClaim) throw new Error("native return cleanup requires an active operation claim");
  return async () => {
    await assertActiveClaim();
    const owner = await deps.readUser(previous.uid);
    if (owner?.currentGatewayId !== previous.fromGatewayId || owner.slug !== previous.slug ||
        !await deps.prepareNativeVmReturn(request)) throw new Error("native return cleanup authority changed");
    await assertActiveClaim();
  };
}

async function preparePreviousSourceAgentStores(deps: MigrateUserDeps, ctx: OperationContext, previous: SchedulerHandoffState, input: {
  resumeSourceScheduler: boolean; recovery?: WorkspaceMigrationRecoveryParams; assertNativeReturnCurrent?: () => Promise<void>;
}): Promise<void> {
  if (!input.resumeSourceScheduler) return;
  if (input.recovery) await prepareRecoveryAgentStores(deps, ctx, input.recovery, input.recovery.sourceGatewayId, previous.slug);
  const assertCurrent = input.assertNativeReturnCurrent;
  if (!assertCurrent) return;
  if (!deps.prepareMigrationAgentStores) throw new Error("native return source ownership preparation is unavailable");
  await assertCurrent();
  await deps.prepareMigrationAgentStores(previous.fromGatewayId, previous.slug, {
    expectedUserUid: previous.uid, assertCurrent,
  });
  await assertCurrent();
}

function previousSchedulerNeedsRecovery(op: Operation, previous: SchedulerHandoffState, migrationId: string): boolean {
  return (previous.forwardRecovery === undefined || op.input.recoverSourceOnly === true && releasedUserActivationSourceRecovery(op)) && op.schedulerHandoffReleased !== true &&
    previous.migrationId !== claimSchedulerMigrationId(migrationId, op);
}

function userActivationDeferredForIdle(op: Operation, previous: SchedulerHandoffState): boolean {
  const lastStep = op.steps?.at(-1);
  return op.input.recoverSourceOnly !== true && userActivationSourceRecoveryPending(op) &&
    previous.toGatewayId === op.input.toGatewayId &&
    lastStep?.status === "skipped" &&
    (lastStep.name === "wait-for-active-work" || lastStep.name === "quiesce-source");
}

async function resumePreviousSchedulerAttempt(
  deps: MigrateUserDeps,
  op: Operation,
  ctx: OperationContext,
  user: UserGatewayInfo,
  uid: string,
): Promise<boolean> {
  const previous = op.schedulerHandoff;
  if (!previous || !previousSchedulerNeedsRecovery(op, previous, deps.genMigrationId(op.id))) return false;
  if (previous.fromGatewayId !== user.currentGatewayId || previous.uid !== uid || previous.slug !== user.slug) {
    throw new Error("scheduler rollback scope changed");
  }
  if (userActivationDeferredForIdle(op, previous)) return false;
  const scope = previousAttemptScope(op, previous);
  const recovery = scope.recoveryRequired ? await sharedRecoveryAuthority(deps, op, user, uid) : undefined;
  const assertNativeReturnCurrent = await previousNativeReturnCleanupAuthority(deps, op, ctx, previous);
  await cleanupPreviousSchedulerTarget(deps, op, ctx, previous, { sharedScope: scope.sharedScope, recovery, assertNativeReturnCurrent });
  await preparePreviousSourceAgentStores(deps, ctx, previous, { resumeSourceScheduler: scope.resumeSourceScheduler, recovery, assertNativeReturnCurrent });
  const url = await deps.resolveGatewayUrl(previous.fromGatewayId);
  const client = deps.buildClient(() => url);
  if (recovery) await deps.assertMigrationRecoveryAuthority!(recovery);
  await assertNativeReturnCurrent?.();
  if (scope.resumeSourceScheduler) {
    await client.scheduler({
      migrationId: previous.migrationId, slug: previous.slug, gatewayId: previous.fromGatewayId, phase: "resume",
    });
    await assertNativeReturnCurrent?.();
  }
  if (scope.releaseSourceIngress) {
    await client.resume({ migrationId: deps.genMigrationId(op.id), slug: user.slug, gatewayId: user.currentGatewayId });
    await assertNativeReturnCurrent?.();
  }
  if (recovery) await deps.completeMigrationRecovery!(recovery);
  return recovery !== undefined;
}

function previousAttemptScope(
  op: Operation,
  previous: SchedulerHandoffState,
): { sharedScope: boolean; recoveryRequired: boolean; resumeSourceScheduler: boolean; releaseSourceIngress: boolean } {
  const sharedScope = ownershipCheckedSourceRecovery(op, previous);
  const sourceNeverHeld = op.input.recoverSourceOnly !== true && attemptNeverHeldSource(op);
  return {
    sharedScope,
    recoveryRequired: sharedScope && (!sourceNeverHeld || userActivationSourceRecoveryPending(op)),
    resumeSourceScheduler: !sourceNeverHeld,
    releaseSourceIngress: !legacyAttemptNeverQuiesced(op) && (!sourceNeverHeld || attemptMayHoldSourceIngress(op)),
  };
}

async function abortSharedTargetLeftovers(
  deps: MigrateUserDeps,
  op: Operation,
  slug: string,
  targetGatewayId: string,
  assertCurrent?: () => Promise<void>,
): Promise<void> {
  await assertCurrent?.();
  const targetUrl = await deps.resolveGatewayUrl(targetGatewayId, { allowUnready: true });
  const target = deps.buildClient(() => targetUrl);
  for (const mode of ["keys", "pre", "final"] as const) {
    await assertCurrent?.();
    await target.abortImport({ migrationId: deps.genMigrationId(op.id), slug, gatewayId: targetGatewayId, mode });
  }
  await assertCurrent?.();
  await target.unmount({ migrationId: deps.genMigrationId(op.id), slug, gatewayId: targetGatewayId });
  await assertCurrent?.();
}

async function abortPreviousTargetAttempt(deps: MigrateUserDeps, previous: SchedulerHandoffState, assertCurrent?: () => Promise<void>): Promise<void> {
  const url = await deps.resolveGatewayUrl(previous.toGatewayId, assertCurrent ? { allowUnready: true } : undefined);
  await assertCurrent?.();
  try {
    await deps.buildClient(() => url).scheduler({
      migrationId: previous.migrationId, slug: previous.slug, gatewayId: previous.toGatewayId, phase: "abort",
    });
  } catch (error) {
    if (!isTargetSchedulerNotReady(error)) throw error;
    throw new Error(
      `target gateway ${previous.toGatewayId} scheduler did not become ready to abort ${previous.migrationId}: ${errorMessage(error)}`,
    );
  }
}

async function recoverCommittedMigration(
  deps: MigrateUserDeps,
  op: Operation,
  ctx: OperationContext,
  user: UserGatewayInfo,
  request: { uid: string; toGatewayId: string },
): Promise<OperationResult | null> {
  if (user.currentGatewayId !== request.toGatewayId) return null;
  const nativeReturn = await finishNativeReturnAfterCutover(deps, op, ctx, user, request);
  if (nativeReturn) return nativeReturn;
  if (op.schedulerHandoff) return completeSchedulerHandoff(deps, op, ctx, user, request);
  return isControllerConvergenceSource(op.input.source) ? { steps: [], success: true, rolledBack: false } : null;
}

function assertRetainedMigrationStrategy(op: Operation, durable: boolean, nativeReturn: NativeVmReturn | null): void {
  if (op.input.sourceTransferMode === RETAINED_POD && (!durable || nativeReturn)) throw new Error('retained source transfer requires an ordinary durable migration');
}

function sourceRecoveryOwnershipChanged(op: Operation, user: UserGatewayInfo): boolean {
  return op.input.recoverSourceOnly === true && (op.schedulerHandoff?.forwardRecovery !== undefined && !releasedUserActivationSourceRecovery(op) ||
    op.cutoverCommittedAt !== undefined || user.currentGatewayId !== op.input.fromGatewayId);
}

async function sourceOnlyRecoveryResult(op: Operation, sourceRecovered: boolean, ctx: OperationContext, now: number): Promise<OperationResult | null> {
  if (op.input.recoverSourceOnly !== true && !(sourceRecovered && userActivationSourceRecoveryPending(op))) return null;
  if (!sourceRecovered) throw new Error("source-only recovery requires an abandoned Shared migration");
  await ctx.reportStep(reportedToOperationStep({ name: "recover-source", status: "done" }, now));
  return { steps: [], success: false, rolledBack: true, error: "abandoned Shared migration rolled back; native source recovery completed" };
}

function declaredMigrationSourceChanged(input: MigrateUserInput, resolvedSource: string): boolean {
  return typeof input.fromGatewayId === "string" && input.fromGatewayId !== resolvedSource;
}

async function prepareSharedSourceAgentStores(input: {
  deps: MigrateUserDeps; op: Operation; ctx: OperationContext;
  targets: MigrationTargets; uid: string; slug: string;
}): Promise<boolean> {
  const { deps, op, ctx, targets, uid, slug } = input;
  if (targets.fromGatewayClass !== "shared" || targets.sourceAssignmentMode !== "assigned" ||
      op.input.fromGatewayId !== targets.fromGatewayId || op.steps.length !== 0 ||
      op.schedulerHandoff && op.schedulerHandoffReleased !== true) return false;
  if (!ctx.assertActiveClaim || !deps.setMigrationPhase || !deps.assertMigrationSourcePreparationAuthority || !deps.prepareMigrationAgentStores) {
    throw new Error("Shared source preparation requires ownership preparation and claimed placement authority");
  }
  const authority: WorkspaceMigrationSourcePreparationParams = {
    uid, slug, sourceGatewayId: targets.fromGatewayId, targetGatewayId: targets.toGatewayId,
    operationId: op.id, sourceEpoch: targets.fromEpoch, claimStartedAt: requiredClaimStartedAt(op),
  };
  const assertCurrent = async () => {
    await ctx.assertActiveClaim!();
    await deps.assertMigrationSourcePreparationAuthority!(authority);
  };
  await ctx.assertActiveClaim();
  await deps.setMigrationPhase({ uid, sourceGatewayId: targets.fromGatewayId, operationId: op.id, phase: "preparing" });
  try {
    await assertCurrent();
    await deps.prepareMigrationAgentStores(targets.fromGatewayId, slug, { expectedUserUid: uid, assertCurrent });
    await assertCurrent();
  } catch (error) {
    await clearFailedSourcePreparation({ deps, op, ctx, targets, uid }, error);
    throw error;
  }
  return true;
}

async function clearFailedSourcePreparation(input: {
  deps: MigrateUserDeps; op: Operation; ctx: OperationContext; targets: MigrationTargets; uid: string;
}, cause: unknown): Promise<void> {
  const { deps, op, ctx, targets, uid } = input;
  if (op.input.source === "builder-activation-lease" || !deps.clearMigrationPreparation) return;
  try {
    await ctx.assertActiveClaim!();
  } catch {
    return;
  }
  try {
    await deps.clearMigrationPreparation({
      uid,
      sourceGatewayId: targets.fromGatewayId,
      operationId: op.id,
      sourceAssignmentMode: targets.sourceAssignmentMode,
      sourceRelease: targets.fromRelease,
      sourceEpoch: targets.fromEpoch,
      ...(targets.sourceRootUpdatedAt !== undefined ? { sourceRootUpdatedAt: targets.sourceRootUpdatedAt } : {}),
    });
  } catch (cleanupError) {
    throw new Error(`${errorMessage(cause)}; the preparation fence could not be cleared: ${errorMessage(cleanupError)}`);
  }
}

function migrationPlacementFailure(op: Operation, failure: { error: string }): { error: string; rolledBack?: false } {
  if (op.schedulerHandoff?.forwardRecovery && /: revision-not-ready(?: \(.+\))?$/u.test(failure.error)) {
    return { error: `migration forward recovery pending: status 503: ${failure.error}`, rolledBack: false };
  }
  return failure;
}

function terminalMigrationPreparationError(
  op: Operation,
  user: UserGatewayInfo,
  toGatewayId: string,
): { error: string; rolledBack: false } | null {
  if (op.cutoverCommittedAt !== undefined) {
    return {
      error:
        `migration cutover already committed to ${toGatewayId}; customer now owned by ${user.currentGatewayId} — ` +
        "source cleanup left to the eviction sweep",
      rolledBack: false,
    };
  }
  if (op.input.recoverSourceOnly !== true && releasedUserActivationSourceRecovery(op)) {
    return { error: RELEASED_ISOLATED_TARGET_ERROR, rolledBack: false };
  }
  return null;
}

class GatewayCompatibilityPendingError extends Error {}

async function sourceCanAdoptPrivateProjectAgent(deps: MigrateUserDeps, uid: string, slug: string, targets: MigrationTargets): Promise<boolean> {
  const user = await deps.readUserSnapshot(uid, targets.toGatewayId);
  if (!user || user.uid !== uid || user.slug !== slug || user.gatewayId !== targets.fromGatewayId) {
    throw new Error("Could not verify project agent eligibility on the current source");
  }
  return user.projectAgents?.some(agent => agent.githubBacked && agent.enabled && agent.status !== "error" && Boolean(agent.token)) ?? false;
}

async function assertPrivateProjectAgentCompatibility(deps: MigrateUserDeps, op: Operation, targets: MigrationTargets, user: { uid: string; slug: string }): Promise<void> {
  const readWorkspace = deps.readPrivateProjectAgentWorkspace;
  if (!readWorkspace || op.schedulerHandoff?.forwardRecovery) return;
  const { uid, slug } = user;
  let reason = `gateway ${targets.toGatewayId} has not reported private project agent workspace support`;
  try {
    const sourceWorkspace = await readWorkspace(targets.fromGatewayId, slug);
    if (sourceWorkspace === undefined) return;
    if (!sourceWorkspace && !await sourceCanAdoptPrivateProjectAgent(deps, uid, slug, targets)) return;
    if (await readWorkspace(targets.toGatewayId, slug) !== undefined) return;
  } catch (error) {
    reason = errorMessage(error);
  }
  throw new GatewayCompatibilityPendingError(`gateway compatibility pending: status 503: ${reason}`);
}

async function prepareMigration(
  deps: MigrateUserDeps,
  op: Operation,
  ctx: OperationContext,
  migrationInput: MigrateUserInput,
  request: { uid: string; toGatewayId: string },
): Promise<
  | PreparedMigration
  | { result: OperationResult }
  | { error: string; rolledBack?: false }
> {
  let user: UserGatewayInfo | null;
  try {
    user = await deps.readUser(request.uid);
  } catch (error) {
    return { error: op.schedulerHandoff?.stageAfterCutover === true
      ? `migration ownership lookup pending: status 503: ${errorMessage(error)}`
      : errorMessage(error) };
  }
  if (!user) return { error: `user not found: ${request.uid}` };
  if (sourceRecoveryOwnershipChanged(op, user)) {
    return { error: "source recovery cannot reverse cutover or changed ownership", rolledBack: false };
  }
  const recovered = await recoverCommittedMigration(deps, op, ctx, user, request);
  if (recovered) return { result: recovered };
  const terminal = terminalMigrationPreparationError(op, user, request.toGatewayId);
  if (terminal) return terminal;
  const migrationId = deps.genMigrationId(op.id);

  try {
    const sourceRecovered = await resumePreviousSchedulerAttempt(deps, op, ctx, user, request.uid);
    const rollback = await sourceOnlyRecoveryResult(op, sourceRecovered, ctx, deps.now());
    if (rollback) return { result: rollback };
    const resolved = await resolveMigrationTargets(
      deps,
      request.uid,
      user,
      request.toGatewayId,
    );
    if ("error" in resolved) return migrationPlacementFailure(op, resolved);
    if (declaredMigrationSourceChanged(migrationInput, resolved.targets.fromGatewayId)) {
      return {
        error:
          `declared source ${migrationInput.fromGatewayId} does not match resolved source ${resolved.targets.fromGatewayId}`,
        rolledBack: false,
      };
    }
    await assertPrivateProjectAgentCompatibility(deps, op, resolved.targets, { uid: request.uid, slug: user.slug });
    await assertForwardRecoveryBeforePreparation(op, resolved.targets, user.slug, request.uid, ctx);
    const automatic = resolveOperationOrigin(op.origin) === "automatic";
    const nativeReturn = await deps.prepareNativeVmReturn({
      fromGatewayId: resolved.targets.fromGatewayId,
      toGatewayId: resolved.targets.toGatewayId,
      uid: request.uid,
      slug: user.slug,
      operationId: op.id,
      claimedStartedAt: op.startedAt,
    });
    const durable = await deps.useDurableMigration(
      user.currentGatewayId,
      request.toGatewayId,
      nativeReturn ? resolved.targets.fromRelease : undefined,
    );
    assertRetainedMigrationStrategy(op,durable,nativeReturn);
    if (nativeReturn) {
      return {
        result: await executeNativeReturn({
          deps,
          ctx,
          op,
          targets: resolved.targets,
          uid: request.uid,
          slug: user.slug,
          migrationId,
          automatic,
          durable,
          nativeReturn,
        }),
      };
    }
    if (durable) {
      const result = await executeOrdinaryMigrationV2({
        deps,
        op,
        ctx,
        targets: resolved.targets,
        uid: request.uid,
        slug: user.slug,
        migrationId,
      });
      return { result };
    }
    return await prepareLegacyMigration({ deps, op, ctx, user, request, migrationId, targets: resolved.targets });
  } catch (error) {
    return migrationPreparationFailure(error, op);
  }
}

async function prepareLegacyMigration(input: {
  deps: MigrateUserDeps;
  op: Operation;
  ctx: OperationContext;
  user: UserGatewayInfo;
  request: { uid: string; toGatewayId: string };
  migrationId: string;
  targets: MigrationTargets;
}): Promise<PreparedMigration | { error: string }> {
  const { deps, op, ctx, user, request, migrationId, targets } = input;
  if (!op.schedulerHandoff?.forwardRecovery && sourceOwnedUserActivation(targets)) {
    if (!deps.readOpenClawBuild) throw new Error("User activation requires its source OpenClaw build");
    const [sourceBuild, targetBuild] = await Promise.all([
      deps.readOpenClawBuild(targets.fromGatewayId, targets.fromRelease),
      deps.readOpenClawBuild(targets.toGatewayId, targets.toRelease!),
    ]);
    if (!sourceBuild || sourceBuild !== targetBuild) {
      throw new Error("User activation waits for the source and target to run the same OpenClaw build");
    }
  }
  const sourcePreparationFenced = await prepareSharedSourceAgentStores({ deps, op, ctx, targets, uid: request.uid, slug: user.slug });
  const clearFence = async (cause: unknown): Promise<void> => {
    if (sourcePreparationFenced) await clearFailedSourcePreparation({ deps, op, ctx, targets, uid: request.uid }, cause);
  };
  const urls = new Map<string, string>();
  let migrationSnapshot: Awaited<ReturnType<MigrateUserDeps["readUserSnapshot"]>>;
  try {
    urls.set(targets.fromGatewayId, await deps.resolveGatewayUrl(targets.fromGatewayId));
    urls.set(targets.toGatewayId, await deps.resolveGatewayUrl(targets.toGatewayId));
    migrationSnapshot = await deps.readUserSnapshot(request.uid, targets.toGatewayId);
  } catch (error) {
    await clearFence(error);
    throw error;
  }
  if (!migrationSnapshot) {
    const error = `durable snapshot not found for ${request.uid}`;
    await clearFence(error);
    return { error };
  }
  return {
    ...request,
    user,
    migrationId,
    targets,
    ...(migrationSnapshot.projectCheckoutScope
      ? { projectCheckoutScope: migrationSnapshot.projectCheckoutScope }
      : {}),
    urls,
    ...(sourcePreparationFenced ? { sourcePreparationFenced: true as const } : {}),
  };
}

function migrationPreparationFailure(error: unknown, op: Operation): { error: string; rolledBack?: false } | { result: OperationResult } {
  if (error instanceof GatewayCompatibilityPendingError) {
    return { result: { ...failure(error.message), output: { gatewayCompatibilityPending: true } } };
  }
  return { error: errorMessage(error), ...(op.schedulerHandoff?.forwardRecovery ? { rolledBack: false as const } : {}) };
}

async function executeOrdinaryMigrationV2(input: {
  deps: MigrateUserDeps;
  op: Operation;
  ctx: OperationContext;
  targets: MigrationTargets;
  uid: string;
  slug: string;
  migrationId: string;
}): Promise<OperationResult> {
  if (input.targets.toRelease === null) {
    return failure("user migration V2 target has no release");
  }
  try {
    return await runOrdinaryMigrationV2(input);
  } catch (error) {
    if (classifyUserMigrationV2Error(error) === "retry") {
      return failure(v2RetryError(error), false);
    }
    return failure(error instanceof Error ? error.message : String(error), false);
  }
}

function shouldClearMigrationPreparation(input: {
  preparationFailed: boolean; postQuiesceFailed: boolean; targetUnmountConfirmed: boolean;
  result: { finalPhase: string; rolledBack: boolean };
}): boolean {
  return input.preparationFailed && input.result.finalPhase === "initial" ||
    (input.preparationFailed || input.postQuiesceFailed) && input.result.rolledBack && input.targetUnmountConfirmed;
}

async function assertForwardRecoveryBeforePreparation(op: Operation, targets: MigrationTargets, slug: string, uid: string, ctx: OperationContext): Promise<void> {
  if (op.schedulerHandoff?.forwardRecovery === undefined) return;
  assertForwardRecovery(op, targets, slug, uid);
  if (!ctx.assertActiveClaim) throw new Error("forward recovery requires an active operation claim");
  await ctx.assertActiveClaim(true);
}

function assertForwardRecoveryScope(targets: MigrationTargets): void {
  if (!Number.isSafeInteger(targets.fromEpoch) || targets.fromEpoch < 0) {
    throw new Error("migration forward recovery placement fence is malformed");
  }
}

function assertForwardRecovery(op: Operation, targets: MigrationTargets, slug: string, uid: string): void {
  const handoff = op.schedulerHandoff!;
  const checkpoint = handoff.forwardRecovery!;
  assertForwardRecoveryScope(targets);
  const exact = [
    checkpoint.schemaVersion === 1, checkpoint.phase === "source-flushed",
    checkpoint.sourceEpoch === targets.fromEpoch, handoff.uid === uid, handoff.slug === slug,
    handoff.fromGatewayId === targets.fromGatewayId, handoff.toGatewayId === targets.toGatewayId,
    !declaredMigrationSourceChanged(op.input as MigrateUserInput, targets.fromGatewayId),
    op.input.toGatewayId === targets.toGatewayId,
    readSchedulerMigrationIdentity(op.id, handoff.migrationId) !== null,
    checkpoint.sourceSystemConfigCommit === undefined || /^[0-9a-f]{40,64}$/.test(checkpoint.sourceSystemConfigCommit),
  ].every(Boolean);
  if (!exact) {
    throw new Error("migration forward recovery scope changed; source remains fenced");
  }
}

function releasedTargetImportFailure(error: string | undefined, targetGatewayId: string, migrationId: string): boolean {
  if (error === `target import already released for migration ${migrationId} on ${targetGatewayId}`) return true;
  const prefix = `/prepare-rsync-import/${targetGatewayId}: 500 `;
  if (!error?.startsWith(prefix)) return false;
  try {
    const body = JSON.parse(error.slice(prefix.length));
    return body?.error === "prepare-rsync-import failed" &&
      body.message === "surge OpenClaw process gate target migration already released";
  } catch {
    return false;
  }
}

async function recordReleasedIsolatedTarget(input: {
  deps: MigrateUserDeps; ctx: OperationContext; op: Operation; handoff: SchedulerHandoffState;
}): Promise<boolean> {
  const { deps, ctx, op, handoff } = input;
  if (!handoff.forwardRecovery) return false;
  const released = { ...handoff, forwardRecovery: { ...handoff.forwardRecovery, targetReleased: true as const } };
  if (!releasedUserActivationSourceRecovery({ ...op, schedulerHandoff: released })) return false;
  if (!ctx.assertActiveClaim || !ctx.persistSchedulerHandoff) throw new Error("released isolated target requires claimed persistence");
  await ctx.assertActiveClaim(true);
  const owner = await deps.readUser(handoff.uid);
  const source = await deps.resolveSourcePlacement(handoff.uid, handoff.fromGatewayId);
  if (op.cutoverCommittedAt !== undefined || owner?.currentGatewayId !== handoff.fromGatewayId || owner.slug !== handoff.slug ||
      source?.assignmentMode !== "assigned" || source.epoch !== handoff.forwardRecovery.sourceEpoch) return false;
  await ctx.persistSchedulerHandoff(released);
  deps.log(`[migrate-customer] target released before cutover migrationId=${handoff.migrationId}; native source recovery required`);
  return true;
}

function sourceOwnedUserActivation(targets: MigrationTargets): boolean {
  return targets.fromGatewayClass === "shared" && targets.toGatewayClass === "isolated";
}

async function executeMigration(
  deps: MigrateUserDeps,
  ctx: OperationContext,
  prepared: PreparedMigration,
  op: Operation,
): Promise<OperationResult> {
  const reported = { steps: 0 };
  const clearUnstarted = async (cause: unknown): Promise<void> => {
    if (prepared.sourcePreparationFenced && reported.steps === 0) {
      await clearFailedSourcePreparation({ deps, op, ctx, targets: prepared.targets, uid: prepared.uid }, cause);
    }
  };
  let result: OperationResult;
  try {
    result = await executeMigrationAttempt(deps, ctx, prepared, op, reported);
  } catch (error) {
    await clearUnstarted(error);
    throw error;
  }
  if (!result.success && result.waitingForUserIdle !== true) await clearUnstarted(result.error);
  return result;
}

async function executeMigrationAttempt(
  deps: MigrateUserDeps,
  ctx: OperationContext,
  prepared: PreparedMigration,
  op: Operation,
  reported: { steps: number },
): Promise<OperationResult> {
  const operationId = op.id;
  const automatic = resolveOperationOrigin(op.origin) === "automatic";
  const client = schedulerRetirementClient(deps.buildClient((transportId) => {
    const url = prepared.urls.get(transportId);
    if (!url) {
      throw new Error(`migration client called with unexpected gatewayId: ${transportId}`);
    }
    return url;
  }), deps, { uid: prepared.uid, slug: prepared.user.slug, gatewayId: prepared.toGatewayId, operationId: op.id, claimedStartedAt: op.startedAt });
  const progress = migrateUserProgress({ deps, op, targets: prepared.targets, slug: prepared.user.slug, migrationId: prepared.migrationId });
  let targetUnmountConfirmed = false;
  let preparationFailed = false;
  let postQuiesceFailed = false;
  let targetReleased = false;
  const destinationContext: OperationContext = {
    ...ctx,
    reportStep: async (step) => {
      reported.steps += 1;
      await ctx.reportStep(step);
      if (step.name === "rollback:unmount-target" && step.status === "done") targetUnmountConfirmed = true;
      if (["keys-sync-state", "pre-sync-state", "wait-for-active-work"].includes(step.name) && step.status === "failed") preparationFailed = true;
      if (["final-sync-state", "verify-target"].includes(step.name) && step.status === "failed") postQuiesceFailed = true;
      if (step.name === "final-sync-state" && step.status === "failed") targetReleased = releasedTargetImportFailure(step.error, prepared.toGatewayId, prepared.migrationId);
      await progress.report(step.name, step.status, step.status === "running" ? step.startedAt : step.completedAt);
    },
  };
  const schedulerMigrationId = op.schedulerHandoff?.forwardRecovery !== undefined
    ? op.schedulerHandoff.migrationId : claimSchedulerMigrationId(prepared.migrationId, op);
  const persistSchedulerHandoff = ctx.persistSchedulerHandoff;
  if (!persistSchedulerHandoff) throw new Error("scheduler handoff persistence is required");
  const heldTarget = prepared.targets.toGatewayClass === "isolated";
  let handoff: SchedulerHandoffState = op.schedulerHandoff?.forwardRecovery !== undefined ? op.schedulerHandoff : {
    migrationId: schedulerMigrationId,
    fromGatewayId: prepared.user.currentGatewayId,
    toGatewayId: prepared.toGatewayId,
    uid: prepared.uid,
    slug: prepared.user.slug,
    ...(heldTarget ? { stageAfterCutover: true as const } : {}),
    scheduleTransfer: true,
  };
  await persistSchedulerHandoff(handoff);
  const restored: ScheduleRestoreOutcome[] = [];
  const result = await runMigration(
    {
      migrationId: prepared.migrationId,
      operationId,
      ...(handoff.forwardRecovery ? { resumeForwardRecovery: handoff.forwardRecovery } : {}),
      uid: prepared.uid,
      slug: prepared.user.slug,
      fromGatewayId: prepared.user.currentGatewayId,
      toGatewayId: prepared.toGatewayId,
      crossGateway: prepared.user.currentGatewayId !== prepared.toGatewayId,
      ...(heldTarget ? { convergeTargetSystemConfig: targetConvergence(prepared.targets.fromGatewayClass) } : {}),
      gateAssignment: true,
      projectCheckoutScope: prepared.projectCheckoutScope,
      includeActivationManifest: true,
      ...(sourceOwnedUserActivation(prepared.targets) && !handoff.forwardRecovery ? { preserveSource: true as const } : {}),
    },
    {
      ...buildRunnerDeps({ deps, client: withImportProgress(client, progress), ctx: destinationContext, automatic, operationId, uid: prepared.uid, sourceGatewayId: prepared.user.currentGatewayId }),
      ...legacySchedulerHandoffDeps(deps, op, ctx, handoff, restored),
      ...(!sourceOwnedUserActivation(prepared.targets) || handoff.forwardRecovery ? { persistForwardRecovery: async (state: { sourceSystemConfigCommit?: string }) => {
        if (!ctx.assertActiveClaim) throw new Error("forward recovery requires an active operation claim");
        await ctx.assertActiveClaim(handoff.forwardRecovery !== undefined);
        const owner = await deps.readUser(prepared.uid);
        const source = await deps.resolveSourcePlacement(prepared.uid, prepared.user.currentGatewayId);
        if (!owner || owner.currentGatewayId !== prepared.user.currentGatewayId || owner.slug !== prepared.user.slug ||
            !source || (source.epoch ?? 0) !== prepared.targets.fromEpoch) {
          throw new Error("migration forward recovery placement changed; source remains fenced");
        }
        assertForwardRecoveryScope(prepared.targets);
        handoff = { ...handoff, forwardRecovery: {
          schemaVersion: 1, phase: "source-flushed",
          sourceEpoch: prepared.targets.fromEpoch, ...state,
        } };
        await persistSchedulerHandoff(handoff);
      } } : {}),
    },
  );
  return finishMigrationAttempt({
    deps, ctx, op, handoff, prepared, result, targetReleased, preparationFailed, postQuiesceFailed, targetUnmountConfirmed, restored,
  });
}

async function finishMigrationAttempt(input: {
  deps: MigrateUserDeps; ctx: OperationContext; op: Operation; handoff: SchedulerHandoffState;
  prepared: PreparedMigration; result: MigrationRunnerResult; targetReleased: boolean;
  preparationFailed: boolean; postQuiesceFailed: boolean; targetUnmountConfirmed: boolean;
  restored: readonly ScheduleRestoreOutcome[];
}): Promise<OperationResult> {
  const { deps, ctx, op, handoff, prepared, result, targetReleased, preparationFailed, postQuiesceFailed, targetUnmountConfirmed } = input;
  if (!result.success && targetReleased && await recordReleasedIsolatedTarget({ deps, ctx, op, handoff })) {
    return failure(RELEASED_ISOLATED_TARGET_ERROR, false);
  }
  if (sourceOwnedUserActivation(prepared.targets) && postQuiesceFailed && result.rolledBack && targetUnmountConfirmed) {
    if (!deps.completeMigrationRecovery) throw new Error("migration rollback completion requires claimed recovery authority");
    await deps.completeMigrationRecovery({
      uid: prepared.uid, sourceGatewayId: prepared.user.currentGatewayId,
      operationId: op.id, sourceEpoch: prepared.targets.fromEpoch, claimStartedAt: requiredClaimStartedAt(op),
    });
  } else if (shouldClearMigrationPreparation({ preparationFailed, postQuiesceFailed, targetUnmountConfirmed, result })) {
    await deps.clearMigrationPreparation?.({
      uid: prepared.uid,
      sourceGatewayId: prepared.user.currentGatewayId,
      operationId: op.id,
      sourceAssignmentMode: prepared.targets.sourceAssignmentMode,
      sourceRelease: prepared.targets.fromRelease,
      sourceEpoch: prepared.targets.fromEpoch,
      ...(prepared.targets.sourceRootUpdatedAt !== undefined
        ? { sourceRootUpdatedAt: prepared.targets.sourceRootUpdatedAt } : {}),
    });
  }
  if (result.success) return scheduleRestoreResult(deps, op, handoff, input.restored);
  return {
    steps: [],
    success: false,
    error: result.errorAt?.error,
    ...(result.waitingForUserIdle ? { waitingForUserIdle: true } : {}),
    rolledBack: result.rolledBack,
  };
}

async function runMigrateUser(
  deps: MigrateUserDeps,
  op: Operation,
  ctx: OperationContext,
): Promise<OperationResult> {
  const assertClaim = ctx.assertActiveClaim;
  if (op.schedulerHandoff?.forwardRecovery !== undefined && assertClaim) {
    ctx = { ...ctx, assertActiveClaim: () => assertClaim(true) };
  }
  const input = op.input as MigrateUserInput;
  const request = migrationRequest(input);
  if ("error" in request) return failure(request.error);
  const terminal = terminalDurableMigrationResult(deps, op, input, request);
  if (terminal) return terminal;
  const resumed = resumeDurableMigration(deps, op, ctx);
  if (resumed) return resumed;
  const prepared = await prepareMigration(deps, op, ctx, input, request);
  if ("error" in prepared) return failure(prepared.error, prepared.rolledBack);
  if ("result" in prepared) {
    return prepared.result;
  }
  return executeMigration(deps, ctx, prepared, op);
}

function migrationVms(op: Operation): Array<["source" | "target", string]> {
  const input = op.input as MigrateUserInput;
  const sourceGatewayId = typeof input.fromGatewayId === "string"
    ? input.fromGatewayId
    : op.userMigrationV2?.sourceGatewayId;
  return [
    ...(typeof input.toGatewayId === "string" ? [["target", input.toGatewayId] as ["target", string]] : []),
    ...(sourceGatewayId ? [["source", sourceGatewayId] as ["source", string]] : []),
  ];
}

async function preemptedVm(
  deps: MigrateUserDeps,
  op: Operation,
): Promise<{ role: "source" | "target"; instanceName: string } | null> {
  const since = op.firstStartedAt ?? op.startedAt;
  if (typeof since !== "number") return null;
  for (const [role, gatewayId] of migrationVms(op)) {
    try {
      const instanceName = await deps.findPreemptedVm(gatewayId, since);
      if (instanceName) return { role, instanceName };
    } catch (error) {
      deps.log(`[migrate-customer] ⚠ could not check whether ${gatewayId}'s VM was preempted: ${errorMessage(error)}`);
    }
  }
  return null;
}

async function attributePreemption(
  deps: MigrateUserDeps,
  op: Operation,
  result: OperationResult,
): Promise<OperationResult> {
  if (result.success) return result;
  const preempted = await preemptedVm(deps, op);
  if (!preempted) return result;
  return {
    ...result,
    error: vmPreemptionError(preempted.role, preempted.instanceName, result.error ?? "migration failed"),
  };
}

export function createMigrateUserHandler(deps: MigrateUserDeps): OperationHandler {
  return async (op: Operation, ctx: OperationContext): Promise<OperationResult> => {
    if (op.input.sourceTransferMode !== undefined && op.input.sourceTransferMode !== RETAINED_POD) throw new Error('unsupported source transfer mode');
    if (op.input.sourceTransferMode === RETAINED_POD && (!deps.observeSourceTransfer || (typeof op.input.fromGatewayId !== 'string' || !op.input.fromGatewayId.startsWith('shared-')))) throw new Error('retained source transfer requires a Shared source');
    if (op.input.recoverSourceOnly === true && op.input.nativeReturnSourceRecovery !== undefined) {
      if (!deps.recoverNativeReturnSource) throw new Error("native return source recovery owner is unavailable");
      return deps.recoverNativeReturnSource(op, ctx);
    }
    const scoped: MigrateUserDeps = { ...deps, log: operationScopedLog(deps.log) };
    return withLogContext({
      operationId: op.id, migrationId: deps.genMigrationId(op.id), attempt: (op.attempts ?? 0) + 1,
      ...(typeof op.input.fromGatewayId === "string" ? { sourceGateway: op.input.fromGatewayId } : {}),
      ...(typeof op.input.toGatewayId === "string" ? { targetGateway: op.input.toGatewayId, gatewayId: op.input.toGatewayId } : {}),
    }, () => withOperationLogScope(op.id, async () =>
      attributePreemption(scoped, op, await runMigrateUser(scoped, op, ctx)),
    ));
  };
}
