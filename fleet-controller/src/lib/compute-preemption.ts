import type { ComputeRequest } from "./compute-vm.js";

export interface ComputeInstanceIdentity {
  projectId: string;
  zone: string;
  name: string;
  instanceId: string;
}

export interface PreemptionObservationWindow {
  since: number;
  through: number;
}

const PREEMPTION_METHOD = "compute.instances.preempted";
const COMPUTE_SERVICE = "compute.googleapis.com";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function auditLogName(projectId: string): string {
  return `projects/${projectId}/logs/cloudaudit.googleapis.com%2Fsystem_event`;
}

function computeResourceName({ projectId, zone, name }: ComputeInstanceIdentity): string {
  return `projects/${projectId}/zones/${zone}/instances/${name}`;
}

function matchesPreemption(value: unknown, instance: ComputeInstanceIdentity, { since, through }: PreemptionObservationWindow): boolean {
  const entry = record(value);
  const resource = record(entry.resource);
  const labels = record(resource.labels);
  const audit = record(entry.protoPayload);
  const status = record(audit.status);
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return entry.logName === auditLogName(instance.projectId) && resource.type === "gce_instance" &&
    labels.project_id === instance.projectId && labels.zone === instance.zone && labels.instance_id === instance.instanceId &&
    audit.serviceName === COMPUTE_SERVICE && audit.methodName === PREEMPTION_METHOD &&
    audit.resourceName === computeResourceName(instance) && (status.code === undefined || status.code === 0) &&
    at >= since && at <= through;
}

export async function readComputePreemption(
  request: ComputeRequest, instance: ComputeInstanceIdentity, window: PreemptionObservationWindow,
): Promise<boolean> {
  const { since, through } = window;
  if (!Number.isSafeInteger(since) || !Number.isSafeInteger(through) || since <= 0 || through < since) return false;
  const { projectId, instanceId, zone } = instance;
  const filter = [
    `logName=${JSON.stringify(auditLogName(projectId))}`,
    'resource.type="gce_instance"',
    `resource.labels.project_id=${JSON.stringify(projectId)}`,
    `resource.labels.zone=${JSON.stringify(zone)}`,
    `resource.labels.instance_id=${JSON.stringify(instanceId)}`,
    `protoPayload.serviceName=${JSON.stringify(COMPUTE_SERVICE)}`,
    `protoPayload.methodName=${JSON.stringify(PREEMPTION_METHOD)}`,
    `protoPayload.resourceName=${JSON.stringify(computeResourceName(instance))}`,
    `timestamp>=${JSON.stringify(new Date(since).toISOString())}`,
    `timestamp<=${JSON.stringify(new Date(through).toISOString())}`,
  ].join(" AND ");
  const response = await request({ url: "https://logging.googleapis.com/v2/entries:list", method: "POST",
    body: { resourceNames: [`projects/${projectId}`], filter, orderBy: "timestamp desc", pageSize: 10 } });
  if (response.status !== 200) throw new Error(`Compute preemption audit lookup returned HTTP ${response.status}`);
  const entries = record(response.data).entries;
  return Array.isArray(entries) && entries.some(entry => matchesPreemption(entry, instance, window));
}
