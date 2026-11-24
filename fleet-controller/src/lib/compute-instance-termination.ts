import type { ComputeRequest } from "./compute-vm.js";

export interface ComputeInstanceIdentity {
  projectId: string;
  zone: string;
  name: string;
  instanceId: string;
}

export interface ComputeTerminationWindow {
  since: number;
  through: number;
}

const PREEMPTION_METHOD = "compute.instances.preempted";
const DELETE_METHOD = "v1.compute.instances.delete";
const COMPUTE_SERVICE = "compute.googleapis.com";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function auditLogName(projectId: string, kind: "system_event" | "activity"): string {
  return `projects/${projectId}/logs/cloudaudit.googleapis.com%2F${kind}`;
}

function matchesComputeResourceName(resourceName: unknown, { projectId, zone, name }: ComputeInstanceIdentity): boolean {
  if (typeof resourceName !== "string") return false;
  const [kind, project, ...path] = resourceName.split("/");
  return kind === "projects" && (project === projectId || /^\d+$/u.test(project)) && path.join("/") === `zones/${zone}/instances/${name}`;
}

function isTerminalEvent(entry: Record<string, unknown>, audit: Record<string, unknown>, projectId: string): boolean {
  if (audit.methodName === PREEMPTION_METHOD) return entry.logName === auditLogName(projectId, "system_event");
  return audit.methodName === DELETE_METHOD && entry.logName === auditLogName(projectId, "activity") &&
    record(entry.operation).last === true;
}

function matchesTermination(value: unknown, instance: ComputeInstanceIdentity, { since, through }: ComputeTerminationWindow): boolean {
  const entry = record(value);
  const resource = record(entry.resource);
  const labels = record(resource.labels);
  const audit = record(entry.protoPayload);
  const status = record(audit.status);
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return resource.type === "gce_instance" &&
    labels.project_id === instance.projectId && labels.zone === instance.zone && labels.instance_id === instance.instanceId &&
    audit.serviceName === COMPUTE_SERVICE && isTerminalEvent(entry, audit, instance.projectId) &&
    matchesComputeResourceName(audit.resourceName, instance) && (status.code === undefined || status.code === 0) &&
    at >= since && at <= through;
}

export async function readComputeInstanceTermination(
  request: ComputeRequest, instance: ComputeInstanceIdentity, window: ComputeTerminationWindow,
): Promise<boolean> {
  const { since, through } = window;
  if (!Number.isSafeInteger(since) || !Number.isSafeInteger(through) || since <= 0 || through < since) return false;
  const { projectId, instanceId, zone } = instance;
  const preempted = `logName=${JSON.stringify(auditLogName(projectId, "system_event"))} AND protoPayload.methodName=${JSON.stringify(PREEMPTION_METHOD)}`;
  const deleted = `logName=${JSON.stringify(auditLogName(projectId, "activity"))} AND protoPayload.methodName=${JSON.stringify(DELETE_METHOD)} AND operation.last=true`;
  const filter = [
    `((${preempted}) OR (${deleted}))`,
    'resource.type="gce_instance"',
    `resource.labels.project_id=${JSON.stringify(projectId)}`,
    `resource.labels.zone=${JSON.stringify(zone)}`,
    `resource.labels.instance_id=${JSON.stringify(instanceId)}`,
    `protoPayload.serviceName=${JSON.stringify(COMPUTE_SERVICE)}`,
    `timestamp>=${JSON.stringify(new Date(since).toISOString())}`,
    `timestamp<=${JSON.stringify(new Date(through).toISOString())}`,
  ].join(" AND ");
  const response = await request({ url: "https://logging.googleapis.com/v2/entries:list", method: "POST",
    body: { resourceNames: [`projects/${projectId}`], filter, orderBy: "timestamp desc", pageSize: 10 } });
  if (response.status !== 200) throw new Error(`Compute termination audit lookup returned HTTP ${response.status}`);
  const entries = record(response.data).entries;
  return Array.isArray(entries) && entries.some(entry => matchesTermination(entry, instance, window));
}
