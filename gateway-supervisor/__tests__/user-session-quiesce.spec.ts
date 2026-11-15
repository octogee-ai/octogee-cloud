import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  quiesceUserSessions,
  quiesceUserSessionsBounded,
  sessionStoreForPath,
  type BoundedQuiesceOptions,
} from "../lib/user-session-quiesce.js";

const tempDirs: string[] = [];

function writeSessions(stateDir: string, agentId: string, sessions: Array<[key: string, status: string]>): string {
  const agentDir = path.join(stateDir, "agents", agentId, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const storePath = path.join(agentDir, "openclaw-agent.sqlite");
  const db = new DatabaseSync(storePath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS session_nodes (session_key TEXT, current_session_id TEXT, status TEXT)");
    db.exec("DELETE FROM session_nodes");
    for (const [index, [key, status]] of sessions.entries()) {
      db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run(key, String(index), status);
    }
  } finally {
    db.close();
  }
  return storePath;
}

function mkStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-session-quiesce-"));
  tempDirs.push(stateDir);
  return stateDir;
}

function clockedRpc() {
  return {
    configGet: vi.fn(async () => ({ config: { agents: { entries: { "octogee-alice-coach": {} } } } })),
    schedulerMigration: vi.fn(async (request: { operationId: string; phase: string; agentIds?: string[] }) => ({
      operationId: request.operationId, phase: request.phase, agentIds: request.agentIds ?? [], drained: true,
    })),
    sessionsList: vi.fn(async (_request: { agentId: string }): Promise<{ sessions: Array<{ key: string; hasActiveRun?: boolean; status?: string; updatedAt?: number; lastActivityAt?: number }> }> => ({ sessions: [] })),
    sessionsAbort: vi.fn(async () => ({ ok: true as const, abortedRunId: "run-1", status: "aborted" as const })),
  };
}

function harness(stateDir: string, overrides: Partial<BoundedQuiesceOptions> = {}) {
  let now = 0;
  const waits: number[] = [];
  const rpc = clockedRpc();
  const opts: BoundedQuiesceOptions = {
    rpc: rpc as unknown as BoundedQuiesceOptions["rpc"],
    slug: "alice",
    agentIds: ["octogee-alice-coach"],
    stores: [sessionStoreForPath(path.join(stateDir, "agents", "octogee-alice-coach", "sessions", "sessions.json"))],
    now: () => now,
    wait: async (delayMs) => {
      waits.push(delayMs);
      now += delayMs;
    },
    log: vi.fn(),
    ...overrides,
  };
  return { rpc, opts, waits, clock: () => now };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("quiesceUserSessions (pre-stop drain)", () => {
  it("counts agent and project-agent runs owned by only the requested user", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "running"]]);
    writeSessions(stateDir, "octogee-alice-proj-launch-coach", [["agent:octogee-alice-proj-launch-coach:main", "running"]]);
    writeSessions(stateDir, "octogee-bob-coach", [["agent:octogee-bob-coach:main", "running"]]);

    await expect(quiesceUserSessions("alice", { stateDir, timeoutMs: 0 }))
      .resolves.toEqual({ drained: false, runningCount: 2 });
  });

  it("returns drained as soon as the user's writers settle", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "running"]]);
    let now = 0;

    await expect(quiesceUserSessions("alice", {
      stateDir,
      timeoutMs: 5_000,
      now: () => now,
      wait: async (delayMs) => {
        now += delayMs;
        writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "done"]]);
      },
    })).resolves.toEqual({ drained: true, runningCount: 0 });
    expect(now).toBe(1_000);
  });

  it("rejects an unreadable session store instead of reporting a drained user", async () => {
    const stateDir = mkStateDir();
    const storePath = writeSessions(stateDir, "octogee-alice-coach", []);
    fs.writeFileSync(storePath, "broken");
    await expect(quiesceUserSessions("alice", { stateDir, timeoutMs: 0 })).rejects.toThrow();
  });
});

describe("sessionStoreForPath", () => {
  it("names the agent that owns a session store from its path", () => {
    expect(sessionStoreForPath(path.join("/state", "agents", "octogee-alice-proj-app-coach", "sessions", "sessions.json")))
      .toEqual({ agentId: "octogee-alice-proj-app-coach", path: path.join("/state", "agents", "octogee-alice-proj-app-coach", "sessions", "sessions.json") });
    expect(() => sessionStoreForPath("/state/sessions.json")).toThrow(/names no agent/u);
  });
});

describe("quiesceUserSessionsBounded", () => {
  it("retains the completed-turn grace across separate bounded drain attempts", async () => {
    const h = harness(mkStateDir(), { graceMs: 20_000, maxWaitMs: 2_000 });
    h.rpc.sessionsList.mockResolvedValue({ sessions: [{ key: "agent:octogee-alice-coach:main", hasActiveRun: true }] });
    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toMatchObject({ drained: false });
    h.rpc.sessionsList.mockResolvedValue({ sessions: [{ key: "agent:octogee-alice-coach:main", hasActiveRun: false, lastActivityAt: h.clock() - 1_000 }] });
    h.opts.maxWaitMs = 30_000;
    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toMatchObject({ drained: true });
    expect(h.clock()).toBe(21_000);
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
  });

  it("keeps a live agent turn past the original grace deadline until it settles", async () => {
    const h = harness(mkStateDir(), { graceMs: 2_000, maxWaitMs: 10_000 });
    h.rpc.sessionsList.mockImplementation(async () => ({ sessions: h.clock() < 5_000
      ? [{ key: "agent:octogee-alice-coach:main", hasActiveRun: true, updatedAt: h.clock() }]
      : [] }));
    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toEqual({ drained: true, runningCount: 0, abortedSessions: 0 });
    expect(h.clock()).toBe(7_000);
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
  });

  it("defers when the request budget expires during live work instead of aborting", async () => {
    const h = harness(mkStateDir(), { graceMs: 2_000, maxWaitMs: 4_000, abortAfterGrace: true });
    h.rpc.sessionsList.mockResolvedValue({ sessions: [{ key: "agent:octogee-alice-coach:main", hasActiveRun: true }] });
    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toEqual({ drained: false, runningCount: 1, abortedSessions: 0 });
    expect(h.clock()).toBe(4_000);
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
  });

  it("resets the idle grace on session progress without treating an unchanged running flag as progress", async () => {
    const h = harness(mkStateDir(), { graceMs: 2_000, maxWaitMs: 10_000 });
    h.rpc.sessionsList.mockImplementation(async () => ({ sessions: [{
      key: "agent:octogee-alice-coach:main", status: "running", updatedAt: Math.min(h.clock(), 3_000),
    }] }));
    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toEqual({ drained: false, runningCount: 1, abortedSessions: 0 });
    expect(h.clock()).toBe(5_000);
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
  });

  it("defers before cutover while an idle native turn still has durable running state", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "running"]]);
    const h = harness(stateDir);
    h.rpc.sessionsList.mockResolvedValue({ sessions: [{ key: "agent:octogee-alice-coach:main", hasActiveRun: false }] });
    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toEqual({ drained: false, runningCount: 1, abortedSessions: 0 });
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
    expect(h.opts.log).toHaveBeenCalledWith(expect.stringContaining("native runtime idle but durable session still running"));
  });

  it("waits for project and queued turns returned by the native runtime", async () => {
    const h = harness(mkStateDir(), { graceMs: 2_000, maxWaitMs: 3_000, agentIds: ["octogee-alice-coach", "octogee-alice-proj-app-coach"] });
    h.rpc.sessionsList.mockImplementation(async ({ agentId }) => ({ sessions: agentId.includes("proj")
      ? [{ key: "agent:octogee-alice-proj-app-coach:main", hasActiveRun: true, status: "queued" }]
      : [] }));
    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toMatchObject({ drained: false, runningCount: 1, abortedSessions: 0 });
    expect(h.rpc.sessionsList).toHaveBeenCalledWith({ agentId: "octogee-alice-proj-app-coach", includeGlobal: true, includeUnknown: true, archived: "all", offset: 0 });
  });

  it("checks every native page before declaring the user idle", async () => {
    const h = harness(mkStateDir(), { maxWaitMs: 0 });
    h.rpc.sessionsList.mockImplementation(async (request) => (request as { offset?: number }).offset === 100
      ? { sessions: [{ key: "agent:octogee-alice-coach:older", hasActiveRun: true }], hasMore: false }
      : { sessions: [], hasMore: true, nextOffset: 100 });
    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toMatchObject({ drained: false, runningCount: 1 });
    expect(h.rpc.sessionsList).toHaveBeenCalledWith(expect.objectContaining({ agentId: "octogee-alice-coach", offset: 100 }));
  });

  it("fails closed when a native inventory page belongs to a different user agent", async () => {
    const h = harness(mkStateDir());
    h.rpc.sessionsList.mockResolvedValue({ sessions: [{ key: "global", agentId: "octogee-bob-coach", hasActiveRun: true }] } as never);
    await expect(quiesceUserSessionsBounded(h.opts)).rejects.toThrow("unexpected session owner octogee-bob-coach");
  });

  it("returns drained immediately, without a grace wait, when nothing is running", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "done"]]);
    const h = harness(stateDir, { schedulerMigrationId: "handoff-1" });

    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toEqual({ drained: true, runningCount: 0, abortedSessions: 0 });
    expect(h.waits).toEqual([]);
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
    expect(h.rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "handoff-1", phase: "hold", agentIds: ["octogee-alice-coach"] });
  });

  it("holds the scheduler in partial mode when the caller keeps host-bound jobs dormant on this gateway", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "done"]]);
    const h = harness(stateDir, { schedulerMigrationId: "handoff-1", retainNonportable: true });

    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toMatchObject({ drained: true });
    expect(h.rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "handoff-1", phase: "hold", agentIds: ["octogee-alice-coach"], retainNonportable: true });
  });

  it("lets a running turn settle inside the grace window and never aborts it", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "running"]]);
    const h = harness(stateDir, {
      graceMs: 20_000,
      readSessions: async () => [{ key: "agent:octogee-alice-coach:main", status: h.clock() === 0 ? "running" : "done" }],
    });

    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toEqual({ drained: true, runningCount: 0, abortedSessions: 0 });
    expect(h.clock()).toBe(21_000);
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
  });

  it("aborts every still-running session of the user's agents through sessions.abort once the grace elapses", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [
      ["agent:octogee-alice-coach:main", "running"],
      ["agent:octogee-alice-coach:mattermost:channel", "done"],
    ]);
    const projectStore = writeSessions(stateDir, "octogee-alice-proj-app-coach", [["agent:octogee-alice-proj-app-coach:cron", "running"]]);
    const h = harness(stateDir, { graceMs: 2_000, recheckMs: 10_000, abortAfterGrace: true });
    h.opts.stores = [...h.opts.stores, sessionStoreForPath(projectStore)];
    h.rpc.sessionsAbort.mockImplementation(async () => {
      writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "killed"]]);
      writeSessions(stateDir, "octogee-alice-proj-app-coach", [["agent:octogee-alice-proj-app-coach:cron", "killed"]]);
      return { ok: true as const, abortedRunId: "run-1", status: "aborted" as const };
    });

    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toEqual({ drained: true, runningCount: 0, abortedSessions: 2 });
    expect(h.rpc.sessionsAbort.mock.calls.map(([request]) => request)).toEqual([
      { key: "agent:octogee-alice-coach:main", agentId: "octogee-alice-coach", clearQueued: true },
      { key: "agent:octogee-alice-proj-app-coach:cron", agentId: "octogee-alice-proj-app-coach", clearQueued: true },
    ]);
    expect(h.clock()).toBe(2_000);
  });

  it("is bounded by grace plus recheck even when the agent never settles, and reports not drained", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "running"]]);
    const h = harness(stateDir, { graceMs: 3_000, recheckMs: 2_000, abortAfterGrace: true });

    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toEqual({ drained: false, runningCount: 1, abortedSessions: 1 });
    expect(h.clock()).toBe(5_000);
    expect(h.rpc.sessionsAbort).toHaveBeenCalledTimes(1);
  });

  it("keeps polling the scheduler hold until its in-flight run is gone, aborting that run like any session", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:cron", "running"]]);
    const h = harness(stateDir, { schedulerMigrationId: "handoff-1", graceMs: 1_000, recheckMs: 5_000, abortAfterGrace: true });
    let holds = 0;
    h.rpc.schedulerMigration.mockImplementation(async (request) => {
      holds += 1;
      return { operationId: request.operationId, phase: request.phase, agentIds: request.agentIds ?? [], drained: holds > 3 };
    });
    h.rpc.sessionsAbort.mockImplementation(async () => {
      writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:cron", "killed"]]);
      return { ok: true as const, abortedRunId: "run-cron", status: "aborted" as const };
    });

    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toEqual({ drained: true, runningCount: 0, abortedSessions: 1 });
    expect(holds).toBe(4);
  });

  it("refuses to abort a running session whose store carries no session key", async () => {
    const stateDir = mkStateDir();
    const agentDir = path.join(stateDir, "agents", "octogee-alice-coach", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    try {
      db.exec("CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, status TEXT)");
      db.prepare("INSERT INTO session_nodes VALUES (NULL, 's', 'running')").run();
    } finally {
      db.close();
    }
    const h = harness(stateDir, { graceMs: 0 });

    await expect(quiesceUserSessionsBounded(h.opts)).rejects.toThrow(/no session key/u);
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
  });

  it("only waits for the grace window when the caller owns the stop itself", async () => {
    const stateDir = mkStateDir();
    writeSessions(stateDir, "octogee-alice-coach", [["agent:octogee-alice-coach:main", "running"]]);
    const h = harness(stateDir, { graceMs: 2_000, abortAfterGrace: false });

    await expect(quiesceUserSessionsBounded(h.opts)).resolves.toEqual({ drained: false, runningCount: 1, abortedSessions: 0 });
    expect(h.rpc.sessionsAbort).not.toHaveBeenCalled();
    expect(h.clock()).toBe(2_000);
  });
});
