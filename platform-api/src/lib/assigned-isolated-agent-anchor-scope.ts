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
}

export interface AssignedIsolatedAgentAnchorScope {
  gatewayId: string;
  podName: string;
  podUid: string;
  slug: string;
  uid: string;
  ownerAssignmentEpoch: number;
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

function isServingOwner(user: Stored<PlatformUserRecord> | null, input: AssignedAnchorRequest): boolean {
  return user !== null && user.slug === input.slug && user.gateway?.gatewayId === input.gatewayId &&
    user.fences.migration === undefined && !isolatedRuntimeMutationFenced(user) &&
    accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle });
}

function currentAnchorAssignmentEpoch(
  assignment: GatewayAssignment | null,
  input: AssignedAnchorRequest,
  uid: string,
): number | null {
  if (!assignment || assignment.uid !== uid || assignment.slug !== input.slug || assignment.gatewayId !== input.gatewayId ||
      assignment.state !== "serving" || !Number.isSafeInteger(assignment.epoch) || assignment.epoch < 0 ||
      (input.requestedEpoch !== undefined && input.requestedEpoch !== assignment.epoch)) return null;
  return assignment.epoch;
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
  if (!isServingOwner(user, input) || epoch === null || !observedOwnerPod(runtime, root.desiredRelease, input, now)) return null;
  return { gatewayId, podName, podUid, slug, uid, ownerAssignmentEpoch: epoch };
}

export async function assignedIsolatedAgentAnchorScopeIsCurrent(
  store: PlatformStateRepositories,
  scope: AssignedIsolatedAgentAnchorScope,
  now: number,
): Promise<boolean> {
  return await readAssignedIsolatedAgentAnchorScope(store, {
    ...scope, requestedUid: scope.uid, requestedEpoch: scope.ownerAssignmentEpoch,
  }, now) !== null;
}
