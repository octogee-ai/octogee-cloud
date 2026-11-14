import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http, { type ServerResponse } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";

const { values } = parseArgs({ options: { "handoff-root": { type: "string" }, fixture: { type: "string" }, extensions: { type: "string" }, output: { type: "string" } } });
assert(values["handoff-root"] && values.fixture && values.extensions && values.output);
const input = path.resolve(values["handoff-root"]);
assert(input.startsWith("/proof/evidence/detach-proof-"), "Only a disposable handoff fixture is supported");
const dsn = new URL(process.env.OCTOGEE_DETACH_PROOF_PG!);
assert(dsn.hostname === "host.docker.internal" && dsn.pathname === "/detach_proof");
const root = await fs.mkdtemp("/proof/evidence/activation-abort-");
await fs.cp(input, root, { recursive: true });
const target = path.join(root, "target"), state = path.join(target, "state"), configPath = path.join(target, "openclaw.json");
const runtime = "/usr/local/lib/node_modules/openclaw";
const relocate = <T>(value: T): T => {
  if (typeof value === "string") return (value.startsWith(`${input}/`) ? `${root}${value.slice(input.length)}` : value) as T;
  if (Array.isArray(value)) return value.map(relocate) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, relocate(child)])) as T;
  return value;
};
const slug = "detachproof", gatewayId = "abort-proof", migrationId = "abort-while-chatting", podUid = "disposable-target-pod";
Object.assign(process.env, { OPENCLAW_DIR: state, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_AGENTS_DIR: path.join(state, "agents"), GATEWAY_CLASS: "isolated", GATEWAY_ID: gatewayId, POD_UID: podUid,
  OPENCLAW_AGENT_STORE_DSN: dsn.href, OPENCLAW_NO_RESPAWN: "1", HOME: target,
  MM_URL: "http://host.docker.internal:62065", MM_SITE_URL: "http://host.docker.internal:62065",
  MM_INTERACTIONS_CALLBACK_BASE_URL: "http://127.0.0.1:3000", MM_INTERACTIONS_ALLOWED_SOURCE_IPS: "127.0.0.1/32",
  FLEET_BROKER_URL: "http://127.0.0.1:9", OCTOGEE_API_SA_TOKEN_PATH: path.join(target, "synthetic-token") });
await fs.writeFile(process.env.OCTOGEE_API_SA_TOKEN_PATH!, "synthetic-abort-proof");
const { reconcilePlatformInvariants } = await import("@octogee/core/system-config-invariants");
const { readPostgresAgentAnchor, queryAgentStore } = await import("@octogee/core/agent-postgres");
const { generateIdentity } = await import("@octogee/core/gateway-device-identity");
const { deploymentEnvironmentSettings } = await import("@octogee/core/deployment-environment");
const { createGatewayRpc } = await import("../lib/gateway-rpc.js");
const { buildSafeDefaultAgent, SAFE_DEFAULT_AGENT_ID } = await import("../lib/openclaw-config-users.js");
const { buildBrokeredLifecycleAdapter } = await import("../lib/user-lifecycle-broker-adapter.js");
const { createAbortRsyncImportHandler } = await import("../lib/fleet-http-migration.js");
const { signFleetRequest, gatewayScopedJobId } = await import("../lib/fleet-signature.js");
const express = (await import("express")).default;
const config = relocate(JSON.parse(await fs.readFile(configPath, "utf8")));
const unmatched = buildSafeDefaultAgent(); delete unmatched.id;
config.agents.entries[SAFE_DEFAULT_AGENT_ID] = unmatched;
config.agents.defaults.authInheritance.agentId = SAFE_DEFAULT_AGENT_ID;
config.agents.defaults.systemAgent.agentId = SAFE_DEFAULT_AGENT_ID;
config.talk.agentId = SAFE_DEFAULT_AGENT_ID;
await fs.mkdir(path.join(state, "agents", SAFE_DEFAULT_AGENT_ID, "agent"), { recursive: true });
await fs.mkdir(path.join(state, "workspaces", SAFE_DEFAULT_AGENT_ID), { recursive: true });
delete config.agents.entries["octogee-targetkeeper-coach"];
delete config.channels.mattermost.accounts["targetkeeper-coach"];
config.bindings = config.bindings.filter((binding: { agentId: string }) => binding.agentId !== "octogee-targetkeeper-coach");
await fs.cp(path.join(target, "workspaces"), path.join(state, "workspaces"), { recursive: true });
for (const [id, entry] of Object.entries(config.agents.entries)) {
  (entry as { workspace: string }).workspace = path.join(state, "workspaces", id);
}
config.database.postgres.connection.id = "OCTOGEE_DETACH_PROOF_PG";
reconcilePlatformInvariants(config, { gatewayClass: "shared" });
reconcilePlatformInvariants(config, { gatewayClass: "isolated", gatewayId, apiOrigin: deploymentEnvironmentSettings("test").appOrigin });
const agents = Object.keys(config.agents.entries).filter(id => id !== SAFE_DEFAULT_AGENT_ID);
const anchors = new Map<string, unknown>(), transcripts = new Map<string, unknown>();
const transcript = (file: string) => {
  const anchor = readPostgresAgentAnchor(file); assert(anchor);
  return queryAgentStore(anchor, "SELECT session_id, seq::text, event_json, encode(event_zstd, 'hex') AS event_zstd, created_at::text FROM $schema.transcript_events ORDER BY session_id, seq");
};
for (const id of agents) {
  const file = path.join(state, "agents", id, "agent/openclaw-agent.sqlite");
  const anchor = readPostgresAgentAnchor(file);
  assert(anchor?.schema.startsWith("detachproof_"));
  anchors.set(id, anchor);
  transcripts.set(id, await transcript(file));
}
await fs.rm(path.join(state, "extensions"), { recursive: true, force: true });
await fs.symlink(path.resolve(values.extensions), path.join(state, "extensions"));
await fs.writeFile(path.join(state, "builder-claim.json"), JSON.stringify({ schemaVersion: 1, gatewayId, ownerUid: "synthetic-owner", builderSlug: slug, leaseId: null, generation: null, claimedAt: 1, overlayAppliedAt: 1 }));
const held = { version: 1, podUid, role: "target", mode: "held", phase: "held", migrationId, slug, targetPodUid: podUid } as const;
const supervisor = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    assert.equal(JSON.parse(body).action, "status");
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(held));
  });
});
supervisor.listen(path.join(state, ".surge-openclaw-process-gate.sock"));
await once(supervisor, "listening");
const rpc = createGatewayRpc({ url: "ws://127.0.0.1:9", token: "synthetic-offline-target", identity: generateIdentity(), callTimeoutMs: 1000 });
const logs: string[] = [];
const adapter = buildBrokeredLifecycleAdapter({ client: {} as FleetBrokerClient, rpc, isIsolatedGateway: () => true, log: message => { logs.push(message); console.log(message); } });
const keys = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const app = express();
app.use(express.json({ verify: (request, _response, buffer) => { Object.assign(request, { rawBody: buffer.toString() }); } }));
app.post("/abort-rsync-import/:gatewayId", createAbortRsyncImportHandler({
  publicKey: keys.publicKey, gatewayId, adapter, log: message => { logs.push(message); console.log(message); },
  reserveSurgeTarget: async () => {}, releaseSurgeReadiness: async () => {}, surgeTargetLive: async () => false,
  admitLiveSurgeTarget: async () => { throw new Error("Held target must not become live"); }, liveSurgeTargetAssigned: async () => false,
  unreserveSurgeTarget: async (_request, cleanup) => { assert(cleanup); await cleanup(async () => {}); return held; },
  pauseSystemConfigWatch: async () => "fixture-watch-fence", resumeSystemConfigWatch: async () => true,
}));
const api = app.listen(0, "127.0.0.1"); await once(api, "listening");
const address = api.address(); assert(address && typeof address === "object");
const abort = async () => {
  const body = JSON.stringify({ migrationId, slug, mode: "pre", rpcPhase: "abort-rsync-import" });
  const response = await fetch(`http://127.0.0.1:${address.port}/abort-rsync-import/${gatewayId}`, { method: "POST", headers: { "content-type": "application/json", "X-Fleet-Controller-Signature": signFleetRequest(keys.privateKey, gatewayScopedJobId(migrationId, gatewayId), body) }, body });
  return { status: response.status, body: await response.json() as { message?: string } };
};
let heldReply: ServerResponse | undefined, completeProvider!: () => void;
const providerStarted = new Promise<void>(resolve => { completeProvider = resolve; });
const provider = http.createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    heldReply = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "synthetic-abort", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Working" }, finish_reason: null }] })}\n\n`);
    completeProvider();
  });
});
provider.listen(0, "127.0.0.1"); await once(provider, "listening");
const providerAddress = provider.address(); assert(providerAddress && typeof providerAddress === "object");
const fixture = JSON.parse(await fs.readFile(values.fixture, "utf8"));
const keeper = fixture.entries.find((entry: { accountId: string }) => entry.accountId === `${slug}-coach`);
assert(keeper && agents.includes(keeper.agentId));
const source = path.join(root, "active-source"), sourceConfigPath = path.join(source, "openclaw.json");
await fs.mkdir(source, { recursive: true });
const sourceConfig = relocate(JSON.parse(await fs.readFile(path.join(root, "source/openclaw.json"), "utf8")));
sourceConfig.agents.entries = { [keeper.agentId]: { workspace: path.join(source, "workspace") } };
sourceConfig.agents.defaults.authInheritance = { ...sourceConfig.agents.defaults.authInheritance, agentId: keeper.agentId };
sourceConfig.agents.defaults.systemAgent = { ...sourceConfig.agents.defaults.systemAgent, agentId: keeper.agentId };
sourceConfig.talk = { ...sourceConfig.talk, agentId: keeper.agentId };
sourceConfig.bindings = [{ agentId: keeper.agentId, match: { channel: "mattermost", accountId: keeper.accountId } }];
sourceConfig.channels.mattermost.accounts = { [keeper.accountId]: { ...sourceConfig.channels.mattermost.accounts[keeper.accountId], enabled: true } };
sourceConfig.database.postgres.connection.id = "OCTOGEE_DETACH_PROOF_PG";
sourceConfig.models.providers.local.baseUrl = `http://127.0.0.1:${providerAddress.port}/v1`;
sourceConfig.models.providers.local.api = "openai-completions";
await fs.writeFile(sourceConfigPath, JSON.stringify(sourceConfig));
const sourceLog = await fs.open(path.join(root, "active-source.log"), "w");
const child = spawn(process.execPath, [path.join(runtime, "dist/entry.js"), "gateway", "run", "--port", "18894", "--bind", "loopback", "--allow-unconfigured"], {
  cwd: runtime, env: { PATH: process.env.PATH, HOME: source, OPENCLAW_HOME: source, OPENCLAW_STATE_DIR: path.join(source, "state"), OPENCLAW_CONFIG_PATH: sourceConfigPath,
    OPENCLAW_NO_RESPAWN: "1", OCTOGEE_DETACH_PROOF_PG: dsn.href, OPENCLAW_SKIP_CRON: "1", OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1", OPENCLAW_SKIP_CANVAS_HOST: "1", OPENCLAW_SKIP_GMAIL_WATCHER: "1" },
  stdio: ["ignore", sourceLog.fd, sourceLog.fd],
});
const closed = once(child, "close");
const wait = async (check: () => Promise<boolean>, label: string) => {
  const deadline = Date.now() + 180_000;
  while (!await check()) { assert(Date.now() < deadline && child.exitCode === null, label); await new Promise(resolve => setTimeout(resolve, 200)); }
};
try {
  await wait(async () => { try { return (await fetch("http://127.0.0.1:18894/readyz")).ok; } catch { return false; } }, "Source must become ready");
  const mm = "http://host.docker.internal:62065";
  await new Promise(resolve => setTimeout(resolve, 2000));
  const post = await fetch(`${mm}/api/v4/posts`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${fixture.adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ channel_id: keeper.channelId, message: "Hold this synthetic reply until the user activation abort completes." }) });
  assert(post.ok);
  await Promise.race([providerStarted, new Promise((_, reject) => setTimeout(() => reject(new Error("Source chat did not reach the held provider")), 60_000).unref())]);
  assert(heldReply && !heldReply.writableEnded, "Source chat must remain active");
  const sourceAnchorPath = path.join(source, "state/agents", keeper.agentId, "agent/openclaw-agent.sqlite");
  const sourceAnchor = readPostgresAgentAnchor(sourceAnchorPath); assert(sourceAnchor);
  assert.notDeepEqual(sourceAnchor, anchors.get(keeper.agentId), "Pre-copy source and held target must own distinct stores for the same agent");
  const legacy = structuredClone(config); delete legacy.meta.migrations.skillWorkshopPlugin;
  await fs.writeFile(configPath, JSON.stringify(legacy));
  const red = await abort();
  assert.equal(red.status, 500, JSON.stringify(red)); assert(red.body.message?.includes("must be migrated first"), JSON.stringify(red));
  await fs.writeFile(configPath, JSON.stringify(config));
  const green = await abort(); assert.equal(green.status, 200, JSON.stringify(green));
  assert(!heldReply.writableEnded && child.exitCode === null, "Abort interrupted the active Shared conversation");
  assert.deepEqual(readPostgresAgentAnchor(sourceAnchorPath), sourceAnchor);
  for (const id of agents) {
    const file = path.join(state, "agents", id, "agent/openclaw-agent.sqlite");
    assert.deepEqual(readPostgresAgentAnchor(file), anchors.get(id));
    assert.deepEqual(await transcript(file), transcripts.get(id));
  }
  heldReply.end(`data: ${JSON.stringify({ id: "synthetic-abort", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: " — activation abort completed." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  await wait(async () => {
    const response = await fetch(`${mm}/api/v4/channels/${encodeURIComponent(keeper.channelId)}/posts?per_page=10`, { redirect: "error", headers: { authorization: `Bearer ${fixture.adminToken}` } });
    const data = await response.json() as { posts: Record<string, { user_id: string; message: string }> };
    return Object.values(data.posts).some(item => item.user_id === keeper.botUserId && item.message.includes("activation abort completed"));
  }, "Active source must deliver its reply after abort");
  await fs.writeFile(values.output, JSON.stringify({ sourceSha: JSON.parse(await fs.readFile(path.join(runtime, "dist/build-info.json"), "utf8")).commit,
    legacyAbortStatus: red.status, correctedAbortStatus: green.status, nativeDetachedAgents: agents.length, anchorsPreserved: true, exactTranscriptsPreserved: true,
    sourceAgentId: keeper.agentId, sourceStoreDistinctFromImportedTarget: true, sourceAnchorPreserved: true, sourceChatActiveDuringAbort: true, sourceReplyDelivered: true, logs }, null, 2));
  console.log(JSON.stringify({ stage: "complete", output: values.output }));
} finally {
  heldReply?.destroy();
  await rpc.close();
  child.kill("SIGTERM"); await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 15_000).unref())]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
  await sourceLog.close();
  await Promise.all([api, supervisor, provider].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
}
