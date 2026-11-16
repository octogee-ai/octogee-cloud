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
let placementAutomation: PlacementAutomationMetricSample | null = null;
let disruptionSnapshot = {
  spotNodes: 0,
  onDemandNodes: 0,
  unknownNodes: 0,
  gatewayPods: 0,
  pendingGatewayPods: 0,
};

export interface PlacementAutomationMetricSample {
  owner: "fleet-controller" | "client";
  yieldedAt: number | null;
  phase: "fleet-controller" | "handoff-pending" | "client";
  pendingObservations: number;
}

const PLACEMENT_AUTOMATION_PHASES: ReadonlyArray<Pick<PlacementAutomationMetricSample, "owner" | "phase">> = [
  { owner: "fleet-controller", phase: "fleet-controller" },
  { owner: "client", phase: "handoff-pending" },
  { owner: "client", phase: "client" },
];

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
  placementAutomation = null;
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

export function recordPlacementAutomation(sample: PlacementAutomationMetricSample): void {
  placementAutomation = { ...sample };
}

function placementAutomationLines(): string[] {
  if (placementAutomation === null) return [];
  const current = placementAutomation;
  return [
    "# HELP glm_placement_automation_owner Placement automation owner and handoff phase; 1 marks the current one.",
    "# TYPE glm_placement_automation_owner gauge",
    ...PLACEMENT_AUTOMATION_PHASES.map(({ owner, phase }) =>
      `glm_placement_automation_owner{owner="${owner}",phase="${phase}"} ${current.owner === owner && current.phase === phase ? 1 : 0}`),
    "# HELP glm_placement_automation_yielded_timestamp_seconds Unix time the fleet controller yielded placement automation to the client; 0 when it has not.",
    "# TYPE glm_placement_automation_yielded_timestamp_seconds gauge",
    `glm_placement_automation_yielded_timestamp_seconds ${((current.yieldedAt ?? 0) / 1000).toFixed(3)}`,
    "# HELP glm_placement_automation_handoff_pending_observations Consecutive observations of a handoff to the client still awaiting the fleet controller's yield.",
    "# TYPE glm_placement_automation_handoff_pending_observations gauge",
    `glm_placement_automation_handoff_pending_observations ${current.pendingObservations}`,
  ];
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
    ...placementAutomationLines(),
    "",
  ].join("\n");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
