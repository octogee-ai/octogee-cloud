import { describe, expect, it, vi } from "vitest";
import {
  acceptedSubagentSpawn,
  agentEventActivityTarget,
  createActivityTargetRegistry,
  createDirectMattermostSessionCandidateRegistry,
  createDirectMattermostSessionTargetRegistry,
  directMattermostSessionCandidate,
  directMattermostSessionTarget,
  isUnresolvedChannelEvent,
  mattermostTurnBindingActivityTarget,
  provisionalSubagentActivityTarget,
  reconciledSubagentActivityTarget,
} from "../activity-target.js";
import type { ActivityRunTarget, SourceAgentEvent } from "../activity-types.js";
import { MemoryStore } from "./memory-store.js";

const mainEvent = (overrides: Partial<SourceAgentEvent> = {}): SourceAgentEvent => ({
  runId: "run-1",
  seq: 1,
  stream: "lifecycle",
  agentId: "coach-1",
  sessionKey: "agent:coach-1:mattermost:channel:channel-1:thread:root-1",
  data: { phase: "start" },
  ...overrides,
});

const channelBindingEvent = (overrides: Partial<SourceAgentEvent> = {}): SourceAgentEvent => ({
  runId: "run-1",
  seq: 2,
  stream: "delivery",
  agentId: "coach-1",
  sessionKey: "agent:coach-1:mattermost:channel:channel-1",
  data: {
    schemaVersion: 1,
    kind: "mattermost-turn-binding",
    conversationId: "channel-1",
    turnId: "message-1",
    runId: "run-1",
    agentId: "coach-1",
    sessionKey: "agent:coach-1:mattermost:channel:channel-1",
    origin: "human",
    mainChannelId: "channel-1",
    mainRootPostId: "message-1",
    inputPostId: "message-1",
  },
  ...overrides,
});

describe("Activity run targets", () => {
  it("binds a raw native agent event to its exact Mattermost channel thread", () => {
    expect(agentEventActivityTarget(mainEvent())).toEqual({
      conversationId: "channel-1",
      turnId: "root-1",
      runId: "run-1",
      agentId: "coach-1",
      sessionKey: "agent:coach-1:mattermost:channel:channel-1:thread:root-1",
      origin: "human",
      mainChannelId: "channel-1",
      mainRootPostId: "root-1",
    });
  });

  it("rejects unthreaded, scheduled, conflicting, and unmapped direct events instead of guessing", () => {
    expect(agentEventActivityTarget(mainEvent({
      sessionKey: "agent:coach-1:mattermost:channel:channel-1",
    }))).toBeNull();
    expect(agentEventActivityTarget(mainEvent({
      sessionKey: "agent:coach-1:cron:daily",
    }))).toBeNull();
    expect(agentEventActivityTarget(mainEvent({ agentId: "other-agent" }))).toBeNull();
    expect(agentEventActivityTarget(mainEvent({
      sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
    }))).toBeNull();
  });

  it.each(["channel", "group"] as const)(
    "binds an exact %s-scoped run from its native delivery identity",
    (peerKind) => {
      const sessionKey = `agent:coach-1:mattermost:${peerKind}:channel-1`;
      const binding = channelBindingEvent({ sessionKey });
      binding.data = { ...binding.data, sessionKey };

      expect(mattermostTurnBindingActivityTarget(binding)).toEqual({
        conversationId: "channel-1",
        turnId: "message-1",
        runId: "run-1",
        agentId: "coach-1",
        sessionKey,
        origin: "human",
        mainChannelId: "channel-1",
        mainRootPostId: "message-1",
        inputPostId: "message-1",
      });
      expect(isUnresolvedChannelEvent(mainEvent({ sessionKey }))).toBe(true);
    },
  );

  it("binds a nested channel input to its exact top-level turn root", () => {
    const binding = channelBindingEvent();
    binding.data = {
      ...binding.data,
      turnId: "message-1",
      mainRootPostId: "message-1",
      inputPostId: "reply-1",
    };

    expect(mattermostTurnBindingActivityTarget(binding)).toEqual({
      conversationId: "channel-1",
      turnId: "message-1",
      runId: "run-1",
      agentId: "coach-1",
      sessionKey: "agent:coach-1:mattermost:channel:channel-1",
      origin: "human",
      mainChannelId: "channel-1",
      mainRootPostId: "message-1",
      inputPostId: "reply-1",
    });
  });

  it("rejects channel bindings with conflicting, threaded, or widened identity", () => {
    expect(mattermostTurnBindingActivityTarget(channelBindingEvent({ runId: "other-run" })))
      .toBeNull();
    expect(mattermostTurnBindingActivityTarget(channelBindingEvent({
      sessionKey: "agent:coach-1:mattermost:channel:channel-1:thread:message-1",
    }))).toBeNull();
    const widened = channelBindingEvent();
    widened.data = { ...widened.data, inferredAt: 123 };
    expect(mattermostTurnBindingActivityTarget(widened)).toBeNull();
    const crossed = channelBindingEvent();
    crossed.data = { ...crossed.data, mainRootPostId: "other-message" };
    expect(mattermostTurnBindingActivityTarget(crossed)).toBeNull();
  });

  it("uses message_received only to bind a direct session to its physical Mattermost route", () => {
    const route = directMattermostSessionTarget(
      {
        sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
        messageId: "root-1",
      },
      {
        channelId: "mattermost",
        sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
        nativeChannelId: "direct-channel-1",
        messageId: "root-1",
      },
    );
    expect(route).toEqual({
      sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
      agentId: "coach-1",
      conversationId: "direct-channel-1",
      rootPostId: "root-1",
    });
    expect(agentEventActivityTarget(mainEvent({
      sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
    }), route)).toMatchObject({
      runId: "run-1",
      mainChannelId: "direct-channel-1",
      mainRootPostId: "root-1",
    });
  });

  it("derives an exact direct resolver candidate without inventing the physical channel", () => {
    expect(directMattermostSessionCandidate(
      {
        sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
        messageId: "message-1",
      },
      {
        channelId: "mattermost",
        sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
        messageId: "message-1",
      },
    )).toEqual({
      sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
      agentId: "coach-1",
      ownerUserId: "user-1",
      rootPostId: "root-1",
      inboundPostId: "message-1",
    });
  });

  it("rejects direct hook facts that conflict with the native session route", () => {
    expect(directMattermostSessionTarget(
      {
        sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
        threadId: "other-root",
      },
      {
        channelId: "mattermost",
        sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
        nativeChannelId: "direct-channel-1",
      },
    )).toBeNull();
  });

  it("uses canonical child and requester facts for a subagent", () => {
    expect(provisionalSubagentActivityTarget({
      phase: "started",
      runId: "child-run",
      childSessionKey: "agent:researcher:subagent:child",
      requester: {
        channel: "mattermost",
        channelId: "channel-1",
        threadId: "root-1",
        messageId: "input-1",
      },
    }, {
      childSessionKey: "agent:researcher:subagent:child",
      requesterSessionKey: "agent:coach-1:mattermost:channel:channel-1:thread:root-1",
    })).toMatchObject({
      requesterSessionKey: "agent:coach-1:mattermost:channel:channel-1:thread:root-1",
      target: {
        runId: "child-run",
        agentId: "researcher",
        sessionKey: "agent:researcher:subagent:child",
        origin: "subagent",
        mainChannelId: "channel-1",
        mainRootPostId: "root-1",
      },
    });
  });

  it("preserves the native direct requester route for a DM-launched subagent", () => {
    const requesterSessionKey =
      "agent:coach-1:mattermost:direct:owner-1:thread:root-1";

    expect(provisionalSubagentActivityTarget({
      phase: "started",
      runId: "child-run",
      childSessionKey: "agent:coach-1:subagent:child",
      requester: {
        channel: "mattermost",
        channelId: "direct-channel-1",
        threadId: "root-1",
        messageId: "input-1",
      },
    }, {
      childSessionKey: "agent:coach-1:subagent:child",
      requesterSessionKey,
    })).toMatchObject({
      requesterSessionKey,
      target: {
        sessionKey: "agent:coach-1:subagent:child",
        requesterSessionKey,
        mainChannelId: "direct-channel-1",
        mainRootPostId: "root-1",
      },
    });
  });

  it("reconciles a cross-Agent DM child through the resolved parent managed account", () => {
    const parent: ActivityRunTarget = {
      conversationId: "direct-channel-1",
      turnId: "root-1",
      runId: "parent-run",
      agentId: "coach-1",
      sessionKey: "agent:coach-1:mattermost:direct:owner-1:thread:root-1",
      origin: "human",
      mainChannelId: "direct-channel-1",
      mainRootPostId: "root-1",
    };
    const provisional = provisionalSubagentActivityTarget({
      phase: "started",
      runId: "child-run",
      childSessionKey: "agent:researcher:subagent:child",
      requester: {
        channel: "mattermost",
        channelId: "direct-channel-1",
        threadId: "root-1",
        messageId: "input-1",
      },
    }, {
      childSessionKey: "agent:researcher:subagent:child",
      requesterSessionKey: parent.sessionKey,
    });
    const accepted = acceptedSubagentSpawn({
      runId: parent.runId,
      seq: 2,
      stream: "tool",
      agentId: parent.agentId,
      sessionKey: parent.sessionKey,
      data: {
        phase: "result",
        name: "sessions_spawn",
        result: {
          details: {
            status: "accepted",
            runId: "child-run",
            childSessionKey: "agent:researcher:subagent:child",
          },
        },
      },
    });

    expect(provisional).not.toBeNull();
    expect(accepted).not.toBeNull();
    expect(reconciledSubagentActivityTarget(provisional!, accepted!, parent)).toMatchObject({
      runId: "child-run",
      parentRunId: "parent-run",
      agentId: "researcher",
      sessionKey: "agent:researcher:subagent:child",
      requesterSessionKey: parent.sessionKey,
      mainChannelId: "direct-channel-1",
      mainRootPostId: "root-1",
    });
    expect(reconciledSubagentActivityTarget(provisional!, accepted!, {
      ...parent,
      sessionKey: "agent:coach-1:mattermost:direct:other-owner:thread:root-1",
    })).toBeNull();
  });

  it("rejects subagent requester metadata that conflicts with the requester session", () => {
    expect(provisionalSubagentActivityTarget({
      phase: "started",
      runId: "child-run",
      childSessionKey: "agent:researcher:subagent:child",
      requester: {
        channel: "mattermost",
        channelId: "channel-2",
        threadId: "root-1",
        messageId: "input-1",
      },
    }, {
      childSessionKey: "agent:researcher:subagent:child",
      requesterSessionKey: "agent:coach-1:mattermost:channel:channel-1:thread:root-1",
    })).toBeNull();
  });

  it("derives exact parent lineage only from an accepted native sessions_spawn result", () => {
    expect(acceptedSubagentSpawn({
      ...mainEvent(),
      seq: 2,
      stream: "tool",
      data: {
        phase: "result",
        name: "sessions_spawn",
        toolCallId: "spawn-1",
        result: {
          details: {
            status: "accepted",
            runId: "child-run",
            childSessionKey: "agent:researcher:subagent:child",
          },
        },
      },
    })).toEqual({
      childRunId: "child-run",
      childSessionKey: "agent:researcher:subagent:child",
      parentRunId: "run-1",
      parentSessionKey: "agent:coach-1:mattermost:channel:channel-1:thread:root-1",
      parentAgentId: "coach-1",
    });
  });

  it("accepts an external Mattermost result without sessionKey but requires its stamped agentId", () => {
    const event = {
      runId: "run-1",
      seq: 2,
      stream: "tool",
      agentId: "coach-1",
      data: {
        phase: "result",
        name: "sessions_spawn",
        result: {
          details: {
            status: "accepted",
            runId: "child-run",
            childSessionKey: "agent:researcher:subagent:child",
          },
        },
      },
    } satisfies SourceAgentEvent;
    expect(acceptedSubagentSpawn(event)).toEqual({
      childRunId: "child-run",
      childSessionKey: "agent:researcher:subagent:child",
      parentRunId: "run-1",
      parentAgentId: "coach-1",
    });
    const { agentId: _agentId, ...unstamped } = event;
    expect(acceptedSubagentSpawn(unstamped)).toBeNull();
  });

  it("rejects guessed, failed, and self-referential subagent lineage", () => {
    const resultEvent = {
      ...mainEvent(),
      seq: 2,
      stream: "tool",
      data: {
        phase: "result",
        name: "sessions_spawn",
        result: {
          details: {
            status: "accepted",
            runId: "child-run",
            childSessionKey: "agent:researcher:subagent:child",
          },
        },
      },
    } satisfies SourceAgentEvent;
    expect(acceptedSubagentSpawn({
      ...resultEvent,
      data: { ...resultEvent.data, name: "other_tool" },
    })).toBeNull();
    expect(acceptedSubagentSpawn({
      ...resultEvent,
      data: { ...resultEvent.data, isError: true },
    })).toBeNull();
    expect(acceptedSubagentSpawn({
      ...resultEvent,
      data: {
        ...resultEvent.data,
        result: {
          details: {
            status: "accepted",
            runId: "run-1",
            childSessionKey: "agent:researcher:subagent:child",
          },
        },
      },
    })).toBeNull();
    expect(acceptedSubagentSpawn({
      ...resultEvent,
      runId: "parent-run",
      sessionKey: "agent:researcher:subagent:child",
    })).toBeNull();
  });

  it("requires a nested child to inherit its exact parent channel and root", () => {
    const parent: ActivityRunTarget = {
      conversationId: "channel-1",
      turnId: "root-1",
      runId: "parent-run",
      parentRunId: "run-1",
      agentId: "researcher",
      sessionKey: "agent:researcher:subagent:parent",
      origin: "subagent",
      mainChannelId: "channel-1",
      mainRootPostId: "root-1",
      inputPostId: "input-1",
    };
    const accepted = acceptedSubagentSpawn({
      runId: parent.runId,
      seq: 2,
      stream: "tool",
      sessionKey: parent.sessionKey,
      agentId: parent.agentId,
      data: {
        phase: "result",
        name: "sessions_spawn",
        result: {
          details: {
            status: "accepted",
            runId: "nested-run",
            childSessionKey: "agent:writer:subagent:nested",
          },
        },
      },
    })!;
    const exact = provisionalSubagentActivityTarget({
      phase: "started",
      runId: accepted.childRunId,
      childSessionKey: accepted.childSessionKey,
      requester: {
        channel: "mattermost",
        channelId: parent.mainChannelId,
        threadId: parent.mainRootPostId,
        messageId: "nested-input",
      },
    }, {
      childSessionKey: accepted.childSessionKey,
      requesterSessionKey: parent.sessionKey,
    })!;
    const crossed = provisionalSubagentActivityTarget({
      phase: "started",
      runId: accepted.childRunId,
      childSessionKey: accepted.childSessionKey,
      requester: {
        channel: "mattermost",
        channelId: "channel-2",
        threadId: "root-2",
        messageId: "nested-input",
      },
    }, {
      childSessionKey: accepted.childSessionKey,
      requesterSessionKey: parent.sessionKey,
    })!;

    expect(reconciledSubagentActivityTarget(exact, accepted, parent)).toMatchObject({
      runId: "nested-run",
      parentRunId: "parent-run",
      mainChannelId: "channel-1",
      mainRootPostId: "root-1",
    });
    expect(reconciledSubagentActivityTarget(
      exact,
      { ...accepted, parentAgentId: "different-parent" },
      parent,
    )).toBeNull();
    expect(reconciledSubagentActivityTarget(crossed, accepted, parent)).toBeNull();
  });

  it("propagates the ancestor direct route through nested cross-Agent subagents", () => {
    const directSessionKey = "agent:coach-1:mattermost:direct:owner-1:thread:root-1";
    const parent: ActivityRunTarget = {
      conversationId: "direct-channel-1",
      turnId: "root-1",
      runId: "parent-run",
      parentRunId: "run-1",
      agentId: "researcher",
      sessionKey: "agent:researcher:subagent:parent",
      requesterSessionKey: directSessionKey,
      origin: "subagent",
      mainChannelId: "direct-channel-1",
      mainRootPostId: "root-1",
      inputPostId: "input-1",
    };
    const accepted = acceptedSubagentSpawn({
      runId: parent.runId,
      seq: 2,
      stream: "tool",
      sessionKey: parent.sessionKey,
      agentId: parent.agentId,
      data: {
        phase: "result",
        name: "sessions_spawn",
        result: {
          details: {
            status: "accepted",
            runId: "nested-run",
            childSessionKey: "agent:writer:subagent:nested",
          },
        },
      },
    })!;
    const provisional = provisionalSubagentActivityTarget({
      phase: "started",
      runId: accepted.childRunId,
      childSessionKey: accepted.childSessionKey,
      requester: {
        channel: "mattermost",
        channelId: parent.mainChannelId,
        threadId: parent.mainRootPostId,
        messageId: "nested-input",
      },
    }, {
      childSessionKey: accepted.childSessionKey,
      requesterSessionKey: parent.sessionKey,
    })!;

    expect(reconciledSubagentActivityTarget(provisional, accepted, parent)).toMatchObject({
      runId: "nested-run",
      parentRunId: "parent-run",
      agentId: "writer",
      sessionKey: "agent:writer:subagent:nested",
      requesterSessionKey: directSessionKey,
      mainChannelId: "direct-channel-1",
      mainRootPostId: "root-1",
    });
  });

  it("rejects conflicting durable targets for one run id", async () => {
    const registry = createActivityTargetRegistry(new MemoryStore<ActivityRunTarget>());
    await registry.start();
    const target = agentEventActivityTarget(mainEvent());
    expect(target).not.toBeNull();
    await registry.remember(target!);

    await expect(registry.remember({
      ...target!,
      conversationId: "channel-2",
      mainChannelId: "channel-2",
    })).rejects.toThrow("activity target changed for run run-1");
  });

  it("does not cache a run target before durable registration succeeds", async () => {
    const store = new MemoryStore<ActivityRunTarget>();
    const registerIfAbsent = vi.spyOn(store, "registerIfAbsent")
      .mockRejectedValueOnce(new Error("durable target write failed"));
    const registry = createActivityTargetRegistry(store);
    await registry.start();
    const target = agentEventActivityTarget(mainEvent())!;

    await expect(registry.remember(target)).rejects.toThrow("durable target write failed");
    await expect(registry.resolveRun(target.runId)).resolves.toBeNull();
    await expect(registry.remember(target)).resolves.toBeUndefined();

    expect(registerIfAbsent).toHaveBeenCalledTimes(2);
    await expect(registry.resolveRun(target.runId)).resolves.toEqual(target);
  });

  it("rejects conflicting durable direct-session routes", async () => {
    const registry = createDirectMattermostSessionTargetRegistry(new MemoryStore());
    await registry.start();
    const route = {
      sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
      agentId: "coach-1",
      conversationId: "direct-channel-1",
      rootPostId: "root-1",
    };
    await registry.remember(route);
    await expect(registry.remember({
      ...route,
      conversationId: "other-direct-channel",
    })).rejects.toThrow("direct Mattermost route changed");
  });

  it("does not cache a direct route before durable registration succeeds", async () => {
    const store = new MemoryStore<{
      sessionKey: string;
      agentId: string;
      conversationId: string;
      rootPostId: string;
    }>();
    const registerIfAbsent = vi.spyOn(store, "registerIfAbsent")
      .mockRejectedValueOnce(new Error("durable route write failed"));
    const registry = createDirectMattermostSessionTargetRegistry(store);
    await registry.start();
    const route = {
      sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
      agentId: "coach-1",
      conversationId: "direct-channel-1",
      rootPostId: "root-1",
    };

    await expect(registry.remember(route)).rejects.toThrow("durable route write failed");
    await expect(registry.resolve(route.sessionKey)).resolves.toBeNull();
    await expect(registry.remember(route)).resolves.toBeUndefined();

    expect(registerIfAbsent).toHaveBeenCalledTimes(2);
    await expect(registry.resolve(route.sessionKey)).resolves.toEqual(route);
  });

  it("keeps the latest native inbound post as the durable direct resolver candidate", async () => {
    const registry = createDirectMattermostSessionCandidateRegistry(new MemoryStore());
    await registry.start();
    const candidate = {
      sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
      agentId: "coach-1",
      ownerUserId: "user-1",
      rootPostId: "root-1",
      inboundPostId: "message-1",
    };
    await registry.remember(candidate);
    await registry.remember({ ...candidate, inboundPostId: "message-2" });
    await expect(registry.resolve(candidate.sessionKey)).resolves.toEqual({
      ...candidate,
      inboundPostId: "message-2",
    });
  });

  it("keeps the durable direct resolver candidate when an update write fails", async () => {
    const store = new MemoryStore<{
      sessionKey: string;
      agentId: string;
      ownerUserId: string;
      rootPostId: string;
      inboundPostId: string;
    }>();
    const registry = createDirectMattermostSessionCandidateRegistry(store);
    await registry.start();
    const candidate = {
      sessionKey: "agent:coach-1:mattermost:direct:user-1:thread:root-1",
      agentId: "coach-1",
      ownerUserId: "user-1",
      rootPostId: "root-1",
      inboundPostId: "message-1",
    };
    await registry.remember(candidate);
    const register = vi.spyOn(store, "register")
      .mockRejectedValueOnce(new Error("durable candidate write failed"));

    await expect(registry.remember({
      ...candidate,
      inboundPostId: "message-2",
    })).rejects.toThrow("durable candidate write failed");
    await expect(registry.resolve(candidate.sessionKey)).resolves.toEqual(candidate);
    await registry.remember({ ...candidate, inboundPostId: "message-2" });

    expect(register).toHaveBeenCalledTimes(2);
    await expect(registry.resolve(candidate.sessionKey)).resolves.toEqual({
      ...candidate,
      inboundPostId: "message-2",
    });
  });
});
