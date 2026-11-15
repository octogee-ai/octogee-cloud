export interface KubeOps {
  scaleDeployment(opts: {
    namespace: string;
    name: string;
    replicas: number;
  }): Promise<void>;
  restartOpenClawInPlace(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
  readDeployedReplicas(opts: {
    namespace: string;
    name: string;
  }): Promise<number | null>;
  readAvailableReplicas(opts: {
    namespace: string;
    name: string;
  }): Promise<number | null>;
  readGatewayPodDiagnostics(opts: {
    namespace: string;
    gatewayId: string;
  }): Promise<GatewayPodDiagnostics>;
  readGatewayPodDiagnosticsBatch(opts: {
    namespace: string;
    gatewayIds: readonly string[];
    includeReplicaSets?: boolean;
  }): Promise<Record<string, GatewayPodDiagnostics>>;
  deletePersistentVolumeClaim(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
  deleteSecret(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
  deleteServiceAccount(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
  deleteService(opts: {
    namespace: string;
    name: string;
  }): Promise<void>;
}

export type GatewayPodDiagnosticsStatus = "ready" | "not-ready" | "missing" | "unknown";
export type GatewayPodCapacityType = "spot" | "on-demand";

// GCE identity of the node a pod is on, captured at observation time. A Spot
// preemption destroys the node, so the instance id can never be looked up after
// the fact — it is only joinable to the octogee_spot_preemptions log metric if
// it was already recorded while the node still existed.
export interface GatewayNodeFacts {
  capacityType: GatewayPodCapacityType;
  instanceId: string | null;
  nodePool: string | null;
}

// A gateway ReplicaSet as the apiserver reports it: what it wants
// (spec.replicas) and what its controller currently counts (status.replicas).
// It outlives its pods, so it is the record of intent that tells a pod lost to
// a preemption apart from one removed by a roll, a restart, or a pause.
export interface GatewayReplicaSetSummary {
  uid: string;
  name: string;
  desiredReplicas: number;
  observedReplicas: number;
}

export interface GatewayPodDiagnostic {
  name: string;
  gatewayId: string | null;
  deleting: boolean;
  gatewayContainerStartedAt: number | null;
  uid: string | null;
  replicaSetUid: string | null;
  phase: string;
  readyContainers: number;
  totalContainers: number;
  restarts: number;
  reason: string | null;
  nodeName: string | null;
  instanceId: string | null;
  nodePool: string | null;
  capacityType: GatewayPodCapacityType | null;
  ageMs: number | null;
}

export interface GatewayPodDiagnostics {
  status: GatewayPodDiagnosticsStatus;
  totalPods: number;
  readyPods: number;
  totalRestarts: number;
  spotPods: number;
  onDemandPods: number;
  unknownCapacityPods: number;
  pods: GatewayPodDiagnostic[];
  replicaSets?: GatewayReplicaSetSummary[];
  error?: string;
}

export interface KubectlSubprocessResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type KubectlSubprocess = (args: string[]) => Promise<KubectlSubprocessResult>;

export interface KubeOpsRunnerDeps {
  runKubectl: KubectlSubprocess;
  log: (msg: string) => void;
  now?: () => number;
}

async function deleteKubeResource(
  deps: KubeOpsRunnerDeps,
  resource: "pvc" | "secret" | "serviceaccount" | "service",
  opts: { namespace: string; name: string },
): Promise<void> {
  const result = await deps.runKubectl([
    "-n",
    opts.namespace,
    "delete",
    `${resource}/${opts.name}`,
    "--ignore-not-found=true",
  ]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl delete ${resource}/${opts.name} ns=${opts.namespace} failed (code=${result.code}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  deps.log(result.stdout.trim()
    ? `[kube-ops] deleted ${resource}/${opts.name} ns=${opts.namespace}`
    : `[kube-ops] ${resource}/${opts.name} ns=${opts.namespace} already absent`);
}

const NOT_FOUND_PATTERN = /\(NotFound\)/;

function isNotFound(stderr: string): boolean {
  return NOT_FOUND_PATTERN.test(stderr);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function containerWaitingReason(status: Record<string, unknown>): string | null {
  const state = isRecord(status.state) ? status.state : {};
  const waiting = isRecord(state.waiting) ? state.waiting : {};
  const terminated = isRecord(state.terminated) ? state.terminated : {};
  return stringOrNull(waiting.reason) ?? stringOrNull(terminated.reason);
}

function podConditionReason(status: Record<string, unknown>): string | null {
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  for (const condition of conditions) {
    if (!isRecord(condition)) continue;
    if (condition.type === "Ready" && condition.status !== "True") {
      return stringOrNull(condition.reason) ?? stringOrNull(condition.message);
    }
  }
  return null;
}

function projectPodContainers(status: Record<string, unknown>): {
  readyContainers: number;
  totalContainers: number;
  restarts: number;
  reason: string | null;
} {
  const containerStatuses = Array.isArray(status.containerStatuses)
    ? status.containerStatuses.filter(isRecord)
    : [];
  return {
    readyContainers: containerStatuses.filter((c) => c.ready === true).length,
    totalContainers: containerStatuses.length,
    restarts: containerStatuses.reduce((sum, c) => sum + numberOrZero(c.restartCount), 0),
    reason:
      containerStatuses.map(containerWaitingReason).find((v): v is string => v !== null) ??
      stringOrNull(status.reason) ??
      podConditionReason(status),
  };
}

function projectPodPlacement(
  spec: Record<string, unknown>,
  factsByNodeName: ReadonlyMap<string, GatewayNodeFacts>,
): Pick<GatewayPodDiagnostic, "nodeName" | "instanceId" | "nodePool" | "capacityType"> {
  const nodeName = stringOrNull(spec.nodeName);
  const facts = nodeName ? factsByNodeName.get(nodeName) ?? null : null;
  return {
    nodeName,
    instanceId: facts?.instanceId ?? null,
    nodePool: facts?.nodePool ?? null,
    capacityType: facts?.capacityType ?? null,
  };
}

function replicaSetOwnerUid(metadata: Record<string, unknown>): string | null {
  const owners = Array.isArray(metadata.ownerReferences) ? metadata.ownerReferences : [];
  for (const owner of owners) {
    if (isRecord(owner) && owner.kind === "ReplicaSet") return stringOrNull(owner.uid);
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function projectReplicaSetSummary(replicaSet: Record<string, unknown>): GatewayReplicaSetSummary | null {
  const metadata = isRecord(replicaSet.metadata) ? replicaSet.metadata : {};
  const spec = isRecord(replicaSet.spec) ? replicaSet.spec : {};
  const status = isRecord(replicaSet.status) ? replicaSet.status : {};
  const uid = stringOrNull(metadata.uid);
  const name = stringOrNull(metadata.name);
  if (!uid || !name) return null;
  return {
    uid,
    name,
    desiredReplicas: numberOrNull(spec.replicas) ?? 0,
    observedReplicas: numberOrNull(status.replicas) ?? 0,
  };
}

function gatewayContainerStartedAt(status: Record<string, unknown>): number | null {
  const containers = Array.isArray(status.containerStatuses) ? status.containerStatuses : [];
  const gateway = containers.find((entry) => isRecord(entry) && entry.name === "gateway");
  const state = isRecord(gateway?.state) ? gateway.state : {};
  const running = isRecord(state.running) ? state.running : {};
  const timestamp = stringOrNull(running.startedAt);
  const startedAt = timestamp === null ? NaN : Date.parse(timestamp);
  return Number.isFinite(startedAt) ? startedAt : null;
}

function projectPodDiagnostic(
  pod: Record<string, unknown>,
  now: number,
  factsByNodeName: ReadonlyMap<string, GatewayNodeFacts>,
): GatewayPodDiagnostic {
  const metadata = isRecord(pod.metadata) ? pod.metadata : {};
  const spec = isRecord(pod.spec) ? pod.spec : {};
  const status = isRecord(pod.status) ? pod.status : {};
  const createdAt = stringOrNull(metadata.creationTimestamp);
  const createdMs = createdAt ? Date.parse(createdAt) : NaN;
  return {
    name: stringOrNull(metadata.name) ?? "unknown",
    gatewayId: gatewayIdForRecord(pod),
    deleting: metadata.deletionTimestamp != null,
    gatewayContainerStartedAt: gatewayContainerStartedAt(status),
    uid: stringOrNull(metadata.uid),
    replicaSetUid: replicaSetOwnerUid(metadata),
    phase: stringOrNull(status.phase) ?? "Unknown",
    ...projectPodContainers(status),
    ...projectPodPlacement(spec, factsByNodeName),
    ageMs: Number.isFinite(createdMs) ? Math.max(0, now - createdMs) : null,
  };
}

function kubeListRecords(
  stdout: string,
  resource: string,
): Record<string, unknown>[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.items)) {
    throw new Error(`kubectl get ${resource} returned invalid JSON shape`);
  }
  return parsed.items.filter(isRecord);
}

function nodeFactsByName(stdout: string): Map<string, GatewayNodeFacts> {
  const facts = new Map<string, GatewayNodeFacts>();
  for (const node of kubeListRecords(stdout, "nodes")) {
    const metadata = isRecord(node.metadata) ? node.metadata : {};
    const name = stringOrNull(metadata.name);
    if (!name) continue;
    const labels = isRecord(metadata.labels) ? metadata.labels : {};
    const annotations = isRecord(metadata.annotations) ? metadata.annotations : {};
    const spot =
      labels["cloud.google.com/gke-spot"] === "true" ||
      labels["cloud.google.com/gke-preemptible"] === "true";
    facts.set(name, {
      capacityType: spot ? "spot" : "on-demand",
      instanceId: stringOrNull(annotations["container.googleapis.com/instance_id"]),
      nodePool: stringOrNull(labels["cloud.google.com/gke-nodepool"]),
    });
  }
  return facts;
}

async function readNodeFactsByName(
  deps: KubeOpsRunnerDeps,
  podRecords: readonly Record<string, unknown>[],
): Promise<Map<string, GatewayNodeFacts>> {
  const hasScheduledPod = podRecords.some((pod) => {
    const spec = isRecord(pod.spec) ? pod.spec : {};
    return stringOrNull(spec.nodeName) !== null;
  });
  if (!hasScheduledPod) return new Map();
  const result = await deps.runKubectl(["get", "nodes", "-o", "json"]);
  if (result.code !== 0) {
    throw new Error(
      `kubectl get nodes failed (code=${result.code}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  return nodeFactsByName(result.stdout);
}

function summarizePodRecords(
  podRecords: readonly Record<string, unknown>[],
  now: number,
  factsByNodeName: ReadonlyMap<string, GatewayNodeFacts>,
): GatewayPodDiagnostics {
  const pods = podRecords.map((pod) =>
    projectPodDiagnostic(pod, now, factsByNodeName)
  );
  const totalPods = pods.length;
  const readyPods = pods.filter(
    (pod) =>
      pod.phase === "Running" &&
      pod.totalContainers > 0 &&
      pod.readyContainers === pod.totalContainers,
  ).length;
  const totalRestarts = pods.reduce((sum, pod) => sum + pod.restarts, 0);
  const spotPods = pods.filter((pod) => pod.capacityType === "spot").length;
  const onDemandPods = pods.filter((pod) => pod.capacityType === "on-demand").length;
  const unknownCapacityPods = totalPods - spotPods - onDemandPods;
  let status: GatewayPodDiagnosticsStatus = "not-ready";
  if (totalPods === 0) {
    status = "missing";
  } else if (readyPods === totalPods) {
    status = "ready";
  }
  return {
    status,
    totalPods,
    readyPods,
    totalRestarts,
    spotPods,
    onDemandPods,
    unknownCapacityPods,
    pods,
  };
}

function gatewayIdForRecord(value: Record<string, unknown>): string | null {
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const labels = isRecord(metadata.labels) ? metadata.labels : {};
  return stringOrNull(labels["gateway-instance"]);
}

function groupByGatewayId(
  records: readonly Record<string, unknown>[],
  gatewayIds: readonly string[],
): Map<string, Record<string, unknown>[]> {
  const requested = new Set(gatewayIds);
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const value of records) {
    const gatewayId = gatewayIdForRecord(value);
    if (!gatewayId || !requested.has(gatewayId)) continue;
    const bucket = grouped.get(gatewayId) ?? [];
    bucket.push(value);
    grouped.set(gatewayId, bucket);
  }
  return grouped;
}

// The ReplicaSet list is optional context for the pod-loss accounting; a failure
// to read it must not degrade the pod status observation the placement policy
// depends on, so it is logged and the summaries are omitted rather than thrown.
async function readGatewayReplicaSetsByGatewayId(
  deps: KubeOpsRunnerDeps,
  namespace: string,
  gatewayIds: readonly string[],
): Promise<Map<string, GatewayReplicaSetSummary[]> | null> {
  const result = await deps.runKubectl([
    "-n",
    namespace,
    "get",
    "replicasets",
    "-l",
    "app=octogee-gateway",
    "-o",
    "json",
  ]);
  if (result.code !== 0) {
    deps.log(
      `[kube-ops] kubectl get replicasets ns=${namespace} failed (code=${result.code}); ` +
        `pod-loss verdicts are deferred this observation: ${result.stderr.trim() || result.stdout.trim()}`,
    );
    return null;
  }
  const grouped = groupByGatewayId(kubeListRecords(result.stdout, "replicasets"), gatewayIds);
  return new Map(
    gatewayIds.map((gatewayId) => [
      gatewayId,
      (grouped.get(gatewayId) ?? [])
        .map(projectReplicaSetSummary)
        .filter((summary): summary is GatewayReplicaSetSummary => summary !== null),
    ]),
  );
}

function summarizeGatewayPodDiagnosticsBatch(
  podRecords: readonly Record<string, unknown>[],
  gatewayIds: readonly string[],
  now: number,
  factsByNodeName: ReadonlyMap<string, GatewayNodeFacts>,
  replicaSetsByGatewayId: ReadonlyMap<string, GatewayReplicaSetSummary[]> | null,
): Record<string, GatewayPodDiagnostics> {
  const podsByGatewayId = groupByGatewayId(podRecords, gatewayIds);
  return Object.fromEntries(
    gatewayIds.map((gatewayId) => {
      const summary = summarizePodRecords(
        podsByGatewayId.get(gatewayId) ?? [],
        now,
        factsByNodeName,
      );
      const replicaSets = replicaSetsByGatewayId?.get(gatewayId);
      return [gatewayId, replicaSets ? { ...summary, replicaSets } : summary];
    }),
  );
}

function unknownPodDiagnostics(error?: string): GatewayPodDiagnostics {
  return {
    status: "unknown",
    totalPods: 0,
    readyPods: 0,
    totalRestarts: 0,
    spotPods: 0,
    onDemandPods: 0,
    unknownCapacityPods: 0,
    pods: [],
    ...(error ? { error } : {}),
  };
}

export function createKubeSubprocessRunner(deps: KubeOpsRunnerDeps): KubeOps {
  return {
    async scaleDeployment({ namespace, name, replicas }) {
      if (!Number.isInteger(replicas) || replicas < 0) {
        throw new Error(
          `scaleDeployment: replicas must be a non-negative integer (got ${replicas})`,
        );
      }
      const args = [
        "-n",
        namespace,
        "scale",
        `deploy/${name}`,
        `--replicas=${replicas}`,
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) {
          deps.log(
            `[kube-ops] scale deploy/${name} ns=${namespace} — deployment not found, no-op (idempotent)`,
          );
          return;
        }
        throw new Error(
          `kubectl scale deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      deps.log(
        `[kube-ops] scaled deploy/${name} ns=${namespace} → replicas=${replicas}`,
      );
    },

    async restartOpenClawInPlace({ namespace, name }) {
      // In-process OpenClaw restart via the gateway's own RPC — NOT a pod
      // reroll. `openclaw gateway restart --safe` asks the running gateway to
      // restart itself (self-authorizing over the local RPC); in a container
      // (no systemd/launchd) OpenClaw does an in-process restart, so the pod
      // stays up and restartCount is unchanged. `--skip-deferral` bypasses the
      // active-work idle-drain wait so an operator click restarts promptly.
      // `-c gateway` targets the container that holds the openclaw CLI +
      // process (not gateway-edge). Requires the gateway to be reachable —
      // an unreachable/crash-looping pod needs a true reroll, which the
      // operator drives separately.
      const args = [
        "-n",
        namespace,
        "exec",
        `deploy/${name}`,
        "-c",
        "gateway",
        "--",
        "openclaw",
        "gateway",
        "restart",
        "--safe",
        "--skip-deferral",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        throw new Error(
          `openclaw gateway restart (in-place) deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      deps.log(
        `[kube-ops] in-process OpenClaw restart deploy/${name} ns=${namespace}`,
      );
    },

    async readDeployedReplicas({ namespace, name }) {
      const args = [
        "-n",
        namespace,
        "get",
        `deploy/${name}`,
        "-o",
        "jsonpath={.spec.replicas}",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) return null;
        throw new Error(
          `kubectl get deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      const raw = result.stdout.trim();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `kubectl get deploy/${name} ns=${namespace}: unparseable replicas '${raw}'`,
        );
      }
      return n;
    },

    async readAvailableReplicas({ namespace, name }) {
      const args = [
        "-n",
        namespace,
        "get",
        `deploy/${name}`,
        "-o",
        "jsonpath={.status.availableReplicas}",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) return null;
        throw new Error(
          `kubectl get deploy/${name} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      const raw = result.stdout.trim();
      if (raw === "") return 0;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(
          `kubectl get deploy/${name} ns=${namespace}: unparseable availableReplicas '${raw}'`,
        );
      }
      return n;
    },

    async readGatewayPodDiagnostics({ namespace, gatewayId }) {
      const args = [
        "-n",
        namespace,
        "get",
        "pods",
        "-l",
        `gateway-instance=${gatewayId}`,
        "-o",
        "json",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) return unknownPodDiagnostics("pods not found");
        throw new Error(
          `kubectl get pods gateway-instance=${gatewayId} ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      const podRecords = kubeListRecords(result.stdout, "pods");
      const factsByNodeName = await readNodeFactsByName(deps, podRecords);
      return summarizePodRecords(
        podRecords,
        deps.now?.() ?? Date.now(),
        factsByNodeName,
      );
    },

    async readGatewayPodDiagnosticsBatch({ namespace, gatewayIds, includeReplicaSets = false }) {
      const args = [
        "-n",
        namespace,
        "get",
        "pods",
        "-l",
        "app=octogee-gateway",
        "-o",
        "json",
      ];
      const result = await deps.runKubectl(args);
      if (result.code !== 0) {
        if (isNotFound(result.stderr)) {
          return Object.fromEntries(
            gatewayIds.map((gatewayId) => [
              gatewayId,
              unknownPodDiagnostics("pods not found"),
            ]),
          );
        }
        throw new Error(
          `kubectl get gateway pods ns=${namespace} failed (code=${result.code}): ${
            result.stderr.trim() || result.stdout.trim()
          }`,
        );
      }
      const podRecords = kubeListRecords(result.stdout, "pods");
      const [factsByNodeName, replicaSetsByGatewayId] = await Promise.all([
        readNodeFactsByName(deps, podRecords),
        includeReplicaSets
          ? readGatewayReplicaSetsByGatewayId(deps, namespace, gatewayIds)
          : Promise.resolve(null),
      ]);
      return summarizeGatewayPodDiagnosticsBatch(
        podRecords,
        gatewayIds,
        deps.now?.() ?? Date.now(),
        factsByNodeName,
        replicaSetsByGatewayId,
      );
    },

    async deletePersistentVolumeClaim({ namespace, name }) {
      await deleteKubeResource(deps, "pvc", { namespace, name });
    },

    async deleteSecret({ namespace, name }) {
      await deleteKubeResource(deps, "secret", { namespace, name });
    },

    async deleteServiceAccount({ namespace, name }) {
      await deleteKubeResource(deps, "serviceaccount", { namespace, name });
    },

    async deleteService({ namespace, name }) {
      await deleteKubeResource(deps, "service", { namespace, name });
    },
  };
}

export function createLoggingKubeOps(log: (msg: string) => void): KubeOps {
  return {
    scaleDeployment: async ({ namespace, name, replicas }) => {
      log(`[kube-ops:stub] scale ns=${namespace} ${name} → ${replicas} — no exec`);
    },
    restartOpenClawInPlace: async ({ namespace, name }) => {
      log(`[kube-ops:stub] in-process OpenClaw restart ns=${namespace} ${name} — no exec`);
    },
    readDeployedReplicas: async ({ namespace, name }) => {
      log(`[kube-ops:stub] readReplicas ns=${namespace} ${name} — returning null`);
      return null;
    },
    readAvailableReplicas: async ({ namespace, name }) => {
      log(`[kube-ops:stub] readAvailableReplicas ns=${namespace} ${name} — returning null`);
      return null;
    },
    readGatewayPodDiagnostics: async ({ namespace, gatewayId }) => {
      log(`[kube-ops:stub] readGatewayPodDiagnostics ns=${namespace} ${gatewayId} — returning unknown`);
      return unknownPodDiagnostics();
    },
    readGatewayPodDiagnosticsBatch: async ({ namespace, gatewayIds }) => {
      log(
        `[kube-ops:stub] readGatewayPodDiagnosticsBatch ns=${namespace} gateways=${gatewayIds.join(",")} — returning unknown`,
      );
      return Object.fromEntries(
        gatewayIds.map((gatewayId) => [gatewayId, unknownPodDiagnostics()]),
      );
    },
    deletePersistentVolumeClaim: async ({ namespace, name }) => {
      log(`[kube-ops:stub] delete pvc ns=${namespace} ${name} — no exec`);
    },
    deleteSecret: async ({ namespace, name }) => {
      log(`[kube-ops:stub] delete secret ns=${namespace} ${name} — no exec`);
    },
    deleteServiceAccount: async ({ namespace, name }) => {
      log(`[kube-ops:stub] delete serviceaccount ns=${namespace} ${name} — no exec`);
    },
    deleteService: async ({ namespace, name }) => {
      log(`[kube-ops:stub] delete service ns=${namespace} ${name} — no exec`);
    },
  };
}
