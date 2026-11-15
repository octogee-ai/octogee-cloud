import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { UpstreamRpcClient } from "@octogee/core/http-candidates/chat-proxy/openclaw/bridge-upstream-rpc";
import { createAutomationsRouter, invokeLocalOpenClaw, NativeAutomationError, type LocalAutomationOpenClawDeps } from "./automations.js";

const AGENT = "octogee-alice-coach";
const CHANNEL = "a".repeat(26);
const SESSION = `agent:${AGENT}:mattermost:channel:${CHANNEL}`;
const OWNER = { agentId: AGENT, accountId: "alice-coach", sessionKey: SESSION };
function job(extra: Record<string, unknown> = {}) {
  return { id: "daily", name: "Daily digest", agentId: AGENT, effectiveAgentId: AGENT,
    owner: OWNER, enabled: true, createdAtMs: 1, updatedAtMs: 2, configRevision: "revision-a",
    schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 50 },
    sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "Summarize." },
    delivery: { mode: "none" }, state: { nextRunAtMs: 1000 }, ...extra };
}
const nativeJobs = [
  job({ id: "proactive", owner: undefined, declarationKey: `octogee:coach-monitor:${AGENT}`,
    name: `Proactive check (${AGENT})`, sessionKey: `agent:${AGENT}:main`, sessionTarget: `session:agent:${AGENT}:main`,
    schedule: { kind: "every", everyMs: 1_800_000, anchorMs: 17 }, wakeMode: "now", idleOnly: true,
    payload: { kind: "agentTurn", message: "Review your automation scratch checklist and relevant session context. Do not infer or repeat old tasks from prior conversations. Take useful action only when needed. Use NO_REPLY when there is nothing to tell the user.", skipIfScratchEmpty: true },
    delivery: { mode: "announce", target: "owner" } }),
];
function page(jobs: Record<string, unknown>[], params: Record<string, unknown> = {}, revision = "snapshot-a") {
  const offset = Number(params.offset ?? 0), limit = Number(params.limit ?? 200);
  const rows = jobs.slice(offset, offset + limit), next = offset + rows.length;
  return { jobs: rows, snapshotRevision: revision, total: jobs.length, offset, limit, hasMore: next < jobs.length, nextOffset: next < jobs.length ? next : null };
}
function historyPage(entries: Record<string, unknown>[], params: Record<string, unknown>) {
  const offset = Number(params.offset ?? 0), limit = Number(params.limit ?? 200);
  const rows = entries.slice(offset, offset + limit), next = offset + rows.length;
  return { entries: rows, total: entries.length, offset, limit, hasMore: next < entries.length, nextOffset: next < entries.length ? next : null };
}
function appForTest(options: { jobs?: Record<string, unknown>[]; invoke?: (method: string, params: Record<string, unknown>) => Promise<unknown>; authorizeOwner?: Parameters<typeof createAutomationsRouter>[0]["authorizeOwner"] } = {}) {
  const jobs = options.jobs ?? [job()];
  const invoke = vi.fn(options.invoke ?? (async (method, params) => {
    if (method === "cron.list") return page(jobs, params);
    if (method === "cron.get") return jobs.find((row) => row.id === params.id);
    if (method === "cron.status") return { enabled: true, triggersEnabled: false, jobs: 999, nextWakeAtMs: 1, storePath: "/private/shared" };
    if (method === "cron.runs") return { entries: [], total: 0, offset: 0, limit: params.limit ?? 20, hasMore: false, nextOffset: null };
    return { ok: true };
  }));
  const authorizeOwner = options.authorizeOwner ?? vi.fn(async () => ({ kind: "authorized" as const, slug: "alice", gatewayId: "gw-alice", coachChannelId: CHANNEL }));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.uid = "builder-uid"; next(); });
  app.use("/api/g/:gatewayId/automations", createAutomationsRouter({ authorizeOwner, localGatewayId: () => "gw-alice", invoke }));
  app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => { if (res.headersSent) { next(error); return; } res.status(500).json({ error: error.message }); });
  return { app, invoke, authorizeOwner };
}
function rpc(app: express.Express, method: string, params: Record<string, unknown> = {}) {
  return request(app).post("/api/g/gw-alice/automations/rpc").set("Authorization", "Bearer caller-token").send({ method, params });
}

describe("native Automations locality broker", () => {
  it("authorizes the current workspace owner before returning trusted native context", async () => {
    const { app, authorizeOwner, invoke } = appForTest();
    const response = await rpc(app, "automations.context");
    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({ agentId: AGENT, canManage: false, capabilities: { runTranscripts: false, scratch: false } });
    expect(authorizeOwner).toHaveBeenCalledWith({ gatewayId: "gw-alice", uid: "builder-uid", authorization: "Bearer caller-token" });
    expect(invoke).not.toHaveBeenCalled();
  });
  it("bounds repeated broker requests per authenticated owner", async () => {
    const { app, authorizeOwner } = appForTest();
    for (let attempt = 0; attempt < 120; attempt++) await rpc(app, "automations.context").expect(200);
    const limited = await rpc(app, "automations.context").expect(429);
    expect(limited.body).toEqual({ error: "Too many requests, please try again later." });
    expect(authorizeOwner).toHaveBeenCalledTimes(120);
  });

  it.each(["forbidden", "not_found", "coach_channel_not_ready", "unauthenticated"] as const)("does not call native RPC after authorization %s", async (kind) => {
    const { app, invoke } = appForTest({ authorizeOwner: async () => ({ kind }) });
    expect((await rpc(app, "cron.list")).status).toBe({ forbidden: 403, not_found: 404, coach_channel_not_ready: 409, unauthenticated: 401 }[kind]);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("returns an ordinary native proactive job unchanged, with actual cadence and owner delivery", async () => {
    const { app } = appForTest({ jobs: nativeJobs });
    const response = await rpc(app, "cron.list", { includeDisabled: true, limit: 20 });
    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({ jobs: JSON.parse(JSON.stringify(nativeJobs)), total: 1, offset: 0, limit: 20, hasMore: false, nextOffset: null });
    expect(response.body.result.snapshotRevision).toEqual(expect.any(String));
    expect(response.body.result.hostedCapabilities.proactive).toEqual({ history: true });
  });
  it("keeps Doctor-converted ordinary jobs visible without declaration or display-name fingerprints", async () => {
    const converted = { ...nativeJobs[0], declarationKey: undefined, name: "My renamed daily check" };
    const { app } = appForTest({ jobs: [converted] });
    expect((await rpc(app, "cron.list")).body.result.jobs).toEqual([JSON.parse(JSON.stringify(converted))]);
    expect((await rpc(app, "cron.get", { id: "proactive" })).body.result).toEqual(JSON.parse(JSON.stringify(converted)));
    expect((await rpc(app, "cron.status")).body.result.jobs).toBe(1);
    expect((await rpc(app, "cron.runs", { id: "proactive" })).status).toBe(200);
  });
  it.each([
    { label: "missing explicit agent", agentId: undefined },
    { label: "foreign explicit agent", agentId: "octogee-bob-coach" },
    { label: "foreign effective agent", effectiveAgentId: "octogee-bob-coach" },
    { label: "missing session", sessionKey: undefined },
    { label: "foreign session", sessionKey: "agent:octogee-bob-coach:main" },
    { label: "foreign session target", sessionTarget: "session:agent:octogee-bob-coach:main" },
    { label: "conflicting scoped session target", sessionTarget: `session:agent:${AGENT}:other` },
  ])("hides ordinary ownerless jobs with $label despite matching name and declaration", async ({ label: _label, ...fields }) => {
    const { app, invoke } = appForTest({ jobs: [{ ...nativeJobs[0], ...fields }] });
    expect((await rpc(app, "cron.list")).body.result.jobs).toEqual([]);
    expect((await rpc(app, "cron.get", { id: "proactive" })).status).toBe(404);
    expect((await rpc(app, "cron.runs", { id: "proactive" })).status).toBe(404);
    expect(invoke.mock.calls.filter(([method]) => method !== "cron.list")).toEqual([]);
  });
  it("enforces stamped owner and account independently of execution agent before pagination", async () => {
    const foreign = job({ id: "foreign", owner: { agentId: "octogee-bob-coach", accountId: "bob-coach" } });
    const account = job({ id: "account", owner: { agentId: AGENT, accountId: "bob-coach" } });
    const retargeted = job({ id: "retargeted", agentId: "octogee-bob-coach", effectiveAgentId: "octogee-bob-coach" });
    const { app } = appForTest({ jobs: [foreign, account, retargeted, job()] });
    const response = await rpc(app, "cron.list", { limit: 1, offset: 1, includeDisabled: true });
    expect(response.body.result).toMatchObject({ jobs: [job()], total: 2, offset: 1, limit: 1, hasMore: false });
  });
  it.each([
    { label: "missing agent", owner: { accountId: OWNER.accountId, sessionKey: SESSION } },
    { label: "missing account", owner: { agentId: AGENT, sessionKey: SESSION } },
    { label: "missing session", owner: { agentId: AGENT, accountId: OWNER.accountId } },
    { label: "non-Mattermost session", owner: { ...OWNER, sessionKey: `agent:${AGENT}:main` } },
    { label: "foreign Mattermost session", owner: { ...OWNER, sessionKey: `agent:octogee-bob-coach:mattermost:channel:${CHANNEL}` } },
    { label: "malformed Mattermost session", owner: { ...OWNER, sessionKey: `agent:${AGENT}:mattermost:channel:${CHANNEL}:foreign` } },
  ])("hides $label authority from list, get, and history", async ({ owner }) => {
    const { app, invoke } = appForTest({ jobs: [job({ owner })] });
    const listed = await rpc(app, "cron.list");
    expect(listed.status).toBe(200);
    expect(listed.body.result).toMatchObject({ jobs: [], total: 0, hostedCapabilities: {} });
    expect((await rpc(app, "cron.get", { id: "daily" })).status).toBe(404);
    expect((await rpc(app, "cron.runs", { id: "daily" })).status).toBe(404);
    expect(invoke.mock.calls.filter(([method]) => method !== "cron.list")).toEqual([]);
  });
  it.each(["agentId", "accountId", "sessionKey"])("rejects get if explicit owner %s disappears after inventory", async (field) => {
    const owner: Record<string, unknown> = { ...OWNER };
    delete owner[field];
    const { app } = appForTest({ invoke: async (method, params) => method === "cron.list" ? page([job()], params) : job({ owner }) });
    const response = await rpc(app, "cron.get", { id: "daily" });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "automation_inventory_changed" });
  });
  it.each(["direct", "group", "channel"])("preserves explicitly owned Mattermost %s and thread authority", async (kind) => {
    const rows = [job({ owner: { ...OWNER, sessionKey: `agent:${AGENT}:mattermost:${kind}:${CHANNEL}` } }),
      job({ id: "thread", owner: { ...OWNER, sessionKey: `agent:${AGENT}:mattermost:${kind}:${CHANNEL}:thread:post-id` } })];
    const { app } = appForTest({ jobs: rows });
    expect((await rpc(app, "cron.list")).body.result.jobs).toEqual(rows);
  });
  it("never attributes arbitrary ownerless jobs or foreign-stamped system jobs by their execution target", async () => {
    const { app } = appForTest({ jobs: [job({ owner: undefined }), { ...nativeJobs[0], owner: { agentId: "octogee-bob-coach" } }] });
    expect((await rpc(app, "cron.list")).body.result.jobs).toEqual([]);
  });
  it("does not infer tenant ownership from retired projection keys or a native dreaming fingerprint", async () => {
    const rows = [
      job({ id: "legacy-heartbeat", owner: undefined, declarationKey: `heartbeat:${AGENT}`, payload: { kind: "heartbeat" } }),
      job({ id: "retired-skills", owner: undefined, declarationKey: `skill-collection-review:${AGENT}` }),
      job({ id: "implicit-dreaming", owner: undefined, agentId: undefined, declarationKey: "memory-core:memory-dreaming-promotion",
        payload: { kind: "agentTurn", message: "__openclaw_memory_core_short_term_promotion_dream__", lightContext: true } }),
    ];
    const { app } = appForTest({ jobs: rows });
    expect((await rpc(app, "cron.list")).body.result.jobs).toEqual([]);
  });
  it.each([
    { payload: { kind: "command", command: "env", env: { SECRET: "private" } } },
    { payload: { kind: "script", script: "private" } },
    { schedule: { kind: "on-exit", command: "private" } },
    { scheduledToolPolicy: { version: 1, mode: "trusted" } },
    { scheduledToolPolicy: { version: 1, mode: "account", ownerAccountId: "bob-coach", ownerSessionKey: SESSION } },
    { scheduledToolPolicy: { version: 1, mode: "account", ownerAccountId: "alice-coach", ownerSessionKey: "agent:foreign:main" } },
  ])("does not expose protected operator payloads or foreign scheduled authority %j", async (fields) => {
    const { app } = appForTest({ jobs: [job(fields)] });
    const response = await rpc(app, "cron.list");
    expect(response.body.result.jobs).toEqual([]);
  });
  it("preserves the canonical account-bound scheduled policy without reattributing its owner", async () => {
    const row = job({ scheduledToolPolicy: { version: 1, mode: "account", ownerAccountId: "alice-coach", ownerSessionKey: SESSION } });
    const { app } = appForTest({ jobs: [row] });
    expect((await rpc(app, "cron.list")).body.result.jobs).toEqual([row]);
  });
  it("fails explicitly on malformed native inventory instead of fabricating an empty page or heartbeat", async () => {
    const { app } = appForTest({ invoke: async () => ({ jobs: [] }) });
    const response = await rpc(app, "cron.list");
    expect(response.status).toBe(502);
    expect(response.body.error).toBe("invalid_native_automation_inventory");
  });
  it("fails explicitly when the native inventory exceeds its bounded scan", async () => {
    const { app } = appForTest({ invoke: async () => ({ ...page([job()]), total: 2001, hasMore: true, nextOffset: 1 }) });
    expect((await rpc(app, "cron.list")).body.error).toBe("automation_inventory_limit");
  });
  it("rejects a changing multi-page snapshot instead of mixing ownership generations", async () => {
    let revision = 0;
    const jobs = Array.from({ length: 201 }, (_, n) => job({ id: `j${n}` }));
    const { app } = appForTest({ invoke: async (method, params) => page(jobs, params, `revision-${revision++}`) });
    expect((await rpc(app, "cron.list")).body.error).toBe("automation_inventory_changed");
  });
  it("keeps scoped revisions and counts independent of foreign inventory rows", async () => {
    let foreignName = "Bob's job";
    const invoke = async (method: string, params: Record<string, unknown>) => page([job(), job({ id: "foreign", owner: { agentId: "bob" }, name: foreignName })], params, foreignName);
    const { app } = appForTest({ invoke });
    const first = (await rpc(app, "cron.list")).body.result;
    foreignName = "Changed privately";
    const second = (await rpc(app, "cron.list")).body.result;
    expect(second.snapshotRevision).toBe(first.snapshotRevision);
    expect(second.total).toBe(1);
  });
  it("rejects foreign client agent selectors before any native request", async () => {
    const { app, invoke } = appForTest();
    expect((await rpc(app, "cron.list", { agentId: "bob" })).status).toBe(400);
    expect((await rpc(app, "cron.runs", { scope: "all", agentId: "bob" })).status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("refuses get when the native owner or definition changed since the scoped inventory", async () => {
    const { app } = appForTest({ invoke: async (method, params) => method === "cron.list" ? page([job()], params) : job({ owner: { agentId: "bob" }, configRevision: "revision-b" }) });
    const response = await rpc(app, "cron.get", { id: "daily" });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("automation_inventory_changed");
    expect(response.body).not.toHaveProperty("result");
  });
  it("retains only bounded native conflict details at the HTTP boundary", async () => {
    const { app } = appForTest({ invoke: async () => { throw new NativeAutomationError({ code: "INVALID_REQUEST", message: "Job changed", details: { code: "CRON_JOB_CHANGED", expectedConfigRevision: "old", actualConfigRevision: "new", privateState: "not public" } }); } });
    const response = await rpc(app, "cron.list");
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "native_automation_error", code: "INVALID_REQUEST", message: "Job changed", details: { code: "CRON_JOB_CHANGED", expectedConfigRevision: "old", actualConfigRevision: "new" } });
  });
  it("derives status counts and next wake from owned native rows, without shared store metadata", async () => {
    const { app } = appForTest();
    const response = await rpc(app, "cron.status");
    expect(response.body.result).toEqual({ enabled: true, triggersEnabled: false, jobs: 1, nextWakeAtMs: 1000 });
  });
  it.each(["cron.get", "cron.runs"])("rejects foreign ownership for %s before the target RPC", async (method) => {
    const { app, invoke } = appForTest({ jobs: [job({ owner: { agentId: "octogee-bob-coach" } })] });
    expect((await rpc(app, method, { id: "daily", ...(method === "cron.update" ? { patch: { enabled: false } } : {}) })).status).toBe(404);
    expect(invoke.mock.calls.filter(([name]) => name !== "cron.list")).toEqual([]);
  });
  it("returns the full native get row for an owned job", async () => {
    const { app } = appForTest();
    expect((await rpc(app, "cron.get", { id: "daily" })).body.result).toEqual(job());
  });
  it.each(["config.get", "heartbeat.get", "heartbeat.update", "cron.scratch.get", "cron.history", "cron.migration"])("explicitly rejects unsupported %s without calling native", async (method) => {
    const { app, invoke } = appForTest();
    expect((await rpc(app, method, { id: "daily" })).status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(["cron.add", "cron.update", "cron.run", "cron.remove"])("denies %s rather than lending unscoped operator authority", async (method) => {
    const { app, invoke } = appForTest();
    const response = await rpc(app, method, { id: "daily", expectedConfigRevision: "revision-a", patch: { enabled: false } });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("automation_read_only");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("advertises only authorized run-history capability", async () => {
    const { app } = appForTest();
    const response = await rpc(app, "cron.list");
    expect(response.body.result.hostedCapabilities.daily).toEqual({ history: true });
  });
  it("keeps an owned retargeted job visible but excludes its foreign-execution history from overview", async () => {
    const retargeted = job({ id: "retargeted", agentId: "octogee-bob-coach", effectiveAgentId: "octogee-bob-coach" });
    const { app, invoke } = appForTest({ jobs: [job(), retargeted] });
    expect((await rpc(app, "cron.list")).body.result.hostedCapabilities.retargeted.history).toBe(false);
    expect((await rpc(app, "cron.runs", { scope: "all" })).status).toBe(200);
    expect(invoke).not.toHaveBeenCalledWith("cron.runs", expect.objectContaining({ id: "retargeted" }));
    expect((await rpc(app, "cron.runs", { id: "retargeted" })).status).toBe(403);
  });
  it("does not expose account-bound foreign policy through ownerless native projection names", async () => {
    const { app } = appForTest({ jobs: [{ ...nativeJobs[0], scheduledToolPolicy: { version: 1, mode: "account", ownerAccountId: "bob-coach", ownerSessionKey: "agent:bob:main" } }] });
    expect((await rpc(app, "cron.list")).body.result.jobs).toEqual([]);
  });
  it("reads durable agent-scoped history and intersects authorized jobs before paging", async () => {
    const jobs = [job(), job({ id: "foreign", owner: { agentId: "foreign" } })];
    const entry = { jobId: "daily", ts: 10, action: "finished", status: "ok", runId: "run-a", sessionKey: `agent:${AGENT}:cron:daily:run:run-a` };
    const invoke = vi.fn(async (method: string, params: Record<string, unknown>) => method === "cron.list" ? page(jobs, params) : { entries: [entry], total: 1, offset: 0, limit: 200, hasMore: false, nextOffset: null });
    const { app } = appForTest({ invoke });
    const response = await rpc(app, "cron.runs", { scope: "all", limit: 10 });
    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({ entries: [entry], total: 1, offset: 0, hasMore: false, nextOffset: null });
    expect(invoke).toHaveBeenCalledWith("cron.runs", expect.objectContaining({ scope: "all", agentId: AGENT }));
    expect(invoke).not.toHaveBeenCalledWith("cron.runs", expect.objectContaining({ id: "foreign" }));
  });

  it("rejects same-total head insertion and tail retirement during history pagination", async () => {
    const entries = Array.from({ length: 201 }, (_, n) => ({ jobId: "daily", ts: 201 - n, runId: `run-${n}` }));
    const rotated = [{ jobId: "daily", ts: 202, runId: "new-head" }, ...entries.slice(0, -1)];
    let reads = 0;
    const { app, invoke } = appForTest({ invoke: async (method, params) => method === "cron.list" ? page([job()], params)
      : historyPage(reads++ === 0 ? entries : rotated, params) });
    const response = await rpc(app, "cron.runs", { scope: "all" });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "automation_history_changed" });
    expect(invoke.mock.calls.filter(([method]) => method === "cron.runs").length).toBeLessThanOrEqual(4);
  });
  it("verifies interior history pages even when the head and total remain unchanged", async () => {
    const entries = Array.from({ length: 401 }, (_, n) => ({ jobId: "daily", ts: 401 - n, summary: `run ${n}` }));
    const changed = entries.map((entry, n) => n === 250 ? { ...entry, summary: "Late delivery result" } : entry);
    let reads = 0;
    const { app } = appForTest({ invoke: async (method, params) => method === "cron.list" ? page([job()], params)
      : historyPage(reads++ < 3 ? entries : changed, params) });
    const response = await rpc(app, "cron.runs", { scope: "all" });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "automation_history_changed" });
    expect(reads).toBeLessThanOrEqual(6);
  });
  it.each(["asc", "desc"])("preserves native %s ordering and sessionless history within a bounded verification pass", async (sortDir) => {
    const entries = Array.from({ length: 2000 }, (_, n) => ({ jobId: "daily", ts: Math.floor(n / 2), summary: `sessionless ${n}` }));
    if (sortDir === "desc") entries.reverse();
    const { app, invoke } = appForTest({ invoke: async (method, params) => method === "cron.list" ? page([job()], params) : historyPage(entries, params) });
    const response = await rpc(app, "cron.runs", { scope: "all", sortDir, offset: 1990, limit: 10 });
    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({ entries: entries.slice(1990), total: 2000, offset: 1990, hasMore: false, nextOffset: null });
    const reads = invoke.mock.calls.filter(([method]) => method === "cron.runs");
    expect(reads).toHaveLength(20);
    expect(reads.every(([, params]) => params.scope === "all" && params.agentId === AGENT && params.sortDir === sortDir)).toBe(true);
  });
  it("uses one atomic native read for a single history page", async () => {
    const entries = [{ jobId: "daily", ts: 10, summary: "Sessionless failure" }];
    const { app, invoke } = appForTest({ invoke: async (method, params) => method === "cron.list" ? page([job()], params) : historyPage(entries, params) });
    const response = await rpc(app, "cron.runs", { id: "daily" });
    expect(response.status).toBe(200);
    expect(response.body.result.entries).toEqual(entries);
    expect(invoke.mock.calls.filter(([method]) => method === "cron.runs")).toHaveLength(1);
  });

  it("refuses an inconsistent foreign-session entry returned by the native agent-scoped history", async () => {
    const { app } = appForTest({ invoke: async (method, params) => method === "cron.list" ? page([job()], params) : { entries: [{ jobId: "daily", ts: 10, sessionKey: "agent:foreign:cron:daily" }], total: 1, offset: 0, limit: 200, hasMore: false, nextOffset: null } });
    const response = await rpc(app, "cron.runs", { id: "daily" });
    expect(response.status).toBe(502);
    expect(response.body.error).toBe("invalid_native_automation_history");
  });
  it.each(["all", "job"])("scopes %s history by durable execution agent after a job is retargeted and returned", async (scope) => {
    const jobs = [job(), job({ id: "foreign-owned", owner: { agentId: "bob", accountId: "bob-coach" } })];
    const records = [
      { agentId: AGENT, entry: { jobId: "daily", ts: 10, summary: "Own sessionless pre-model failure", status: "error" } },
      { agentId: "octogee-bob-coach", entry: { jobId: "daily", ts: 20, summary: "Private earlier foreign execution", status: "error" } },
      { agentId: undefined, entry: { jobId: "daily", ts: 30, summary: "Unattributed history", status: "error" } },
      { agentId: AGENT, entry: { jobId: "foreign-owned", ts: 40, summary: "Foreign owner's job executed here", status: "ok" } },
    ];
    const invoke = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "cron.list") return page(jobs, params);
      const entries = records.filter((row) => params.scope === "all"
        ? params.agentId === undefined || row.agentId === params.agentId
        : row.entry.jobId === params.id).map((row) => row.entry);
      return { entries, total: entries.length, offset: 0, limit: 200, hasMore: false, nextOffset: null };
    });
    const { app } = appForTest({ invoke });
    const response = await rpc(app, "cron.runs", { scope, ...(scope === "job" ? { id: "daily" } : {}), limit: 1 });
    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({ entries: [records[0].entry], total: 1, hasMore: false, nextOffset: null, hostedCapabilities: { daily: { history: true } } });
    expect(JSON.stringify(response.body)).not.toContain("Private earlier");
    expect(JSON.stringify(response.body)).not.toContain("Unattributed");
    expect(JSON.stringify(response.body)).not.toContain("Foreign owner's");
    expect(invoke).toHaveBeenCalledWith("cron.runs", expect.objectContaining({ scope: "all", agentId: AGENT }));
  });
  it("returns history capability metadata for each returned job even when it was not in the jobs page", async () => {
    const jobs = [job(), job({ id: "second" })];
    const { app } = appForTest({ invoke: async (method, params) => method === "cron.list" ? page(jobs, params) : { entries: [{ jobId: "second", ts: 20 }, { jobId: "daily", ts: 10 }], total: 2, offset: 0, limit: 200, hasMore: false, nextOffset: null } });
    const listed = await rpc(app, "cron.list", { limit: 1 });
    expect(listed.body.result.hostedCapabilities).toEqual({ daily: { history: true } });
    const runs = await rpc(app, "cron.runs", { scope: "all", limit: 1 });
    expect(runs.body.result).toMatchObject({ total: 2, hasMore: true, nextOffset: 1, hostedCapabilities: { second: { history: true } } });
  });

});

describe("local Automations OpenClaw transport", () => {
  it("uses the auth-rotating upstream and closes it after the bounded RPC", async () => {
    const close = vi.fn();
    const dispose = vi.fn();
    const openAuthenticatedUpstream = vi.fn(async () => ({ close } as never));
    const rpc: UpstreamRpcClient = {
      call: async <T>() => ({ ok: true as const, result: { jobs: [] } as T }),
      dispose,
    };
    const attachRpcClient = vi.fn(() => rpc);
    const deps: LocalAutomationOpenClawDeps = {
      gatewayId: () => "eggman-devdays",
      gatewayUrl: () => "http://127.0.0.1:18789",
      openAuthenticatedUpstream,
      attachRpcClient,
    };

    await expect(invokeLocalOpenClaw("cron.list", {}, deps)).resolves.toEqual({ jobs: [] });

    expect(openAuthenticatedUpstream).toHaveBeenCalledWith({
      gatewayId: "eggman-devdays",
      url: "http://127.0.0.1:18789",
      timeoutMs: 10_000,
    });
    expect(attachRpcClient).toHaveBeenCalledWith(expect.anything(), { timeoutMs: 10_000 });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
