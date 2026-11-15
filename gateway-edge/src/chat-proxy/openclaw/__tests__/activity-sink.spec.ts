import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_ACTIVITY_RESERVED_ITEM_IDS,
  agentActivityCanonicalKey,
  type AgentActivityEnvelopeV1,
} from "@octogee/shared/types/agent-conversation";
import {
  activityPayloadDigest,
  createActivitySink,
  ActivitySinkInvalidAttachmentError,
  ActivitySinkIntegrityError,
} from "../activity-sink.js";
import {
  InMemoryActivityWriteReceiptStore,
  type ActivityWriteReceiptStore,
} from "@octogee/core/http-candidates/chat-proxy/openclaw/activity-write-receipts";
import type {
  ActivityMattermostClient,
  ActivityMattermostPost,
} from "../mm-client.js";

function envelope(
  type: AgentActivityEnvelopeV1['type'],
  overrides: Partial<AgentActivityEnvelopeV1> = {},
): AgentActivityEnvelopeV1 {
  const ref = {
    conversationId: "main-1",
    turnId: "turn-1",
    runId: "run-1",
    agentId: "agent-1",
    sessionKey: "agent:agent-1:mattermost:channel:main-1",
    origin: "human" as const,
    mainChannelId: "main-1",
    mainRootPostId: "turn-1",
    inputPostId: "turn-1",
    itemId: type === "turn.started" ? AGENT_ACTIVITY_RESERVED_ITEM_IDS.runRoot : "tool-1",
    ordinal: type === "turn.started" ? 0 : 1,
    semanticVersion: 1,
  };
  const base = {
    schemaVersion: 1 as const,
    eventKey: createHash("sha256").update(agentActivityCanonicalKey(ref)).digest("hex"),
    emittedAt: "2026-07-11T15:00:00.000Z",
    ref,
    redaction: { policy: "octogee-v1" as const, appliedAt: "producer" as const },
  };
  if (type === "turn.started") return { ...base, type, ...overrides } as AgentActivityEnvelopeV1;
  if (type === "turn.finalized") {
    const finalizedRef = {
      ...ref,
      itemId: AGENT_ACTIVITY_RESERVED_ITEM_IDS.turnFinalized,
      ordinal: 5,
    };
    return {
      ...base,
      eventKey: createHash("sha256").update(agentActivityCanonicalKey(finalizedRef)).digest("hex"),
      ref: finalizedRef,
      type,
      outcome: "completed",
      ...overrides,
    } as AgentActivityEnvelopeV1;
  }
  return {
    ...base,
    type: "item.completed",
    item: { kind: "tool", status: "completed", summary: "Ran inspection" },
    ...overrides,
  } as AgentActivityEnvelopeV1;
}

function answerEnvelope(): AgentActivityEnvelopeV1 {
  const base = envelope("item.completed");
  const ref = {
    ...base.ref,
    itemId: "octogee:answer-commit",
    ordinal: 3,
  };
  return {
    schemaVersion: 1,
    eventKey: createHash("sha256").update(agentActivityCanonicalKey(ref)).digest("hex"),
    emittedAt: base.emittedAt,
    ref,
    redaction: base.redaction,
    type: "answer.committed",
    answer: {
      terminalOutcome: "completed",
      deliveryOutcome: "delivered",
      postIds: ["answer-1", "answer-2"],
      parts: [
        { postId: "answer-1", kind: "text", index: 0, rootPostId: "turn-1" },
        { postId: "answer-2", kind: "media", index: 1, threadId: "turn-1" },
      ],
    },
  } as unknown as AgentActivityEnvelopeV1;
}

function answerRunProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ref = answerEnvelope().ref;
  return {
    schemaVersion: 3,
    projectionKind: "run",
    conversationId: ref.conversationId,
    turnId: ref.turnId,
    runId: ref.runId,
    agentId: ref.agentId,
    sessionKey: ref.sessionKey,
    origin: ref.origin,
    mainChannelId: ref.mainChannelId,
    mainRootPostId: ref.mainRootPostId,
    inputPostId: ref.inputPostId,
    ...overrides,
  };
}

function answerPosts(): ActivityMattermostPost[] {
  return [
    answerPost({ id: "answer-1", message: "Done", props: { octogee: answerRunProps() } }),
    answerPost({ id: "answer-2", message: "", fileIds: ["file-2"] }),
  ];
}

function answerPost(
  overrides: Partial<ActivityMattermostPost> & Pick<ActivityMattermostPost, "id">,
): ActivityMattermostPost {
  return {
    channelId: "main-1",
    rootId: "turn-1",
    userId: "agent-1",
    props: {},
    fileIds: [],
    createAt: 1,
    editAt: 0,
    deleteAt: 0,
    ...overrides,
  };
}

type TestMattermostClient = ActivityMattermostClient & {
  patchStoredPost(postId: string, patch: Partial<ActivityMattermostPost>): void;
};

function mmClient(
  initialPosts: ActivityMattermostPost[] = [],
  answerCommitPatch: Partial<ActivityMattermostPost> = {},
): TestMattermostClient {
  let next = 0;
  let timestamp = 100;
  const posts = new Map<string, ActivityMattermostPost>([
    [
      "turn-1",
      { id: "turn-1", channelId: "main-1", rootId: "", userId: "builder-1", props: {}, fileIds: [] },
    ],
    ...initialPosts.map((post) => [post.id, post] as [string, ActivityMattermostPost]),
  ]);
  const client: ActivityMattermostClient = {
    createPost: vi.fn(async () => ({ id: `post-${++next}` })),
    editPost: vi.fn(async (postId, input) => {
      const current = posts.get(postId);
      if (current) posts.set(postId, { ...current, ...input });
    }),
    deletePost: vi.fn(async (postId) => {
      posts.delete(postId);
    }),
    withUserToken: vi.fn(() => client),
    createActivityPost: vi.fn(async (input) => {
      const id = `post-${++next}`;
      posts.set(id, {
        id,
        channelId: input.channelId,
        rootId: input.rootId ?? "",
        userId: "agent-1",
        message: input.message,
        props: input.props ?? {},
        fileIds: input.fileIds ?? [],
        createAt: ++timestamp,
        editAt: 0,
        deleteAt: 0,
        ...(input.message === "Answer committed" ? answerCommitPatch : {}),
      });
      return { id };
    }),
    getPost: vi.fn(async (postId) => posts.get(postId) ?? null),
    listChannelPosts: vi.fn(async () => ({ posts: [], reachedEnd: true })),
    createUploadSession: vi.fn(async () => ({ id: "upload-1", fileOffset: 0 })),
    getUploadSession: vi.fn(async () => ({ id: "upload-1", fileOffset: 0 })),
    uploadData: vi.fn(async () => ({ outcome: "complete", fileId: "file-1" })),
    getFileInfo: vi.fn(async (fileId) => ({ id: fileId, size: 8 })),
    getPostFiles: vi.fn(async () => [{ id: "file-1", size: 8 }]),
  } as TestMattermostClient;
  client.patchStoredPost = (postId, patch) => {
    const post = posts.get(postId);
    if (post) posts.set(postId, { ...post, ...patch });
  };
  return client;
}

const binding = {
  mainChannelId: "main-1",
  channelCreateAt: 100,
  defaultAgentMmUserId: "agent-1",
  attentionMention: "@builder",
};

function journalProps(
  value: AgentActivityEnvelopeV1,
  activityRootPostId?: string,
): Record<string, unknown> {
  const kind = value.type === "turn.started"
    ? "activity.run-root"
    : value.type === "item.completed" && value.ref.itemId === "activity.run-complete"
      ? "activity.run-complete"
      : value.type === "item.completed"
        ? `activity.${value.item.kind}`
        : "";
  const status = value.type === "item.completed" && value.ref.itemId === "activity.run-complete"
    ? value.item.summary.startsWith("🛑")
      ? "stopped"
      : value.item.status === "completed" ? "completed" : "failed"
    : value.type === "item.completed" && value.item.status === "waiting"
      ? "waiting"
      : value.type === "item.completed" && value.item.status === "failed"
        ? "failed"
        : "running";
  return {
    octogee: {
      schemaVersion: 3,
      projectionKind: "run",
      conversationId: value.ref.conversationId,
      turnId: value.ref.turnId,
      eventKey: value.eventKey,
      runId: value.ref.runId,
      ...(value.ref.parentRunId ? { parentRunId: value.ref.parentRunId } : {}),
      ...(value.ref.retryOfRunId ? { retryOfRunId: value.ref.retryOfRunId } : {}),
      agentId: value.ref.agentId,
      sessionKey: value.ref.sessionKey,
      origin: value.ref.origin,
      status,
      mainChannelId: value.ref.mainChannelId,
      mainRootPostId: value.ref.mainRootPostId,
      inputPostId: value.ref.inputPostId,
      itemId: value.ref.itemId,
      ordinal: value.ref.ordinal,
      semanticVersion: value.ref.semanticVersion,
      attention: "routine",
      kind,
      ...(activityRootPostId ? { activityRootPostId } : {}),
    },
  };
}

describe("attention-aware Activity sink", () => {
  it("rejects a channel-scoped turn whose exact nested human input is missing", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
    });
    const started = envelope("turn.started");
    started.ref.inputPostId = "nested-input-1";

    await expect(sink.append({ envelope: started, binding }))
      .rejects.toThrow(ActivitySinkIntegrityError);
  });

  it("accepts an exact nested human input under the bound turn root", async () => {
    const mm = mmClient([answerPost({
      id: "nested-input-1",
      rootId: "turn-1",
      userId: "builder-1",
    })]);
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
    });
    const started = envelope("turn.started");
    started.ref.inputPostId = "nested-input-1";

    await expect(sink.append({ envelope: started, binding }))
      .resolves.toMatchObject({ outcome: "persisted" });
  });

  it("writes waiting approvals as ordinary native Mattermost posts", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockResolvedValueOnce({ id: "approval-post-1" });
    const approval = envelope("item.completed", {
      item: { kind: "approval", status: "waiting", summary: "Approve deployment?" },
    });
    approval.ref.itemId = "octogee:approval:approval-1";
    approval.eventKey = createHash("sha256")
      .update(agentActivityCanonicalKey(approval.ref))
      .digest("hex");

    const result = await sink.append({ envelope: approval, binding });

    expect(mm.createActivityPost).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "main-1",
      rootId: "turn-1",
      message: "@builder Approve deployment?",
      silent: false,
      props: {
        octogee: expect.objectContaining({
          kind: "activity.approval",
          attention: "action-required",
          eventKey: approval.eventKey,
        }),
      },
    }));
    expect(mm.createActivityPost).toHaveBeenCalledWith(expect.not.objectContaining({
      props: expect.objectContaining({
        attachments: expect.anything(),
      }),
    }));
    expect(result).toMatchObject({
      outcome: "persisted",
      postIds: ["approval-post-1"],
      receipt: {
        eventKey: approval.eventKey,
        postId: "approval-post-1",
        activityRootPostId: "post-1",
      },
    });
  });

  it("creates a structured run root and writes sibling journal detail beneath the primary turn root", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    const started = envelope("turn.started");

    await expect(sink.append({ envelope: started, binding: binding })).resolves.toMatchObject({
      outcome: "persisted",
      postIds: ["post-1"],
      receipt: {
        postId: "post-1",
        activityRootPostId: "post-1",
      },
    });
    await expect(sink.append({ envelope: started, binding: binding })).resolves.toMatchObject({
      outcome: "duplicate",
      postIds: ["post-1"],
    });
    expect(mm.listChannelPosts).not.toHaveBeenCalled();
    await sink.append({ envelope: envelope("item.completed"), binding: binding });

    expect(mm.createActivityPost).toHaveBeenCalledTimes(2);
    expect(mm.getPost).toHaveBeenCalledTimes(3);
    expect(mm.createActivityPost).toHaveBeenNthCalledWith(1, expect.objectContaining({
      channelId: "main-1",
      rootId: "turn-1",
      message: "▶️ Agent run started",
      props: {
        octogee: expect.objectContaining({
          kind: "activity.run-root",
          mainRootPostId: "turn-1",
        }),
      },
      silent: true,
    }));
    expect(mm.createActivityPost).toHaveBeenNthCalledWith(2, expect.objectContaining({
      channelId: "main-1",
      rootId: "turn-1",
      props: {
        octogee: expect.objectContaining({
          kind: "activity.tool",
          activityRootPostId: "post-1",
        }),
      },
      silent: true,
    }));
  });

  it("rejects a physical thread root authored by the managed Agent Mattermost account", async () => {
    const mm = mmClient();
    vi.mocked(mm.getPost).mockResolvedValueOnce({
      id: "turn-1",
      channelId: "main-1",
      rootId: "",
      userId: binding.defaultAgentMmUserId,
      props: {},
      fileIds: [],
    });
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
    });

    await expect(sink.append({ envelope: envelope("turn.started"), binding }))
      .rejects.toThrow("main thread root failed exact Mattermost verification");
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it("rejects a physical thread root without a Mattermost author identity", async () => {
    const mm = mmClient();
    vi.mocked(mm.getPost).mockResolvedValueOnce({
      id: "turn-1",
      channelId: "main-1",
      rootId: "",
      props: {},
      fileIds: [],
    });
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
    });

    await expect(sink.append({ envelope: envelope("turn.started"), binding }))
      .rejects.toThrow("main thread root failed exact Mattermost verification");
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it("marshals exact subagent lineage as structured Mattermost props", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    const started = envelope("turn.started");
    started.ref.origin = "subagent";
    started.ref.parentRunId = "parent-run";
    started.ref.sessionKey = "agent:agent-1:subagent:child";
    started.eventKey = createHash("sha256")
      .update(agentActivityCanonicalKey(started.ref))
      .digest("hex");

    await sink.append({ envelope: started, binding });

    expect(mm.createActivityPost).toHaveBeenCalledWith(expect.objectContaining({
      message: "▶️ Agent run started",
      props: {
        octogee: expect.objectContaining({
          runId: "run-1",
          parentRunId: "parent-run",
          origin: "subagent",
        }),
      },
    }));
    expect(vi.mocked(mm.createActivityPost).mock.calls[0]?.[0].message)
      .not.toContain("subagent of");
  });

  it("rejects a replay whose Mattermost post has mismatched structured lineage", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    const started = envelope("turn.started");
    started.ref.origin = "subagent";
    started.ref.parentRunId = "parent-run";
    started.ref.sessionKey = "agent:agent-1:subagent:child";
    started.eventKey = createHash("sha256")
      .update(agentActivityCanonicalKey(started.ref))
      .digest("hex");
    await sink.append({ envelope: started, binding });
    const props = journalProps(started);
    const octogee = props.octogee as Record<string, unknown>;
    await mm.editPost("post-1", {
      message: "▶️ Agent run started",
      props: { octogee: { ...octogee, parentRunId: "foreign-parent" } },
    });

    await expect(sink.append({ envelope: started, binding }))
      .rejects.toBeInstanceOf(ActivitySinkIntegrityError);
    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
  });

  it("posts the terminal error once beneath the primary turn root without silencing it", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding: binding });
    const terminalError = envelope("item.completed", {
      item: { kind: "error", status: "failed", summary: "Agent run failed" },
    });
    terminalError.ref.itemId = "octogee:terminal-error";
    terminalError.eventKey = createHash("sha256")
      .update(agentActivityCanonicalKey(terminalError.ref))
      .digest("hex");

    await sink.append({ envelope: terminalError, binding: binding });
    await sink.append({ envelope: terminalError, binding: binding });

    expect(mm.createActivityPost).toHaveBeenCalledTimes(2);
    expect(mm.createActivityPost).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "main-1",
      rootId: "turn-1",
      message: "Agent run failed",
      silent: false,
    }));
  });

  it("recovers a structured run root after verification and before receipt commit", async () => {
    const mm = mmClient();
    const delegate = new InMemoryActivityWriteReceiptStore();
    let crashCommit = true;
    const receipts: ActivityWriteReceiptStore = {
      claim: (input) => delegate.claim(input),
      read: (eventKey) => delegate.read(eventKey),
      markPosted: (eventKey, token, postId, now) => delegate.markPosted(eventKey, token, postId, now),
      updateAttachment: (eventKey, token, attachment, now) =>
        delegate.updateAttachment(eventKey, token, attachment, now),
      async commit(eventKey, token, now) {
        if (crashCommit) throw new Error("crashed before structured root commit");
        await delegate.commit(eventKey, token, now);
      },
    };
    const started = envelope("turn.started");
    const first = createActivitySink({ mm, receipts, leaseOwner: "worker-1", now: () => 0, leaseMs: 1 });

    await expect(first.append({ envelope: started, binding: binding })).rejects.toThrow(
      "crashed before structured root commit",
    );
    await expect(delegate.read(started.eventKey)).resolves.toMatchObject({
      state: "posted",
      postId: "post-1",
    });
    crashCommit = false;
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10, leaseMs: 1 });

    await expect(sink.append({ envelope: started, binding: binding })).resolves.toMatchObject({
      outcome: "duplicate",
      postIds: ["post-1"],
    });
    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["deleted", null],
    ["wrong-channel", { id: "turn-1", channelId: "foreign-channel", rootId: "", props: {}, fileIds: [] }],
    ["thread-reply", { id: "turn-1", channelId: "main-1", rootId: "parent-1", props: {}, fileIds: [] }],
  ])("rejects a %s main root before writing a receipt", async (_case, root) => {
    const mm = mmClient();
    vi.mocked(mm.getPost).mockResolvedValue(root);
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
    });

    await expect(sink.append({ envelope: envelope("turn.started"), binding: binding }))
      .rejects.toBeInstanceOf(ActivitySinkIntegrityError);
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it("fails a committed structured-root replay after its Mattermost post is deleted", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
    });
    const started = envelope("turn.started");
    await sink.append({ envelope: started, binding: binding });
    await mm.deletePost("post-1");
    vi.mocked(mm.createActivityPost).mockClear();

    await expect(sink.append({ envelope: started, binding: binding }))
      .rejects.toBeInstanceOf(ActivitySinkIntegrityError);
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it("replays a crash after Mattermost create by scanning exactly to the stored anchor", async () => {
    const mm = mmClient();
    const receipts = new InMemoryActivityWriteReceiptStore();
    await createActivitySink({ mm, receipts, leaseOwner: "root-worker", now: () => 0 })
      .append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockClear();
    const completed = envelope("item.completed");
    const payloadDigest = activityPayloadDigest(completed);
    const claim = await receipts.claim({
      eventKey: completed.eventKey,
      payloadDigest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "crashed-worker",
      now: 0,
      leaseMs: 1,
    });
    if (claim.outcome !== "claimed") throw new Error("expected claim");
    vi.mocked(mm.listChannelPosts)
      .mockResolvedValueOnce({
        posts: [{ id: "created-before-crash", channelId: "main-1", rootId: "turn-1", props: journalProps(completed, "post-1"), fileIds: [] }],
        reachedEnd: false,
        nextBefore: "created-before-crash",
      })
      .mockResolvedValueOnce({
        posts: [{ id: "anchor-1", channelId: "main-1", rootId: "", props: {}, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "anchor-1",
      });
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

    const result = await sink.append({ envelope: completed, binding });

    expect(result).toMatchObject({ outcome: "duplicate", postIds: ["created-before-crash"] });
    expect(mm.createActivityPost).not.toHaveBeenCalled();
    expect(mm.listChannelPosts).toHaveBeenCalledTimes(1);
  });

  it("fails visibly when a recovery scan cannot find its stored anchor", async () => {
    const mm = mmClient();
    const receipts = new InMemoryActivityWriteReceiptStore();
    await createActivitySink({ mm, receipts, leaseOwner: "root-worker", now: () => 0 })
      .append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockClear();
    const completed = envelope("item.completed");
    await receipts.claim({
      eventKey: completed.eventKey,
      payloadDigest: activityPayloadDigest(completed),
      historyAnchorPostId: "deleted-anchor",
      leaseOwner: "crashed-worker",
      now: 0,
      leaseMs: 1,
    });
    vi.mocked(mm.listChannelPosts).mockResolvedValue({ posts: [], reachedEnd: true });
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

    await expect(sink.append({ envelope: completed, binding })).rejects.toBeInstanceOf(
      ActivitySinkIntegrityError,
    );
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it("pages backward without a cap until the stored anchor, then safely creates", async () => {
    const mm = mmClient();
    const receipts = new InMemoryActivityWriteReceiptStore();
    await createActivitySink({ mm, receipts, leaseOwner: "root-worker", now: () => 0 })
      .append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockClear();
    const completed = envelope("item.completed");
    await receipts.claim({
      eventKey: completed.eventKey,
      payloadDigest: activityPayloadDigest(completed),
      historyAnchorPostId: "anchor-1",
      leaseOwner: "crashed-worker",
      now: 0,
      leaseMs: 1,
    });
    vi.mocked(mm.listChannelPosts)
      .mockResolvedValueOnce({
        posts: [{ id: "newer-2", channelId: "main-1", rootId: "", props: {}, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "newer-2",
      })
      .mockResolvedValueOnce({
        posts: [{ id: "newer-1", channelId: "main-1", rootId: "", props: {}, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "newer-1",
      })
      .mockResolvedValueOnce({
        posts: [{ id: "anchor-1", channelId: "main-1", rootId: "", props: {}, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "anchor-1",
      });
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

    const result = await sink.append({ envelope: completed, binding });

    expect(result.outcome).toBe("persisted");
    expect(mm.listChannelPosts).toHaveBeenCalledTimes(3);
    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["foreign-activity", "turn-1", "foreign-post"],
    ["main-1", "foreign-root", "foreign-post"],
    ["main-1", "turn-1", "different-returned-post"],
  ])("rejects a recovered receipt post outside its exact channel/root/id (%s, %s, %s)", async (
    channelId,
    rootId,
    returnedPostId,
  ) => {
    const mm = mmClient();
    const receipts = new InMemoryActivityWriteReceiptStore();
    const started = envelope("turn.started");
    const claim = await receipts.claim({
      eventKey: started.eventKey,
      payloadDigest: activityPayloadDigest(started),
      historyAnchorPostId: "anchor-1",
      leaseOwner: "crashed-worker",
      now: 0,
      leaseMs: 1,
    });
    if (claim.outcome !== "claimed") throw new Error("expected claim");
    await receipts.markPosted(started.eventKey, claim.receipt.leaseToken, "foreign-post", 0);
    vi.mocked(mm.getPost).mockImplementation(async (postId) => postId === "turn-1"
      ? { id: "turn-1", channelId: "main-1", rootId: "", props: {}, fileIds: [] }
      : {
          id: returnedPostId,
          channelId,
          rootId,
          props: journalProps(started),
          fileIds: [],
        });
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

    await expect(sink.append({ envelope: started, binding })).rejects.toBeInstanceOf(
      ActivitySinkIntegrityError,
    );
  });

  it("redacts inline detail again before persistence", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding });
    const completed = envelope("item.completed", {
      item: {
        kind: "tool",
        status: "completed",
        summary: "Used sk-proj-1234567890abcdefghijklmnop",
        detail: { format: "text", text: "Bearer secret-token-1234567890" },
      },
    });

    await sink.append({ envelope: completed, binding });

    expect(mm.createActivityPost).toHaveBeenLastCalledWith(expect.objectContaining({
      message: expect.not.stringContaining("secret-token"),
    }));
  });

  it.each(["session-created", "uploading"] as const)(
    "resumes from a durable %s upload receipt without creating a second session",
    async (state) => {
      const mm = mmClient();
      const receipts = new InMemoryActivityWriteReceiptStore();
      const initial = createActivitySink({ mm, receipts, leaseOwner: "worker-1", now: () => 0, leaseMs: 1 });
      await initial.append({ envelope: envelope("turn.started"), binding });
      const bytes = Buffer.from("12345678");
      const completed = envelope("item.completed", {
        item: {
          kind: "tool",
          status: "completed",
          summary: "Large output",
          attachment: {
            filename: "tool.txt",
            mediaType: "text/plain",
            byteLength: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            multipartField: "detail",
          },
        },
      });
      const claim = await receipts.claim({
        eventKey: completed.eventKey,
        payloadDigest: activityPayloadDigest(completed, bytes),
        historyAnchorPostId: "anchor-1",
        leaseOwner: "crashed-worker",
        now: 0,
        leaseMs: 1,
      });
      if (claim.outcome !== "claimed") throw new Error("expected claim");
      await receipts.updateAttachment(completed.eventKey, claim.receipt.leaseToken, {
        state,
        uploadId: "upload-1",
        fileOffset: state === "session-created" ? 0 : 2,
        filename: "tool.txt",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
      }, 0);
      vi.mocked(mm.getUploadSession).mockResolvedValue({ id: "upload-1", fileOffset: 4 });
      vi.mocked(mm.uploadData).mockResolvedValue({ outcome: "complete", fileId: "file-1" });
      vi.mocked(mm.getFileInfo).mockResolvedValue({ id: "file-1", size: 8 });
      vi.mocked(mm.getPostFiles).mockResolvedValue([{ id: "file-1", size: 8 }]);
      vi.mocked(mm.listChannelPosts).mockResolvedValue({
        posts: [{ id: "anchor-1", channelId: "main-1", rootId: "", props: {}, fileIds: [] }],
        reachedEnd: false,
        nextBefore: "anchor-1",
      });
      const recovered = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10 });

      await recovered.append({ envelope: completed, attachment: bytes, binding });

      expect(mm.createUploadSession).not.toHaveBeenCalled();
      const uploaded = vi.mocked(mm.uploadData).mock.calls[0][1];
      expect(Buffer.from(uploaded).toString("utf8")).toBe("5678");
    },
  );

  it("attaches large detail once and records a lost final response without reuploading", async () => {
    const mm = mmClient();
    vi.mocked(mm.uploadData).mockRejectedValueOnce(new Error("connection reset after final byte"));
    vi.mocked(mm.getUploadSession).mockResolvedValueOnce(null);
    const receipts = new InMemoryActivityWriteReceiptStore();
    const alerts = { attachmentUnknown: vi.fn(), integrityFailure: vi.fn() };
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-1", now: () => 1_000, alerts });
    await sink.append({ envelope: envelope("turn.started"), binding });
    const bytes = Buffer.from("redacted output");
    const completed = envelope("item.completed", {
      item: {
        kind: "tool",
        status: "completed",
        summary: "Large output",
        attachment: {
          filename: "tool.txt",
          mediaType: "text/plain",
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          multipartField: "detail",
        },
      },
    });

    const first = await sink.append({ envelope: completed, attachment: bytes, binding });
    const replay = await sink.append({ envelope: completed, attachment: bytes, binding });

    expect(first.outcome).toBe("persisted");
    expect(replay.outcome).toBe("duplicate");
    expect(mm.createUploadSession).toHaveBeenCalledTimes(1);
    expect(mm.uploadData).toHaveBeenCalledTimes(1);
    expect(alerts.attachmentUnknown).toHaveBeenCalledTimes(1);
    expect(mm.createActivityPost).toHaveBeenLastCalledWith(expect.objectContaining({
      fileIds: undefined,
      message: expect.stringContaining("attachment unavailable"),
    }));
  });

  it("re-runs redaction over a bounded attachment source before any Mattermost upload", async () => {
    const mm = mmClient();
    vi.mocked(mm.uploadData).mockRejectedValueOnce(new Error("lost final response"));
    vi.mocked(mm.getUploadSession).mockResolvedValueOnce(null);
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding });
    const bytes = new TextEncoder().encode(
      `tool output Bearer secret-token-${"1".repeat(80)} trailing text`,
    );
    const readLengths: number[] = [];
    const source = {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      async read(offset: number, length: number) {
        readLengths.push(length);
        return bytes.slice(offset, Math.min(offset + length, bytes.byteLength));
      },
    };
    const completed = envelope("item.completed", {
      item: {
        kind: "tool",
        status: "completed",
        summary: "Large output",
        attachment: {
          filename: "tool.txt",
          mediaType: "text/plain",
          byteLength: source.byteLength,
          sha256: source.sha256,
          multipartField: "detail",
        },
      },
    });

    await sink.append({ envelope: completed, attachment: source, binding });

    const uploadedBytes = vi.mocked(mm.uploadData).mock.calls[0][1];
    expect(new TextDecoder().decode(uploadedBytes)).toBe(
      "[redacted: attachment contained secret material]",
    );
    expect(Math.max(...readLengths)).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(mm.createActivityPost).toHaveBeenLastCalledWith(expect.objectContaining({
      message: expect.not.stringContaining("secret-token"),
    }));
  });

  it("rejects invalid UTF-8 attachment detail deterministically before upload", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding });
    const bytes = Uint8Array.from([0xc3, 0x28]);
    const completed = envelope("item.completed", {
      item: {
        kind: "tool",
        status: "completed",
        summary: "Invalid detail",
        attachment: {
          filename: "tool.txt",
          mediaType: "text/plain",
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          multipartField: "detail",
        },
      },
    });

    await expect(sink.append({ envelope: completed, attachment: bytes, binding }))
      .rejects.toBeInstanceOf(ActivitySinkInvalidAttachmentError);
    expect(mm.createUploadSession).not.toHaveBeenCalled();
  });

  it("continues UTF-8 validation after detecting a secret and still rejects malformed trailing bytes", async () => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
      now: () => 1_000,
    });
    await sink.append({ envelope: envelope("turn.started"), binding });
    const prefix = new TextEncoder().encode("Bearer secret-token-12345678901234567890 trailing");
    const bytes = Uint8Array.from([...prefix, 0xc3, 0x28]);
    const source = {
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      async read(offset: number) {
        return bytes.slice(offset, Math.min(offset + 8, bytes.byteLength));
      },
    };
    const completed = envelope("item.completed", {
      item: {
        kind: "tool",
        status: "completed",
        summary: "Invalid secret detail",
        attachment: {
          filename: "tool.txt",
          mediaType: "text/plain",
          byteLength: bytes.byteLength,
          sha256: source.sha256,
          multipartField: "detail",
        },
      },
    });

    await expect(sink.append({ envelope: completed, attachment: source, binding }))
      .rejects.toBeInstanceOf(ActivitySinkInvalidAttachmentError);
    expect(mm.createUploadSession).not.toHaveBeenCalled();
  });

  it("recovers a crash after post attachment without another post or physical upload", async () => {
    const mm = mmClient();
    const delegate = new InMemoryActivityWriteReceiptStore();
    let crashCommit = false;
    const receipts: ActivityWriteReceiptStore = {
      claim: (input) => delegate.claim(input),
      read: (eventKey) => delegate.read(eventKey),
      markPosted: (eventKey, token, postId, now) => delegate.markPosted(eventKey, token, postId, now),
      updateAttachment: (eventKey, token, attachment, now) =>
        delegate.updateAttachment(eventKey, token, attachment, now),
      async commit(eventKey, token, now) {
        if (crashCommit) {
          crashCommit = false;
          throw new Error("process crashed before commit");
        }
        await delegate.commit(eventKey, token, now);
      },
    };
    const bytes = Buffer.from("12345678");
    vi.mocked(mm.getFileInfo).mockResolvedValue({ id: "file-1", size: 8 });
    vi.mocked(mm.getPostFiles).mockResolvedValue([{ id: "file-1", size: 8 }]);
    const first = createActivitySink({ mm, receipts, leaseOwner: "worker-1", now: () => 0, leaseMs: 1 });
    await first.append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockClear();
    const completed = envelope("item.completed", {
      item: {
        kind: "tool",
        status: "completed",
        summary: "Large output",
        attachment: {
          filename: "tool.txt",
          mediaType: "text/plain",
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          multipartField: "detail",
        },
      },
    });
    crashCommit = true;
    await expect(first.append({ envelope: completed, attachment: bytes, binding })).rejects.toThrow(
      "process crashed before commit",
    );
    const posted = await delegate.read(completed.eventKey);
    if (!posted?.postId) throw new Error("expected posted receipt");
    vi.mocked(mm.getPost).mockResolvedValue({
      id: posted.postId,
      channelId: "main-1",
      rootId: "turn-1",
      props: journalProps(completed, "post-1"),
      fileIds: ["file-1"],
    });
    const recovered = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10, leaseMs: 1 });

    const result = await recovered.append({ envelope: completed, attachment: bytes, binding });

    expect(result).toMatchObject({ outcome: "duplicate", postIds: [posted.postId] });
    expect(mm.createUploadSession).toHaveBeenCalledTimes(1);
    expect(mm.uploadData).toHaveBeenCalledTimes(1);
    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["completed", "✅ Run completed", "completed"],
    ["failed", "❌ Run failed", "failed"],
    ["failed", "🛑 Run stopped", "stopped"],
  ] as const)("projects a terminal %s checkpoint with %s status", async (
    itemStatus,
    message,
    projectedStatus,
  ) => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
    });
    await sink.append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockClear();
    const completion = envelope("item.completed", {
      item: { kind: "checkpoint", status: itemStatus, summary: message },
    });
    completion.ref.itemId = "activity.run-complete";
    completion.eventKey = createHash("sha256")
      .update(agentActivityCanonicalKey(completion.ref))
      .digest("hex");

    const result = await sink.append({ envelope: completion, binding });

    expect(result.receipt.activityRootPostId).toBe("post-1");
    expect(mm.createActivityPost).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "main-1",
      rootId: "turn-1",
      message,
      props: {
        octogee: expect.objectContaining({
          kind: "activity.run-complete",
          status: projectedStatus,
          activityRootPostId: "post-1",
        }),
      },
    }));
  });

  it("finalization commits an empty post list and never duplicates the final answer", async () => {
    const mm = mmClient(answerPosts());
    const sink = createActivitySink({ mm, receipts: new InMemoryActivityWriteReceiptStore(), leaseOwner: "worker-1" });
    await sink.append({ envelope: envelope("turn.started"), binding });
    await sink.append({ envelope: answerEnvelope(), binding });
    vi.mocked(mm.createActivityPost).mockClear();
    const result = await sink.append({ envelope: envelope("turn.finalized"), binding });

    expect(result).toMatchObject({ outcome: "persisted", postIds: [] });
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it.each([
    ["direct", "agent:agent-1:mattermost:direct:owner-1:thread:turn-1", "human", undefined],
    ["subagent", "agent:agent-1:subagent:child-1", "subagent", "parent-run"],
  ] as const)("finalizes a %s Activity run without a channel answer commit", async (
    _kind,
    sessionKey,
    origin,
    parentRunId,
  ) => {
    const mm = mmClient();
    const sink = createActivitySink({
      mm,
      receipts: new InMemoryActivityWriteReceiptStore(),
      leaseOwner: "worker-1",
    });
    const started = envelope("turn.started");
    started.ref.sessionKey = sessionKey;
    started.ref.origin = origin;
    delete started.ref.inputPostId;
    if (parentRunId) started.ref.parentRunId = parentRunId;
    started.eventKey = createHash("sha256")
      .update(agentActivityCanonicalKey(started.ref))
      .digest("hex");
    const finalized = envelope("turn.finalized");
    finalized.ref.sessionKey = sessionKey;
    finalized.ref.origin = origin;
    delete finalized.ref.inputPostId;
    if (parentRunId) finalized.ref.parentRunId = parentRunId;
    finalized.eventKey = createHash("sha256")
      .update(agentActivityCanonicalKey(finalized.ref))
      .digest("hex");

    await sink.append({ envelope: started, binding });
    vi.mocked(mm.createActivityPost).mockClear();
    await expect(sink.append({ envelope: finalized, binding })).resolves.toMatchObject({
      outcome: "persisted",
      postIds: [],
    });
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it("verifies every answer part and persists one silent immutable commit marker", async () => {
    const mm = mmClient(answerPosts());
    const receipts = new InMemoryActivityWriteReceiptStore();
    const sink = createActivitySink({ mm, receipts, leaseOwner: "worker-1" });
    await sink.append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockClear();
    const committed = answerEnvelope();

    const first = await sink.append({ envelope: committed, binding });
    const replay = await sink.append({ envelope: committed, binding });

    expect(first).toMatchObject({ outcome: "persisted", postIds: ["post-2"] });
    expect(replay).toMatchObject({ outcome: "duplicate", postIds: ["post-2"] });
    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
    expect(mm.createActivityPost).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "main-1",
      rootId: "turn-1",
      silent: true,
      props: {
        octogee: expect.objectContaining({
          status: "completed",
          itemId: "octogee:answer-commit",
          kind: "agent.answer-commit",
          answer: (committed as unknown as { answer: unknown }).answer,
        }),
      },
    }));
  });

  it("rejects an answer part edited after the newly created commit marker", async () => {
    const posts = answerPosts();
    posts[0] = { ...posts[0]!, editAt: 10_000 };
    const mm = mmClient(posts);
    const sink = createActivitySink({ mm, receipts: new InMemoryActivityWriteReceiptStore(), leaseOwner: "worker-1" });
    await sink.append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockClear();

    await expect(sink.append({ envelope: answerEnvelope(), binding }))
      .rejects.toBeInstanceOf(ActivitySinkIntegrityError);
    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["edited", { editAt: 1 }],
    ["deleted", { deleteAt: 1 }],
    ["wrong-message", { message: "Not an answer commit" }],
    ["attached", { fileIds: ["file-1"] }],
  ])("rejects an %s newly created answer-commit marker", async (_case, markerPatch) => {
    const mm = mmClient(answerPosts(), markerPatch);
    const sink = createActivitySink({ mm, receipts: new InMemoryActivityWriteReceiptStore(), leaseOwner: "worker-1" });
    await sink.append({ envelope: envelope("turn.started"), binding });

    await expect(sink.append({ envelope: answerEnvelope(), binding }))
      .rejects.toBeInstanceOf(ActivitySinkIntegrityError);
  });

  it("recovers an answer commit crash after marker creation without posting twice", async () => {
    const mm = mmClient(answerPosts());
    const delegate = new InMemoryActivityWriteReceiptStore();
    const committed = answerEnvelope();
    let crashCommit = false;
    const receipts: ActivityWriteReceiptStore = {
      claim: (input) => delegate.claim(input),
      read: (eventKey) => delegate.read(eventKey),
      markPosted: (eventKey, token, postId, now) => delegate.markPosted(eventKey, token, postId, now),
      updateAttachment: (eventKey, token, attachment, now) =>
        delegate.updateAttachment(eventKey, token, attachment, now),
      async commit(eventKey, token, now) {
        if (crashCommit && eventKey === committed.eventKey) {
          crashCommit = false;
          throw new Error("crashed before answer commit receipt");
        }
        await delegate.commit(eventKey, token, now);
      },
    };
    const first = createActivitySink({ mm, receipts, leaseOwner: "worker-1", now: () => 0, leaseMs: 1 });
    await first.append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockClear();
    crashCommit = true;
    await expect(first.append({ envelope: committed, binding }))
      .rejects.toThrow("crashed before answer commit receipt");
    await expect(delegate.read(committed.eventKey)).resolves.toMatchObject({
      state: "posted",
      postId: "post-2",
    });

    const recovered = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10, leaseMs: 1 });
    await expect(recovered.append({ envelope: committed, binding })).resolves.toMatchObject({
      outcome: "duplicate",
      postIds: ["post-2"],
    });
    expect(mm.createActivityPost).toHaveBeenCalledTimes(1);
  });

  it("refuses to finalize until the answer commit marker is durably persisted", async () => {
    const mm = mmClient();
    const sink = createActivitySink({ mm, receipts: new InMemoryActivityWriteReceiptStore(), leaseOwner: "worker-1" });
    await sink.append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockClear();

    await expect(sink.append({ envelope: envelope("turn.finalized"), binding }))
      .rejects.toThrow("answer commit is not durably persisted");
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["foreign-author", answerPost({ id: "answer-1", userId: "builder-1" })],
    ["foreign-channel", answerPost({ id: "answer-1", channelId: "other" })],
    ["foreign-root", answerPost({ id: "answer-1", rootId: "other" })],
    ["missing-revision", { ...answerPost({ id: "answer-1" }), createAt: undefined }],
    ["deleted", answerPost({ id: "answer-1", deleteAt: 2 })],
    ["mismatched-run", answerPost({
      id: "answer-1",
      props: { octogee: answerRunProps({ runId: "other-run" }) },
    })],
    ["semantic-activity", answerPost({
      id: "answer-1",
      props: { octogee: answerRunProps({ itemId: "tool-1", kind: "activity.tool" }) },
    })],
    ["semantic-tool", answerPost({
      id: "answer-1",
      props: { octogee: answerRunProps({ toolCallId: "call-1" }) },
    })],
  ])("rejects a %s sealed answer part before writing the commit marker", async (_case, badPart) => {
    const second = answerPost({ id: "answer-2" });
    const mm = mmClient([...(badPart ? [badPart] : []), second] as ActivityMattermostPost[]);
    const sink = createActivitySink({ mm, receipts: new InMemoryActivityWriteReceiptStore(), leaseOwner: "worker-1" });
    await sink.append({ envelope: envelope("turn.started"), binding });
    vi.mocked(mm.createActivityPost).mockClear();

    await expect(sink.append({ envelope: answerEnvelope(), binding }))
      .rejects.toBeInstanceOf(ActivitySinkIntegrityError);
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });

  it.each([
    ["answer part edit", "answer-1", { editAt: 10_000 }],
    ["answer part deletion", "answer-1", { deleteAt: 10_000 }],
    ["commit marker edit", "post-2", { editAt: 10_000 }],
    ["commit marker deletion", "post-2", { deleteAt: 10_000 }],
  ])("rejects finalization after an %s", async (_case, postId, patch) => {
    const mm = mmClient(answerPosts());
    const sink = createActivitySink({ mm, receipts: new InMemoryActivityWriteReceiptStore(), leaseOwner: "worker-1" });
    await sink.append({ envelope: envelope("turn.started"), binding });
    await sink.append({ envelope: answerEnvelope(), binding });
    mm.patchStoredPost(postId, patch);

    await expect(sink.append({ envelope: envelope("turn.finalized"), binding }))
      .rejects.toBeInstanceOf(ActivitySinkIntegrityError);
  });

  it("replays an uncommitted finalization without searching for a Mattermost post", async () => {
    const mm = mmClient(answerPosts());
    const delegate = new InMemoryActivityWriteReceiptStore();
    let crashCommit = false;
    const receipts: ActivityWriteReceiptStore = {
      claim: (input) => delegate.claim(input),
      read: (eventKey) => delegate.read(eventKey),
      markPosted: (eventKey, token, postId, now) => delegate.markPosted(eventKey, token, postId, now),
      updateAttachment: (eventKey, token, attachment, now) =>
        delegate.updateAttachment(eventKey, token, attachment, now),
      async commit(eventKey, token, now) {
        if (crashCommit) throw new Error("crashed before finalization commit");
        await delegate.commit(eventKey, token, now);
      },
    };
    const first = createActivitySink({ mm, receipts, leaseOwner: "worker-1", now: () => 0, leaseMs: 1 });
    await first.append({ envelope: envelope("turn.started"), binding });
    await first.append({ envelope: answerEnvelope(), binding });
    const finalized = envelope("turn.finalized");
    crashCommit = true;
    await expect(first.append({ envelope: finalized, binding })).rejects.toThrow(
      "crashed before finalization commit",
    );
    crashCommit = false;
    vi.mocked(mm.listChannelPosts).mockClear();
    vi.mocked(mm.createActivityPost).mockClear();
    const recovered = createActivitySink({ mm, receipts, leaseOwner: "worker-2", now: () => 10, leaseMs: 1 });

    await expect(recovered.append({ envelope: finalized, binding })).resolves.toMatchObject({
      outcome: "persisted",
      postIds: [],
    });
    expect(mm.listChannelPosts).not.toHaveBeenCalled();
    expect(mm.createActivityPost).not.toHaveBeenCalled();
  });
});
