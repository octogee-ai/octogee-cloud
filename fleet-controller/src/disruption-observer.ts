import { createServiceLogger } from "@octogee/shared/server/service-logger";
const eventLogger = createServiceLogger("cowboy");
import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import type { KubectlSubprocess } from "./lib/kube-ops.js";
import {
  initializeDisruptionObservation,
  recordDisruptionObservation,
  recordDisruptionSnapshot,
} from "./metrics.js";

export const DISRUPTION_RECORD_SCHEMA = "octogee.disruption.v1" as const;

export type DisruptionCause =
  | "node_shutdown_unconfirmed"
  | "pod_termination_observed"
  | "prestop_hook_failure"
  | "scheduler_pending"
  | "taint_manager_eviction"
  | "kubelet_critical_preemption"
  | "pod_evicted_unclassified";

export interface DisruptionNodeRecord {
  name: string;
  uid: string | null;
  providerId: string | null;
  gceInstanceId: string | null;
  zone: string | null;
  capacityClass: "spot" | "on-demand" | "unknown";
  provisioning: string | null;
  computeClass: string | null;
  taints: Array<{ key: string; value: string | null; effect: string }>;
  conditions: Array<{ type: string; status: string; reason: string | null }>;
}

export interface DisruptionPodRecord {
  name: string;
  uid: string | null;
  nodeName: string | null;
  phase: string;
  reason: string | null;
  gatewayId: string | null;
  gatewayInstance: string | null;
  gatewayClass: string | null;
}

export interface DisruptionGatewayRecord {
  gatewayId: string;
  gatewayClass: string | null;
  desiredStatus: string | null;
  builderSlug: string | null;
  assignments: Array<{ uid: string; slug: string }>;
  operations: Array<{ id: string; kind: string | null; status: string | null; origin: string | null }>;
}

export interface DisruptionRecord {
  schema: typeof DISRUPTION_RECORD_SCHEMA;
  recordType: "disruption_observation";
  observedAt: string;
  environment: string;
  cluster: string;
  namespace: string;
  source: "kubernetes_event";
  cause: DisruptionCause;
  confidence: "observed" | "unconfirmed";
  severity: "INFO" | "WARNING" | "CRITICAL";
  event: {
    uid: string;
    reason: string;
    type: string | null;
    message: string | null;
    namespace: string | null;
    objectKind: string | null;
    objectName: string | null;
    objectUid: string | null;
    firstTimestamp: string | null;
    lastTimestamp: string | null;
    count: number | null;
  };
  nodeName: string | null;
  nodeUid: string | null;
  providerId: string | null;
  gceInstanceId: string | null;
  zone: string | null;
  capacityClass: DisruptionNodeRecord["capacityClass"];
  computeClass: string | null;
  affectedPods: DisruptionPodRecord[];
  affectedGateways: DisruptionGatewayRecord[];
}

interface KubeObject {
  [key: string]: unknown;
  metadata?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

interface KubeEvent extends KubeObject {
  reason: string;
  type: string | null;
  message: string | null;
  involvedObject: {
    kind: string | null;
    namespace: string | null;
    name: string | null;
    uid: string | null;
  };
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  count: number | null;
}

interface DisruptionObserverDeps {
  store: Pick<PlatformStateRepositories, "gateways" | "journal">;
  runKubectl: KubectlSubprocess;
  environment: string;
  cluster: string;
  namespace: string;
  intervalMs: number;
  log: (message: string) => void;
  emit?: (record: DisruptionRecord) => void;
  now?: () => number;
}

const RELEVANT_REASONS = new Set([
  "NodeShutdown",
  "Killing",
  "FailedPreStopHook",
  "FailedScheduling",
  "TaintManagerEviction",
  "Evicted",
  "Preempting",
]);

type NodeCache = Map<string, DisruptionNodeRecord>;
type PodCache = Map<string, DisruptionPodRecord>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataOf(value: KubeObject): Record<string, unknown> {
  return isRecord(value.metadata) ? value.metadata : {};
}

function labelsOf(value: KubeObject): Record<string, unknown> {
  const labels = metadataOf(value).labels;
  return isRecord(labels) ? labels : {};
}

function annotationsOf(value: KubeObject): Record<string, unknown> {
  const annotations = metadataOf(value).annotations;
  return isRecord(annotations) ? annotations : {};
}

function parseProviderId(providerId: string | null): { zone: string | null } {
  if (!providerId) return { zone: null };
  const parts = providerId.split("/");
  return { zone: parts.length >= 4 ? parts[3] ?? null : null };
}

function capacityClass(labels: Record<string, unknown>): DisruptionNodeRecord["capacityClass"] {
  if (labels["cloud.google.com/gke-spot"] === "true" || labels["cloud.google.com/gke-provisioning"] === "spot") {
    return "spot";
  }
  if (labels["cloud.google.com/gke-spot"] === "false" || labels["cloud.google.com/gke-provisioning"] === "standard") {
    return "on-demand";
  }
  return "unknown";
}

function parseNode(value: KubeObject): DisruptionNodeRecord {
  const metadata = metadataOf(value);
  const labels = labelsOf(value);
  const annotations = annotationsOf(value);
  const spec = isRecord(value.spec) ? value.spec : {};
  const status = isRecord(value.status) ? value.status : {};
  const providerId = stringOrNull(spec.providerID);
  const provider = parseProviderId(providerId);
  const taints = Array.isArray(spec.taints)
    ? spec.taints.filter(isRecord).map((taint) => ({
        key: stringOrNull(taint.key) ?? "unknown",
        value: stringOrNull(taint.value),
        effect: stringOrNull(taint.effect) ?? "unknown",
      }))
    : [];
  const conditions = Array.isArray(status.conditions)
    ? status.conditions.filter(isRecord).map((condition) => ({
        type: stringOrNull(condition.type) ?? "unknown",
        status: stringOrNull(condition.status) ?? "unknown",
        reason: stringOrNull(condition.reason),
      }))
    : [];
  return {
    name: stringOrNull(metadata.name) ?? "unknown",
    uid: stringOrNull(metadata.uid),
    providerId,
    gceInstanceId: stringOrNull(annotations["container.googleapis.com/instance_id"]),
    zone: stringOrNull(labels["topology.kubernetes.io/zone"]) ?? provider.zone,
    capacityClass: capacityClass(labels),
    provisioning: stringOrNull(labels["cloud.google.com/gke-provisioning"]),
    computeClass: stringOrNull(labels["cloud.google.com/compute-class"]),
    taints,
    conditions,
  };
}

function parsePod(value: KubeObject): DisruptionPodRecord {
  const metadata = metadataOf(value);
  const labels = labelsOf(value);
  const spec = isRecord(value.spec) ? value.spec : {};
  const status = isRecord(value.status) ? value.status : {};
  return {
    name: stringOrNull(metadata.name) ?? "unknown",
    uid: stringOrNull(metadata.uid),
    nodeName: stringOrNull(spec.nodeName),
    phase: stringOrNull(status.phase) ?? "Unknown",
    reason: stringOrNull(status.reason),
    gatewayId: stringOrNull(labels["gateway-id"]),
    gatewayInstance: stringOrNull(labels["gateway-instance"]),
    gatewayClass: stringOrNull(labels["gateway-class"]),
  };
}

function parseEvent(value: KubeObject): KubeEvent | null {
  const metadata = metadataOf(value);
  const involved = isRecord(value.involvedObject) ? value.involvedObject : {};
  const reason = stringOrNull(value.reason);
  if (!reason || !RELEVANT_REASONS.has(reason)) return null;
  return {
    metadata,
    reason,
    type: stringOrNull(value.type),
    message: stringOrNull(value.message),
    involvedObject: {
      kind: stringOrNull(involved.kind),
      namespace: stringOrNull(involved.namespace),
      name: stringOrNull(involved.name),
      uid: stringOrNull(involved.uid),
    },
    firstTimestamp: stringOrNull(value.firstTimestamp) ?? stringOrNull(value.eventTime),
    lastTimestamp: stringOrNull(value.lastTimestamp) ?? stringOrNull(value.eventTime),
    count: numberOrNull(value.count),
  };
}

async function readJson(
  runKubectl: KubectlSubprocess,
  args: string[],
): Promise<Record<string, unknown>> {
  const result = await runKubectl(args);
  if (result.code !== 0) {
    throw new Error(`kubectl ${args.join(" ")} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!isRecord(parsed)) throw new Error(`kubectl ${args.join(" ")} returned a non-object JSON response`);
  return parsed;
}

async function readPodIfPresent(
  deps: DisruptionObserverDeps,
  event: KubeEvent,
  cache: Map<string, DisruptionPodRecord | null>,
): Promise<DisruptionPodRecord | null> {
  const object = event.involvedObject;
  if (object.kind !== "Pod" || !object.namespace || !object.name) return null;
  const key = `${object.namespace}/${object.name}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const result = await deps.runKubectl(["-n", object.namespace, "get", "pod", object.name, "-o", "json"]);
  if (result.code !== 0) {
    cache.set(key, null);
    return null;
  }
  try {
    const pod = parsePod(JSON.parse(result.stdout) as KubeObject);
    cache.set(key, pod);
    return pod;
  } catch {
    cache.set(key, null);
    return null;
  }
}

function causeFor(reason: string): DisruptionCause {
  switch (reason) {
    case "NodeShutdown": return "node_shutdown_unconfirmed";
    case "Killing": return "pod_termination_observed";
    case "FailedPreStopHook": return "prestop_hook_failure";
    case "FailedScheduling": return "scheduler_pending";
    case "TaintManagerEviction": return "taint_manager_eviction";
    case "Preempting": return "kubelet_critical_preemption";
    default: return "pod_evicted_unclassified";
  }
}

function severityFor(cause: DisruptionCause): DisruptionRecord["severity"] {
  if (
    cause === "node_shutdown_unconfirmed" ||
    cause === "prestop_hook_failure" ||
    cause === "kubelet_critical_preemption"
  ) return "WARNING";
  return "INFO";
}

function podCacheKey(pod: DisruptionPodRecord): string {
  return pod.uid ?? pod.name;
}

function eventKey(event: KubeEvent): string {
  const uid = stringOrNull(event.metadata?.uid);
  return uid ?? [event.reason, event.involvedObject.namespace, event.involvedObject.name, event.message].join("\0");
}

function gatewayIdsForPods(pods: readonly DisruptionPodRecord[]): string[] {
  return [...new Set(pods.flatMap((pod) => pod.gatewayId ? [pod.gatewayId] : []))].sort();
}

async function gatewayRecords(
  store: Pick<PlatformStateRepositories, "gateways" | "journal">,
  gatewayIds: readonly string[],
): Promise<DisruptionGatewayRecord[]> {
  return Promise.all(gatewayIds.map(async (gatewayId) => {
    const [root, assignments, operations] = await Promise.all([
      store.gateways.roots.get(gatewayId),
      store.gateways.assignments.list(gatewayId),
      store.journal.operations.listByGateway(gatewayId),
    ]);
    return {
      gatewayId,
      gatewayClass: root?.gatewayClass ?? null,
      desiredStatus: root?.desiredStatus ?? null,
      builderSlug: root?.builderSlug ?? null,
      assignments: assignments.map((assignment) => ({ uid: assignment.uid, slug: assignment.slug })),
      operations: operations.flatMap((operation) =>
        operation.status === "pending" || operation.status === "running"
          ? [{ id: operation.id, kind: operation.kind, status: operation.status, origin: operation.origin ?? null }]
          : []),
    };
  }));
}

function emitRecord(record: DisruptionRecord): void {
  const level = ({ CRITICAL: "fatal", WARNING: "warn", INFO: "info" } as const)[record.severity];
  eventLogger[level]("Gateway disruption observed", { ...record });
}

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity
async function observeOnce(
  deps: DisruptionObserverDeps,
  nodeCache: NodeCache,
  podCache: PodCache,
  seenEvents: Map<string, number>,
  podLookupCache: Map<string, DisruptionPodRecord | null>,
): Promise<void> {
  const [nodeResponse, podResponse, eventResponse] = await Promise.all([
    readJson(deps.runKubectl, ["get", "nodes", "-o", "json"]),
    readJson(deps.runKubectl, ["-n", deps.namespace, "get", "pods", "-l", "app=octogee-gateway", "-o", "json"]),
    readJson(deps.runKubectl, ["get", "events", "-A", "-o", "json"]),
  ]);

  const nodes = Array.isArray(nodeResponse.items)
    ? nodeResponse.items.filter(isRecord).map(parseNode)
    : [];
  for (const node of nodes) nodeCache.set(node.name, node);

  const gatewayPods = Array.isArray(podResponse.items)
    ? podResponse.items.filter(isRecord).map(parsePod)
    : [];
  for (const pod of gatewayPods) podCache.set(podCacheKey(pod), pod);

  recordDisruptionSnapshot({
    spotNodes: nodes.filter((node) => node.capacityClass === "spot").length,
    onDemandNodes: nodes.filter((node) => node.capacityClass === "on-demand").length,
    unknownNodes: nodes.filter((node) => node.capacityClass === "unknown").length,
    gatewayPods: gatewayPods.length,
    pendingGatewayPods: gatewayPods.filter((pod) => pod.phase === "Pending").length,
    now: (deps.now ?? Date.now)(),
  });

  const events = Array.isArray(eventResponse.items)
    ? eventResponse.items.filter(isRecord).map(parseEvent).filter((event): event is KubeEvent => event !== null)
    : [];
  const cutoff = (deps.now ?? Date.now)() - 60 * 60 * 1000;
  const gatewayCache = new Map<string, Promise<DisruptionGatewayRecord[]>>();
  for (const [key, observedAt] of seenEvents) {
    if (observedAt < cutoff) seenEvents.delete(key);
  }

  for (const event of events) {
    if (event.involvedObject.namespace && event.involvedObject.namespace !== deps.namespace) continue;
    const key = eventKey(event);
    if (seenEvents.has(key)) continue;
    seenEvents.set(key, (deps.now ?? Date.now)());

    let eventPod = await readPodIfPresent(deps, event, podLookupCache);
    if (eventPod) podCache.set(podCacheKey(eventPod), eventPod);
    if (!eventPod && event.involvedObject.uid) eventPod = podCache.get(event.involvedObject.uid) ?? null;
    if (!eventPod && event.involvedObject.name) {
      eventPod = [...podCache.values()].find((pod) => pod.name === event.involvedObject.name) ?? null;
    }

    let node = event.involvedObject.kind === "Node" && event.involvedObject.name
      ? nodeCache.get(event.involvedObject.name) ?? null
      : null;
    if (!node && eventPod?.nodeName) node = nodeCache.get(eventPod.nodeName) ?? null;

    const affectedPods = [...podCache.values()].filter((pod) =>
      (node?.name && pod.nodeName === node.name) ||
      (!!eventPod && pod.uid === eventPod.uid) ||
      (!!eventPod && pod.name === eventPod.name),
    );
    if (eventPod && !affectedPods.some((pod) => pod.uid === eventPod?.uid || pod.name === eventPod?.name)) {
      affectedPods.push(eventPod);
    }
    const relevantPods = affectedPods.filter((pod) => pod.gatewayId !== null);
    if (relevantPods.length === 0 && event.involvedObject.namespace === deps.namespace) {
      if (eventPod?.gatewayId) relevantPods.push(eventPod);
    }
    if (relevantPods.length === 0) continue;

    const cause = causeFor(event.reason);
    const capacityClass = node?.capacityClass ?? "unknown";
    const record: DisruptionRecord = {
      schema: DISRUPTION_RECORD_SCHEMA,
      recordType: "disruption_observation",
      observedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      environment: deps.environment,
      cluster: deps.cluster,
      namespace: deps.namespace,
      source: "kubernetes_event",
      cause,
      confidence: cause === "node_shutdown_unconfirmed" ? "unconfirmed" : "observed",
      severity: severityFor(cause),
      event: {
        uid: eventKey(event),
        reason: event.reason,
        type: event.type,
        message: event.message,
        namespace: event.involvedObject.namespace,
        objectKind: event.involvedObject.kind,
        objectName: event.involvedObject.name,
        objectUid: event.involvedObject.uid,
        firstTimestamp: event.firstTimestamp,
        lastTimestamp: event.lastTimestamp,
        count: event.count,
      },
      nodeName: node?.name ?? null,
      nodeUid: node?.uid ?? null,
      providerId: node?.providerId ?? null,
      gceInstanceId: node?.gceInstanceId ?? null,
      zone: node?.zone ?? null,
      capacityClass,
      computeClass: node?.computeClass ?? null,
      affectedPods: relevantPods,
      affectedGateways: await (async () => {
        const gatewayIds = gatewayIdsForPods(relevantPods);
        const cacheKey = gatewayIds.join(",");
        const pending = gatewayCache.get(cacheKey) ?? gatewayRecords(deps.store, gatewayIds);
        gatewayCache.set(cacheKey, pending);
        return pending;
      })(),
    };
    recordDisruptionObservation({
      cause,
      source: "kubernetes_event",
      capacityClass,
      namespace: deps.namespace,
      now: (deps.now ?? Date.now)(),
    });
    (deps.emit ?? emitRecord)(record);
  }
}

export function startDisruptionObserver(deps: DisruptionObserverDeps): () => void {
  for (const capacityClass of ["spot", "on-demand", "unknown"] as const) {
    initializeDisruptionObservation({
      cause: "kubelet_critical_preemption",
      source: "kubernetes_event",
      capacityClass,
      namespace: deps.namespace,
    });
  }
  const nodeCache: NodeCache = new Map();
  const podCache: PodCache = new Map();
  const seenEvents = new Map<string, number>();
  const podLookupCache = new Map<string, DisruptionPodRecord | null>();
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await observeOnce(deps, nodeCache, podCache, seenEvents, podLookupCache);
    } catch (error) {
      deps.log(`[glm-controller] disruption observer failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export const disruptionObserverTest = {
  causeFor,
  severityFor,
  parseNode,
  parsePod,
  parseEvent,
};
