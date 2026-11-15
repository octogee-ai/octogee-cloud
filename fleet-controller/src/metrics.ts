// Minimal Prometheus exposition for the fleet controller (glm-controller). Hand-rolled (no
// prom-client dep) — the high-value signals are: is the fleet reconciler ticking
// and succeeding, and how often does it fail. Process metrics are deferred.
// Scraped at /metrics by the glm-controller ServiceMonitor.

let reconcileOk = 0;
let reconcileFail = 0;
let lastSuccessMs: number | null = null;
let gatewayHealth: GatewayHealthSample[] = [];
let vmDiskUsage: VmDiskUsageSample[] = [];
const configRoll = new Map<string, number>();
const disruptionObservations = new Map<string, number>();
let disruptionLastObservedMs: number | null = null;
let sharedGatewayMaxCapacity = 0;
let sharedGatewayCapacitySnapshot = {
  assignmentCount: 0,
  hotMemberCount: 0,
};
let sharedPoolReplicaBounds = { minReplicas: 0, maxReplicas: 0 };
let disruptionSnapshot = {
  spotNodes: 0,
  onDemandNodes: 0,
  unknownNodes: 0,
  gatewayPods: 0,
  pendingGatewayPods: 0,
};

export type ConfigRollStage = "checkpoint" | "proof" | "unfreeze";
export type ConfigRollResult = "ok" | "fail";

export interface ConfigRollSample {
  stage: ConfigRollStage;
  result: ConfigRollResult;
  gatewayId: string;
  revisionId: string;
}

export interface GatewayHealthSample {
  gatewayId: string;
  availableReplicas: number;
}

export interface VmDiskUsageSample {
  gatewayId: string;
  sizeBytes: number;
  freeBytes: number;
  observedAt: number;
}

export interface DisruptionObservationSample {
  cause: string;
  source: string;
  capacityClass: string;
  namespace: string;
  now?: number;
}

export interface DisruptionSnapshotSample {
  spotNodes: number;
  onDemandNodes: number;
  unknownNodes: number;
  gatewayPods: number;
  pendingGatewayPods: number;
  now?: number;
}

export interface SharedGatewayMaxCapacitySample {
  assignmentCount: number;
  hotMemberCount: number;
}

export function recordReconcile(result: "ok" | "fail", now: number = Date.now()): void {
  if (result === "ok") {
    reconcileOk += 1;
    lastSuccessMs = now;
  } else {
    reconcileFail += 1;
  }
}

export function resetMetrics(): void {
  reconcileOk = 0;
  reconcileFail = 0;
  lastSuccessMs = null;
  gatewayHealth = [];
  vmDiskUsage = [];
  configRoll.clear();
  disruptionObservations.clear();
  disruptionLastObservedMs = null;
  sharedGatewayMaxCapacity = 0;
  sharedGatewayCapacitySnapshot = {
    assignmentCount: 0,
    hotMemberCount: 0,
  };
  disruptionSnapshot = {
    spotNodes: 0,
    onDemandNodes: 0,
    unknownNodes: 0,
    gatewayPods: 0,
    pendingGatewayPods: 0,
  };
}

export function recordConfigRoll(sample: ConfigRollSample): void {
  const key = [sample.gatewayId, sample.revisionId, sample.stage, sample.result].join("\0");
  configRoll.set(key, (configRoll.get(key) ?? 0) + 1);
}

export function recordGatewayHealth(samples: GatewayHealthSample[]): void {
  gatewayHealth = samples.map((sample) => ({
    gatewayId: sample.gatewayId,
    availableReplicas: Math.max(0, Math.trunc(sample.availableReplicas)),
  }));
}

export function recordVmDiskUsage(samples: VmDiskUsageSample[]): void {
  vmDiskUsage = samples.map((sample) => ({
    gatewayId: sample.gatewayId,
    sizeBytes: Math.max(0, Math.trunc(sample.sizeBytes)),
    freeBytes: Math.max(0, Math.trunc(sample.freeBytes)),
    observedAt: sample.observedAt,
  }));
}

function disruptionObservationKey(sample: DisruptionObservationSample): string {
  return [sample.cause, sample.source, sample.capacityClass, sample.namespace].join("\0");
}

export function initializeDisruptionObservation(sample: DisruptionObservationSample): void {
  const key = disruptionObservationKey(sample);
  if (!disruptionObservations.has(key)) disruptionObservations.set(key, 0);
}

export function recordDisruptionObservation(sample: DisruptionObservationSample): void {
  const key = disruptionObservationKey(sample);
  disruptionObservations.set(key, (disruptionObservations.get(key) ?? 0) + 1);
  disruptionLastObservedMs = sample.now ?? Date.now();
}

export function recordDisruptionSnapshot(sample: DisruptionSnapshotSample): void {
  disruptionSnapshot = {
    spotNodes: Math.max(0, Math.trunc(sample.spotNodes)),
    onDemandNodes: Math.max(0, Math.trunc(sample.onDemandNodes)),
    unknownNodes: Math.max(0, Math.trunc(sample.unknownNodes)),
    gatewayPods: Math.max(0, Math.trunc(sample.gatewayPods)),
    pendingGatewayPods: Math.max(0, Math.trunc(sample.pendingGatewayPods)),
  };
  disruptionLastObservedMs = sample.now ?? Date.now();
}

export function recordSharedPoolReplicaBounds(bounds: { minReplicas: number; maxReplicas: number }): void {
  sharedPoolReplicaBounds = {
    minReplicas: Math.max(0, Math.trunc(bounds.minReplicas)),
    maxReplicas: Math.max(0, Math.trunc(bounds.maxReplicas)),
  };
}

export function recordSharedGatewayMaxCapacity(
  sample: SharedGatewayMaxCapacitySample,
): void {
  sharedGatewayMaxCapacity += 1;
  sharedGatewayCapacitySnapshot = {
    assignmentCount: Math.max(0, Math.trunc(sample.assignmentCount)),
    hotMemberCount: Math.max(0, Math.trunc(sample.hotMemberCount)),
  };
}

export function renderMetrics(): string {
  const lastSuccessSec = lastSuccessMs == null ? 0 : lastSuccessMs / 1000;
  return [
    "# HELP glm_reconcile_total Fleet reconcile ticks by result.",
    "# TYPE glm_reconcile_total counter",
    `glm_reconcile_total{result="ok"} ${reconcileOk}`,
    `glm_reconcile_total{result="fail"} ${reconcileFail}`,
    "# HELP glm_reconcile_last_success_timestamp_seconds Unix time of the last successful reconcile tick.",
    "# TYPE glm_reconcile_last_success_timestamp_seconds gauge",
    `glm_reconcile_last_success_timestamp_seconds ${lastSuccessSec.toFixed(3)}`,
    "# HELP glm_gateway_available_replicas Available Kubernetes replicas for each desired-running gateway.",
    "# TYPE glm_gateway_available_replicas gauge",
    ...gatewayHealth.map(
      (sample) =>
        `glm_gateway_available_replicas{gateway_id="${escapeLabel(sample.gatewayId)}"} ${sample.availableReplicas}`,
    ),
    "# HELP glm_gateway_desired_running_unavailable Desired-running gateway has no available Kubernetes replica.",
    "# TYPE glm_gateway_desired_running_unavailable gauge",
    ...gatewayHealth.map(
      (sample) =>
        `glm_gateway_desired_running_unavailable{gateway_id="${escapeLabel(sample.gatewayId)}"} ${
          sample.availableReplicas > 0 ? 0 : 1
        }`,
    ),
    "# HELP glm_gateway_vm_disk_size_bytes Boot disk filesystem size reported by each running gateway VM.",
    "# TYPE glm_gateway_vm_disk_size_bytes gauge",
    ...vmDiskUsage.map((sample) => `glm_gateway_vm_disk_size_bytes{gateway_id="${escapeLabel(sample.gatewayId)}"} ${sample.sizeBytes}`),
    "# HELP glm_gateway_vm_disk_free_bytes Boot disk filesystem bytes still free on each running gateway VM.",
    "# TYPE glm_gateway_vm_disk_free_bytes gauge",
    ...vmDiskUsage.map((sample) => `glm_gateway_vm_disk_free_bytes{gateway_id="${escapeLabel(sample.gatewayId)}"} ${sample.freeBytes}`),
    "# HELP glm_gateway_vm_disk_observed_timestamp_seconds Unix time of each running gateway VM's last disk report.",
    "# TYPE glm_gateway_vm_disk_observed_timestamp_seconds gauge",
    ...vmDiskUsage.map((sample) => `glm_gateway_vm_disk_observed_timestamp_seconds{gateway_id="${escapeLabel(sample.gatewayId)}"} ${(sample.observedAt / 1000).toFixed(3)}`),
    "# HELP glm_config_roll_total Durable config roll fencing outcomes.",
    "# TYPE glm_config_roll_total counter",
    ...[...configRoll.entries()].map(([key, count]) => {
      const [gatewayId, revisionId, stage, result] = key.split("\0");
      return `glm_config_roll_total{gateway_id="${escapeLabel(gatewayId)}",revision_id="${escapeLabel(revisionId)}",stage="${stage}",result="${result}"} ${count}`;
    }),
    "# HELP glm_disruption_observations_total Kubernetes disruption observations emitted by the controller.",
    "# TYPE glm_disruption_observations_total counter",
    ...[...disruptionObservations.entries()].map(([key, count]) => {
      const [cause, source, capacityClass, namespace] = key.split("\0");
      return `glm_disruption_observations_total{cause="${escapeLabel(cause)}",source="${escapeLabel(source)}",capacity_class="${escapeLabel(capacityClass)}",namespace="${escapeLabel(namespace)}"} ${count}`;
    }),
    "# HELP glm_disruption_last_observed_timestamp_seconds Unix time of the last disruption observer observation.",
    "# TYPE glm_disruption_last_observed_timestamp_seconds gauge",
    `glm_disruption_last_observed_timestamp_seconds ${disruptionLastObservedMs == null ? "0.000" : (disruptionLastObservedMs / 1000).toFixed(3)}`,
    "# HELP glm_disruption_nodes Current node capacity classification observed by the disruption observer.",
    "# TYPE glm_disruption_nodes gauge",
    `glm_disruption_nodes{capacity_class="spot"} ${disruptionSnapshot.spotNodes}`,
    `glm_disruption_nodes{capacity_class="on-demand"} ${disruptionSnapshot.onDemandNodes}`,
    `glm_disruption_nodes{capacity_class="unknown"} ${disruptionSnapshot.unknownNodes}`,
    "# HELP glm_disruption_gateway_pods Current gateway pods observed by the disruption observer.",
    "# TYPE glm_disruption_gateway_pods gauge",
    `glm_disruption_gateway_pods ${disruptionSnapshot.gatewayPods}`,
    "# HELP glm_disruption_pending_gateway_pods Current Pending gateway pods observed by the disruption observer.",
    "# TYPE glm_disruption_pending_gateway_pods gauge",
    `glm_disruption_pending_gateway_pods ${disruptionSnapshot.pendingGatewayPods}`,
    "# HELP octogee_shared_pool_min_replicas The shared pool floor the fleet controller converges to for this environment.",
    "# TYPE octogee_shared_pool_min_replicas gauge",
    `octogee_shared_pool_min_replicas ${sharedPoolReplicaBounds.minReplicas}`,
    "# HELP octogee_shared_pool_max_replicas The shared pool ceiling the fleet controller will mint slots up to for this environment.",
    "# TYPE octogee_shared_pool_max_replicas gauge",
    `octogee_shared_pool_max_replicas ${sharedPoolReplicaBounds.maxReplicas}`,
    "# HELP glm_shared_gateway_max_capacity_total Shared pool scaler observations at the replica ceiling.",
    "# TYPE glm_shared_gateway_max_capacity_total counter",
    `glm_shared_gateway_max_capacity_total ${sharedGatewayMaxCapacity}`,
    "# HELP glm_shared_gateway_assignment_count Assigned users observed when the Shared gateway most recently reached maximum capacity.",
    "# TYPE glm_shared_gateway_assignment_count gauge",
    `glm_shared_gateway_assignment_count ${sharedGatewayCapacitySnapshot.assignmentCount}`,
    "# HELP glm_shared_gateway_hot_members Running Shared gateway members observed when the pool most recently reached maximum capacity.",
    "# TYPE glm_shared_gateway_hot_members gauge",
    `glm_shared_gateway_hot_members ${sharedGatewayCapacitySnapshot.hotMemberCount}`,
    "",
  ].join("\n");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
