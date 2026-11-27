import { withLogContext } from "@octogee/shared/server/service-logger";


import {
  advancePhase,
  nextMigrationStep,
  rollbackPlan,
  type MigrationPhase,
  type MigrationState,
  type MigrationStep,
} from "./fleet-migration.js";
import { MigrationDrainPendingError, MigrationRpcError, type MigrationClient } from "./fleet-migration-client.js";
import type { FleetBrokerProjectCheckoutScope } from "@octogee/shared/types/fleet-broker";
import type { ScheduleRecord, ScheduleRestoreFailureRecord, ScheduleRestoreResult, ScheduleTransferDoc } from "@octogee/shared/types/fleet-controller";
import type { WorkspaceMigrationPhase } from "@octogee/shared/types/workspace-migration";

export interface ReportedStep {
  name: string;
  status: "running" | "done" | "failed" | "skipped";
  error?: string;
}

// The single cutover commit the runner drives. The implementation MUST write the
// mirror move (flipMirror) AND the assignment as ONE atomic Firestore operation —
// a crash leaves NEITHER, so there is never a half-state the rollback would have
// to reverse (GATEWAY-RELEASES-SPEC, PR5 review P0).
export interface CutoverCommit {
  uid: string;
  slug: string;
  toGatewayId: string;
  fromGatewayId: string;
  flipMirror: boolean;
}

export type ScheduleRestoreRecord = Pick<ScheduleTransferDoc, "restoredTo" | "restoredAt"> &
  Required<Pick<ScheduleTransferDoc, "restoreAttemptedTo" | "restoreAttemptedAt" | "restoreFailures">>;

export interface MigrationRunnerDeps {
  client: MigrationClient;

  commitCutover: (commit: CutoverCommit) => Promise<void>;
  readCurrentGateway?: () => Promise<string | null>;
  prepareRollbackTarget?: (gatewayId: string, slug: string) => Promise<void>;
  prepareRollbackSource?: (gatewayId: string, slug: string) => Promise<void>;

  // Roster-state gate: written to "quiescing" on the SOURCE assignment before
  // the quiesce RPC — blocking the source edge from serving this user
  // BEFORE the target ever does — and restored to "serving" when a pre-cutover
  // failure rolls the migration back.
  setAssignmentState?: (input: {
    gatewayId: string;
    uid: string;
    state: "serving" | "quiescing" | "migrating";
  }) => Promise<void>;

  readScheduleTransfer: (migrationId: string) => Promise<ScheduleTransferDoc | null>;
  saveScheduleTransfer: (doc: ScheduleTransferDoc) => Promise<void>;
  recordScheduleRestore: (migrationId: string, restore: ScheduleRestoreRecord) => Promise<void>;
  finishLegacySchedulerHandoff?: () => Promise<void>;

  log: (msg: string) => void;

  reportStep?: (step: ReportedStep) => Promise<void> | void;

  setMigrationPhase?: (phase: WorkspaceMigrationPhase) => Promise<void>;

  readTargetSystemConfigCommit?: (gatewayId: string) => Promise<string | null>;

  persistForwardRecovery?: (state: { sourceSystemConfigCommit?: string }) => Promise<void>;

  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}

const QUIESCE_SOURCE = "quiesce-source";
const SYNC_STATE = "sync-state";
const WAIT_FOR_ACTIVE_WORK = "wait-for-active-work";
const RELEASE_ATTEMPTS = 3;
const RELEASE_RETRY_DELAY_MS = 2_000;
const RELEASED_TARGET_SCHEDULER_READY_TIMEOUT_MS = 300_000;
const TARGET_SCHEDULER_READY_POLL_MS = 5_000;
const TARGET_SCHEDULER_NOT_READY = /workspace identities are not initialized for this boot/;

export function isTargetSchedulerNotReady(error: unknown): boolean {
  return TARGET_SCHEDULER_NOT_READY.test(error instanceof Error ? error.message : String(error));
}

const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);

export function isPermanentSchedulerRefusal(error: unknown): boolean {
  if (!(error instanceof MigrationRpcError)) return false;
  if (error.retryable !== undefined) return !error.retryable;
  const status = error.status ?? 0;
  return status >= 400 && status < 500 && !RETRYABLE_CLIENT_STATUSES.has(status);
}

type StepTimings = Readonly<Record<string, number>>;

export interface MigrationRunnerInput {
  resumeForwardRecovery?: { sourceSystemConfigCommit?: string };
  operationId?: string;
  migrationId: string;
  uid: string;
  slug: string;
  fromGatewayId: string;
  toGatewayId: string;
  crossGateway?: boolean;
  // Present when the user has a roster assignment to gate (the quiescing
  // mark before quiesce, restored on rollback). Absent = legacy migration with
  // no assignment layer.
  gateAssignment?: boolean;
  projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
  includeActivationManifest?: boolean;
  preserveSource?: true;
  verifyPreparedTarget?: true;
  convergeTargetSystemConfig?: TargetSystemConfigConvergence;
}

export type TargetSystemConfigConvergence = "source-commit" | "target-commit";

export interface MigrationRunnerResult {
  waitingForUserIdle?: boolean;
  success: boolean;
  finalPhase: MigrationPhase;
  errorAt?: { phase: MigrationPhase; error: string };
  rolledBack: boolean;
}

interface ScheduleTransferState {
  doc?: ScheduleTransferDoc;
}

interface ScheduleTransferScope {
  migrationId: string;
  slug: string;
}

type ScheduleRestoreDeps = Pick<MigrationRunnerDeps, "client" | "log" | "now" | "readScheduleTransfer" | "recordScheduleRestore">;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function snapshotSchedules(
  deps: MigrationRunnerDeps,
  scope: ScheduleTransferScope & { sourceGatewayId: string; targetGatewayId: string },
  state: ScheduleTransferState,
): Promise<void> {
  const { migrationId, slug, sourceGatewayId } = scope;
  let pending: ScheduleTransferDoc | null;
  let doc: ScheduleTransferDoc;
  try {
    pending = await deps.readScheduleTransfer(migrationId);
    doc = pending && pending.restoredTo === undefined ? pending : await takeScheduleSnapshot(deps, scope);
  } catch (error) {
    throw new Error(`Schedule snapshot failed on ${sourceGatewayId}; source retained: ${errorText(error)}`, { cause: error });
  }
  // Snapshot fences can already have disabled source jobs. Keep their original
  // enabled state available to rollback even if durable publication fails.
  state.doc = doc;
  if (doc === pending) {
    deps.log(`[migration-runner] carrying ${doc.records.length} schedule(s) an earlier attempt snapshotted migrationId=${migrationId} slug=${slug}`);
  } else {
    try {
      await deps.saveScheduleTransfer(doc);
    } catch (error) {
      throw new Error(`Could not persist schedules for ${slug}; source retained: ${errorText(error)}`, { cause: error });
    }
  }
  await removeSnapshottedSchedules(deps, { migrationId, slug, sourceGatewayId }, doc.records);
}

async function takeScheduleSnapshot(
  deps: MigrationRunnerDeps,
  scope: ScheduleTransferScope & { sourceGatewayId: string; targetGatewayId: string },
): Promise<ScheduleTransferDoc> {
  const { migrationId, slug, sourceGatewayId } = scope;
  const snapshot = await deps.client.schedules({ migrationId, slug, gatewayId: sourceGatewayId, op: "snapshot" });
  const skipped = snapshot.skipped.map((skip) => ` ${skip.name} (${skip.reason})`).join(",");
  deps.log(
    `[migration-runner] schedules snapshotted on ${sourceGatewayId} migrationId=${migrationId} slug=${slug}: ` +
    `${snapshot.records.length} captured, ${snapshot.skipped.length} skipped${skipped}`,
  );
  return {
    migrationId, slug, sourceGatewayId, targetGatewayId: scope.targetGatewayId,
    records: snapshot.records, skipped: snapshot.skipped, snapshotAt: (deps.now ?? Date.now)(),
  };
}

async function removeSnapshottedSchedules(
  deps: MigrationRunnerDeps,
  scope: ScheduleTransferScope & { sourceGatewayId: string },
  records: readonly ScheduleRecord[],
): Promise<void> {
  const { migrationId, slug, sourceGatewayId } = scope;
  if (records.length === 0) return;
  try {
    const result = await deps.client.schedules({ migrationId, slug, gatewayId: sourceGatewayId, op: "remove", jobIds: records.map((record) => record.sourceJobId) });
    if (result.failed.length > 0) {
      deps.log(
        `[migration-runner] ⚠ source ${sourceGatewayId} kept ${result.failed.length} of ${records.length} snapshotted schedule(s) ` +
        `migrationId=${migrationId} slug=${slug}; they stay disabled there until the source is unmounted`,
      );
    }
  } catch (error) {
    deps.log(`[migration-runner] ⚠ could not remove ${records.length} snapshotted schedule(s) from ${sourceGatewayId} migrationId=${migrationId} slug=${slug}: ${errorText(error)}; they stay disabled there`);
  }
}

export interface ScheduleRestoreFailure {
  name: string;
  agentId: string | null;
  sourceJobId: string | null;
  error: string;
  transient: boolean;
}

function scheduleName(record: ScheduleRecord): string {
  return typeof record.job.name === "string" ? record.job.name : record.sourceJobId;
}

function attributeRestoreFailures(records: readonly ScheduleRecord[], failed: ScheduleRestoreResult["failed"]): ScheduleRestoreFailure[] {
  return failed.map(({ name, agentId, sourceJobId, error, retryable }) => {
    const record = records.find((candidate) => candidate.agentId === agentId && candidate.sourceJobId === sourceJobId);
    return { name, agentId: record?.agentId ?? null, sourceJobId: record?.sourceJobId ?? null, error, transient: retryable };
  });
}

function storedRestoreFailure({ name, agentId, sourceJobId, error }: ScheduleRestoreFailure): ScheduleRestoreFailureRecord {
  return { name, ...(agentId === null ? {} : { agentId }), ...(sourceJobId === null ? {} : { sourceJobId }), error };
}

function logRestoreFailures(deps: Pick<ScheduleRestoreDeps, "log">, input: ScheduleTransferScope & { gatewayId: string }, failures: readonly ScheduleRestoreFailure[]): void {
  for (const failure of failures) {
    deps.log(
      `[migration-runner] ⚠ schedule "${failure.name}" of ${failure.agentId ?? "an unknown agent"} was not restored on ${input.gatewayId} ` +
      `migrationId=${input.migrationId} slug=${input.slug}: ${failure.error}`,
    );
  }
}

export function scheduleRestoreRecord(
  gatewayId: string,
  at: number,
  failures: readonly ScheduleRestoreFailureRecord[],
  custodyReleased: boolean,
): ScheduleRestoreRecord {
  return {
    restoreAttemptedTo: gatewayId,
    restoreAttemptedAt: at,
    restoreFailures: [...failures],
    ...(failures.length === 0 && custodyReleased ? { restoredTo: gatewayId, restoredAt: at } : {}),
  };
}

export function awaitsOnlyCustodyRelease(doc: ScheduleTransferDoc): boolean {
  return doc.restoredTo === undefined && doc.restoreAttemptedTo !== undefined && (doc.restoreFailures ?? []).length === 0;
}

export async function restoreScheduleTransfer(
  deps: ScheduleRestoreDeps,
  input: ScheduleTransferScope & { gatewayId: string; doc?: ScheduleTransferDoc; custodyReleased?: boolean },
): Promise<ScheduleRestoreFailure[]> {
  const { migrationId, slug, gatewayId } = input;
  const doc = input.doc ?? await deps.readScheduleTransfer(migrationId);
  if (!doc) {
    deps.log(`[migration-runner] ⚠ no schedule transfer record migrationId=${migrationId} slug=${slug} to restore on ${gatewayId}`);
    return [];
  }
  if (doc.restoredTo !== undefined) return [];
  const custodyReleased = input.custodyReleased !== false;
  const now = deps.now ?? Date.now;
  const record = async (restore: ScheduleRestoreRecord) => {
    try {
      await deps.recordScheduleRestore(migrationId, restore);
    } catch (error) {
      deps.log(`[migration-runner] ⚠ could not record the schedule restore on ${gatewayId} migrationId=${migrationId} slug=${slug}: ${errorText(error)}`);
    }
  };
  const held = () => deps.log(
    `[migration-runner] schedule transfer migrationId=${migrationId} slug=${slug} stays unrestored until the scheduler custody on ${gatewayId} is released`);
  if (awaitsOnlyCustodyRelease(doc)) {
    if (custodyReleased) await record(scheduleRestoreRecord(gatewayId, now(), [], true));
    else held();
    return [];
  }
  let failures: ScheduleRestoreFailure[];
  try {
    const result = await deps.client.schedules({ migrationId, slug, gatewayId, op: "restore", records: doc.records });
    deps.log(
      `[migration-runner] schedules restored on ${gatewayId} migrationId=${migrationId} slug=${slug}: ` +
      `${result.created} created, ${result.existing} existing, ${result.failed.length} failed`,
    );
    failures = attributeRestoreFailures(doc.records, result.failed);
  } catch (error) {
    deps.log(`[migration-runner] ⚠ schedule restore on ${gatewayId} failed migrationId=${migrationId} slug=${slug}: ${errorText(error)}`);
    const cause = { error: errorText(error), transient: !isPermanentSchedulerRefusal(error) };
    failures = doc.records.length > 0
      ? doc.records.map((record) => ({ name: scheduleName(record), agentId: record.agentId, sourceJobId: record.sourceJobId, ...cause }))
      : [{ name: `schedule transfer ${migrationId}`, agentId: null, sourceJobId: null, ...cause }];
  }
  logRestoreFailures(deps, input, failures);
  if (failures.length === 0 && !custodyReleased) held();
  await record(scheduleRestoreRecord(gatewayId, now(), failures.map(storedRestoreFailure), custodyReleased));
  return failures;
}

interface SystemConfigConvergence {
  convergeTarget?: TargetSystemConfigConvergence;
  sourceCommit?: string;
}

async function convergeTargetSystemConfig(input: {
  deps: MigrationRunnerDeps;
  migrationId: string;
  slug: string;
  targetGatewayId: string;
  systemConfig: SystemConfigConvergence;
}): Promise<void> {
  const { deps } = input;
  const expectedSystemConfigCommit = input.systemConfig.convergeTarget === "source-commit"
    ? input.systemConfig.sourceCommit
    : await deps.readTargetSystemConfigCommit?.(input.targetGatewayId);
  if (!expectedSystemConfigCommit) {
    const holder = input.systemConfig.convergeTarget === "source-commit" ? "source" : `target ${input.targetGatewayId}`;
    throw new Error(`${holder} has no accepted system config commit to converge ${input.slug} on`);
  }
  const converge = await deps.client.flushGateway({
    migrationId: input.migrationId,
    gatewayId: input.targetGatewayId,
    slug: input.slug,
    reason: "migration-converge",
    expectedSystemConfigCommit,
  });
  if (!converge.ok) {
    throw new Error(`target ${input.targetGatewayId} did not converge system config for ${input.slug}`);
  }
}

async function convergeTargetAfterFinalCopy(input: {
  deps: MigrationRunnerDeps;
  migrationId: string;
  step: Extract<MigrationStep, { action: typeof SYNC_STATE }>;
  systemConfig: SystemConfigConvergence;
}): Promise<void> {
  if (input.step.mode !== "final" || !input.systemConfig.convergeTarget) return;
  await input.deps.setMigrationPhase?.("activating");
  await convergeTargetSystemConfig({
    deps: input.deps,
    migrationId: input.migrationId,
    slug: input.step.slug,
    targetGatewayId: input.step.to,
    systemConfig: input.systemConfig,
  });
}

interface MigrationStepExecution {
  step: MigrationStep;
  deps: MigrationRunnerDeps;
  migrationId: string;
  slug: string;
  projectCheckoutScope: FleetBrokerProjectCheckoutScope | undefined;
  includeActivationManifest: boolean | undefined;
  preserveSource?: true;
  verifyPreparedTarget?: true;
  crossGateway: boolean;
  targetGatewayId: string;
  schedules: ScheduleTransferState;
  systemConfig: SystemConfigConvergence;
}

async function transferMigrationState(params: MigrationStepExecution, step: Extract<MigrationStep, { action: typeof SYNC_STATE }>): Promise<StepTimings> {
  const { deps, migrationId, projectCheckoutScope, includeActivationManifest } = params;
  const clock = deps.now ?? Date.now;
  const importStartedAt = clock();
  await deps.client.transferState({
    migrationId,
    fromGatewayId: step.from,
    toGatewayId: step.to,
    slug: step.slug,
    mode: step.mode,
    includeActivationManifest: step.mode !== "keys" && includeActivationManifest,
    projectCheckoutScope,
    ...(step.mode !== "keys" && params.preserveSource ? { preserveSource: true as const } : {}),
  });
  const transferAndImportMs = clock() - importStartedAt;
  if (!params.preserveSource) await convergeTargetAfterFinalCopy({ deps, migrationId, step, systemConfig: params.systemConfig });
  return { transferAndImportMs };
}

async function executeStep(params: MigrationStepExecution): Promise<StepTimings | undefined> {
  const {
    step,
    deps,
    migrationId,
    slug,
    crossGateway,
  } = params;
  switch (step.action) {
    case QUIESCE_SOURCE:
      await deps.client.quiesce({ migrationId, gatewayId: step.gateway, slug: step.slug });
      if (crossGateway) {
        await snapshotSchedules(deps, {
          migrationId, slug: step.slug, sourceGatewayId: step.gateway, targetGatewayId: params.targetGatewayId,
        }, params.schedules);
      }
      return;
    case "flush-source": {
      const flush = await deps.client.flushGateway({
        migrationId,
        gatewayId: step.gateway,
        slug: step.slug,
        reason: "migration-final",
      });
      params.systemConfig.sourceCommit = flush.systemConfigCommit;
      return;
    }
    case SYNC_STATE:
      return transferMigrationState(params, step);
    case "verify-target":
      await deps.client.verifyTarget({
        migrationId,
        gatewayId: step.gateway,
        slug: step.slug,
      });
      return;
    case "cutover-firestore":
      // ONE atomic commit — the mirror move (when the bare gateway changed)
      // before unmount-source. If it throws, nothing lands, so the rollback
      // from target-verified has no half-state to reverse.
      await deps.commitCutover({
        uid: step.uid,
        slug,
        toGatewayId: step.to,
        fromGatewayId: step.from,
        flipMirror: crossGateway,
      });
      if (params.preserveSource) {
        const clock = deps.now ?? Date.now;
        const activationStartedAt = clock();
        await deps.client.resume({ migrationId, gatewayId: params.targetGatewayId, slug, role: "target" });
        await convergeTargetSystemConfig({ deps, migrationId, slug, targetGatewayId: params.targetGatewayId, systemConfig: params.systemConfig });
        if (params.verifyPreparedTarget) await deps.client.verifyTarget({ migrationId, gatewayId: params.targetGatewayId, slug });
        return { targetActivationMs: clock() - activationStartedAt };
      }
      return;
    case "unmount-gateway":
      await deps.client.unmount({
        migrationId,
        gatewayId: step.gateway,
        slug: step.slug,
      });
      return;
    case "complete":
      return;
  }
}

class TargetSchedulerNotReadyError extends Error {
  readonly retryable = true;
}

type SchedulerRequest = Parameters<MigrationClient["scheduler"]>[0];

export async function callReleasedTargetScheduler(
  deps: Pick<MigrationRunnerDeps, "client" | "log" | "now" | "wait">,
  request: SchedulerRequest,
): Promise<void> {
  const clock = deps.now ?? Date.now;
  const wait = deps.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const deadline = clock() + RELEASED_TARGET_SCHEDULER_READY_TIMEOUT_MS;
  while (true) {
    try {
      await deps.client.scheduler(request);
      return;
    } catch (error) {
      if (!isTargetSchedulerNotReady(error)) throw error;
      const message = errorText(error);
      if (clock() >= deadline) {
        throw new TargetSchedulerNotReadyError(
          `target gateway ${request.gatewayId} scheduler did not become ready within ${RELEASED_TARGET_SCHEDULER_READY_TIMEOUT_MS}ms: ${message}`,
        );
      }
      deps.log(`[migration-runner] ⏳ target gateway ${request.gatewayId} scheduler not ready for ${request.phase}; retrying: ${message}`);
      await wait(TARGET_SCHEDULER_READY_POLL_MS);
    }
  }
}

function reportName(step: MigrationStep): string {
  if (step.action === SYNC_STATE) return `${step.mode}-sync-state`;
  if (step.action === "unmount-gateway") return `unmount-${step.role}`;
  return step.action;
}

function isPostCutoverSourceCleanup(
  state: MigrationState,
  step: MigrationStep,
): boolean {
  return (
    state.phase === "cutover-done" &&
    step.action === "unmount-gateway" &&
    step.role === "source"
  );
}

export async function runMigration(
  input: MigrationRunnerInput,
  deps: MigrationRunnerDeps,
): Promise<MigrationRunnerResult> {
  return withLogContext({
    builderSlug: input.slug, ...(input.operationId ? { operationId: input.operationId } : {}),
    migrationId: input.migrationId, category: "migration", gatewayId: input.toGatewayId,
    sourceGateway: input.fromGatewayId, targetGateway: input.toGatewayId,
  }, async () => {
    const execution = createMigrationExecution(input, deps);
    const keysPending = await resyncForwardRecoveryKeys(execution);
    if (keysPending) return keysPending;
    while (true) {
      const result = await runNextMigrationStep(execution);
      if (result) return result;
    }
  });
}

interface MigrationExecution {
  input: MigrationRunnerInput;
  deps: MigrationRunnerDeps;
  crossGateway: boolean;
  quiescingMarked: boolean;
  quiesceStarted: boolean;
  preDrainStarted: boolean;
  schedules: ScheduleTransferState;
  systemConfig: SystemConfigConvergence;
  state: MigrationState;
  forwardOnly: boolean;
}

function createMigrationExecution(
  input: MigrationRunnerInput,
  deps: MigrationRunnerDeps,
): MigrationExecution {
  return {
    input,
    deps,
    crossGateway: input.crossGateway ?? input.fromGatewayId !== input.toGatewayId,
    forwardOnly: input.resumeForwardRecovery !== undefined,
    quiescingMarked: input.resumeForwardRecovery !== undefined,
    quiesceStarted: input.resumeForwardRecovery !== undefined,
    preDrainStarted: false,
    schedules: {},
    systemConfig: { convergeTarget: input.convergeTargetSystemConfig, sourceCommit: input.resumeForwardRecovery?.sourceSystemConfigCommit },
    state: {
      phase: input.resumeForwardRecovery ? "source-flushed" : "initial",
      slug: input.slug,
      uid: input.uid,
      fromGatewayId: input.fromGatewayId,
      toGatewayId: input.toGatewayId,
    },
  };
}

async function resyncForwardRecoveryKeys(execution: MigrationExecution): Promise<MigrationRunnerResult | null> {
  const { input, deps } = execution;
  if (input.resumeForwardRecovery === undefined) return null;
  const step: MigrationStep = { action: SYNC_STATE, mode: "keys", from: input.fromGatewayId, to: input.toGatewayId, slug: input.slug };
  const name = reportName(step);
  const phaseAtStart = execution.state.phase;
  await report(deps, { name, status: "running" });
  try {
    await executeForwardStep(execution, step);
    await report(deps, { name, status: "done" });
    return null;
  } catch (error) {
    return handleStepFailure(execution, { step, name, phaseAtStart, error });
  }
}

async function markSourceQuiescing(
  execution: MigrationExecution,
  step: MigrationStep,
): Promise<void> {
  if (step.action !== QUIESCE_SOURCE || execution.input.gateAssignment !== true) return;
  const { input, deps } = execution;
  if (!deps.setAssignmentState) {
    throw new Error("assignment-gated migration requires deps.setAssignmentState");
  }
  await deps.setMigrationPhase?.("transferring");
  await deps.setAssignmentState({
    gatewayId: input.fromGatewayId,
    uid: input.uid,
    state: "quiescing",
  });
  execution.quiescingMarked = true;
}

function executeForwardStep(execution: MigrationExecution, step: MigrationStep): Promise<StepTimings | undefined> {
  const { input, deps } = execution;
  return executeStep({
    step,
    deps,
    migrationId: input.migrationId,
    slug: input.slug,
    projectCheckoutScope: input.projectCheckoutScope,
    includeActivationManifest: input.includeActivationManifest,
    preserveSource: input.preserveSource,
    verifyPreparedTarget: input.verifyPreparedTarget,
    crossGateway: execution.crossGateway,
    targetGatewayId: input.toGatewayId,
    schedules: execution.schedules,
    systemConfig: execution.systemConfig,
  });
}

function migrationComplete(execution: MigrationExecution): MigrationRunnerResult {
  const { input, deps } = execution;
  deps.log(
    `[migration-runner] ✅ migration complete migrationId=${input.migrationId} slug=${input.slug} ${input.fromGatewayId} → ${input.toGatewayId}`,
  );
  return {
    success: true,
    finalPhase: "done",
    rolledBack: false,
  };
}

async function finishPostCutoverScheduleHandoff(
  execution: MigrationExecution,
  step: MigrationStep,
): Promise<MigrationRunnerResult | null> {
  if (!isPostCutoverSourceCleanup(execution.state, step) || !execution.crossGateway) return null;
  const { deps, input, state } = execution;
  try {
    if (deps.finishLegacySchedulerHandoff) await deps.finishLegacySchedulerHandoff();
    else await restoreScheduleTransfer(deps, { migrationId: input.migrationId, slug: input.slug, gatewayId: input.toGatewayId, doc: execution.schedules.doc });
    return null;
  } catch (error) {
    const message = `migration cutover committed; destination recovery pending: status 503: ${errorText(error)}`;
    await report(deps, { name: reportName(step), status: "failed", error: message });
    deps.log(`[migration-runner] ${message} migrationId=${input.migrationId} slug=${input.slug}`);
    return { success: false, finalPhase: state.phase, rolledBack: false, errorAt: { phase: state.phase, error: message } };
  }
}

async function runNextMigrationStep(
  execution: MigrationExecution,
): Promise<MigrationRunnerResult | null> {
  const step = nextMigrationStep(execution.state);
  if (step.action === "complete") return migrationComplete(execution);
  if (step.action === "verify-target" && execution.input.preserveSource && !execution.input.verifyPreparedTarget) {
    await report(execution.deps, { name: "verify-target", status: "skipped" });
    execution.state = { ...execution.state, phase: advancePhase(execution.state.phase) };
    return null;
  }
  const phaseAtStart = execution.state.phase;
  const name = reportName(step);
  if (step.action === QUIESCE_SOURCE) {
    const deferred = await awaitActiveWorkDrained(execution, step, phaseAtStart);
    if (deferred) return deferred;
  }
  await report(execution.deps, { name, status: "running" });
  const handoffPending = await finishPostCutoverScheduleHandoff(execution, step);
  if (handoffPending) return handoffPending;
  try {
    if (step.action === SYNC_STATE && step.mode === "keys") await execution.deps.setMigrationPhase?.("preparing");
    if (step.action === "verify-target") await execution.deps.setMigrationPhase?.("connecting");
    await markSourceQuiescing(execution, step);
    if (step.action === QUIESCE_SOURCE) execution.quiesceStarted = true;
    await persistFinalTransferFence(execution, step);
    const timings = await executeForwardStep(execution, step);
    await report(execution.deps, { name, status: "done" });
    advanceExecution(execution, name, phaseAtStart, timings);
    return null;
  } catch (error) {
    return handleStepFailure(execution, { step, name, phaseAtStart, error });
  }
}

async function persistFinalTransferFence(execution: MigrationExecution, step: MigrationStep): Promise<void> {
  if (step.action !== SYNC_STATE || step.mode !== "final" || !execution.deps.persistForwardRecovery) return;
  execution.forwardOnly = true;
  await execution.deps.persistForwardRecovery({
    ...(execution.systemConfig.sourceCommit ? { sourceSystemConfigCommit: execution.systemConfig.sourceCommit } : {}),
  });
}

async function awaitActiveWorkDrained(
  execution: MigrationExecution,
  step: Extract<MigrationStep, { action: "quiesce-source" }>,
  phaseAtStart: MigrationPhase,
): Promise<MigrationRunnerResult | null> {
  await report(execution.deps, { name: WAIT_FOR_ACTIVE_WORK, status: "running" });
  try {
    await execution.deps.setMigrationPhase?.("waiting");
    execution.preDrainStarted = true;
    await execution.deps.client.quiesce({ migrationId: execution.input.migrationId, gatewayId: step.gateway, slug: step.slug, timeoutMs: 30_000, stopMattermost: false });
  } catch (error) {
    return handleStepFailure(execution, { step, name: WAIT_FOR_ACTIVE_WORK, phaseAtStart, error });
  }
  await report(execution.deps, { name: WAIT_FOR_ACTIVE_WORK, status: "done" });
  return null;
}

function formatTimings(timings: StepTimings | undefined): string {
  if (!timings) return "";
  return Object.entries(timings).map(([key, value]) => ` ${key}=${value}`).join("");
}

function advanceExecution(
  execution: MigrationExecution,
  name: string,
  phaseAtStart: MigrationPhase,
  timings: StepTimings | undefined,
): void {
  const nextPhase = advancePhase(execution.state.phase);
  withLogContext({ phase: name, status: "done", ...timings }, () => execution.deps.log(
    `[migration-runner] ${name} ok migrationId=${execution.input.migrationId} slug=${execution.input.slug} (phase ${phaseAtStart} → ${nextPhase})${formatTimings(timings)}`,
  ));
  execution.state = { ...execution.state, phase: nextPhase };
}

interface StepFailureInput {
  step: MigrationStep;
  name: string;
  phaseAtStart: MigrationPhase;
  error: unknown;
}

async function readRecoveryOwner(execution: MigrationExecution, phase: MigrationPhase): Promise<
  { owner: string | null | undefined } | { pending: MigrationRunnerResult }
> {
  try {
    return { owner: await execution.deps.readCurrentGateway?.() };
  } catch (error) {
    const message = `migration ownership lookup pending: status 503: ${errorText(error)}`;
    execution.deps.log(`[migration-runner] ${message}`);
    return { pending: { success: false, finalPhase: execution.state.phase, rolledBack: false,
      errorAt: { phase, error: message } } };
  }
}

async function handleStepFailure(
  execution: MigrationExecution,
  failure: StepFailureInput,
): Promise<MigrationRunnerResult | null> {
  const { step, name, phaseAtStart, error } = failure;
  const { input, deps } = execution;
  const message = error instanceof Error ? error.message : String(error);
  if (step.action === QUIESCE_SOURCE && error instanceof MigrationDrainPendingError) {
    await deps.client.resume({ migrationId: input.migrationId, gatewayId: input.fromGatewayId, slug: input.slug });
    if (execution.quiescingMarked) await deps.setAssignmentState!({ gatewayId: input.fromGatewayId, uid: input.uid, state: "serving" });
    await deps.setMigrationPhase?.("waiting");
    await report(deps, { name, status: "skipped", error: message });
    return { success: false, finalPhase: execution.state.phase, rolledBack: false, waitingForUserIdle: true };
  }
  if (isPostCutoverSourceCleanup(execution.state, step)) {
    await report(deps, { name, status: "skipped", error: message });
    deps.log(
      `[migration-runner] ⚠ ${name} cleanup failed after durable cutover migrationId=${input.migrationId} slug=${input.slug}: ${message} — target remains serving`,
    );
    execution.state = { ...execution.state, phase: advancePhase(execution.state.phase) };
    return null;
  }
  const ownership = await readRecoveryOwner(execution, phaseAtStart);
  if ("pending" in ownership) return ownership.pending;
  const { owner } = ownership;
  if (owner !== undefined && owner !== input.fromGatewayId) {
    await report(deps, { name, status: "failed", error: message });
    return { success: false, finalPhase: execution.state.phase, rolledBack: false,
      errorAt: { phase: phaseAtStart, error: owner === input.toGatewayId
        ? `migration cutover committed; destination recovery pending: status 503: ${message}`
        : "migration owner changed; recovery left to the current assignment" } };
  }
  if (execution.forwardOnly) {
    await report(deps, { name, status: "failed", error: message });
    deps.log(`[migration-runner] forward recovery pending migrationId=${input.migrationId}: ${message}`);
    return { success: false, finalPhase: execution.state.phase, rolledBack: false,
      errorAt: { phase: phaseAtStart, error: `migration forward recovery pending: status 503: ${message}` } };
  }
  await resumeUnquiescedPreDrain(execution);
  await report(deps, { name, status: "failed", error: message });
  deps.log(`[migration-runner] ❌ ${name} failed at phase=${phaseAtStart}: ${message}`);
  if (execution.schedules.doc) {
    await restoreScheduleTransfer(deps, { migrationId: input.migrationId, slug: input.slug, gatewayId: input.fromGatewayId, doc: execution.schedules.doc });
  }
  const rollback = await rollbackExecution(execution);
  if (rollback.error) {
    deps.log(
      `[migration-runner] ❌ rollback incomplete migrationId=${input.migrationId} slug=${input.slug}: ${rollback.error}`,
    );
  }
  return {
    success: false,
    finalPhase: execution.state.phase,
    errorAt: {
      phase: phaseAtStart,
      error: rollback.error ? `${message} — ${rollback.error}` : message,
    },
    rolledBack: rollback.rolledBack,
  };
}

async function resumeUnquiescedPreDrain(execution: MigrationExecution): Promise<void> {
  if (!execution.preDrainStarted || execution.quiesceStarted) return;
  const { input, deps } = execution;
  await deps.client.resume({ migrationId: input.migrationId, gatewayId: input.fromGatewayId, slug: input.slug });
}

interface RollbackOutcome {
  rolledBack: boolean;
  error?: string;
}

function rollbackServingTarget(
  execution: MigrationExecution,
): { gatewayId: string; uid: string } | null {
  if (!execution.quiescingMarked) return null;
  return { gatewayId: execution.input.fromGatewayId, uid: execution.input.uid };
}

function rollbackExecution(execution: MigrationExecution): Promise<RollbackOutcome> {
  const { input, deps } = execution;
  return tryRollback(execution.state, deps, input.migrationId, {
    crossGateway: execution.crossGateway,
    restoreServing: rollbackServingTarget(execution),
    quiesceStarted: execution.quiesceStarted,
  });
}

interface RollbackTransports {
  crossGateway: boolean;
  restoreServing: { gatewayId: string; uid: string } | null;
  quiesceStarted: boolean;
}

async function confirmRelease(
  deps: MigrationRunnerDeps,
  name: string,
  release: () => Promise<unknown>,
): Promise<string | null> {
  const wait = deps.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  await report(deps, { name, status: "running" });
  let lastError = "";
  for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
    try {
      await release();
      await report(deps, { name, status: "done" });
      return null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      deps.log(`[migration-runner] ⚠ ${name} attempt ${attempt}/${RELEASE_ATTEMPTS} failed: ${lastError}`);
      if (attempt < RELEASE_ATTEMPTS) await wait(RELEASE_RETRY_DELAY_MS);
    }
  }
  await report(deps, { name, status: "failed", error: lastError });
  return lastError;
}

async function releaseSource(
  state: MigrationState,
  deps: MigrationRunnerDeps,
  migrationId: string,
): Promise<string | null> {
  const error = await confirmRelease(deps, "rollback:resume-ingress", () =>
    deps.client.resume({ migrationId, gatewayId: state.fromGatewayId, slug: state.slug }));
  return error ? `source ingress on ${state.fromGatewayId} not resumed: ${error}` : null;
}

const TARGET_HOLDS_STORES_DURING_ROLLBACK: ReadonlySet<MigrationPhase> =
  new Set(["source-flushed", "final-synced", "target-verified", "cutover-done"]);
const RETURN_SOURCE_STORES = "rollback:return-source-stores";

async function returnSourceStores(state: MigrationState, deps: MigrationRunnerDeps): Promise<string | null> {
  if (!deps.prepareRollbackSource) return null;
  await report(deps, { name: RETURN_SOURCE_STORES, status: "running" });
  try {
    await deps.prepareRollbackSource(state.fromGatewayId, state.slug);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await report(deps, { name: RETURN_SOURCE_STORES, status: "failed", error: msg });
    deps.log(`[migration-runner] ⚠ rollback warn: agent stores not returned to ${state.fromGatewayId}: ${msg}`);
    return `${RETURN_SOURCE_STORES}: ${msg}`;
  }
  await report(deps, { name: RETURN_SOURCE_STORES, status: "done" });
  return null;
}

async function tryRollback(
  state: MigrationState,
  deps: MigrationRunnerDeps,
  migrationId: string,
  transports: RollbackTransports,
): Promise<RollbackOutcome> {
  let plan: MigrationStep[];
  try {
    plan = rollbackPlan(state);
  } catch (planErr) {
    const msg = planErr instanceof Error ? planErr.message : String(planErr);
    deps.log(
      `[migration-runner] ⚠ cannot rollback from phase=${state.phase}: ${msg} — operator must intervene`,
    );
    return { rolledBack: false };
  }
  if (plan.length === 0) {
    await restoreSourceServing(deps, transports.restoreServing);
    deps.log(
      `[migration-runner] no rollback needed at phase=${state.phase} (source still owns)`,
    );
    return { rolledBack: false };
  }
  const failures: string[] = [];
  for (const step of plan) {
    const rbName = `rollback:${reportName(step)}`;
    await report(deps, { name: rbName, status: "running" });
    try {
      if (step.action === "unmount-gateway" && step.role === "target" &&
          ["source-flushed", "final-synced", "target-verified"].includes(state.phase)) {
        await deps.prepareRollbackTarget?.(step.gateway, step.slug);
      }
      await executeStep({
        step,
        deps,
        migrationId,
        slug: state.slug,
        projectCheckoutScope: undefined,
        includeActivationManifest: undefined,
        // Rollback's cutover-firestore restores the SOURCE: flip the mirror
        // back when the migration crossed gateways.
        crossGateway: transports.crossGateway,
        targetGatewayId: state.toGatewayId,
        schedules: {},
        systemConfig: {},
      });
      await report(deps, { name: rbName, status: "done" });
      deps.log(`[migration-runner] rollback ${step.action} ok`);
    } catch (rbErr) {
      const msg = rbErr instanceof Error ? rbErr.message : String(rbErr);
      failures.push(`${rbName}: ${msg}`);
      await report(deps, { name: rbName, status: "failed", error: msg });
      deps.log(`[migration-runner] ⚠ rollback warn: ${step.action} failed: ${msg}`);
    }
  }
  if (failures.length > 0) return { rolledBack: false, error: failures.join("; ") };
  if (TARGET_HOLDS_STORES_DURING_ROLLBACK.has(state.phase)) {
    const unreturned = await returnSourceStores(state, deps);
    if (unreturned) return { rolledBack: false, error: unreturned };
  }
  if (transports.quiesceStarted) {
    const unreleased = await releaseSource(state, deps, migrationId);
    if (unreleased) return { rolledBack: false, error: unreleased };
  }
  await restoreSourceServing(deps, transports.restoreServing);
  return { rolledBack: true };
}

// Revert the pre-quiesce "quiescing" roster mark so the user keeps serving
// on the source after a pre-cutover rollback. Failure here is LOUD (the edge
// keeps 503ing the user until a retry re-drives the migration or the
// operator repairs the assignment).
async function restoreSourceServing(
  deps: MigrationRunnerDeps,
  target: { gatewayId: string; uid: string } | null,
): Promise<void> {
  if (!target || !deps.setAssignmentState) return;
  try {
    await deps.setAssignmentState({ ...target, state: "serving" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(
      `[migration-runner] ❌ FAILED to restore assignment serving for uid=${target.uid} on ${target.gatewayId}: ${msg} — ` +
        `the user stays quiescing (edge answers 503) until the next retry or an operator repair`,
    );
    throw err;
  }
}

async function report(
  deps: MigrationRunnerDeps,
  step: ReportedStep,
): Promise<void> {
  if (!deps.reportStep) return;
  try {
    await deps.reportStep(step);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`[migration-runner] ⚠ reportStep threw — ignoring: ${msg}`);
  }
}
