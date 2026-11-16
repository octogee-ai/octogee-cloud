import { isDeepStrictEqual } from "node:util";
import type { OperationStep } from "@octogee/shared/types/glm";
import { readWorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";
import { MigrationRpcError } from "./fleet-migration-client.js";
import { markAssignmentStateInTransaction } from "./fleet-state.js";
import { PlacementPreconditionFailed, type PlacementRefusalReason } from "./placement-refusal.js";
import type {
  GatewayAssignment,
  OperationRecord,
  PlatformStateStore,
  PlatformStateTransaction,
  PlatformUserRecord,
  Stored,
} from "./platform-state/index.js";

const MIGRATE_USER_KIND = "migrate-user";
const SOURCE_HELD_STEP = "quiesce-source";
const TARGET_UNMOUNTED_STEP = "rollback:unmount-target";
const INGRESS_RESUMED_STEP = "rollback:resume-ingress";
const ROLLBACK_STEP_PREFIX = "rollback:";
const FAILURES_ROLLED_BACK_BEFORE_CUTOVER: ReadonlySet<string> = new Set([
  SOURCE_HELD_STEP,
  "flush-source",
  "final-sync-state",
  "verify-target",
]);

const NOT_STRANDED: PlacementRefusalReason = "source-not-stranded";
const IN_FLIGHT: PlacementRefusalReason = "migration-in-flight";
const NOT_PROVEN: PlacementRefusalReason = "rollback-not-proven";
const STATE_CHANGED: PlacementRefusalReason = "fleet-state-changed";

export interface StrandedSource {
  uid: string;
  slug: string;
  gatewayId: string;
  epoch: number;
  assignmentUpdatedAt: number;
  operationId: string;
  targetGatewayId: string;
}

export interface StrandedSourceRestored {
  uid: string;
  slug: string;
  gatewayId: string;
  operationId: string;
  targetGatewayId: string;
  state: "serving";
}

export type ResumeSourceIngress = (input: { operationId: string; gatewayId: string; slug: string }) => Promise<void>;

export interface StrandedSourceRestoreDeps {
  store: PlatformStateStore;
  resumeSourceIngress: ResumeSourceIngress;
  log: (message: string) => void;
  now?: () => Date;
}

export class StrandedSourceResumeFailed extends Error {
  readonly gatewayId: string;
  readonly operationId: string;
  readonly gatewayAnswered: boolean;

  constructor(source: StrandedSource, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`source ingress on ${source.gatewayId} not resumed for ${source.slug}: ${reason}`, { cause });
    this.name = "StrandedSourceResumeFailed";
    this.gatewayId = source.gatewayId;
    this.operationId = source.operationId;
    this.gatewayAnswered = cause instanceof MigrationRpcError;
  }
}

type Refusal = [reasonCode: PlacementRefusalReason, message: string];
type Check = [refused: boolean, reasonCode: PlacementRefusalReason, message: string];

function firstRefusal(checks: readonly Check[]): Refusal | null {
  const refused = checks.find(([failed]) => failed);
  return refused ? [refused[1], refused[2]] : null;
}

function refuse([reasonCode, message]: Refusal): never {
  throw new PlacementPreconditionFailed(reasonCode, message);
}

function rollbackLeftSourceClosed(steps: readonly OperationStep[]): boolean {
  if (steps.length < 3) return false;
  const [failed, unmount, resume] = steps.slice(-3);
  const completed = steps.slice(0, -3);
  return [
    unmount.name === TARGET_UNMOUNTED_STEP && unmount.status === "done",
    resume.name === INGRESS_RESUMED_STEP && (resume.status === "failed" || resume.status === "done"),
    failed.status === "failed" && FAILURES_ROLLED_BACK_BEFORE_CUTOVER.has(failed.name),
    completed.every((step) => step.status === "done" && !step.name.startsWith(ROLLBACK_STEP_PREFIX)),
    steps.filter((step) => step.name === SOURCE_HELD_STEP).length === 1,
    new Set(steps.map((step) => step.name)).size === steps.length,
  ].every(Boolean);
}

function userRefusal(user: Stored<PlatformUserRecord>, stranded: Stored<GatewayAssignment>, others: readonly Stored<GatewayAssignment>[]): Refusal | null {
  const { uid } = user;
  const marker = readWorkspaceMigrationMarker({ migration: user.fences.migration });
  const fenceOwner = marker?.operationId ?? "no operation";
  return firstRefusal([
    [user.fences.restoreFence !== undefined, STATE_CHANGED, `user ${uid} restore outcome is unresolved`],
    [user.fences.sourceTransferFence !== undefined, STATE_CHANGED, `user ${uid} source transfer outcome is unresolved`],
    [user.gateway?.gatewayId !== stranded.gatewayId, STATE_CHANGED,
      `user ${uid} is assigned to ${user.gateway?.gatewayId ?? "no gateway"}, not to ${stranded.gatewayId} where its assignment is quiescing`],
    [others.length > 0, STATE_CHANGED, `user ${uid} also holds an assignment on ${others.map((other) => other.gatewayId).join(", ")}`],
    [user.slug !== stranded.slug, STATE_CHANGED, `user ${uid} is ${user.slug ?? "unnamed"}, but its assignment on ${stranded.gatewayId} is for ${stranded.slug}`],
    [user.fences.migration !== undefined && marker?.operationId !== stranded.updatedByOperationId, STATE_CHANGED,
      `user ${uid} migration fence names ${fenceOwner}, not ${stranded.updatedByOperationId}`],
  ]);
}

type MoveInput = Record<"uid" | "userSlug" | "fromGatewayId" | "toGatewayId" | "recoverSourceOnly", unknown>;

function moveInput(operation: Stored<OperationRecord>): MoveInput {
  const { uid, userSlug, fromGatewayId, toGatewayId, recoverSourceOnly } = operation.input as Record<string, unknown>;
  return { uid, userSlug, fromGatewayId, toGatewayId, recoverSourceOnly };
}

function movesUserOutOf(operation: Stored<OperationRecord>, stranded: Stored<GatewayAssignment>): boolean {
  const input = moveInput(operation);
  return [
    operation.kind === MIGRATE_USER_KIND,
    input.uid === stranded.uid,
    input.userSlug === undefined || input.userSlug === stranded.slug,
    input.fromGatewayId === stranded.gatewayId,
    typeof input.toGatewayId === "string" && input.toGatewayId !== "" && input.toGatewayId !== stranded.gatewayId,
  ].every(Boolean);
}

function ownerRefusal(operation: Stored<OperationRecord> | null, stranded: Stored<GatewayAssignment>): Refusal | null {
  const operationId = stranded.updatedByOperationId;
  if (operation === null) return [NOT_PROVEN, `operation ${operationId} that closed ${stranded.gatewayId} is not in the journal`];
  return firstRefusal([
    [!movesUserOutOf(operation, stranded), NOT_STRANDED, `operation ${operationId} is not a user move of ${stranded.uid} out of ${stranded.gatewayId}`],
    [operation.status === "pending" || operation.status === "running", IN_FLIGHT, `operation ${operationId} is ${operation.status}`],
    [operation.status !== "failed", NOT_PROVEN, `operation ${operationId} is ${operation.status}, not failed`],
  ]);
}

function forwardStateRefusal(operation: Stored<OperationRecord>, stranded: Stored<GatewayAssignment>): Refusal | null {
  const { id } = operation;
  return firstRefusal([
    [operation.cutoverCommittedAt !== undefined, NOT_PROVEN, `operation ${id} committed its cutover`],
    [operation.userMigrationV2 !== undefined, NOT_PROVEN, `operation ${id} holds forward migration state`],
    [operation.schedulerHandoff?.forwardRecovery !== undefined, NOT_PROVEN, `operation ${id} holds a forward recovery checkpoint`],
    [operation.sourceTransferExecution !== undefined, NOT_PROVEN, `operation ${id} holds a source transfer`],
    [operation.cancellationRequestedAt !== undefined, NOT_PROVEN, `operation ${id} has a cancellation pending`],
    [moveInput(operation).recoverSourceOnly === true, NOT_PROVEN, `operation ${id} is a source-only recovery`],
    [stranded.sharedSurgeForwardRecovery !== undefined, NOT_PROVEN,
      `the assignment of ${stranded.uid} on ${stranded.gatewayId} carries a forward recovery marker`],
    [!Array.isArray(operation.steps) || !rollbackLeftSourceClosed(operation.steps), NOT_PROVEN,
      `the recorded steps of operation ${id} do not show its target unmounted and its source ingress left to resume`],
  ]);
}

function inFlightRefusal(active: readonly Stored<OperationRecord>[], stranded: Stored<GatewayAssignment>): Refusal | null {
  const blocking = active.find((operation) => {
    const input = operation.input as Record<string, unknown>;
    return operation.inputUid === stranded.uid || input.uid === stranded.uid || input.gatewayId === stranded.gatewayId;
  });
  return blocking ? [IN_FLIGHT, `${blocking.kind} operation ${blocking.id} is ${blocking.status}`] : null;
}

function quiescingAssignment(uid: string, assignments: readonly Stored<GatewayAssignment>[]): Stored<GatewayAssignment> {
  const quiescing = assignments.filter((assignment) => assignment.state === "quiescing");
  if (quiescing.length === 0) refuse([NOT_STRANDED, `user ${uid} has no quiescing assignment; nothing to restore`]);
  if (quiescing.length > 1) {
    refuse([STATE_CHANGED, `user ${uid} is quiescing on ${quiescing.map((assignment) => assignment.gatewayId).join(", ")}`]);
  }
  const [stranded] = quiescing;
  if (!stranded.updatedByOperationId) {
    refuse([NOT_STRANDED, `the quiescing assignment of ${uid} on ${stranded.gatewayId} names no operation`]);
  }
  return stranded;
}

export async function strandedSourceInTransaction(tx: PlatformStateTransaction, uid: string): Promise<StrandedSource> {
  const [user, assignments] = await Promise.all([
    tx.users.records.get(uid),
    tx.gateways.assignments.listForUid(uid),
  ]);
  if (user === null) refuse(["user-missing", `user ${uid} does not exist`]);
  const stranded = quiescingAssignment(uid, assignments);
  const operationId = stranded.updatedByOperationId as string;
  const [operation, active] = await Promise.all([
    tx.journal.operations.get(operationId),
    tx.journal.operations.listByStatus(["pending", "running"]),
  ]);
  const refusal = ownerRefusal(operation, stranded)
    ?? forwardStateRefusal(operation as Stored<OperationRecord>, stranded)
    ?? userRefusal(user, stranded, assignments.filter((assignment) => assignment !== stranded))
    ?? inFlightRefusal(active.filter((candidate) => candidate.id !== operationId), stranded);
  if (refusal !== null) refuse(refusal);
  return {
    uid,
    slug: stranded.slug,
    gatewayId: stranded.gatewayId,
    epoch: stranded.epoch,
    assignmentUpdatedAt: stranded.updatedAt,
    operationId,
    targetGatewayId: moveInput(operation as Stored<OperationRecord>).toGatewayId as string,
  };
}

export function readStrandedSource(store: PlatformStateStore, uid: string): Promise<StrandedSource> {
  return store.transaction({ label: "stranded-source.read", readOnly: true }, (tx) => strandedSourceInTransaction(tx, uid));
}

async function markSourceServing(deps: StrandedSourceRestoreDeps, source: StrandedSource): Promise<void> {
  const now = deps.now ? deps.now().getTime() : Date.now();
  await deps.store.transaction({ label: "stranded-source.restore-serving" }, async (tx) => {
    const current = await strandedSourceInTransaction(tx, source.uid);
    if (!isDeepStrictEqual(current, source)) {
      refuse([STATE_CHANGED, `the quiescing assignment of ${source.uid} on ${source.gatewayId} changed while its ingress resumed`]);
    }
    await markAssignmentStateInTransaction(tx, {
      gatewayId: source.gatewayId,
      uid: source.uid,
      slug: source.slug,
      epoch: source.epoch,
      state: "serving",
      updatedByOperationId: source.operationId,
      expected: { state: "quiescing", updatedByOperationId: source.operationId, updatedAt: source.assignmentUpdatedAt },
    }, now);
  });
}

export async function restoreStrandedSourceServing(
  deps: StrandedSourceRestoreDeps,
  input: { uid: string },
): Promise<StrandedSourceRestored> {
  const source = await readStrandedSource(deps.store, input.uid);
  const { uid, slug, gatewayId, operationId, targetGatewayId } = source;
  try {
    await deps.resumeSourceIngress({ operationId, gatewayId, slug });
  } catch (cause) {
    const failure = new StrandedSourceResumeFailed(source, cause);
    deps.log(`[stranded-source] ❌ ${failure.message}; uid=${uid} stays quiescing under operation ${operationId}`);
    throw failure;
  }
  try {
    await markSourceServing(deps, source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log(`[stranded-source] ❌ source ingress on ${gatewayId} resumed but the assignment was not restored for uid=${uid} slug=${slug}: ${reason}`);
    throw error;
  }
  deps.log(`[stranded-source] restored serving for uid=${uid} slug=${slug} on ${gatewayId} after operation ${operationId} left it quiescing`);
  return { uid, slug, gatewayId, operationId, targetGatewayId, state: "serving" };
}
