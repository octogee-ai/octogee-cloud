import { describe, expect, it, vi } from "vitest";
import {
  createActivitySource,
  type ActivitySourcePreparedEvent,
  type StoredPublicationState,
} from "../activity-source.js";
import {
  activitySourceSpoolId,
  createActivitySourceSpool,
  type ActivitySourceSpoolRecord,
} from "../durable-source-spool.js";
import type {
  ActivityRunTarget,
  AgentActivityAppend,
  SourceAgentEvent,
} from "../activity-types.js";
import { MemoryStore } from "./memory-store.js";

const target: ActivityRunTarget = {
  conversationId: "channel-1",
  turnId: "root-1",
  runId: "run-1",
  agentId: "coach-1",
  sessionKey: "agent:coach-1:mattermost:channel:channel-1",
  origin: "human",
  mainChannelId: "channel-1",
  mainRootPostId: "root-1",
  inputPostId: "input-1",
};

function lifecycle(seq: number, phase: string): SourceAgentEvent {
  return {
    runId: target.runId,
    seq,
    stream: "lifecycle",
    sessionKey: target.sessionKey,
    agentId: target.agentId,
    data: { phase },
  };
}

function answerCommitData(
  terminalOutcome: "completed" | "failed" | "stopped" = "completed",
) {
  return {
    schemaVersion: 1 as const,
    kind: "answer-commit" as const,
    conversationId: target.conversationId,
    turnId: target.turnId,
    runId: target.runId,
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    origin: target.origin,
    mainChannelId: target.mainChannelId,
    mainRootPostId: target.mainRootPostId,
    inputPostId: target.inputPostId,
    terminalOutcome,
    deliveryOutcome: "delivered" as const,
    postIds: ["answer-post-1"],
    parts: [{ postId: "answer-post-1", kind: "text" as const, index: 0 }],
  };
}

function sourceFor(input: {
  sourceStore: MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>;
  publicationStore: MemoryStore<StoredPublicationState>;
  append: (item: AgentActivityAppend) => Promise<void>;
  now: string;
  setTimeoutImpl?: typeof setTimeout;
  resolveRun?: (event: SourceAgentEvent, context: unknown) => Promise<ActivityRunTarget | "ignore" | null>;
}) {
  return createActivitySource({
    resolveRun: input.resolveRun ?? (async () => target),
    append: input.append,
    spool: createActivitySourceSpool({
      store: input.sourceStore,
      ...(input.setTimeoutImpl ? { setTimeoutImpl: input.setTimeoutImpl } : {}),
    }),
    stateStore: input.publicationStore,
    now: () => new Date(input.now),
  });
}

describe("durable Activity source startup recovery", () => {
  it("stops a persisted publication that has no pending native event", async () => {
    const sourceStore = new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>();
    const publicationStore = new MemoryStore<StoredPublicationState>();
    const delivered: AgentActivityAppend[] = [];
    const first = sourceFor({
      sourceStore,
      publicationStore,
      append: async (item) => { delivered.push(item); },
      now: "2026-08-28T00:00:00.000Z",
    });
    await first.start();
    await first.handle(lifecycle(1, "start"));
    first.stop();

    const resolveRun = vi.fn(async () => target);
    const recovered = sourceFor({
      sourceStore,
      publicationStore,
      append: async (item) => { delivered.push(item); },
      now: "2026-08-28T00:05:00.000Z",
      resolveRun,
    });
    await recovered.start();

    expect(delivered.map(({ envelope }) => envelope.ref.itemId)).toEqual([
      "octogee:run-root",
      "octogee:terminal-error",
      "octogee:answer-commit",
      "activity.run-complete",
      "octogee:turn-finalized",
    ]);
    expect(delivered[1]).toMatchObject({
      envelope: {
        type: "item.completed",
        emittedAt: "2026-08-28T00:05:00.000Z",
        item: {
          kind: "error",
          status: "failed",
          summary: "Gateway restarted before OpenClaw committed final answer delivery",
        },
      },
    });
    expect(delivered[2]).toMatchObject({
      envelope: {
        type: "answer.committed",
        answer: {
          terminalOutcome: "stopped",
          deliveryOutcome: "not-attempted",
          postIds: [],
          parts: [],
        },
      },
    });
    expect(delivered[3]).toMatchObject({
      envelope: {
        type: "item.completed",
        emittedAt: "2026-08-28T00:05:00.000Z",
        item: { kind: "checkpoint", status: "failed", summary: "🛑 Run stopped" },
      },
    });
    expect(delivered[4]).toMatchObject({
      envelope: { type: "turn.finalized", outcome: "stopped" },
    });
    expect(resolveRun).not.toHaveBeenCalled();
    expect(delivered.every(({ envelope }) => (
      envelope.ref.runId === target.runId
      && envelope.ref.sessionKey === target.sessionKey
      && envelope.ref.mainRootPostId === target.mainRootPostId
    ))).toBe(true);
    expect(await publicationStore.entries()).toEqual([]);
    recovered.stop();

    const third = sourceFor({
      sourceStore,
      publicationStore,
      append: async (item) => { delivered.push(item); },
      now: "2026-08-28T00:10:00.000Z",
    });
    await third.start();
    expect(delivered).toHaveLength(5);
    third.stop();
  });

  it("projects pending native terminal and answer delivery before considering recovery", async () => {
    const sourceStore = new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>();
    const publicationStore = new MemoryStore<StoredPublicationState>();
    const delivered: AgentActivityAppend[] = [];
    const first = sourceFor({
      sourceStore,
      publicationStore,
      append: async (item) => { delivered.push(item); },
      now: "2026-08-28T00:00:00.000Z",
    });
    await first.start();
    await first.handle(lifecycle(1, "start"));
    first.stop();

    const terminal: ActivitySourceSpoolRecord<ActivitySourcePreparedEvent> = {
      schemaVersion: 1,
      laneId: target.runId,
      seq: 2,
      payload: {
        event: { ...lifecycle(2, "end"), data: {} },
        action: { type: "terminal", outcome: "completed" },
        context: undefined,
        emittedAt: "2026-08-28T00:04:00.000Z",
      },
    };
    await sourceStore.register(activitySourceSpoolId(target.runId, 2), terminal);
    const deliveryData = answerCommitData();
    const delivery: ActivitySourceSpoolRecord<ActivitySourcePreparedEvent> = {
      schemaVersion: 1,
      laneId: target.runId,
      seq: 3,
      payload: {
        event: {
          runId: target.runId,
          seq: 3,
          stream: "delivery",
          sessionKey: target.sessionKey,
          agentId: target.agentId,
          data: {},
        },
        action: { type: "answer", commit: deliveryData },
        context: undefined,
        emittedAt: "2026-08-28T00:04:30.000Z",
      },
    };
    await sourceStore.register(activitySourceSpoolId(target.runId, 3), delivery);

    const recovered = sourceFor({
      sourceStore,
      publicationStore,
      append: async (item) => { delivered.push(item); },
      now: "2026-08-28T00:05:00.000Z",
    });
    await recovered.start();

    const completion = delivered.find(({ envelope }) => (
      envelope.ref.itemId === "activity.run-complete"
    ));
    expect(completion).toMatchObject({
      envelope: {
        emittedAt: "2026-08-28T00:04:30.000Z",
        item: { summary: "✅ Run completed" },
      },
    });
    expect(delivered.find(({ envelope }) => envelope.type === "answer.committed"))
      .toMatchObject({
        envelope: {
          type: "answer.committed",
          answer: {
            terminalOutcome: "completed",
            deliveryOutcome: "delivered",
            postIds: ["answer-post-1"],
          },
        },
      });
    expect(delivered.some(({ envelope }) => (
      envelope.ref.itemId === "octogee:terminal-error"
      || (envelope.type === "item.completed" && envelope.item.summary === "🛑 Run stopped")
    ))).toBe(false);
    expect(await sourceStore.entries()).toEqual([]);
    expect(await publicationStore.entries()).toEqual([]);
    recovered.stop();
  });

  it("does not guess completion when a persisted lifecycle terminal has no answer delivery", async () => {
    const sourceStore = new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>();
    const publicationStore = new MemoryStore<StoredPublicationState>();
    const delivered: AgentActivityAppend[] = [];
    const first = sourceFor({
      sourceStore,
      publicationStore,
      append: async (item) => { delivered.push(item); },
      now: "2026-08-28T00:00:00.000Z",
    });
    await first.start();
    await first.handle(lifecycle(1, "start"));
    first.stop();

    await sourceStore.register(activitySourceSpoolId(target.runId, 2), {
      schemaVersion: 1,
      laneId: target.runId,
      seq: 2,
      payload: {
        event: { ...lifecycle(2, "end"), data: {} },
        action: { type: "terminal", outcome: "completed" },
        context: undefined,
        emittedAt: "2026-08-28T00:04:00.000Z",
      },
    });

    const recovered = sourceFor({
      sourceStore,
      publicationStore,
      append: async (item) => { delivered.push(item); },
      now: "2026-08-28T00:05:00.000Z",
    });
    await recovered.start();

    expect(delivered.find(({ envelope }) => envelope.type === "answer.committed"))
      .toMatchObject({
        envelope: {
          answer: {
            terminalOutcome: "stopped",
            deliveryOutcome: "not-attempted",
            postIds: [],
            parts: [],
          },
        },
      });
    expect(delivered.at(-1)).toMatchObject({
      envelope: { type: "turn.finalized", outcome: "stopped" },
    });
    expect(delivered.some(({ envelope }) => (
      envelope.type === "item.completed" && envelope.item.summary === "✅ Run completed"
    ))).toBe(false);
    recovered.stop();
  });

  it("recovers an interrupted startup lane after its blocked native record drains", async () => {
    const sourceStore = new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>();
    const publicationStore = new MemoryStore<StoredPublicationState>();
    const delivered: AgentActivityAppend[] = [];
    const first = sourceFor({
      sourceStore,
      publicationStore,
      append: async (item) => { delivered.push(item); },
      now: "2026-08-28T00:00:00.000Z",
    });
    await first.start();
    await first.handle(lifecycle(1, "start"));
    first.stop();

    const pending: ActivitySourceSpoolRecord<ActivitySourcePreparedEvent> = {
      schemaVersion: 1,
      laneId: target.runId,
      seq: 2,
      payload: {
        event: { ...lifecycle(2, "end"), data: {} },
        action: { type: "item", itemId: "checkpoint-1", kind: "checkpoint", status: "completed", body: "Saved", summary: "Saved" },
        context: undefined,
        emittedAt: "2026-08-28T00:04:00.000Z",
      },
    };
    await sourceStore.register(activitySourceSpoolId(target.runId, 2), pending);
    const timers: Array<() => void> = [];
    let available = false;
    const append = vi.fn(async (item: AgentActivityAppend) => {
      if (!available) throw new Error("outbox unavailable");
      delivered.push(item);
    });
    const recovered = sourceFor({
      sourceStore,
      publicationStore,
      append,
      now: "2026-08-28T00:05:00.000Z",
      setTimeoutImpl: ((callback: () => void) => {
        timers.push(callback);
        return { unref() {} };
      }) as unknown as typeof setTimeout,
    });
    await recovered.start();

    expect(append).toHaveBeenCalledTimes(1);
    expect(await sourceStore.entries()).toHaveLength(1);
    expect(await publicationStore.entries()).toHaveLength(1);
    expect(timers).toHaveLength(1);

    available = true;
    timers[0]?.();
    await vi.waitFor(async () => {
      expect(await sourceStore.entries()).toEqual([]);
      expect(await publicationStore.entries()).toEqual([]);
    });
    expect(delivered.map(({ envelope }) => envelope.ref.itemId)).toEqual([
      "octogee:run-root",
      "checkpoint-1",
      "octogee:terminal-error",
      "octogee:answer-commit",
      "activity.run-complete",
      "octogee:turn-finalized",
    ]);
    expect(delivered.at(-2)).toMatchObject({
      envelope: {
        type: "item.completed",
        item: { summary: "🛑 Run stopped" },
      },
    });
    recovered.stop();
  });

  it("recovers a startup spool lane that had no publication until its target resolved", async () => {
    const sourceStore = new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>();
    const publicationStore = new MemoryStore<StoredPublicationState>();
    const delivered: AgentActivityAppend[] = [];
    const pending: ActivitySourceSpoolRecord<ActivitySourcePreparedEvent> = {
      schemaVersion: 1,
      laneId: target.runId,
      seq: 1,
      payload: {
        event: { ...lifecycle(1, "start"), data: {} },
        action: {
          type: "item",
          itemId: "checkpoint-1",
          kind: "checkpoint",
          status: "completed",
          body: "Saved",
          summary: "Saved",
        },
        context: undefined,
        emittedAt: "2026-08-28T00:04:00.000Z",
      },
    };
    await sourceStore.register(activitySourceSpoolId(target.runId, 1), pending);
    let resolution: ActivityRunTarget | null = null;
    const timers: Array<() => void> = [];
    const recovered = sourceFor({
      sourceStore,
      publicationStore,
      append: async (item) => { delivered.push(item); },
      now: "2026-08-28T00:05:00.000Z",
      resolveRun: async () => resolution,
      setTimeoutImpl: ((callback: () => void) => {
        timers.push(callback);
        return { unref() {} };
      }) as unknown as typeof setTimeout,
    });
    await recovered.start();

    expect(await sourceStore.entries()).toHaveLength(1);
    expect(await publicationStore.entries()).toEqual([]);
    expect(timers).toHaveLength(1);

    resolution = target;
    await recovered.drain();

    expect(delivered.map(({ envelope }) => envelope.ref.itemId)).toEqual([
      "octogee:run-root",
      "checkpoint-1",
      "octogee:terminal-error",
      "octogee:answer-commit",
      "activity.run-complete",
      "octogee:turn-finalized",
    ]);
    expect(await sourceStore.entries()).toEqual([]);
    expect(await publicationStore.entries()).toEqual([]);
    recovered.stop();
  });

  it("replays the same recovery facts after a crash while committing final state", async () => {
    class FailingFinalRegisterStore extends MemoryStore<StoredPublicationState> {
      private failFinalRegister = true;

      override async register(key: string, value: StoredPublicationState): Promise<void> {
        if (value.finalized && this.failFinalRegister) {
          this.failFinalRegister = false;
          throw new Error("publication state unavailable");
        }
        await super.register(key, value);
      }
    }

    const sourceStore = new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>();
    const publicationStore = new FailingFinalRegisterStore();
    const persisted = new Map<string, AgentActivityAppend>();
    const append = vi.fn(async (item: AgentActivityAppend) => {
      persisted.set(item.envelope.eventKey, item);
    });
    const first = sourceFor({
      sourceStore,
      publicationStore,
      append,
      now: "2026-08-28T00:00:00.000Z",
    });
    await first.start();
    await first.handle(lifecycle(1, "start"));
    first.stop();

    const interrupted = sourceFor({
      sourceStore,
      publicationStore,
      append,
      now: "2026-08-28T00:05:00.000Z",
      setTimeoutImpl: ((() => ({ unref() {} })) as unknown as typeof setTimeout),
    });
    await interrupted.start();
    interrupted.stop();
    const eventKeysAfterCrash = [...persisted.keys()];

    const replayed = sourceFor({
      sourceStore,
      publicationStore,
      append,
      now: "2026-08-28T00:10:00.000Z",
    });
    await replayed.start();

    expect([...persisted.keys()]).toEqual(eventKeysAfterCrash);
    expect([...persisted.values()].map(({ envelope }) => envelope.ref.itemId)).toEqual([
      "octogee:run-root",
      "octogee:terminal-error",
      "octogee:answer-commit",
      "activity.run-complete",
      "octogee:turn-finalized",
    ]);
    expect(await publicationStore.entries()).toEqual([]);
    replayed.stop();
  });
});
