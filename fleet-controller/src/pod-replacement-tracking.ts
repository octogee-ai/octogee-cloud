import {
  EMPTY_GATEWAY_POD_REPLACEMENTS,
  POD_REPLACEMENT_MAX_RETAINED,
  pruneGatewayPodReplacementWindow,
  type GatewayPodPlacement,
  type GatewayPodReplacements,
} from "@octogee/shared/types/gateway-pod-replacements";

import type { GatewayPodDiagnostics } from "./gateway-kubernetes-observation.js";

// What a gateway's ReplicaSet wants and what its controller currently sees.
// `desiredReplicas` is spec.replicas; `observedReplicas` is status.replicas.
export interface ObservedReplicaSet {
  uid: string;
  name: string;
  desiredReplicas: number;
  observedReplicas: number;
}

function comparePodUid(left: GatewayPodPlacement, right: GatewayPodPlacement): number {
  if (left.uid < right.uid) return -1;
  return left.uid > right.uid ? 1 : 0;
}

// `null` means "this tick observed nothing trustworthy" — a kubectl failure or a
// pod record without an identity. Attributing a loss to an unreadable window
// would invent churn out of a transient API error, so the caller must leave the
// tracked placements untouched instead.
export function observedPodPlacements(
  diagnostics: GatewayPodDiagnostics | undefined,
): GatewayPodPlacement[] | null {
  if (!diagnostics || diagnostics.error) return null;
  if (diagnostics.status === "unknown") return null;
  const pods = diagnostics.pods;
  if (!pods) return diagnostics.totalPods === 0 ? [] : null;
  const byUid = new Map<string, GatewayPodPlacement>();
  for (const pod of pods) {
    if (typeof pod.uid !== "string" || pod.uid.length === 0) return null;
    byUid.set(pod.uid, {
      uid: pod.uid,
      name: pod.name ?? pod.uid,
      replicaSetUid: pod.replicaSetUid ?? null,
      nodeName: pod.nodeName ?? null,
      instanceId: pod.instanceId ?? null,
      nodePool: pod.nodePool ?? null,
    });
  }
  return [...byUid.values()].sort(comparePodUid);
}

// `null` means the ReplicaSet list was not read this tick, so no vanished pod
// can be classified and every one of them is carried forward unresolved.
export function observedReplicaSets(
  diagnostics: GatewayPodDiagnostics | undefined,
): ObservedReplicaSet[] | null {
  const replicaSets = diagnostics?.replicaSets;
  if (!replicaSets) return null;
  return replicaSets.map((replicaSet) => ({
    uid: replicaSet.uid,
    name: replicaSet.name,
    desiredReplicas: replicaSet.desiredReplicas,
    observedReplicas: replicaSet.observedReplicas,
  }));
}

export type VacatedPodVerdict = "unplanned" | "planned" | "deferred" | "unowned";

// The ReplicaSet is Kubernetes' own record of intent for a pod's generation and
// it outlives the pod, which makes it the discriminator that survives the timing
// gap between the fleet controller writing desired state and the pod actually going away:
// - the ReplicaSet is gone or scaled to zero: a roll, a restart, a config upgrade,
//   a pause or an uninstall replaced or removed this generation — planned;
// - the ReplicaSet controller still counts more pods than this observation
//   contains: the pod list is behind the controller (or a bad read) — deferred,
//   the pod stays tracked and is classified again next tick;
// - the ReplicaSet still wants the pod running and agrees it is gone — unplanned.
export function classifyVacatedPod(
  pod: GatewayPodPlacement,
  replicaSets: readonly ObservedReplicaSet[],
  observed: readonly GatewayPodPlacement[],
): VacatedPodVerdict {
  if (pod.replicaSetUid === null) return "unowned";
  const replicaSet = replicaSets.find((candidate) => candidate.uid === pod.replicaSetUid);
  if (!replicaSet || replicaSet.desiredReplicas === 0) return "planned";
  const ownedObserved = observed.filter((candidate) => candidate.replicaSetUid === replicaSet.uid).length;
  if (ownedObserved < replicaSet.observedReplicas) return "deferred";
  return "unplanned";
}

export interface PodReplacementTransition {
  replacements: GatewayPodReplacements | null;
  placements: GatewayPodPlacement[];
  vacated: GatewayPodPlacement[];
  deferred: GatewayPodPlacement[];
  unowned: GatewayPodPlacement[];
}

// Counted on the pod DISAPPEARING, not on its successor appearing. The vacated
// pod carries the node identity that joins to the preemption record, and that
// identity is gone once the successor is observed; and a gateway whose pod is
// never rescheduled (Spot capacity exhausted) is exactly the case an
// appearance-triggered counter would report as zero churn while it is down.
export function nextPodReplacementTransition(input: {
  previousPlacements: readonly GatewayPodPlacement[] | null;
  previous: GatewayPodReplacements | null;
  observedPlacements: readonly GatewayPodPlacement[] | null;
  replicaSets: readonly ObservedReplicaSet[] | null;
  now: number;
}): PodReplacementTransition | null {
  const { observedPlacements: observed, replicaSets, now } = input;
  if (observed === null) return null;

  const observedUids = new Set(observed.map((pod) => pod.uid));
  const missing = (input.previousPlacements ?? []).filter((pod) => !observedUids.has(pod.uid));

  const vacated: GatewayPodPlacement[] = [];
  const deferred: GatewayPodPlacement[] = [];
  const unowned: GatewayPodPlacement[] = [];
  for (const pod of missing) {
    const verdict = replicaSets === null ? "deferred" : classifyVacatedPod(pod, replicaSets, observed);
    if (verdict === "unplanned") vacated.push(pod);
    else if (verdict === "deferred") deferred.push(pod);
    else if (verdict === "unowned") unowned.push(pod);
  }

  const placements = [...observed, ...deferred].sort(comparePodUid);
  const previous = input.previous;
  const retained = previous ? pruneGatewayPodReplacementWindow(previous.recentAt, now) : [];

  if (vacated.length === 0) {
    return {
      replacements: previous ? { ...previous, recentAt: retained } : null,
      placements,
      vacated,
      deferred,
      unowned,
    };
  }

  const base = previous ?? EMPTY_GATEWAY_POD_REPLACEMENTS;
  const last = vacated[vacated.length - 1]!;
  return {
    replacements: {
      recentAt: [...retained, ...vacated.map(() => now)].slice(-POD_REPLACEMENT_MAX_RETAINED),
      lastAt: now,
      lastVacatedPodUid: last.uid,
      lastVacatedNodeName: last.nodeName,
      lastVacatedInstanceId: last.instanceId,
      lastVacatedNodePool: last.nodePool,
      total: base.total + vacated.length,
    },
    placements,
    vacated,
    deferred,
    unowned,
  };
}
