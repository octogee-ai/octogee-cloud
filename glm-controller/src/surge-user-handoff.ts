import { createRepeatSquelch } from "@octogee/shared/server/repeat-squelch";
import { recoverAbandonedSurgeSchedulerSource } from "./surge-scheduler-source-recovery.js";
import { abortSurgeSchedulerTarget, activateSurgeScheduler, resumeSurgeSchedulerSource, assertSurgeSchedulerCustody, inspectExistingSurgeScheduler, stageSurgeScheduler, type SurgeSchedulerCustody } from "./surge-scheduler-handoff.js";
import type { CrashLoopEvictionClaim } from "./surge-crashloop-eviction.js";
import { MigrationDrainPendingError } from "@octogee/core/fleet-migration-client";
import { createMigrationProgress } from "./migration-progress.js";
import { operationScopedLog, withOperationLogScope } from "./operation-log-scope.js";
import type { MigrationProgressRequestBody, SchedulerMigrationRequest, SchedulerMigrationResult } from "@octogee/shared/types/fleet-controller";
import type { AssignmentState } from "@octogee/shared/types/gateway-releases";
import type { MigrationProgressRecord, OperationStatus } from "@octogee/shared/types/glm";
import type {
  MigrationConfigTransferMode,
  MigrationLoadStrategy,
} from "@octogee/shared/types/fleet-controller";
import { gatewayHeartbeatMatchesImageTag } from "@octogee/shared/types/image-tag";

const CONFIGURED_USER_SYSTEM_CONFIG = "configured-builder-system-config";

export type SurgeUserHandoffResult =
  | { ready: boolean; prelaunchHeld?: never }
  | { ready: true; prelaunchHeld: true };

export interface SurgePod {
  image?: string;
  uid: string;
  name: string;
  podIP: string;
  ready: boolean;
  terminating: boolean;
  crashLooping: boolean;
}

export interface SurgePodSnapshot {
  pods: readonly SurgePod[];
  observedPodUids: readonly string[];
}

export type SurgePrelaunchState = "none" | "held" | "hydrated" | "starting" | "serving";
export type SurgeFleetSignatureCapability = "gateway-scoped" | "legacy";

export interface SurgePodHealth {
  status: "booting" | "ready";
  version: string;
  fleetSignatureCapability: SurgeFleetSignatureCapability;
  handoffReleased: boolean;
  prelaunchState: SurgePrelaunchState;
  mountedCustomers: readonly string[];
  migratingIn?: readonly string[];
  terminalTarget?: { migrationId: string; slug: string; targetPodUid: string; processHeld?: boolean; completionStarted?: boolean };
}

export interface SurgeAssignment {
  uid: string;
  slug: string;
  state: AssignmentState;
  epoch: number;
  updatedAt?: number;
  updatedByOperationId: string | null;
  sharedSurgeForwardRecovery?: { operationId: string; targetPodUid: string; receivingPodUid: string };
}

export interface SurgeLiveRoster {
  mountedCustomers: readonly string[];
}

export function assertSurgeAssignmentCoverage(
  assignments: readonly SurgeAssignment[],
  users: ReadonlyArray<{ uid: string; slug: string }>,
): void {
  const assignmentByUid = new Map(assignments.map((item) => [item.uid, item]));
  const userByUid = new Map(users.map((item) => [item.uid, item]));
  for (const user of users) {
    const assignment = assignmentByUid.get(user.uid);
    if (!assignment || assignment.slug !== user.slug) {
      throw new Error(`missing assignment for assigned user ${user.uid}/${user.slug}`);
    }
  }
  for (const assignment of assignments) {
    const user = userByUid.get(assignment.uid);
    if (!user || user.slug !== assignment.slug) {
      throw new Error(`orphan assignment ${assignment.uid}/${assignment.slug}`);
    }
  }
}

class SurgeTargetCleanupError extends Error {}

// A source pod whose image predates the OpenClaw process gate cannot stop its
// own OpenClaw on request. It still quiesces and flushes, so the handoff
// degrades to the pre-gate contract for that one roll instead of wedging the
// gateway on its own image forever.
export class SurgeOpenClawProcessEndpointMissingError extends Error {}
export class SurgeGatewayScopedSignatureCapabilityMissingError extends Error {}
export class SurgeAssignmentBusyError extends Error {}

const SYSTEM_CONFIG_COMMIT = /^[0-9a-f]{40,64}$/;
const CONFIGURED_ISOLATED_TARGET_RELEASE_RETRY_DELAY_MS = 7_000;

interface SurgeSourceControlInput {
  gatewayId: string;
  slug: string;
  operationId: string;
  sourcePod: SurgePod;
}

export interface SurgeUserHandoffDeps {
  reportMigrationProgress: (input: { gatewayId: string; targetPod: SurgePod; event: MigrationProgressRequestBody }) => Promise<unknown>;
  recordMigrationProgress: (input: { gatewayId: string; uid: string; event: MigrationProgressRecord }) => Promise<unknown>;
  listPods: (gatewayId: string) => Promise<SurgePodSnapshot>;
  readPodHealth: (pod: SurgePod, gatewayId: string) => Promise<SurgePodHealth | null>;
  deleteCancelledTarget: (input: { gatewayId: string; pod: SurgePod }) => Promise<void>;
  deleteCrashLoopingPod: (input: { gatewayId: string; pod: SurgePod }) => Promise<void>;
  claimCrashLoopEviction: (input: { gatewayId: string; imageTag: string; pod: SurgePod }) => Promise<CrashLoopEvictionClaim>;
  readAssignments: (gatewayId: string, liveRoster?: SurgeLiveRoster) => Promise<SurgeAssignment[]>;
  markSharedSurgeForwardRecovery: (input: { gatewayId: string; uid: string; slug: string; epoch: number; operationId: string; targetPodUid: string; expectedUpdatedAt: number }) => Promise<void>;
  rebindSharedSurgeForwardRecovery: (input: { gatewayId: string; uid: string; slug: string; epoch: number; operationId: string; targetPodUid: string; expectedReceivingPodUid: string; receivingPodUid: string; expectedUpdatedAt: number }) => Promise<void>;
  markAssignment: (input: {
    gatewayId: string;
    uid: string;
    slug: string;
    epoch: number;
    state: "serving" | "quiescing";
    updatedByOperationId: string;
    clearSharedSurgeForwardRecovery?: { operationId: string; targetPodUid: string; receivingPodUid: string };
    expected: {
      state: AssignmentState;
      updatedByOperationId: string | null;
      updatedAt?: number;
    };
  }) => Promise<void>;
  waitForSourceIdle: (input: SurgeSourceControlInput) => Promise<void>;
  quiesce: (input: SurgeSourceControlInput) => Promise<void>;
  scheduler?: (input: SchedulerMigrationRequest & { gatewayId: string; slug: string; pod: SurgePod }) => Promise<SchedulerMigrationResult>;
  resumeSourceIngress: (input: SurgeSourceControlInput) => Promise<void>;
  stopSourceOpenClaw?: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
  }) => Promise<void>;
  resumeSourceOpenClaw?: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
  }) => Promise<void>;
  holdTargetOpenClaw?: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    targetPod: SurgePod;
    inspectTarget?: boolean;
    reserveTarget?: boolean;
  }) => Promise<{ completionStarted?: boolean } | void>;
  unreserveTargetOpenClaw?: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    targetPod: SurgePod;
  }) => Promise<void>;
  flush: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    pod: SurgePod;
    reason: "migration-final" | "migration-converge";
    expectedSystemConfigCommit?: string;
  }) => Promise<{ systemConfigCommit?: string }>;
  transfer: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
    loadStrategy: MigrationLoadStrategy;
    configTransferMode: MigrationConfigTransferMode;
    expectedSystemConfigCommit?: string;
  }) => Promise<void>;
  discardTargetUser: (input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    targetPod: SurgePod;
  }) => Promise<void>;
  readSystemConfigCommit: (pod: SurgePod) => Promise<string>;
  releaseTarget: (input: {
    gatewayId: string;
    operationId: string;
    pod: SurgePod;
  }) => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  readOwnerOperation: (operationId: string) => Promise<{ status: OperationStatus; sourceRecoveryPending?: boolean } | null>;
  recheckGatewayLater: (gatewayId: string) => void;
  log: (message: string) => void;
}

export interface ReconcileSurgeUserHandoffInput {
  gatewayId: string;
  desiredImageTag: string;
  requiresUserMigration: boolean;
  isolatedGateway?: boolean;
  ownerlessOperatorPrewarm?: boolean;
  /** Image tag a queued rollout will put on this gateway, when it replaces the current one. */
  supersedingImageTag?: string;
}

function configTransferModeFor(
  input: Pick<ReconcileSurgeUserHandoffInput, "isolatedGateway">,
): MigrationConfigTransferMode {
  return input.isolatedGateway === true
    ? CONFIGURED_USER_SYSTEM_CONFIG
    : "activation-manifest";
}

function configuredUserProcessGateRequired(
  input: Pick<ReconcileSurgeUserHandoffInput, "isolatedGateway">,
): boolean {
  return configTransferModeFor(input) === CONFIGURED_USER_SYSTEM_CONFIG;
}

function prelaunchTransferEligible(health: SurgePodHealth): boolean {
  return health.prelaunchState === "held" || health.prelaunchState === "hydrated";
}

function terminalTargetAttemptMatches(health: SurgePodHealth, target: SurgePod, owner: string): boolean {
  return health.terminalTarget?.migrationId === owner && health.terminalTarget.targetPodUid === target.uid;
}

async function stopSourceOpenClaw(
  deps: SurgeUserHandoffDeps,
  input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
  },
): Promise<void> {
  if (!deps.stopSourceOpenClaw) {
    throw new Error("configured user source lacks the required surge OpenClaw hold capability");
  }
  await deps.stopSourceOpenClaw(input);
}

async function resumeSourceOpenClaw(
  deps: SurgeUserHandoffDeps,
  input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
  },
): Promise<void> {
  if (!deps.resumeSourceOpenClaw) {
    throw new Error("configured user source lacks the required surge OpenClaw resume capability");
  }
  await deps.resumeSourceOpenClaw(input);
}

async function holdTargetOpenClaw(
  deps: SurgeUserHandoffDeps,
  input: {
    gatewayId: string;
    slug: string;
    operationId: string;
    targetPod: SurgePod;
    inspectTarget?: boolean;
    reserveTarget?: boolean;
  },
): Promise<{ completionStarted?: boolean } | void> {
  if (!deps.holdTargetOpenClaw) {
    throw new Error("configured isolated target lacks the required surge OpenClaw reserve capability");
  }
  return deps.holdTargetOpenClaw(input);
}

function requireSystemConfigCommit(
  systemConfigCommit: string | undefined,
  slug: string,
): string {
  if (typeof systemConfigCommit === "string" && SYSTEM_CONFIG_COMMIT.test(systemConfigCommit)) {
    return systemConfigCommit;
  }
  throw new Error(`User handoff source flush did not return a system config commit for ${slug}`);
}

function operationId(gatewayId: string, targetPodUid: string): string {
  return `surge-${gatewayId}-${targetPodUid}`;
}

const SURGE_OPERATION_ID_RE =
  /^surge-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

function isSurgeOwnerForGateway(owner: string, gatewayId: string): boolean {
  return SURGE_OPERATION_ID_RE.exec(owner)?.[1] === gatewayId;
}

// A quiescing assignment is a lease. Surge leases name a pod uid, so pod observation
// decides liveness; every other owner is an operations-collection id, and one that is
// gone or terminal will never release its own lease.
async function abandonedLeaseReason(
  deps: SurgeUserHandoffDeps,
  gatewayId: string,
  owner: string,
  context: {
    liveSurgeOwners: ReadonlySet<string>;
    reclaimableOwners: ReadonlySet<string>;
  },
): Promise<string | null> {
  if (SURGE_OPERATION_ID_RE.test(owner)) {
    if (!isSurgeOwnerForGateway(owner, gatewayId)) return null;
    if (context.reclaimableOwners.has(owner)) return "prior surge target is now the source";
    return context.liveSurgeOwners.has(owner) ? null : "owning surge pod is gone";
  }
  const operation = await deps.readOwnerOperation(owner);
  if (!operation) return "owning operation no longer exists";
  if (operation.sourceRecoveryPending) return null;
  return operation.status === "pending" || operation.status === "running"
    ? null
    : `owning operation is ${operation.status}`;
}

function selectTarget(
  pods: readonly SurgePod[],
  healthByUid: ReadonlyMap<string, SurgePodHealth>,
  desiredImageTag: string,
): SurgePod | null {
  const desired = pods.filter((pod) => !pod.terminating && gatewayHeartbeatMatchesImageTag(
    healthByUid.get(pod.uid)?.version,
    desiredImageTag,
  ));
  const blocked = desired.filter((pod) => !pod.ready);
  if (blocked.length === 1) return blocked[0];
  if (blocked.length > 1) {
    throw new Error(`multiple blocked replacement pods report desired image ${desiredImageTag}`);
  }
  if (desired.length === 1) return desired[0];
  return null;
}

function assertAssignmentsAvailable(
  assignments: readonly SurgeAssignment[],
  ownedBy: string,
): void {
  const foreign = assignments.find((item) =>
    item.state !== "serving" &&
    !(item.state === "quiescing" && item.updatedByOperationId === ownedBy));
  if (foreign) {
    const message = `foreign assignment gate for ${foreign.uid}/${foreign.slug}: ` +
      `state=${foreign.state} owner=${foreign.updatedByOperationId ?? "none"}`;
    if (foreign.state === "quiescing" && foreign.updatedByOperationId) {
      throw new SurgeAssignmentBusyError(message);
    }
    throw new Error(message);
  }
}

async function setAssignmentState(
  deps: SurgeUserHandoffDeps,
  gatewayId: string,
  assignment: SurgeAssignment,
  options: { state: "serving" | "quiescing"; ownedBy: string; clearForward?: boolean },
): Promise<void> {
  const { state, ownedBy, clearForward } = options;
  await deps.markAssignment({
    gatewayId,
    uid: assignment.uid,
    slug: assignment.slug,
    epoch: assignment.epoch,
    state,
    updatedByOperationId: ownedBy,
    ...(clearForward && assignment.sharedSurgeForwardRecovery ? { clearSharedSurgeForwardRecovery: assignment.sharedSurgeForwardRecovery } : {}),
    expected: {
      state: assignment.state,
      updatedByOperationId: assignment.updatedByOperationId,
      ...(assignment.updatedAt === undefined ? {} : { updatedAt: assignment.updatedAt }),
    },
  });
  const current = (await deps.readAssignments(gatewayId)).find(row => row.uid === assignment.uid);
  if (!current || current.slug !== assignment.slug || current.epoch !== assignment.epoch || current.state !== state ||
      current.updatedByOperationId !== ownedBy || !Number.isSafeInteger(current.updatedAt) || current.updatedAt! <= 0 ||
      (assignment.updatedAt !== undefined && current.updatedAt! <= assignment.updatedAt)) {
    throw new Error(`assignment clock changed during state update for ${assignment.slug}`);
  }
  assignment.updatedAt = current.updatedAt;
}

async function gateServingAssignments(
  deps: SurgeUserHandoffDeps,
  gatewayId: string,
  assignments: readonly SurgeAssignment[],
  ownedBy: string,
): Promise<void> {
  for (const assignment of assignments) {
    if (assignment.state !== "serving") continue;
    await setAssignmentState(deps, gatewayId, assignment, { state: "quiescing", ownedBy });
    assignment.state = "quiescing";
    assignment.updatedByOperationId = ownedBy;
  }
}

async function restoreOwnedAssignments(
  deps: SurgeUserHandoffDeps,
  gatewayId: string,
  assignments: readonly SurgeAssignment[],
  ownedBy: string,
  clearForward = false,
): Promise<void> {
  for (const assignment of assignments) {
    if (assignment.state === "quiescing" && assignment.updatedByOperationId === ownedBy) {
      await setAssignmentState(deps, gatewayId, assignment, { state: "serving", ownedBy, clearForward });
      assignment.state = "serving";
      assignment.updatedByOperationId = ownedBy;
    }
  }
}

async function restoreAbandonedSurgeAssignments(
  deps: SurgeUserHandoffDeps,
  gatewayId: string,
  assignments: readonly SurgeAssignment[],
  ownedBy: string | null,
  context: {
    observedPodUids: readonly string[];
    reclaimableOwners?: ReadonlySet<string>;
    schedulerCustodyRequired?: boolean;
  },
): Promise<void> {
  const { observedPodUids, reclaimableOwners = new Set() } = context;
  const liveSurgeOwners = new Set(observedPodUids.map((uid) => operationId(gatewayId, uid)));
  for (const assignment of assignments) {
    if (assignment.sharedSurgeForwardRecovery) continue;
    const priorOwner = assignment.updatedByOperationId;
    if (assignment.state !== "quiescing" || priorOwner === null || priorOwner === ownedBy) {
      continue;
    }
    const reason = await abandonedLeaseReason(deps, gatewayId, priorOwner, {
      liveSurgeOwners,
      reclaimableOwners,
    });
    if (!reason) continue;
    if (context.schedulerCustodyRequired) {
      const snapshot = await deps.listPods(gatewayId);
      const sources = snapshot.pods.filter(pod => pod.ready && !pod.terminating && !pod.crashLooping);
      if (!isSurgeOwnerForGateway(priorOwner, gatewayId) || sources.length !== 1 || snapshot.pods.length > 2) {
        deps.log(`[surge-handoff] scheduler custody settlement required before restoring ${assignment.slug} owner=${priorOwner}`);
        continue;
      }
      const standbyTarget = snapshot.pods.find(pod => pod.uid !== sources[0].uid);
      await recoverAbandonedSurgeSchedulerSource(deps, { gatewayId, assignment: { ...assignment }, sourcePod: sources[0],
        ...(standbyTarget ? { standbyTarget } : {}) });
    }
    deps.log(
      `[surge-handoff] restoring abandoned assignment ` +
      `gateway=${gatewayId} uid=${assignment.uid} owner=${priorOwner}: ${reason}`,
    );
    const recoveryOwner = ownedBy ?? priorOwner;
    await setAssignmentState(deps, gatewayId, assignment, { state: "serving", ownedBy: recoveryOwner });
    assignment.state = "serving";
    assignment.updatedByOperationId = recoveryOwner;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function discardTargetUsers(
  deps: SurgeUserHandoffDeps,
  context: {
    gatewayId: string;
    operationId: string;
    targetPod: SurgePod;
    slugs: readonly string[];
    cause?: unknown;
  },
): Promise<void> {
  const failures: string[] = [];
  for (const slug of [...new Set(context.slugs)].reverse()) {
    try {
      await deps.discardTargetUser({
        gatewayId: context.gatewayId,
        slug,
        operationId: context.operationId,
        targetPod: context.targetPod,
      });
    } catch (error) {
      failures.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new SurgeTargetCleanupError(
      `surge target cleanup failed; admission remains closed: ${failures.join("; ")}`,
      { cause: context.cause },
    );
  }
}

interface AssignmentTransferContext {
  input: ReconcileSurgeUserHandoffInput;
  sourcePod: SurgePod;
  targetPod: SurgePod;
  ownedBy: string;
  heldSourceSlugs: string[];
  schedulerCustodies: SurgeSchedulerCustody[];
}

async function finalizeSourceForAssignment(
  deps: SurgeUserHandoffDeps,
  context: AssignmentTransferContext,
  assignment: SurgeAssignment,
): Promise<string | undefined> {
  const { input, sourcePod, targetPod, ownedBy, heldSourceSlugs } = context;
  await deps.quiesce({
    gatewayId: input.gatewayId,
    slug: assignment.slug,
    operationId: ownedBy,
    sourcePod,
  });
  if (!configuredUserProcessGateRequired(input)) return undefined;
  const sourceSystemConfigCommit = requireSystemConfigCommit(
    (await deps.flush({
      gatewayId: input.gatewayId,
      slug: assignment.slug,
      operationId: ownedBy,
      pod: sourcePod,
      reason: "migration-final",
    })).systemConfigCommit,
    assignment.slug,
  );
  await holdTargetOpenClaw(deps, {
    gatewayId: input.gatewayId,
    slug: assignment.slug,
    operationId: ownedBy,
    targetPod,
  });
  try {
    await stopSourceOpenClaw(deps, {
      gatewayId: input.gatewayId,
      slug: assignment.slug,
      operationId: ownedBy,
      sourcePod,
      targetPod,
    });
  } catch (error) {
    if (!(error instanceof SurgeOpenClawProcessEndpointMissingError)) throw error;
    deps.log(
      `[surge-handoff] source predates the OpenClaw process gate; copying from the quiesced ` +
      `source ` +
      `gateway=${input.gatewayId} source=${sourcePod.name} slug=${assignment.slug}`,
    );
    return sourceSystemConfigCommit;
  }
  if (!heldSourceSlugs.includes(assignment.slug)) heldSourceSlugs.push(assignment.slug);
  return sourceSystemConfigCommit;
}

async function copyAssignment(
  deps: SurgeUserHandoffDeps,
  context: AssignmentTransferContext,
  assignment: SurgeAssignment,
  expectedSystemConfigCommit: string | undefined,
): Promise<void> {
  const { input, sourcePod, targetPod, ownedBy } = context;
  const configTransferMode = configTransferModeFor(input);
  await deps.transfer({
    gatewayId: input.gatewayId,
    slug: assignment.slug,
    operationId: ownedBy,
    sourcePod,
    targetPod,
    loadStrategy: input.isolatedGateway === true && sourcePod.terminating
      ? "expedited"
      : "standard",
    configTransferMode,
    ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
  });

}

async function drainWithProgress<T>(
  progress: ReturnType<typeof createMigrationProgress>,
  phase: string,
  action: () => Promise<T>,
): Promise<T> {
  await progress.report(phase, "running");
  try {
    const result = await action();
    await progress.report(phase, "done");
    return result;
  } catch (error) {
    await progress.report(error instanceof MigrationDrainPendingError ? "waiting-for-builder-idle" : phase,
      error instanceof MigrationDrainPendingError ? "pending" : "failed");
    throw error;
  }
}

async function waitForSourceAssignments(
  deps: SurgeUserHandoffDeps,
  context: AssignmentTransferContext & { assignments: readonly SurgeAssignment[]; sourceDrainSlugs: string[] },
): Promise<void> {
  for (const assignment of context.assignments) {
    if (assignment.sharedSurgeForwardRecovery) continue;
    context.sourceDrainSlugs.push(assignment.slug);
    const progress = createMigrationProgress({
      log: (message) => deps.log(`${message} migrationId=${context.ownedBy} user=${assignment.slug}`),
      send: (event) => deps.reportMigrationProgress({
        gatewayId: context.input.gatewayId,
        targetPod: context.targetPod,
        event: { ...event, migrationId: context.ownedBy, slug: assignment.slug, source: context.sourcePod.name },
      }),
      persist: (event) => deps.recordMigrationProgress({
        gatewayId: context.input.gatewayId,
        uid: assignment.uid,
        event: { ...event, migrationId: context.ownedBy, slug: assignment.slug, source: context.sourcePod.name },
      }),
    });
    await drainWithProgress(progress, "waiting-for-builder-idle", () => deps.waitForSourceIdle({
      gatewayId: context.input.gatewayId, slug: assignment.slug,
      operationId: context.ownedBy, sourcePod: context.sourcePod,
    }));
  }
}

async function transferAssignments(
  deps: SurgeUserHandoffDeps,
  context: AssignmentTransferContext & { assignments: readonly SurgeAssignment[] },
): Promise<void> {
  const { input, assignments, targetPod, ownedBy } = context;
  const touchedSlugs: string[] = [];
  try {
    for (const assignment of assignments) {
      const progress = createMigrationProgress({
        log: (message) => deps.log(`${message} migrationId=${ownedBy} user=${assignment.slug}`),
        send: (event) => deps.reportMigrationProgress({
          gatewayId: input.gatewayId,
          targetPod,
          event: { ...event, migrationId: ownedBy, slug: assignment.slug, source: context.sourcePod.name },
        }),
        persist: (event) => deps.recordMigrationProgress({
          gatewayId: input.gatewayId,
          uid: assignment.uid,
          event: { ...event, migrationId: ownedBy, slug: assignment.slug, source: context.sourcePod.name },
        }),
      });
      await progress.run("gate-source", () => gateServingAssignments(deps, input.gatewayId, [assignment], ownedBy));
      if (configTransferModeFor(input) === "activation-manifest") {
        const custody: SurgeSchedulerCustody = { gatewayId: input.gatewayId, owner: ownedBy, assignment: { ...assignment }, source: context.sourcePod, target: targetPod };
        context.schedulerCustodies.push(custody);
        await progress.run("stage-scheduler", () => stageSurgeScheduler(deps, custody));
      }
      const sourceSystemConfigCommit = assignment.sharedSurgeForwardRecovery ? undefined :
        await drainWithProgress(progress, "quiesce-and-finalize-source", () => finalizeSourceForAssignment(deps, context, assignment));
      if (configTransferModeFor(input) === "activation-manifest" && !assignment.sharedSurgeForwardRecovery) {
        if (!assignment.updatedAt) throw new Error("Shared surge forward boundary requires assignment clock");
        await deps.markSharedSurgeForwardRecovery({ gatewayId: input.gatewayId, uid: assignment.uid, slug: assignment.slug,
          epoch: assignment.epoch, operationId: ownedBy, targetPodUid: targetPod.uid, expectedUpdatedAt: assignment.updatedAt });
        assignment.sharedSurgeForwardRecovery = { operationId: ownedBy, targetPodUid: targetPod.uid, receivingPodUid: targetPod.uid };
      }
      touchedSlugs.push(assignment.slug);
      await progress.run("transfer-state", () => copyAssignment(deps, context, assignment, sourceSystemConfigCommit));
      await progress.report("serving-handoff", "pending");
    }
  } catch (error) {
    const current = await deps.readAssignments(input.gatewayId);
    if (current.some(row => row.sharedSurgeForwardRecovery)) throw error;
    if (configTransferModeFor(input) === "activation-manifest") {
      await discardTargetUsers(deps, {
        gatewayId: input.gatewayId,
        operationId: ownedBy,
        targetPod,
        slugs: touchedSlugs,
        cause: error,
      });
    } else if (touchedSlugs.length > 0) {
      deps.log(
        `[surge-handoff] preserving configured isolated target state after failed handoff ` +
        `gateway=${input.gatewayId} slugs=${touchedSlugs.join(",")}: ${errorMessage(error)}`,
      );
    }
    throw error;
  }
}

function targetMountedAssignedUsers(
  assignments: readonly SurgeAssignment[],
  mountedCustomers: readonly string[],
): boolean {
  const assigned = new Set(assignments.map((assignment) => assignment.slug));
  const mounted = new Set(mountedCustomers);
  return assigned.size === mounted.size && [...assigned].every((slug) => mounted.has(slug));
}

function soleTargetLiveRoster(
  source: SurgeSourceSelection,
  target: SurgePod,
  targetHealth: SurgePodHealth,
  observedPodUids: readonly string[],
): SurgeLiveRoster | undefined {
  return source.kind === "missing" && targetHealth.status === "ready" &&
    observedPodUids.length === 1 && observedPodUids[0] === target.uid
    ? { mountedCustomers: targetHealth.mountedCustomers }
    : undefined;
}

type SurgeSourceSelection =
  | { kind: "missing" }
  | { kind: "waiting"; pod: SurgePod }
  | { kind: "ready"; pod: SurgePod };

function selectSource(pods: readonly SurgePod[], target: SurgePod): SurgeSourceSelection {
  const sources = pods.filter((pod) => pod.uid !== target.uid);
  if (sources.length > 1) throw new Error("multiple source pods found");
  const source = sources[0];
  if (!source) return { kind: "missing" };
  return source.ready || source.terminating
    ? { kind: "ready", pod: source }
    : { kind: "waiting", pod: source };
}

async function releaseTargetWithConfirmation(
  deps: SurgeUserHandoffDeps,
  input: {
    gatewayId: string;
    operationId: string;
    pod: SurgePod;
    retryHeldConfiguredIsolatedTarget?: boolean;
  },
): Promise<void> {
  const releaseOnce = async (): Promise<void> => {
    try {
      await deps.releaseTarget(input);
    } catch (error) {
      const health = await deps.readPodHealth(input.pod, input.gatewayId);
      if (health?.handoffReleased) {
        deps.log(
          `[surge-handoff] confirmed target release after response failure ` +
          `pod=${input.pod.name}`,
        );
        return;
      }
      throw error;
    }
  };
  try {
    await releaseOnce();
  } catch (error) {
    if (!input.retryHeldConfiguredIsolatedTarget) throw error;
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    await wait(CONFIGURED_ISOLATED_TARGET_RELEASE_RETRY_DELAY_MS);
    const health = await deps.readPodHealth(input.pod, input.gatewayId);
    if (health?.handoffReleased) {
      deps.log(
        `[surge-handoff] confirmed target release after delayed response failure ` +
        `pod=${input.pod.name}`,
      );
      return;
    }
    if (!health || !prelaunchTransferEligible(health)) throw error;
    deps.log(
      `[surge-handoff] retrying configured isolated target release after it returned to hold ` +
      `pod=${input.pod.name}: ${errorMessage(error)}`,
    );
    await releaseOnce();
  }
}

function assertSameTargetCompletion(
  expected: { completionStarted?: boolean }, actual: { completionStarted?: boolean } | void,
): void {
  if (actual?.completionStarted !== expected.completionStarted) {
    throw new Error("configured isolated target completion state changed during forward retry");
  }
}

async function retryHeldIsolatedTarget(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  context: { sourcePod: SurgePod; targetPod: SurgePod; ownedBy: string; assignments: readonly SurgeAssignment[] },
): Promise<void> {
  const assignment = context.assignments[0]!;
  const scope = { gatewayId: input.gatewayId, slug: assignment.slug, operationId: context.ownedBy };
  await stopSourceOpenClaw(deps, { ...scope, sourcePod: context.sourcePod, targetPod: context.targetPod });
  const hold = await holdTargetOpenClaw(deps, { ...scope, targetPod: context.targetPod, inspectTarget: true });
  if (typeof hold?.completionStarted !== "boolean") {
    throw new Error("configured isolated target cannot prove whether Native completion started");
  }
  if (!hold.completionStarted) {
    const sourceCommit = requireSystemConfigCommit(await deps.readSystemConfigCommit(context.sourcePod), assignment.slug);
    await deps.transfer({ ...scope, sourcePod: context.sourcePod, targetPod: context.targetPod,
      loadStrategy: "standard", configTransferMode: CONFIGURED_USER_SYSTEM_CONFIG, expectedSystemConfigCommit: sourceCommit });
  }
  const snapshot = await deps.listPods(input.gatewayId);
  if (!physicalPodsProjected(snapshot) || snapshot.pods.length !== 2 ||
      !snapshot.pods.some(pod => pod.uid === context.sourcePod.uid && !pod.terminating) ||
      !snapshot.pods.some(pod => pod.uid === context.targetPod.uid && !pod.terminating)) {
    throw new Error("configured user forward retry pod custody changed");
  }
  const current = await deps.readAssignments(input.gatewayId);
  if (current.length !== 1 || current[0]!.uid !== assignment.uid || current[0]!.epoch !== assignment.epoch ||
      current[0]!.state !== "quiescing" || current[0]!.updatedByOperationId !== context.ownedBy) {
    throw new Error("configured user forward retry assignment custody changed");
  }
  await stopSourceOpenClaw(deps, { ...scope, sourcePod: context.sourcePod, targetPod: context.targetPod });
  const verified = await holdTargetOpenClaw(deps, { ...scope, targetPod: context.targetPod, inspectTarget: true });
  assertSameTargetCompletion(hold, verified);
  await releaseTargetWithConfirmation(deps, { gatewayId: input.gatewayId, operationId: context.ownedBy,
    pod: context.targetPod, retryHeldConfiguredIsolatedTarget: true });
}

async function recoverHeldWaitingSource(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  context: {
    sourcePod: SurgePod;
    sourceHealth: SurgePodHealth | undefined;
    targetPod: SurgePod;
    targetHealth: SurgePodHealth;
    ownedBy: string;
    assignments: readonly SurgeAssignment[];
  },
): Promise<void> {
  if (
    !configuredUserProcessGateRequired(input) ||
    context.sourceHealth?.prelaunchState !== "held" || !prelaunchTransferEligible(context.targetHealth)
  ) {
    return;
  }
  const owned = context.assignments.length === 1 && context.assignments.every(assignment =>
    assignment.state === "quiescing" && assignment.updatedByOperationId === context.ownedBy);
  if (owned && context.targetHealth.terminalTarget?.completionStarted !== false && context.targetHealth.terminalTarget) return;
  if (owned && !context.targetHealth.terminalTarget) {
    await retryHeldIsolatedTarget(deps, input, context);
    return;
  }
  const resumed: SurgeAssignment[] = [];
  for (const assignment of context.assignments) {
    const { slug } = assignment;
    try {
      await resumeSourceOpenClaw(deps, {
        gatewayId: input.gatewayId,
        slug,
        operationId: context.ownedBy,
        sourcePod: context.sourcePod,
        targetPod: context.targetPod,
      });
      await deps.resumeSourceIngress({ gatewayId: input.gatewayId, slug,
        operationId: context.ownedBy, sourcePod: context.sourcePod });
      resumed.push(assignment);
      deps.log(
        `[surge-handoff] resumed a held NotReady source ` +
        `gateway=${input.gatewayId} source=${context.sourcePod.name} slug=${slug}`,
      );
    } catch (error) {
      deps.log(
        `[surge-handoff] held NotReady source resume failed ` +
        `gateway=${input.gatewayId} source=${context.sourcePod.name} slug=${slug}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await restoreOwnedAssignments(deps, input.gatewayId, resumed, context.ownedBy);
}

// A reserved target whose source pod object is gone waits forever: its
// reservation refuses pod-side self-release and no source can feed a transfer.
// Unreserving converts it back to the no-sibling boot path, which rebuilds from
// durable state.
async function unreserveSourcelessTarget(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  context: {
    targetPod: SurgePod;
    targetHealth: SurgePodHealth;
    ownedBy: string;
    slugs: readonly string[];
  },
): Promise<void> {
  if (
    !configuredUserProcessGateRequired(input) ||
    !prelaunchTransferEligible(context.targetHealth) ||
    !deps.unreserveTargetOpenClaw
  ) {
    return;
  }
  for (const slug of context.slugs) {
    try {
      await deps.unreserveTargetOpenClaw({
        gatewayId: input.gatewayId,
        slug,
        operationId: context.ownedBy,
        targetPod: context.targetPod,
      });
      deps.log(
        `[surge-handoff] unreserved a sourceless configured isolated target ` +
        `gateway=${input.gatewayId} target=${context.targetPod.name} slug=${slug}`,
      );
    } catch (error) {
      deps.log(
        `[surge-handoff] sourceless target unreserve failed ` +
        `gateway=${input.gatewayId} target=${context.targetPod.name} slug=${slug}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function releaseSourcelessSharedTarget(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  context: { targetPod: SurgePod; targetHealth: SurgePodHealth; ownedBy: string; assignments: readonly SurgeAssignment[] },
): Promise<void> {
  if (!targetMountedAssignedUsers(context.assignments, context.targetHealth.mountedCustomers)) {
    deps.log(`[surge-handoff] sourceless Shared target is missing its assigned mounted roster gateway=${input.gatewayId} target=${context.targetPod.name}`);
    deps.recheckGatewayLater(input.gatewayId);
    return;
  }
  try {
    await releaseTargetWithConfirmation(deps, {
      gatewayId: input.gatewayId,
      operationId: context.ownedBy,
      pod: context.targetPod,
    });
    deps.log(
      `[surge-handoff] released a sourceless shared target ` +
      `gateway=${input.gatewayId} target=${context.targetPod.name}`,
    );
  } catch (error) {
    deps.log(
      `[surge-handoff] sourceless shared target release failed ` +
      `gateway=${input.gatewayId} target=${context.targetPod.name}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const sourceWaits = createRepeatSquelch({ windowMs: 60_000 });

function sourceForTransfer(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  source: SurgeSourceSelection,
): SurgePod | null {
  if (source.kind === "missing") {
    const admitted = sourceWaits.admit(input.gatewayId, "missing");
    if (admitted) deps.log(`[surge-handoff] source absent; waiting for pod-side readiness release gateway=${input.gatewayId}${admitted.note}`);
    return null;
  }
  if (source.kind === "waiting") {
    const admitted = sourceWaits.admit(input.gatewayId, `waiting:${source.pod.name}`);
    if (admitted) deps.log(`[surge-handoff] source pod exists but is NotReady; waiting gateway=${input.gatewayId} source=${source.pod.name}${admitted.note}`);
    return null;
  }
  sourceWaits.settle(input.gatewayId);
  return source.pod;
}

function assertSourceMountedRoster(assignments: readonly SurgeAssignment[], mountedCustomers: readonly string[], gatewayId: string): void {
  const assigned = new Set(assignments.map(assignment => assignment.slug));
  const unassigned = mountedCustomers.find(slug => !assigned.has(slug));
  if (unassigned) throw new Error(`source mounted user ${unassigned} has no assignment on ${gatewayId}`);
  const mounted = new Set(mountedCustomers);
  const unmounted = assignments.find(assignment => !mounted.has(assignment.slug));
  if (unmounted) throw new Error(`source has unmounted assigned user ${unmounted.slug} on ${gatewayId}`);
}

async function migrateAssignedState(
  deps: SurgeUserHandoffDeps,
  context: {
    input: ReconcileSurgeUserHandoffInput;
    assignments: readonly SurgeAssignment[];
    sourcePod: SurgePod;
    targetPod: SurgePod;
    ownedBy: string;
    heldSourceSlugs: string[];
    sourceDrainSlugs: string[];
    schedulerCustodies: SurgeSchedulerCustody[];
  },
): Promise<void> {
  const { input, assignments, sourcePod, targetPod, ownedBy, heldSourceSlugs } = context;
  const [sourceHealth, targetHealth] = await Promise.all([
    deps.readPodHealth(sourcePod, input.gatewayId),
    deps.readPodHealth(targetPod, input.gatewayId),
  ]);
  if (!sourceHealth) {
    throw new Error(`source health unavailable before handoff on ${input.gatewayId}`);
  }
  if (!targetHealth) {
    throw new Error(`target health unavailable before handoff on ${input.gatewayId}`);
  }
  const assignmentBySlug = new Map(assignments.map((assignment) => [assignment.slug, assignment]));
  const configTransferMode = configTransferModeFor(input);
  assertSourceMountedRoster(assignments.filter(row => !row.sharedSurgeForwardRecovery), sourceHealth.mountedCustomers.filter(slug => !assignments.some(row => row.slug === slug && row.sharedSurgeForwardRecovery)), input.gatewayId);
  await waitForSourceAssignments(deps, { ...context, assignments });
  if (targetHealth.mountedCustomers.length > 0) {
    if (configTransferMode === CONFIGURED_USER_SYSTEM_CONFIG) {
      const foreignMount = targetHealth.mountedCustomers.find((slug) => !assignmentBySlug.has(slug));
      if (foreignMount) {
        throw new Error(
          `configured isolated target mounted foreign user ${foreignMount} on ${input.gatewayId}`,
        );
      }
      deps.log(
        `[surge-handoff] preserving configured isolated target mounts before transfer ` +
        `gateway=${input.gatewayId} slugs=${targetHealth.mountedCustomers.join(",")}`,
      );
    } else {
      const staleSlugs = new Set(targetHealth.mountedCustomers.filter(slug => !assignmentBySlug.get(slug)?.sharedSurgeForwardRecovery));
      const staleAssignments = assignments.filter((assignment) => staleSlugs.has(assignment.slug));
      await gateServingAssignments(deps, input.gatewayId, staleAssignments, ownedBy);
      deps.log(
        `[surge-handoff] cleaning stale target mounts before transfer ` +
        `gateway=${input.gatewayId} slugs=${targetHealth.mountedCustomers.join(",")}`,
      );
      await discardTargetUsers(deps, {
        gatewayId: input.gatewayId,
        operationId: ownedBy,
        targetPod,
        slugs: [...staleSlugs],
      });
      await restoreOwnedAssignments(deps, input.gatewayId, staleAssignments, ownedBy);
    }
  }
  await transferAssignments(deps, {
    input,
    assignments,
    sourcePod,
    targetPod,
    ownedBy,
    heldSourceSlugs,
    schedulerCustodies: context.schedulerCustodies,
  });
}

async function resumeHeldSources(
  deps: SurgeUserHandoffDeps,
  input: {
    gatewayId: string;
    operationId: string;
    sourcePod: SurgePod;
    targetPod: SurgePod;
    slugs: readonly string[];
  },
): Promise<void> {
  for (const slug of [...new Set(input.slugs)].reverse()) {
    await resumeSourceOpenClaw(deps, {
      gatewayId: input.gatewayId,
      slug,
      operationId: input.operationId,
      sourcePod: input.sourcePod,
      targetPod: input.targetPod,
    });
  }
}

// Rollback trusts the observed source, not the bookkeeping: a stop that failed
// before reaching the pod (a source without the process endpoints, a lost
// request) leaves the source running, and resuming it would fail again and
// strand the assignments in quiescing.
async function sourceStillHeld(
  deps: SurgeUserHandoffDeps,
  sourcePod: SurgePod,
  gatewayId: string,
): Promise<boolean> {
  const health = await deps.readPodHealth(sourcePod, gatewayId);
  return health === null || health.prelaunchState === "held";
}

async function rollBackConfiguredUserHandoff(
  deps: SurgeUserHandoffDeps,
  context: {
    input: ReconcileSurgeUserHandoffInput;
    sourcePod: SurgePod;
    targetPod: SurgePod;
    ownedBy: string;
    reservedTargetSlugs: readonly string[];
    heldSourceSlugs: readonly string[];
    targetReleaseAttempted: boolean;
    cause: unknown;
  },
): Promise<void> {
  const {
    input,
    sourcePod,
    targetPod,
    ownedBy,
    reservedTargetSlugs,
    heldSourceSlugs,
    targetReleaseAttempted,
    cause,
  } = context;
  const targetReholdErrors: unknown[] = [];
  for (const slug of [...new Set([...reservedTargetSlugs, ...heldSourceSlugs])]) {
    try {
      await holdTargetOpenClaw(deps, {
        gatewayId: input.gatewayId,
        slug,
        operationId: ownedBy,
        targetPod,
      });
    } catch (error) {
      deps.log(
        `[surge-handoff] rollback target hold failed; the target reservation still blocks its start ` +
        `gateway=${input.gatewayId} target=${targetPod.name} slug=${slug}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      if (targetReleaseAttempted) targetReholdErrors.push(error);
    }
  }
  if (targetReholdErrors.length > 0) {
    throw new AggregateError(
      [cause, ...targetReholdErrors],
      "configured isolated target could not be re-held after release attempt: " +
        `handoff=${errorMessage(cause)}; rehold=${targetReholdErrors.map(errorMessage).join("; ")}`,
    );
  }
  if (heldSourceSlugs.length > 0 && await sourceStillHeld(deps, sourcePod, input.gatewayId)) {
    try {
      await resumeHeldSources(deps, {
        gatewayId: input.gatewayId,
        operationId: ownedBy,
        sourcePod,
        targetPod,
        slugs: heldSourceSlugs,
      });
    } catch (resumeError) {
      throw new AggregateError(
        [cause, resumeError],
        "configured user handoff failed and its source could not be resumed: " +
          `handoff=${errorMessage(cause)}; resume=${errorMessage(resumeError)}`,
      );
    }
  } else if (heldSourceSlugs.length > 0) {
    deps.log(
      `[surge-handoff] source is not held; skipping resume during rollback ` +
      `gateway=${input.gatewayId} source=${sourcePod.name}`,
    );
  }
}

async function resumeDrainedSource(
  deps: SurgeUserHandoffDeps,
  context: { gatewayId: string; operationId: string; sourcePod: SurgePod; slugs: readonly string[]; cause: unknown },
): Promise<void> {
  const resumed = await Promise.allSettled([...new Set(context.slugs)].map((slug) => deps.resumeSourceIngress({
    gatewayId: context.gatewayId, operationId: context.operationId, sourcePod: context.sourcePod, slug,
  })));
  const failures = resumed.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError([context.cause, ...failures],
    `surge source admission could not resume: ${failures.map(errorMessage).join("; ")}`);
}

async function assertRestoredSharedSourceReady(
  deps: SurgeUserHandoffDeps,
  context: { input: ReconcileSurgeUserHandoffInput; assignments: readonly SurgeAssignment[]; sourcePod: SurgePod },
): Promise<void> {
  const { input, assignments, sourcePod } = context;
  const physical = await deps.listPods(input.gatewayId);
  const source = physical.pods.find(pod => pod.uid === sourcePod.uid);
  const health = await deps.readPodHealth(sourcePod, input.gatewayId);
  if (!source?.ready || source.terminating || source.crashLooping || health?.status !== "ready" ||
      health.fleetSignatureCapability !== "gateway-scoped" || !health.handoffReleased || health.terminalTarget !== undefined ||
      (health.migratingIn?.length ?? 0) !== 0 || !["none", "serving"].includes(health.prelaunchState) ||
      !targetMountedAssignedUsers(assignments, health.mountedCustomers)) {
    throw new Error("Shared rollback source is not serving its complete mounted roster; admission remains fenced");
  }
}

async function restoreOwnedSharedSource(
  deps: SurgeUserHandoffDeps,
  context: { input: ReconcileSurgeUserHandoffInput; assignments: SurgeAssignment[]; sourcePod: SurgePod; targetPod: SurgePod; ownedBy: string },
): Promise<void> {
  const { input, assignments, sourcePod, targetPod, ownedBy } = context;
  assertAssignmentsAvailable(assignments, ownedBy);
  const owned = assignments.filter(row => row.state === "quiescing" && row.updatedByOperationId === ownedBy);
  const custodies = owned.map(assignment => ({ gatewayId: input.gatewayId, owner: ownedBy, assignment: { ...assignment }, source: sourcePod, target: targetPod }));
  const targetHealth = await deps.readPodHealth(targetPod, input.gatewayId);
  const assigned = new Set(assignments.map(row => row.slug));
  if (!targetHealth || targetHealth.mountedCustomers.some(slug => !assigned.has(slug))) {
    throw new Error("Shared rollback target roster is unavailable or contains an unassigned workspace");
  }
  for (const custody of custodies) await inspectExistingSurgeScheduler(deps, custody);
  for (const custody of custodies) await abortSurgeSchedulerTarget(deps, custody);
  await discardTargetUsers(deps, { gatewayId: input.gatewayId, operationId: ownedBy, targetPod,
    slugs: targetHealth.mountedCustomers.filter(slug => owned.some(row => row.slug === slug)) });
  await resumeDrainedSource(deps, { gatewayId: input.gatewayId, operationId: ownedBy, sourcePod,
    slugs: owned.map(row => row.slug), cause: new Error("interrupted Shared import rollback") });
  await assertRestoredSharedSourceReady(deps, context);
  for (const custody of custodies) await resumeSurgeSchedulerSource(deps, custody);
  for (const custody of custodies) await assertSurgeSchedulerCustody(deps, custody);
  await restoreOwnedAssignments(deps, input.gatewayId, owned, ownedBy);
}

async function sharedSourceNeedsRecovery(
  deps: SurgeUserHandoffDeps,
  context: Parameters<typeof restoreOwnedSharedSource>[1],
): Promise<boolean> {
  if (configuredUserProcessGateRequired(context.input) || context.assignments.some(row => row.sharedSurgeForwardRecovery)) return false;
  const [health, targetHealth] = await Promise.all([
    deps.readPodHealth(context.sourcePod, context.input.gatewayId), deps.readPodHealth(context.targetPod, context.input.gatewayId),
  ]);
  if (!health || !targetHealth) throw new Error(`pod health unavailable before handoff on ${context.input.gatewayId}`);
  const mounted = new Set(health.mountedCustomers);
  if ((context.assignments.some(row => !mounted.has(row.slug)) || targetHealth.mountedCustomers.length > 0) &&
      context.assignments.some(row => row.state === "quiescing" && row.updatedByOperationId === context.ownedBy)) {
    await restoreOwnedSharedSource(deps, context);
    return true;
  }
  assertSourceMountedRoster(context.assignments, health.mountedCustomers, context.input.gatewayId);
  return false;
}

async function restoreFailedSurgeAdmission(
  deps: SurgeUserHandoffDeps,
  context: Parameters<typeof restoreOwnedSharedSource>[1] & { sourceDrainSlugs: string[]; schedulerCustodies: SurgeSchedulerCustody[] },
  cause: unknown,
): Promise<void> {
  const { input, sourcePod, ownedBy, assignments } = context;
  for (const custody of [...context.schedulerCustodies].reverse()) await abortSurgeSchedulerTarget(deps, custody);
  await resumeDrainedSource(deps, { gatewayId: input.gatewayId, operationId: ownedBy, sourcePod,
    slugs: context.sourceDrainSlugs, cause });
  if (!configuredUserProcessGateRequired(input)) await assertRestoredSharedSourceReady(deps, context);
  for (const custody of context.schedulerCustodies) await resumeSurgeSchedulerSource(deps, custody);
  await restoreOwnedAssignments(deps, input.gatewayId, assignments, ownedBy);
}

async function rebindSharedForwardTargets(
  deps: SurgeUserHandoffDeps,
  context: { input: ReconcileSurgeUserHandoffInput; assignments: SurgeAssignment[]; sourcePod: SurgePod; targetPod: SurgePod; ownedBy: string },
): Promise<void> {
  const changed = context.assignments.filter(row => row.sharedSurgeForwardRecovery && row.sharedSurgeForwardRecovery.receivingPodUid !== context.targetPod.uid);
  if (changed.length === 0) return;
  const snapshot = await deps.listPods(context.input.gatewayId);
  if (!physicalPodsProjected(snapshot) || snapshot.pods.length !== 2 ||
      !snapshot.pods.some(p => p.uid === context.sourcePod.uid && p.name === context.sourcePod.name && p.podIP === context.sourcePod.podIP && p.ready && !p.terminating && !p.crashLooping) ||
      !snapshot.pods.some(p => p.uid === context.targetPod.uid && p.name === context.targetPod.name && p.podIP === context.targetPod.podIP && !p.terminating && !p.crashLooping) ||
      changed.some(row => snapshot.observedPodUids.includes(row.sharedSurgeForwardRecovery!.receivingPodUid))) {
    throw new Error("Shared surge replacement target physical custody changed");
  }
  for (const row of changed) {
    const marker = row.sharedSurgeForwardRecovery!;
    if (row.state !== "quiescing" || row.updatedByOperationId !== context.ownedBy || marker.operationId !== context.ownedBy || !row.updatedAt) {
      throw new Error("Shared surge replacement target assignment custody changed");
    }
    await deps.rebindSharedSurgeForwardRecovery({ gatewayId: context.input.gatewayId, uid: row.uid, slug: row.slug, epoch: row.epoch,
      operationId: marker.operationId, targetPodUid: marker.targetPodUid, expectedReceivingPodUid: marker.receivingPodUid,
      receivingPodUid: context.targetPod.uid, expectedUpdatedAt: row.updatedAt });
    row.sharedSurgeForwardRecovery = { ...marker, receivingPodUid: context.targetPod.uid };
  }
}

async function sharedForwardRecoveryPending(deps: SurgeUserHandoffDeps, input: ReconcileSurgeUserHandoffInput): Promise<boolean> {
  return !configuredUserProcessGateRequired(input) &&
    (await deps.readAssignments(input.gatewayId)).some(row => row.sharedSurgeForwardRecovery);
}

async function migrateAssignmentsAndReleaseTarget(
  deps: SurgeUserHandoffDeps,
  context: {
    input: ReconcileSurgeUserHandoffInput;
    assignments: SurgeAssignment[];
    sourcePod: SurgePod;
    targetPod: SurgePod;
    ownedBy: string;
    observedPodUids: readonly string[];
  },
): Promise<void> {
  const { input, assignments, sourcePod, targetPod, ownedBy, observedPodUids } = context;
  await rebindSharedForwardTargets(deps, context);
  if (await sharedSourceNeedsRecovery(deps, context)) return;
  await restoreAbandonedSurgeAssignments(
    deps,
    input.gatewayId,
    assignments,
    ownedBy,
    {
      observedPodUids,
      reclaimableOwners: new Set([operationId(input.gatewayId, sourcePod.uid)]),
      schedulerCustodyRequired: !configuredUserProcessGateRequired(input),
    },
  );
  assertAssignmentsAvailable(assignments, ownedBy);
  const reservedTargetSlugs: string[] = [];
  const heldSourceSlugs: string[] = [];
  const sourceDrainSlugs: string[] = [];
  const schedulerCustodies: SurgeSchedulerCustody[] = [];
  let targetReleaseAttempted = false;
  try {
    await migrateAssignedState(deps, {
      input,
      assignments,
      sourcePod,
      targetPod,
      ownedBy,
      heldSourceSlugs,
      sourceDrainSlugs,
      schedulerCustodies,
    });
    await gateServingAssignments(deps, input.gatewayId, assignments, ownedBy);
    for (const custody of schedulerCustodies) await assertSurgeSchedulerCustody(deps, custody);
    targetReleaseAttempted = true;
    await releaseTargetWithConfirmation(deps, {
      gatewayId: input.gatewayId,
      operationId: ownedBy,
      pod: targetPod,
      retryHeldConfiguredIsolatedTarget: configuredUserProcessGateRequired(input),
    });
  } catch (error) {
    if (await sharedForwardRecoveryPending(deps, input)) throw error;
    if (error instanceof SurgeTargetCleanupError) {
      throw error;
    }
    if (configuredUserProcessGateRequired(input) && targetReleaseAttempted) {
      deps.log(`[surge-handoff] target release failed; retaining source and target custody for forward retry gateway=${input.gatewayId}`);
      throw error;
    }
    if (configuredUserProcessGateRequired(input)) {
      await rollBackConfiguredUserHandoff(deps, {
        input,
        sourcePod,
        targetPod,
        ownedBy,
        reservedTargetSlugs,
        heldSourceSlugs,
        targetReleaseAttempted,
        cause: error,
      });
    }
    if (sourceDrainSlugs.length > 0 && (!targetReleaseAttempted || configuredUserProcessGateRequired(input))) {
      try {
        await restoreFailedSurgeAdmission(deps, { ...context, sourceDrainSlugs, schedulerCustodies }, error);
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError],
          `surge handoff failed and source recovery is unconfirmed: handoff=${errorMessage(error)}; recovery=${errorMessage(recoveryError)}`);
      }
    }
    if (error instanceof MigrationDrainPendingError) {
      deps.log(`[surge-handoff] waiting for user activity to finish gateway=${input.gatewayId}: ${error.message}`);
      return;
    }
    throw error;
  }
}

async function settleReleasedTarget(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  context: {
    source: SurgeSourceSelection;
    target: SurgePod;
    targetHealth: SurgePodHealth;
    ownedBy: string;
    observedPodUids: readonly string[];
  },
): Promise<{ ready: boolean }> {
  const { source, targetHealth, ownedBy, observedPodUids } = context;
  if (source.kind !== "missing") return { ready: false };
  const assignments = await deps.readAssignments(input.gatewayId);
  if (
    input.requiresUserMigration &&
    !targetMountedAssignedUsers(assignments, targetHealth.mountedCustomers)
  ) {
    deps.log(
      `[surge-handoff] target released without its assigned mounted roster ` +
      `gateway=${input.gatewayId} expected=${assignments.map((item) => item.slug).join(",")} ` +
      `observed=${targetHealth.mountedCustomers.join(",")}`,
    );
    return { ready: false };
  }
  if (!configuredUserProcessGateRequired(input)) {
    await restoreAbandonedSurgeAssignments(deps, input.gatewayId, assignments, ownedBy,
      { observedPodUids, schedulerCustodyRequired: true });
    assertAssignmentsAvailable(assignments, ownedBy);
    for (const assignment of assignments) {
      if (assignment.state === "quiescing" && assignment.updatedByOperationId === ownedBy) {
        await activateSurgeScheduler(deps, { gatewayId: input.gatewayId, owner: ownedBy, assignment: { ...assignment }, target: context.target });
      }
    }
  } else {
    await restoreAbandonedSurgeAssignments(deps, input.gatewayId, assignments, ownedBy, { observedPodUids });
  }
  const pending = assignments.filter((assignment) => assignment.state === "quiescing" && assignment.updatedByOperationId === ownedBy);
  await restoreOwnedAssignments(deps, input.gatewayId, assignments, ownedBy, true);
  for (const assignment of pending) {
    const progress = createMigrationProgress({
      log: (message) => deps.log(`${message} migrationId=${ownedBy} user=${assignment.slug}`),
      send: (event) => deps.reportMigrationProgress({
        gatewayId: input.gatewayId,
        targetPod: context.target,
        event: { ...event, migrationId: ownedBy, slug: assignment.slug, source: input.gatewayId },
      }),
      persist: (event) => deps.recordMigrationProgress({
        gatewayId: input.gatewayId,
        uid: assignment.uid,
        event: { ...event, migrationId: ownedBy, slug: assignment.slug, source: input.gatewayId },
      }),
    });
    await progress.report("serving-handoff", "done");
  }
  return { ready: true };
}

async function releaseSourcelessUser(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  context: { target: SurgePod; targetHealth: SurgePodHealth; ownedBy: string; assignments: SurgeAssignment[];
    targetStillAlone: () => Promise<boolean> },
): Promise<void> {
  const { target, targetHealth, ownedBy, assignments, targetStillAlone } = context;
  if (input.supersedingImageTag) {
    await unreserveSourcelessTarget(deps, input, { targetPod: target, targetHealth, ownedBy,
      slugs: assignments.map((assignment) => assignment.slug) });
    return;
  }
  if (targetHealth.terminalTarget || assignments.length !== 1 || assignments[0]!.state !== "serving" ||
      targetHealth.mountedCustomers.some(slug => slug !== assignments[0]!.slug)) return;
  await holdTargetOpenClaw(deps, { gatewayId: input.gatewayId, slug: assignments[0]!.slug,
    operationId: ownedBy, targetPod: target, reserveTarget: true });
  if (!await targetStillAlone()) return;
  const current = await deps.readAssignments(input.gatewayId);
  if (current.length !== 1 || current[0]!.uid !== assignments[0]!.uid ||
      current[0]!.epoch !== assignments[0]!.epoch || current[0]!.state !== "serving") return;
  await releaseTargetWithConfirmation(deps, { gatewayId: input.gatewayId, operationId: ownedBy, pod: target });
}

async function tendSourcelessTarget(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  context: {
    source: SurgeSourceSelection;
    target: SurgePod;
    targetHealth: SurgePodHealth;
    healthByUid: ReadonlyMap<string, SurgePodHealth>;
    observedPodUids: readonly string[];
    ownedBy: string;
    assignments?: SurgeAssignment[];
  },
): Promise<void> {
  const { source, target, targetHealth, healthByUid, ownedBy, assignments, observedPodUids } = context;
  if (source.kind === "missing") {
    if (observedPodUids.length !== 1 || observedPodUids[0] !== target.uid) return;
    const sourceAssignments = assignments ??
      await deps.readAssignments(input.gatewayId, soleTargetLiveRoster(source, target, targetHealth, observedPodUids));
    const targetStillAlone = async () => {
      const snapshot = await deps.listPods(input.gatewayId);
      return physicalPodsProjected(snapshot) && snapshot.pods.length === 1 &&
        snapshot.pods[0]!.uid === target.uid && !snapshot.pods[0]!.terminating;
    };
    if (!await targetStillAlone()) return;
    if (configuredUserProcessGateRequired(input)) {
      await releaseSourcelessUser(deps, input, { target, targetHealth, ownedBy, assignments: sourceAssignments, targetStillAlone });
    } else {
      await releaseSourcelessSharedTarget(deps, input, { targetPod: target, targetHealth, ownedBy, assignments: sourceAssignments });
    }
  } else if (source.kind === "waiting" && configuredUserProcessGateRequired(input)) {
    const sourceAssignments = assignments ?? await deps.readAssignments(input.gatewayId);
    await recoverHeldWaitingSource(deps, input, {
      sourcePod: source.pod,
      sourceHealth: healthByUid.get(source.pod.uid),
      targetPod: target,
      targetHealth,
      ownedBy,
      assignments: sourceAssignments,
    });
  }
}

async function recoverCancelledTargetSource(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  context: SurgePassObservation & { source: SurgeSourceSelection; ownedBy: string },
): Promise<void> {
  if (!configuredUserProcessGateRequired(input) || isolatedPodObservationIncomplete(input, context)) return;
  if (context.source.kind === "ready") {
    await recoverReadyCancelledTargetSource(deps, input, context);
    return;
  }
  if (context.source.kind !== "waiting") return;
  const assignments = await deps.readAssignments(input.gatewayId);
  assertAssignmentsAvailable(assignments, context.ownedBy);
  await tendSourcelessTarget(deps, input, { ...context, assignments });
}

// A held prelaunch target is legitimately NotReady with OpenClaw down, so it
// enters the handoff; every other NotReady target, and a released marker beside
// a normal gate, waits. A Ready target has already been handed off and only
// needs its roster settled.
async function settleOrGateTarget(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  context: {
    target: SurgePod;
    targetHealth: SurgePodHealth;
    source: SurgeSourceSelection;
    ownedBy: string;
    observedPodUids: readonly string[];
  },
): Promise<SurgeUserHandoffResult | null> {
  const { target, targetHealth, source, ownedBy, observedPodUids } = context;
  const heldPrelaunchTarget = configuredUserProcessGateRequired(input) &&
    prelaunchTransferEligible(targetHealth);
  if (targetHealth.status !== "ready" && !heldPrelaunchTarget) {
    deps.log(`[surge-handoff] target is booting; rechecking gateway=${input.gatewayId} target=${target.name}`);
    deps.recheckGatewayLater(input.gatewayId);
    return { ready: false };
  }
  if (target.ready) {
    return settleReleasedTarget(deps, input, { source, target, targetHealth, ownedBy, observedPodUids });
  }
  if (await isolatedPrelaunchReserved(deps, input, source, targetHealth)) {
    return { ready: true, prelaunchHeld: true };
  }
  // A released marker beside a held prelaunch gate is rollback residue: the
  // release landed while the controller rolled the handoff back. The gate owns
  // process start, so the retry simply runs the handoff again.
  return targetHealth.handoffReleased && !heldPrelaunchTarget ? { ready: false } : null;
}

function sourceHoldsItsOpenClaw(
  input: ReconcileSurgeUserHandoffInput,
  source: SurgeSourceSelection,
  healthByUid: ReadonlyMap<string, SurgePodHealth>,
): boolean {
  return configuredUserProcessGateRequired(input) &&
    source.kind !== "missing" &&
    healthByUid.get(source.pod.uid)?.prelaunchState === "held";
}

function hasLegacyFleetSignatureCapability(
  targetHealth: SurgePodHealth,
  sourceHealth: SurgePodHealth | undefined,
): boolean {
  return targetHealth.fleetSignatureCapability === "legacy" ||
    sourceHealth?.fleetSignatureCapability === "legacy";
}

async function isolatedPrelaunchReserved(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  source: SurgeSourceSelection,
  targetHealth: SurgePodHealth,
): Promise<boolean> {
  if (
    input.isolatedGateway !== true ||
    input.requiresUserMigration ||
    input.supersedingImageTag !== undefined ||
    source.kind !== "missing" ||
    targetHealth.status !== "booting" ||
    targetHealth.handoffReleased ||
    targetHealth.prelaunchState !== "held" ||
    targetHealth.mountedCustomers.length !== 0
  ) {
    return false;
  }
  return (await deps.readAssignments(input.gatewayId)).length === 0;
}

// Handing users onto pods a queued rollout is about to replace buys nothing.
// Everything that keeps a user served still runs, because none of it may wait
// on the queue: a gated lease refuses the user at the edge, and a held source
// cannot restart its own OpenClaw.
async function standDownForSupersedingRelease(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  context: {
    source: SurgeSourceSelection;
    target: SurgePod;
    targetHealth: SurgePodHealth;
    healthByUid: ReadonlyMap<string, SurgePodHealth>;
    ownedBy: string;
    observedPodUids: readonly string[];
  },
): Promise<{ ready: boolean }> {
  const { source, target, targetHealth, healthByUid, ownedBy, observedPodUids } = context;
  deps.log(
    `[surge-handoff] standing down for a queued rollout gateway=${input.gatewayId} ` +
    `serving=${input.desiredImageTag} queued=${input.supersedingImageTag}`,
  );
  if (source.kind !== "missing" && !prelaunchTransferEligible(targetHealth)) {
    deps.log(`[surge-handoff] source admission remains closed while superseded target execution is uncertain gateway=${input.gatewayId} target=${target.name}`);
    return { ready: false };
  }
  const assignments = await deps.readAssignments(input.gatewayId, soleTargetLiveRoster(source, target, targetHealth, observedPodUids));
  if (assignments.some(row => row.sharedSurgeForwardRecovery)) return { ready: false };
  if (!configuredUserProcessGateRequired(input)) {
    const servingHealth = source.kind === "missing" ? targetHealth : healthByUid.get(source.pod.uid);
    if (!servingHealth || !targetMountedAssignedUsers(assignments, servingHealth.mountedCustomers)) {
      deps.log(`[surge-handoff] retaining Shared admission during queued rollout without its assigned mounted roster gateway=${input.gatewayId}`);
      return { ready: false };
    }
  }
  if (!configuredUserProcessGateRequired(input) && assignments.some(row => row.state === "quiescing" && row.updatedByOperationId === ownedBy)) {
    if (source.kind !== "ready") return { ready: false };
    await restoreOwnedSharedSource(deps, { input, assignments, sourcePod: source.pod, targetPod: target, ownedBy });
    return { ready: false };
  }
  await restoreAbandonedSurgeAssignments(
    deps,
    input.gatewayId,
    assignments,
    null,
    { observedPodUids, schedulerCustodyRequired: !configuredUserProcessGateRequired(input) },
  );
  await tendSourcelessTarget(deps, input, {
    source,
    target,
    targetHealth,
    healthByUid,
    observedPodUids,
    ownedBy,
    assignments,
  });
  if (!sourceHoldsItsOpenClaw(input, source, healthByUid)) {
    if (source.kind === "ready" && prelaunchTransferEligible(targetHealth)) {
      await resumeDrainedSource(deps, { gatewayId: input.gatewayId, operationId: ownedBy,
        sourcePod: source.pod, slugs: assignments.map(assignment => assignment.slug),
        cause: new Error("surge superseded before target activation") });
    }
    await restoreOwnedAssignments(deps, input.gatewayId, assignments, ownedBy);
  }
  return { ready: false };
}

function physicalPodsProjected(snapshot: SurgePodSnapshot): boolean {
  return snapshot.observedPodUids.length === snapshot.pods.length &&
    new Set(snapshot.observedPodUids).size === snapshot.observedPodUids.length &&
    snapshot.observedPodUids.every(uid => snapshot.pods.some(pod => pod.uid === uid));
}

function isolatedPodObservationIncomplete(input: Pick<ReconcileSurgeUserHandoffInput, "isolatedGateway">, snapshot: SurgePodSnapshot): boolean {
  return configuredUserProcessGateRequired(input) && !physicalPodsProjected(snapshot);
}

function replacementPodMatches(pod: SurgePod | undefined, identity: Pick<SurgePod, "uid" | "name">, ready: boolean): pod is SurgePod {
  return pod !== undefined && [pod.uid === identity.uid, pod.name === identity.name, pod.ready === ready, !pod.terminating].every(Boolean);
}

function replacementSourceServing(health: SurgePodHealth | null): health is SurgePodHealth {
  return health !== null && [health.status === "ready", health.prelaunchState === "serving",
    health.fleetSignatureCapability === "gateway-scoped", (health.migratingIn?.length ?? 0) === 0].every(Boolean);
}

function cancelledTargetHeld(health: SurgePodHealth | null, pod: SurgePod, ownedBy: string): health is SurgePodHealth {
  return health !== null && [health.fleetSignatureCapability === "gateway-scoped", health.prelaunchState === "held",
    !health.handoffReleased, health.terminalTarget?.processHeld === true, terminalTargetAttemptMatches(health, pod, ownedBy),
    health.mountedCustomers.length === 0, (health.migratingIn?.length ?? 0) === 0].every(Boolean);
}

async function recoverReadyCancelledTargetSource(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  context: SurgePassObservation & { source: SurgeSourceSelection; ownedBy: string },
): Promise<void> {
  if (context.source.kind !== "ready") return;
  const sourceIdentity = { ...context.source.pod }, targetIdentity = { ...context.target };
  const observe = async () => {
    const snapshot = await deps.listPods(input.gatewayId);
    if (!physicalPodsProjected(snapshot) || snapshot.pods.length !== 2 || sourceIdentity.uid === targetIdentity.uid) return null;
    const source = snapshot.pods.find(pod => pod.uid === sourceIdentity.uid);
    const target = snapshot.pods.find(pod => pod.uid === targetIdentity.uid);
    if (!replacementPodMatches(source, sourceIdentity, true) || !replacementPodMatches(target, targetIdentity, false)) return null;
    const [sourceHealth, targetHealth] = await Promise.all([
      deps.readPodHealth(source, input.gatewayId), deps.readPodHealth(target, input.gatewayId),
    ]);
    if (!replacementSourceServing(sourceHealth) || !cancelledTargetHeld(targetHealth, target, context.ownedBy) ||
        !gatewayHeartbeatMatchesImageTag(targetHealth.version, input.desiredImageTag)) return null;
    const assignments = await deps.readAssignments(input.gatewayId);
    const owned = assignments.filter(row => row.state === "quiescing" && row.updatedByOperationId === context.ownedBy);
    if (owned.length === 0 || assignments.some(row => row.state !== "serving" && !owned.includes(row)) ||
        !assignments.some(row => row.slug === targetHealth.terminalTarget?.slug) ||
        !targetMountedAssignedUsers(assignments, sourceHealth.mountedCustomers)) return null;
    return { sourcePod: { ...source }, assignments: owned.map(row => ({ ...row })), fingerprint: JSON.stringify({
      source: [source.uid, source.name, source.podIP, source.image, sourceHealth.version],
      target: [target.uid, target.name, target.podIP, target.image, targetHealth.version],
      assignments: assignments.map(({ uid, slug, epoch, state, updatedByOperationId }) =>
        ({ uid, slug, epoch, state, updatedByOperationId })).sort((left, right) => left.uid.localeCompare(right.uid)),
    }) };
  };
  const before = await observe();
  if (!before) return;
  await resumeDrainedSource(deps, { gatewayId: input.gatewayId, operationId: context.ownedBy,
    sourcePod: before.sourcePod, slugs: before.assignments.map(row => row.slug),
    cause: new Error("cancelled target rollback admission recovery") });
  const after = await observe();
  if (!after || after.fingerprint !== before.fingerprint) return;
  await restoreOwnedAssignments(deps, input.gatewayId, after.assignments, context.ownedBy);
}

async function replaceCancelledTarget(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  target: SurgePod,
  source: SurgeSourceSelection,
  ownedBy: string,
): Promise<void> {
  if (!configuredUserProcessGateRequired(input) || source.kind !== "ready") return;
  const sourceIdentity = { uid: source.pod.uid, name: source.pod.name }, targetIdentity = { uid: target.uid, name: target.name };
  const eligible = async (): Promise<{ pod: SurgePod; assignments: string } | null> => {
    const snapshot = await deps.listPods(input.gatewayId);
    if (!physicalPodsProjected(snapshot) || snapshot.pods.length !== 2 || sourceIdentity.uid === targetIdentity.uid) return null;
    const predecessor = snapshot.pods.find(pod => pod.uid === sourceIdentity.uid);
    const cancelled = snapshot.pods.find(pod => pod.uid === targetIdentity.uid);
    if (!replacementPodMatches(predecessor, sourceIdentity, true) || !replacementPodMatches(cancelled, targetIdentity, false)) return null;
    const [sourceHealth, targetHealth] = await Promise.all([
      deps.readPodHealth(predecessor, input.gatewayId), deps.readPodHealth(cancelled, input.gatewayId),
    ]);
    if (!replacementSourceServing(sourceHealth) || !cancelledTargetHeld(targetHealth, cancelled, ownedBy)) return null;
    const assignments = await deps.readAssignments(input.gatewayId);
    if (assignments.length === 0 || assignments.some(assignment => assignment.state !== "serving") ||
        !assignments.some(assignment => assignment.slug === targetHealth.terminalTarget?.slug) ||
        !targetMountedAssignedUsers(assignments, sourceHealth.mountedCustomers)) return null;
    return { pod: cancelled, assignments: JSON.stringify(assignments.map(({ uid, slug, epoch, state, updatedByOperationId }) =>
      ({ uid, slug, epoch, state, updatedByOperationId })).sort((left, right) => left.uid.localeCompare(right.uid))) };
  };
  const before = await eligible();
  if (!before) return;
  const claim = await deps.claimCrashLoopEviction({ gatewayId: input.gatewayId, imageTag: input.desiredImageTag, pod: target });
  if (!claim.allowed) {
    deps.log(`[surge-handoff] cancelled target replacement budget spent gateway=${input.gatewayId} target=${target.name} image=${input.desiredImageTag} budget=${claim.budget}`);
    return;
  }
  const cancelled = await eligible();
  if (!cancelled || cancelled.assignments !== before.assignments) return;
  await deps.deleteCancelledTarget({ gatewayId: input.gatewayId, pod: cancelled.pod });
  deps.log(`[surge-handoff] deleted cancelled held target gateway=${input.gatewayId} target=${cancelled.pod.name} uid=${cancelled.pod.uid} replacement=${claim.count}/${claim.budget}`);
}

async function evictCrashLoopingSurgeTargets(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
  pods: readonly SurgePod[],
  healthByUid: ReadonlyMap<string, SurgePodHealth>,
): Promise<boolean> {
  const predecessorServing = pods.some((pod) =>
    pod.ready && !pod.terminating && healthByUid.has(pod.uid));
  const wedged = pods.filter((pod) =>
    pod.crashLooping && !pod.ready && !pod.terminating && !healthByUid.has(pod.uid));
  if (!predecessorServing || wedged.length === 0) return false;
  let evicted = false;
  for (const pod of wedged) {
    const claim = await deps.claimCrashLoopEviction({ gatewayId: input.gatewayId, imageTag: input.desiredImageTag, pod });
    if (!claim.allowed) {
      deps.log(
        `[surge-handoff] gateway=${input.gatewayId} leaving crash-looping surge target pod=${pod.name} in place: ` +
          `the eviction budget of ${claim.budget} for image ${input.desiredImageTag} is spent; repair the release or delete the pod by hand`,
      );
      continue;
    }
    await deps.deleteCrashLoopingPod({ gatewayId: input.gatewayId, pod });
    deps.log(
      `[surge-handoff] gateway=${input.gatewayId} deleted crash-looping surge target pod=${pod.name} ` +
        `(eviction ${claim.count} of ${claim.budget} for image ${input.desiredImageTag}); ` +
        "its Deployment recreates it with a fresh emptyDir and the handoff restarts from zero",
    );
    evicted = true;
  }
  return evicted;
}

interface SurgePassObservation {
  pods: readonly SurgePod[];
  observedPodUids: readonly string[];
  healthByUid: ReadonlyMap<string, SurgePodHealth>;
  target: SurgePod;
  targetHealth: SurgePodHealth;
}

async function observeSurgePass(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
): Promise<SurgePassObservation | null> {
  const { pods, observedPodUids } = await deps.listPods(input.gatewayId);
  const healthEntries = await Promise.all(pods.map(async (pod) => [
    pod.uid,
    await deps.readPodHealth(pod, input.gatewayId),
  ] as const));
  const healthByUid = new Map(
    healthEntries.filter((entry): entry is readonly [string, SurgePodHealth] => entry[1] !== null),
  );
  if (await evictCrashLoopingSurgeTargets(deps, input, pods, healthByUid)) return null;
  const target = selectTarget(pods, healthByUid, input.desiredImageTag);
  if (!target) {
    const assignments = await deps.readAssignments(input.gatewayId);
    if (!configuredUserProcessGateRequired(input)) {
      const source = pods[0];
      const health = source ? healthByUid.get(source.uid) : undefined;
      if (pods.length !== 1 || !physicalPodsProjected({ pods, observedPodUids }) || !source?.ready || source.terminating ||
          health?.status !== "ready" || !targetMountedAssignedUsers(assignments, health.mountedCustomers)) {
        deps.log(`[surge-handoff] retaining Shared admission without a complete mounted source gateway=${input.gatewayId}`);
        deps.recheckGatewayLater(input.gatewayId);
        return null;
      }
    }
    await restoreAbandonedSurgeAssignments(
      deps,
      input.gatewayId,
      assignments,
      null,
      { observedPodUids, schedulerCustodyRequired: !configuredUserProcessGateRequired(input) },
    );
    return null;
  }
  const targetHealth = healthByUid.get(target.uid);
  return targetHealth ? { pods, observedPodUids, healthByUid, target, targetHealth } : null;
}

export async function reconcileSurgeUserHandoff(
  deps: SurgeUserHandoffDeps,
  input: ReconcileSurgeUserHandoffInput,
): Promise<SurgeUserHandoffResult> {
  const observation = await observeSurgePass(deps, input);
  if (!observation) return { ready: false };
  const { pods, observedPodUids, healthByUid, target, targetHealth } = observation;

  const source = selectSource(pods, target);
  const sourceHealth = source.kind === "missing" ? undefined : healthByUid.get(source.pod.uid);
  if (hasLegacyFleetSignatureCapability(targetHealth, sourceHealth)) return { ready: false };
  const currentAssignments = !configuredUserProcessGateRequired(input) && (source.kind === "ready" || target.ready)
    ? await deps.readAssignments(input.gatewayId) : null;
  const forwardOwners = new Set((currentAssignments ?? []).flatMap(row => row.sharedSurgeForwardRecovery ? [row.sharedSurgeForwardRecovery.operationId] : []));
  if (forwardOwners.size > 1) throw new Error("conflicting Shared surge forward owners");
  const ownedBy = [...forwardOwners][0] ?? operationId(input.gatewayId, target.uid);
  const scoped: SurgeUserHandoffDeps = { ...deps, log: operationScopedLog(deps.log) };
  return withOperationLogScope(ownedBy, async () => {
    const settled = await settleOrGateTarget(scoped, input, {
      target,
      targetHealth,
      source,
      ownedBy,
      observedPodUids,
    });
    // A settled target is a handoff that already finished — the release it proves
    // still marks live, because withholding that would gate the Dashboard behind a
    // queue this gateway is not waiting on.
    if (settled?.ready) return settled;
    if (input.supersedingImageTag && forwardOwners.size === 0) {
      return standDownForSupersedingRelease(scoped, input, {
        source,
        target,
        targetHealth,
        healthByUid,
        ownedBy,
        observedPodUids,
      });
    }
    if (settled) return settled;
    if (terminalTargetAttemptMatches(targetHealth, target, ownedBy)) {
      await recoverCancelledTargetSource(scoped, input, { ...observation, source, ownedBy });
      await replaceCancelledTarget(scoped, input, target, source, ownedBy);
      scoped.log(`[surge-handoff] target attempt is terminal; waiting for a replacement pod gateway=${input.gatewayId} target=${target.name}`);
      return { ready: false };
    }

    if (isolatedPodObservationIncomplete(input, { pods, observedPodUids })) {
      scoped.log(`[surge-handoff] waiting for observed pod identities to settle gateway=${input.gatewayId}`);
      return { ready: false };
    }

    let assignments: SurgeAssignment[] | null = currentAssignments;
    if (input.requiresUserMigration && input.ownerlessOperatorPrewarm === true) {
      assignments = await scoped.readAssignments(input.gatewayId);
      if (assignments.length === 0) {
        await releaseTargetWithConfirmation(scoped, {
          gatewayId: input.gatewayId,
          operationId: ownedBy,
          pod: target,
        });
        return { ready: false };
      }
    }

    const sourcePod = sourceForTransfer(scoped, input, source);
    if (!sourcePod) {
      await tendSourcelessTarget(scoped, input, {
        source,
        target,
        targetHealth,
        healthByUid,
        observedPodUids,
        ownedBy,
        ...(assignments ? { assignments } : {}),
      });
      return { ready: false };
    }

    assignments ??= await scoped.readAssignments(input.gatewayId);
    await migrateAssignmentsAndReleaseTarget(scoped, {
      input,
      assignments,
      sourcePod,
      targetPod: target,
      ownedBy,
      observedPodUids,
    });
    return { ready: false };
  });
}
