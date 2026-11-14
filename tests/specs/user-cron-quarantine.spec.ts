import { spawnSync } from "node:child_process";
import { realpathSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import openclawCodingTools from "../fixtures/openclaw-coding-tools.json";

const repoRoot = path.resolve(__dirname, "../..");
const script = path.join(repoRoot, "infra/gateway/quarantine-user-cron-jobs.mjs");
const template = JSON.parse(readFileSync(path.join(repoRoot, "infra/gateway/openclaw.template.json"), "utf8"));
const defaultAgentTools = [...new Set([...openclawCodingTools, ...template.tools.alsoAllow])]
  .filter((tool) => !template.tools.deny.includes(tool));
const storeKey = "/home/node/.openclaw/cron/jobs.json";
const ceckertAgent = "octogee-ceckert-coach";
const mikeAgent = "octogee-mike-coach";
const ceckertAccount = "ceckert-coach";
const mikeAccount = "mike-coach";
const ceckertSession = `agent:${ceckertAgent}:mattermost:channel:ceckert-channel`;
const mikeSession = `agent:${mikeAgent}:mattermost:channel:mike-channel`;

const simpleTierModels = ["platform-openai/gpt-6-luna", "platform-openai/gpt-6.1-sol", "platform-openai/gpt-6.1-terra"];

type CronRow = Record<string, string | number | null>;

function parsedOrRaw(value: string | number | null) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jobJson(values: CronRow) {
  const scheduleKind = String(values.schedule_kind);
  const schedule = scheduleKind === "stream"
    ? { kind: scheduleKind, command: ["true"] }
    : scheduleKind === "on-exit"
      ? { kind: scheduleKind, command: "true" }
      : { kind: scheduleKind, expr: "0 * * * *" };
  const payloadKind = String(values.payload_kind);
  const payload: Record<string, unknown> = payloadKind === "script"
    ? { kind: payloadKind, script: "return true" }
    : payloadKind === "command"
      ? { kind: payloadKind, argv: ["true"] }
      : payloadKind === "agentTurn"
        ? { kind: payloadKind, message: "hello" }
        : { kind: payloadKind, text: "hello" };
  if (values.payload_model != null) payload.model = values.payload_model;
  if (values.payload_fallbacks_json != null) {
    payload.fallbacks = parsedOrRaw(values.payload_fallbacks_json);
  }
  if (values.payload_allow_unsafe_external_content != null) {
    payload.allowUnsafeExternalContent = values.payload_allow_unsafe_external_content === 1;
  }
  if (values.payload_tools_allow_json != null) {
    payload.toolsAllow = parsedOrRaw(values.payload_tools_allow_json);
  }

  const delivery: Record<string, unknown> = {
    mode: values.delivery_mode,
    channel: values.delivery_channel,
    to: values.delivery_to,
    accountId: values.delivery_account_id,
  };
  if (values.delivery_completion_mode != null || values.delivery_completion_to != null) {
    delivery.completionDestination = {
      mode: values.delivery_completion_mode,
      to: values.delivery_completion_to,
    };
  }
  if (
    values.failure_delivery_mode != null ||
    values.failure_delivery_channel != null ||
    values.failure_delivery_to != null ||
    values.failure_delivery_account_id != null
  ) {
    delivery.failureDestination = {
      mode: values.failure_delivery_mode,
      channel: values.failure_delivery_channel,
      to: values.failure_delivery_to,
      accountId: values.failure_delivery_account_id,
    };
  }
  const failureAlert = values.failure_alert_mode != null ||
    values.failure_alert_channel != null ||
    values.failure_alert_to != null ||
    values.failure_alert_account_id != null
    ? {
        mode: values.failure_alert_mode,
        channel: values.failure_alert_channel,
        to: values.failure_alert_to,
        accountId: values.failure_alert_account_id,
      }
    : undefined;

  return JSON.stringify({
    id: values.job_id,
    name: String(values.job_id),
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: values.updated_at,
    owner: {
      agentId: values.owner_agent_id,
      sessionKey: values.owner_session_key,
      accountId: values.owner_agent_id === mikeAgent ? mikeAccount : ceckertAccount,
    },
    agentId: values.agent_id,
    sessionKey: values.session_key,
    sessionTarget: values.session_target,
    wakeMode: "now",
    schedule,
    payload,
    delivery,
    ...(values.trigger_script != null ? { trigger: { script: values.trigger_script } } : {}),
    ...(failureAlert ? { failureAlert } : {}),
    ...(values.scheduled_tool_policy_json != null
      ? { scheduledToolPolicy: parsedOrRaw(values.scheduled_tool_policy_json) }
      : {}),
    state: {},
  });
}

function row(jobId: string, overrides: Partial<CronRow> = {}): CronRow {
  const values: CronRow = {
    store_key: storeKey,
    job_id: jobId,
    owner_agent_id: ceckertAgent,
    owner_session_key: ceckertSession,
    agent_id: ceckertAgent,
    session_key: ceckertSession,
    session_target: "main",
    schedule_kind: "cron",
    payload_kind: "systemEvent",
    trigger_script: null,
    payload_model: null,
    payload_fallbacks_json: null,
    payload_allow_unsafe_external_content: null,
    payload_tools_allow_json: null,
    delivery_mode: "announce",
    delivery_channel: "mattermost",
    delivery_to: "ceckert-channel",
    delivery_account_id: ceckertAccount,
    delivery_completion_mode: null,
    delivery_completion_to: null,
    failure_delivery_mode: null,
    failure_delivery_channel: null,
    failure_delivery_to: null,
    failure_delivery_account_id: null,
    failure_alert_channel: null,
    failure_alert_to: null,
    failure_alert_mode: null,
    failure_alert_account_id: null,
    scheduled_tool_policy_json: null,
    job_json: "",
    updated_at: 1,
    ...overrides,
  };
  if (!overrides.job_json) {
    values.job_json = jobJson(values);
  }
  return values;
}

function rowWithJobPatch(
  jobId: string,
  patch: Record<string, unknown>,
  overrides: Partial<CronRow> = {},
): CronRow {
  const values = row(jobId, overrides);
  values.job_json = JSON.stringify({ ...JSON.parse(String(values.job_json)), ...patch });
  return values;
}

function fixture(extraRows: CronRow[] = []) {
  const root = mkdtempSync(path.join(tmpdir(), "octogee-cron-quarantine-"));
  const state = path.join(root, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({
    agents: { list: [{ id: ceckertAgent }, { id: mikeAgent }] },
    channels: { mattermost: { accounts: { [ceckertAccount]: {}, [mikeAccount]: {} } } },
  }));
  const db = new DatabaseSync(path.join(state, "openclaw.sqlite"));
  db.exec(`
    CREATE TABLE cron_jobs (
      store_key TEXT NOT NULL,
      job_id TEXT NOT NULL,
      declaration_key TEXT,
      owner_agent_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL,
      agent_id TEXT,
      payload_kind TEXT NOT NULL,
      job_json TEXT NOT NULL,
      state_json TEXT NOT NULL DEFAULT '{}',
      runtime_updated_at_ms INTEGER,
      schedule_identity TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (store_key, job_id)
    );
    CREATE TABLE cron_job_scratch (
      store_key TEXT NOT NULL,
      job_id TEXT NOT NULL,
      content TEXT,
      PRIMARY KEY (store_key, job_id)
    );
  `);
  const rows = [
    row("safe"),
    row("script", { payload_kind: "script" }),
    row("command", { payload_kind: "command" }),
    row("stream", { schedule_kind: "stream" }),
    row("exit", { schedule_kind: "on-exit" }),
    row("trigger", { trigger_script: "json({ fire: true })" }),
    row("mike-job-naming-ceckert", {
      owner_agent_id: mikeAgent,
      owner_session_key: mikeSession,
      agent_id: ceckertAgent,
      session_key: ceckertSession,
      delivery_account_id: ceckertAccount,
    }),
    row("foreign-delivery-account", { delivery_account_id: mikeAccount }),
    row("foreign-session", { session_key: mikeSession }),
    row("webhook", { delivery_mode: "webhook", delivery_to: "https://attacker.example/hook" }),
    ...simpleTierModels.map((model) => row(`tier-model-${model}`, { payload_kind: "agentTurn", payload_model: model })),
    row("unsafe-model", { payload_kind: "agentTurn", payload_model: "openai/gpt-attacker" }),
    row("unsafe-fallback", { payload_kind: "agentTurn", payload_fallbacks_json: JSON.stringify(["openai/gpt-attacker"]) }),
    row("unsafe-tools", { payload_kind: "agentTurn", payload_tools_allow_json: JSON.stringify(["exec"]) }),
    row("wildcard-tools", { payload_kind: "agentTurn", payload_tools_allow_json: JSON.stringify(["*"]) }),
    row("group-tools", { payload_kind: "agentTurn", payload_tools_allow_json: JSON.stringify(["group:web"]) }),
    row("pattern-tools", { payload_kind: "agentTurn", payload_tools_allow_json: JSON.stringify(["octogee_*"]) }),
    row("duplicate-tools", { payload_kind: "agentTurn", payload_tools_allow_json: JSON.stringify(["read", "read"]) }),
    row("malformed-tools", { payload_kind: "agentTurn", payload_tools_allow_json: "[" }),
    row("safe-tools", {
      payload_kind: "agentTurn",
      payload_tools_allow_json: JSON.stringify(defaultAgentTools),
      scheduled_tool_policy_json: JSON.stringify({
        version: 1,
        mode: "account",
        ownerSessionKey: ceckertSession,
        ownerAccountId: ceckertAccount,
      }),
    }),
    row("invalid-job-json", { job_json: "{" }),
    rowWithJobPatch("job-id-shadow-mismatch", { id: "other-job-id" }),
    rowWithJobPatch("owner-agent-shadow-mismatch", {
      owner: { agentId: mikeAgent, sessionKey: ceckertSession, accountId: ceckertAccount },
    }),
    rowWithJobPatch("agent-shadow-mismatch", { agentId: mikeAgent }),
    rowWithJobPatch("payload-kind-shadow-mismatch", {
      payload: { kind: "command", argv: ["true"] },
    }),
    row("scheduled-policy-version", {
      payload_kind: "agentTurn",
      payload_tools_allow_json: JSON.stringify(["read"]),
      scheduled_tool_policy_json: JSON.stringify({
        version: 2,
        mode: "account",
        ownerSessionKey: ceckertSession,
        ownerAccountId: ceckertAccount,
      }),
    }),
    row("wildcard-session-target", { session_target: "session:*" }),
    row("owned-session-target", { session_target: `session:${ceckertSession}` }),
    row("malformed-session-target", { session_target: "MAIN" }),
    ...extraRows,
  ];
  const columns = [
    "store_key", "job_id", "declaration_key", "owner_agent_id", "name", "description", "enabled",
    "agent_id", "payload_kind", "job_json", "state_json", "runtime_updated_at_ms",
    "schedule_identity", "sort_order", "updated_at",
  ];
  const insert = db.prepare(
    `INSERT INTO cron_jobs (${columns.join(", ")}) VALUES (${columns.map((column) => `@${column}`).join(", ")})`,
  );
  for (const cronRow of rows) {
    let job: Record<string, unknown> = {};
    try {
      job = JSON.parse(String(cronRow.job_json));
    } catch {
      job = {};
    }
    const normalizedRow: CronRow = {
      store_key: cronRow.store_key,
      job_id: cronRow.job_id,
      declaration_key: null,
      name: typeof job.name === "string" ? job.name : String(cronRow.job_id),
      description: null,
      enabled: 1,
      owner_agent_id: cronRow.owner_agent_id,
      agent_id: cronRow.agent_id,
      payload_kind: cronRow.payload_kind,
      job_json: cronRow.job_json,
      state_json: "{}",
      runtime_updated_at_ms: cronRow.updated_at,
      schedule_identity: null,
      sort_order: 0,
      updated_at: cronRow.updated_at,
    };
    insert.run(normalizedRow);
    db.prepare("INSERT INTO cron_job_scratch VALUES (?, ?, ?)").run(storeKey, cronRow.job_id, "scratch");
  }
  db.close();
  return { root, jobCount: rows.length };
}

function run(root: string, gatewayClass: "shared" | "isolated", scriptPath = script) {
  return spawnSync("node", [realpathSync(scriptPath)], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_DIR: root, GATEWAY_CLASS: gatewayClass },
  });
}

describe("user cron routing quarantine", () => {
  it("runs standalone from gateway scripts without a Core package installation", () => {
    const standalone = mkdtempSync(path.join(tmpdir(), "octogee-cron-standalone-"));
    const gateway = path.join(standalone, "infra", "gateway");
    mkdirSync(gateway, { recursive: true });
    writeFileSync(path.join(standalone, "package.json"), JSON.stringify({ type: "module" }));
    for (const name of ["quarantine-user-cron-jobs.mjs", "workflow-tools.mjs"]) {
      copyFileSync(path.join(repoRoot, "infra", "gateway", name), path.join(gateway, name));
    }
    const { root } = fixture();
    const result = run(root, "shared", path.join(gateway, "quarantine-user-cron-jobs.mjs"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("quarantined 26 unsafe user cron job(s)");
  });

  it.each(["shared", "isolated"] as const)(
    "removes cross-tenant and unsafe persisted jobs before %s startup while preserving reminders and the full captured agent tool surface",
    (gatewayClass) => {
      const { root } = fixture();
      const result = run(root, gatewayClass);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("quarantined 26 unsafe user cron job(s)");

      const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), { readOnly: true });
      const survivors = [
        { job_id: "safe" },
        { job_id: "safe-tools" },
        ...simpleTierModels.map((model) => ({ job_id: `tier-model-${model}` })),
      ];
      expect(db.prepare("SELECT job_id FROM cron_jobs ORDER BY job_id").all()).toEqual(survivors);
      expect(db.prepare("SELECT job_id FROM cron_job_scratch ORDER BY job_id").all()).toEqual(survivors);
      db.close();
      const quarantine = JSON.parse(readFileSync(
        path.join(root, "cron", "octogee-customer-cron-quarantine.json"),
        "utf8",
      ));
      expect(quarantine.jobs.map((job: { jobId: string }) => job.jobId).sort()).toEqual([
        "agent-shadow-mismatch",
        "command",
        "duplicate-tools",
        "exit",
        "foreign-delivery-account",
        "foreign-session",
        "group-tools",
        "invalid-job-json",
        "job-id-shadow-mismatch",
        "malformed-session-target",
        "malformed-tools",
        "mike-job-naming-ceckert",
        "owned-session-target",
        "owner-agent-shadow-mismatch",
        "pattern-tools",
        "payload-kind-shadow-mismatch",
        "scheduled-policy-version",
        "script",
        "stream",
        "trigger",
        "unsafe-fallback",
        "unsafe-model",
        "unsafe-tools",
        "webhook",
        "wildcard-session-target",
        "wildcard-tools",
      ]);
      expect(quarantine.jobs.find((job: { jobId: string }) => job.jobId === "mike-job-naming-ceckert").reason)
        .toBe("owner-agent-mismatch");
      const reasons = Object.fromEntries(
        quarantine.jobs.map((job: { jobId: string; reason: string }) => [job.jobId, job.reason]),
      );
      expect(reasons).toMatchObject({
        "invalid-job-json": "invalid-job-json",
        "job-id-shadow-mismatch": "job-id-shadow-mismatch",
        "owner-agent-shadow-mismatch": "owner-agent-shadow-mismatch",
        "agent-shadow-mismatch": "agent-shadow-mismatch",
        "payload-kind-shadow-mismatch": "payload-kind-shadow-mismatch",
        "scheduled-policy-version": "scheduled-authority-mismatch",
      });
    },
  );

  it("does not exempt the retired operator class from quarantine", () => {
    const { root } = fixture();
    const result = run(root, "operator" as never);
    expect(result.status, result.stderr).toBe(0);
    const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), { readOnly: true });
    expect(db.prepare("SELECT count(*) AS count FROM cron_jobs").get()).toEqual({ count: 2 + simpleTierModels.length });
    db.close();
  });

  it("keeps an owner automation: isolated, no session key, delivered to the Agent channel it is owned by", () => {
    const coachChannel = "c".repeat(26);
    const defaultAgentSession = `agent:${ceckertAgent}:mattermost:group:${coachChannel}`;
    const job = {
      id: "owner-automation",
      name: "weekday-brief",
      displayName: "Weekday morning brief",
      declarationKey: `octogee:owner-automation:${ceckertAgent}:weekday-brief`,
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      owner: { agentId: ceckertAgent, sessionKey: defaultAgentSession, accountId: ceckertAccount },
      agentId: ceckertAgent,
      sessionTarget: "isolated",
      wakeMode: "now",
      schedule: { kind: "cron", expr: "0 7 * * 1-5", tz: "America/Los_Angeles" },
      payload: {
        kind: "agentTurn",
        message: "Brief me.",
        toolsAllow: ["octogee_google_calendar_events", "octogee_google_gmail_search", "octogee_google_gmail_get", "octogee_google_tasks_lists", "octogee_google_tasks_list"],
      },
      delivery: { mode: "announce", channel: "mattermost", accountId: ceckertAccount, to: `channel:${coachChannel}` },
      scheduledToolPolicy: { version: 1, mode: "account", ownerSessionKey: defaultAgentSession, ownerAccountId: ceckertAccount },
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        callerOrigin: { kind: "external", channel: "mattermost" },
        channelRequester: { version: 1, channel: "mattermost", accountId: ceckertAccount, senderId: "o".repeat(26) },
      },
      state: {},
    };
    const { root } = fixture([row("owner-automation", { payload_kind: "agentTurn", job_json: JSON.stringify(job) })]);

    const result = run(root, "shared");

    expect(result.status, result.stderr).toBe(0);
    const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), { readOnly: true });
    const survivors = db.prepare("SELECT job_id FROM cron_jobs").all().map((entry) => String(entry.job_id));
    db.close();
    expect(survivors).toContain("owner-automation");
  });

  it("keeps jobs that deliver to their own session through native user and channel targets", () => {
    const ownerPeer = "o".repeat(26);
    const directSession = `agent:${ceckertAgent}:mattermost:direct:${ownerPeer}`;
    const direct = { owner_session_key: directSession, session_key: directSession };
    const { root } = fixture([
      row("dm-native-target", { ...direct, delivery_to: `user:${ownerPeer}` }),
      row("dm-foreign-user", { ...direct, delivery_to: `user:${"x".repeat(26)}` }),
      row("dm-as-channel", { ...direct, delivery_to: `channel:${ownerPeer}` }),
      row("channel-native-target", { delivery_to: "channel:ceckert-channel" }),
      row("channel-foreign-channel", { delivery_to: "channel:mike-channel" }),
      row("channel-as-user", { delivery_to: "user:ceckert-channel" }),
      row("dm-foreign-failure-alert", { ...direct, delivery_to: `user:${ownerPeer}`, failure_alert_to: `user:${"x".repeat(26)}` }),
    ]);

    const result = run(root, "isolated");

    expect(result.status, result.stderr).toBe(0);
    const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), { readOnly: true });
    const survivors = db.prepare("SELECT job_id FROM cron_jobs").all().map((entry) => String(entry.job_id));
    db.close();
    expect(survivors).toEqual(expect.arrayContaining(["dm-native-target", "channel-native-target"]));
    const reasons = Object.fromEntries(JSON.parse(readFileSync(
      path.join(root, "cron", "octogee-customer-cron-quarantine.json"),
      "utf8",
    )).jobs.map((job: { jobId: string; reason: string }) => [job.jobId, job.reason]));
    expect(reasons).toMatchObject({
      "dm-foreign-user": "delivery-destination-mismatch",
      "dm-as-channel": "delivery-destination-mismatch",
      "channel-foreign-channel": "delivery-destination-mismatch",
      "channel-as-user": "delivery-destination-mismatch",
      "dm-foreign-failure-alert": "failure-alert-destination-mismatch",
    });
  });
});

