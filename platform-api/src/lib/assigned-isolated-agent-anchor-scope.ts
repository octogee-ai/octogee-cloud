import { isolatedRuntimeMutationFenced } from "@octogee/core/gateway-retirement-claim";
import { configuredUserCredentialBootstrapAllowed } from "@octogee/core/gateway-live-release";
import type { FleetRegistryRecord, GatewayAssignment, GatewayRoot, PlatformStateRepositories, PlatformUserRecord, Stored } from "@octogee/core/platform-state";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import type { GatewayKubernetesObservation } from "@octogee/shared/types/gateway-releases";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";

interface PodIdentity {
  gatewayId: string;
  podName?: string | undefined;
  podUid?: string | undefined;
}

interface AssignedAnchorRequest extends PodIdentity {
  slug: string;
  boundOwnerUid?: string | undefined;
  requestedUid?: unknown;
  requestedEpoch?: unknown;
  sourceMigrationId?: string | undefined;
}

interface SourceMigrationClaim {
  operationId: string;
  claimStartedAt: number;
  targetGatewayId: string;
  release: number;
}

export interface AssignedIsolatedAgentAnchorScope {
  gatewayId: string;
  podName: string;
  podUid: string;
  slug: string;
  uid: string;
  ownerAssignmentEpoch: number;
  sourceMigration?: SourceMigrationClaim;
}

function freshSinglePodObservation(observation: GatewayKubernetesObservation, now: number): boolean {
  return Number.isFinite(observation.observedAt) && observation.observedAt <= now &&
    now - observation.observedAt <= GATEWAY_UNREACHABLE_AFTER_MS &&
    (observation.status === "not-ready" || observation.status === "ready") &&
    observation.totalPods === 1 && observation.pods?.length === 1;
}

function observedOwnerPod(
  runtime: FleetRegistryRecord | null,
  requestedRelease: number,
  pod: PodIdentity,
  now: number,
): boolean {
  const observation = runtime?.kubernetes;
  if (runtime?.gatewayId !== pod.gatewayId || runtime.runtime !== "cluster" || runtime.release !== requestedRelease ||
      (runtime.lifecycle !== "provisioning" && runtime.lifecycle !== "serving") ||
      !observation || !freshSinglePodObservation(observation, now)) return false;
  const observed = observation.pods?.[0];
  return observed?.uid === pod.podUid && observed?.name === pod.podName;
}

function configuredAnchorOwner(root: GatewayRoot | null, input: AssignedAnchorRequest): string | null {
  const uid = root?.ownerUid;
  if (!root || !uid || root.gatewayClass !== "isolated" || root.allocation != null ||
      (input.boundOwnerUid !== undefined && input.boundOwnerUid !== uid) ||
      (input.requestedUid !== undefined && input.requestedUid !== uid) ||
      !configuredUserCredentialBootstrapAllowed(root, { ...input, podName: input.podName, uid })) return null;
  return uid;
}

function ownerHasInteractiveAccess(user: Stored<PlatformUserRecord> | null, input: AssignedAnchorRequest): user is Stored<PlatformUserRecord> {
  return user !== null && user.slug === input.slug && user.gateway?.gatewayId === input.gatewayId &&
    !isolatedRuntimeMutationFenced(user) &&
    accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle });
}

function currentAnchorAssignmentEpoch(
  assignment: GatewayAssignment | null,
  input: AssignedAnchorRequest,
  uid: string,
): number | null {
  if (!assignment || assignment.uid !== uid || assignment.slug !== input.slug || assignment.gatewayId !== input.gatewayId ||
      assignment.state !== (input.sourceMigrationId === undefined ? "serving" : "quiescing") ||
      !Number.isSafeInteger(assignment.epoch) || assignment.epoch < 0 ||
      (input.requestedEpoch !== undefined && input.requestedEpoch !== assignment.epoch)) return null;
  return assignment.epoch;
}

function activeSourceClaim(
  operation: Awaited<ReturnType<PlatformStateRepositories["journal"]["operations"]["get"]>>,
  { gatewayId, slug }: AssignedAnchorRequest,
  uid: string,
  now: number,
): operation is NonNullable<typeof operation> & { startedAt: number } {
  return operation?.kind === "migrate-user" && operation.status === "running" && operation.completedAt === null &&
    operation.startedAt !== null && Number.isSafeInteger(operation.startedAt) && operation.startedAt > 0 && operation.startedAt <= now &&
    operation.cancellationRequestedAt === undefined && operation.cutoverCommittedAt === undefined &&
    operation.input.fromGatewayId === gatewayId && operation.input.uid === uid &&
    (operation.input.userSlug === undefined || operation.input.userSlug === slug);
}

interface SourceMigrationContext {
  root: GatewayRoot;
  user: Stored<PlatformUserRecord>;
  assignment: GatewayAssignment;
  runtime: FleetRegistryRecord | null;
}

function sourceMigrationOperationId(input: AssignedAnchorRequest, context: SourceMigrationContext): string | null {
  const { root, user, assignment, runtime } = context;
  const id = input.sourceMigrationId;
  if (!id || !/^mig-[a-zA-Z0-9_-]+$/.test(id) || runtime?.lifecycle !== "serving" ||
      root.liveRelease !== root.desiredRelease || root.runtimeRestartFence !== undefined) return null;
  const operationId = id.slice(4);
  const marker = user.fences.migration;
  return assignment.updatedByOperationId === operationId && marker?.operationId === operationId &&
    marker.state === "moving" ? operationId : null;
}

function isSoleSourceAssignment(assignments: readonly GatewayAssignment[], source: GatewayAssignment): boolean {
  if (assignments.length !== 1) return false;
  const [current] = assignments;
  return current.uid === source.uid && current.slug === source.slug && current.gatewayId === source.gatewayId &&
    current.epoch === source.epoch && current.state === source.state && current.updatedByOperationId === source.updatedByOperationId;
}

async function readSourceMigrationClaim(
  store: PlatformStateRepositories, input: AssignedAnchorRequest, context: SourceMigrationContext, now: number,
): Promise<SourceMigrationClaim | null> {
  const operationId = sourceMigrationOperationId(input, context);
  if (!operationId) return null;
  const { root, user } = context;
  const operation = await store.journal.operations.get(operationId);
  if (!activeSourceClaim(operation, input, user.uid, now)) return null;
  const targetGatewayId = operation.input.toGatewayId;
  if (typeof targetGatewayId !== "string" || !targetGatewayId || targetGatewayId === root.gatewayId) return null;
  const [target, assignments] = await Promise.all([
    store.gateways.roots.get(targetGatewayId), store.gateways.assignments.listForUid(user.uid),
  ]);
  if (target?.gatewayClass !== "shared" || target.desiredStatus !== "running" || target.retirementClaim != null ||
      !isSoleSourceAssignment(assignments, context.assignment)) return null;
  return { operationId, claimStartedAt: operation.startedAt, targetGatewayId, release: root.desiredRelease };
}

export async function readAssignedIsolatedAgentAnchorScope(
  store: PlatformStateRepositories,
  input: AssignedAnchorRequest,
  now: number,
): Promise<AssignedIsolatedAgentAnchorScope | null> {
  const { gatewayId, slug, podUid, podName } = input;
  if (!podUid || !podName) return null;
  const root = await store.gateways.roots.get(gatewayId);
  const uid = configuredAnchorOwner(root, input);
  if (!root || !uid) return null;
  const [user, assignment, runtime] = await Promise.all([
    store.users.records.get(uid),
    store.gateways.assignments.get(gatewayId, uid),
    store.fleetRegistry.get(gatewayId),
  ]);
  const epoch = currentAnchorAssignmentEpoch(assignment, input, uid);
  if (!ownerHasInteractiveAccess(user, input) || !assignment || epoch === null ||
      !observedOwnerPod(runtime, root.desiredRelease, input, now)) return null;
  const scope = { gatewayId, podName, podUid, slug, uid, ownerAssignmentEpoch: epoch };
  if (input.sourceMigrationId === undefined) return user.fences.migration === undefined ? scope : null;
  const sourceMigration = await readSourceMigrationClaim(store, input, { root, user, assignment, runtime }, now);
  return sourceMigration ? { ...scope, sourceMigration } : null;
}

export async function assignedIsolatedAgentAnchorScopeIsCurrent(
  store: PlatformStateRepositories,
  scope: AssignedIsolatedAgentAnchorScope,
  now: number,
): Promise<boolean> {
  const captured = scope.sourceMigration;
  const current = await readAssignedIsolatedAgentAnchorScope(store, {
    ...scope, requestedUid: scope.uid, requestedEpoch: scope.ownerAssignmentEpoch,
    sourceMigrationId: captured && `mig-${captured.operationId}`,
  }, now);
  if (!current) return false;
  if (!captured) return current.sourceMigration === undefined;
  const active = current.sourceMigration;
  return active?.operationId === captured.operationId && active.claimStartedAt === captured.claimStartedAt &&
    active.targetGatewayId === captured.targetGatewayId && active.release === captured.release;
}
