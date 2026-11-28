#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  coachRoundTrip,
  command,
  kindDependencies,
  kubectlArgs,
  parseArgs,
  pinModel,
  placeOnSharedGateway,
  waitFor,
  waitForUserMount,
} from "./kind-agent-round-trip.mjs";

export const POD_SIZING_PROFILE = "pod-s";
export const POD_PROFILE = {
  isolation: "isolated",
  sizingTier: "s",
  computer: { runtime: "cluster", homeSizeGiB: 2 },
  fallbackStorageGb: null,
};
export const IDENTITY_FAILURE = "Workspace identity initialization failed";

const IDENTITY_BOOT = "/home/node/.openclaw/workspace-identity-boot";
const IDENTITY_READY = "/home/node/.openclaw/workspace-identity-ready";
const HOME_MARKER = "/home/node/kind-isolated-gateway-marker";
const BOOT_TIMEOUT_MS = 900_000;
const MIGRATION_TIMEOUT_MS = 600_000;
const MIGRATION_IN_FLIGHT = new Set(["pending", "running"]);
const MARKER_READ_FAILURE_LIMIT = 3;
const LOG_TAIL_LINES = 40;
const EVENT_LIMIT = 20;
const SECRET_PATTERNS = [
  [/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "$1 [redacted]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]"],
  [/\b(?:sk|ghp|gho|ghs|ghu|github_pat)[-_][A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/(\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1[redacted]@"],
  [/\b([\w-]*(?:token|secret|password|passwd|api[_-]?key)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"',&}]+/gi, "$1$2[redacted]"],
];

const OPENCLAW_CONFIG = "/home/node/.openclaw/system_config/openclaw.json";
const SHARED_OPENCLAW_CONFIG = "/home/node/.openclaw/openclaw.json";
const PROJECT_TIMEOUT_MS = 600_000;
const PROJECT_AGENT_STORE_SQL = `SELECT gateway_id FROM platform.agent_stores WHERE uid = :'uid' AND agent_id = :'agent';
`;
const ARCHIVE_PROJECT_SQL = `UPDATE platform.workspace_projects SET commercial_lifecycle_status = 'archived'
WHERE owner_uid = :'uid' AND project_slug = :'project';
`;
const RESTORE_PROJECT_SQL = `UPDATE platform.workspace_projects SET commercial_lifecycle_status = 'active'
WHERE owner_uid = :'uid' AND project_slug = :'project';
`;

export function projectSlug(now, name = "harbor") {
  return `${name}${now.toString(36)}`;
}

export function projectWorkspaceFile(user, slug, file) {
  return `/home/node/.openclaw/customers/${user}/projects/${slug}/${file}`;
}

export function projectAgentId(user, slug) {
  return `octogee-${user}-proj-${slug}-coach`;
}

export function configuresAgent(config, agentId) {
  const agents = JSON.parse(config).agents;
  if (agents?.entries && typeof agents.entries === "object" && !Array.isArray(agents.entries)) {
    return Object.hasOwn(agents.entries, agentId) && agents.entries[agentId] !== null;
  }
  if (Array.isArray(agents?.list)) return agents.list.some(agent => agent?.id === agentId);
  throw new Error("openclaw.json has neither agents.entries nor agents.list");
}

const GATEWAY_LEDGER_SQL = `SELECT event::text FROM platform.model_broker_usage_events
WHERE event->>'gatewayId' = :'gateway' AND created_at >= :'since'::bigint ORDER BY created_at;
`;

export function identityReady({ boot, ready }, bootBeforePark = null) {
  return Boolean(boot) && boot === ready && boot !== bootBeforePark;
}

export function lastIdentityFailure(log) {
  return log.split("\n").filter(line => line.includes(IDENTITY_FAILURE)).at(-1)?.trim() ?? null;
}

function identityFailureNote(deps, gatewayId) {
  try {
    const line = lastIdentityFailure(deps.gatewayLog(gatewayId));
    return line ? `Last identity failure in the gateway log: ${line}` : `The gateway log has no "${IDENTITY_FAILURE}" line`;
  } catch (error) {
    return `The gateway log could not be read: ${error.message}`;
  }
}

function blockerNote(deps, gatewayId) {
  try {
    const gateway = (deps.fleet(["gateway", "ls"]).gateways ?? []).find(entry => entry.gatewayId === gatewayId);
    const blocker = gateway?.lastError?.message;
    return blocker ? `${gatewayId} is blocked: ${blocker}` : null;
  } catch (error) {
    return `${gatewayId}'s last error could not be read: ${error.message}`;
  }
}

export async function waitForWorkspaceIdentities(deps, gatewayId, bootBeforePark = null) {
  let readFailure = null;
  let readFailuresInARow = 0;
  try {
    await waitFor(() => {
      if (!deps.gatewayRunning(gatewayId)) {
        readFailuresInARow = 0;
        return false;
      }
      try {
        const markers = {
          boot: deps.readGatewayFile(gatewayId, IDENTITY_BOOT),
          ready: deps.readGatewayFile(gatewayId, IDENTITY_READY),
        };
        readFailure = null;
        readFailuresInARow = 0;
        return identityReady(markers, bootBeforePark);
      } catch (error) {
        readFailure = error.message;
        readFailuresInARow += 1;
        if (readFailuresInARow < MARKER_READ_FAILURE_LIMIT) return false;
        throw new Error(`${gatewayId}'s gateway container is running, but its identity markers could not be read ${readFailuresInARow} times in a row`);
      }
    }, { timeoutMs: BOOT_TIMEOUT_MS, intervalMs: 10_000, label: `${gatewayId} to mark its workspace identities ready for this boot` }, deps.clock);
  } catch (error) {
    const notes = [
      error.message,
      identityFailureNote(deps, gatewayId),
      blockerNote(deps, gatewayId),
      readFailure && `The last marker read failed: ${readFailure}`,
    ];
    throw new Error(notes.filter(Boolean).join(". "));
  }
  deps.log(`${gatewayId} marked its workspace identities ready for this boot`);
}

function fieldText(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function migrationState(operation) {
  const steps = operation.steps ?? [];
  const step = steps.find(entry => entry.status === "failed") ?? steps.findLast(entry => entry.status === "running");
  const error = step?.error ?? operation.error;
  return `${operation.status}${step ? ` at step ${step.name}` : ""}${error ? `: ${fieldText(error)}` : ""}`;
}

function migrationOperationId(response, what) {
  const operationId = response?.operationId;
  if (typeof operationId !== "string" || operationId === "") throw new Error(`${what} answered without an operation id`);
  return operationId;
}

export async function waitForMigration(deps, operationId, gatewayId) {
  const migration = `migration ${operationId} to ${gatewayId}`;
  let operation = null;
  try {
    await waitFor(() => {
      operation = deps.fleet(["ops", "inspect", operationId]).operation;
      if (typeof operation?.status !== "string") throw new Error(`ops inspect ${operationId} answered without an operation status`);
      return !MIGRATION_IN_FLIGHT.has(operation.status);
    }, { timeoutMs: MIGRATION_TIMEOUT_MS, intervalMs: 5_000, label: `${migration} to finish` }, deps.clock);
  } catch (error) {
    throw new Error(operation ? `${error.message}; it is ${migrationState(operation)}` : error.message);
  }
  if (operation.status !== "succeeded") throw new Error(`${migration} ended ${migrationState(operation)}`);
  deps.log(`${migration} succeeded`);
}

export function redactSecrets(text) {
  return SECRET_PATTERNS.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), text);
}

function containerLine(status) {
  const { running, waiting, terminated } = status.state ?? {};
  const now = running ? `running since ${running.startedAt}`
    : waiting ? `waiting: ${waiting.reason}${waiting.message ? ` (${waiting.message})` : ""}`
    : terminated ? `exited ${terminated.exitCode} (${terminated.reason})` : "in no state";
  const last = status.lastState?.terminated;
  const lastExit = last ? `, last exited ${last.exitCode} (${last.reason}) at ${last.finishedAt}` : "";
  return `${status.name}: ${status.ready ? "ready" : "not ready"}, ${status.restartCount} restarts, ${now}${lastExit}`;
}

function podLines(pods) {
  if (pods.length === 0) return ["none"];
  return pods.flatMap(pod => [
    `pod ${pod.metadata.name}: ${pod.status?.phase ?? "no phase"}`,
    ...[...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]
      .map(status => `  ${containerLine(status)}`),
  ]);
}

function eventLines(events) {
  if (events.length === 0) return ["none"];
  return events
    .map(event => ({ at: event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ?? "", event }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-EVENT_LIMIT)
    .map(({ at, event }) => `${at} ${event.type} ${event.reason} ${event.involvedObject.kind.toLowerCase()}/`
      + `${event.involvedObject.name}${event.count > 1 ? ` (${event.count} times)` : ""}: ${event.message}`);
}

function selects(selector, labels) {
  return Object.entries(selector?.matchLabels ?? {}).every(([key, value]) => labels[key] === value)
    && (selector?.matchExpressions ?? []).every(({ key, operator, values = [] }) => {
      if (operator === "In") return values.includes(labels[key]);
      if (operator === "NotIn") return !values.includes(labels[key]);
      if (operator === "Exists") return Object.hasOwn(labels, key);
      return !Object.hasOwn(labels, key);
    });
}

function policyLines(policies, pods) {
  const labels = pods[0]?.metadata?.labels;
  if (!labels) return ["no pod to match them against"];
  const selecting = policies.filter(policy => selects(policy.spec?.podSelector, labels));
  if (selecting.length === 0) return ["none"];
  return selecting.map(policy => {
    const types = policy.spec.policyTypes ?? (policy.spec.egress ? ["Ingress", "Egress"] : ["Ingress"]);
    return `${policy.metadata.name} (${types.join(", ")})`;
  });
}

function tail(log) {
  const lines = log.trimEnd().split("\n");
  return lines.slice(-LOG_TAIL_LINES);
}

function section(title, read) {
  try {
    return [`${title}:`, ...read().map(line => `  ${line}`)];
  } catch (error) {
    return [`${title} could not be read: ${error.message}`];
  }
}

function homeClaimName(gatewayId) {
  return `octogee-gateway-${gatewayId}-data`;
}

function gatewayObjectNames(gatewayId, pods) {
  const replicaSets = pods.flatMap(pod => (pod.metadata?.ownerReferences ?? [])
    .filter(owner => owner.kind === "ReplicaSet").map(owner => owner.name));
  return [...new Set([`octogee-gateway-${gatewayId}`, ...replicaSets, ...pods.map(pod => pod.metadata.name), homeClaimName(gatewayId)])];
}

export function gatewayDiagnostics(deps, gatewayId) {
  let pods = [];
  let podReadError = null;
  try {
    pods = deps.gatewayPods(gatewayId);
  } catch (error) {
    podReadError = error;
  }
  const lines = [
    `Diagnostics for ${gatewayId}, with secrets redacted:`,
    ...section("Its pods", () => {
      if (podReadError) throw podReadError;
      return podLines(pods);
    }),
    ...section("Its events, oldest first", () => eventLines(deps.gatewayEvents(gatewayObjectNames(gatewayId, pods)))),
    ...section("Network policies that select its pod", () => policyLines(deps.networkPolicies(), pods)),
    ...section(`The last ${LOG_TAIL_LINES} lines of its gateway container's log`, () => tail(deps.gatewayLog(gatewayId))),
  ];
  const restarted = pods.some(pod => (pod.status?.containerStatuses ?? [])
    .some(status => status.name === "gateway" && status.restartCount > 0));
  if (restarted) {
    lines.push(...section(`The last ${LOG_TAIL_LINES} lines of its previous gateway container's log`,
      () => tail(deps.previousGatewayLog(gatewayId))));
  }
  return redactSecrets(lines.join("\n"));
}

function requireBoundHome(deps, gatewayId) {
  const phase = deps.homeClaimPhase(gatewayId);
  if (phase !== "Bound") throw new Error(`${gatewayId}'s home claim is ${phase ?? "missing"}, not Bound`);
}

async function giveProject(deps, options, uid, name) {
  const issued = deps.fleet(["user", "issue-passwords", options.user, "--apply"]).response;
  const chat = await deps.signIn(issued.chat.username, issued.chat.password);
  const api = await deps.platformApi(chat.token);
  const slug = projectSlug(deps.clock.now(), name.toLowerCase());
  await api.post("/api/projects", { name, slug });
  const agentId = projectAgentId(options.user, slug);
  await waitFor(() => deps.sql(PROJECT_AGENT_STORE_SQL, { uid, agent: agentId }).trim() === options.gateway,
    { timeoutMs: PROJECT_TIMEOUT_MS, intervalMs: 10_000, label: `${agentId}'s store to be recorded on ${options.gateway}` }, deps.clock);
  deps.log(`Gave ${options.user} project ${slug}; ${agentId} has a store on ${options.gateway}`);
  return { slug, agentId };
}

async function waitForRosteredAgents(deps, gatewayId, agentIds) {
  await waitFor(() => {
    const config = deps.readGatewayFile(gatewayId, SHARED_OPENCLAW_CONFIG);
    return config !== null && agentIds.every(agentId => configuresAgent(config, agentId));
  }, { timeoutMs: PROJECT_TIMEOUT_MS, intervalMs: 10_000, label: `${gatewayId} to roster ${agentIds.join(" and ")}` }, deps.clock);
  deps.log(`${gatewayId} rostered ${agentIds.join(" and ")}`);
}

async function waitForDetachedAgent(deps, gatewayId, agentId) {
  await waitFor(() => {
    const config = deps.readGatewayFile(gatewayId, OPENCLAW_CONFIG);
    return config !== null && !configuresAgent(config, agentId);
  }, { timeoutMs: PROJECT_TIMEOUT_MS, intervalMs: 10_000, label: `${gatewayId} to detach archived project agent ${agentId}` }, deps.clock);
  deps.log(`${gatewayId} detached archived project agent ${agentId}`);
}

export async function run(deps, options) {
  const { log } = deps;
  pinModel(deps, options);
  const user = await placeOnSharedGateway(deps, options);
  const project = { uid: user.id, ...await giveProject(deps, options, user.id, "Harbor") };
  const active = await giveProject(deps, options, user.id, "Tide");

  deps.setSizingProfile(POD_SIZING_PROFILE, POD_PROFILE);
  log(`Set sizing profile ${POD_SIZING_PROFILE} to a pod with a ${POD_PROFILE.computer.homeSizeGiB} GiB home`);
  const giving = `user migrate --to-isolated=${POD_SIZING_PROFILE}`;
  const given = deps.fleet(["user", "migrate", options.user, `--to-isolated=${POD_SIZING_PROFILE}`, "--apply"]).response;
  const gatewayId = given?.gatewayId;
  if (typeof gatewayId !== "string" || gatewayId === "") throw new Error(`${giving} answered without a gateway id`);
  const operationId = migrationOperationId(given, giving);
  log(`Gave ${options.user} isolated gateway ${gatewayId} in migration ${operationId}`);
  let roundTrip;
  try {
    roundTrip = await serveParkResumeAndRetire(deps, options, { gatewayId, operationId }, { project, active });
  } catch (error) {
    throw new Error(redactSecrets(`${error.message}\n${gatewayDiagnostics(deps, gatewayId)}`));
  }
  return { gatewayId, ...roundTrip, ...await restoreOnSharedAndMoveOut(deps, options, project, active) };
}

async function restoreOnSharedAndMoveOut(deps, options, project, active) {
  const { log } = deps;
  await waitForRosteredAgents(deps, options.gateway, [active.agentId]);
  deps.sql(RESTORE_PROJECT_SQL, { uid: project.uid, project: project.slug });
  log(`Restored ${options.user}'s project ${project.slug} on ${options.gateway}`);
  await waitForRosteredAgents(deps, options.gateway, [project.agentId, active.agentId]);

  const moving = `user migrate --to-isolated=${POD_SIZING_PROFILE}`;
  const moved = deps.fleet(["user", "migrate", options.user, `--to-isolated=${POD_SIZING_PROFILE}`, "--apply"]).response;
  const gatewayId = moved?.gatewayId;
  if (typeof gatewayId !== "string" || gatewayId === "") throw new Error(`${moving} answered without a gateway id`);
  try {
    await waitForMigration(deps, migrationOperationId(moved, moving), gatewayId);
    await waitForUserMount(deps, options, gatewayId);
  } catch (error) {
    throw new Error(redactSecrets(`${error.message}\n${gatewayDiagnostics(deps, gatewayId)}`));
  }
  log(`Moved ${options.user} out again to isolated gateway ${gatewayId} after the restore`);
  return { secondGatewayId: gatewayId };
}

async function serveParkResumeAndRetire(deps, options, { gatewayId, operationId }, { project, active }) {
  const { log, clock } = deps;
  await waitForWorkspaceIdentities(deps, gatewayId);
  await waitForUserMount(deps, options, gatewayId);
  await waitForMigration(deps, operationId, gatewayId);
  requireBoundHome(deps, gatewayId);
  const roundTrip = await coachRoundTrip(deps, options,
    { sql: GATEWAY_LEDGER_SQL, variables: { gateway: gatewayId }, caller: `isolated gateway ${gatewayId}` });
  deps.sql(ARCHIVE_PROJECT_SQL, { uid: project.uid, project: project.slug });
  log(`Archived ${options.user}'s project ${project.slug} while they are on ${gatewayId}`);

  const marker = `${gatewayId}-${clock.now()}`;
  deps.writeGatewayFile(gatewayId, HOME_MARKER, marker);
  const bootBeforePark = deps.readGatewayFile(gatewayId, IDENTITY_BOOT);
  deps.fleet(["gateway", "park", gatewayId, "--apply"]);
  await waitFor(() => deps.gatewayPodCount(gatewayId) === 0,
    { timeoutMs: 300_000, intervalMs: 5_000, label: `${gatewayId}'s pod to stop after park` }, clock);
  requireBoundHome(deps, gatewayId);
  log(`Parked ${gatewayId}; its pod stopped and its home claim stayed Bound`);

  deps.fleet(["gateway", "resume", gatewayId, "--apply"]);
  await waitForWorkspaceIdentities(deps, gatewayId, bootBeforePark);
  await waitForUserMount(deps, options, gatewayId);
  if (deps.readGatewayFile(gatewayId, HOME_MARKER) !== marker) {
    throw new Error(`${gatewayId} lost its home across park and resume: ${HOME_MARKER} no longer holds what was written before park`);
  }
  log(`Resumed ${gatewayId} with its home intact`);
  await waitForDetachedAgent(deps, gatewayId, project.agentId);
  deps.removeGatewayFile(gatewayId, projectWorkspaceFile(options.user, active.slug, "SOUL.md"));
  log(`Removed the generated SOUL.md from ${options.user}'s project ${active.slug} on ${gatewayId}`);

  const returning = deps.fleet(["user", "migrate", options.user, `--to=${options.gateway}`, "--apply"]).response;
  await waitForMigration(deps, migrationOperationId(returning, `user migrate --to=${options.gateway}`), options.gateway);
  await waitForUserMount(deps, options, options.gateway, BOOT_TIMEOUT_MS);
  await waitFor(() => {
    const gateway = (deps.fleet(["gateway", "ls"]).gateways ?? []).find(entry => entry.gatewayId === gatewayId);
    return Array.isArray(gateway?.mountedUsers) && gateway.mountedUsers.length === 0;
  }, { timeoutMs: 300_000, intervalMs: 10_000, label: `${gatewayId}'s heartbeat to report no mounted users after the return` }, clock);
  deps.fleet(["gateway", "retire", gatewayId, "--apply"]);
  await waitFor(() => deps.gatewayPodCount(gatewayId) === 0 && deps.homeClaimPhase(gatewayId) === null,
    { timeoutMs: 600_000, intervalMs: 5_000, label: `${gatewayId}'s pod and home claim to be deleted after retire` }, clock);
  log(`Returned ${options.user} to ${options.gateway} with archived project agent ${project.agentId} and retired ${gatewayId}; its home claim is gone`);
  return roundTrip;
}

export function isolatedDependencies(base, options) {
  const kubectl = kubectlArgs(options.state);
  const deployment = gatewayId => `deployment/octogee-gateway-${gatewayId}`;
  const gatewayExec = (gatewayId, script, args, input) => command("kubectl",
    [...kubectl, "exec", ...(input === undefined ? [] : ["-i"]), deployment(gatewayId), "-c", "gateway", "--",
      "sh", "-c", script, "sh", ...args], { input });
  return {
    ...base,
    log: line => console.log(`[isolated-gateway] ${line}`),
    setSizingProfile: (name, profile) => {
      const file = join(base.scratch, `${name}.json`);
      writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
      base.fleet(["sizing", "set", name, `--file=${file}`, "--apply"]);
    },
    readGatewayFile: (gatewayId, path) => {
      const output = gatewayExec(gatewayId, 'if [ -e "$1" ]; then printf present; cat "$1"; else printf absent; fi', [path]);
      return output.startsWith("present") ? output.slice("present".length) : null;
    },
    writeGatewayFile: (gatewayId, path, content) => {
      gatewayExec(gatewayId, 'cat > "$1"', [path], content);
    },
    removeGatewayFile: (gatewayId, path) => {
      gatewayExec(gatewayId, 'test -f "$1" && rm "$1"', [path]);
    },
    gatewayLog: gatewayId => command("kubectl", [...kubectl, "logs", deployment(gatewayId), "-c", "gateway", "--tail=5000"]),
    previousGatewayLog: gatewayId => command("kubectl",
      [...kubectl, "logs", deployment(gatewayId), "-c", "gateway", "--previous", `--tail=${LOG_TAIL_LINES}`]),
    gatewayPods: gatewayId => JSON.parse(command("kubectl",
      [...kubectl, "get", "pods", "-l", `gateway-instance=${gatewayId}`, "-o", "json"])).items,
    gatewayEvents: names => names.flatMap(name => JSON.parse(command("kubectl",
      [...kubectl, "get", "events", "--field-selector", `involvedObject.name=${name}`, "-o", "json"])).items),
    networkPolicies: () => JSON.parse(command("kubectl", [...kubectl, "get", "networkpolicies", "-o", "json"])).items,
    homeClaimPhase: gatewayId => command("kubectl",
      [...kubectl, "get", "pvc", homeClaimName(gatewayId), "--ignore-not-found", "-o", "jsonpath={.status.phase}"])
      .trim() || null,
    gatewayPodCount: gatewayId => command("kubectl",
      [...kubectl, "get", "pods", "-l", `gateway-instance=${gatewayId}`, "-o", "name"])
      .split("\n").filter(Boolean).length,
    gatewayRunning: gatewayId => command("kubectl",
      [...kubectl, "get", "pods", "-l", `gateway-instance=${gatewayId}`, "-o",
        'jsonpath={.items[*].status.containerStatuses[?(@.name=="gateway")].state.running.startedAt}'])
      .trim() !== "",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const base = await kindDependencies(options);
  try {
    const deps = isolatedDependencies(base, options);
    const { gatewayId, secondGatewayId } = await run(deps, options);
    deps.log(`Isolated gateway ${gatewayId} served ${options.user}, kept their home through park and resume, and retired cleanly; `
      + `the restored project was rostered on ${options.gateway} and ${options.user} moved out again to ${secondGatewayId}`);
  } finally {
    base.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[isolated-gateway] ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  });
}
