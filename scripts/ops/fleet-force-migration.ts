import { isDeepStrictEqual } from "node:util";
import {
  assertGatewayRuntimeMutationUnfencedInStore,
  isolatedRuntimeMutationFenced,
} from "@octogee/core/gateway-retirement-claim";
import { findActiveGatewayMigration } from "@octogee/core/fleet-operation-lock";
import type {
  PlatformUserRecord,
  GatewayAssignment,
  PlatformStateStore,
  PlatformStateTransaction,
  Stored,
} from "@octogee/core/platform-state";

export interface ForceMigrationTarget {
  operationId: string;
  uid: string;
  slug: string;
  fromGatewayId: string;
  toGatewayId: string;
}

export interface ForceMigrationPlan extends ForceMigrationTarget {
  sourceEpoch: number;
  sourceRelease: number;
  targetRelease: number;
  attempts: number;
  lastProgressAt: number;
}

export interface OwnedMigrationRestart {
  fence: Record<string, unknown>;
  request: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertForceMigrationSource(source: Record<string, unknown>, target: ForceMigrationTarget): void {
  if (source.gatewayClass !== "isolated") {
    throw new Error("forced migration recovery requires a dedicated isolated gateway; Shared sources cannot be restarted");
  }
  if (source.ownerUid !== target.uid || source.builderSlug !== target.slug) {
    throw new Error("forced migration user source ownership changed");
  }
  if (source.runtime !== undefined && source.runtime !== "cluster") {
    throw new Error("forced migration currently supports Kubernetes isolated gateways only; GCE VM transport is not available");
  }
}

export async function readForceMigrationSource(store: PlatformStateStore, target: ForceMigrationTarget): Promise<void> {
  assertForceMigrationSource(record(await store.gateways.roots.get(target.fromGatewayId)), target);
}

function drainBlocked(op: Record<string, unknown>): boolean {
  const history = Array.isArray(op.attemptHistory) ? op.attemptHistory : [];
  const last = record(history.at(-1));
  const waiting = op.waitingOn === "builder-idle";
  const steps = waiting ? op.steps : last.steps;
  if (!Array.isArray(steps) || (!waiting && last.attempt !== op.attempts)) return false;
  const rows = steps.map(record);
  const drain = (step: Record<string, unknown>) => step.name === "quiesce-source" || step.name === "wait-for-active-work";
  if (!rows.some((step) => drain(step) && step.status === (waiting ? "skipped" : "failed"))) return false;
  if (rows.some((step) => step.status === "running" || step.status === "failed" && !drain(step))) return false;
  if (rows.some((step) => ["flush-source", "final-sync-state", "verify-target", "cutover-firestore", "unmount-source"].includes(String(step.name)))) return false;
  return waiting || !rows.some((step) => step.name === "pre-sync-state" && step.status === "done") ||
    rows.some((step) => step.name === "rollback:unmount-target" && step.status === "done");
}

async function assertSourceUsersUnfenced(tx: PlatformStateTransaction, gatewayId: string): Promise<void> {
  const holders = await tx.users.records.listGatewayFenceHolders(gatewayId);
  if (holders.sourceTransferSource.length > 0 || holders.sourceTransferTarget.length > 0 ||
    holders.assigned.some(isolatedRuntimeMutationFenced)) {
    throw new Error("force migration source users retain custody fences");
  }
}

async function assertNoCompetingCustody(tx: PlatformStateTransaction, target: ForceMigrationTarget, owned?: OwnedMigrationRestart): Promise<void> {
  const operations = (await tx.journal.operations.listByStatus(["running"])).map((operation) => ({
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    input: operation.input,
    userMigrationV2: operation.userMigrationV2,
  }));
  if ([target.fromGatewayId, target.toGatewayId].some((id) => findActiveGatewayMigration(id, operations)) ||
    operations.some((op) => op.kind === "migrate-user" && record(op.input).uid === target.uid)) {
    throw new Error("force migration is blocked by another running migration");
  }
  if (owned) await assertSourceUsersUnfenced(tx, target.fromGatewayId);
  else await assertGatewayRuntimeMutationUnfencedInStore(tx, target.fromGatewayId);
  await assertGatewayRuntimeMutationUnfencedInStore(tx, target.toGatewayId);
}

function assertPendingDrain(op: Record<string, unknown>, target: ForceMigrationTarget, owned?: OwnedMigrationRestart): void {
  const input = record(op.input);
  if (op.kind !== "migrate-user" || op.status !== "pending" || op.startedAt !== null || op.completedAt !== null ||
    input.uid !== target.uid || input.fromGatewayId !== target.fromGatewayId || input.toGatewayId !== target.toGatewayId) {
    throw new Error("force migration requires the exact pending unclaimed operation");
  }
  if (!owned && op.forceDrainRequest !== undefined) throw new Error("force migration was already requested for this operation");
  if (!drainBlocked(op)) throw new Error("force migration requires a settled attempt blocked by source drain");
}

function assertNoAcceptedCustody(op: Record<string, unknown>): void {
  const v2 = record(op.userMigrationV2);
  if (["cutoverCommittedAt", "restoreAttempt", "sourceTransferExecution", "cancellationRequestedAt"].some((key) => op[key] !== undefined) ||
    op.userMigrationV2 !== undefined && !["initialized", "keysSynced", "preSynced"].includes(String(v2.phase))) {
    throw new Error("force migration cannot replace accepted custody or cutover");
  }
}

function assertSourceAssignment(user: Stored<PlatformUserRecord> | null, assignment: Stored<GatewayAssignment> | null,
  targetAssignment: Stored<GatewayAssignment> | null, target: ForceMigrationTarget,
): { user: Stored<PlatformUserRecord>; assignment: Stored<GatewayAssignment> } {
  const migration = user?.fences.migration;
  if (user === null || user.slug !== target.slug || user.gateway?.gatewayId !== target.fromGatewayId ||
    migration?.operationId !== target.operationId || migration.phase !== "waiting" ||
    assignment === null || assignment.uid !== target.uid || assignment.slug !== target.slug || assignment.gatewayId !== target.fromGatewayId ||
    assignment.state !== "serving" || assignment.updatedByOperationId !== target.operationId ||
    !Number.isSafeInteger(assignment.epoch) || assignment.epoch < 1 || targetAssignment !== null) {
    throw new Error("force migration source assignment or migration owner changed");
  }
  return { user, assignment };
}

function assertConvergedRoots(user: Stored<PlatformUserRecord>, source: Record<string, unknown>, destination: Record<string, unknown>, owned?: OwnedMigrationRestart): void {
  if (isolatedRuntimeMutationFenced(user) || (!owned && source.runtimeRestartFence !== undefined) ||
    destination.runtimeRestartFence !== undefined || [source, destination].some((root) => root.retirementClaim != null)) {
    throw new Error("force migration is blocked by a live custody fence");
  }
  if (!["running", "draining"].includes(String(source.desiredStatus)) || destination.desiredStatus !== "running" ||
    [source, destination].some((root) => !Number.isSafeInteger(root.desiredRelease) || Number(root.desiredRelease) < 1 || root.desiredRelease !== root.liveRelease)) {
    throw new Error("force migration requires converged source and target releases");
  }
}

function assertOwnedRestart(owned: OwnedMigrationRestart, op: Record<string, unknown>, source: Record<string, unknown>,
  target: ForceMigrationTarget, sourceEpoch: unknown): void {
  const { fence, request } = owned;
  const matches = [
    isDeepStrictEqual(op.forceDrainRequest, request), isDeepStrictEqual(source.runtimeRestartFence, fence),
    typeof request.auditId === "string" && request.auditId.length > 0, request.auditId === fence.auditId,
    fence.gatewayId === target.fromGatewayId, request.uid === target.uid,
    request.sourceGatewayId === target.fromGatewayId, request.targetGatewayId === target.toGatewayId,
    request.sourceEpoch === sourceEpoch,
  ].every(Boolean);
  if (!matches) throw new Error("force migration restart authority changed");
}

export async function readForceMigrationPlanInTransaction(tx: PlatformStateTransaction, target: ForceMigrationTarget, owned?: OwnedMigrationRestart): Promise<ForceMigrationPlan> {
  for (const value of Object.values(target)) {
    if (!value || value.includes("/")) throw new Error("force migration requires exact non-empty identifiers");
  }
  if (target.fromGatewayId === target.toGatewayId) throw new Error("force migration requires different gateways");
  const [operation, storedUser, storedAssignment, targetAssignment, sourceRoot, targetRoot] = await Promise.all([
    tx.journal.operations.get(target.operationId), tx.users.records.get(target.uid),
    tx.gateways.assignments.get(target.fromGatewayId, target.uid),
    tx.gateways.assignments.get(target.toGatewayId, target.uid),
    tx.gateways.roots.get(target.fromGatewayId), tx.gateways.roots.get(target.toGatewayId),
  ]);
  const op = record(operation);
  const source = record(sourceRoot);
  const destination = record(targetRoot);
  assertForceMigrationSource(source, target);
  if (owned) assertOwnedRestart(owned, op, source, target, storedAssignment?.epoch);
  assertPendingDrain(op, target, owned);
  assertNoAcceptedCustody(op);
  const { user, assignment } = assertSourceAssignment(storedUser, storedAssignment, targetAssignment, target);
  assertConvergedRoots(user, source, destination, owned);
  if (!Number.isSafeInteger(op.attempts ?? 0) || Number(op.attempts ?? 0) < 0 || typeof op.lastProgressAt !== "number" || !Number.isFinite(op.lastProgressAt)) {
    throw new Error("force migration has invalid attempt identity");
  }
  await assertNoCompetingCustody(tx, target, owned);
  return { ...target, sourceEpoch: assignment.epoch, sourceRelease: Number(source.liveRelease),
    targetRelease: Number(destination.liveRelease), attempts: Number(op.attempts ?? 0), lastProgressAt: op.lastProgressAt };
}

export function readForceMigrationPlan(store: PlatformStateStore, target: ForceMigrationTarget, owned?: OwnedMigrationRestart): Promise<ForceMigrationPlan> {
  return store.transaction({ label: "fleet-force-migration.plan", readOnly: true }, (tx) =>
    readForceMigrationPlanInTransaction(tx, target, owned));
}
