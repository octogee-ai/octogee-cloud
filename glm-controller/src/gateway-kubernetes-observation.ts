import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { resolveGatewayRuntime } from "@octogee/shared/types/glm";
import type { GatewayKubernetesObservation } from "@octogee/shared/types/gateway-releases";
import {
  GATEWAY_POD_REPLACEMENT_SCHEMA,
  isGatewayPodPlacement,
  isGatewayPodReplacements,
  type GatewayPodPlacement,
  type GatewayPodReplacements,
} from "@octogee/shared/types/gateway-pod-replacements";
import type { FleetRegistryRecord, PlatformStateStore } from "@octogee/core/platform-state";
import {
  nextPodReplacementTransition,
  observedPodPlacements,
  observedReplicaSets,
  type PodReplacementTransition,
} from "./pod-replacement-tracking.js";

const eventLogger = createServiceLogger("cowboy");

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export type GatewayKubernetesStatus = "ready" | "not-ready" | "missing" | "unknown";

export interface GatewayPodDiagnostics {
  status: string;
  totalPods: number;
  readyPods: number;
  pods?: ReadonlyArray<{
    gatewayId?: string | null;
    phase?: string;
    deleting?: boolean;
    gatewayContainerStartedAt?: number | null;
    uid?: string | null;
    name?: string | null;
    replicaSetUid?: string | null;
    nodeName?: string | null;
    instanceId?: string | null;
    nodePool?: string | null;
  }>;
  replicaSets?: ReadonlyArray<{
    uid: string;
    name: string;
    desiredReplicas: number;
    observedReplicas: number;
  }>;
  error?: string;
}

export function gatewayKubernetesStatus(
  diagnostics: GatewayPodDiagnostics | undefined,
): GatewayKubernetesStatus {
  if (!diagnostics || diagnostics.error) return "unknown";
  if (diagnostics.status === "unknown") return "unknown";
  if (diagnostics.totalPods === 0) return "missing";
  if (diagnostics.totalPods > 0 && diagnostics.readyPods > 0) return "ready";
  if (diagnostics.totalPods > 0) return "not-ready";
  return "unknown";
}

export function gatewayPodDiagnosticsScope(
  gatewayIds: readonly string[],
  runtimes: ReadonlyMap<string, Pick<FleetRegistryRecord, "runtime">>,
): {
  clusterGatewayIds: string[];
  vmDiagnostics: Record<string, GatewayPodDiagnostics>;
} {
  const clusterGatewayIds: string[] = [];
  const vmDiagnostics: Record<string, GatewayPodDiagnostics> = {};
  for (const gatewayId of gatewayIds) {
    if (resolveGatewayRuntime(runtimes.get(gatewayId)?.runtime) === "gce-vm") {
      vmDiagnostics[gatewayId] = { status: "unknown", totalPods: 0, readyPods: 0 };
    } else {
      clusterGatewayIds.push(gatewayId);
    }
  }
  return { clusterGatewayIds, vmDiagnostics };
}

// Must stay a reconcile tick inside GATEWAY_UNREACHABLE_AFTER_MS.
export const KUBERNETES_OBSERVATION_REFRESH_MS = 120_000;

interface KubernetesObservation {
  status: string;
  totalPods: number;
  readyPods: number;
}

// Structured record mirroring octogee.disruption.v1: emitted to stdout so Cloud
// Logging can extract gateway_id / instance_id / node_pool as log-metric labels.
// instance_id is the join key against octogee_spot_preemptions, which knows the
// preempted instance but not which gateway was running on it. Node identity is
// "unknown" rather than null when the pod was never observed on a node, so the
// metric carries an explicit unattributed series instead of a blank label.
export interface GatewayPodReplacementRecord {
  schema: typeof GATEWAY_POD_REPLACEMENT_SCHEMA;
  recordType: "gateway_pod_replacement";
  observedAt: string;
  namespace: string;
  gatewayId: string;
  podName: string;
  vacatedPodUid: string;
  replicaSetUid: string;
  nodeName: string;
  instanceId: string;
  nodePool: string;
  total: number;
}

export const UNATTRIBUTED_NODE_IDENTITY = "unknown";

function emitGatewayPodReplacementRecord(value: GatewayPodReplacementRecord): void {
  eventLogger.info("Gateway pod replaced", { ...value });
}

function storedPodPlacements(
  stored: Record<string, unknown> | null,
): GatewayPodPlacement[] | null {
  const pods = stored?.pods;
  if (!Array.isArray(pods)) return null;
  const placements: GatewayPodPlacement[] = [];
  for (const pod of pods) {
    if (!isGatewayPodPlacement(pod)) return null;
    placements.push({
      uid: pod.uid,
      name: pod.name,
      replicaSetUid: pod.replicaSetUid,
      nodeName: pod.nodeName,
      instanceId: pod.instanceId,
      nodePool: pod.nodePool,
    });
  }
  return placements;
}

function samePodPlacement(left: GatewayPodPlacement, right: GatewayPodPlacement): boolean {
  return left.uid === right.uid &&
    left.name === right.name &&
    left.replicaSetUid === right.replicaSetUid &&
    left.nodeName === right.nodeName &&
    left.instanceId === right.instanceId &&
    left.nodePool === right.nodePool;
}

// A Spot preemption replaces the pod without changing readyPods or the restart
// count, so pod identity has to be part of the freshness comparison — otherwise
// a loss inside the refresh interval is skipped and never recorded. Node facts
// are compared too: a pod first seen Pending binds to its node later, and the
// instance id it lands on must be persisted before that node can be preempted.
function samePodPlacements(
  stored: Record<string, unknown> | null,
  observed: readonly GatewayPodPlacement[] | null,
): boolean {
  if (observed === null) return true;
  const previous = storedPodPlacements(stored);
  if (previous === null) return false;
  return previous.length === observed.length &&
    previous.every((pod, index) => samePodPlacement(pod, observed[index]!));
}

function kubernetesObservationIsCurrent(input: {
  stored: unknown;
  observed: KubernetesObservation;
  observedPlacements: readonly GatewayPodPlacement[] | null;
  now: number;
}): boolean {
  const { observed, observedPlacements, now } = input;
  const current = record(input.stored);
  if (!current) return false;
  const observedAt = current.observedAt;
  if (typeof observedAt !== "number") return false;
  if (observedAt > now || now - observedAt >= KUBERNETES_OBSERVATION_REFRESH_MS) return false;
  return current.status === observed.status &&
    current.totalPods === observed.totalPods &&
    current.readyPods === observed.readyPods &&
    samePodPlacements(current, observedPlacements);
}

interface KubernetesObservationOutcome {
  transition: PodReplacementTransition | null;
  malformedReplacements: boolean;
}

function persistedKubernetesObservation(input: {
  observed: KubernetesObservation;
  now: number;
  transition: PodReplacementTransition | null;
}): { kubernetes: Record<string, unknown>; podReplacements?: GatewayPodReplacements } {
  const { observed, now, transition } = input;
  if (transition === null) return { kubernetes: { ...observed, observedAt: now } };
  return {
    kubernetes: { ...observed, observedAt: now, pods: transition.placements },
    ...(transition.replacements ? { podReplacements: transition.replacements } : {}),
  };
}

function gatewayPodReplacementRecord(input: {
  gatewayId: string;
  namespace: string;
  vacated: GatewayPodPlacement;
  total: number;
  now: number;
}): GatewayPodReplacementRecord {
  const { vacated } = input;
  return {
    schema: GATEWAY_POD_REPLACEMENT_SCHEMA,
    recordType: "gateway_pod_replacement",
    observedAt: new Date(input.now).toISOString(),
    namespace: input.namespace,
    gatewayId: input.gatewayId,
    podName: vacated.name,
    vacatedPodUid: vacated.uid,
    replicaSetUid: vacated.replicaSetUid ?? UNATTRIBUTED_NODE_IDENTITY,
    nodeName: vacated.nodeName ?? UNATTRIBUTED_NODE_IDENTITY,
    instanceId: vacated.instanceId ?? UNATTRIBUTED_NODE_IDENTITY,
    nodePool: vacated.nodePool ?? UNATTRIBUTED_NODE_IDENTITY,
    total: input.total,
  };
}

function describePlacement(pod: GatewayPodPlacement): string {
  return `${pod.name} (uid=${pod.uid} rs=${pod.replicaSetUid ?? "none"} node=${pod.nodeName ?? "unscheduled"} ` +
    `instance=${pod.instanceId ?? "unknown"} nodePool=${pod.nodePool ?? "unknown"})`;
}

// Log lines and the structured record are emitted only after the transaction
// has committed: firebase-admin re-runs the transaction callback on contention,
// and a DELTA log metric would count every retry as another loss.
function reportKubernetesObservationOutcome(input: {
  gatewayId: string;
  outcome: KubernetesObservationOutcome;
  now: number;
  options: PersistKubernetesObservationsOptions;
}): void {
  const { gatewayId, outcome, now, options } = input;
  const log = options.log ?? (() => undefined);
  if (outcome.malformedReplacements) {
    log(`[kubernetes-observation] ${gatewayId} stored podReplacements were malformed; restarting the loss history`);
  }
  const transition = outcome.transition;
  if (!transition) return;
  for (const pod of transition.deferred) {
    log(
      `[kubernetes-observation] ${gatewayId} pod ${describePlacement(pod)} is missing from the pod list but ` +
        `its ReplicaSet still counts it; deferring the verdict to the next observation`,
    );
  }
  for (const pod of transition.unowned) {
    log(`[kubernetes-observation] ${gatewayId} pod ${describePlacement(pod)} vanished with no ReplicaSet owner; not counted`);
  }
  for (const pod of transition.vacated) {
    log(
      `[kubernetes-observation] ${gatewayId} lost pod ${describePlacement(pod)} while its ReplicaSet ` +
        `still wanted it running; total=${transition.replacements?.total ?? 0}`,
    );
    (options.emitReplacement ?? emitGatewayPodReplacementRecord)(gatewayPodReplacementRecord({
      gatewayId,
      namespace: options.namespace ?? UNATTRIBUTED_NODE_IDENTITY,
      vacated: pod,
      total: transition.replacements?.total ?? 0,
      now,
    }));
  }
}

export interface PersistKubernetesObservationsOptions {
  log?: (message: string) => void;
  emitReplacement?: (record: GatewayPodReplacementRecord) => void;
  namespace?: string;
}

export interface ScannedGatewayRuntime {
  gatewayId: string;
  kubernetes: unknown;
}

export async function persistKubernetesObservations(
  store: PlatformStateStore,
  runtimes: ReadonlyArray<ScannedGatewayRuntime>,
  kubernetesByGatewayId: Readonly<Record<string, GatewayPodDiagnostics>>,
  now: number,
  options: PersistKubernetesObservationsOptions = {},
): Promise<void> {
  if (runtimes.length === 0) return;
  await Promise.all(runtimes.map(async (scanned) => {
    const diagnostics = kubernetesByGatewayId[scanned.gatewayId];
    const observed: KubernetesObservation = {
      status: gatewayKubernetesStatus(diagnostics),
      totalPods: diagnostics?.totalPods ?? 0,
      readyPods: diagnostics?.readyPods ?? 0,
    };
    const observedPlacements = observedPodPlacements(diagnostics);
    const replicaSets = observedReplicaSets(diagnostics);
    if (kubernetesObservationIsCurrent({
      stored: scanned.kubernetes,
      observed,
      observedPlacements,
      now,
    })) return;
    const outcome = await store.transaction(
      { label: "gateway-kubernetes-observation" },
      async (transaction): Promise<KubernetesObservationOutcome | null> => {
        const current = await transaction.fleetRegistry.get(scanned.gatewayId);
        if (current === null) return null;
        const storedKubernetes = record(current.kubernetes);
        const storedObservedAt = storedKubernetes?.observedAt;
        if (typeof storedObservedAt === "number" && storedObservedAt > now) return null;
        const malformedReplacements = current.podReplacements !== undefined &&
          !isGatewayPodReplacements(current.podReplacements);
        const transition = nextPodReplacementTransition({
          previousPlacements: storedPodPlacements(storedKubernetes),
          previous: isGatewayPodReplacements(current.podReplacements) ? current.podReplacements : null,
          observedPlacements,
          replicaSets,
          now,
        });
        const persisted = persistedKubernetesObservation({ observed, now, transition });
        await transaction.fleetRegistry.patch(scanned.gatewayId, {
          ...persisted,
          kubernetes: { ...storedKubernetes, ...persisted.kubernetes } as unknown as GatewayKubernetesObservation,
        }, { revision: current.revision });
        return { transition, malformedReplacements };
      },
    );
    if (outcome) {
      reportKubernetesObservationOutcome({ gatewayId: scanned.gatewayId, outcome, now, options });
    }
  }));
}

export type ReadGatewayPodDiagnosticsBatch = (input: {
  namespace: string;
  gatewayIds: readonly string[];
  includeReplicaSets?: boolean;
}) => Promise<Record<string, GatewayPodDiagnostics>>;

export interface ObserveGatewayKubernetesInput {
  store: PlatformStateStore;
  namespace: string;
  now: number;
  log(message: string): void;
  readGatewayPodDiagnosticsBatch: ReadGatewayPodDiagnosticsBatch;
  gatewayIds: readonly string[];
  runtimes: ReadonlyArray<Pick<FleetRegistryRecord, "gatewayId" | "runtime" | "kubernetes">>;
}

export async function observeGatewayKubernetes(
  input: ObserveGatewayKubernetesInput,
): Promise<Record<string, GatewayPodDiagnostics>> {
  const runtimes = new Map(input.runtimes.map((runtime) => [runtime.gatewayId, runtime]));
  const scope = gatewayPodDiagnosticsScope(input.gatewayIds, runtimes);
  const kubernetesByGatewayId = {
    ...scope.vmDiagnostics,
    ...await input.readGatewayPodDiagnosticsBatch({
      namespace: input.namespace,
      gatewayIds: scope.clusterGatewayIds,
      includeReplicaSets: true,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      input.log(`[kubernetes-observation] Kubernetes diagnostics unreadable; treating fleet as unknown: ${message}`);
      return Object.fromEntries(scope.clusterGatewayIds.map((gatewayId) => [gatewayId, {
        status: "unknown",
        totalPods: 0,
        readyPods: 0,
      }]));
    }),
  };
  await persistKubernetesObservations(input.store, input.runtimes.map((runtime) => ({
    gatewayId: runtime.gatewayId,
    kubernetes: runtime.kubernetes,
  })), kubernetesByGatewayId, input.now, {
    log: input.log,
    namespace: input.namespace,
  });
  return kubernetesByGatewayId;
}

export const GATEWAY_KUBERNETES_OBSERVATION_MS = 15_000;

export interface GatewayKubernetesObserverDeps {
  store: PlatformStateStore;
  namespace: string;
  now(): number;
  log(message: string): void;
  readGatewayPodDiagnosticsBatch: ReadGatewayPodDiagnosticsBatch;
  listGatewayIds(): Promise<readonly string[]>;
  listRuntimes(): Promise<ReadonlyArray<Pick<FleetRegistryRecord, "gatewayId" | "runtime" | "kubernetes">>>;
  afterObservation?(kubernetesByGatewayId: Readonly<Record<string, GatewayPodDiagnostics>>): Promise<void>;
}

export async function observeGatewayKubernetesOnce(deps: GatewayKubernetesObserverDeps): Promise<void> {
  const [gatewayIds, runtimes] = await Promise.all([deps.listGatewayIds(), deps.listRuntimes()]);
  const observed = await observeGatewayKubernetes({
    store: deps.store,
    namespace: deps.namespace,
    now: deps.now(),
    log: deps.log,
    readGatewayPodDiagnosticsBatch: deps.readGatewayPodDiagnosticsBatch,
    gatewayIds,
    runtimes,
  });
  await deps.afterObservation?.(observed);
}

export function startGatewayKubernetesObserver(
  deps: GatewayKubernetesObserverDeps,
  intervalMs = GATEWAY_KUBERNETES_OBSERVATION_MS,
): () => void {
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await observeGatewayKubernetesOnce(deps);
    } catch (error) {
      deps.log(`[kubernetes-observation] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
