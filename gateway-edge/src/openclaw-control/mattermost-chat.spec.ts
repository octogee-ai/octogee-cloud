import { describe, expect, it, vi } from "vitest";

import type { AuthorizedChannel } from "../lib/channel-session-authorization.js";
import type { MattermostModelPost } from "../lib/channel-session-model-control.js";
import {
  createMattermostControlChat,
  projectMattermostControlMessages,
} from "./mattermost-chat.js";
import type { OpenClawControlSession } from "./session.js";
import { logger } from "@octogee/core/http/logging";

const channelId = "c".repeat(26);
const humanId = "h".repeat(26);
const agentMmUserId = "a".repeat(26);
const rootId = "r".repeat(26);
const answerId = "n".repeat(26);
const commitId = "m".repeat(26);
const followupId = "f".repeat(26);
const secondAnswerId = "v".repeat(26);
const secondCommitId = "w".repeat(26);
const secondChannelId = "s".repeat(26);
const deniedChannelId = "d".repeat(26);
const agentId = "octogee-alice-coach";
const sessionKey = `agent:${agentId}:mattermost:group:${channelId}`;
const secondSessionKey = `agent:${agentId}:mattermost:group:${secondChannelId}`;
const deniedSessionKey = `agent:${agentId}:mattermost:group:${deniedChannelId}`;

function runProps(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    projectionKind: "run",
    conversationId: channelId,
    turnId: rootId,
    runId: rootId,
    agentId,
    sessionKey,
    origin: "human",
    status: "completed",
    mainChannelId: channelId,
    mainRootPostId: rootId,
    inputPostId: rootId,
    attention: "routine",
    ...extra,
  };
}

function post(input: Partial<MattermostModelPost> & Pick<MattermostModelPost, "id">): MattermostModelPost {
  return {
    type: "",
    root_id: "",
    channel_id: channelId,
    user_id: humanId,
    create_at: 1,
    update_at: 1,
    edit_at: 0,
    delete_at: 0,
    message: "",
    pending_post_id: "",
    file_ids: [],
    props: {},
    ...input,
    id: input.id,
  };
}

function committedPosts(): MattermostModelPost[] {
  return [
    post({
      id: commitId,
      root_id: rootId,
      user_id: agentMmUserId,
      create_at: 4,
      message: "Answer committed",
      pending_post_id: "answer-commit-write",
      props: {
        octogee: runProps({
          itemId: "octogee:answer-commit",
          ordinal: 4,
          semanticVersion: 1,
          kind: "agent.answer-commit",
          answer: {
            terminalOutcome: "completed",
            deliveryOutcome: "delivered",
            postIds: [answerId],
            parts: [{ postId: answerId, kind: "text", index: 0, rootPostId: rootId }],
          },
        }),
      },
    }),
    post({
      id: "p".repeat(26),
      root_id: rootId,
      user_id: agentMmUserId,
      create_at: 2,
      message: "Working through it",
      props: { octogee: runProps({ kind: "activity.commentary", itemId: "commentary-1" }) },
    }),
    post({
      id: answerId,
      root_id: rootId,
      user_id: agentMmUserId,
      create_at: 3,
      message: "The durable answer",
      pending_post_id: "native-delivery-write",
      props: { octogee: runProps() },
    }),
    post({ id: rootId, message: "Please investigate", create_at: 1 }),
  ];
}

function session(): OpenClawControlSession {
  return {
    sessionId: "browser-session",
    uid: "uid-owner",
    gatewayId: "walter",
    workspaceSlug: "alice",
    revisionId: "walter-r7",



    idleExpiresAt: 10_000,
    absoluteExpiresAt: 20_000,
  };
}

function authorized(client: Record<string, unknown>): AuthorizedChannel {
  return {
    forbidden: false,
    target: {
      ownerUid: "uid-owner",
      workspaceSlug: "alice",
      agentId,
      agentMmUserId,
    },
    callerMmUserId: humanId,
    client: {
      getJson: async () => ({
        id: channelId,
        team_id: "t".repeat(26),
        type: "P",
        name: "alice-general",
        display_name: "General",
        create_at: 1,
        update_at: 1,
        delete_at: 0,
        last_post_at: 1,
      }),
      ...client,
    } as unknown as AuthorizedChannel["client"],
  };
}

describe("Mattermost-backed OpenClaw Control chat", () => {
  it("shows native top-level and threaded bot replies without Activity metadata", () => {
    const messages = projectMattermostControlMessages({
      posts: [
        post({ id: rootId, message: "Native question" }),
        post({ id: answerId, user_id: agentMmUserId, message: "Native flat reply", create_at: 2 }),
        post({ id: secondAnswerId, root_id: rootId, user_id: agentMmUserId, message: "Native threaded reply", create_at: 3 }),
        post({ id: commitId, channel_id: secondChannelId, user_id: agentMmUserId, message: "Another channel", create_at: 4 }),
      ], channelId, agentId, agentMmUserId,
    });
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", [{ type: "text", text: "Native question" }]],
      ["assistant", [{ type: "text", text: "Native flat reply" }]],
      ["assistant", [{ type: "text", text: "Native threaded reply" }]],
    ]);
  });

  it("keeps a native discussion rooted in a top-level bot reply visible", () => {
    const messages = projectMattermostControlMessages({
      posts: [
        post({ id: answerId, user_id: agentMmUserId, message: "Native answer" }),
        post({ id: followupId, root_id: answerId, message: "Follow-up question", create_at: 2 }),
        post({ id: secondAnswerId, root_id: answerId, user_id: agentMmUserId, message: "Follow-up answer", create_at: 3 }),
      ], channelId, agentId, agentMmUserId,
    });
    expect(messages.map((message) => message.__openclaw.id)).toEqual([answerId, followupId, secondAnswerId]);
  });

  it("projects only human roots and exactly committed answer parts", () => {
    const messages = projectMattermostControlMessages({
      posts: committedPosts(),
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => ({
      role: message.role,
      text: message.content[0]?.text,
      id: message.__openclaw.id,
      runId: message.__openclaw.runId,
    }))).toEqual([
      { role: "user", text: "Please investigate", id: rootId, runId: rootId },
      { role: "assistant", text: "The durable answer", id: commitId, runId: rootId },
    ]);
    expect(JSON.stringify(messages)).not.toContain("Working through it");
    expect(messages[0]?.__openclaw.idempotencyKey).toBe(`${rootId}:user`);
  });

  it("orders a recovered answer by its last delivered part instead of its later commit marker", () => {
    const followup = post({
      id: followupId,
      root_id: rootId,
      create_at: 4,
      message: "I saw the answer; one follow-up",
    });
    const messages = projectMattermostControlMessages({
      posts: [
        ...committedPosts().map((entry) => entry.id === commitId
          ? post({ ...entry, create_at: 5 })
          : entry),
        followup,
      ],
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => ({
      id: message.__openclaw.id,
      timestamp: message.timestamp,
    }))).toEqual([
      { id: rootId, timestamp: 1 },
      { id: commitId, timestamp: 3 },
      { id: followupId, timestamp: 4 },
    ]);
  });

  it("keeps a partial answer and its unresolved commit marker as raw evidence", () => {
    const messages = projectMattermostControlMessages({
      posts: [
        ...committedPosts().map((entry) => entry.id === commitId
          ? post({
              ...entry,
              create_at: 5,
              props: {
                octogee: runProps({
                  itemId: "octogee:answer-commit",
                  ordinal: 4,
                  semanticVersion: 1,
                  kind: "agent.answer-commit",
                  answer: {
                    terminalOutcome: "completed",
                    deliveryOutcome: "partial",
                    postIds: [answerId],
                    parts: [{ postId: answerId, kind: "text", index: 0, rootPostId: rootId }],
                  },
                }),
              },
            })
          : entry),
        post({
          id: followupId,
          root_id: rootId,
          create_at: 4,
          message: "Continue after the partial answer",
        }),
      ],
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => ({
      id: message.__openclaw.id,
      timestamp: message.timestamp,
    }))).toEqual([
      { id: rootId, timestamp: 1 },
      { id: answerId, timestamp: 3 },
      { id: followupId, timestamp: 4 },
      { id: commitId, timestamp: 5 },
    ]);
  });

  it.each([
    ["failed", "failed"],
    ["suppressed", "completed"],
    ["not-attempted", "failed"],
  ] as const)("does not invent an answer for a zero-part %s delivery", (deliveryOutcome, status) => {
    const messages = projectMattermostControlMessages({
      posts: committedPosts()
        .filter((entry) => entry.id !== answerId)
        .map((entry) => entry.id === commitId
          ? post({
              ...entry,
              props: {
                octogee: runProps({
                  status,
                  itemId: "octogee:answer-commit",
                  ordinal: 4,
                  semanticVersion: 1,
                  kind: "agent.answer-commit",
                  answer: {
                    terminalOutcome: status,
                    deliveryOutcome,
                    postIds: [],
                    parts: [],
                  },
                }),
              },
            })
          : entry),
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => message.__openclaw.id)).toEqual([rootId]);
  });

  it("reuses a durable Control send identity and ignores Mattermost system posts", () => {
    const systemRootId = "j".repeat(26);
    const systemReplyId = "k".repeat(26);
    const messages = projectMattermostControlMessages({
      posts: [
        ...committedPosts().map((entry) => entry.id === rootId
          ? post({ ...entry, pending_post_id: "control-run-1" })
          : entry),
        post({
          id: systemRootId,
          type: "system_join_channel",
          message: "human joined the channel",
          create_at: 5,
        }),
        post({
          id: systemReplyId,
          type: "system_add_to_channel",
          root_id: rootId,
          message: "human was added",
          create_at: 6,
        }),
      ],
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => message.__openclaw.id)).toEqual([rootId, commitId]);
    expect(messages[0]?.__openclaw.idempotencyKey).toBe("control-run-1");
    expect(messages[0]?.__openclaw.runId).toBe("control-run-1");
    expect(JSON.stringify(messages)).not.toContain("joined");
    expect(JSON.stringify(messages)).not.toContain("was added");
  });

  it("keeps attachment evidence visible for Mattermost-authored transcript posts", () => {
    const messages = projectMattermostControlMessages({
      posts: committedPosts().map((entry) => entry.id === rootId
        ? post({ ...entry, message: "", file_ids: ["x".repeat(26)] })
        : entry.id === answerId
          ? post({ ...entry, file_ids: ["y".repeat(26)] })
          : entry),
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => message.content[0]?.text)).toEqual([
      "[attachment]",
      "The durable answer\n\n[text attachment]",
    ]);
  });

  it("accepts absent answer metadata and pre-commit edits without treating update_at as an edit", () => {
    const messages = projectMattermostControlMessages({
      posts: committedPosts().map((entry) => {
        if (entry.id === answerId) {
          return post({
            ...entry,
            update_at: 100,
            edit_at: 4,
            props: {},
          });
        }
        return entry.id === commitId
          ? post({ ...entry, update_at: 101 })
          : entry;
      }),
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => message.__openclaw.id)).toEqual([rootId, commitId]);
  });

  it("fails sealed projection closed when required post revision evidence is absent", () => {
    const missingCommitEdit = committedPosts().map((entry) => entry.id === commitId
      ? post({ ...entry, edit_at: undefined })
      : entry);
    const missingAnswerEdit = committedPosts().map((entry) => entry.id === answerId
      ? post({ ...entry, edit_at: undefined })
      : entry);

    expect(projectMattermostControlMessages({
      posts: missingCommitEdit,
      channelId,
      agentId,
      agentMmUserId,
    }).map((message) => message.__openclaw.id)).toEqual([rootId, answerId]);
    expect(projectMattermostControlMessages({
      posts: missingAnswerEdit,
      channelId,
      agentId,
      agentMmUserId,
    }).map((message) => message.__openclaw.id)).toEqual([rootId, commitId]);
  });

  it("keeps unsealed or mismatched answer posts visible without promoting them", () => {
    const withoutCommit = committedPosts().filter((entry) => entry.id !== commitId);
    const mismatched = committedPosts().map((entry) => entry.id === answerId
      ? post({ ...entry, props: { octogee: runProps({ runId: "other-run" }) } })
      : entry);

    const withoutCommitMessages = projectMattermostControlMessages({
      posts: withoutCommit,
      channelId,
      agentId,
      agentMmUserId,
    });
    const mismatchedMessages = projectMattermostControlMessages({
      posts: mismatched,
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(withoutCommitMessages.map((message) => message.__openclaw.id)).toEqual([
      rootId,
      answerId,
    ]);
    expect(mismatchedMessages.map((message) => message.__openclaw.id)).toEqual([
      rootId,
      answerId,
      commitId,
    ]);
  });

  it("never exposes Activity or tool semantics as raw assistant answers", () => {
    const activityId = "p".repeat(26);
    const toolId = "t".repeat(26);
    const messages = projectMattermostControlMessages({
      posts: [
        ...committedPosts()
          .filter((entry) => entry.id !== commitId)
          .map((entry) => entry.id === activityId
            ? post({ ...entry, message: "Answer committed" })
            : entry),
        post({
          id: toolId,
          root_id: rootId,
          user_id: agentMmUserId,
          create_at: 3,
          message: "Answer committed",
          props: { octogee: runProps({ toolCallId: "tool-1" }) },
        }),
      ],
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => message.__openclaw.id)).toEqual([rootId, answerId]);
  });

  it("keeps a legacy assistant reply whose literal text is Answer committed", () => {
    const legacyReplyId = "i".repeat(26);
    const messages = projectMattermostControlMessages({
      posts: [
        ...committedPosts().filter((entry) => entry.id !== commitId),
        post({
          id: legacyReplyId,
          root_id: rootId,
          user_id: agentMmUserId,
          create_at: 4,
          message: "Answer committed",
        }),
      ],
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => ({
      id: message.__openclaw.id,
      text: message.content[0]?.text,
    }))).toContainEqual({ id: legacyReplyId, text: "Answer committed" });
  });

  it("keeps malformed structured commit marker evidence in raw history", () => {
    const messages = projectMattermostControlMessages({
      posts: committedPosts().map((entry) => entry.id === commitId
        ? post({
            ...entry,
            message: "Malformed answer commit",
          })
        : entry),
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => ({
      id: message.__openclaw.id,
      text: message.content[0]?.text,
    }))).toContainEqual({ id: commitId, text: "Malformed answer commit" });
  });

  it("keeps nested human inputs and one sealed answer for each distinct input", () => {
    const secondRunId = "followup-run-2";
    const messages = projectMattermostControlMessages({
      posts: [
        ...committedPosts(),
        post({
          id: followupId,
          root_id: rootId,
          create_at: 5,
          message: "Also check the retry path",
        }),
        post({
          id: secondAnswerId,
          root_id: rootId,
          user_id: agentMmUserId,
          create_at: 6,
          message: "The latest durable answer",
          props: { octogee: runProps({ runId: secondRunId, inputPostId: followupId }) },
        }),
        post({
          id: secondCommitId,
          root_id: rootId,
          user_id: agentMmUserId,
          create_at: 7,
          message: "Answer committed",
          props: {
            octogee: runProps({
              runId: secondRunId,
              inputPostId: followupId,
              itemId: "octogee:answer-commit",
              ordinal: 7,
              semanticVersion: 1,
              kind: "agent.answer-commit",
              answer: {
                terminalOutcome: "completed",
                deliveryOutcome: "delivered",
                postIds: [secondAnswerId],
                parts: [{
                  postId: secondAnswerId,
                  kind: "text",
                  index: 0,
                  rootPostId: rootId,
                }],
              },
            }),
          },
        }),
      ],
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => ({
      role: message.role,
      text: message.content[0]?.text,
      id: message.__openclaw.id,
    }))).toEqual([
      { role: "user", text: "Please investigate", id: rootId },
      { role: "assistant", text: "The durable answer", id: commitId },
      { role: "user", text: "Also check the retry path", id: followupId },
      { role: "assistant", text: "The latest durable answer", id: secondCommitId },
    ]);
  });

  it("uses only the latest unique sealed run for the same human input", () => {
    const retryRunId = "retry-run-2";
    const messages = projectMattermostControlMessages({
      posts: [
        ...committedPosts(),
        post({
          id: secondAnswerId,
          root_id: rootId,
          user_id: agentMmUserId,
          create_at: 5,
          message: "The retried durable answer",
          props: { octogee: runProps({ runId: retryRunId }) },
        }),
        post({
          id: secondCommitId,
          root_id: rootId,
          user_id: agentMmUserId,
          create_at: 6,
          message: "Answer committed",
          props: {
            octogee: runProps({
              runId: retryRunId,
              itemId: "octogee:answer-commit",
              ordinal: 6,
              semanticVersion: 1,
              kind: "agent.answer-commit",
              answer: {
                terminalOutcome: "completed",
                deliveryOutcome: "delivered",
                postIds: [secondAnswerId],
                parts: [{ postId: secondAnswerId, kind: "text", index: 0 }],
              },
            }),
          },
        }),
      ],
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => ({
      role: message.role,
      text: message.content[0]?.text,
    }))).toEqual([
      { role: "user", text: "Please investigate" },
      { role: "assistant", text: "The retried durable answer" },
    ]);
  });

  it("invalidates every run that reuses one answer post across human inputs", () => {
    const secondRunId = "followup-run-2";
    const sharedAnswer = committedPosts().map((entry) => entry.id === answerId
      ? post({ ...entry, props: {} })
      : entry);
    const messages = projectMattermostControlMessages({
      posts: [
        ...sharedAnswer,
        post({
          id: followupId,
          root_id: rootId,
          create_at: 5,
          message: "Also check the retry path",
        }),
        post({
          id: secondCommitId,
          root_id: rootId,
          user_id: agentMmUserId,
          create_at: 6,
          message: "Answer committed",
          props: {
            octogee: runProps({
              runId: secondRunId,
              inputPostId: followupId,
              itemId: "octogee:answer-commit",
              ordinal: 6,
              semanticVersion: 1,
              kind: "agent.answer-commit",
              answer: {
                terminalOutcome: "completed",
                deliveryOutcome: "delivered",
                postIds: [answerId],
                parts: [{ postId: answerId, kind: "text", index: 0 }],
              },
            }),
          },
        }),
      ],
      channelId,
      agentId,
      agentMmUserId,
    });

    expect(messages.map((message) => message.__openclaw.id)).toEqual([
      rootId,
      answerId,
      commitId,
      followupId,
      secondCommitId,
    ]);
  });

  it("rejects duplicate commits for one run and an Agent-authored input", () => {
    const duplicate = post({
      ...committedPosts()[0],
      id: "z".repeat(26),
      create_at: 5,
    });
    const agentInput = committedPosts().map((entry) => entry.id === commitId
      ? post({
          ...entry,
          props: { octogee: runProps({
            inputPostId: answerId,
            itemId: "octogee:answer-commit",
            ordinal: 4,
            semanticVersion: 1,
            kind: "agent.answer-commit",
            answer: {
              terminalOutcome: "completed",
              deliveryOutcome: "delivered",
              postIds: [answerId],
              parts: [{ postId: answerId, kind: "text", index: 0, rootPostId: rootId }],
            },
          }) },
        })
      : entry.id === answerId
        ? post({ ...entry, props: { octogee: runProps({ inputPostId: answerId }) } })
        : entry);

    expect(projectMattermostControlMessages({
      posts: [...committedPosts(), duplicate],
      channelId,
      agentId,
      agentMmUserId,
    }).map((message) => message.__openclaw.id)).toEqual([
      rootId,
      answerId,
      commitId,
      duplicate.id,
    ]);
    expect(projectMattermostControlMessages({
      posts: agentInput,
      channelId,
      agentId,
      agentMmUserId,
    }).map((message) => message.__openclaw.id)).toEqual([rootId, answerId, commitId]);
  });

  it("rejects a commit whose declared human input is absent", () => {
    const missingInputId = "x".repeat(26);
    const posts = committedPosts().map((entry) => entry.id === commitId
      ? post({
          ...entry,
          props: { octogee: runProps({
            inputPostId: missingInputId,
            itemId: "octogee:answer-commit",
            ordinal: 4,
            semanticVersion: 1,
            kind: "agent.answer-commit",
            answer: {
              terminalOutcome: "completed",
              deliveryOutcome: "delivered",
              postIds: [answerId],
              parts: [{ postId: answerId, kind: "text", index: 0 }],
            },
          }) },
        })
      : entry.id === answerId
        ? post({ ...entry, props: { octogee: runProps({ inputPostId: missingInputId }) } })
        : entry);

    expect(projectMattermostControlMessages({
      posts,
      channelId,
      agentId,
      agentMmUserId,
    }).map((message) => message.__openclaw.id)).toEqual([rootId, answerId, commitId]);
  });

  it("does not bind an answer part created before its human input", () => {
    const posts = [
      ...committedPosts().map((entry) => {
        if (entry.id === answerId) {
          return post({
            ...entry,
            create_at: 10,
            props: { octogee: runProps({ inputPostId: followupId }) },
          });
        }
        return entry.id === commitId
          ? post({
              ...entry,
              create_at: 40,
              props: {
                octogee: runProps({
                  inputPostId: followupId,
                  itemId: "octogee:answer-commit",
                  ordinal: 40,
                  semanticVersion: 1,
                  kind: "agent.answer-commit",
                  answer: {
                    terminalOutcome: "completed",
                    deliveryOutcome: "delivered",
                    postIds: [answerId],
                    parts: [{ postId: answerId, kind: "text", index: 0 }],
                  },
                }),
              },
            })
          : entry;
      }),
      post({
        id: followupId,
        root_id: rootId,
        create_at: 30,
        message: "A later human input",
      }),
    ];

    expect(projectMattermostControlMessages({
      posts,
      channelId,
      agentId,
      agentMmUserId,
    }).map((message) => message.__openclaw.id)).toEqual([
      rootId,
      answerId,
      followupId,
      commitId,
    ]);
  });

  it.each([
    ["edited commit", (posts: MattermostModelPost[]) => posts.map((entry) => entry.id === commitId
      ? post({ ...entry, edit_at: entry.create_at + 1 })
      : entry)],
    ["unsafe ordinal", (posts: MattermostModelPost[]) => posts.map((entry) => entry.id === commitId
      ? post({
          ...entry,
          props: { octogee: runProps({
            itemId: "octogee:answer-commit",
            ordinal: Number.MAX_SAFE_INTEGER + 1,
            semanticVersion: 1,
            kind: "agent.answer-commit",
            answer: {
              terminalOutcome: "completed",
              deliveryOutcome: "delivered",
              postIds: [answerId],
              parts: [{ postId: answerId, kind: "text", index: 0, rootPostId: rootId }],
            },
          }) },
        })
      : entry)],
    ["terminal mismatch", (posts: MattermostModelPost[]) => posts.map((entry) => entry.id === commitId
      ? post({
          ...entry,
          props: { octogee: runProps({
            status: "failed",
            itemId: "octogee:answer-commit",
            ordinal: 4,
            semanticVersion: 1,
            kind: "agent.answer-commit",
            answer: {
              terminalOutcome: "completed",
              deliveryOutcome: "delivered",
              postIds: [answerId],
              parts: [{ postId: answerId, kind: "text", index: 0, rootPostId: rootId }],
            },
          }) },
        })
      : entry)],
    ["partial delivery", (posts: MattermostModelPost[]) => posts.map((entry) => entry.id === commitId
      ? post({
          ...entry,
          props: { octogee: runProps({
            itemId: "octogee:answer-commit",
            ordinal: 4,
            semanticVersion: 1,
            kind: "agent.answer-commit",
            answer: {
              terminalOutcome: "completed",
              deliveryOutcome: "partial",
              postIds: [answerId],
              parts: [{ postId: answerId, kind: "text", index: 0, rootPostId: rootId }],
            },
          }) },
        })
      : entry)],
    ["late answer edit", (posts: MattermostModelPost[]) => posts.map((entry) => entry.id === answerId
      ? post({ ...entry, edit_at: 5 })
      : entry)],
  ])("does not promote an answer with an %s but keeps its physical evidence visible", (_label, mutate) => {
    expect(projectMattermostControlMessages({
      posts: mutate(committedPosts()),
      channelId,
      agentId,
      agentMmUserId,
    }).map((message) => message.__openclaw.id)).toEqual([rootId, answerId, commitId]);
  });

  it("attributes chat to the existing profile and user slug while retaining the agent's native identity", async () => {
    const authorize = vi.fn(async () => authorized({ listChannelPosts: async () => ({ posts: committedPosts(), reachedEnd: true }) }));
    const resolveChatProfile = vi.fn(async () => ({ mattermostUserId: humanId, profileId: "existing-profile", username: "alice", avatarUrl: "/api/users/existing-profile/avatar?v=7" }));
    const prepared = await createMattermostControlChat({ authorize, resolveChatProfile }).prepare({
      type: "req", id: "history-profile", method: "chat.history", params: { sessionKey },
    }, session());
    expect(resolveChatProfile).toHaveBeenCalledWith(session(), { channelId, postId: rootId });
    if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
    const response = prepared.project({ type: "res", ok: true, payload: {} });
    expect(response).toMatchObject({ payload: { messages: [
      { role: "user", __openclaw: { senderId: "existing-profile", senderIdentity: { type: "profile", id: "existing-profile" }, senderObservation: { type: "observation", pluginId: "mattermost", accountId: "alice-coach", senderKind: "unknown", id: humanId }, senderName: "alice", senderUsername: "alice", senderProfileAvatarUrl: "/api/users/existing-profile/avatar?v=7" } },
      { role: "assistant" },
    ] } });
    expect(response).toMatchObject({ payload: { messages: [{ __openclaw: {
      senderId: "existing-profile", senderName: "alice",
      senderObservation: { id: humanId },
    } }, { role: "assistant" }] } });
    expect(JSON.stringify(response)).not.toContain(agentMmUserId);
  });

  it("resolves all visible authors concurrently without waiting for earlier authors", async () => {
    const posts = Array.from({ length: 8 }, (_, index) => post({
      id: String(index).repeat(26), user_id: String(index + 1).repeat(26),
      message: `Message ${index}`, create_at: index + 1,
    }));
    const authorize = vi.fn(async () => authorized({ listChannelPosts: async () => ({ posts, reachedEnd: true }) }));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const resolveChatProfile = vi.fn(async () => { await pending; return null; });
    const preparation = createMattermostControlChat({ authorize, resolveChatProfile }).prepare({
      type: "req", id: "many-authors", method: "chat.history", params: { sessionKey },
    }, session());
    try {
      await vi.waitFor(() => expect(resolveChatProfile).toHaveBeenCalledTimes(8));
    } finally {
      release();
      await preparation;
    }
  });

  it("rejects a profile whose verified author does not match the projected message", async () => {
    const authorize = vi.fn(async () => authorized({ listChannelPosts: async () => ({ posts: committedPosts(), reachedEnd: true }) }));
    const resolveChatProfile = vi.fn(async () => ({ mattermostUserId: "other", profileId: "wrong-profile", username: "other" }));
    const result = await createMattermostControlChat({ authorize, resolveChatProfile }).prepare({ type: "req", id: "history", method: "chat.history", params: { sessionKey } }, session());
    expect(result).toMatchObject({ kind: "response", frame: { ok: false } });
  });

  it("replaces SQLite history with the clean Mattermost projection while preserving native metadata", async () => {
    const listChannelPosts = vi.fn(async () => ({
      posts: committedPosts(),
      reachedEnd: true,
    }));
    const authorize = vi.fn(async () => authorized({ listChannelPosts }));
    const adapter = createMattermostControlChat({ authorize });
    const prepared = await adapter.prepare({
      type: "req",
      id: "history-1",
      method: "chat.startup",
      params: { sessionKey, agentId, limit: 800 },
    }, session());

    expect(authorize).toHaveBeenCalledWith(
      "uid-owner",
      channelId,
      "alice",
      { requireActiveLedger: true },
    );
    expect(prepared?.kind).toBe("upstream");
    if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
    const response = prepared.project({
      type: "res",
      id: "history-1",
      ok: true,
      payload: {
        messages: [{ role: "user", content: "SQLite only" }],
        deltaCursor: "sqlite-cursor",
        thinkingLevel: "medium",
      },
    });
    expect(response).toMatchObject({
      ok: true,
      payload: {
        thinkingLevel: "medium",
        offset: 0,
        hasMore: false,
        totalMessages: 2,
        completeSnapshot: true,
      },
    });
    expect(JSON.stringify(response)).toContain("The durable answer");
    expect(JSON.stringify(response)).not.toContain("SQLite only");
    expect(JSON.stringify(response)).not.toContain("sqlite-cursor");
  });


  it("continues paging for every post referenced by a delivered answer commit", async () => {
    const [commit, commentary, answer, root] = committedPosts();
    const listChannelPosts = vi.fn()
      .mockResolvedValueOnce({ posts: [commit], reachedEnd: false, nextBefore: commitId })
      .mockResolvedValueOnce({ posts: [commentary, answer], reachedEnd: false, nextBefore: answerId })
      .mockResolvedValueOnce({ posts: [root], reachedEnd: true });
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async () => authorized({ listChannelPosts })),
    });
    const prepared = await adapter.prepare({
      type: "req",
      id: "history-paged",
      method: "chat.history",
      params: { sessionKey, agentId, limit: 1 },
    }, session());

    expect(listChannelPosts).toHaveBeenCalledTimes(3);
    expect(listChannelPosts).toHaveBeenNthCalledWith(1, channelId, undefined, 50);
    expect(prepared?.kind).toBe("upstream");
    if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
    expect(JSON.stringify(prepared.project({
      type: "res",
      id: "history-paged",
      ok: true,
      payload: { messages: [] },
    }))).toContain("The durable answer");
  });

  it("reports unavailable when Mattermost omits a post referenced by a delivered commit", async () => {
    const [commit, , , root] = committedPosts();
    const listChannelPosts = vi.fn()
      .mockResolvedValueOnce({ posts: [commit], reachedEnd: false, nextBefore: commitId })
      .mockResolvedValueOnce({ posts: [root], reachedEnd: true });
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async () => authorized({ listChannelPosts })),
    });

    await expect(adapter.prepare({
      type: "req",
      id: "history-gap",
      method: "chat.history",
      params: { sessionKey, agentId, limit: 1 },
    }, session())).resolves.toMatchObject({
      kind: "response",
      frame: { ok: false, error: { code: "UNAVAILABLE" } },
    });
    expect(listChannelPosts).toHaveBeenCalledTimes(2);
  });

  it("fails history before cumulative Mattermost bytes can exceed the recovery budget", async () => {
    const oversized = "x".repeat(4 * 1024 * 1024 + 1);
    const listChannelPosts = vi.fn()
      .mockResolvedValueOnce({
        posts: [post({ id: "j".repeat(26), type: "system_join_channel", message: oversized })],
        reachedEnd: false,
        nextBefore: "j".repeat(26),
      })
      .mockResolvedValueOnce({
        posts: [post({ id: "k".repeat(26), type: "system_leave_channel", message: oversized })],
        reachedEnd: false,
        nextBefore: "k".repeat(26),
      });
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async () => authorized({ listChannelPosts })),
    });

    await expect(adapter.prepare({
      type: "req",
      id: "history-byte-budget",
      method: "chat.history",
      params: { sessionKey, agentId, limit: 1 },
    }, session())).resolves.toMatchObject({
      kind: "response",
      frame: { ok: false, error: { code: "UNAVAILABLE" } },
    });
    expect(listChannelPosts).toHaveBeenCalledTimes(2);
  });

  it("merges authorized Mattermost channels into the normal Control UI session roster", async () => {
    const channelMetadata = (id: string) => ({
      id,
      team_id: "t".repeat(26),
      type: "P",
      name: id === channelId ? "alice-general" : "alice-design",
      display_name: id === channelId ? "General" : "Design",
      create_at: 10,
      update_at: 20,
      delete_at: 0,
      last_post_at: id === channelId ? 40 : 30,
    });
    const authorize = vi.fn(async (_uid: string, id: string) => id === deniedChannelId
      ? { forbidden: true as const }
      : authorized({ getJson: vi.fn(async () => channelMetadata(id)) }));
    const listWorkspaceChannels = vi.fn(async () => [
      { channelId },
      { channelId: secondChannelId },
      { channelId: deniedChannelId },
    ]);
    const adapter = createMattermostControlChat({ authorize, listWorkspaceChannels });
    const prepared = await adapter.prepare({
      type: "req",
      id: "sessions-1",
      method: "sessions.list",
      params: {
        limit: 60,
        includeGlobal: true,
        includeUnknown: true,
        configuredAgentsOnly: true,
        includeDerivedTitles: true,
        includeLastMessage: true,
      },
    }, session());

    expect(listWorkspaceChannels).toHaveBeenCalledWith("alice");
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(authorize).toHaveBeenCalledWith(
      "uid-owner",
      channelId,
      "alice",
      { requireActiveLedger: true },
    );
    expect(prepared?.kind).toBe("upstream");
    if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
    const response = prepared.project({
      type: "res",
      id: "sessions-1",
      ok: true,
      payload: {
        ts: 100,
        path: "/native/sessions.sqlite",
        defaults: { model: "native-default" },
        count: 4,
        totalCount: 4,
        hasMore: false,
        nextOffset: null,
        sessions: [
          {
            key: sessionKey,
            kind: "group",
            agentId: "stale-agent",
            peerKind: "channel",
            channel: "stale-channel",
            displayName: "Stale name",
            archived: true,
            updatedAt: 50_000,
            model: "native-model",
            thinkingLevel: "high",
            nativeOnly: { retained: true },
          },
          {
            key: deniedSessionKey,
            kind: "group",
            updatedAt: 45,
            displayName: "Must not leak",
          },
          {
            key: `agent:${agentId}:mattermost:group:not-a-mattermost-id`,
            kind: "group",
            updatedAt: 44,
            displayName: "Malformed Mattermost row",
          },
          {
            key: "agent:octogee-alice-coach:main",
            kind: "direct",
            updatedAt: 35,
            displayName: "Native main",
          },
        ],
      },
    });

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ts: 100,
        path: "/native/sessions.sqlite",
        defaults: { model: "native-default" },
        count: 3,
        sessions: expect.arrayContaining([
          expect.objectContaining({
            key: sessionKey,
            agentId,
            peerKind: "group",
            channel: "mattermost",
            displayName: "General",
            archived: false,
            updatedAt: 40,
            model: "native-model",
            thinkingLevel: "high",
            nativeOnly: { retained: true },
          }),
          expect.objectContaining({
            key: secondSessionKey,
            agentId,
            channel: "mattermost",
            displayName: "Design",
          }),
          expect.objectContaining({
            key: "agent:octogee-alice-coach:main",
            displayName: "Native main",
          }),
        ]),
      },
    });
    expect(JSON.stringify(response)).not.toContain(deniedSessionKey);
    expect(JSON.stringify(response)).not.toContain("Must not leak");
    expect(JSON.stringify(response)).not.toContain("Malformed Mattermost row");
  });

  it.each([true, false])("preserves the hasBoard=%s inventory filter and channel authorization", async (hasBoard) => {
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async (_uid: string, id: string) => id === deniedChannelId
        ? { forbidden: true as const }
        : authorized({ getJson: vi.fn(async () => ({
          id, team_id: "t".repeat(26), type: "P", name: "alice-general",
          display_name: "General", create_at: 10, update_at: 20,
          delete_at: 0, last_post_at: 40,
        })) })),
      listWorkspaceChannels: vi.fn(async () => [
        { channelId }, { channelId: secondChannelId }, { channelId: deniedChannelId },
      ]),
    });
    const prepared = await adapter.prepare({
      type: "req", id: "dashboards", method: "sessions.list",
      params: { hasBoard, archived: "all", limit: 60, includeGlobal: true, includeUnknown: true },
    }, session());
    expect(prepared?.kind).toBe("upstream");
    if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
    expect(prepared.upstreamParams).toMatchObject({ hasBoard, archived: "all" });
    const nativeKey = `agent:${agentId}:main`;
    expect(prepared.project({
      type: "res", id: "dashboards", ok: true,
      payload: {
        count: 3, totalCount: 3, hasMore: false, nextOffset: null,
        sessions: [{ key: sessionKey }, { key: deniedSessionKey }, { key: nativeKey }],
      },
    })).toMatchObject({
      ok: true, payload: {
        count: 2, totalCount: 2,
        sessions: [expect.objectContaining({ key: sessionKey }), expect.objectContaining({ key: nativeKey })],
      },
    });
  });

  it("rejects a non-boolean board inventory filter", async () => {
    const listWorkspaceChannels = vi.fn();
    const adapter = createMattermostControlChat({ listWorkspaceChannels });
    await expect(adapter.prepare({
      type: "req", id: "invalid-board-filter", method: "sessions.list", params: { hasBoard: "true" },
    }, session())).resolves.toMatchObject({
      kind: "response", frame: { ok: false, error: { code: "INVALID_REQUEST" } },
    });
    expect(listWorkspaceChannels).not.toHaveBeenCalled();
  });

  it("rejects unsupported sessions.list input before native rows can bypass projection", async () => {
    const listWorkspaceChannels = vi.fn();
    const adapter = createMattermostControlChat({
      authorize: vi.fn(),
      listWorkspaceChannels,
    });

    await expect(adapter.prepare({
      type: "req",
      id: "sessions-invalid",
      method: "sessions.list",
      params: { limit: 0, unexpected: true },
    }, session())).resolves.toEqual({
      kind: "response",
      frame: {
        type: "res",
        id: "sessions-invalid",
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "Unsupported Mattermost session list request",
        },
      },
    });
    expect(listWorkspaceChannels).not.toHaveBeenCalled();
  });
  it("subscribes without an unadapted snapshot so startup reads the authorized channel roster", async () => {
    const adapter = createMattermostControlChat();
    const prepared = await adapter.prepare({ type: "req", id: "subscribe-member", method: "sessions.subscribe",
      params: { ownerFirst: true, limit: 60 } },
    { ...session()});
    if (prepared?.kind !== "upstream") throw new Error("expected upstream subscription");
    expect(prepared.upstreamParams).toEqual({});
    expect(prepared.project({ type: "res", id: "subscribe-member", ok: true,
      payload: { subscribed: true, list: { sessions: [{ key: "private-upstream-session" }] } } }))
      .toEqual({ type: "res", id: "subscribe-member", ok: true, payload: { subscribed: true } });
    const failed = { type: "res", id: "subscribe-member", ok: false, error: { code: "UNAVAILABLE" } };
    expect(prepared.project(failed)).toEqual(failed);
    await expect(adapter.prepare({ type: "req", id: "subscribe-invalid", method: "sessions.subscribe",
      params: { limit: 0 } }, session())).resolves.toMatchObject({
      kind: "response", frame: { ok: false, error: { code: "INVALID_REQUEST" } },
    });
  });

  it("includes authorized channels absent from a Team member's private store with owner-first ordering", async () => {
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async (_uid: string, id: string) => id === deniedChannelId
        ? { forbidden: true as const }
        : authorized({ getJson: vi.fn(async () => ({
          id: channelId, team_id: "t".repeat(26), type: "P", name: "alice-general",
          display_name: "General", create_at: 10, update_at: 20, delete_at: 0, last_post_at: 40,
        })) })),
      listWorkspaceChannels: async () => [{ channelId }, { channelId: deniedChannelId }],
    });
    const prepared = await adapter.prepare({ type: "req", id: "member-owner-first", method: "sessions.list",
      params: { ownerFirst: true, limit: 60 } },
    { ...session()});
    if (prepared?.kind !== "upstream") throw new Error("expected native session projection");
    expect(prepared.project({ type: "res", ok: true, payload: {
      sessions: [], count: 0, totalCount: 0, hasMore: false, nextOffset: null,
    } })).toMatchObject({ payload: { count: 1, sessions: [{ key: sessionKey, displayName: "General" }] } });
  });

  it("does not synthesize channel sessions withheld by native per-user authorization", async () => {
    const adapter = createMattermostControlChat({ perUserIdentity: true,
      authorize: vi.fn(async () => authorized({ getJson: vi.fn(async () => ({
        id: channelId, team_id: "t".repeat(26), type: "P", name: "alice-general",
        display_name: "General", create_at: 10, update_at: 20, delete_at: 0, last_post_at: 40,
      })) })), listWorkspaceChannels: async () => [{ channelId }] });
    const prepared = await adapter.prepare({ type: "req", id: "list", method: "sessions.list", params: {} },
      { ...session()});
    if (prepared?.kind !== "upstream") throw new Error("expected native channel projection");
    expect(prepared.project({ type: "res", ok: true, payload: {
      sessions: [], count: 0, totalCount: 0, hasMore: false, nextOffset: null,
    } })).toMatchObject({ payload: { sessions: [], count: 0 } });
    expect(prepared.project({ type: "res", ok: true, payload: {
      sessions: [{ key: sessionKey, sessionId: "native-general", updatedAt: 1 }],
      count: 1, totalCount: 1, hasMore: false, nextOffset: null,
    } })).toMatchObject({ payload: { sessions: [{ key: sessionKey, sessionId: "native-general", displayName: "General" }] } });
  });

  it("preserves OpenClaw-authorized native sessions and subscription requests for per-user gateways", async () => {
    const adapter = createMattermostControlChat({ perUserIdentity: true,
      authorize: vi.fn(), listWorkspaceChannels: async () => [] });
    const member = { ...session()};
    const subscribe = { type: "req", id: "subscription", method: "sessions.subscribe", params: { futureOption: true } };
    await expect(adapter.prepare(subscribe, member)).resolves.toBeNull();
    await expect(adapter.prepare({ ...subscribe, method: "sessions.list" }, member)).resolves.toBeNull();
    const prepared = await adapter.prepare({ type: "req", id: "list", method: "sessions.list", params: {} }, member);
    if (prepared?.kind !== "upstream") throw new Error("expected Mattermost roster merge");
    const native = { key: "agent:octogee-alice-proj-shared:authorized-by-openclaw", updatedAt: 1 };
    expect(prepared.project({ type: "res", ok: true, payload: {
      sessions: [native], count: 1, totalCount: 1, hasMore: false, nextOffset: null,
    } })).toMatchObject({ payload: { sessions: [native], count: 1 } });
  });


  it("preserves valid native direct and threaded Mattermost sessions in the roster", async () => {
    const adapter = createMattermostControlChat({
      authorize: vi.fn(),
      listWorkspaceChannels: vi.fn(async () => []),
    });
    const prepared = await adapter.prepare({
      type: "req",
      id: "sessions-native-mattermost",
      method: "sessions.list",
      params: { limit: 60 },
    }, session());

    expect(prepared?.kind).toBe("upstream");
    if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
    const directKey = `agent:${agentId}:mattermost:direct:${humanId}`;
    const threadedKey = `${sessionKey}:thread:${rootId}`;
    expect(prepared.project({
      type: "res",
      id: "sessions-native-mattermost",
      ok: true,
      payload: {
        count: 3,
        totalCount: 3,
        hasMore: false,
        nextOffset: null,
        sessions: [
          { key: directKey, updatedAt: 30 },
          { key: threadedKey, updatedAt: 20 },
          { key: `agent:${agentId}:mattermost:group:not-a-channel-id`, updatedAt: 10 },
        ],
      },
    })).toMatchObject({
      payload: {
        count: 2,
        totalCount: 2,
        sessions: [{ key: directKey }, { key: threadedKey }],
      },
    });
  });

  it("uses the exact public-channel peer kind in synthesized session keys", async () => {
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async () => authorized({
        getJson: vi.fn(async () => ({
          id: channelId,
          team_id: "t".repeat(26),
          type: "O",
          name: "alice-town-square",
          display_name: "Town Square",
          create_at: 10,
          update_at: 20,
          delete_at: 0,
          last_post_at: 30,
        })),
      })),
      listWorkspaceChannels: vi.fn(async () => [{ channelId }]),
    });
    const prepared = await adapter.prepare({
      type: "req",
      id: "sessions-public",
      method: "sessions.list",
      params: { limit: 60, includeGlobal: true, includeUnknown: true },
    }, session());

    expect(prepared?.kind).toBe("upstream");
    if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
    expect(prepared.project({
      type: "res",
      id: "sessions-public",
      ok: true,
      payload: {
        count: 0,
        totalCount: 0,
        hasMore: false,
        nextOffset: null,
        sessions: [],
      },
    })).toMatchObject({
      payload: {
        sessions: [expect.objectContaining({
          key: `agent:${agentId}:mattermost:channel:${channelId}`,
          classification: "channel",
          peerKind: "channel",
        })],
      },
    });
  });

  it("keeps an authorized Mattermost channel discoverable after the native session row is lost", async () => {
    const getJson = vi.fn(async () => ({
      id: channelId,
      team_id: "t".repeat(26),
      type: "P",
      name: "alice-general",
      display_name: "General",
      create_at: 10,
      update_at: 20,
      delete_at: 0,
      last_post_at: 30,
    }));
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async () => authorized({ getJson })),
      listWorkspaceChannels: vi.fn(async () => [{ channelId }]),
    });
    const prepared = await adapter.prepare({
      type: "req",
      id: "sessions-empty",
      method: "sessions.list",
      params: {
        limit: 60,
        includeGlobal: true,
        includeUnknown: true,
        configuredAgentsOnly: true,
        includeDerivedTitles: true,
        includeLastMessage: true,
      },
    }, session());

    expect(prepared?.kind).toBe("upstream");
    if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
    expect(prepared.project({
      type: "res",
      id: "sessions-empty",
      ok: true,
      payload: {
        ts: 100,
        path: "/native/sessions.sqlite",
        count: 0,
        totalCount: 0,
        hasMore: false,
        nextOffset: null,
        sessions: [],
      },
    })).toMatchObject({
      ok: true,
      payload: {
        count: 1,
        totalCount: 1,
        sessions: [expect.objectContaining({
          key: sessionKey,
          kind: "group",
          classification: "group",
          peerKind: "group",
          updatedAt: 30,
        })],
      },
    });
    expect(getJson).toHaveBeenCalledWith(["channels", channelId]);
  });

  it("bounds concurrent authorization while discovering Mattermost sessions", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const candidates = Array.from({ length: 9 }, (_, index) => ({
      channelId: index.toString(36).padStart(26, "0"),
    }));
    const authorize = vi.fn(async (_uid: string, id: string) => {
      started += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return authorized({
        getJson: vi.fn(async () => ({
          id,
          team_id: "t".repeat(26),
          type: "P",
          name: `channel-${id}`,
          display_name: id,
          create_at: 1,
          update_at: 1,
          delete_at: 0,
          last_post_at: 1,
        })),
      });
    });
    const adapter = createMattermostControlChat({
      authorize,
      listWorkspaceChannels: vi.fn(async () => candidates),
    });
    const preparation = adapter.prepare({
      type: "req",
      id: "sessions-concurrency",
      method: "sessions.list",
      params: { limit: 20 },
    }, session());

    await vi.waitFor(() => expect(started).toBe(8));
    expect(maximumActive).toBe(8);
    release();
    await expect(preparation).resolves.toMatchObject({ kind: "upstream" });
    expect(started).toBe(9);
    expect(maximumActive).toBe(8);
  });

  it("propagates the RPC cancellation signal through session discovery", async () => {
    const controller = new AbortController();
    const listWorkspaceChannels = vi.fn(async () => [{ channelId }]);
    const authorize = vi.fn(async () => authorized({}));
    const adapter = createMattermostControlChat({ authorize, listWorkspaceChannels });

    await expect(adapter.prepare({
      type: "req",
      id: "sessions-signal",
      method: "sessions.list",
      params: { limit: 20 },
    }, session(), controller.signal)).resolves.toMatchObject({ kind: "upstream" });

    expect(listWorkspaceChannels).toHaveBeenCalledWith("alice", controller.signal);
    expect(authorize).toHaveBeenCalledWith(
      "uid-owner",
      channelId,
      "alice",
      { requireActiveLedger: true, signal: controller.signal },
    );
  });

  it("paginates one complete merged roster without duplicating later native rows", async () => {
    const channelMetadata = (id: string) => ({
      id,
      team_id: "t".repeat(26),
      type: "P",
      name: id === channelId ? "alice-general" : "alice-design",
      display_name: id === channelId ? "General" : "Design",
      create_at: 10,
      update_at: 20,
      delete_at: 0,
      last_post_at: id === channelId ? 35 : 30,
    });
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async (_uid, id) => authorized({
        getJson: vi.fn(async () => channelMetadata(id)),
      })),
      listWorkspaceChannels: vi.fn(async () => [{ channelId }, { channelId: secondChannelId }]),
    });
    const native = {
      type: "res",
      id: "sessions-paged",
      ok: true,
      payload: {
        count: 2,
        totalCount: 2,
        limitApplied: 2_048,
        hasMore: false,
        nextOffset: null,
        sessions: [
          { key: "agent:octogee-alice-coach:main", updatedAt: 40 },
          { key: sessionKey, updatedAt: 35, nativeOnly: "kept" },
        ],
      },
    };
    const projectPage = async (offset: number) => {
      const prepared = await adapter.prepare({
        type: "req",
        id: "sessions-paged",
        method: "sessions.list",
        params: { limit: 1, offset, includeGlobal: true, includeUnknown: true },
      }, session());
      expect(prepared?.kind).toBe("upstream");
      if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
      expect(prepared.upstreamParams).toMatchObject({ limit: 2_048, offset: 0 });
      return prepared.project(native);
    };

    const pages = await Promise.all([projectPage(0), projectPage(1), projectPage(2)]);
    expect(pages.map((response) => response.payload)).toEqual([
      expect.objectContaining({
        count: 1,
        totalCount: 3,
        limitApplied: 1,
        nextOffset: 1,
        hasMore: true,
        sessions: [expect.objectContaining({ key: "agent:octogee-alice-coach:main" })],
      }),
      expect.objectContaining({
        count: 1,
        totalCount: 3,
        offset: 1,
        nextOffset: 2,
        hasMore: true,
        sessions: [expect.objectContaining({ key: sessionKey, nativeOnly: "kept" })],
      }),
      expect.objectContaining({
        count: 1,
        totalCount: 3,
        offset: 2,
        nextOffset: null,
        hasMore: false,
        sessions: [expect.objectContaining({ key: secondSessionKey })],
      }),
    ]);
    const keys = pages.flatMap((response) =>
      ((response as { payload: { sessions: Array<{ key: string }> } }).payload.sessions)
        .map(({ key }) => key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("re-sorts matched native rows after refreshing their live Mattermost timestamps", async () => {
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async () => authorized({
        getJson: vi.fn(async () => ({
          id: channelId,
          team_id: "t".repeat(26),
          type: "P",
          name: "alice-general",
          display_name: "General",
          create_at: 10,
          update_at: 20,
          delete_at: 0,
          last_post_at: 20,
        })),
      })),
      listWorkspaceChannels: vi.fn(async () => [{ channelId }]),
    });
    const prepared = await adapter.prepare({
      type: "req",
      id: "sessions-refreshed-order",
      method: "sessions.list",
      params: { limit: 1, includeGlobal: true, includeUnknown: true },
    }, session());

    expect(prepared?.kind).toBe("upstream");
    if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
    expect(prepared.project({
      type: "res",
      id: "sessions-refreshed-order",
      ok: true,
      payload: {
        count: 2,
        totalCount: 2,
        hasMore: false,
        nextOffset: null,
        sessions: [
          { key: sessionKey, updatedAt: 100 },
          { key: "agent:octogee-alice-coach:main", updatedAt: 50 },
        ],
      },
    })).toMatchObject({
      payload: {
        count: 1,
        totalCount: 2,
        sessions: [{ key: "agent:octogee-alice-coach:main", updatedAt: 50 }],
      },
    });
  });

  it.each([
    ["search", { search: "legacy channel" }],
    ["activity", { activeMinutes: 1 }],
    ["interaction", { requireLastInteraction: true }],
    ["Agent", { agentId: "stale-agent" }],
    ["archive", { archived: true }],
  ] as const)("re-applies the %s filter after refreshing live Mattermost metadata", async (
    _filter,
    filterParams,
  ) => {
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async () => authorized({
        getJson: vi.fn(async () => ({
          id: channelId,
          team_id: "t".repeat(26),
          type: "P",
          name: "alice-general",
          display_name: "General",
          create_at: 1,
          update_at: 1,
          delete_at: 0,
          last_post_at: 0,
        })),
      })),
      listWorkspaceChannels: vi.fn(async () => [{ channelId }]),
    });
    const prepared = await adapter.prepare({
      type: "req",
      id: "sessions-refreshed-filter",
      method: "sessions.list",
      params: { limit: 20, ...filterParams },
    }, session());

    expect(prepared?.kind).toBe("upstream");
    if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
    expect(prepared.project({
      type: "res",
      id: "sessions-refreshed-filter",
      ok: true,
      payload: {
        count: 1,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
        sessions: [{
          key: sessionKey,
          agentId: "stale-agent",
          archived: true,
          displayName: "Legacy channel",
          subject: "Legacy channel",
          groupChannel: "legacy-channel",
          updatedAt: Date.now(),
          lastInteractionAt: Date.now(),
        }],
      },
    })).toMatchObject({
      payload: { count: 0, totalCount: 0, sessions: [] },
    });
  });

  it("fails closed when the bounded native roster is incomplete", async () => {
    const adapter = createMattermostControlChat({
      authorize: vi.fn(),
      listWorkspaceChannels: vi.fn(async () => []),
    });
    const prepared = await adapter.prepare({
      type: "req",
      id: "sessions-overflow",
      method: "sessions.list",
      params: { limit: 50 },
    }, session());

    expect(prepared?.kind).toBe("upstream");
    if (prepared?.kind !== "upstream") throw new Error("expected upstream projection");
    expect(prepared.project({
      type: "res",
      id: "sessions-overflow",
      ok: true,
      payload: {
        count: 2_048,
        totalCount: 2_049,
        hasMore: true,
        nextOffset: 2_048,
        sessions: Array.from({ length: 2_048 }, (_, index) => ({ key: `native-${index}` })),
      },
    })).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(prepared.project({
      type: "res",
      id: "sessions-overflow",
      ok: true,
      payload: {
        count: 2_049,
        totalCount: 2_049,
        hasMore: false,
        nextOffset: null,
        sessions: Array.from({ length: 2_049 }, (_, index) => ({ key: `native-${index}` })),
      },
    })).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  });

  it("fails the session roster visibly instead of returning a partial authorization projection", async () => {
    const log = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const adapter = createMattermostControlChat({
      authorize: vi.fn(),
      listWorkspaceChannels: vi.fn(async () => {
        throw new Error("Firestore unavailable");
      }),
    });

    await expect(adapter.prepare({
      type: "req",
      id: "sessions-failed",
      method: "sessions.list",
      params: { limit: 60, includeGlobal: true, includeUnknown: true },
    }, session())).resolves.toEqual({
      kind: "response",
      frame: {
        type: "res",
        id: "sessions-failed",
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Mattermost channel is temporarily unavailable",
        },
      },
    });
    expect(log).toHaveBeenCalledWith("Mattermost Dashboard request failed", {
      gatewayId: "walter", method: "sessions.list", stage: "session-list",
      failure: "Error", durationMs: expect.any(Number),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("Firestore unavailable");
    log.mockRestore();
  });

  it("preserves submission identity after Mattermost strips the transient pending post ID", async () => {
    let persistedBody: Record<string, unknown> = {};
    const postJson = vi.fn(async (_path: string[], body: unknown) => {
      persistedBody = body as Record<string, unknown>;
      return post({ id: rootId, message: "Hello" });
    });
    const adapter = createMattermostControlChat({ authorize: vi.fn(async () => authorized({ postJson })) });
    await adapter.prepare({
      type: "req", id: "durable-send", method: "chat.send",
      params: { sessionKey, message: "Hello", idempotencyKey: "control-run-1" },
    }, session());
    const messages = projectMattermostControlMessages({
      posts: [post({ id: rootId, message: "Hello", pending_post_id: "", props: (persistedBody.props ?? {}) as Record<string, unknown> })],
      channelId, agentId, agentMmUserId,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.__openclaw.idempotencyKey).toBe("control-run-1");
    expect(messages[0]?.__openclaw.id).toBe(rootId);
  });

  it.each([
    { userId: agentMmUserId, id: "control-run-1" },
    { userId: humanId, id: " invalid " },
  ])("ignores invalid or differently authored submission identity %j", (submission) => {
    const messages = projectMattermostControlMessages({
      posts: [post({ id: rootId, props: { octogeeControlSubmission: submission } })],
      channelId, agentId, agentMmUserId,
    });
    expect(messages[0]?.__openclaw.idempotencyKey).toBe(`${rootId}:user`);
  });

  it("posts Control UI sends as caller-authored top-level Mattermost turns", async () => {
    const postJson = vi.fn(async () => ({
      id: rootId,
      root_id: "",
      channel_id: channelId,
      user_id: humanId,
      create_at: 1,
      message: "Hello",
    }));
    const authorize = vi.fn(async () => authorized({ postJson }));
    const adapter = createMattermostControlChat({ authorize });
    const prepared = await adapter.prepare({
      type: "req",
      id: "send-1",
      method: "chat.send",
      params: {
        sessionKey,
        agentId,
        message: "Hello",
        deliver: false,
        idempotencyKey: "control-run-1",
      },
    }, session());

    expect(postJson).toHaveBeenCalledWith(["posts"], {
      channel_id: channelId,
      message: "Hello",
      pending_post_id: "control-run-1",
      props: { octogeeControlSubmission: { id: "control-run-1", userId: humanId } },
    });
    expect(prepared).toEqual({
      kind: "response",
      frame: {
        type: "res",
        id: "send-1",
        ok: true,
        payload: { runId: "control-run-1", status: "ok" },
      },
    });

    const projected = projectMattermostControlMessages({
      posts: [post({
        id: rootId,
        message: "Hello",
        pending_post_id: "control-run-1",
      })],
      channelId,
      agentId,
      agentMmUserId,
    });
    expect(projected[0]?.__openclaw.idempotencyKey).toBe("control-run-1");
  });

  it("rejects a non-string Control message without entering the Mattermost write path", async () => {
    const postJson = vi.fn();
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async () => authorized({ postJson })),
    });

    await expect(adapter.prepare({
      type: "req",
      id: "send-non-string",
      method: "chat.send",
      params: {
        sessionKey,
        agentId,
        message: 42,
        deliver: false,
        idempotencyKey: "control-run-invalid-message",
      },
    }, session())).resolves.toMatchObject({
      kind: "response",
      frame: { ok: false, error: { code: "INVALID_REQUEST" } },
    });
    expect(postJson).not.toHaveBeenCalled();
  });

  it("rejects Control attachments before any Mattermost write", async () => {
    const postJson = vi.fn();
    const adapter = createMattermostControlChat({
      authorize: vi.fn(async () => authorized({ postJson })),
    });

    await expect(adapter.prepare({
      type: "req",
      id: "send-attachment",
      method: "chat.send",
      params: {
        sessionKey,
        agentId,
        message: "See attached",
        deliver: false,
        idempotencyKey: "control-run-with-file",
        attachments: [{
          type: "file",
          mimeType: "text/plain",
          fileName: "note.txt",
          content: Buffer.from("note").toString("base64"),
        }],
      },
    }, session())).resolves.toMatchObject({
      kind: "response",
      frame: { ok: false, error: { code: "INVALID_REQUEST" } },
    });
    expect(postJson).not.toHaveBeenCalled();
  });

  it('uploads native phone attachments as the caller into the canonical channel before posting one turn', async () => {
    const fileId = 'f'.repeat(26);
    const uploadFiles = vi.fn(async () => ({ file_infos: [{ id: fileId, user_id: humanId, channel_id: channelId }] }));
    const postJson = vi.fn(async () => post({ id: rootId, message: '', file_ids: [fileId] }));
    const adapter = createMattermostControlChat({ allowAttachments: true, authorize: vi.fn(async () => authorized({ postJson, uploadFiles })) });
    const prepared = await adapter.prepare({ id: 'mobile-file', method: 'chat.send', params: {
      sessionKey, agentId, message: '', idempotencyKey: 'phone-upload',
      attachments: [{ type: 'file', mimeType: 'text/plain', fileName: 'note.txt', content: Buffer.from('note').toString('base64') }],
    } }, session());
    expect(prepared).toMatchObject({ kind: 'response', frame: { ok: true, payload: { runId: 'phone-upload' } } });
    expect(uploadFiles).toHaveBeenCalledWith(channelId, [{ fileName: 'note.txt', mimeType: 'text/plain', bytes: Buffer.from('note') }]);
    expect(postJson).toHaveBeenCalledExactlyOnceWith(['posts'], expect.objectContaining({ channel_id: channelId, file_ids: [fileId], pending_post_id: 'phone-upload' }));
  });

  it.each(['../secret', 'invalid-base64', 'foreign-upload'])('rejects invalid native attachment %s without posting', async kind => {
    const uploadFiles = vi.fn(async () => ({ file_infos: [{ id: 'f'.repeat(26), user_id: 'other', channel_id: channelId }] }));
    const postJson = vi.fn();
    const adapter = createMattermostControlChat({ allowAttachments: true, authorize: vi.fn(async () => authorized({ postJson, uploadFiles })) });
    const response = await adapter.prepare({ id: 'bad-upload', method: 'chat.send', params: {
      sessionKey, agentId, message: 'File', idempotencyKey: 'phone-upload', attachments: [{ type: 'file', mimeType: 'text/plain',
        fileName: kind === '../secret' ? kind : 'note.txt', content: kind === 'invalid-base64' ? 'https://private.example/file' : Buffer.from('note').toString('base64') }],
    } }, session());
    expect(response).toMatchObject({ kind: 'response', frame: { ok: false } });
    expect(postJson).not.toHaveBeenCalled();
    if (kind !== 'foreign-upload') expect(uploadFiles).not.toHaveBeenCalled();
  });

  it.each([
    ["group", "O", 0],
    ["channel", "P", 0],
    ["group", "P", 1],
  ] as const)(
    "rejects a directly supplied %s session when the live Mattermost channel is incompatible",
    async (peerKind, liveType, deleteAt) => {
      const listChannelPosts = vi.fn();
      const authorize = vi.fn(async () => authorized({
        getJson: vi.fn(async () => ({
          id: channelId,
          team_id: "t".repeat(26),
          type: liveType,
          name: "alice-general",
          display_name: "General",
          create_at: 1,
          update_at: 1,
          delete_at: deleteAt,
          last_post_at: 1,
        })),
        listChannelPosts,
      }));
      const adapter = createMattermostControlChat({ authorize });

      await expect(adapter.prepare({
        type: "req",
        id: "history-peer-mismatch",
        method: "chat.history",
        params: {
          sessionKey: `agent:${agentId}:mattermost:${peerKind}:${channelId}`,
          agentId,
        },
      }, session())).resolves.toMatchObject({
        kind: "response",
        frame: { ok: false, error: { code: "FORBIDDEN" } },
      });
      expect(authorize).toHaveBeenCalledWith(
        "uid-owner",
        channelId,
        "alice",
        { requireActiveLedger: true },
      );
      expect(listChannelPosts).not.toHaveBeenCalled();
    },
  );

  it("leaves non-channel and valid direct or threaded Mattermost sessions native", async () => {
    const authorize = vi.fn();
    const adapter = createMattermostControlChat({ authorize });
    await expect(adapter.prepare({
      type: "req",
      id: "history-main",
      method: "chat.history",
      params: { sessionKey: "agent:main:main" },
    }, session())).resolves.toBeNull();
    await expect(adapter.prepare({
      type: "req",
      id: "history-thread",
      method: "chat.history",
      params: { sessionKey: `${sessionKey}:thread:${rootId}` },
    }, session())).resolves.toBeNull();
    await expect(adapter.prepare({
      type: "req",
      id: "send-direct",
      method: "chat.send",
      params: {
        sessionKey: `agent:${agentId}:mattermost:direct:${humanId}`,
        message: "Native DM",
        idempotencyKey: "native-direct",
      },
    }, session())).resolves.toBeNull();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects malformed Mattermost-looking history and send keys locally", async () => {
    const authorize = vi.fn();
    const adapter = createMattermostControlChat({ authorize });
    const malformed = `agent:${agentId}:mattermost:group:not-a-channel-id`;

    await expect(adapter.prepare({
      type: "req",
      id: "history-malformed",
      method: "chat.history",
      params: { sessionKey: malformed },
    }, session())).resolves.toMatchObject({
      kind: "response",
      frame: { ok: false, error: { code: "INVALID_REQUEST" } },
    });
    await expect(adapter.prepare({
      type: "req",
      id: "send-malformed",
      method: "chat.send",
      params: { sessionKey: malformed, message: "No", idempotencyKey: "malformed" },
    }, session())).resolves.toMatchObject({
      kind: "response",
      frame: { ok: false, error: { code: "INVALID_REQUEST" } },
    });
    expect(authorize).not.toHaveBeenCalled();
  });
});
