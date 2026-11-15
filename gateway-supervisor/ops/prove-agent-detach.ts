import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs, { type FileHandle } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { generateIdentity } from "@octogee/core/gateway-device-identity";
import { queryAgentStore, readPostgresAgentAnchor, type PostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { createGatewayRpc, type GatewayRpcClient } from "../lib/gateway-rpc.js";
import { deleteRosterAgents } from "../lib/agent-roster-deletion.js";
import { createRosterAgents } from "../lib/agent-roster-creation.js";
import { setUserChannelsRunning } from "../lib/user-channel-quiesce.js";
import { exportAgentStoreSnapshots, prepareAgentStoreSnapshots, installPreparedAgentStores } from "../lib/agent-store-snapshot.js";

type Account = { agentId: string; accountId: string; botUserId: string; channelId: string; token: string };
type MattermostFixture = { baseUrl: string; adminToken: string; adminUserId: string; entries: Account[] };
type History = { sessionId: string; messages: unknown[] };
type ChannelAccount = { accountId: string; running?: boolean; connected?: boolean };
type FixtureClient = {
  start(): void;
  stop(): Promise<void>;
  request<T>(method: string, params: object): Promise<T>;
};
type Gateway = {
  home: string; state: string; rpc: GatewayRpcClient; client: FixtureClient;
  process: ChildProcess; closed: Promise<unknown>; log: FileHandle;
};

const { values } = parseArgs({ options: {
  runtime: { type: "string", default: "/usr/local/lib/node_modules/openclaw" },
  fixture: { type: "string" }, output: { type: "string" },
  "mattermost-url": { type: "string" }, "latency-ms": { type: "string", default: "5" },
} });
assert(values.fixture && values.output, "Usage: prove-agent-detach --fixture <local-mm.json> --output <result.json> [--runtime <installed-root>] [--mattermost-url <local-url>] [--latency-ms <ms>]");
const connection = process.env.OCTOGEE_DETACH_PROOF_PG;
assert(connection, "OCTOGEE_DETACH_PROOF_PG must select the disposable detach_proof database");
const databaseUrl = new URL(connection);
const localHosts = new Set(["127.0.0.1", "localhost", "host.docker.internal"]);
assert(localHosts.has(databaseUrl.hostname) && databaseUrl.pathname === "/detach_proof", "Only a disposable local detach_proof database is supported");
process.env.OPENCLAW_AGENT_STORE_DSN = connection;
const fixture = JSON.parse(await fs.readFile(values.fixture, "utf8")) as MattermostFixture;
fixture.baseUrl = values["mattermost-url"] ?? fixture.baseUrl;
const mattermostOrigin = new URL(fixture.baseUrl);
assert(localHosts.has(mattermostOrigin.hostname) && ["http:", "https:"].includes(mattermostOrigin.protocol) &&
  !mattermostOrigin.username && !mattermostOrigin.password && mattermostOrigin.pathname === "/" &&
  !mattermostOrigin.search && !mattermostOrigin.hash, "Mattermost must be a disposable local server origin");
fixture.baseUrl = mattermostOrigin.origin;
assert(fixture.entries.length === 8 && fixture.entries.every(entry => entry.agentId && entry.accountId && entry.token && entry.channelId), "Expected six migrating accounts and two keeper accounts");
const travelers = fixture.entries.filter(entry => entry.accountId.startsWith("detachproof-"));
assert.equal(travelers.length, 6);
assert(travelers.every(entry => entry.accountId === "detachproof-coach" || entry.accountId.startsWith("detachproof-proj-")));
const keeper = fixture.entries.find(entry => entry.accountId === "keeper-coach")!;
const targetKeeper = fixture.entries.find(entry => entry.accountId === "targetkeeper-coach")!;
const runtime = path.resolve(values.runtime);
const output = path.resolve(values.output);
await fs.mkdir(path.dirname(output), { recursive: true });
const work = await fs.mkdtemp(path.join(path.dirname(output), "detach-proof-"));
const schemaPrefix = `detachproof_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const latencyMs = Number(values["latency-ms"]);
assert(Number.isFinite(latencyMs) && latencyMs >= 0 && latencyMs <= 100);
const trace: object[] = [];
const log = (stage: string, data: object = {}) => {
  const item = { stage, ...data };
  trace.push(item);
  console.log(JSON.stringify(item));
};
const gateways: Gateway[] = [];
const sql = new pg.Client({ connectionString: connection });
let activeDelay = 0;
const proxy = net.createServer(downstream => {
  const upstream = net.connect(Number(databaseUrl.port || 5432), databaseUrl.hostname);
  const relay = (socket: net.Socket, chunk: Buffer | string) => {
    const send = () => { if (!socket.destroyed) socket.write(chunk); };
    if (activeDelay) setTimeout(send, activeDelay); else send();
  };
  downstream.on("data", chunk => relay(upstream, chunk));
  upstream.on("data", chunk => relay(downstream, chunk));
  downstream.on("error", () => upstream.destroy());
  upstream.on("error", () => downstream.destroy());
  downstream.on("close", () => upstream.destroy());
  upstream.on("close", () => downstream.destroy());
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const proxyAddress = proxy.address();
assert(proxyAddress && typeof proxyAddress === "object");
const gatewayDatabase = new URL(connection);
gatewayDatabase.hostname = "127.0.0.1";
gatewayDatabase.port = String(proxyAddress.port);

async function waitFor(check: () => Promise<boolean>, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function freePort(): Promise<number> {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function accountConfig(entry: Account) {
  return { enabled: true, baseUrl: fixture.baseUrl, botToken: entry.token,
    dmPolicy: "open", allowFrom: ["*"], groupPolicy: "open", groupAllowFrom: [fixture.adminUserId],
    requireMention: false, threadSessionScope: "channel", network: { dangerouslyAllowPrivateNetwork: true } };
}

async function channelAccounts(rpc: GatewayRpcClient): Promise<ChannelAccount[]> {
  const status = await rpc.channelsStatus() as { channelAccounts?: { mattermost?: ChannelAccount[] } };
  const accounts = status.channelAccounts?.mattermost;
  assert(Array.isArray(accounts), "Mattermost runtime status missing");
  return accounts;
}

async function channelRunning(rpc: GatewayRpcClient, accountId: string) {
  const account = (await channelAccounts(rpc)).find(entry => entry.accountId === accountId);
  return account?.running === true && account.connected === true;
}

function historyWithoutLocationCursor(history: History) {
  const messages = structuredClone(history.messages) as { __openclaw?: { transcriptPosition?: { source?: string } } }[];
  for (const message of messages) {
    const position = message.__openclaw?.transcriptPosition;
    assert(position && typeof position.source === "string", "History is missing its display cursor");
    position.source = "location-bound-cursor";
  }
  return messages;
}

async function transcriptBytes(anchor: PostgresAgentAnchor, sessionId: string) {
  const rows = await queryAgentStore(anchor, "SELECT seq::text, event_json, encode(event_zstd,'hex') AS event_zstd_hex, created_at::text FROM $schema.transcript_events WHERE session_id=$1 ORDER BY seq", [sessionId]);
  assert(rows.length > 0, "Seeded transcript is empty");
  return rows;
}

async function startGateway(name: string, entries: Account[]): Promise<Gateway> {
  const home = path.join(work, name);
  const state = path.join(home, "state");
  await fs.mkdir(state, { recursive: true });
  const configPath = path.join(home, "openclaw.json");
  const token = "synthetic-disposable-detach-proof";
  const port = await freePort();
  await fs.writeFile(configPath, JSON.stringify({
    database: { engine: "postgres", postgres: { connection: { source: "env", provider: "default", id: "OCTOGEE_DETACH_PROOF_PG" }, schemaPrefix } },
    browser: { enabled: false }, update: { checkOnStart: false }, discovery: { mdns: { mode: "off" } },
    gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token }, controlUi: { enabled: false }, tailscale: { mode: "off" } },
    agents: { ownership: "explicit", defaults: { skipBootstrap: true, model: { primary: "local/synthetic" } }, entries: Object.fromEntries(entries.map(entry => [entry.agentId, { workspace: path.join(home, "workspaces", entry.agentId) }])) },
    models: { catalogRefresh: { enabled: false }, providers: { local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-responses", apiKey: "synthetic-only", models: [{ id: "synthetic", name: "Synthetic fixture", contextWindow: 32768, maxTokens: 512 }] } } },
    plugins: { enabled: true, allow: ["mattermost", "openai"], slots: { memory: "none" }, entries: { mattermost: { enabled: true }, openai: { enabled: true } } },
    channels: { mattermost: { enabled: true, accounts: Object.fromEntries(entries.map(entry => [entry.accountId, accountConfig(entry)])) } },
    bindings: entries.map(entry => ({ agentId: entry.agentId, match: { channel: "mattermost", accountId: entry.accountId } })),
  }), { mode: 0o600 });
  let modulePath: string | undefined;
  for (const file of await fs.readdir(path.join(runtime, "dist"))) {
    if (file.startsWith("client-") && file.endsWith(".mjs") && (await fs.readFile(path.join(runtime, "dist", file), "utf8")).includes("export { GatewayClient,")) { modulePath = file; break; }
  }
  assert(modulePath, "Built public GatewayClient module missing");
  const { GatewayClient } = await import(pathToFileURL(path.join(runtime, "dist", modulePath)).href);
  let hello!: () => void;
  let failure!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { hello = resolve; failure = reject; });
  const client: FixtureClient = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token, deviceIdentity: generateIdentity(), clientName: "gateway-client", clientDisplayName: "Disposable Octogee proof", clientVersion: "1", mode: "backend", role: "operator", scopes: ["operator.admin"], requestTimeoutMs: 120_000, onHelloOk: hello, onConnectError: failure });
  const handle = await fs.open(path.join(work, `${name}.log`), "w");
  const child = spawn(process.execPath, [path.join(runtime, "dist/entry.js"), "gateway", "run", "--port", String(port), "--bind", "loopback", "--auth", "token", "--tailscale", "off", "--allow-unconfigured"], {
    cwd: runtime, env: { PATH: process.env.PATH, HOME: home, USER: "detach-proof", LANG: "en_US.UTF-8", NO_COLOR: "1", CI: "1",
      OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_NO_RESPAWN: "1", OCTOGEE_DETACH_PROOF_PG: gatewayDatabase.href,
      OPENCLAW_SKIP_CRON: "1", OPENCLAW_SKIP_GMAIL_WATCHER: "1", OPENCLAW_SKIP_CANVAS_HOST: "1", OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1" },
    stdio: ["ignore", handle.fd, handle.fd],
  });
  const closed = once(child, "close");
  const rpc = createGatewayRpc({ url: `ws://127.0.0.1:${port}`, token, identity: generateIdentity(), callTimeoutMs: 120_000, onConnectTrace: item => { if (!item.success) log("rpc-connect-failed", { phase: item.stage, errorCode: item.errorCode }); } });
  const gateway: Gateway = { home, state, rpc, client, process: child, closed, log: handle };
  gateways.push(gateway);
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`${name} gateway exited ${child.exitCode}; see ${name}.log`);
    try { return (await fetch(`http://127.0.0.1:${port}/readyz`)).ok; } catch { return false; }
  }, `${name} ready`, 180_000);
  client.start();
  await ready;
  for (const entry of entries) await waitFor(() => channelRunning(rpc, entry.accountId), `Mattermost ${entry.accountId} connected`);
  log("gateway-ready", { name, accounts: entries.length });
  return gateway;
}

async function mattermostHelp(entry: Account) {
  const headers = { authorization: `Bearer ${fixture.adminToken}`, "content-type": "application/json" };
  const response = await fetch(`${fixture.baseUrl}/api/v4/posts`, { method: "POST", redirect: "error", headers, body: JSON.stringify({ channel_id: entry.channelId, message: "/help" }) });
  assert(response.ok, `Mattermost fixture post failed: ${response.status}`);
  const post = await response.json() as { id: string; create_at: number };
  await waitFor(async () => {
    const result = await fetch(`${fixture.baseUrl}/api/v4/channels/${encodeURIComponent(entry.channelId)}/posts?per_page=30`, { redirect: "error", headers });
    assert(result.ok, `Mattermost fixture history failed: ${result.status}`);
    const body = await result.json() as { posts: Record<string, { user_id: string; create_at: number; message: string }> };
    return Object.values(body.posts).some(item => item.user_id === entry.botUserId && item.create_at >= post.create_at && item.message.length > 0);
  }, `real Mattermost reply from ${entry.accountId}`);
}

try {
  await sql.connect();
  const source = await startGateway("source", [keeper, ...travelers]);
  await mattermostHelp(keeper);
  const histories = new Map<string, History>();
  const identities = new Map<string, PostgresAgentAnchor>();
  const transcripts = new Map<string, unknown[]>();
  const key = (entry: Account) => `agent:${entry.agentId}:mattermost:channel:${entry.channelId}`;
  for (const entry of travelers) {
    await source.client.request("sessions.create", { agentId: entry.agentId, key: key(entry) });
    await source.client.request("chat.inject", { sessionKey: key(entry), message: `Synthetic retained history for ${entry.agentId}` });
    histories.set(entry.agentId, await source.client.request<History>("chat.history", { sessionKey: key(entry) }));
    await fs.mkdir(path.join(source.home, "workspaces", entry.agentId), { recursive: true });
    await fs.writeFile(path.join(source.home, "workspaces", entry.agentId, "retained.txt"), entry.agentId);
  }
  const quiesceStarted = performance.now();
  await setUserChannelsRunning(source.rpc, "detachproof", false);
  const channelStopMs = performance.now() - quiesceStarted;
  for (const entry of travelers) assert.equal((await channelAccounts(source.rpc)).find(account => account.accountId === entry.accountId)?.running, false);
  const samples = [];
  for (const entry of travelers) {
    const anchor = path.join(source.state, "agents", entry.agentId, "agent", "openclaw-agent.sqlite");
    const before = readPostgresAgentAnchor(anchor);
    assert(before, "Source did not create a PostgreSQL agent anchor");
    transcripts.set(entry.agentId, await transcriptBytes(before, histories.get(entry.agentId)!.sessionId));
    await sql.query("SELECT pg_stat_statements_reset()");
    activeDelay = latencyMs;
    const started = performance.now();
    try {
      const result = await deleteRosterAgents([entry.agentId], { rpc: source.rpc, preserveStore: true, log: message => log("octogee", { message }) });
      assert.deepEqual(result, [{ agentId: entry.agentId, status: "deleted" }]);
    } finally { activeDelay = 0; }
    const ms = performance.now() - started;
    const count = await sql.query("SELECT sum(calls)::int AS calls FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%pg_stat_statements%'");
    const config = (await source.rpc.configGet()).config as { agents: { entries: Record<string, unknown> }; bindings: { agentId: string }[] };
    assert(!config.agents.entries[entry.agentId]);
    assert(!config.bindings.some(binding => binding.agentId === entry.agentId));
    await assert.rejects(source.client.request("chat.inject", { sessionKey: key(entry), message: "Old source must refuse" }));
    assert.deepEqual(readPostgresAgentAnchor(anchor), before, "Detach changed the PostgreSQL store identity");
    identities.set(entry.agentId, before);
    assert.equal(await fs.readFile(path.join(source.home, "workspaces", entry.agentId, "retained.txt"), "utf8"), entry.agentId);
    assert(await channelRunning(source.rpc, keeper.accountId));
    assert.equal((await channelAccounts(source.rpc)).find(account => account.accountId === entry.accountId)?.running, false, "Detached source account restarted");
    samples.push({ agentId: entry.agentId, ms, sqlCalls: count.rows[0].calls });
    log("detached", samples.at(-1));
  }
  const snapshotRoot = path.join(work, "snapshots");
  await exportAgentStoreSnapshots({
    sources: travelers.map(entry => ({ cwd: source.state, path: `agents/${entry.agentId}` })),
    exportRoot: snapshotRoot,
    detachAgent: async agentId => {
      assert(identities.has(agentId), "Snapshot export requires the confirmed native detach receipt");
      const { config } = await source.rpc.configGet();
      assert(!(config as { agents: { entries: Record<string, unknown> } }).agents.entries[agentId]);
    },
  });
  const target = await startGateway("target", [targetKeeper]);
  const prepared = await prepareAgentStoreSnapshots({ stageDir: snapshotRoot, importDir: target.state, migrationId: randomUUID() });
  assert.equal(prepared.stores.length, travelers.length);
  await installPreparedAgentStores({ prepared, procRoot: "/proc", releaseAgent: async agentId => { throw new Error(`Fresh proof destination already owns ${agentId}`); } });
  for (const entry of travelers) {
    const workspace = path.join(target.home, "workspaces", entry.agentId);
    await fs.cp(path.join(source.home, "workspaces", entry.agentId), workspace, { recursive: true, errorOnExist: true, force: false });
    const created = await createRosterAgents([{ agentId: entry.agentId, workspace }], { rpc: target.rpc, log: message => log("octogee", { message }) });
    assert.equal(created[0].status, "created");
    const restored = await target.client.request<History>("chat.history", { sessionKey: key(entry) });
    const original = histories.get(entry.agentId)!;
    assert.equal(restored.sessionId, original.sessionId);
    assert.deepEqual(historyWithoutLocationCursor(restored), historyWithoutLocationCursor(original));
    assert.deepEqual(await transcriptBytes(identities.get(entry.agentId)!, original.sessionId), transcripts.get(entry.agentId), "Canonical transcript bytes changed during handoff");
    assert.deepEqual(readPostgresAgentAnchor(path.join(target.state, "agents", entry.agentId, "agent", "openclaw-agent.sqlite")), identities.get(entry.agentId));
    await target.client.request("chat.inject", { sessionKey: key(entry), message: "Destination owns this retained conversation" });
    await assert.rejects(source.client.request("chat.inject", { sessionKey: key(entry), message: "Source remains retired" }));
    const { config, hash } = await target.rpc.configGet();
    const current = config as { bindings: object[] };
    await target.rpc.configPatchAndWaitForChange({ channels: { mattermost: { accounts: { [entry.accountId]: accountConfig(entry) } } }, bindings: [...current.bindings, { agentId: entry.agentId, match: { channel: "mattermost", accountId: entry.accountId } }] }, hash, { replacePaths: ["bindings"] });
    await waitFor(() => channelRunning(target.rpc, entry.accountId), `adopted Mattermost account ${entry.accountId}`);
    log("adopted", { agentId: entry.agentId, exactHistoryPreserved: true, anchorPreserved: true });
  }
  await mattermostHelp(travelers[0]);
  await mattermostHelp(keeper);
  const build = JSON.parse(await fs.readFile(path.join(runtime, "dist/build-info.json"), "utf8"));
  const warm = samples.slice(1);
  const times = warm.map(sample => sample.ms).sort((a, b) => a - b);
  const sqlCalls = warm.map(sample => sample.sqlCalls as number).sort((a, b) => a - b);
  assert.equal(times.length, 5);
  const aggregates = { cold: samples[0], warm: { count: times.length, medianMs: times[2], p95MsNearestRank: times[Math.ceil(0.95 * times.length) - 1], minMs: times[0], maxMs: times.at(-1), medianObservedSqlCalls: sqlCalls[2] } };
  await fs.writeFile(output, JSON.stringify({ build, latencyMs, channelStopMs, samples, aggregates, handoff: "verified-postgres-anchor-snapshot", hostLoad: os.loadavg(), exactHistoryPreserved: true, anchorsPreserved: true, sourceWritesRejected: true, realMattermostReplyAfterAdoption: true, survivingMattermostReply: true, trace }, null, 2));
  log("complete", { output, sourceSha: build.commit });
} finally {
  activeDelay = 0;
  for (const gateway of gateways.reverse()) {
    await gateway.rpc.close();
    await gateway.client?.stop();
    gateway.process.kill("SIGTERM");
    await Promise.race([gateway.closed, new Promise(resolve => setTimeout(resolve, 15_000).unref())]);
    if (gateway.process.exitCode === null && gateway.process.signalCode === null) { gateway.process.kill("SIGKILL"); await gateway.closed; }
    await gateway.log.close();
  }
  await sql.end();
  await new Promise<void>(resolve => proxy.close(() => resolve()));
}
