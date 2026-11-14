import { prepareIsolatedPrelaunchConfig, systemConfigPath } from "../lib/system-config.js";
import { runOpenClaw } from "../lib/openclaw-cli.js";
import { currentGatewayContainerPidNamespace, recoverIsolatedPodGatewayLocks } from "../lib/stopped-gateway-locks.js";
import { prepareUserSystemStore } from "../lib/user-system-store.js";
import { userClaimSlug } from "@octogee/shared/server/user-claim";
import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("surge-openclaw-supervisor");
import { assertUserStoreMigrationComplete, assertUserPostgresSelection, migrateUserStores } from "../lib/user-store-migration.js";
import { beginWorkspaceIdentityBoot } from "@octogee/core/openclaw-workspace-bootstrap";
import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createSurgeOpenClawProcessGate,
  surgeOpenClawGatePhase,
  isSurgeOpenClawProcessSupervisorAction,
  surgeOpenClawProcessActionNamesMigration,
  surgeOpenClawProcessSocketPath,
  type SurgeOpenClawProcessGateState,
  type SurgeOpenClawProcessRequest,
  type SurgeOpenClawProcessSupervisorRequest,
} from "../lib/surge-openclaw-process-gate.js";
import { createSurgeReadinessGate } from "../lib/surge-readiness.js";
import { prepareOpenClawSqliteJournals } from "../lib/openclaw-sqlite-journal-preflight.js";
import { prepareGatewayStateStore } from "../lib/gateway-state-store-preparation.js";
import { createFleetBrokerClient, type FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { inspectConfiguredUserAgentStores } from "../lib/openclaw-user-store-preflight.js";
import {
  createOpenClawBootWatcher,
  type OpenClawBootWatcher,
} from "../lib/openclaw-boot-watcher.js";
import { readInstalledOpenClawBuild } from "../lib/openclaw-installed-build.js";
import { isPerUserControlIdentity } from "@octogee/shared/types/openclaw-proxy-identity";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";
import type { UserIdentity } from "../../shared/types/user-identity.js";

const DEFAULT_HEALTH_TIMEOUT_MS = 600_000;
const DEFAULT_STOP_GRACE_MS = 30_000;
const ORPHAN_REAP_POLL_MS = 250;
const INITIAL_START_RETRY_MIN_MS = 5_000;
const INITIAL_START_RETRY_MAX_MS = 60_000;
const SURGE_OPENCLAW_PID_FILE = ".surge-openclaw-process.pid";

interface SpawnedOpenClaw {
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: ChildProcess["once"];
  pid?: number;
}

export interface StartSurgeOpenClawSupervisorOptions {
  openclawDir: string;
  podUid: string;
  log: (message: string) => void;
  socketPath?: string;
  healthTimeoutMs?: number;
  stopGraceMs?: number;
  readinessReleased?: () => Promise<boolean>;
  prelaunchBoot?: boolean;
  preparePrelaunch?: (assertHeld: () => Promise<void>) => Promise<void>;
  assertPrelaunchAuthority?: () => Promise<void>;
  prepareSystemStore?: (assertStopped: () => Promise<void>) => Promise<void>;
  activationMigrationId?: string;
  spawnOpenClaw?: () => SpawnedOpenClaw;
  prepareTarget?: () => Promise<void>;
  prepareDatabases?: () => Promise<void>;
  migrateUserStores?: (assertHeld: () => Promise<void>) => Promise<void>;
  probeHealthz?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  createServer?: typeof http.createServer;
  onUnexpectedChildExit?: () => void;
  bootWatcher?: OpenClawBootWatcher;
}

export interface StartedSurgeOpenClawSupervisor {
  socketPath: string;
  state: () => Promise<SurgeOpenClawProcessGateState>;
  stop: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new Error(`invalid surge OpenClaw process supervisor ${field}`);
  }
  return value;
}

function parseRequest(value: unknown): SurgeOpenClawProcessSupervisorRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid surge OpenClaw process supervisor request");
  }
  const candidate = value as Record<string, unknown>;
  const action = candidate.action;
  if (!isSurgeOpenClawProcessSupervisorAction(action)) {
    throw new Error("invalid surge OpenClaw process supervisor action");
  }
  if (action === "migrate-builder-stores") return { action, expectedPodUid: requireString(candidate.expectedPodUid, "expectedPodUid") };
  if (!surgeOpenClawProcessActionNamesMigration(action)) return { action };
  return {
    action,
    migrationId: requireString(candidate.migrationId, "migrationId"),
    slug: requireString(candidate.slug, "slug"),
    targetPodUid: requireString(candidate.targetPodUid, "targetPodUid"),
  };
}

function requestIdentity(
  request: SurgeOpenClawProcessSupervisorRequest,
): SurgeOpenClawProcessRequest {
  if (!surgeOpenClawProcessActionNamesMigration(request.action)) {
    throw new Error("surge OpenClaw process supervisor request has no migration identity");
  }
  return {
    migrationId: request.migrationId!,
    slug: request.slug!,
    targetPodUid: request.targetPodUid!,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultProbeHealthz(): Promise<boolean> {
  return fetch("http://127.0.0.1:18789/healthz", { signal: AbortSignal.timeout(2_000) })
    .then((response) => response.ok)
    .catch(() => false);
}

const OPENCLAW_BINARY = "/usr/local/bin/openclaw";

// Detached: OpenClaw leads its own process group so a stop can reap the whole
// tree and a supervisor restart can reap an orphaned group by recorded pid.
const OPENCLAW_STACK_TRACE_LIMIT = "--stack-trace-limit=50";

export function openClawProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const withFailureStacks: NodeJS.ProcessEnv = {
    ...env,
    OPENCLAW_DEBUG: "1",
    NODE_OPTIONS: [env.NODE_OPTIONS?.trim(), OPENCLAW_STACK_TRACE_LIMIT].filter(Boolean).join(" "),
  };
  if (!isPerUserControlIdentity(env)) return withFailureStacks;
  const { OPENCLAW_GATEWAY_TOKEN: podToken, ...rest } = withFailureStacks;
  if ((env.GATEWAY_RUNTIME_KIND === "gce-vm" ||
    (isIsolatedGatewayClassValue(env.GATEWAY_CLASS) && env.GATEWAY_RUNTIME_KIND === "cluster" && env.GATEWAY_COMPUTER_DESKTOP === "x11")) && podToken) {
    return { ...rest, OPENCLAW_GATEWAY_PASSWORD: podToken };
  }
  return rest;
}

function defaultSpawnOpenClaw(): SpawnedOpenClaw {
  beginWorkspaceIdentityBoot();
  return spawn(OPENCLAW_BINARY, ["gateway", "run", "--bind", "lan", "--port", "18789"], {
    stdio: "inherit",
    detached: true,
    env: openClawProcessEnv(),
  }) as SpawnedOpenClaw;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForSpawn(command: string, args: string[], options: SpawnOptionsWithoutStdio): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? signal ?? "unknown"}`));
    });
  });
}

export async function prepareConfiguredIsolatedTarget(
  env: NodeJS.ProcessEnv = process.env,
  run: typeof waitForSpawn = waitForSpawn,
): Promise<void> {
  const tsx = env.TSX ?? "/octogee/scripts/node_modules/.bin/tsx";
  const policy = env.GATEWAY_CLASS_POLICY_PATH ?? "/octogee/infra/gateway/apply-gateway-class-policy.mjs";
  const userEnv = { ...env, GATEWAY_CLASS: "isolated" };
  await run(tsx, ["/octogee/scripts/entrypoints/pre-boot-config.ts"], { env: userEnv });
  await run("node", [policy], { env: userEnv });
  await run(tsx, ["/octogee/scripts/entrypoints/ensure-configured-agent-runtime-dirs.ts"], { env: userEnv });
  await run(tsx, ["/octogee/scripts/entrypoints/clean-user-project-placeholders.ts"], { env: userEnv });
}

async function awaitHealthOrShutdown<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(signal.reason); });
  signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([work(), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

async function waitForHealth(input: {
  child: () => SpawnedOpenClaw | null;
  probe: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (await awaitHealthOrShutdown(input.signal, input.probe)) return;
    if (!input.child()) throw new Error("OpenClaw exited before becoming healthy");
    await awaitHealthOrShutdown(input.signal, () => input.sleep(250));
  }
  throw new Error(`OpenClaw did not become healthy within ${input.timeoutMs}ms`);
}

// A supervisor that died uncleanly leaves its OpenClaw running; that orphan
// would answer the health probe for a fresh child that then dies on
// EADDRINUSE, and a later hold would report success while the orphan keeps
// writing state. Reap the recorded group first; an unknown listener is fatal.
async function reapOrphanedOpenClawGroup(input: {
  probeHealthz: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  recordedChildPid: () => Promise<number | null>;
  forgetChildPid: () => Promise<void>;
  stopGraceMs: number;
  log: (message: string) => void;
}): Promise<void> {
  if (!(await input.probeHealthz())) return;
  const pid = await input.recordedChildPid();
  if (pid === null || !processAlive(pid)) {
    throw new Error("OpenClaw already answers on 18789 with no supervised child; refusing to start a second gateway");
  }
  input.log(`[surge-openclaw] reaping orphaned OpenClaw group pid=${pid} before start`);
  signalProcessGroup(pid, "SIGTERM");
  const deadline = Date.now() + input.stopGraceMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid) && !(await input.probeHealthz())) {
      await input.forgetChildPid();
      return;
    }
    await input.sleep(ORPHAN_REAP_POLL_MS);
  }
  signalProcessGroup(pid, "SIGKILL");
  await input.sleep(ORPHAN_REAP_POLL_MS);
  if (await input.probeHealthz()) {
    throw new Error(`orphaned OpenClaw group pid=${pid} survived SIGKILL; refusing to start a second gateway`);
  }
  await input.forgetChildPid();
}

// The recorded pid is what lets a restarted supervisor recognize — and reap —
// an OpenClaw its predecessor spawned.
function childPidFile(pidPath: string): {
  recordChildPid: (pid: number | undefined) => Promise<void>;
  forgetChildPid: () => Promise<void>;
  recordedChildPid: () => Promise<number | null>;
} {
  return {
    recordChildPid: async (pid) => {
      if (pid === undefined) return;
      await fs.writeFile(pidPath, `${pid}\n`, { mode: 0o600 });
    },
    forgetChildPid: () => fs.rm(pidPath, { force: true }),
    recordedChildPid: async () => {
      const raw = await fs.readFile(pidPath, "utf8").catch(() => null);
      const pid = raw === null ? Number.NaN : Number.parseInt(raw.trim(), 10);
      return Number.isInteger(pid) && pid > 1 ? pid : null;
    },
  };
}

function supervisorRequestListener(
  handle: (request: SurgeOpenClawProcessSupervisorRequest) => Promise<SurgeOpenClawProcessGateState>,
  log: (message: string) => void,
): http.RequestListener {
  return (req, res) => {
    if (req.method !== "POST" || req.url !== "/") {
      respondJson(res, 404, { error: "not found" });
      return;
    }
    void readJsonBody(req)
      .then(parseRequest)
      .then(handle)
      .then((state) => respondJson(res, 200, state))
      .catch((error) => {
        log(`[surge-openclaw] supervisor request failed: ${errorMessage(error)}`);
        respondJson(res, 409, { error: errorMessage(error) });
      });
  };
}

interface OpenClawChildExit { code: number | null; signal: NodeJS.Signals | null }

async function waitForExit(child: SpawnedOpenClaw): Promise<OpenClawChildExit> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
}

async function waitForExitOrTimeout(
  child: SpawnedOpenClaw,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<OpenClawChildExit | null> {
  return Promise.race([
    waitForExit(child),
    sleep(timeoutMs).then(() => null),
  ]);
}

interface StartPermittedOpenClawChildOptions {
  signal: AbortSignal;
  before: SurgeOpenClawProcessGateState;
  child: { get: () => SpawnedOpenClaw | null; set: (next: SpawnedOpenClaw | null) => void };
  current: () => Promise<SurgeOpenClawProcessGateState>;
  forgetChildPid: () => Promise<void>;
  isStopping: () => boolean;
  log: (message: string) => void;
  onUnexpectedChildExit?: () => void;
  podUid: string;
  prepare: boolean;
  prepareTarget: () => Promise<void>;
  prepareSystemStore?: (assertStopped: () => Promise<void>) => Promise<void>;
  prepareDatabases: () => Promise<void>;
  probeHealthz: () => Promise<boolean>;
  reapOrphanedOpenClaw: () => Promise<void>;
  recordChildPid: (pid: number | undefined) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  spawnOpenClaw: () => SpawnedOpenClaw;
  timeoutMs: number;
  stopChild: () => Promise<void>;
  gate: Pick<ReturnType<typeof createSurgeOpenClawProcessGate>, "markRunning">;
  bootWatcher: OpenClawBootWatcher;
}

async function preparePermittedOpenClawChild(
  opts: StartPermittedOpenClawChildOptions,
): Promise<SurgeOpenClawProcessGateState> {
  opts.signal.throwIfAborted();
  await opts.reapOrphanedOpenClaw();
  opts.signal.throwIfAborted();
  const assertStopped = async () => {
    opts.signal.throwIfAborted();
    const state = await opts.current();
    if (state.podUid !== opts.podUid || state.mode !== "permitted" || state.phase !== "starting" || opts.child.get()) {
      throw new Error("User system-store preparation lost its stopped-writer boundary");
    }
  };
  if (opts.prepareSystemStore) {
    await assertStopped();
    await opts.prepareSystemStore(assertStopped);
    await assertStopped();
  }
  if (opts.prepare || opts.before.role === "target") await opts.prepareTarget();
  opts.signal.throwIfAborted();
  const afterPreparation = await opts.current();
  opts.signal.throwIfAborted();
  if (afterPreparation.mode !== "permitted") {
    throw new Error("surge OpenClaw process was held during target preparation");
  }
  await opts.prepareDatabases();
  opts.signal.throwIfAborted();
  if ((await opts.current()).mode !== "permitted") {
    throw new Error("surge OpenClaw process was held during database preparation");
  }
  opts.signal.throwIfAborted();
  return afterPreparation;
}

async function startPermittedOpenClawChild(
  opts: StartPermittedOpenClawChildOptions,
): Promise<SurgeOpenClawProcessGateState> {
  let retriedPreHealthExit = false;
  for (;;) {
    const afterPreparation = await preparePermittedOpenClawChild(opts);
    opts.signal.throwIfAborted();
    await opts.bootWatcher.beforeStart();
    opts.signal.throwIfAborted();
    const spawnedAt = Date.now();
    const spawned = opts.spawnOpenClaw();
    opts.child.set(spawned);
    opts.log(`[surge-openclaw] OpenClaw spawned pid=${spawned.pid ?? "unknown"}`);
    let healthy = false;
    let exitedBeforeHealth = false;
    let resolveExitCleanup: () => void = () => {};
    const exitCleanup = new Promise<void>((resolve) => { resolveExitCleanup = resolve; });
    spawned.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      opts.log(`[surge-openclaw] OpenClaw exited code=${code ?? "none"} signal=${signal ?? "none"} after ${Date.now() - spawnedAt}ms`);
      if (opts.child.get() !== spawned) return;
      opts.child.set(null);
      void opts.forgetChildPid().then(resolveExitCleanup, resolveExitCleanup);
      if (!opts.isStopping()) {
        if (!healthy && !retriedPreHealthExit) {
          exitedBeforeHealth = true;
          return;
        }
        opts.log("[surge-openclaw] OpenClaw exited outside a supervised stop");
        opts.onUnexpectedChildExit?.();
      }
    });
    spawned.once("error", () => {
      if (opts.child.get() === spawned) opts.child.set(null);
    });
    await opts.recordChildPid(spawned.pid);
    if (opts.child.get() !== spawned) await opts.forgetChildPid();
    try {
      await waitForHealth({
        child: () => opts.child.get() === spawned ? spawned : null,
        probe: opts.probeHealthz,
        sleep: opts.sleep,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
      });
    } catch (error) {
      if (!retriedPreHealthExit && !opts.signal.aborted) {
        opts.log(`[surge-openclaw] OpenClaw did not become healthy; restarting once: ${errorMessage(error)}`);
        await opts.stopChild();
        if (exitedBeforeHealth) await exitCleanup;
        retriedPreHealthExit = true;
        continue;
      }
      throw error;
    }
    if (opts.child.get() !== spawned) {
      if (exitedBeforeHealth && !retriedPreHealthExit && !opts.signal.aborted) {
        await exitCleanup;
        retriedPreHealthExit = true;
        continue;
      }
      throw new Error("OpenClaw exited before becoming healthy");
    }
    opts.log(`[surge-openclaw] OpenClaw healthy after ${Date.now() - spawnedAt}ms`);
    opts.signal.throwIfAborted();
    healthy = true;
    await opts.bootWatcher.healthy();
    opts.signal.throwIfAborted();
    return opts.gate.markRunning({ podUid: opts.podUid, migrationId: afterPreparation.migrationId });
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 16_384) req.destroy(new Error("request too large"));
    });
    req.once("error", reject);
    req.once("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON request"));
      }
    });
  });
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface TargetSupervisorOperationDependencies {
  current: () => Promise<SurgeOpenClawProcessGateState>;
  gate: Pick<ReturnType<typeof createSurgeOpenClawProcessGate>,
    "claimTargetCompletion" | "finalizeTargetCancellation" | "hold" |
    "markHeld" | "reholdTarget" | "reholdReleasedTarget" | "settleTargetCompletion"
  >;
  podUid: string;
  readiness: Pick<ReturnType<typeof createSurgeReadinessGate>, "release" | "hold">;
  stopChild: () => Promise<void>;
}

interface TargetSupervisorOperations {
  claimTargetCompletion: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  finalizeTargetCancellation: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  hold: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  reholdTarget: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  reholdReleasedTarget: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
  releaseTarget: (input: SurgeOpenClawProcessRequest) => Promise<SurgeOpenClawProcessGateState>;
}

function withPodUid(
  input: SurgeOpenClawProcessRequest,
  podUid: string,
): SurgeOpenClawProcessRequest & { podUid: string } {
  return { ...input, podUid };
}

function terminalTargetMatches(
  state: SurgeOpenClawProcessGateState,
  input: SurgeOpenClawProcessRequest,
): boolean {
  const terminal = state.terminalTarget;
  return state.role === "normal" && terminal?.migrationId === input.migrationId &&
    terminal.slug === input.slug && terminal.targetPodUid === input.targetPodUid;
}

function permittedTargetMatches(
  state: SurgeOpenClawProcessGateState,
  input: SurgeOpenClawProcessRequest,
): boolean {
  return state.role === "target" && state.mode === "permitted" &&
    state.migrationId === input.migrationId && state.slug === input.slug &&
    state.targetPodUid === input.targetPodUid;
}

function createTargetSupervisorOperations(
  deps: TargetSupervisorOperationDependencies,
): TargetSupervisorOperations {
  const { current, gate, podUid, readiness, stopChild } = deps;
  const stopAndMarkHeld = async (
    state: SurgeOpenClawProcessGateState,
    input: SurgeOpenClawProcessRequest,
  ): Promise<SurgeOpenClawProcessGateState> => {
    await stopChild();
    if (state.phase === "cancelling") return state;
    return gate.markHeld({ podUid, migrationId: input.migrationId });
  };

  return {
    async hold(input) {
      const state = await gate.hold(withPodUid(input, podUid));
      return stopAndMarkHeld(state, input);
    },
    async reholdTarget(input) {
      const state = await gate.reholdTarget(withPodUid(input, podUid));
      await readiness.hold();
      return stopAndMarkHeld(state, input);
    },
    async reholdReleasedTarget(input) {
      const state = await gate.reholdReleasedTarget(withPodUid(input, podUid));
      await readiness.hold();
      return stopAndMarkHeld(state, input);
    },
    claimTargetCompletion: (input) => gate.claimTargetCompletion(withPodUid(input, podUid)),
    finalizeTargetCancellation: (input) => gate.finalizeTargetCancellation(withPodUid(input, podUid)),
    async releaseTarget(input) {
      const state = await current();
      if (terminalTargetMatches(state, input)) {
        await readiness.release({ targetPodUid: input.targetPodUid });
        return state;
      }
      if (!permittedTargetMatches(state, input)) {
        throw new Error("surge OpenClaw process gate does not permit this target migration");
      }
      await readiness.release({ targetPodUid: input.targetPodUid });
      return gate.settleTargetCompletion(withPodUid(input, podUid));
    },
  };
}

async function defaultPrepareDatabases(opts: StartSurgeOpenClawSupervisorOptions): Promise<void> {
  await assertUserPostgresSelection(process.env);
  const result = prepareOpenClawSqliteJournals({
    stateDir: process.env.OPENCLAW_STATE_DIR || opts.openclawDir,
    configPath: process.env.OPENCLAW_CONFIG_PATH,
  });
  if (result.converted.length) {
    opts.log(`[surge-openclaw] prepared ${result.converted.length} WAL store(s) for 9p storage`);
  }
  await prepareGatewayStateStore({ log: opts.log });
}

function defaultBootWatcher(): OpenClawBootWatcher {
  return { beforeStart: async () => {}, healthy: async () => {} };
}

async function readOwnedSurgeGate(gate: Pick<ReturnType<typeof createSurgeOpenClawProcessGate>, "read">, podUid: string): Promise<SurgeOpenClawProcessGateState> {
  const state = await gate.read();
  if (!state || state.podUid !== podUid) throw new Error("surge OpenClaw process gate disappeared or belongs to another pod");
  return state;
}

function closeSupervisorServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function assertSuccessfulOpenClawExit(exit: OpenClawChildExit | undefined): void {
  if (exit && (exit.code !== 0 || exit.signal !== null)) {
    throw new Error(`OpenClaw shutdown exited with code ${exit.code}, signal ${exit.signal}`);
  }
}

function terminalSupervisorStop(input: {
  shutdown: AbortController; stopChild: (requireSuccess?: boolean) => Promise<void>; settle: () => Promise<void>;
  forgetChildPid: () => Promise<void>; server: http.Server; socketPath: string;
}): () => Promise<void> {
  let stopped: Promise<void> | undefined;
  return () => {
    input.shutdown.abort(new Error("surge OpenClaw supervisor is shutting down"));
    stopped ??= (async () => {
      const errors: unknown[] = [];
      const finish = async (work: () => Promise<void>) => {
        try { await work(); } catch (error) { errors.push(error); }
      };
      await finish(() => input.stopChild(true));
      await finish(input.settle);
      await finish(input.forgetChildPid);
      await finish(() => closeSupervisorServer(input.server));
      await finish(() => fs.rm(input.socketPath, { force: true }));
      if (errors.length) throw new AggregateError(errors, `surge shutdown failed: ${errors.map(errorMessage).join("; ")}`);
    })();
    return stopped;
  };
}

function logBootGateDecision(opts: StartSurgeOpenClawSupervisorOptions, prior: SurgeOpenClawProcessGateState | null, released: boolean, hold: boolean): void {
  opts.log(`[surge-openclaw] boot gate pod=${opts.podUid} prior=${prior ? surgeOpenClawGatePhase(prior) : "none"} readinessReleased=${released} `
    + `prelaunchBoot=${Boolean(opts.prelaunchBoot)} activation=${opts.activationMigrationId ?? "none"} hold=${hold}`);
}

async function initializeBootGate(input: {
  opts: StartSurgeOpenClawSupervisorOptions; gate: ReturnType<typeof createSurgeOpenClawProcessGate>;
  readiness: ReturnType<typeof createSurgeReadinessGate>; readinessReleased: () => Promise<boolean>;
  reapOrphanedOpenClaw: () => Promise<void>;
}): Promise<SurgeOpenClawProcessGateState> {
  const { opts, gate, readiness, readinessReleased, reapOrphanedOpenClaw } = input;
  const prior = await gate.read();
  const matchingActivation = opts.activationMigrationId && prior?.podUid === opts.podUid &&
    ((prior.role === "target" && prior.migrationId === opts.activationMigrationId) ||
     (prior.role === "normal" && prior.terminalTarget?.migrationId === opts.activationMigrationId));
  const holdForPrelaunch = opts.prelaunchBoot || (opts.activationMigrationId && !matchingActivation);
  if (holdForPrelaunch) {
    await readiness.hold();
    await reapOrphanedOpenClaw();
  }
  const released = await readinessReleased();
  logBootGateDecision(opts, prior, released, Boolean(holdForPrelaunch));
  let initial = await gate.ensure({ podUid: opts.podUid, readinessReleased: released });
  if (holdForPrelaunch && !matchingActivation) initial = await gate.holdPrelaunch({ podUid: opts.podUid });
  if (opts.prelaunchBoot) {
    if (!opts.preparePrelaunch) throw new Error("Isolated prelaunch config preparation is unavailable");
    const assertHeld = async () => {
      const state = await readOwnedSurgeGate(gate, opts.podUid);
      if (state.role !== "normal" || state.mode !== "held" || state.phase !== "held") throw new Error("Isolated prelaunch lost its stopped-writer hold");
      await opts.assertPrelaunchAuthority?.();
    };
    await assertHeld();
    await opts.preparePrelaunch(assertHeld);
    await assertHeld();
    initial = await gate.permitNormal({ podUid: opts.podUid });
    await readiness.release({ targetPodUid: opts.podUid });
  }
  return initial;
}

async function migrateHeldUserStores(input: {
  expectedPodUid: string | undefined;
  opts: StartSurgeOpenClawSupervisorOptions;
  current: () => Promise<SurgeOpenClawProcessGateState>;
  hold: () => Promise<SurgeOpenClawProcessGateState>;
  reap: () => Promise<void>;
  hasChild: () => boolean;
  readinessReleased: () => Promise<boolean>;
  signal: AbortSignal;
}): Promise<SurgeOpenClawProcessGateState> {
  const { opts, current } = input;
  if (input.expectedPodUid !== opts.podUid) throw new Error("User store migration addresses another allocation");
  if ((await current()).role !== "normal") throw new Error("User store migration requires a normal allocation without an active handoff");
  if (!await input.readinessReleased()) throw new Error("User store migration requires a previously serving retained source allocation");
  await input.hold();
  await input.reap();
  const assertHeld = async () => {
    input.signal.throwIfAborted();
    const state = await current();
    if (input.hasChild() || state.role !== "normal" || state.mode !== "held" || state.phase !== "held") {
      throw new Error("User store migration lost its stopped-writer hold");
    }
  };
  await assertHeld();
  await (opts.migrateUserStores ?? (async check => {
    await migrateUserStores({ assertHeld: check, log: opts.log, signal: input.signal });
  }))(assertHeld);
  await assertHeld();
  return current();
}

function serializedGateRequests(input: {
  dispatch: (request: SurgeOpenClawProcessSupervisorRequest) => Promise<SurgeOpenClawProcessGateState>;
  runSerial: <T>(work: () => Promise<T>) => Promise<T>;
  cancelInitialStart: () => void;
  log: (message: string) => void;
}): (request: SurgeOpenClawProcessSupervisorRequest) => Promise<SurgeOpenClawProcessGateState> {
  return (request) => {
    if (request.action === "status") return input.dispatch(request);
    return input.runSerial(() => {
      input.cancelInitialStart();
      const owner = "migrationId" in request && request.migrationId ? ` migration=${request.migrationId} slug=${request.slug}` : "";
      input.log(`[surge-openclaw] gate request ${request.action}${owner}`);
      return input.dispatch(request);
    });
  };
}

function createInitialStartRecovery(input: {
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  signal: AbortSignal;
  runSerial: <T>(work: () => Promise<T>) => Promise<T>;
  restart: () => Promise<void>;
}): { cancel: () => void; recover: (firstFailure: unknown) => Promise<void> } {
  let cancelled = false;
  const recover = async (firstFailure: unknown): Promise<void> => {
    let failure = firstFailure;
    for (let attempt = 0; ; attempt += 1) {
      input.log(`[surge-openclaw] initial permitted start failed: ${errorMessage(failure)}`);
      if (cancelled || input.signal.aborted) return;
      const delayMs = Math.min(INITIAL_START_RETRY_MIN_MS * 2 ** attempt, INITIAL_START_RETRY_MAX_MS);
      input.log(`[surge-openclaw] retrying the initial start in ${delayMs}ms`);
      await input.sleep(delayMs);
      try {
        await input.runSerial(async () => { if (!cancelled) await input.restart(); });
        return;
      } catch (error) {
        failure = error;
      }
    }
  };
  return { cancel: () => { cancelled = true; }, recover };
}

export async function startSurgeOpenClawSupervisor(
  opts: StartSurgeOpenClawSupervisorOptions,
): Promise<StartedSurgeOpenClawSupervisor> {
  const gate = createSurgeOpenClawProcessGate(opts.openclawDir, opts.log);
  const readiness = createSurgeReadinessGate(opts.openclawDir, opts.podUid);
  const socketPath = opts.socketPath ?? surgeOpenClawProcessSocketPath(opts.openclawDir);
  const probeHealthz = opts.probeHealthz ?? defaultProbeHealthz;
  const sleep = opts.sleep ?? defaultSleep;
  const spawnOpenClaw = opts.spawnOpenClaw ?? defaultSpawnOpenClaw;
  const timeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const pidPath = path.join(opts.openclawDir, SURGE_OPENCLAW_PID_FILE);
  let child: SpawnedOpenClaw | null = null;
  let stopping = false;
  let starting: Promise<SurgeOpenClawProcessGateState> | null = null;
  let serial = Promise.resolve();
  const shutdown = new AbortController();
  let stoppingChild: Promise<OpenClawChildExit | undefined> | null = null;

  const { recordChildPid, forgetChildPid, recordedChildPid } = childPidFile(pidPath);

  const reapOrphanedOpenClaw = (): Promise<void> => reapOrphanedOpenClawGroup({
    probeHealthz,
    sleep,
    recordedChildPid,
    forgetChildPid,
    stopGraceMs,
    log: opts.log,
  });

  const runSerial = <T>(work: () => Promise<T>): Promise<T> => {
    const admitted = () => { shutdown.signal.throwIfAborted();return work(); };
    const result = serial.then(admitted, admitted);
    serial = result.then(() => undefined, () => undefined);
    return result;
  };

  const current = () => readOwnedSurgeGate(gate, opts.podUid);

  const stopActiveChild = async (): Promise<OpenClawChildExit | undefined> => {
    const active = child;
    if (!active) return;
    stopping = true;
    const stopRequestedAt = Date.now();
    try {
      active.kill("SIGTERM");
      let exit = await waitForExitOrTimeout(active, stopGraceMs, sleep);
      if (!exit) {
        opts.log(`[surge-openclaw] OpenClaw ignored SIGTERM for ${stopGraceMs}ms; killing its process group`);
        if (active.pid === undefined || !signalProcessGroup(active.pid, "SIGKILL")) active.kill("SIGKILL");
        exit = await waitForExit(active);
      }
      if (child === active) child = null;
      await forgetChildPid();
      opts.log(`[surge-openclaw] OpenClaw stopped in ${Date.now() - stopRequestedAt}ms`);
      return exit;
    } finally {
      stopping = false;
    }
  };
  const stopChild = async (requireSuccess: boolean = false): Promise<void> => {
    stoppingChild ??= stopActiveChild().finally(() => { stoppingChild = null; });
    const exit = await stoppingChild;
    if (requireSuccess) assertSuccessfulOpenClawExit(exit);
  };

  const startChild = async (prepare: boolean = false): Promise<SurgeOpenClawProcessGateState> => {
    shutdown.signal.throwIfAborted();
    if (starting) return starting;
    const work = (async () => {
      const before = await current();
      shutdown.signal.throwIfAborted();
      if (before.mode !== "permitted") {
        throw new Error("surge OpenClaw process is held");
      }
      if (child) return before;
      await assertUserStoreMigrationComplete(opts.openclawDir);
      await gate.markStarting({ podUid: opts.podUid, migrationId: before.migrationId });
      return startPermittedOpenClawChild({
        signal: shutdown.signal,
        before,
        child: {
          get: () => child,
          set: (next) => { child = next; },
        },
        current,
        forgetChildPid,
        isStopping: () => stopping || shutdown.signal.aborted,
        log: opts.log,
        onUnexpectedChildExit: opts.onUnexpectedChildExit,
        podUid: opts.podUid,
        prepare,
        prepareTarget: opts.prepareTarget ?? prepareConfiguredIsolatedTarget,
        prepareSystemStore: opts.prepareSystemStore,
        prepareDatabases: opts.prepareDatabases ?? (() => defaultPrepareDatabases(opts)),
        probeHealthz,
        reapOrphanedOpenClaw,
        recordChildPid,
        sleep,
        spawnOpenClaw,
        timeoutMs,
        stopChild,
        gate,
        bootWatcher: opts.bootWatcher ?? defaultBootWatcher(),
      });
    })();
    starting = work;
    try {
      return await work;
    } catch (error) {
      try {
        await stopChild();
        const state = await current();
        if (state.mode === "permitted") {
          await gate.markHeld({ podUid: opts.podUid, migrationId: state.migrationId });
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "OpenClaw start failed and process hold cleanup failed",
        );
      }
      throw error;
    } finally {
      starting = null;
    }
  };

  const targetOperations = createTargetSupervisorOperations({
    current,
    gate,
    podUid: opts.podUid,
    readiness,
    stopChild,
  });

  const permit = async (input: SurgeOpenClawProcessRequest): Promise<SurgeOpenClawProcessGateState> => {
    await gate.permitTarget({ ...input, podUid: opts.podUid });
    return startChild();
  };

  const hydrate = async (input: SurgeOpenClawProcessRequest): Promise<SurgeOpenClawProcessGateState> =>
    gate.hydrateTarget({ ...input, podUid: opts.podUid });

  const permitNormal = async (): Promise<SurgeOpenClawProcessGateState> => {
    await gate.permitNormal({ podUid: opts.podUid });
    return startChild(true);
  };

  const holdNormal = async (): Promise<SurgeOpenClawProcessGateState> => {
    await gate.holdNormal({ podUid: opts.podUid });
    await stopChild();
    return gate.markHeld({ podUid: opts.podUid });
  };

  const resume = async (input: SurgeOpenClawProcessRequest): Promise<SurgeOpenClawProcessGateState> => {
    await gate.resumeSource({ ...input, podUid: opts.podUid });
    await startChild();
    return gate.settle({ podUid: opts.podUid });
  };

  const unreserve = (input: SurgeOpenClawProcessRequest): Promise<SurgeOpenClawProcessGateState> =>
    gate.unreserveTarget({ ...input, podUid: opts.podUid });

  const settle = (): Promise<SurgeOpenClawProcessGateState> =>
    gate.settle({ podUid: opts.podUid });

  const readinessReleased = opts.readinessReleased ?? (() => readiness.released());
  const initial = await initializeBootGate({ opts, gate, readiness, readinessReleased, reapOrphanedOpenClaw });

  await fs.mkdir(opts.openclawDir, { recursive: true });
  await fs.rm(socketPath, { force: true });
  const createServer = opts.createServer ?? http.createServer;
  const dispatch = (
    request: SurgeOpenClawProcessSupervisorRequest,
  ): Promise<SurgeOpenClawProcessGateState> => {
    if (request.action === "status") return current();
    if (request.action === "hold-normal") return holdNormal();
    if (request.action === "migrate-builder-stores") return migrateHeldUserStores({
      expectedPodUid: request.expectedPodUid, opts, current, hold: holdNormal, reap: reapOrphanedOpenClaw,
      hasChild: () => child !== null, readinessReleased, signal: shutdown.signal,
    });
    if (request.action === "permit-normal") return permitNormal();
    if (request.action === "settle") return settle();
    const input = requestIdentity(request);
    if (request.action === "hold") return targetOperations.hold(input);
    if (request.action === "rehold") return targetOperations.reholdTarget(input);
    if (request.action === "rehold-released-target") return targetOperations.reholdReleasedTarget(input);
    if (request.action === "claim") return targetOperations.claimTargetCompletion(input);
    if (request.action === "finalize-cancellation") return targetOperations.finalizeTargetCancellation(input);
    if (request.action === "release-target") return targetOperations.releaseTarget(input);
    if (request.action === "hydrate") return hydrate(input);
    if (request.action === "permit") return permit(input);
    if (request.action === "unreserve") return unreserve(input);
    return resume(input);
  };
  // A gate read must never queue behind a start or stop; the readiness probe
  // calls it while a permit holds the lane.
  const initialStart = createInitialStartRecovery({ log: opts.log, sleep, signal: shutdown.signal, runSerial,
    restart: async () => { await gate.permitNormal({ podUid: opts.podUid }); await startChild(); } });
  const server = createServer(supervisorRequestListener(serializedGateRequests({ dispatch, runSerial, cancelInitialStart: initialStart.cancel, log: opts.log }), opts.log));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  await fs.chmod(socketPath, 0o600);

  if (initial.mode === "permitted") {
    void runSerial(startChild).catch(initialStart.recover);
  }

  return {
    socketPath,
    state: current,
    stop: terminalSupervisorStop({ shutdown, stopChild, settle: () => serial, forgetChildPid, server, socketPath }),
  };
}

export function createSurgeOpenClawBootWatcher(input: {
  client: Pick<FleetBrokerClient, "claimOpenClawBoot" | "completeOpenClawBoot" | "completeOpenClawDoctor">;
  openclawDir: string;
  releaseKey: string;
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  installedOpenClawBuild?: () => Promise<string>;
}): OpenClawBootWatcher {
  const env = input.env ?? process.env;
  return createOpenClawBootWatcher({ ...input, inspectUserStores: isIsolatedGatewayClassValue(env.GATEWAY_CLASS)
    ? () => inspectConfiguredUserAgentStores({ stateDir: input.openclawDir,
      configPath: env.OPENCLAW_CONFIG_PATH || path.join(input.openclawDir, "openclaw.json") })
    : undefined,
  openclaw: input.installedOpenClawBuild
    ? { binary: OPENCLAW_BINARY, installedBuild: input.installedOpenClawBuild }
    : undefined });
}

export interface UserBootMode {
  prelaunchBoot: boolean;
  activationMigrationId?: string;
  userAuthorityKey?: string;
}

function isolatedRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.GATEWAY_RUNTIME_KIND === "gce-vm" ||
    (isIsolatedGatewayClassValue(env.GATEWAY_CLASS) && env.GATEWAY_RUNTIME_KIND === "cluster");
}

export async function userBootMode(input: {
  env: NodeJS.ProcessEnv;
  readIdentity: () => Promise<UserIdentity>;
}): Promise<UserBootMode> {
  if (!isolatedRuntime(input.env)) return { prelaunchBoot: false };
  const identity = await input.readIdentity();
  if (identity.state !== "claimed" || !identity.bootMode) throw new Error("Native user boot mode is unavailable");
  return {
    prelaunchBoot: identity.bootMode === "prelaunch",
    ...(identity.activationMigrationId ? { activationMigrationId: identity.activationMigrationId } : {}),
    userAuthorityKey: JSON.stringify([identity.gatewayId, identity.ownerUid, identity.builderSlug, identity.leaseId, identity.generation]),
  };
}

async function main(): Promise<void> {
  const podUid = process.env.POD_UID?.trim();
  if (!podUid) throw new Error("POD_UID is required for the surge OpenClaw supervisor");
  const gatewayId = process.env.GATEWAY_ID?.trim();
  if (!gatewayId) throw new Error("GATEWAY_ID is required for the surge OpenClaw supervisor");
  const revisionId = process.env.GATEWAY_REVISION_ID?.trim() || gatewayId;
  const releaseKey = process.env.GATEWAY_IMAGE_TAG?.trim() || process.env.BUILD_SHA?.trim();
  if (!releaseKey) {
    throw new Error("GATEWAY_IMAGE_TAG or BUILD_SHA is required for the surge OpenClaw supervisor");
  }
  const openclawDir = process.env.OPENCLAW_DIR?.trim() || "/home/node/.openclaw";
  const log = runtimeLogger.info;
  const bootWatcher = createSurgeOpenClawBootWatcher({
    openclawDir,
    client: createFleetBrokerClient(gatewayId, revisionId),
    releaseKey,
    log,
    installedOpenClawBuild: () => readInstalledOpenClawBuild(OPENCLAW_BINARY),
  });
  const readBootMode = () => userBootMode({
    env: process.env,
    readIdentity: () => createFleetBrokerClient(gatewayId, revisionId).builderIdentity({ nativeBoot: true }),
  });
  const boot = await readBootMode();
  await recoverIsolatedPodGatewayLocks({
    env: { ...process.env, OPENCLAW_STATE_DIR: openclawDir, OPENCLAW_CONFIG_PATH: systemConfigPath(openclawDir) },
    hostname: os.hostname(),
    pidNamespace: await currentGatewayContainerPidNamespace(),
    run: runOpenClaw,
    log,
  });
  const supervisor = await startSurgeOpenClawSupervisor({
    openclawDir,
    podUid,
    log,
    bootWatcher,
    ...boot,
    prepareSystemStore: (assertStopped) => prepareUserSystemStore({ root: openclawDir, assertCurrent: assertStopped, log,
      readAuthority: async () => (await readBootMode()).userAuthorityKey }),
    assertPrelaunchAuthority: async () => {
      const current = await readBootMode();
      if (!current.prelaunchBoot || !boot.userAuthorityKey || current.userAuthorityKey !== boot.userAuthorityKey) throw new Error("Isolated prelaunch authority changed");
    },
    preparePrelaunch: async (assertHeld) => {
      await prepareUserSystemStore({ root: openclawDir, assertCurrent: assertHeld, log });
      const slug = userClaimSlug();
      if (!slug) throw new Error("Isolated prelaunch requires its owner slug");
      await prepareIsolatedPrelaunchConfig(openclawDir, slug);
    },
    onUnexpectedChildExit: () => {
      runtimeLogger.error("[surge-openclaw] exiting so the runner restarts the supervisor and OpenClaw");
      process.exit(1);
    },
  });
  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopPromise ??= supervisor.stop().then(
      () => process.exit(0),
      (error) => {
        runtimeLogger.error(`[surge-openclaw] supervisor stop failed: ${errorMessage(error)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    runtimeLogger.error(`[surge-openclaw] supervisor fatal: ${errorMessage(error)}`);
    process.exit(1);
  });
}
