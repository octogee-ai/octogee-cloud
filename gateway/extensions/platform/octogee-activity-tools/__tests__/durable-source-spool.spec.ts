import { describe, expect, it, vi } from "vitest";
import { createActivitySourceSpool } from "../durable-source-spool.js";
import { MemoryStore } from "./memory-store.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("durable Activity source spool", () => {
  it("recovers ordered source events and only deletes them after projection", async () => {
    const store = new MemoryStore<any>();
    const spool = createActivitySourceSpool<{ value: string }>({ store });
    await spool.enqueue("run-1", 2, { value: "second" });
    await spool.enqueue("run-1", 1, { value: "first" });
    const projected: string[] = [];

    const reconcile = vi.fn(async () => undefined);
    await spool.start({
      process: vi.fn(async (record) => {
        projected.push(record.payload.value);
        return { kind: "completed" as const };
      }),
      completed: vi.fn(async () => undefined),
      reconcile,
    });

    expect(projected).toEqual(["first", "second"]);
    expect(await store.entries()).toEqual([]);
    expect(reconcile).toHaveBeenCalledWith(new Set());
  });

  it("preserves each source lane when recovered records are interleaved", async () => {
    const store = new MemoryStore<any>();
    const spool = createActivitySourceSpool<{ value: string }>({ store });
    await spool.enqueue("run-1", 2, { value: "run-1:2" });
    await spool.enqueue("run-2", 1, { value: "run-2:1" });
    await spool.enqueue("run-1", 1, { value: "run-1:1" });
    const projected: string[] = [];

    await spool.start({
      process: vi.fn(async (record) => {
        projected.push(record.payload.value);
        return { kind: "completed" as const };
      }),
      completed: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => undefined),
    });

    expect(projected).toEqual(["run-1:1", "run-1:2", "run-2:1"]);
  });

  it("reports lanes that remain pending after startup drain", async () => {
    const store = new MemoryStore<any>();
    const timers: Array<() => void> = [];
    const spool = createActivitySourceSpool<{ value: string }>({
      store,
      setTimeoutImpl: ((callback: () => void) => {
        timers.push(callback);
        return { unref() {} };
      }) as unknown as typeof setTimeout,
    });
    await spool.enqueue("run-1", 1, { value: "blocked" });
    const reconcile = vi.fn(async () => undefined);

    await spool.start({
      process: vi.fn(async () => {
        throw new Error("offline");
      }),
      completed: vi.fn(async () => undefined),
      reconcile,
    });

    expect(reconcile).toHaveBeenCalledWith(new Set(["run-1"]));
    expect(await store.entries()).toHaveLength(1);
    expect(timers).toHaveLength(1);
    spool.stop();
  });

  it("retries startup reconciliation failures without disabling source intake", async () => {
    const store = new MemoryStore<any>();
    const timers: Array<() => void> = [];
    const spool = createActivitySourceSpool<{ value: string }>({
      store,
      setTimeoutImpl: ((callback: () => void) => {
        timers.push(callback);
        return { unref() {} };
      }) as unknown as typeof setTimeout,
    });
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error("state unavailable"))
      .mockResolvedValue(undefined);

    await expect(spool.start({
      process: vi.fn(async () => ({ kind: "completed" as const })),
      completed: vi.fn(async () => undefined),
      reconcile,
    })).resolves.toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(1);

    timers[0]?.();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    spool.stop();
  });

  it("runs a follow-on pass for an enqueue during an active drain without retrying its blocked lane", async () => {
    const store = new MemoryStore<any>();
    const timers: Array<() => void> = [];
    const blockedStarted = deferred();
    const releaseBlocked = deferred();
    const secondRegistered = deferred();
    const releaseSecondRegistration = deferred();
    const registerIfAbsent = store.registerIfAbsent.bind(store);
    vi.spyOn(store, "registerIfAbsent").mockImplementation(async (key, value) => {
      const registered = await registerIfAbsent(key, value);
      if (value.payload.value === "other") {
        secondRegistered.resolve();
        await releaseSecondRegistration.promise;
      }
      return registered;
    });
    const spool = createActivitySourceSpool<{ value: string }>({
      store,
      setTimeoutImpl: ((callback: () => void) => {
        timers.push(callback);
        return { unref() {} };
      }) as unknown as typeof setTimeout,
    });
    const processed: string[] = [];
    const blockedProcess = vi.fn(async () => {
      blockedStarted.resolve();
      await releaseBlocked.promise;
      throw new Error("offline");
    });

    await spool.start({
      process: vi.fn(async (record) => {
        if (record.payload.value === "blocked") return await blockedProcess();
        processed.push(record.payload.value);
        return { kind: "completed" as const };
      }),
      completed: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => undefined),
    });

    const blockedEnqueue = spool.enqueue("run-1", 1, { value: "blocked" });
    await blockedStarted.promise;
    const otherEnqueue = spool.enqueue("run-2", 1, { value: "other" });
    await secondRegistered.promise;
    releaseSecondRegistration.resolve();
    await Promise.resolve();
    await Promise.resolve();
    releaseBlocked.resolve();

    await Promise.all([blockedEnqueue, otherEnqueue]);
    expect(processed).toEqual(["other"]);
    expect(blockedProcess).toHaveBeenCalledTimes(1);
    expect((await store.entries()).map((entry) => entry.value.payload.value)).toEqual(["blocked"]);
    expect(timers).toHaveLength(1);
    spool.stop();
  });
});
