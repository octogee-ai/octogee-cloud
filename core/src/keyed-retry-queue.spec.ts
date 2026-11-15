import { describe, expect, it } from "vitest";
import { createKeyedRetryQueue } from "./keyed-retry-queue.js";

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("keyed retry queue", () => {
  it("keeps a failing key's backoff when the key is enqueued again", async () => {
    const clock = 1_000;
    const runs: number[] = [];
    const queue = createKeyedRetryQueue({
      concurrency: 1,
      now: () => clock,
      retryDelayMs: () => 60_000,
      onError: () => undefined,
      process: async () => {
        runs.push(clock);
        throw new Error("still failing");
      },
    });
    queue.open();
    queue.enqueue("u1");
    await flush();

    queue.enqueue("u1");
    await flush();

    expect(runs).toEqual([1_000]);
    expect(queue.pendingCount()).toBe(1);
    queue.stop();
  });

  it("answers attempted once every key has run, whether it succeeded or failed", async () => {
    const queue = createKeyedRetryQueue({
      concurrency: 2,
      retryDelayMs: () => 60_000,
      onError: () => undefined,
      process: async (key) => {
        if (key === "bad") throw new Error("never succeeds");
      },
    });
    queue.open();
    queue.enqueue("good");
    queue.enqueue("bad");

    await queue.attempted(["good", "bad"]);

    expect(queue.pendingCount()).toBe(1);
    queue.stop();
  });

  it("runs a key again when it is enqueued while running", async () => {
    let release: () => void = () => undefined;
    const runs: string[] = [];
    const queue = createKeyedRetryQueue({
      concurrency: 1,
      retryDelayMs: () => 1,
      onError: () => undefined,
      process: async (key) => {
        runs.push(key);
        if (runs.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      },
    });
    queue.open();
    queue.enqueue("u1");
    await flush();
    queue.enqueue("u1");
    release();

    await queue.settled(["u1"]);

    expect(runs).toEqual(["u1", "u1"]);
    queue.stop();
  });
});
