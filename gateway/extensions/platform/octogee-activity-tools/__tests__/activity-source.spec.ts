import { describe, expect, it } from "vitest";
import {
  createActivitySource,
  type ActivitySourcePreparedEvent,
  type StoredPublicationState,
} from "../activity-source.js";
import {
  createActivitySourceSpool,
  type ActivitySourceSpoolRecord,
} from "../durable-source-spool.js";
import {
  ActivityDeliveryError,
  createActivityOutbox,
} from "../durable-outbox.js";
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

function event(seq: number, stream: string, data: Record<string, unknown>): SourceAgentEvent {
  return {
    runId: target.runId,
    seq,
    stream,
    sessionKey: target.sessionKey,
    agentId: target.agentId,
    data,
  };
}

function answerCommit(
  seq: number,
  terminalOutcome: "completed" | "failed" | "stopped",
): SourceAgentEvent {
  return event(seq, "delivery", {
    schemaVersion: 1,
    kind: "answer-commit",
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
    deliveryOutcome: "delivered",
    postIds: ["answer-post-1"],
    parts: [{
      postId: "answer-post-1",
      kind: "text",
      index: 0,
      rootPostId: target.mainRootPostId,
      threadId: target.mainRootPostId,
    }],
  });
}

describe("durable Activity source", () => {
  it("persists native approval requests and resolutions without requiring approvalId", async () => {
    const delivered: AgentActivityAppend[] = [];
    const source = createActivitySource({
      resolveRun: async () => target,
      append: async (item) => {
        delivered.push(item);
      },
      spool: createActivitySourceSpool({
        store: new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>(),
      }),
      stateStore: new MemoryStore<StoredPublicationState>(),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });

    await source.start();
    await source.handle(event(1, "lifecycle", { phase: "start" }));
    await source.handle(event(2, "approval", {
      phase: "requested",
      kind: "exec",
      status: "pending",
      title: "Command approval requested",
      itemId: "command:tool-1",
      toolCallId: "tool-1",
      approvalId: "approval-1",
      command: "deploy --environment test",
      host: "gateway",
      message: "Waiting for the owner.",
    }));
    await source.handle(event(3, "approval", {
      phase: "resolved",
      kind: "exec",
      status: "approved",
      title: "Command approval resolved",
      itemId: "command:tool-1",
      toolCallId: "tool-1",
      scope: "turn",
      message: "Approved for this turn.",
    }));
    await source.handle(event(4, "approval", {
      phase: "requested",
      kind: "exec",
      status: "unavailable",
      title: "Command approval unavailable",
      itemId: "command:tool-2",
      toolCallId: "tool-2",
      reason: "No interactive approval route is available.",
      message: "The command remains blocked.",
      commandPreviewOmitted: true,
      reasonPreviewOmitted: false,
    }));
    await source.handle(event(5, "approval", {
      phase: "resolved",
      kind: "exec",
      status: "denied",
      title: "Command approval resolved",
      itemId: "command:tool-3",
      toolCallId: "tool-3",
      message: "The owner denied the command.",
    }));

    const approvals = delivered.filter(({ envelope }) => (
      envelope.type === "item.completed" && envelope.item.kind === "approval"
    ));
    expect(approvals.map(({ envelope }) => envelope.ref.itemId)).toEqual([
      "octogee:approval:tool-1:requested",
      "octogee:approval:tool-1:resolved",
      "octogee:approval:tool-2:requested",
      "octogee:approval:tool-3:resolved",
    ]);
    expect(approvals.map(({ envelope }) => envelope.ref.semanticVersion)).toEqual([1, 1, 1, 1]);
    expect(approvals.map(({ envelope }) => envelope.ref.ordinal)).toEqual([1, 2, 3, 4]);
    expect(approvals.map(({ envelope }) => (
      envelope.type === "item.completed" ? envelope.item.status : undefined
    ))).toEqual(["waiting", "completed", "failed", "failed"]);
    expect(approvals.map(({ envelope }) => (
      envelope.type === "item.completed" ? envelope.item.detail?.text : undefined
    ))).toEqual([
      expect.stringContaining("Waiting for the owner."),
      expect.stringContaining("Approved for this turn."),
      expect.stringContaining("No interactive approval route is available."),
      expect.stringContaining("The owner denied the command."),
    ]);
    const unavailableDetail = approvals[2]?.envelope.type === "item.completed"
      ? approvals[2].envelope.item.detail?.text
      : undefined;
    expect(unavailableDetail).toContain('"commandPreviewOmitted": true');
    expect(unavailableDetail).toContain('"reasonPreviewOmitted": false');
    source.stop();
  });

  it("redacts PEM private-key blocks from generic fields and raw text", async () => {
    const delivered: AgentActivityAppend[] = [];
    const source = createActivitySource({
      resolveRun: async () => target,
      append: async (item) => {
        delivered.push(item);
      },
      spool: createActivitySourceSpool({
        store: new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>(),
      }),
      stateStore: new MemoryStore<StoredPublicationState>(),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });
    const inputSentinel = "INPUT_PRIVATE_KEY_SENTINEL";
    const outputSentinel = "OUTPUT_PRIVATE_KEY_SENTINEL";

    await source.start();
    await source.handle(event(1, "lifecycle", { phase: "start" }));
    await source.handle(event(2, "tool", {
      phase: "start",
      toolCallId: "tool-pem",
      name: "inspect",
      args: {
        notes: `before\n-----BEGIN PRIVATE KEY-----\n${inputSentinel}\n-----END PRIVATE KEY-----\nafter`,
      },
    }));
    await source.handle(event(3, "tool", {
      phase: "result",
      toolCallId: "tool-pem",
      name: "inspect",
      output: `before\n-----BEGIN RSA PRIVATE KEY-----\n${outputSentinel}\n-----END RSA PRIVATE KEY-----\nafter`,
    }));

    const serialized = JSON.stringify(delivered);
    expect(serialized).not.toContain(inputSentinel);
    expect(serialized).not.toContain(outputSentinel);
    expect(serialized).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(serialized).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
    expect(serialized).toContain("[redacted: private key]");
    source.stop();
  });

  it("keeps embedded Markdown fences inside the durable tool detail block", async () => {
    const delivered: AgentActivityAppend[] = [];
    const source = createActivitySource({
      resolveRun: async () => target,
      append: async (item) => {
        delivered.push(item);
      },
      spool: createActivitySourceSpool({
        store: new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>(),
      }),
      stateStore: new MemoryStore<StoredPublicationState>(),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });

    await source.start();
    await source.handle(event(1, "lifecycle", { phase: "start" }));
    await source.handle(event(2, "tool", {
      phase: "result",
      toolCallId: "tool-fence",
      name: "inspect",
      output: "before\n```json\n{\"visible\":true}\n```   \nafter",
    }));

    const result = delivered.find(({ envelope }) => envelope.ref.itemId === "tool-fence:result");
    const detail = result?.envelope.type === "item.completed"
      ? result.envelope.item.detail?.text
      : undefined;
    expect(detail).toContain("    ```json");
    expect(detail).toContain("    ```   ");
    expect(detail).toContain('{"visible":true}');
    expect(detail?.match(/^```$/gmu)).toHaveLength(2);
    source.stop();
  });

  it.each([
    ["completed", "completed", "✅ Run completed"],
    ["failed", "failed", "❌ Run failed"],
    ["stopped", "failed", "🛑 Run stopped"],
  ] as const)("waits for answer delivery before emitting an explicit %s terminal checkpoint", async (outcome, status, summary) => {
    const delivered: AgentActivityAppend[] = [];
    const source = createActivitySource({
      resolveRun: async () => target,
      append: async (item) => {
        delivered.push(item);
      },
      spool: createActivitySourceSpool({
        store: new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>(),
      }),
      stateStore: new MemoryStore<StoredPublicationState>(),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });

    await source.start();
    await source.handle(event(1, "lifecycle", { phase: "start" }));
    await source.handle(event(2, "lifecycle", { phase: "end", outcome }));

    expect(delivered.map(({ envelope }) => envelope.type)).toEqual(["turn.started"]);

    await source.handle(answerCommit(3, outcome));

    expect(delivered.find(({ envelope }) => envelope.ref.itemId === "activity.run-complete"))
      .toMatchObject({
        envelope: {
          type: "item.completed",
          item: { kind: "checkpoint", status, summary, detail: { format: "markdown", text: summary } },
        },
      });
    expect(delivered.find(({ envelope }) => envelope.type === "answer.committed"))
      .toMatchObject({
        envelope: {
          type: "answer.committed",
          ref: { itemId: "octogee:answer-commit" },
          answer: {
            terminalOutcome: outcome,
            deliveryOutcome: "delivered",
            postIds: ["answer-post-1"],
            parts: [{
              postId: "answer-post-1",
              kind: "text",
              index: 0,
              rootPostId: target.mainRootPostId,
              threadId: target.mainRootPostId,
            }],
          },
        },
      });
    expect(delivered.at(-1)).toMatchObject({
      envelope: { type: "turn.finalized", outcome },
    });
    source.stop();
  });

  it("fails closed when answer delivery identity does not match the durable run target", async () => {
    const delivered: AgentActivityAppend[] = [];
    const logged: Array<{ message: string; fields: Record<string, unknown> }> = [];
    const source = createActivitySource({
      resolveRun: async () => target,
      append: async (item) => { delivered.push(item); },
      spool: createActivitySourceSpool({
        store: new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>(),
        log: (message, fields) => { logged.push({ message, fields }); },
      }),
      stateStore: new MemoryStore<StoredPublicationState>(),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });

    await source.start();
    await source.handle(event(1, "lifecycle", { phase: "start" }));
    await source.handle(event(2, "lifecycle", { phase: "end", outcome: "completed" }));
    const mismatched = answerCommit(3, "completed");
    mismatched.data.conversationId = "different-conversation";
    await source.handle(mismatched);

    expect(delivered.map(({ envelope }) => envelope.type)).toEqual(["turn.started"]);
    expect(logged).toContainEqual({
      message: "activity source event rejected",
      fields: expect.objectContaining({
        reason: "invalid_activity_event",
        message: "answer commit identity does not match activity target",
      }),
    });
    source.stop();
  });

  it("emits a mutable checkpoint when only its status changes", async () => {
    const delivered: AgentActivityAppend[] = [];
    const source = createActivitySource({
      resolveRun: async () => target,
      append: async (item) => {
        delivered.push(item);
      },
      spool: createActivitySourceSpool({
        store: new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>(),
      }),
      stateStore: new MemoryStore<StoredPublicationState>(),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });

    await source.start();
    await source.handle(event(1, "lifecycle", { phase: "start" }));
    await source.handle(event(2, "checkpoint", {
      itemId: "checkpoint-1",
      status: "waiting",
      summary: "Checkpoint unchanged",
    }));
    await source.handle(event(3, "checkpoint", {
      itemId: "checkpoint-1",
      status: "failed",
      summary: "Checkpoint unchanged",
    }));
    await source.handle(event(4, "checkpoint", {
      itemId: "checkpoint-1",
      status: "failed",
      summary: "Checkpoint unchanged",
    }));

    const checkpoints = delivered.filter(({ envelope }) => (
      envelope.ref.itemId === "checkpoint-1"
    ));
    expect(checkpoints.map(({ envelope }) => envelope.ref.semanticVersion)).toEqual([1, 2]);
    expect(checkpoints.map(({ envelope }) => (
      envelope.type === "item.completed" ? envelope.item.status : undefined
    ))).toEqual(["waiting", "failed"]);
    source.stop();
  });

  it("appends every distinct released commentary revision and deduplicates identical snapshots", async () => {
    const delivered: AgentActivityAppend[] = [];
    const source = createActivitySource({
      resolveRun: async () => target,
      append: async (item) => {
        delivered.push(item);
      },
      spool: createActivitySourceSpool({
        store: new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>(),
      }),
      stateStore: new MemoryStore<StoredPublicationState>(),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });

    await source.start();
    await source.handle(event(1, "lifecycle", { phase: "start" }));
    await source.handle(event(2, "item", {
      itemId: "commentary-1",
      kind: "commentary",
      progressText: "Inspecting token=abcdefghijklmnop",
    }));
    await source.handle(event(3, "item", {
      itemId: "commentary-1",
      kind: "commentary",
      progressText: "Inspecting token=abcdefghijklmnop",
    }));
    await source.handle(event(4, "item", {
      itemId: "commentary-1",
      kind: "commentary",
      progressText: "Inspecting token=abcdefghijklmnop\nFound the boundary",
    }));
    await source.handle(event(5, "item", {
      itemId: "commentary-1",
      kind: "commentary",
      progressText: "Ready",
    }));

    const commentary = delivered.filter(({ envelope }) => (
      envelope.ref.itemId === "commentary-1"
    ));
    expect(commentary.map(({ envelope }) => envelope.ref.semanticVersion)).toEqual([1, 2, 3]);
    expect(commentary.map(({ envelope }) => envelope.ref.ordinal)).toEqual([1, 2, 3]);
    expect(commentary.map(({ envelope }) => (
      envelope.type === "item.completed" ? envelope.item.detail?.text : undefined
    ))).toEqual([
      "Inspecting token=***",
      "Inspecting token=***\nFound the boundary",
      "Ready",
    ]);
    expect(new Set(commentary.map(({ envelope }) => envelope.eventKey)).size).toBe(3);
    source.stop();
  });

  it("bounds stable result ids and summaries while preserving failed tool output", async () => {
    const delivered: AgentActivityAppend[] = [];
    const source = createActivitySource({
      resolveRun: async () => target,
      append: async (item) => {
        delivered.push(item);
      },
      spool: createActivitySourceSpool({
        store: new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>(),
      }),
      stateStore: new MemoryStore<StoredPublicationState>(),
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });
    const result = event(2, "tool", {
      phase: "result",
      toolCallId: "t".repeat(300),
      name: "x".repeat(5_000),
      isError: true,
      durationMs: -1,
      output: "tool failed visibly",
    });

    await source.start();
    await source.handle(event(1, "lifecycle", { phase: "start" }));
    await source.handle(result);
    await source.handle(result);

    const toolResults = delivered.filter(({ envelope }) => envelope.ref.itemId.endsWith(":result"));
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.envelope.ref.itemId).toMatch(/^tool:[a-f0-9]{64}:result$/u);
    expect(toolResults[0]?.envelope.type === "item.completed"
      ? toolResults[0].envelope.item
      : undefined).toMatchObject({
      kind: "tool",
      status: "failed",
      detail: {
        format: "markdown",
        text: "```\ntool failed visibly\n```\n\n_0s · failed_",
      },
    });
    expect(toolResults[0]?.envelope.type === "item.completed"
      ? toolResults[0].envelope.item.summary.length
      : 0).toBe(4_000);
    source.stop();
  });

  it("hands an ordered, idempotent run to the outbox and recovers it after an outage", async () => {
    const sourceStore = new MemoryStore<ActivitySourceSpoolRecord<ActivitySourcePreparedEvent>>();
    const outboxStore = new MemoryStore<AgentActivityAppend>();
    const publicationStore = new MemoryStore<StoredPublicationState>();
    const timers: Array<() => void> = [];
    const offlineOutbox = createActivityOutbox({
      store: outboxStore,
      deliver: async () => {
        throw new ActivityDeliveryError("offline", true);
      },
      setTimeoutImpl: ((callback: () => void) => {
        timers.push(callback);
        return { unref() {} };
      }) as unknown as typeof setTimeout,
    });
    const spool = createActivitySourceSpool({ store: sourceStore });
    const source = createActivitySource({
      resolveRun: async () => target,
      append: (item) => offlineOutbox.enqueue(item),
      spool,
      stateStore: publicationStore,
      sourceIdentity: (sourceEvent) => sourceEvent.runId,
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });

    await offlineOutbox.start();
    await source.start();
    await source.handle(event(1, "lifecycle", { phase: "start" }));
    await source.handle(event(2, "item", {
      itemId: "commentary-1",
      kind: "commentary",
      progressText: "Inspecting the project",
    }));
    const toolInput = event(3, "tool", {
      phase: "start",
      toolCallId: "tool-1",
      name: "read",
      args: {
        path: "README.md",
        nested: {
          accessToken: "input-secret-value",
          sessionKey: "input-session-secret",
        },
      },
    });
    await source.handle(toolInput);
    await source.handle(toolInput);
    const toolResult = event(4, "tool", {
      phase: "result",
      toolCallId: "tool-1",
      name: "read",
      meta: "README.md",
      result: {
        content: "project contents",
        durationMs: 42,
        nested: { credential: "result-secret-value" },
      },
    });
    await source.handle(toolResult);
    await source.handle(toolResult);
    await source.handle(event(5, "lifecycle", { phase: "end", outcome: "completed" }));
    await source.handle(answerCommit(6, "completed"));

    expect(await sourceStore.entries()).toEqual([]);
    expect(await publicationStore.entries()).toEqual([]);
    expect(await outboxStore.entries()).toHaveLength(7);
    expect(timers).toHaveLength(1);
    source.stop();
    offlineOutbox.stop();

    const delivered: AgentActivityAppend[] = [];
    const recoveredOutbox = createActivityOutbox({
      store: outboxStore,
      deliver: async (item) => {
        delivered.push(item);
      },
    });
    await recoveredOutbox.start();

    expect(delivered.map((item) => item.envelope.ref.itemId)).toEqual([
      "octogee:run-root",
      "commentary-1",
      "tool-1:input",
      "tool-1:result",
      "octogee:answer-commit",
      "activity.run-complete",
      "octogee:turn-finalized",
    ]);
    expect(delivered.map((item) => item.envelope.ref.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const input = delivered.find((item) => item.envelope.ref.itemId === "tool-1:input");
    expect(input).toMatchObject({
      envelope: {
        type: "item.completed",
        item: {
          kind: "tool",
          status: "waiting",
          summary: "### 🔧 read · input",
        },
      },
    });
    const inputDetail = input?.envelope.type === "item.completed"
      ? input.envelope.item.detail?.text
      : undefined;
    expect(inputDetail).toContain("```json");
    expect(inputDetail).toContain('"path": "README.md"');
    expect(inputDetail).toContain('"accessToken": "***"');
    expect(inputDetail).toContain('"sessionKey": "***"');
    expect(inputDetail).not.toMatch(/_\d+(?:\.\d+)?s · [^_\n]+_\s*$/u);
    expect(inputDetail).not.toContain("input-secret-value");
    expect(inputDetail).not.toContain("input-session-secret");

    const result = delivered.find((item) => item.envelope.ref.itemId === "tool-1:result");
    expect(result).toMatchObject({
      envelope: {
        type: "item.completed",
        item: {
          kind: "tool",
          status: "completed",
          summary: "### 🔧 read · result · README.md",
        },
      },
    });
    const resultDetail = result?.envelope.type === "item.completed"
      ? result.envelope.item.detail?.text
      : undefined;
    expect(resultDetail).toContain("```\n");
    expect(resultDetail).toContain('"content": "project contents"');
    expect(resultDetail).toContain('"credential": "***"');
    expect(resultDetail).toContain("_0.042s · completed_");
    expect(resultDetail).not.toContain("result-secret-value");
    expect(await outboxStore.entries()).toEqual([]);
  });
});
