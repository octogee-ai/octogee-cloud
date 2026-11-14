import { isDeepStrictEqual } from "node:util";
import { DuplicateRecordError, type PlatformUserRecord, type GatewayAssignment, type GatewayRoot, type PlatformStateRepositories, type Stored } from "@octogee/core/platform-state";
import { userActivationRecoveryTargetMatches, sharedRecoveryTargetCleaned, migrationCancellationDeferred, isolatedTargetBelongsToUser } from "@octogee/core/fleet-state";
import { isolatedRuntimeMutationFenced } from "@octogee/core/gateway-retirement-claim";
import { readSchedulerMigrationIdentity, type UserMigrationV2State } from "@octogee/shared/types/glm";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import type { FleetBrokerAgentAnchorMigration } from "@octogee/shared/types/fleet-broker";
import { readWorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- operation and input fields are checked one by one before use
type StoredFields = { [field: string]: any };

interface AgentAnchorMigrationRequest {
  gatewayId: string;
  slug: string;
  migrationId: unknown;
  podUid?: string;
  expected?: FleetBrokerAgentAnchorMigration;
}

const POD_UID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sharedAgentAnchorMigrationScope(tx: PlatformStateRepositories, request: AgentAnchorMigrationRequest) {
  const { migrationId } = request;
  if (typeof migrationId === "string" && migrationId.startsWith("surge-")) return sharedSurgeAgentAnchorScope(tx, request);
  return sharedCrossGatewayAgentAnchorScope(tx, request);
}

async function sharedCrossGatewayAgentAnchorScope(tx: PlatformStateRepositories, request: AgentAnchorMigrationRequest) {
  const { gatewayId, slug, migrationId, expected } = request;
  if (!validMigrationId(migrationId)) return null;
  const operationId = migrationId.slice(4);
  const operation: StoredFields = (await tx.journal.operations.get(operationId)) ?? {};
  const input = operation.input ?? {};
  if (!migrationOperationCurrent(operation, input, gatewayId, operationId)) return null;
  const sourceGatewayId: string = input.fromGatewayId, targetGatewayId: string = input.toGatewayId, uid: string = input.uid;
  const sourceRequest = gatewayId === sourceGatewayId;
  const [gateway, source, user, assignment, targetAssignment] = await Promise.all([
    tx.gateways.roots.get(targetGatewayId),
    tx.gateways.roots.get(sourceGatewayId),
    tx.users.records.get(uid),
    tx.gateways.assignments.get(sourceGatewayId, uid),
    tx.gateways.assignments.get(targetGatewayId, uid),
  ]);
  const target = projectGatewayDesiredRootForGateway(gateway, targetGatewayId);
  const sourceRoot = projectGatewayDesiredRootForGateway(source, sourceGatewayId);
  if (!sourceRoot || !assignment) return null;
  const { sourceTargetCurrent, isolatedTargetAdmitted } = migrationTargetAuthority({
    operationId, operation, input, user, sourceEpoch: assignment.epoch, targetRoot: gateway, target });
  if (!migrationCustodyCurrent({ sourceRequest, sourceRoot, target, operationId, operation, input, slug, assigned: assignment, sourceTargetCurrent,
    isolatedTargetAdmitted, targetAssigned: targetAssignment !== null, user, migrationId, sourceGatewayId, targetGatewayId })) return null;
  const migration: FleetBrokerAgentAnchorMigration = { migrationId, claimStartedAt: operation.startedAt, sourceGatewayId, sourceEpoch: assignment.epoch };
  if (!migrationAuthorityMatches(migration, expected)) return null;
  return { gatewayId, uid, slug, assignmentEpoch: assignment.epoch, assignmentState: "quiescing" as const, migration };
}

function migrationTargetAuthority({ operationId, operation, input, user, sourceEpoch, targetRoot, target }: {
  operationId: string; operation: StoredFields; input: StoredFields; user: Stored<PlatformUserRecord> | null; sourceEpoch: number;
  targetRoot: unknown; target: ReturnType<typeof projectGatewayDesiredRootForGateway>;
}): { sourceTargetCurrent: boolean; isolatedTargetAdmitted: boolean } {
  const activation = userActivationTarget({ operationId, input, user, sourceEpoch, targetRoot });
  if (activation) return { sourceTargetCurrent: activation.matches, isolatedTargetAdmitted: activation.activating };
  const ownIsolatedTarget = isolatedTargetBelongsToUser(targetRoot, input);
  return {
    sourceTargetCurrent: target?.gatewayClass === "shared" || ownIsolatedTarget || sharedRecoveryTargetCleaned(input, operation.schedulerHandoff),
    isolatedTargetAdmitted: ownIsolatedTarget,
  };
}

function userActivationTarget({ operationId, input, user, sourceEpoch, targetRoot }: {
  operationId: string; input: StoredFields; user: Stored<PlatformUserRecord> | null; sourceEpoch: number; targetRoot: unknown;
}): { matches: boolean; activating: boolean } | null {
  if (input.source !== "builder-activation-lease") return null;
  const activationLease = user?.activationLease ?? undefined;
  const matches = userActivationRecoveryTargetMatches({ operationId, input, openclaw: { activationLease }, sourceEpoch, targetRoot });
  return { matches, activating: matches && activationLease?.status === "activating" };
}

async function sharedSurgeAssignmentForSlug(tx: PlatformStateRepositories, gatewayId: string, slug: string): Promise<Stored<GatewayAssignment> | null> {
  try {
    return await tx.gateways.assignments.findBySlug(gatewayId, slug);
  } catch (error) {
    if (error instanceof DuplicateRecordError) return null;
    throw error;
  }
}

async function sharedSurgeAgentAnchorScope(tx: PlatformStateRepositories, request: AgentAnchorMigrationRequest) {
  const { gatewayId, slug, migrationId, podUid, expected } = request;
  if (typeof migrationId !== "string") return null;
  const prefix = `surge-${gatewayId}-`;
  const logicalTargetPodUid = migrationId.startsWith(prefix) ? migrationId.slice(prefix.length) : "";
  if (!podUid || !POD_UID_SHAPE.test(podUid) || !POD_UID_SHAPE.test(logicalTargetPodUid)) return null;
  const [gateway, assigned] = await Promise.all([
    tx.gateways.roots.get(gatewayId), sharedSurgeAssignmentForSlug(tx, gatewayId, slug),
  ]);
  if (!sharedSurgeGatewayCurrent(gateway, gatewayId) || !assigned) return null;
  const uid = assigned.uid;
  if (!sharedSurgeAssignmentCurrent(assigned, uid, request) ||
      sharedSurgeReceivingPodUid(assigned, migrationId, logicalTargetPodUid) !== podUid) return null;
  const user = await tx.users.records.get(uid);
  if (!sharedSurgeUserCurrent(user, request)) return null;
  const migration: FleetBrokerAgentAnchorMigration = { migrationId, claimStartedAt: assigned.updatedAt, sourceGatewayId: gatewayId, sourceEpoch: assigned.epoch };
  if (!migrationAuthorityMatches(migration, expected)) return null;
  return { gatewayId, uid, slug, assignmentEpoch: assigned.epoch, assignmentState: "quiescing" as const, migration };
}

export async function sharedAssignedSourceSurgeAnchorScope(
  tx: PlatformStateRepositories, request: AgentAnchorMigrationRequest & { uid: string },
) {
  const { gatewayId, slug, migrationId, podUid, uid, expected } = request;
  const prefix = `surge-${gatewayId}-`;
  const targetPodUid = typeof migrationId === "string" && migrationId.startsWith(prefix) ? migrationId.slice(prefix.length) : "";
  if (!podUid || !POD_UID_SHAPE.test(podUid) || !POD_UID_SHAPE.test(targetPodUid) || podUid === targetPodUid || !validDocumentId(uid)) return null;
  const [gateway, assigned, user] = await Promise.all([
    tx.gateways.roots.get(gatewayId), tx.gateways.assignments.get(gatewayId, uid), tx.users.records.get(uid),
  ]);
  if (!sharedSurgeGatewayCurrent(gateway, gatewayId) || !assigned || !sharedSurgeAssignmentCurrent(assigned, uid, request) ||
      !sharedSurgeUserCurrent(user, request) ||
      !sharedSurgeSourcePodCurrent(assigned, migrationId, targetPodUid, podUid)) return null;
  const sourceSurge: FleetBrokerAgentAnchorMigration = { migrationId: migrationId as string, claimStartedAt: assigned.updatedAt, sourceGatewayId: gatewayId, sourceEpoch: assigned.epoch };
  if (!migrationAuthorityMatches(sourceSurge, expected)) return null;
  return { gatewayId, uid, slug, assignmentEpoch: assigned.epoch, assignmentState: "quiescing" as const, sourceSurge };
}

function sharedSurgeReceivingPodUid(assignment: GatewayAssignment, migrationId: unknown, logicalTargetPodUid: string): string | null {
  const marker = assignment.sharedSurgeForwardRecovery;
  if (marker === undefined) return logicalTargetPodUid;
  if (marker?.operationId !== migrationId || marker.targetPodUid !== logicalTargetPodUid ||
      typeof marker.receivingPodUid !== "string" || !POD_UID_SHAPE.test(marker.receivingPodUid)) return null;
  return marker.receivingPodUid;
}

function sharedSurgeSourcePodCurrent(assignment: GatewayAssignment, migrationId: unknown, logicalTargetPodUid: string, podUid: string): boolean {
  const receivingPodUid = sharedSurgeReceivingPodUid(assignment, migrationId, logicalTargetPodUid);
  return receivingPodUid !== null && podUid !== receivingPodUid;
}

function sharedSurgeGatewayCurrent(stored: Stored<GatewayRoot> | null, gatewayId: string): boolean {
  const root = projectGatewayDesiredRootForGateway(stored, gatewayId);
  return [root?.gatewayClass === "shared", ["running", "draining"].includes(root?.desiredStatus ?? ""),
    root?.retirementClaim == null, stored?.runtimeRestartFence == null].every(Boolean);
}

function sharedSurgeAssignmentCurrent(assigned: GatewayAssignment, uid: string, { gatewayId, slug, migrationId }: AgentAnchorMigrationRequest): boolean {
  return [validDocumentId(uid), assigned.uid === uid, assigned.slug === slug, assigned.gatewayId === gatewayId,
    assigned.state === "quiescing", assigned.updatedByOperationId === migrationId,
    Number.isSafeInteger(assigned.epoch), assigned.epoch >= 0, Number.isSafeInteger(assigned.updatedAt), assigned.updatedAt > 0].every(Boolean);
}

function sharedSurgeUserCurrent(user: Stored<PlatformUserRecord> | null, { gatewayId, slug, migrationId }: AgentAnchorMigrationRequest): boolean {
  if (!user) return false;
  const marker = readWorkspaceMigrationMarker({ migration: user.fences.migration });
  return [!isolatedRuntimeMutationFenced(user), user.slug === slug, user.gateway?.gatewayId === gatewayId,
    user.openclaw.status === "complete", marker?.state === "moving", marker?.operationId === migrationId,
    Number.isSafeInteger(marker?.startedAt), (marker?.startedAt ?? 0) > 0].every(Boolean);
}

function migrationOperationCurrent(operation: StoredFields, input: StoredFields, gatewayId: string, operationId: string): boolean {
  return [
    operation.kind === "migrate-user", operation.status === "running",
    operation.cancellationRequestedAt === undefined || migrationCancellationDeferred(operation, operationId),
    operation.cutoverCommittedAt === undefined, Number.isSafeInteger(operation.startedAt), operation.startedAt > 0,
    validDocumentId(input.uid), validDocumentId(input.fromGatewayId), validDocumentId(input.toGatewayId),
    input.fromGatewayId !== input.toGatewayId, gatewayId === input.toGatewayId || gatewayId === input.fromGatewayId,
  ].every(Boolean);
}

function migrationCustodyCurrent({ sourceRequest, sourceRoot, target, operationId, operation, input, slug,
  assigned, sourceTargetCurrent, isolatedTargetAdmitted, targetAssigned, user, migrationId, sourceGatewayId, targetGatewayId }: {
  sourceRequest: boolean;
  sourceRoot: NonNullable<ReturnType<typeof projectGatewayDesiredRootForGateway>>;
  target: ReturnType<typeof projectGatewayDesiredRootForGateway>;
  operationId: string;
  operation: StoredFields;
  input: StoredFields;
  slug: string;
  assigned: GatewayAssignment;
  sourceTargetCurrent: boolean;
  isolatedTargetAdmitted: boolean;
  targetAssigned: boolean;
  user: Stored<PlatformUserRecord> | null;
  migrationId: string;
  sourceGatewayId: string;
  targetGatewayId: string;
}): boolean {
  return [
    sourceRequest
      ? sourceRoot.gatewayClass === "shared" && ["running", "draining"].includes(sourceRoot.desiredStatus) &&
        assigned.updatedByOperationId === operationId && sourceRecoveryIntentCurrent(operationId, operation, input, slug, assigned.epoch) && sourceTargetCurrent
      : (target?.gatewayClass === "shared" || isolatedTargetAdmitted) && target?.desiredStatus === "running" && target.retirementClaim == null,
    sourceRoot.retirementClaim == null, !targetAssigned, userMigrationCustodyCurrent(user, { slug, sourceGatewayId, operationId }),
    assigned.uid === input.uid, assigned.slug === slug, assigned.gatewayId === sourceGatewayId, assigned.state === "quiescing",
    Number.isSafeInteger(assigned.epoch), assigned.epoch >= 0,
    cancelledImportCustodyCurrent(operation, slug, assigned.epoch),
    migrationV2ImportCurrent(operation.userMigrationV2, { operationId, migrationId, uid: input.uid, slug, sourceGatewayId, targetGatewayId, sourceEpoch: assigned.epoch }),
  ].every(Boolean);
}

function userMigrationCustodyCurrent(
  user: Stored<PlatformUserRecord> | null, { slug, sourceGatewayId, operationId }: { slug: string; sourceGatewayId: string; operationId: string },
): boolean {
  if (user === null || isolatedRuntimeMutationFenced(user)) return false;
  return user.slug === slug && user.gateway?.gatewayId === sourceGatewayId && user.fences.migration?.operationId === operationId;
}

function cancelledImportCustodyCurrent(operation: StoredFields, slug: string, sourceEpoch: unknown): boolean {
  if (operation.cancellationRequestedAt === undefined || operation.userMigrationV2 !== undefined) return true;
  const handoff = operation.schedulerHandoff;
  return handoff?.slug === slug && handoff.forwardRecovery?.sourceEpoch === sourceEpoch;
}

function sourceRecoveryIntentCurrent(operationId: string, operation: Record<string, unknown>, input: Record<string, unknown>, slug: string, sourceEpoch: unknown): boolean {
  if (operation.schedulerHandoffReleased === true || input.userSlug !== undefined && input.userSlug !== slug) return false;
  if (input.recoverSourceOnly !== true) return true;
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const handoff = record(operation.schedulerHandoff), recovery = record(handoff.sourceRecovery);
  return [handoff.uid === input.uid, handoff.slug === slug, handoff.fromGatewayId === input.fromGatewayId,
    handoff.toGatewayId === input.toGatewayId, readSchedulerMigrationIdentity(operationId, handoff.migrationId) !== null,
    recovery.migrationId === handoff.migrationId, recovery.sourceEpoch === sourceEpoch, Array.isArray(recovery.steps)].every(Boolean);
}

function validDocumentId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("/");
}

function validMigrationId(value: unknown): value is string {
  return typeof value === "string" && /^mig-[a-zA-Z0-9_-]+$/.test(value);
}

function migrationAuthorityMatches(current: FleetBrokerAgentAnchorMigration, expected?: FleetBrokerAgentAnchorMigration): boolean {
  return expected === undefined || isDeepStrictEqual(current, expected);
}

function migrationV2ImportCurrent(
  state: UserMigrationV2State | undefined,
  expected: Pick<UserMigrationV2State, "operationId" | "migrationId" | "uid" | "slug" | "sourceGatewayId" | "targetGatewayId" | "sourceEpoch">,
): boolean {
  if (state === undefined) return true;
  return [state.phase === "sourceQuiesced", state.cutoverAt === undefined,
    state.operationId === expected.operationId, state.migrationId === expected.migrationId,
    state.uid === expected.uid, state.slug === expected.slug, state.sourceGatewayId === expected.sourceGatewayId,
    state.targetGatewayId === expected.targetGatewayId, state.sourceEpoch === expected.sourceEpoch,
    state.sourceAssignmentMode === "assigned",
  ].every(Boolean);
}
