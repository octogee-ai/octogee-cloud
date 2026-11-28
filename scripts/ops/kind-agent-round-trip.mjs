#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const NAMESPACE = "octogee-local";
const PROMPT = "Reply with one short sentence to confirm you can hear me.";
const FIRST_TURN_BUG = "A known OpenClaw bug can drop the first turn of an agent placed on a running gateway, "
  + "with \"Agent database has no PostgreSQL schema admission\" in the gateway log; this check does not retry";
const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const MODEL_REF = /^platform-([a-z]+)\/([a-z0-9][a-z0-9._:/-]*)$/;

const USAGE = `Usage: kind-agent-round-trip.mjs --state=DIR [--fleet=PATH] [--gateway=ID] [--user=NAME]
  [--model=platform-<provider>/<model>] [--reply-timeout=SECONDS]`;

export function parseArgs(argv) {
  const options = { fleet: "octogee-fleet", gateway: "shared-a", user: "lin", model: null, replyTimeoutMs: 300_000 };
  for (const arg of argv) {
    const [flag, value] = arg.split(/=(.*)/s, 2);
    if (value === undefined || value === "") throw new Error(`${flag} needs a value\n${USAGE}`);
    if (flag === "--state") options.state = resolve(value);
    else if (flag === "--fleet") options.fleet = value;
    else if (flag === "--gateway") options.gateway = value;
    else if (flag === "--user") options.user = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--reply-timeout") options.replyTimeoutMs = Number(value) * 1000;
    else throw new Error(`Unknown option ${flag}\n${USAGE}`);
  }
  if (!options.state) throw new Error(`--state is required\n${USAGE}`);
  if (!NAME.test(options.gateway)) throw new Error(`Invalid gateway id: ${options.gateway}`);
  if (!NAME.test(options.user)) throw new Error(`Invalid user name: ${options.user}`);
  if (options.model !== null && !MODEL_REF.test(options.model)) {
    throw new Error(`--model needs a platform model ref such as platform-openrouter/meta/muse-ember: ${options.model}`);
  }
  if (!Number.isFinite(options.replyTimeoutMs) || options.replyTimeoutMs <= 0) {
    throw new Error("--reply-timeout needs a positive number of seconds");
  }
  return options;
}

export function pinnedModels(ref) {
  return { freeTierModelRef: ref, builderAgentModelRef: ref, builderAgentFallbackModelRef: null };
}

export function upstreamModel(ref) {
  const [, provider, model] = MODEL_REF.exec(ref);
  return { provider, model };
}

export function gatewayReady(listing, id) {
  return (listing?.gateways ?? []).some(gateway => gateway.gatewayId === id && gateway.status === "ready");
}

export function findUser(listing, name) {
  return (listing?.users ?? []).find(user => user.name === name) ?? null;
}

export function userMounted(user, gatewayId) {
  return user?.provisioningStatus === "complete" && user?.mountedGatewayId === gatewayId;
}

export function agentReply(postList, { botUserId, after }) {
  return Object.values(postList?.posts ?? {})
    .filter(post => post.user_id === botUserId && post.create_at > after && !post.type && !post.delete_at)
    .filter(post => typeof post.message === "string" && post.message.trim() !== "")
    .sort((a, b) => a.create_at - b.create_at)[0] ?? null;
}

export function ledgerEvidence(rows, expected, caller = "the user") {
  const calls = rows.filter(event => Number(event.upstreamStatus) === 200);
  const matching = expected
    ? calls.filter(event => event.provider === expected.provider && event.model === expected.model)
    : calls;
  if (matching.length === 0) {
    const seen = rows.map(event => `${event.provider}/${event.model} HTTP ${event.upstreamStatus}`).join(", ") || "none";
    const wanted = expected ? `${expected.provider}/${expected.model}` : "any model";
    throw new Error(`The broker's usage ledger has no successful call to ${wanted} for ${caller} (recorded: ${seen})`);
  }
  return {
    calls: matching.length,
    provider: matching[0].provider,
    model: matching[0].model,
    totalTokens: matching.reduce((sum, event) => sum + (Number(event.totalTokens) || 0), 0),
    costUsd: matching.reduce((sum, event) => sum + (Number(event.costUsd) || 0), 0),
  };
}

export async function waitFor(check, { timeoutMs, intervalMs, label }, clock) {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (clock.now() >= deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);
    await clock.sleep(intervalMs);
  }
}

const PIN_MODEL_SQL = `INSERT INTO platform.platform_config (key, value, updated_at, updated_by)
VALUES ('models', :'value'::jsonb, :'now'::bigint, 'kind-agent-round-trip')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
`;

const LEDGER_SQL = `SELECT event::text FROM platform.model_broker_usage_events
WHERE owner_key = :'owner' AND created_at >= :'since'::bigint ORDER BY created_at;
`;

export function pinModel(deps, options) {
  if (!options.model) return;
  deps.sql(PIN_MODEL_SQL, { value: JSON.stringify(pinnedModels(options.model)), now: String(deps.clock.now()) });
  deps.log(`Pinned the agent model to ${options.model}`);
}

export async function waitForUserMount(deps, options, gatewayId, timeoutMs = 600_000) {
  const user = await waitFor(() => {
    const current = deps.fleet(["user", "inspect", options.user]).user;
    return userMounted(current, gatewayId) ? current : null;
  }, { timeoutMs, intervalMs: 10_000, label: `${options.user} to be provisioned and mounted on ${gatewayId}` }, deps.clock);
  deps.log(`${options.user} is provisioned and mounted on ${gatewayId}`);
  return user;
}

export async function placeOnSharedGateway(deps, options) {
  const { log, clock } = deps;
  if (!(deps.fleet(["gateway", "ls"]).gateways ?? []).some(gateway => gateway.gatewayId === options.gateway)) {
    deps.fleet(["gateway", "add", `--id=${options.gateway}`, "--apply"]);
    log(`Added shared gateway ${options.gateway}`);
  }
  await waitFor(() => gatewayReady(deps.fleet(["gateway", "ls"]), options.gateway),
    { timeoutMs: 900_000, intervalMs: 10_000, label: `gateway ${options.gateway} to be ready` }, clock);
  deps.waitForGatewayPod(options.gateway);
  log(`Gateway ${options.gateway} is ready`);

  let user = findUser(deps.fleet(["user", "ls"]), options.user);
  if (!user) {
    deps.fleet(["user", "add", options.user, `--email=${options.user}@example.com`, "--apply"]);
    log(`Added user ${options.user}`);
  }
  user = findUser(deps.fleet(["user", "ls"]), options.user);
  if (user?.assignedGatewayId !== options.gateway) {
    deps.fleet(["user", "assign", options.user, `--to=${options.gateway}`, "--apply"]);
    log(`Assigned ${options.user} to ${options.gateway}`);
  }
  return waitForUserMount(deps, options, options.gateway);
}

export async function coachRoundTrip(deps, options, ledger) {
  const { log, clock } = deps;
  const issued = deps.fleet(["user", "issue-passwords", options.user, "--apply"]).response;
  const chat = await deps.signIn(issued.chat.username, issued.chat.password);
  const bot = await chat.get(`/api/v4/users/username/${options.user}-coach`);
  const teams = await chat.get("/api/v4/users/me/teams");
  const channels = await Promise.all(teams.map(team =>
    chat.get(`/api/v4/teams/${team.id}/channels/name/${options.user}-coach`).catch(() => null)));
  const channel = channels.find(Boolean);
  if (!channel) throw new Error(`${options.user} has no ${options.user}-coach channel`);

  const sent = await chat.post("/api/v4/posts", { channel_id: channel.id, message: PROMPT });
  log(`Posted to ${options.user}-coach; waiting up to ${Math.round(options.replyTimeoutMs / 1000)}s for ${bot.username}`);
  const reply = await waitFor(async () => agentReply(
    await chat.get(`/api/v4/channels/${channel.id}/posts?since=${sent.create_at}`),
    { botUserId: bot.id, after: sent.create_at },
  ), { timeoutMs: options.replyTimeoutMs, intervalMs: 5_000, label: `a reply from ${bot.username}` }, clock)
    .catch(error => {
      throw new Error(`${error.message}. ${FIRST_TURN_BUG}`);
    });
  log(`${bot.username} replied after ${Math.round((reply.create_at - sent.create_at) / 1000)}s (${reply.message.trim().length} characters)`);

  const expected = options.model ? upstreamModel(options.model) : null;
  const ledgerDeadline = clock.now() + 60_000;
  const evidence = await waitFor(() => {
    const rows = deps.sql(ledger.sql, { ...ledger.variables, since: String(sent.create_at) })
      .split("\n").filter(Boolean).map(line => JSON.parse(line));
    try {
      return ledgerEvidence(rows, expected, ledger.caller);
    } catch (error) {
      if (clock.now() < ledgerDeadline) return null;
      throw new Error(`${error.message}. ${bot.username} replied: ${JSON.stringify(reply.message.trim().slice(0, 200))}`);
    }
  }, { timeoutMs: 60_000, intervalMs: 5_000, label: "the broker's usage ledger" }, clock);
  log(`Ledger: ${evidence.calls} call(s) to ${evidence.provider}/${evidence.model}, ${evidence.totalTokens} tokens, $${evidence.costUsd.toFixed(6)}`);
  return { reply, evidence };
}

export async function run(deps, options) {
  pinModel(deps, options);
  const user = await placeOnSharedGateway(deps, options);
  return coachRoundTrip(deps, options, { sql: LEDGER_SQL, variables: { owner: user.id }, caller: "the user" });
}

function portForward(kubectl, service, remotePort) {
  return new Promise((resolvePort, reject) => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- kubectl is the operator and CI cluster client on PATH.
    const child = spawn("kubectl", [...kubectl, "port-forward", "--address=127.0.0.1", `svc/${service}`, `:${remotePort}`],
      { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Port-forward to ${service} did not start: ${output.trim()}`)); }, 30_000);
    const read = chunk => {
      output += chunk;
      const match = new RegExp(`Forwarding from 127\\.0\\.0\\.1:(\\d+) -> ${remotePort}`).exec(output);
      if (!match) return;
      clearTimeout(timeout);
      resolvePort({ origin: `http://127.0.0.1:${match[1]}`, close: () => child.kill() });
    };
    child.stdout.setEncoding("utf8").on("data", read);
    child.stderr.setEncoding("utf8").on("data", read);
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Port-forward to ${service} exited with ${code}: ${output.trim()}`)); });
  });
}

export function command(file, args, { input, env } = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", input, env, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(file)} ${args.join(" ")} exited with ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function fleetJson(args, stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`octogee-fleet ${args.filter(arg => !arg.startsWith("-")).join(" ")} printed output that is not JSON`);
  }
}

async function mattermostSession(origin, username, password) {
  const login = await fetch(`${origin}/api/v4/users/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login_id: username, password }),
  });
  const token = login.headers.get("token");
  if (!login.ok || !token) throw new Error(`Mattermost sign-in as ${username} failed with HTTP ${login.status}`);
  const call = async (method, path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`Mattermost ${method} ${path.split("?")[0]} returned HTTP ${response.status}`);
    return response.json();
  };
  return { token, get: path => call("GET", path), post: (path, body) => call("POST", path, body) };
}

function platformApiSession(origin, token) {
  return {
    post: async (path, body) => {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Platform API POST ${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    },
  };
}

export function kubectlArgs(state) {
  return [`--kubeconfig=${join(state, "kubeconfig")}`, `--context=kind-${basename(state)}`, "-n", NAMESPACE];
}

export async function kindDependencies(options) {
  const kubectl = kubectlArgs(options.state);
  const forwards = [];
  const scratch = mkdtempSync(join(tmpdir(), "kind-agent-round-trip-"));
  const close = () => {
    for (const forward of forwards) forward.close();
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    const admin = await portForward(kubectl, "glm-controller", 8080);
    forwards.push(admin);
    const config = JSON.parse(readFileSync(join(options.state, "fleet-config.json"), "utf8"));
    config.environments.kind.adminApiOrigin = admin.origin;
    const fleetConfig = join(scratch, "fleet-config.json");
    writeFileSync(fleetConfig, JSON.stringify(config), { mode: 0o600 });
    const fleetEnv = { ...process.env, OCTOGEE_FLEET_CONFIG: fleetConfig };
    return {
      close,
      scratch,
      log: line => console.log(`[agent-round-trip] ${line}`),
      clock: { now: () => Date.now(), sleep: ms => new Promise(done => setTimeout(done, ms)) },
      fleet: args => fleetJson(args, command(options.fleet, ["--env=kind", ...args, "--format=json"], { env: fleetEnv })),
      sql: (sql, variables) => command("kubectl", [...kubectl, "exec", "-i", "statefulset/postgres", "--",
        "psql", "-U", "postgres", "-d", "octogee_platform", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
        ...Object.entries(variables).flatMap(([key, value]) => ["-v", `${key}=${value}`])], { input: sql }),
      waitForGatewayPod: id => command("kubectl", [...kubectl, "rollout", "status", `deployment/octogee-gateway-${id}`, "--timeout=10m"]),
      signIn: async (username, password) => {
        const chat = await portForward(kubectl, "mattermost", 8065);
        forwards.push(chat);
        return mattermostSession(chat.origin, username, password);
      },
      platformApi: async token => {
        const api = await portForward(kubectl, "octogee-api", 3001);
        forwards.push(api);
        return platformApiSession(api.origin, token);
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const deps = await kindDependencies(options);
  try {
    await run(deps, options);
    deps.log("The agent replied and the broker recorded the call");
  } finally {
    deps.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[agent-round-trip] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
