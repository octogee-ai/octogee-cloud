import * as fs from "node:fs";
import * as path from "node:path";

import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import type { SchedulerMigrationResult } from "@octogee/shared/types/fleet-controller";
import {
  MIGRATION_QUIESCE_GRACE_MS,
  MIGRATION_QUIESCE_STOP_RECHECK_MS,
} from "@octogee/shared/types/workspace-migration";
import { schedulerHandoffAgentIds } from "./agent-roster-deletion.js";
import {
  type AgentSessionEntry,
  userDefaultAgentId,
  readAgentSessions,
  readAgentSessionsAtPath,
  resolveOpenClawStateDir,
} from "./fleet-http-migration.js";
import type { GatewayRpcClient, GatewaySessionSummary } from "./gateway-rpc.js";

export interface UserSessionStore {
  agentId: string;
  path: string;
}

export function sessionStoreForPath(storePath: string): UserSessionStore {
  const segments = storePath.split(path.sep);
  const agentId = segments[segments.lastIndexOf("agents") + 1];
  if (segments.lastIndexOf("agents") < 0 || !agentId) {
    throw new Error(`session store path names no agent: ${storePath}`);
  }
  return { agentId, path: storePath };
}

export interface BoundedQuiesceOptions {
  rpc: Pick<GatewayRpcClient, "configGet" | "schedulerMigration" | "sessionsAbort" | "sessionsList">;
  slug: string;
  agentIds: readonly string[];
  stores: readonly UserSessionStore[];
  schedulerMigrationId?: string;
  retainNonportable?: boolean;
  graceMs?: number;
  maxWaitMs?: number;
  recheckMs?: number;
  abortAfterGrace?: boolean;
  readSessions?: (path: string) => Promise<AgentSessionEntry[]>;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface BoundedQuiesceResult {
  drained: boolean;
  runningCount: number;
  abortedSessions: number;
}

interface RunningSession {
  agentId: string;
  key: string;
  hasActiveRun?: boolean;
  updatedAt?: number;
}

const POLL_MS = 1_000;

function applyNativeSession(running: Map<string, RunningSession>, agentId: string, session: GatewaySessionSummary): void {
  const identity = `${agentId}:${session.key}`;
  if (session.hasActiveRun === false) {
    if (running.has(identity)) running.set(identity, { agentId, key: session.key, hasActiveRun: false });
  } else if (session.hasActiveRun === true || session.status === "running" || session.status === "queued" || running.has(identity)) {
    running.set(identity, { agentId, key: session.key, hasActiveRun: session.hasActiveRun, updatedAt: session.updatedAt });
  }
}

async function listAgentActivity(opts: BoundedQuiesceOptions, agentId: string): Promise<GatewaySessionSummary[]> {
  const sessions: GatewaySessionSummary[] = [];
  let offset = 0;
  while (true) {
    const page = await opts.rpc.sessionsList({ agentId, includeGlobal: true, includeUnknown: true, archived: "all", offset });
    for (const session of page.sessions) {
      if (session.agentId && session.agentId !== agentId) throw new Error(`unexpected session owner ${session.agentId} in ${agentId} inventory`);
      sessions.push(session);
    }
    if (page.hasMore !== true) return sessions;
    if (!Number.isSafeInteger(page.nextOffset) || (page.nextOffset as number) <= offset) throw new Error(`invalid sessions.list pagination for ${agentId}`);
    offset = page.nextOffset as number;
  }
}

async function listRunningSessions(
  opts: BoundedQuiesceOptions,
  agentIds: readonly string[],
  readSessions: (path: string) => Promise<AgentSessionEntry[]>,
): Promise<{ running: RunningSession[]; lastActivityAt: number | null }> {
  const running = new Map<string, RunningSession>();
  let lastActivityAt: number | null = null;
  for (const store of opts.stores) {
    for (const session of await readSessions(store.path)) {
      if (session.status !== "running") continue;
      if (typeof session.key !== "string" || session.key.length === 0) throw new Error(`running session in ${store.path} has no session key to abort`);
      running.set(`${store.agentId}:${session.key}`, { agentId: store.agentId, key: session.key });
    }
  }
  const inventories = await Promise.all(agentIds.map(async (agentId) => ({ agentId, sessions: await listAgentActivity(opts, agentId) })));
  for (const { agentId, sessions } of inventories) {
    for (const session of sessions) {
      if (typeof session.lastActivityAt === "number" && Number.isFinite(session.lastActivityAt)) {
        lastActivityAt = Math.max(lastActivityAt ?? session.lastActivityAt, session.lastActivityAt);
      }
      applyNativeSession(running, agentId, session);
    }
  }
  return { running: [...running.values()], lastActivityAt };
}

async function holdScheduler(
  opts: BoundedQuiesceOptions,
  agentIds: readonly string[],
): Promise<SchedulerMigrationResult | null> {
  if (!opts.schedulerMigrationId) return null;
  return opts.rpc.schedulerMigration({
    operationId: opts.schedulerMigrationId,
    phase: "hold",
    agentIds: [...agentIds],
    ...(opts.retainNonportable ? { retainNonportable: true } : {}),
  });
}

async function scheduledAgentIds(opts: BoundedQuiesceOptions): Promise<string[]> {
  if (!opts.schedulerMigrationId) return [...opts.agentIds];
  const { config } = await opts.rpc.configGet();
  const agentIds = schedulerHandoffAgentIds(config, opts.slug, opts.agentIds, opts.retainNonportable === true);
  if (agentIds.length === 0) throw new Error(`Cannot hold scheduler for ${opts.slug}: no user agents`);
  return agentIds;
}

interface DrainWindow {
  idleDeadline: number;
  sawWork: boolean;
  previouslyBusy: boolean;
  observed: Map<string, number>;
}

function observeSessionProgress(observed: Map<string, number>, running: readonly RunningSession[]): boolean {
  let progress = false;
  for (const session of running) {
    if (typeof session.updatedAt !== "number" || !Number.isFinite(session.updatedAt)) continue;
    const identity = `${session.agentId}:${session.key}`;
    const previous = observed.get(identity);
    if (previous !== undefined && session.updatedAt > previous) progress = true;
    observed.set(identity, Math.max(previous ?? session.updatedAt, session.updatedAt));
  }
  return progress;
}

function observeDrainActivity(state: DrainWindow, activity: {
  busy: boolean; active: boolean; progress: boolean; lastActivityAt: number | null;
}, at: number, graceMs: number): void {
  const { busy, active, progress, lastActivityAt } = activity;
  if (lastActivityAt !== null && lastActivityAt + graceMs > at) {
    const completedDeadline = Math.min(at, lastActivityAt) + graceMs;
    state.idleDeadline = state.sawWork ? Math.max(state.idleDeadline, completedDeadline) : completedDeadline;
    state.sawWork = true;
  }
  if ((!busy && state.previouslyBusy) || active || progress) state.idleDeadline = at + graceMs;
  state.sawWork ||= busy;
  state.previouslyBusy = busy;
}

function logDrainWaiting(opts: BoundedQuiesceOptions, phase: string, status: {
  running: RunningSession[]; active: boolean; progress: boolean; schedulerDrained: boolean;
}): void {
  opts.log?.(
    `[quiesce:${opts.slug}] ${phase}: ${status.running.length} running session(s)` +
    `${status.active ? ", native runtime still active" : ""}` +
    `${status.running.some((session) => session.hasActiveRun === false) ? ", native runtime idle but durable session still running" : ""}` +
    `${status.progress ? ", progress renewed grace" : ""}` +
    `${status.schedulerDrained ? "" : ", scheduler still draining"}; waiting`,
  );
}

function quiesceClock(opts: Pick<UserSessionQuiesceOptions, "now" | "wait">) {
  return {
    now: opts.now ?? Date.now,
    wait: opts.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))),
  };
}

async function settleWithin(
  opts: BoundedQuiesceOptions,
  agentIds: readonly string[],
  deadline: number,
  phase: "grace" | "recheck",
): Promise<{ settled: boolean; running: RunningSession[]; active: boolean }> {
  const { now, wait } = quiesceClock(opts);
  const readSessions = opts.readSessions ?? readAgentSessionsAtPath;
  const graceMs = opts.graceMs ?? MIGRATION_QUIESCE_GRACE_MS;
  const window: DrainWindow = { idleDeadline: now() + graceMs, sawWork: false, previouslyBusy: false, observed: new Map() };
  while (true) {
    const held = await holdScheduler(opts, agentIds);
    const { running, lastActivityAt } = await listRunningSessions(opts, agentIds, readSessions);
    const schedulerDrained = held === null || held.drained;
    const busy = !schedulerDrained || running.length > 0;
    const active = running.some((session) => session.hasActiveRun === true);
    const progress = observeSessionProgress(window.observed, running);
    const at = now();
    if (phase === "grace") observeDrainActivity(window, { busy, active, progress, lastActivityAt }, at, graceMs);
    if (!busy && (phase === "recheck" || !window.sawWork || at >= window.idleDeadline)) return { settled: true, running, active: false };
    logDrainWaiting(opts, phase, { running, active, progress, schedulerDrained });
    const remainingMs = (phase === "grace" ? Math.min(window.idleDeadline, deadline) : deadline) - at;
    if (remainingMs <= 0) {
      opts.log?.(`[quiesce:${opts.slug}] deferring: ${active ? "live work exceeded this drain request budget" : "no new progress within the idle grace"}`);
      return { settled: false, running, active };
    }
    await wait(Math.min(POLL_MS, remainingMs));
  }
}

async function abortSessions(
  opts: BoundedQuiesceOptions,
  running: readonly RunningSession[],
): Promise<number> {
  let aborted = 0;
  for (const session of running) {
    const result = await opts.rpc.sessionsAbort({ key: session.key, agentId: session.agentId, clearQueued: true });
    const run = result.abortedRunId ? ` run=${result.abortedRunId}` : "";
    opts.log?.(`[quiesce:${opts.slug}] aborted ${session.agentId} ${session.key}: ${result.status}${run}`);
    if (result.status === "aborted") aborted += 1;
  }
  return aborted;
}

export interface UserSessionQuiesceOptions {
  timeoutMs: number;
  log?: (message: string) => void;
  stateDir?: string;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}

function userAgentIds(stateDir: string, slug: string): string[] {
  const agentIds = new Set([userDefaultAgentId(slug)]);
  const agentsDir = path.join(stateDir, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && agentIdBelongsToSlug(entry.name, slug)) agentIds.add(entry.name);
    }
  }
  return [...agentIds].sort();
}

export async function quiesceUserSessions(
  slug: string,
  opts: UserSessionQuiesceOptions,
): Promise<{ drained: boolean; runningCount: number }> {
  const stateDir = opts.stateDir ?? resolveOpenClawStateDir();
  const { now, wait } = quiesceClock(opts);
  const deadline = now() + opts.timeoutMs;
  let runningCount = 0;
  do {
    runningCount = 0;
    for (const agentId of userAgentIds(stateDir, slug)) {
      const sessions = await readAgentSessions(stateDir, agentId);
      runningCount += sessions.filter((session) => session.status === "running").length;
    }
    if (runningCount === 0) return { drained: true, runningCount: 0 };
    opts.log?.(`[quiesce:${slug}] ${runningCount} running session(s); waiting`);
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await wait(Math.min(POLL_MS, remainingMs));
  } while (now() < deadline);
  return { drained: false, runningCount };
}

export async function quiesceUserSessionsBounded(
  opts: BoundedQuiesceOptions,
): Promise<BoundedQuiesceResult> {
  const now = opts.now ?? Date.now;
  const agentIds = await scheduledAgentIds(opts);
  const grace = await settleWithin(opts, agentIds, now() + (opts.maxWaitMs ?? 30_000), "grace");
  if (grace.settled) return { drained: true, runningCount: 0, abortedSessions: 0 };
  if (opts.abortAfterGrace !== true || grace.active) {
    return { drained: false, runningCount: grace.running.length, abortedSessions: 0 };
  }
  const abortedSessions = await abortSessions(opts, grace.running);
  const recheck = await settleWithin(
    opts,
    agentIds,
    now() + (opts.recheckMs ?? MIGRATION_QUIESCE_STOP_RECHECK_MS),
    "recheck",
  );
  return { drained: recheck.settled, runningCount: recheck.running.length, abortedSessions };
}
