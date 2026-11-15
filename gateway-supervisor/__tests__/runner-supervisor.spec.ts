import { describe, expect, it, vi } from "vitest";

import { superviseRunner, type SupervisedChild } from "../lib/runner-supervisor";
import type { RunnerHeartbeat } from "../lib/runner-heartbeat";

// A child whose exit resolves only when we say so, with a chosen code.
function deferredChild(): { child: SupervisedChild; exit: (code: number) => void } {
  let resolve!: (code: number) => void;
  const p = new Promise<number>((r) => (resolve = r));
  return { child: { waitForExit: () => p }, exit: resolve };
}

const noopScheduler = { set: () => 0, clear: () => {} };

interface Harness {
  writes: Array<{ dir: string; hb: RunnerHeartbeat }>;
  logs: string[];
  sleeps: number[];
}

describe("superviseRunner", () => {
  it("writes running:true on launch, running:false + exit code on exit, and counts restarts", async () => {
    const h: Harness = { writes: [], logs: [], sleeps: [] };
    const children = [deferredChild(), deferredChild()];
    let spawnCount = 0;

    const loop = superviseRunner({
      name: "provisioner",
      spawn: () => children[spawnCount++].child,
      heartbeatDir: "/hb",
      restartDelayMs: 5000,
      now: () => 1000,
      sleep: async (ms) => { h.sleeps.push(ms); },
      scheduler: noopScheduler,
      writeHb: (dir, hb) => h.writes.push({ dir, hb }),
      log: (l) => h.logs.push(l),
      // Stop after the second child has been spawned.
      shouldStop: () => spawnCount >= 2,
    });

    // First child exits cleanly → triggers restart.
    children[0].exit(0);
    await Promise.resolve();
    // Second child exits with failure.
    children[1].exit(1);
    await loop;

    const launches = h.writes.filter((w) => w.hb.running);
    const exits = h.writes.filter((w) => !w.hb.running);
    expect(launches.map((w) => w.hb.restarts)).toEqual([0, 1]); // first launch, then restart #1
    expect(exits.map((w) => w.hb.lastExitCode)).toEqual([0, 1]);
    expect(h.writes[0].dir).toBe("/hb");
  });

  it("emits a structured restart log with the exit code on each exit", async () => {
    const h: Harness = { writes: [], logs: [], sleeps: [] };
    const c = deferredChild();
    let spawned = 0;

    const loop = superviseRunner({
      name: "site-build",
      spawn: () => { spawned++; return c.child; },
      now: () => 1,
      sleep: async () => {},
      scheduler: noopScheduler,
      writeHb: () => {},
      log: (l) => h.logs.push(l),
      shouldStop: () => spawned >= 1,
    });
    c.exit(42);
    await loop;

    expect(h.logs).toHaveLength(1);
    const parsed = JSON.parse(h.logs[0]);
    expect(parsed).toMatchObject({ runner: "site-build", event: "restart", exitCode: 42 });
  });

  it("sleeps restartDelayMs between runs", async () => {
    const h: Harness = { writes: [], logs: [], sleeps: [] };
    const children = [deferredChild(), deferredChild()];
    let spawned = 0;
    const loop = superviseRunner({
      name: "x",
      spawn: () => children[spawned++].child,
      restartDelayMs: 1234,
      now: () => 0,
      sleep: async (ms) => { h.sleeps.push(ms); },
      scheduler: noopScheduler,
      writeHb: () => {},
      log: () => {},
      shouldStop: () => spawned >= 2,
    });
    children[0].exit(0);
    await Promise.resolve();
    children[1].exit(0);
    await loop;
    expect(h.sleeps).toEqual([1234]);
  });

  it("does not wait the restart delay once stop is requested", async () => {
    const h: Harness = { writes: [], logs: [], sleeps: [] };
    const c = deferredChild();
    let stopping = false;
    const loop = superviseRunner({
      name: "x",
      spawn: () => c.child,
      restartDelayMs: 30000,
      now: () => 0,
      sleep: async (ms) => { h.sleeps.push(ms); },
      scheduler: noopScheduler,
      writeHb: () => {},
      log: () => {},
      shouldStop: () => stopping,
    });
    stopping = true;
    c.exit(0);
    await loop;
    expect(h.sleeps).toEqual([]);
  });

  it("clears the heartbeat ticker when the child exits", async () => {
    const cleared = vi.fn();
    const sched = { set: () => "handle", clear: cleared };
    const c = deferredChild();
    let spawned = 0;
    const loop = superviseRunner({
      name: "x",
      spawn: () => { spawned++; return c.child; },
      now: () => 0,
      sleep: async () => {},
      scheduler: sched,
      writeHb: () => {},
      log: () => {},
      shouldStop: () => spawned >= 1,
    });
    c.exit(0);
    await loop;
    expect(cleared).toHaveBeenCalledWith("handle");
  });
});
