import {
  OWNER_AUTOMATION_KEY,
  OWNER_AUTOMATION_TOOLS,
  ownerAutomationAccountId as accountId,
  ownerAutomationDefinition,
  ownerAutomationKeyPrefix as keyPrefix,
  ownerAutomationSessionKey as ownerSessionKey,
  type OwnerAutomationSave,
  type OwnerAutomationTenant,
} from "@octogee/shared/types/automations";
import {
  AutomationBrokerError,
  automationRecord,
  scanAutomationInventory,
  type AutomationInvoke,
  type AutomationRecord,
} from "./automation-native.js";

export { OWNER_AUTOMATION_KEY_PREFIX, OWNER_AUTOMATION_TOOLS, ownerAutomationDefinition } from "@octogee/shared/types/automations";
export type { OwnerAutomationSave, OwnerAutomationTenant } from "@octogee/shared/types/automations";

export type OwnerAutomationRequest =
  | { action: "list" }
  | { action: "save"; params: OwnerAutomationSave }
  | { action: "remove"; params: { key: string } };

export const MAX_OWNER_AUTOMATIONS = 10;

const CRON_MINUTE = /^(?:\d|[1-5]\d)$/u;
const CRON_FIELD = /^[0-9A-Za-z*,/-]{1,40}$/u;
const MAX_NAME = 100;
const MAX_PROMPT = 4_000;

function fail(status: number, code: string): never {
  throw new AutomationBrokerError(status, code);
}

function exactKeys(value: AutomationRecord, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && allowed.every((key) => keys.includes(key));
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function cronExpression(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const fields = value.trim().split(/\s+/u);
  if (fields.length !== 5 || !CRON_MINUTE.test(fields[0]!)) return null;
  return fields.slice(1).every((field) => CRON_FIELD.test(field)) ? fields.join(" ") : null;
}

function automationKey(value: unknown): string | null {
  return typeof value === "string" && OWNER_AUTOMATION_KEY.test(value) ? value : null;
}

function saveParams(params: AutomationRecord): OwnerAutomationSave {
  const schedule = automationRecord(params.schedule);
  if (!exactKeys(params, ["key", "name", "schedule", "prompt"]) || !schedule || !exactKeys(schedule, ["expr", "tz"])) {
    fail(400, "invalid_owner_automation");
  }
  const key = automationKey(params.key);
  const name = boundedText(params.name, MAX_NAME);
  const prompt = boundedText(params.prompt, MAX_PROMPT);
  const expr = cronExpression(schedule.expr);
  const tz = typeof schedule.tz === "string" && validTimeZone(schedule.tz) ? schedule.tz : null;
  if (!key || !name || !prompt) fail(400, "invalid_owner_automation");
  if (!expr) fail(400, "owner_automation_schedule_unsupported");
  if (!tz) fail(400, "owner_automation_time_zone_invalid");
  return { key, name, prompt, schedule: { expr, tz } };
}

export function parseOwnerAutomationRequest(action: unknown, params: unknown): OwnerAutomationRequest {
  const record = automationRecord(params);
  if (!record) fail(400, "invalid_owner_automation");
  if (action === "list") {
    if (!exactKeys(record, [])) fail(400, "invalid_owner_automation");
    return { action };
  }
  if (action === "remove") {
    const key = automationKey(record.key);
    if (!exactKeys(record, ["key"]) || !key) fail(400, "invalid_owner_automation");
    return { action, params: { key } };
  }
  if (action === "save") return { action, params: saveParams(record) };
  return fail(400, "unsupported_owner_automation_action");
}

function exactTools(value: unknown): boolean {
  return Array.isArray(value) && value.length === OWNER_AUTOMATION_TOOLS.length &&
    OWNER_AUTOMATION_TOOLS.every((tool) => value.includes(tool));
}

function managedPayload(job: AutomationRecord): boolean {
  const payload = automationRecord(job.payload);
  return payload?.kind === "agentTurn" && exactTools(payload.toolsAllow) && payload.toolsAllowIsDefault !== true &&
    payload.model === undefined && payload.fallbacks === undefined && payload.allowUnsafeExternalContent === undefined;
}

function managedOwner(job: AutomationRecord, tenant: OwnerAutomationTenant): boolean {
  const owner = automationRecord(job.owner), policy = automationRecord(job.scheduledToolPolicy);
  return owner?.agentId === tenant.agentId && owner.sessionKey === ownerSessionKey(tenant) && owner.accountId === accountId(tenant) &&
    policy?.version === 1 && policy.mode === "account" && policy.ownerSessionKey === ownerSessionKey(tenant) && policy.ownerAccountId === accountId(tenant);
}

function managedDelivery(job: AutomationRecord, tenant: OwnerAutomationTenant): boolean {
  const delivery = automationRecord(job.delivery);
  return delivery?.mode === "announce" && delivery.channel === "mattermost" && delivery.accountId === accountId(tenant) &&
    delivery.to === `channel:${tenant.coachChannelId}` && delivery.failureDestination === undefined && delivery.completionDestination === undefined;
}

function managedRouting(job: AutomationRecord, tenant: OwnerAutomationTenant): boolean {
  return managedOwner(job, tenant) && managedDelivery(job, tenant) && automationRecord(job.schedule)?.kind === "cron";
}

export function isManagedOwnerAutomation(job: AutomationRecord, tenant: OwnerAutomationTenant): boolean {
  return typeof job.declarationKey === "string" && job.declarationKey.startsWith(keyPrefix(tenant)) &&
    job.agentId === tenant.agentId && (job.effectiveAgentId === undefined || job.effectiveAgentId === tenant.agentId) &&
    job.sessionTarget === "isolated" && job.sessionKey === undefined && job.trigger === undefined &&
    (job.failureAlert === undefined || job.failureAlert === false) &&
    managedPayload(job) && managedRouting(job, tenant);
}

function summary(job: AutomationRecord, tenant: OwnerAutomationTenant): AutomationRecord {
  const schedule = automationRecord(job.schedule);
  return {
    key: String(job.declarationKey).slice(keyPrefix(tenant).length),
    name: job.displayName ?? job.name,
    schedule: { expr: schedule?.expr, tz: schedule?.tz },
    enabled: job.enabled,
    nextRunAtMs: job.nextRunAtMs ?? null,
    lastRunStatus: job.lastRunStatus ?? null,
  };
}

async function tenantKeyedJobs(invoke: AutomationInvoke, tenant: OwnerAutomationTenant): Promise<AutomationRecord[]> {
  const prefix = keyPrefix(tenant);
  const { jobs } = await scanAutomationInventory(invoke, (job) =>
    typeof job.declarationKey === "string" && job.declarationKey.startsWith(prefix));
  return jobs;
}

async function save(invoke: AutomationInvoke, tenant: OwnerAutomationTenant, params: OwnerAutomationSave): Promise<unknown> {
  const definition = ownerAutomationDefinition(tenant, params);
  const jobs = await tenantKeyedJobs(invoke, tenant);
  const existing = jobs.find((job) => job.declarationKey === definition.declarationKey);
  if (existing && !isManagedOwnerAutomation(existing, tenant)) fail(409, "owner_automation_key_unavailable");
  const others = jobs.filter((job) => job !== existing && isManagedOwnerAutomation(job, tenant));
  if (others.length >= MAX_OWNER_AUTOMATIONS) fail(409, "owner_automation_limit");
  const result = automationRecord(await invoke("cron.add", definition));
  const job = automationRecord(result?.job) ?? result;
  if (!job || typeof job.id !== "string") fail(502, "invalid_native_automation_result");
  if (!isManagedOwnerAutomation(job, tenant)) {
    await invoke("cron.remove", { id: job.id });
    fail(502, "owner_automation_shape_rejected");
  }
  return { created: result?.created ?? !existing, automation: summary(job, tenant) };
}

async function remove(invoke: AutomationInvoke, tenant: OwnerAutomationTenant, key: string): Promise<unknown> {
  const declarationKey = `${keyPrefix(tenant)}${key}`;
  const job = (await tenantKeyedJobs(invoke, tenant))
    .find((candidate) => candidate.declarationKey === declarationKey && isManagedOwnerAutomation(candidate, tenant));
  if (!job) fail(404, "owner_automation_not_found");
  await invoke("cron.remove", { id: job.id, expectedConfigRevision: job.configRevision });
  return { removed: true, key };
}

const tenantQueues = new Map<string, Promise<unknown>>();

function serialized<T>(tenant: OwnerAutomationTenant, work: () => Promise<T>): Promise<T> {
  const previous = tenantQueues.get(tenant.agentId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  const tail = next.catch(() => undefined);
  tenantQueues.set(tenant.agentId, tail);
  void tail.then(() => {
    if (tenantQueues.get(tenant.agentId) === tail) tenantQueues.delete(tenant.agentId);
  });
  return next;
}

export async function executeOwnerAutomation(
  invoke: AutomationInvoke,
  tenant: OwnerAutomationTenant,
  request: OwnerAutomationRequest,
): Promise<unknown> {
  if (request.action === "list") {
    const jobs = (await tenantKeyedJobs(invoke, tenant)).filter((job) => isManagedOwnerAutomation(job, tenant));
    return { automations: jobs.map((job) => summary(job, tenant)) };
  }
  if (request.action === "save") return serialized(tenant, () => save(invoke, tenant, request.params));
  return serialized(tenant, () => remove(invoke, tenant, request.params.key));
}
