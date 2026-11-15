import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  userAttachPending,
  userMountPending,
  reconcileFleet,
  startReconcileLoop,
  _resetReconcileInFlightForTests,
  type ReconcileLoopDeps,
} from "../lib/reconcile-loop.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

interface Spy extends ReconcileLoopDeps {
  ensured: string[];
  evicted: string[];
  logs: string[];
}

function mkDeps(over: Partial<ReconcileLoopDeps> = {}): Spy {
  const ensured: string[] = [];
  const evicted: string[] = [];
  const logs: string[] = [];
  return {
    gatewayId: "default",
    getMountObserved: () => [],
    getEvictObserved: () => [],
    readDesired: async () => [],
    ensureSlug: async (slug) => {
      ensured.push(slug);
      return "mounted";
    },
    unmountSlug: async (slug) => {
      evicted.push(slug);
      return "drained";
    },
    log: (m) => logs.push(m),
    ensured,
    evicted,
    logs,
    ...over,
  };
}

/** Both observed views agree — the common case where default-agent-wired == fully-mounted. */
function observed(slugs: string[]): Partial<ReconcileLoopDeps> {
  return { getMountObserved: () => slugs, getEvictObserved: () => slugs };
}

beforeEach(() => _resetReconcileInFlightForTests());

describe("reconcileFleet — bidirectional desired−observed convergence", () => {
  it("rechecks admission before mutating a roster sampled while permitted", async () => {
    const getMountObserved = vi.fn(() => [] as string[]);
    const getEvictObserved = vi.fn(() => ["stale"]);
    const readDesired = vi.fn(async () => ["alice"]);
    const d = mkDeps({
      getMountObserved,
      getEvictObserved,
      readDesired,
      canReconcile: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false),
    });

    await reconcileFleet(d);

    expect(getMountObserved).toHaveBeenCalledOnce();
    expect(getEvictObserved).toHaveBeenCalledOnce();
    expect(readDesired).toHaveBeenCalledOnce();
    expect(d.ensured).toEqual([]);
    expect(d.evicted).toEqual([]);
  });

  it("mounts desired−observed and evicts observed−desired in one tick", async () => {
    const d = mkDeps({
      ...observed(["b", "c", "d"]),
      readDesired: async () => ["a", "b", "c"],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual(["a"]);
    expect(d.evicted).toEqual(["d"]);
  });

  it("retries deferred project hydration after cutover without evicting the user", async () => {
    let hydrateAttempt = 0;
    const d = mkDeps({
      ...observed(["august"]),
      readDesired: async () => ["august"],
      getContentStale: () => ["august"],
      ensureSlug: async (slug) => {
        d.ensured.push(slug);
        hydrateAttempt += 1;
        if (hydrateAttempt === 1) {
          throw new Error("project checkout still absent: roamly");
        }
        return "noop";
      },
    });

    await reconcileFleet(d);

    expect(d.ensured).toEqual(["august"]);
    expect(d.evicted).toEqual([]);
    expect(d.logs.some((line) => line.includes("ensure failed for august"))).toBe(true);

    await reconcileFleet(d);

    expect(d.ensured).toEqual(["august", "august"]);
    expect(d.evicted).toEqual([]);
  });

  it("admits the assigned roster before detached stale-state cleanup completes", async () => {
    const actions: string[] = [];
    const eviction = deferred();
    const d = mkDeps({
      maxConcurrent: 4,
      ...observed(["test31"]),
      readDesired: async () => ["alice", "bob"],
      unmountSlug: async (slug) => {
        actions.push(`evict:${slug}`);
        await eviction.promise;
        return "drained";
      },
      ensureSlug: async (slug) => {
        actions.push(`mount:${slug}`);
        return "mounted";
      },
    });

    await reconcileFleet(d);
    await flushMicrotasks();
    expect(actions).toEqual(["mount:alice", "mount:bob", "evict:test31"]);
    eviction.resolve();
    await flushMicrotasks();

    expect(actions).toEqual(["mount:alice", "mount:bob", "evict:test31"]);
  });

  it("admits a fresh mount when stale local state cannot be evicted", async () => {
    const d = mkDeps({
      ...observed(["test31"]),
      readDesired: async () => ["alice"],
      unmountSlug: async () => {
        throw new Error("remove config.patch rejected");
      },
    });

    await reconcileFleet(d);
    await flushMicrotasks();

    expect(d.ensured).toEqual(["alice"]);
    expect(d.logs.some((line) => line.includes("evict failed"))).toBe(true);
  });

  it("carries blocked cleanup across ticks into fresh admission and keeps one cleanup lane", async () => {
    const blockedA = deferred();
    let evictObserved = ["a"];
    let desired: string[] = [];
    let activeCleanup = 0;
    let maxActiveCleanup = 0;
    const cleanupStarts: string[] = [];
    const admissionBatches: string[][] = [];
    const d = mkDeps({
      getMountObserved: () => [],
      getEvictObserved: () => evictObserved,
      readDesired: async () => desired,
      ensureSlug: async (_slug, batch, currentBatch) => {
        admissionBatches.push([...batch].sort(), [...currentBatch()].sort());
        return "mounted";
      },
      unmountSlug: async (slug) => {
        cleanupStarts.push(slug);
        activeCleanup++;
        maxActiveCleanup = Math.max(maxActiveCleanup, activeCleanup);
        if (slug === "a") await blockedA.promise;
        activeCleanup--;
        return "drained";
      },
    });

    await reconcileFleet(d);
    await flushMicrotasks();
    expect(cleanupStarts).toEqual(["a"]);

    evictObserved = ["a", "b"];
    desired = ["fresh"];
    await reconcileFleet(d);

    expect(admissionBatches).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(cleanupStarts).toEqual(["a"]);
    expect(maxActiveCleanup).toBe(1);

    blockedA.resolve();
    await vi.waitFor(() => expect(cleanupStarts).toEqual(["a", "b"]));
    await vi.waitFor(() => expect(activeCleanup).toBe(0));
    expect(maxActiveCleanup).toBe(1);
  });

  it("repairs a re-admitted batch member once when the batch owner already quarantined it", async () => {
    const ownerCleanup = deferred();
    let desired: string[] = [];
    const mounted = new Set<string>();
    const ensured: string[] = [];
    const cleanupStarts: string[] = [];
    const cancelled: string[] = [];
    const d = mkDeps({
      getMountObserved: () => [...mounted],
      getEvictObserved: () => ["a", "b"],
      readDesired: async () => desired,
      ensureSlug: async (slug) => {
        ensured.push(slug);
        mounted.add(slug);
        return "mounted";
      },
      unmountSlug: async (slug) => {
        cleanupStarts.push(slug);
        if (slug === "a") await ownerCleanup.promise;
        return "drained";
      },
      onPendingEvictionCancelled: (slug) => cancelled.push(slug),
    });

    await reconcileFleet(d);
    await flushMicrotasks();
    expect(cleanupStarts).toEqual(["a"]);

    desired = ["b"];
    await reconcileFleet(d);
    expect(cancelled).toEqual(["b"]);
    expect(ensured).toEqual(["b"]);

    ownerCleanup.resolve();
    await vi.waitFor(() => expect(cleanupStarts).toEqual(["a"]));
    await reconcileFleet(d);
    expect(ensured).toEqual(["b"]);
  });

  it("mounts other users after a setup failure and retries the failed user next tick", async () => {
    let failed = false;
    const mounted = new Set<string>();
    const d = mkDeps({
      maxConcurrent: 1,
      readDesired: async () => ["cold", "other"],
      getMountObserved: () => [...mounted],
      ensureSlug: async (slug) => {
        d.ensured.push(slug);
        if (slug === "cold" && !failed) {
          failed = true;
          throw new Error("User profile catalog is not ready");
        }
        mounted.add(slug);
        return "mounted";
      },
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual(["cold", "other"]);
    await reconcileFleet(d);
    expect(d.ensured).toEqual(["cold", "other", "cold"]);
  });

  it("continues the serial mount lane after a permanent config failure", async () => {
    const d = mkDeps({
      maxConcurrent: 1,
      readDesired: async () => ["poisoned", "protected"],
      ensureSlug: async (slug) => {
        d.ensured.push(slug);
        if (slug === "poisoned") throw new Error("invalid patch");
        return "mounted";
      },
    });

    await reconcileFleet(d);

    expect(d.ensured).toEqual(["poisoned", "protected"]);
  });

  it("mounts concurrently with a bounded worker pool", async () => {
    let active = 0;
    let peak = 0;
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const slugs = ["a", "b", "c", "d"];
    for (const s of slugs) gates.set(s, deferred());
    const d = mkDeps({
      maxConcurrent: 3,
      readDesired: async () => slugs,
      ensureSlug: async (slug) => {
        active++;
        peak = Math.max(peak, active);
        await gates.get(slug)!.promise;
        active--;
        return "mounted";
      },
    });
    const p = reconcileFleet(d);
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(3);
    for (const g of gates.values()) g.resolve();
    await p;
  });

  it("continues queued mounts after a permanent config failure in a concurrent lane", async () => {
    const started: string[] = [];
    const gate = deferred();
    const d = mkDeps({
      maxConcurrent: 2,
      readDesired: async () => ["poisoned", "in-flight", "later", "last"],
      ensureSlug: async (slug) => {
        started.push(slug);
        if (slug === "poisoned") throw new Error("invalid patch");
        await gate.promise;
        return "mounted";
      },
    });
    const p = reconcileFleet(d);
    await new Promise((r) => setTimeout(r, 10));
    gate.resolve();
    await p;

    expect(started.sort()).toEqual(["in-flight", "last", "later", "poisoned"]);
  });

  it("rechecks queued work against current quiescing admission without evicting its roster member", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let quiescing = false;
    const d = mkDeps({
      maxConcurrent: 1,
      ...observed(["source"]),
      getContentStale: () => ["source"],
      readDesired: async () => ["first", "source"],
      canEnsureSlug: async (slug) => slug !== "source" || !quiescing,
      ensureSlug: async (slug) => {
        d.ensured.push(slug);
        if (slug === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return "mounted";
      },
    });

    const tick = reconcileFleet(d);
    await firstStarted.promise;
    quiescing = true;
    releaseFirst.resolve();
    await tick;

    expect(d.ensured).toEqual(["first"]);
    expect(d.evicted).toEqual([]);
  });

  it("surfaces a failed admission refresh without ensuring or evicting from the failed read", async () => {
    const failure = new Error("missing canonical assignment for uid-alice");
    const onEnsureError = vi.fn();
    const d = mkDeps({
      ...observed(["alice"]),
      getContentStale: () => ["alice"],
      readDesired: async () => ["alice"],
      canEnsureSlug: vi.fn().mockRejectedValueOnce(failure),
      onEnsureError,
    });

    await reconcileFleet(d);

    expect(d.ensured).toEqual([]);
    expect(d.evicted).toEqual([]);
    expect(onEnsureError).toHaveBeenCalledExactlyOnceWith("alice", failure.message, failure);
    expect(d.logs).toContainEqual(expect.stringContaining(failure.message));
  });

  it("continues evicting while the ensure lane is held", async () => {
    const d = mkDeps({
      ...observed(["stale"]),
      readDesired: async () => ["alice"],
      shouldEnsureSlug: () => false,
    });

    await reconcileFleet(d);

    expect(d.evicted).toEqual(["stale"]);
    expect(d.ensured).toEqual([]);
  });

  it("resumes a held mount lane on the next tick after stale state is evicted", async () => {
    let observedSlugs = ["stale"];
    let held = true;
    const d = mkDeps({
      getMountObserved: () => observedSlugs,
      getEvictObserved: () => observedSlugs,
      readDesired: async () => ["alice"],
      shouldEnsureSlug: () => !held,
      unmountSlug: async (slug) => {
        d.evicted.push(slug);
        held = false;
        observedSlugs = [];
        return "drained";
      },
    });

    await reconcileFleet(d);
    expect(d.evicted).toEqual(["stale"]);
    expect(d.ensured).toEqual([]);

    await reconcileFleet(d);
    expect(d.ensured).toEqual(["alice"]);
  });

  it("is a no-op when observed already equals desired (no mount, no evict)", async () => {
    const d = mkDeps({
      ...observed(["a", "b"]),
      readDesired: async () => ["a", "b"],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual([]);
    expect(d.evicted).toEqual([]);
  });

  it("self-heals a desired-but-unmounted slug without any push or kick", async () => {
    // The livefixture repro: assigned (desired) but absent on disk (observed) → mounted.
    const d = mkDeps({
      readDesired: async () => ["livefixture"],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual(["livefixture"]);
  });

  it("skips a slug already in flight from a prior overlapping tick (no double-mount)", async () => {
    const started = deferred();
    const release = deferred();
    const d = mkDeps({
      readDesired: async () => ["a"],
      ensureSlug: async (slug) => {
        d.ensured.push(slug);
        started.resolve();
        await release.promise;
        return "mounted";
      },
    });
    const first = reconcileFleet(d);
    await started.promise; // a is now in flight
    await reconcileFleet(d); // overlapping tick: a in flight → skipped
    expect(d.ensured).toEqual(["a"]); // mounted exactly once
    release.resolve();
    await first;
  });

  it("starts a slug assigned during a running tick alongside the in-flight lanes", async () => {
    const gates = new Map([["a", deferred()], ["b", deferred()], ["c", deferred()]]);
    let desired = ["a", "b"];
    const d = mkDeps({
      maxConcurrent: 4,
      readDesired: async () => desired,
      ensureSlug: async (slug) => {
        d.ensured.push(slug);
        await gates.get(slug)!.promise;
        return "mounted";
      },
    });
    const first = reconcileFleet(d);
    await vi.waitFor(() => expect(d.ensured).toEqual(["a", "b"]));
    desired = ["a", "b", "c"];
    const second = reconcileFleet(d);
    await vi.waitFor(() => expect(d.ensured).toEqual(["a", "b", "c"]));
    for (const gate of gates.values()) gate.resolve();
    await Promise.all([first, second]);
  });

  it("holds the mount cap process-wide across overlapping ticks", async () => {
    const gates = new Map([["a", deferred()], ["b", deferred()], ["c", deferred()]]);
    let desired = ["a", "b"];
    const d = mkDeps({
      maxConcurrent: 2,
      readDesired: async () => desired,
      ensureSlug: async (slug) => {
        d.ensured.push(slug);
        await gates.get(slug)!.promise;
        return "mounted";
      },
    });
    const first = reconcileFleet(d);
    await vi.waitFor(() => expect(d.ensured).toEqual(["a", "b"]));
    desired = ["a", "b", "c"];
    const second = reconcileFleet(d);
    await new Promise((r) => setTimeout(r, 10));
    expect(d.ensured).toEqual(["a", "b"]);
    gates.get("a")!.resolve();
    await vi.waitFor(() => expect(d.ensured).toEqual(["a", "b", "c"]));
    gates.get("b")!.resolve();
    gates.get("c")!.resolve();
    await Promise.all([first, second]);
  });

  it("caps work at maxConcurrent", async () => {
    let active = 0;
    let peak = 0;
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const slugs = ["a", "b", "c", "d", "e"];
    for (const s of slugs) gates.set(s, deferred());
    const d = mkDeps({
      maxConcurrent: 2,
      readDesired: async () => slugs,
      ensureSlug: async (slug) => {
        active++;
        peak = Math.max(peak, active);
        await gates.get(slug)!.promise;
        active--;
        return "mounted";
      },
    });
    const p = reconcileFleet(d);
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBeLessThanOrEqual(2);
    for (const g of gates.values()) g.resolve();
    await p;
    expect(d.ensured.length).toBe(0); // ensureSlug overridden; just assert all completed
    expect(peak).toBe(2);
  });

  it("maxConcurrent: 1 runs ensures fully serially — no overlap that could bleed shared adapter state", async () => {
    let active = 0;
    let peak = 0;
    const slugs = ["a", "b", "c"];
    const gates = slugs.map(() => deferred());
    const order: string[] = [];
    const d = mkDeps({
      maxConcurrent: 1,
      readDesired: async () => slugs,
      ensureSlug: async (slug) => {
        active++;
        peak = Math.max(peak, active);
        order.push(slug);
        await gates[slugs.indexOf(slug)].promise;
        active--;
        return "mounted";
      },
    });
    const p = reconcileFleet(d);
    for (let i = 0; i < slugs.length; i++) {
      await new Promise((r) => setTimeout(r, 5));
      expect(peak).toBe(1); // never more than one ensure in flight
      gates[i].resolve();
    }
    await p;
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("a failing ensure is logged and does not block the rest (left for the next tick)", async () => {
    const d = mkDeps({
      readDesired: async () => ["bad", "good"],
      ensureSlug: async (slug) => {
        if (slug === "bad") throw new Error("boom");
        d.ensured.push(slug);
        return "mounted";
      },
    });
    await expect(reconcileFleet(d)).resolves.toBeUndefined(); // does not throw
    expect(d.ensured).toEqual(["good"]);
    expect(d.logs.some((l) => l.includes("bad") && l.includes("boom"))).toBe(true);
  });

  it("clears in-flight after a tick so the next tick re-drives a still-missing slug (retry)", async () => {
    let attempt = 0;
    const d = mkDeps({
      readDesired: async () => ["x"],
      ensureSlug: async (slug) => {
        attempt++;
        if (attempt === 1) throw new Error("transient");
        d.ensured.push(slug);
        return "mounted";
      },
    });
    await reconcileFleet(d); // attempt 1 fails
    await reconcileFleet(d); // attempt 2 succeeds (not wedged in-flight)
    expect(d.ensured).toEqual(["x"]);
    expect(attempt).toBe(2);
  });
});

describe("reconcileFleet — split observed (mount keys off completion, evict off presence)", () => {
  it("re-ensures a wired-but-unmarked desired slug instead of treating it as done", async () => {
    // The post-config wedge: agent is wired on disk (evict-observed) but the mount never
    // completed (no .mounted marker → absent from mount-observed). Still desired, so it
    // belongs in toMount, NOT silently skipped — and must NOT be evicted.
    const d = mkDeps({
      getEvictObserved: () => ["wedged"], // default-agent-wired on disk
      getMountObserved: () => [], // but not fully mounted (no marker)
      readDesired: async () => ["wedged"],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual(["wedged"]);
    expect(d.evicted).toEqual([]);
  });

  it("still evicts an unassigned on-disk user", async () => {
    const d = mkDeps({
      ...observed(["ghost"]),
      readDesired: async () => [],
    });
    await reconcileFleet(d);
    expect(d.evicted).toEqual(["ghost"]);
    expect(d.ensured).toEqual([]);
  });

  it("never evicts a converging user (desired, not yet on disk at all)", async () => {
    const d = mkDeps({
      getEvictObserved: () => [],
      getMountObserved: () => [],
      readDesired: async () => ["arriving"],
    });
    await reconcileFleet(d);
    expect(d.evicted).toEqual([]);
    expect(d.ensured).toEqual(["arriving"]);
  });
});

describe("reconcileFleet — ensure outcome surfaced (best-effort lastError mirror)", () => {
  it("reports success to onEnsureSuccess and failure to onEnsureError", async () => {
    const succeeded: string[] = [];
    const failed: Array<{ slug: string; message: string }> = [];
    const d = mkDeps({
      readDesired: async () => ["ok", "bad"],
      ensureSlug: async (slug) => {
        if (slug === "bad") throw new Error("kaboom");
        return "mounted";
      },
      onEnsureSuccess: (slug) => succeeded.push(slug),
      onEnsureError: (slug, message) => failed.push({ slug, message }),
    });
    await reconcileFleet(d);
    expect(succeeded).toEqual(["ok"]);
    expect(failed).toEqual([{ slug: "bad", message: "kaboom" }]);
  });

  it("a throwing outcome hook never crashes the tick", async () => {
    const d = mkDeps({
      readDesired: async () => ["ok", "bad"],
      ensureSlug: async (slug) => {
        if (slug === "bad") throw new Error("kaboom");
        return "mounted";
      },
      onEnsureSuccess: () => {
        throw new Error("hook exploded");
      },
      onEnsureError: () => {
        throw new Error("hook exploded");
      },
    });
    await expect(reconcileFleet(d)).resolves.toBeUndefined();
  });
});

describe("reconcileFleet — content convergence (mounted-but-stale re-ensured)", () => {
  it("re-ensures a mounted slug whose config content drifted, without a remount", async () => {
    // The multi-agent repro: a project-agent toggle changes the user's snapshot while
    // it's already fully mounted. Membership is unchanged (still desired, still
    // mount-observed), so the set-difference alone would skip it — content staleness
    // must pull it back into toMount so the new project agent binding lands.
    const d = mkDeps({
      ...observed(["a"]),
      readDesired: async () => ["a"],
      getContentStale: () => ["a"],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual(["a"]);
    expect(d.evicted).toEqual([]);
  });

  it("does NOT re-ensure a mounted slug whose content is current", async () => {
    const d = mkDeps({
      ...observed(["a", "b"]),
      readDesired: async () => ["a", "b"],
      getContentStale: () => [],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual([]);
  });

  it("never ensures a stale slug that is not desired (staleness cannot resurrect an unassigned slug)", async () => {
    const d = mkDeps({
      getMountObserved: () => ["gone"],
      getEvictObserved: () => [],
      readDesired: async () => [],
      getContentStale: () => ["gone"],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual([]);
  });

  it("does not double-drive a slug that is both unmounted and reported stale", async () => {
    const d = mkDeps({
      getMountObserved: () => [],
      getEvictObserved: () => [],
      readDesired: async () => ["a"],
      getContentStale: () => ["a"],
    });
    await reconcileFleet(d);
    expect(d.ensured).toEqual(["a"]); // exactly once
  });
});

describe("startReconcileLoop", () => {
  it("wakes immediately from push and drains an event received during a mount", async () => {
    let wake!: () => void;
    const unsubscribe = vi.fn();
    const gate = deferred();
    let desired = ["a"];
    const mounted: string[] = [];
    const d = mkDeps({
      getMountObserved: () => mounted,
      readDesired: async () => desired,
      ensureSlug: async (slug) => {
        if (slug === "a") await gate.promise;
        mounted.push(slug);
        return "mounted";
      },
    });
    const stop = startReconcileLoop({ ...d, intervalMs: 60_000,
      subscribe: (notify) => { wake = notify; return unsubscribe; },
    });
    try {
      wake();
      await flushMicrotasks();
      desired = ["a", "b"];
      wake();
      gate.resolve();
      await vi.waitFor(() => expect(mounted).toEqual(["a", "b"]));
    } finally { gate.resolve(); stop(); }
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("reconciles a push wake immediately while an earlier tick is still mounting", async () => {
    let wake!: () => void;
    const gate = deferred();
    let desired = ["a"];
    const d = mkDeps({
      readDesired: async () => desired,
      ensureSlug: async (slug) => {
        d.ensured.push(slug);
        if (slug === "a") await gate.promise;
        return "mounted";
      },
    });
    const stop = startReconcileLoop({ ...d, intervalMs: 60_000,
      subscribe: (notify) => { wake = notify; return () => undefined; },
    });
    try {
      wake();
      await vi.waitFor(() => expect(d.ensured).toEqual(["a"]));
      desired = ["a", "b"];
      wake();
      await vi.waitFor(() => expect(d.ensured).toEqual(["a", "b"]));
    } finally { gate.resolve(); stop(); }
  });

  it("reconciles on each interval tick and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const d = mkDeps({ readDesired: async () => ["a"] });
      const stop = startReconcileLoop({ ...d, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      stop();
      await vi.advanceTimersByTimeAsync(1000);
      // ensured "a" on the first tick; second tick it's still observed-empty so re-ensures.
      expect(d.ensured.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is non-reentrant: an interval firing while the prior tick's ensure is pending does not start a concurrent ensure", async () => {
    vi.useFakeTimers();
    try {
      const ensured: string[] = [];
      let inEnsure = 0;
      let peak = 0;
      const aGate = deferred();
      const d = mkDeps({
        ...observed([]),
        readDesired: async () => ["a", "b"],
        maxConcurrent: 1,
        ensureSlug: async (slug) => {
          inEnsure += 1;
          peak = Math.max(peak, inEnsure);
          if (slug === "a") await aGate.promise; // hold "a" across the next interval
          inEnsure -= 1;
          ensured.push(slug);
          return "mounted";
        },
      });
      const stop = startReconcileLoop({ ...d, intervalMs: 1000 });

      await vi.advanceTimersByTimeAsync(1000); // tick 1 → ensure("a") starts and hangs
      expect(peak).toBe(1);

      await vi.advanceTimersByTimeAsync(1000); // tick 2 fires while "a" is still pending
      // Without the re-entrancy guard, tick 2 runs reconcileFleet again and starts
      // ensure("b") concurrently (a different slug → the per-slug inFlight guard
      // doesn't stop it), defeating maxConcurrent: 1. With the guard, tick 2 is skipped.
      expect(peak).toBe(1);

      aGate.resolve(); // let "a" finish; tick 1's worker proceeds to "b" serially
      await vi.advanceTimersByTimeAsync(0);
      expect(peak).toBe(1);
      expect(ensured).toContain("b");

      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("userMountPending", () => {
  it("holds for a slug queued behind the mount pool and while its ensure runs", async () => {
    const first = deferred<"mounted">();
    const d = mkDeps({
      maxConcurrent: 1,
      readDesired: async () => ["alice", "bob"],
      ensureSlug: async (slug) => (slug === "alice" ? first.promise : "mounted"),
    });

    const tick = reconcileFleet(d);
    await flushMicrotasks();

    expect(userMountPending("alice")).toBe(true);
    expect(userMountPending("bob")).toBe(true);
    expect(userMountPending("carol")).toBe(false);
    first.resolve("mounted");
    await tick;
    expect(userMountPending("alice")).toBe(false);
    expect(userMountPending("bob")).toBe(false);
  });

  it("clears when the ensure fails, so a failed attach is not reported in progress", async () => {
    const d = mkDeps({
      readDesired: async () => ["alice"],
      ensureSlug: async () => { throw new Error("config.patch refused"); },
    });

    await reconcileFleet(d);

    expect(userMountPending("alice")).toBe(false);
  });

  it("does not report an eviction as a pending mount", async () => {
    const drain = deferred<"drained">();
    const d = mkDeps({
      ...observed(["alice"]),
      readDesired: async () => [],
      unmountSlug: async () => drain.promise,
    });

    await reconcileFleet(d);
    await flushMicrotasks();

    expect(userMountPending("alice")).toBe(false);
    drain.resolve("drained");
  });
});

describe("userAttachPending", () => {
  const assigned = (value: boolean) => vi.fn(async () => value);

  it("covers an assignment no reconcile tick has picked up yet", async () => {
    const isAssigned = assigned(true);

    expect(await userAttachPending("alice", isAssigned)).toBe(true);
    expect(isAssigned).toHaveBeenCalledOnce();
  });

  it("does not report an unassigned slug awaiting its first ensure", async () => {
    expect(await userAttachPending("alice", assigned(false))).toBe(false);
  });

  it("stops once a tick attempted the assignment and the ensure failed", async () => {
    await reconcileFleet(mkDeps({
      readDesired: async () => ["alice"],
      ensureSlug: async () => { throw new Error("config.patch refused"); },
    }));

    expect(await userAttachPending("alice", assigned(true))).toBe(false);
  });

  it("holds while the picked-up ensure runs without reading the assignment", async () => {
    const ensure = deferred<"mounted">();
    const tick = reconcileFleet(mkDeps({
      readDesired: async () => ["alice"],
      ensureSlug: async () => ensure.promise,
    }));
    await flushMicrotasks();
    const isAssigned = assigned(true);

    expect(await userAttachPending("alice", isAssigned)).toBe(true);
    expect(isAssigned).not.toHaveBeenCalled();
    ensure.resolve("mounted");
    await tick;
  });

  it("stops when a tick attempts the assignment while the assignment read is in flight", async () => {
    const read = deferred<boolean>();
    const pending = userAttachPending("alice", () => read.promise);
    await reconcileFleet(mkDeps({
      readDesired: async () => ["alice"],
      ensureSlug: async () => { throw new Error("config.patch refused"); },
    }));
    read.resolve(true);

    expect(await pending).toBe(false);
  });
});

describe("reconcileFleet — mount lanes (create precedes move)", () => {
  const lanes = (creates: string[]) => (slug: string) => (creates.includes(slug) ? "create" : "move") as const;

  it("starts create-lane mounts before move-lane mounts queued ahead of them, FIFO within a lane", async () => {
    const slugs = ["mover-a", "new-1", "mover-b", "new-2"];
    const gates = new Map(slugs.map((s) => [s, deferred()]));
    const d = mkDeps({
      maxConcurrent: 1,
      readDesired: async () => slugs,
      mountLane: lanes(["new-1", "new-2"]),
      ensureSlug: async (slug) => {
        d.ensured.push(slug);
        await gates.get(slug)!.promise;
        return "mounted";
      },
    });
    const p = reconcileFleet(d);
    await vi.waitFor(() => expect(d.ensured).toEqual(["new-1"]));
    gates.get("new-1")!.resolve();
    await vi.waitFor(() => expect(d.ensured).toEqual(["new-1", "new-2"]));
    gates.get("new-2")!.resolve();
    await vi.waitFor(() => expect(d.ensured).toEqual(["new-1", "new-2", "mover-a"]));
    gates.get("mover-a")!.resolve();
    await vi.waitFor(() => expect(d.ensured).toEqual(["new-1", "new-2", "mover-a", "mover-b"]));
    gates.get("mover-b")!.resolve();
    await p;
    expect(d.logs.some((m) => m.includes("new-1:create") && m.includes("mover-a:move"))).toBe(true);
  });

  it("a new user assigned while movers are queued from an earlier tick mounts next", async () => {
    const gates = new Map(["a", "b", "c", "oct08"].map((s) => [s, deferred()]));
    let desired = ["a", "b", "c"];
    const d = mkDeps({
      maxConcurrent: 1,
      readDesired: async () => desired,
      mountLane: lanes(["oct08"]),
      ensureSlug: async (slug) => {
        d.ensured.push(slug);
        await gates.get(slug)!.promise;
        return "mounted";
      },
    });
    const first = reconcileFleet(d);
    await vi.waitFor(() => expect(d.ensured).toEqual(["a"]));
    desired = ["a", "b", "c", "oct08"];
    const second = reconcileFleet(d);
    await new Promise((r) => setTimeout(r, 10));
    expect(d.ensured).toEqual(["a"]);
    gates.get("a")!.resolve();
    await vi.waitFor(() => expect(d.ensured).toEqual(["a", "oct08"]));
    gates.get("oct08")!.resolve();
    await vi.waitFor(() => expect(d.ensured).toEqual(["a", "oct08", "b"]));
    gates.get("b")!.resolve();
    await vi.waitFor(() => expect(d.ensured).toEqual(["a", "oct08", "b", "c"]));
    gates.get("c")!.resolve();
    await Promise.all([first, second]);
  });

  it("without a lane source every mount shares one lane in roster order", async () => {
    const d = mkDeps({ maxConcurrent: 1, readDesired: async () => ["b", "a"] });
    await reconcileFleet(d);
    expect(d.ensured).toEqual(["b", "a"]);
  });
});
