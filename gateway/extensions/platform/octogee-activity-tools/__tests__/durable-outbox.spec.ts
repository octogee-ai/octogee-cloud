import { describe, expect, it, vi } from "vitest";
import {
  ActivityDeliveryError,
  createActivityOutbox,
} from "../durable-outbox.js";
import type { AgentActivityAppend, AgentActivityIngressRef } from "../activity-types.js";
import { MemoryStore } from "./memory-store.js";

function append(runId: string, ordinal: number): AgentActivityAppend {
  const ref: AgentActivityIngressRef = {
    conversationId: "channel-1",
    turnId: "root-1",
    runId,
    agentId: "coach-1",
    sessionKey: "agent:coach-1:mattermost:channel:channel-1:thread:root-1",
    origin: "human",
    mainChannelId: "channel-1",
    mainRootPostId: "root-1",
    itemId: ordinal === 0 ? "octogee:run-root" : `item-${ordinal}`,
    ordinal,
    semanticVersion: 1,
  };
  return {
    envelope: {
      schemaVersion: 1,
      eventKey: `${runId}-${ordinal}`.padEnd(64, "0"),
      emittedAt: "2026-08-28T00:00:00.000Z",
      ref,
      redaction: { policy: "octogee-v1", appliedAt: "producer" },
      type: "turn.started",
    },
  };
}

describe("durable Activity outbox", () => {
  it("recovers persisted entries in root-before-detail order", async () => {
    const store = new MemoryStore<AgentActivityAppend>();
    await store.registerIfAbsent("detail", append("run-1", 2));
    await store.registerIfAbsent("root", append("run-1", 0));
    const delivered: number[] = [];
    const outbox = createActivityOutbox({
      store,
      deliver: async (item) => { delivered.push(item.envelope.ref.ordinal); },
    });

    await outbox.start();

    expect(delivered).toEqual([0, 2]);
    expect(await store.entries()).toEqual([]);
  });

  it("preserves each run lane when recovered entries are interleaved", async () => {
    const store = new MemoryStore<AgentActivityAppend>();
    await store.registerIfAbsent("run-1-detail", append("run-1", 2));
    await store.registerIfAbsent("run-2-root", append("run-2", 0));
    await store.registerIfAbsent("run-1-root", append("run-1", 0));
    const delivered: string[] = [];
    const outbox = createActivityOutbox({
      store,
      deliver: async (item) => {
        delivered.push(`${item.envelope.ref.runId}:${item.envelope.ref.ordinal}`);
      },
    });

    await outbox.start();

    expect(delivered).toEqual(["run-1:0", "run-1:2", "run-2:0"]);
  });

  it("retains retryable failures and permanently discards rejected payloads", async () => {
    const store = new MemoryStore<AgentActivityAppend>();
    const timers: Array<() => void> = [];
    const retryable = createActivityOutbox({
      store,
      deliver: vi.fn(async () => { throw new ActivityDeliveryError("offline", true); }),
      setTimeoutImpl: ((callback: () => void) => {
        timers.push(callback);
        return { unref() {} };
      }) as unknown as typeof setTimeout,
    });
    await retryable.enqueue(append("run-1", 0));
    expect(await store.entries()).toHaveLength(1);
    expect(timers).toHaveLength(1);
    retryable.stop();

    const rejected = createActivityOutbox({
      store,
      deliver: vi.fn(async () => { throw new ActivityDeliveryError("invalid", false); }),
    });
    await rejected.start();
    expect(await store.entries()).toEqual([]);
  });
});
