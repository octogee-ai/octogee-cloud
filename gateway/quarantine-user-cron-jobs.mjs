#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OCTOGEE_WORKFLOW_TOOLS } from "./workflow-tools.mjs";

const HOST_EXEC_SCHEDULES = new Set(["stream", "on-exit"]);
const HOST_EXEC_PAYLOADS = new Set(["script", "command"]);
const SAFE_MODELS = new Set([
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "platform-openrouter/z-ai/glm-5.2",
  "platform-openrouter/minimax/minimax-m3",
  "platform-openrouter/deepseek/deepseek-v4-pro",
  "platform-openrouter/openai/gpt-5.6-luna",
  "platform-openai/gpt-5.4-mini",
  "platform-openai/gpt-6-luna",
  "platform-openai/gpt-6.1-terra",
  "platform-openai/gpt-6.1-sol",
]);
const SAFE_SCHEDULED_TOOLS = new Set([
  ...OCTOGEE_WORKFLOW_TOOLS,
  "ls",
  "read",
  "write",
  "edit",
  "apply_patch",
  "web_search",
  "web_fetch",
  "brave_search",
  "tavily_search",
  "tavily_extract",
  "code_execution",
  "secrets",
  "x_search",
  "memory_search",
  "memory_get",
  "sessions",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_send",
  "agents_wait",
  "sessions_yield",
  "session_status",
  "suggest_task",
  "dismiss_task",
  "screen",
  "dashboard",
  "portal",
  "github_identity_status",
  "github_publish",
  "get_goal",
  "create_goal",
  "update_goal",
  "progress_card",
  "ask_user",
  "view_image",
  "image_generate",
  "music_generate",
  "video_generate",
]);
const SAFE_SESSION_TARGETS = new Set(["main", "isolated", "current"]);
const USER_AGENT_ID = /^octogee-[a-z0-9-]+(?:-proj-[a-z0-9-]+)?-coach$/;
const WEBHOOK_DESTINATION_REASON = "webhook-destination";
const REQUIRED_CRON_COLUMNS = [
  "store_key", "job_id", "owner_agent_id", "agent_id", "payload_kind", "job_json", "updated_at",
];

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function tableExists(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function accountIdForAgent(agentId) {
  if (typeof agentId !== "string" || !USER_AGENT_ID.test(agentId)) return null;
  const body = agentId.slice("octogee-".length, -"-coach".length);
  return body.includes("-proj-") ? body : `${body}-coach`;
}

function configuredAgentAccounts(config) {
  const accountIds = new Set(Object.keys(objectValue(config.channels?.mattermost?.accounts) ?? {}));
  const bindings = new Map();
  const add = (agentId) => {
    const accountId = accountIdForAgent(agentId);
    if (accountId && accountIds.has(accountId)) bindings.set(agentId, accountId);
  };
  if (Array.isArray(config.agents?.list)) {
    for (const entry of config.agents.list) add(objectValue(entry)?.id);
  }
  const entries = objectValue(config.agents?.entries);
  if (entries) {
    for (const agentId of Object.keys(entries)) add(agentId);
  }
  return bindings;
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function jsonValue(value) {
  return value == null ? null : JSON.stringify(value);
}

function recordValue(record, key) {
  return record === null ? null : record[key] ?? null;
}

function policyFields(job) {
  const owner = objectValue(job.owner);
  const schedule = objectValue(job.schedule);
  const trigger = objectValue(job.trigger);
  const payload = objectValue(job.payload);
  const delivery = objectValue(job.delivery);
  const completion = objectValue(recordValue(delivery, "completionDestination"));
  const failureDelivery = objectValue(recordValue(delivery, "failureDestination"));
  const failureAlert = objectValue(job.failureAlert);
  return {
    owner_session_key: recordValue(owner, "sessionKey"),
    session_key: recordValue(job, "sessionKey"),
    session_target: recordValue(job, "sessionTarget"),
    schedule_kind: recordValue(schedule, "kind"),
    trigger_script: recordValue(trigger, "script"),
    payload_model: recordValue(payload, "model"),
    payload_fallbacks_json: jsonValue(recordValue(payload, "fallbacks")),
    payload_allow_unsafe_external_content: recordValue(payload, "allowUnsafeExternalContent"),
    payload_tools_allow_json: jsonValue(recordValue(payload, "toolsAllow")),
    delivery_mode: recordValue(delivery, "mode"),
    delivery_channel: recordValue(delivery, "channel"),
    delivery_to: recordValue(delivery, "to"),
    delivery_account_id: recordValue(delivery, "accountId"),
    delivery_completion_mode: recordValue(completion, "mode"),
    delivery_completion_to: recordValue(completion, "to"),
    delivery_completion_present: delivery != null && Object.hasOwn(delivery, "completionDestination"),
    failure_delivery_mode: recordValue(failureDelivery, "mode"),
    failure_delivery_channel: recordValue(failureDelivery, "channel"),
    failure_delivery_to: recordValue(failureDelivery, "to"),
    failure_delivery_account_id: recordValue(failureDelivery, "accountId"),
    failure_alert_channel: recordValue(failureAlert, "channel"),
    failure_alert_to: recordValue(failureAlert, "to"),
    failure_alert_mode: recordValue(failureAlert, "mode"),
    failure_alert_account_id: recordValue(failureAlert, "accountId"),
  };
}

function cronPolicyRow(row) {
  const job = objectValue(parseJson(row.job_json));
  return job ? { ...row, ...policyFields(job) } : row;
}

function parseMattermostSession(sessionKey) {
  if (typeof sessionKey !== "string") return null;
  const match = /^agent:([^:]+):mattermost:(direct|group|channel):([^:]+)(?::thread:[^:]+)?$/i.exec(sessionKey);
  return match ? { agentId: match[1].toLowerCase(), kind: match[2].toLowerCase(), peerId: match[3] } : null;
}

function sessionOwnedBy(sessionKey, agentId) {
  return typeof sessionKey === "string" && sessionKey.startsWith(`agent:${agentId}:`);
}

const NATIVE_TARGET_PREFIX = { direct: "user", group: "channel", channel: "channel" };

function destinationMatchesSession(value, route) {
  return value == null ||
    value === route.peerId ||
    value === `mattermost:${route.kind}:${route.peerId}` ||
    value === `${NATIVE_TARGET_PREFIX[route.kind]}:${route.peerId}`;
}

function safeModelList(raw) {
  if (raw == null) return true;
  const parsed = parseJson(raw);
  return Array.isArray(parsed) && parsed.every((model) => typeof model === "string" && SAFE_MODELS.has(model));
}

function safeToolList(raw) {
  if (raw == null) return true;
  const parsed = parseJson(raw);
  return Array.isArray(parsed) &&
    new Set(parsed).size === parsed.length &&
    parsed.every((tool) => typeof tool === "string" && SAFE_SCHEDULED_TOOLS.has(tool));
}

function firstQuarantineReason(checks) {
  return checks.find(([unsafe]) => unsafe)?.[1] ?? null;
}

function payloadQuarantineReason(row) {
  return firstQuarantineReason([
    [HOST_EXEC_SCHEDULES.has(row.schedule_kind), "host-exec-schedule"],
    [HOST_EXEC_PAYLOADS.has(row.payload_kind), "host-exec-payload"],
    [row.trigger_script != null, "trigger-script"],
    [row.payload_allow_unsafe_external_content === true, "unsafe-external-content"],
    [row.payload_allow_unsafe_external_content != null &&
      typeof row.payload_allow_unsafe_external_content !== "boolean", "invalid-unsafe-external-content"],
    [row.payload_model != null && !SAFE_MODELS.has(row.payload_model), "unsafe-model"],
    [!safeModelList(row.payload_fallbacks_json), "unsafe-fallbacks"],
    [!safeToolList(row.payload_tools_allow_json), "unsafe-tools"],
    [!SAFE_SESSION_TARGETS.has(row.session_target), "unsafe-session-target"],
  ]);
}

function resolveRowAuthority(row, bindings) {
  const effectiveAgentId = row.agent_id;
  const accountId = bindings.get(effectiveAgentId);
  if (!accountId) return { reason: "unconfigured-agent" };
  const ownershipReason = firstQuarantineReason([
    [row.owner_agent_id !== effectiveAgentId, "owner-agent-mismatch"],
    [!sessionOwnedBy(row.owner_session_key, effectiveAgentId), "owner-session-mismatch"],
    [row.session_key != null && !sessionOwnedBy(row.session_key, effectiveAgentId), "session-mismatch"],
  ]);
  if (ownershipReason) return { reason: ownershipReason };
  const route = parseMattermostSession(row.owner_session_key);
  if (!route || route.agentId !== effectiveAgentId) {
    return { reason: "non-mattermost-owner-session" };
  }
  return { accountId, effectiveAgentId, route };
}

function jobAuthorityReason(row, job, authority) {
  const { accountId, effectiveAgentId } = authority;
  const owner = objectValue(job.owner);
  const ownerMismatch = owner?.agentId !== effectiveAgentId ||
    owner.sessionKey !== row.owner_session_key ||
    owner.accountId !== accountId;
  if (ownerMismatch) return "job-owner-mismatch";
  if (job.agentId !== effectiveAgentId || (job.sessionKey ?? null) !== row.session_key) {
    return "job-routing-mismatch";
  }
  const scheduledPolicy = objectValue(job.scheduledToolPolicy);
  const scheduledAuthorityMismatch = row.payload_tools_allow_json != null && (
    scheduledPolicy?.version !== 1 ||
    scheduledPolicy?.mode !== "account" ||
    scheduledPolicy.ownerSessionKey !== row.owner_session_key ||
    scheduledPolicy.ownerAccountId !== accountId
  );
  if (scheduledAuthorityMismatch) {
    return "scheduled-authority-mismatch";
  }
  return null;
}

function firstFieldMismatch(row, fields, expected) {
  const field = fields.find((key) => row[key] != null && row[key] !== expected);
  return field ? `${field.replaceAll("_", "-")}-mismatch` : null;
}

function deliveryQuarantineReason(row, authority) {
  const accountMismatch = firstFieldMismatch(
    row,
    ["delivery_account_id", "failure_delivery_account_id", "failure_alert_account_id"],
    authority.accountId,
  );
  const channelMismatch = firstFieldMismatch(
    row,
    ["delivery_channel", "failure_delivery_channel", "failure_alert_channel"],
    "mattermost",
  );
  return accountMismatch ?? channelMismatch ?? firstQuarantineReason([
    [!destinationMatchesSession(row.delivery_to, authority.route), "delivery-destination-mismatch"],
    [!destinationMatchesSession(row.failure_delivery_to, authority.route), "failure-delivery-destination-mismatch"],
    [!destinationMatchesSession(row.failure_alert_to, authority.route), "failure-alert-destination-mismatch"],
    [row.delivery_mode === "webhook", WEBHOOK_DESTINATION_REASON],
    [row.failure_delivery_mode === "webhook", WEBHOOK_DESTINATION_REASON],
    [row.failure_alert_mode === "webhook", WEBHOOK_DESTINATION_REASON],
    [row.delivery_completion_present, WEBHOOK_DESTINATION_REASON],
  ]);
}

function rowQuarantineReason(row, bindings) {
  const job = objectValue(parseJson(row.job_json));
  if (!job) return "invalid-job-json";
  const owner = objectValue(job.owner);
  const payload = objectValue(job.payload);
  const shadowReason = firstQuarantineReason([
    [job.id !== row.job_id, "job-id-shadow-mismatch"],
    [owner?.agentId !== row.owner_agent_id, "owner-agent-shadow-mismatch"],
    [job.agentId !== row.agent_id, "agent-shadow-mismatch"],
    [payload?.kind !== row.payload_kind, "payload-kind-shadow-mismatch"],
  ]);
  if (shadowReason) return shadowReason;
  const payloadReason = payloadQuarantineReason(row);
  if (payloadReason) return payloadReason;
  const authority = resolveRowAuthority(row, bindings);
  if (authority.reason) return authority.reason;
  const jobReason = jobAuthorityReason(row, job, authority);
  return jobReason ?? deliveryQuarantineReason(row, authority);
}

function readQuarantine(file) {
  if (!fs.existsSync(file)) return { version: 1, jobs: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.jobs)) {
    throw new Error(`invalid user cron quarantine file: ${file}`);
  }
  return parsed;
}

function writeQuarantine(file, rows) {
  const current = readQuarantine(file);
  const jobs = new Map(current.jobs.map((job) => [`${job.storeKey}\u0000${job.jobId}`, job]));
  const quarantinedAt = new Date().toISOString();
  for (const row of rows) {
    jobs.set(`${row.store_key}\u0000${row.job_id}`, {
      storeKey: row.store_key,
      jobId: row.job_id,
      reason: row.quarantine_reason,
      scheduleKind: row.schedule_kind,
      payloadKind: row.payload_kind,
      triggerScript: row.trigger_script,
      jobJson: row.job_json,
      updatedAt: row.updated_at,
      quarantinedAt,
    });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, jobs: [...jobs.values()] }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function assertCronSafetyColumns(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(cron_jobs)").all().map((row) => row.name));
  for (const column of REQUIRED_CRON_COLUMNS) {
    if (!columns.has(column)) {
      throw new Error(`cron_jobs is missing required safety column ${column}`);
    }
  }
}

function readUnsafeCronRows(db, bindings) {
  const rows = db.prepare(`SELECT ${REQUIRED_CRON_COLUMNS.join(", ")} FROM cron_jobs`).all();
  return rows.flatMap((row) => {
    const policyRow = cronPolicyRow(row);
    const reason = rowQuarantineReason(policyRow, bindings);
    return reason ? [{ ...policyRow, quarantine_reason: reason }] : [];
  });
}

function removeQuarantinedRows(db, rows) {
  const removeJob = db.prepare("DELETE FROM cron_jobs WHERE store_key = ? AND job_id = ?");
  const removeScratch = tableExists(db, "cron_job_scratch")
    ? db.prepare("DELETE FROM cron_job_scratch WHERE store_key = ? AND job_id = ?")
    : null;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      removeScratch?.run(row.store_key, row.job_id);
      removeJob.run(row.store_key, row.job_id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function quarantineUserCronJobs(env = process.env, log = console.log) {
  const openclawDir = env.OPENCLAW_DIR ?? "/home/node/.openclaw";
  const stateRoot = env.OPENCLAW_STATE_DIR?.trim() || openclawDir;
  const databasePath = path.join(stateRoot, "state", "openclaw.sqlite");
  if (!fs.existsSync(databasePath)) return { removed: 0, skipped: "missing-database" };

  const db = new DatabaseSync(databasePath);
  try {
    if (!tableExists(db, "cron_jobs")) return { removed: 0, skipped: "missing-table" };
    assertCronSafetyColumns(db);
    const configPath = env.OPENCLAW_CONFIG_PATH?.trim() || path.join(openclawDir, "openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const bindings = configuredAgentAccounts(config);
    const quarantined = readUnsafeCronRows(db, bindings);
    if (quarantined.length === 0) return { removed: 0 };

    const quarantinePath = path.join(openclawDir, "cron", "octogee-customer-cron-quarantine.json");
    writeQuarantine(quarantinePath, quarantined);
    removeQuarantinedRows(db, quarantined);
    log(`quarantined ${quarantined.length} unsafe user cron job(s)`);
    return { removed: quarantined.length, quarantinePath };
  } finally {
    db.close();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  quarantineUserCronJobs();
}
