import { describe, expect, it, vi } from "vitest";

import {
  createOpenClawRuntimeBroker,
  createOpenClawRuntimeBrokerFromEnv,
  runtimeBrokerBaseUrlFromEnv,
} from "../runtime-broker.js";
import { SIDECAR_BROKER_TOKEN_HEADER } from "@octogee/core/internal-fetch";
import {
  ActivityReceiptConflictError,
  ActivityReceiptLeaseError,
} from "@octogee/core/http-candidates/chat-proxy/openclaw/activity-write-receipts";

const threadRootPostId = 'r'.repeat(26);
function brokerWithRedeemStatus(
  status: number,
  body: Record<string, unknown>,
): ReturnType<typeof createOpenClawRuntimeBroker> {
  const fetchImpl: typeof fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    }),
  );
  return createOpenClawRuntimeBroker({
    baseUrl: "http://octogee-api:3001/",
    gatewayId: "default",
    fetchImpl,
  });
}

describe("redeemOpenClawWs outcome", () => {
  it('preserves only the validated native Activity scope', async () => {
    const activityConversation = { gatewayId: 'default', ownerUid: 'owner', channelId: 'c'.repeat(26), threadRootPostId, expectedAgentId: 'octogee-bob-coach', sessionKey: `agent:octogee-bob-coach:mattermost:group:${'c'.repeat(26)}` };
    const broker = brokerWithRedeemStatus(200, { uid: 'member', gatewayId: 'default', gatewayUrl: 'ws://gw', expectedAgentId: 'octogee-bob-coach', activityConversation: { ...activityConversation, unexpected: 'discard' } });
    expect(await broker.redeemOpenClawWs('ticket')).toMatchObject({ kind: 'redeemed', redeemed: { activityConversation } });
    const result = await brokerWithRedeemStatus(200, activityConversation).getActivityConversation?.('member', activityConversation.channelId, threadRootPostId);
    expect(result).toEqual(activityConversation);
  });
  it('accepts a channel-scoped native Activity scope without a selected thread', async () => {
    const activityConversation = { gatewayId: 'default', ownerUid: 'owner', channelId: 'c'.repeat(26), expectedAgentId: 'octogee-bob-coach', sessionKey: `agent:octogee-bob-coach:mattermost:group:${'c'.repeat(26)}` };
    const broker = brokerWithRedeemStatus(200, { uid: 'member', gatewayId: 'default', gatewayUrl: 'ws://gw', expectedAgentId: 'octogee-bob-coach', activityConversation });
    expect(await broker.redeemOpenClawWs('ticket')).toMatchObject({ kind: 'redeemed', redeemed: { activityConversation } });
    const result = await brokerWithRedeemStatus(200, activityConversation).getActivityConversation?.('member', activityConversation.channelId);
    expect(result).toEqual(activityConversation);
    expect(result).not.toHaveProperty('threadRootPostId');
  });
  it('rejects a direct-message Activity scope without a selected thread', async () => {
    const activityConversation = { gatewayId: 'default', ownerUid: 'owner', channelId: 'c'.repeat(26), expectedAgentId: 'octogee-bob-coach', sessionKey: `agent:octogee-bob-coach:mattermost:direct:${'u'.repeat(26)}` };
    const broker = brokerWithRedeemStatus(200, { uid: 'member', gatewayId: 'default', gatewayUrl: 'ws://gw', expectedAgentId: 'octogee-bob-coach', activityConversation });
    await expect(broker.redeemOpenClawWs('ticket')).rejects.toThrow('malformed Activity conversation');
  });
  it.each([{ gatewayId: 'foreign' }, { expectedAgentId: 'other' }, { sessionKey: 'agent:octogee-bob-coach:main' },
    { sessionKey: `agent:octogee-bob-coach:mattermost:group:${'d'.repeat(26)}` },
    { sessionKey: `agent:octogee-bob-coach:mattermost:group:${'c'.repeat(26)}:thread:${threadRootPostId}` },
  ])('rejects mismatched native Activity scope %j', async patch => {
    const activityConversation = { gatewayId: 'default', ownerUid: 'owner', channelId: 'c'.repeat(26), threadRootPostId, expectedAgentId: 'octogee-bob-coach', sessionKey: `agent:octogee-bob-coach:mattermost:group:${'c'.repeat(26)}`, ...patch };
    const broker = brokerWithRedeemStatus(200, { uid: 'member', gatewayId: 'default', gatewayUrl: 'ws://gw', expectedAgentId: 'octogee-bob-coach', activityConversation });
    await expect(broker.redeemOpenClawWs('ticket')).rejects.toThrow('malformed Activity conversation');
  });
  it("200 → redeemed", async () => {
    const broker = brokerWithRedeemStatus(200, {
      uid: "uid-bob",
      gatewayId: "default",
      gatewayUrl: "ws://gw",
      expectedAgentId: "octogee-bob-coach",
    });
    const outcome = await broker.redeemOpenClawWs("ticket");
    expect(outcome).toEqual({
      kind: "redeemed",
      redeemed: {
        uid: "uid-bob",
        gatewayId: "default",
        gatewayUrl: "ws://gw",
        expectedAgentId: "octogee-bob-coach",
      },
    });
  });

  it("preserves authoritative workspace voice scope for gateway admission and channel startup", async () => {
    const voiceConversation = { ownerUid: "owner", workspaceSlug: "alice", channelId: "c".repeat(26), threadRootPostId, sessionKey: `agent:octogee-alice-coach:mattermost:group:${"c".repeat(26)}` };
    const voiceGrant = "g".repeat(43);
    const voiceGrantExpiresAt = Date.now() + 60_000;
    const broker = brokerWithRedeemStatus(200, { uid: "member", gatewayId: "default", gatewayUrl: "ws://gw", expectedAgentId: "octogee-alice-coach", voiceConversation, voiceGrant, voiceGrantExpiresAt });
    expect(await broker.redeemOpenClawWs("ticket", "voice-ws")).toMatchObject({ kind: "redeemed", redeemed: { uid: "member", voiceConversation, voiceGrant, voiceGrantExpiresAt } });
  });
  it.each(['channel', 'group'])('preserves an authorized project voice scope for a %s session', async peerKind => {
    const expectedAgentId = 'octogee-alice-proj-orbit-coach';
    const voiceConversation = { ownerUid: 'owner', workspaceSlug: 'alice', channelId: 'c'.repeat(26), threadRootPostId,
      sessionKey: `agent:${expectedAgentId}:mattermost:${peerKind}:${'c'.repeat(26)}` };
    const voiceGrant = 'g'.repeat(43);
    const voiceGrantExpiresAt = Date.now() + 60_000;
    const broker = brokerWithRedeemStatus(200, { uid: 'project-member', gatewayId: 'default', gatewayUrl: 'ws://gw', expectedAgentId,
      voiceConversation, voiceGrant, voiceGrantExpiresAt });
    expect(await broker.redeemOpenClawWs('ticket', 'voice-ws')).toMatchObject({ kind: 'redeemed',
      redeemed: { uid: 'project-member', expectedAgentId, voiceConversation, voiceGrant, voiceGrantExpiresAt } });
  });
  it.each([
    { expectedAgentId: 'octogee-other-proj-orbit-coach', sessionKey: `agent:octogee-other-proj-orbit-coach:mattermost:group:${'c'.repeat(26)}` },
    { expectedAgentId: 'not-an-octogee-agent' },
    { workspaceSlug: 'other' },
    { sessionKey: `agent:octogee-alice-proj-another-coach:mattermost:group:${'c'.repeat(26)}` },
    { sessionKey: `agent:octogee-alice-proj-orbit-coach:mattermost:group:${'d'.repeat(26)}` },
    { sessionKey: `agent:octogee-alice-proj-orbit-coach:mattermost:direct:${'c'.repeat(26)}` },
    { sessionKey: `agent:octogee-alice-proj-orbit-coach:mattermost:group:${'c'.repeat(26)}:thread:${threadRootPostId}` },
  ])('rejects mismatched project voice scope %j', async ({ expectedAgentId = 'octogee-alice-proj-orbit-coach', ...patch }) => {
    const broker = brokerWithRedeemStatus(200, { uid: 'project-member', gatewayId: 'default', gatewayUrl: 'ws://gw', expectedAgentId,
      voiceGrant: 'g'.repeat(43), voiceGrantExpiresAt: Date.now() + 60_000,
      voiceConversation: { ownerUid: 'owner', workspaceSlug: 'alice', channelId: 'c'.repeat(26), threadRootPostId,
        sessionKey: `agent:octogee-alice-proj-orbit-coach:mattermost:group:${'c'.repeat(26)}`, ...patch } });
    await expect(broker.redeemOpenClawWs('ticket', 'voice-ws')).rejects.toThrow('malformed redeem response');
  });
  it.each([undefined, { ownerUid: "owner", workspaceSlug: "alice", channelId: "bad" }, { ownerUid: "owner", workspaceSlug: "other", channelId: "c".repeat(26) }])("refuses malformed or mismatched voice scope %j", async voiceConversation => {
    const broker = brokerWithRedeemStatus(200, { uid: "member", gatewayId: "default", gatewayUrl: "ws://gw", expectedAgentId: "octogee-alice-coach", voiceConversation });
    await expect(broker.redeemOpenClawWs("ticket", "voice-ws")).rejects.toThrow("malformed redeem response");
  });

  it.each([
    {}, { voiceGrant: 'bad', voiceGrantExpiresAt: Date.now() + 60_000 },
    { voiceGrant: 'g'.repeat(43), voiceGrantExpiresAt: 1 },
    { voiceGrant: 'g'.repeat(43), voiceGrantExpiresAt: 'later' },
  ])('refuses missing or malformed voice grant custody: %j', async custody => {
    const broker = brokerWithRedeemStatus(200, { uid: 'member', gatewayId: 'default', gatewayUrl: 'ws://gw', expectedAgentId: 'octogee-alice-coach',
      voiceConversation: { ownerUid: 'owner', workspaceSlug: 'alice', channelId: 'c'.repeat(26), threadRootPostId, sessionKey: `agent:octogee-alice-coach:mattermost:group:${'c'.repeat(26)}` }, ...custody });
    await expect(broker.redeemOpenClawWs('ticket', 'voice-ws')).rejects.toThrow('malformed redeem response');
  });
  it('rejects a voice ticket with a different canonical native session', async () => {
    const broker = brokerWithRedeemStatus(200, { uid: 'member', gatewayId: 'default', gatewayUrl: 'ws://gw', expectedAgentId: 'octogee-alice-coach',
      voiceGrant: 'g'.repeat(43), voiceGrantExpiresAt: Date.now() + 60_000,
      voiceConversation: { ownerUid: 'owner', workspaceSlug: 'alice', channelId: 'c'.repeat(26), threadRootPostId, sessionKey: 'agent:other:main' } });
    await expect(broker.redeemOpenClawWs('ticket', 'voice-ws')).rejects.toThrow('malformed redeem response');
  });

  it("401 → unauthorized", async () => {
    const broker = brokerWithRedeemStatus(401, { error: "unauthorized" });
    expect(await broker.redeemOpenClawWs("ticket")).toEqual({ kind: "unauthorized" });
  });

  it("502 gateway-url-unresolved → revision-unavailable (expected, distinguishable, not a throw)", async () => {
    const broker = brokerWithRedeemStatus(502, { error: "gateway-url-unresolved" });
    const outcome = await broker.redeemOpenClawWs("ticket");
    expect(outcome).toEqual({ kind: "revision-unavailable", reason: "gateway-url-unresolved" });
  });
});

describe("direct conversation target outcome", () => {
  it.each([403, 404])("treats broker HTTP %s as an unavailable target", async (status) => {
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "default",
      fetchImpl: vi.fn(async () => new Response(
        JSON.stringify({ error: status === 403 ? "forbidden" : "not_found" }),
        { headers: { "content-type": "application/json" }, status },
      )),
    });

    await expect(broker.resolveDirectConversationTarget(
      "octogee-bob-coach",
      "direct-1",
      "owner-1",
    )).resolves.toBeNull();
  });

  it("preserves unexpected broker failures", async () => {
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "default",
      fetchImpl: vi.fn(async () => new Response(
        JSON.stringify({ error: "unavailable" }),
        { headers: { "content-type": "application/json" }, status: 503 },
      )),
    });

    await expect(broker.resolveDirectConversationTarget(
      "octogee-bob-coach",
      "direct-1",
      "owner-1",
    )).rejects.toMatchObject({ status: 503, message: "unavailable" });
  });
});

describe("OpenClaw runtime broker env", () => {
  it("adds the sidecar capability only when resolving agent secrets", async () => {
    const calls: Array<{ path: string; credential: string | null }> = [];
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "shared-blue",
      sidecarBrokerHeaders: async () => ({
        [SIDECAR_BROKER_TOKEN_HEADER]: "credential-jwt",
      }),
      fetchImpl: vi.fn(async (input, init) => {
        calls.push({
          path: new URL(String(input)).pathname,
          credential: new Headers(init?.headers).get(SIDECAR_BROKER_TOKEN_HEADER),
        });
        const identity = {
          agentId: "octogee-alice-coach",
          uid: "uid-alice",
          coachToken: "default-agent-pat",
        };
        return new Response(JSON.stringify(
          String(input).endsWith("agent-identity") ? { identity } : { target: null },
        ), { headers: { "content-type": "application/json" }, status: 200 });
      }),
    });

    await broker.resolveAgentIdentity("octogee-alice-coach");
    await broker.resolveConversationTarget("octogee-alice-coach", "channel-1");
    await broker.resolveDirectConversationTarget("octogee-alice-coach", "direct-1", "owner-1");

    expect(calls).toEqual([
      {
        path: "/internal/openclaw/activity/agent-identity",
        credential: "credential-jwt",
      },
      { path: "/internal/openclaw/activity/conversation-target", credential: null },
      { path: "/internal/openclaw/activity/direct-conversation-target", credential: null },
    ]);
  });

  it("requires OPENCLAW_RUNTIME_BROKER_URL", () => {
    expect(() => runtimeBrokerBaseUrlFromEnv({ GATEWAY_ID: "default" })).toThrow(
      "OPENCLAW_RUNTIME_BROKER_URL is required",
    );
    expect(() => createOpenClawRuntimeBrokerFromEnv({ GATEWAY_ID: "default" })).toThrow(
      "OPENCLAW_RUNTIME_BROKER_URL is required",
    );
  });

  it("requires GATEWAY_ID when the broker URL is configured", () => {
    expect(() =>
      createOpenClawRuntimeBrokerFromEnv({
        OPENCLAW_RUNTIME_BROKER_URL: "http://octogee-api:3001/",
      }),
    ).toThrow("GATEWAY_ID is required for OpenClaw runtime broker");
  });

  it("constructs the broker only when both env vars are present", () => {
    const broker = createOpenClawRuntimeBrokerFromEnv({
      OPENCLAW_RUNTIME_BROKER_URL: "http://octogee-api:3001/",
      GATEWAY_ID: "default",
    });

    expect(broker).toEqual(
      expect.objectContaining({
        redeemOpenClawWs: expect.any(Function),
        getUserGatewayId: expect.any(Function),
        resolveConversationTarget: expect.any(Function),
        resolveDirectConversationTarget: expect.any(Function),
        activityWriteReceiptsFor: expect.any(Function),
      }),
    );
  });

  it("brokers Mattermost owner and user-id resolution through octogee-api", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      calls.push({ url, body });

      if (url.endsWith("/internal/openclaw/activity/channel-owner")) {
        return new Response(JSON.stringify({ ownerUid: "uid-owner" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.endsWith("/internal/openclaw/activity/user-by-mm")) {
        return new Response(JSON.stringify({ uid: "uid-author" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    });

    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-walter",
      fetchImpl,
    });

    await expect(broker.resolveChannelOwnerUid("mm-channel")).resolves.toBe("uid-owner");
    await expect(broker.resolveOctogeeUidByMmUser("mm-user")).resolves.toBe("uid-author");
    expect(calls).toEqual([
      {
        url: "http://octogee-api:3001/internal/openclaw/activity/channel-owner",
        body: { gatewayId: "gw-walter", channelId: "mm-channel" },
      },
      {
        url: "http://octogee-api:3001/internal/openclaw/activity/user-by-mm",
        body: { gatewayId: "gw-walter", mmUserId: "mm-user" },
      },
    ]);
  });

  it("brokers chat activity demand and fails loud on a refused report", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const statuses = [202, 404, 409];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const status = statuses.shift()!;
      return new Response(
        JSON.stringify(status === 202
          ? { recorded: true, status: "requested" }
          : status === 404 ? { error: "not_found" } : { error: "builder-runtime-assignment-stale" }),
        { headers: { "content-type": "application/json" }, status },
      );
    });
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-walter",
      fetchImpl,
    });
    const activity = {
      kind: "post" as const,
      channelId: "mm-channel",
      postId: "mm-post",
      mmUserId: "mm-user",
    };

    await expect(broker.requestChatActivityDemand(activity)).resolves.toEqual({
      recorded: true,
      status: "requested",
    });
    await expect(broker.requestChatActivityDemand(activity)).resolves.toEqual({
      recorded: false,
      reason: "channel-not-found",
    });
    await expect(broker.requestChatActivityDemand(activity)).rejects.toMatchObject({ status: 409 });
    expect(calls[0]).toEqual({
      url: "http://octogee-api:3001/internal/openclaw/activity/chat-demand",
      body: { gatewayId: "gw-walter", ...activity },
    });
  });

  it("answers chat demand unavailable when the API has no chat demand route", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response("Cannot POST /internal/openclaw/activity/chat-demand", {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 404,
      }));
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-walter",
      fetchImpl,
    });

    await expect(broker.requestChatActivityDemand({
      kind: "post",
      channelId: "mm-channel",
      postId: "mm-post",
      mmUserId: "mm-user",
    })).resolves.toEqual({ recorded: false, reason: "chat-demand-unavailable" });
  });

  it("brokers preview membership without requiring Firestore access in the gateway pod", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      return new Response(JSON.stringify({ authorized: body.uid === "uid-member" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-walter",
      fetchImpl,
    });

    await expect(
      broker.authorizePreviewAccess("uid-member", "acme", "launch-room"),
    ).resolves.toBe(true);
    await expect(
      broker.authorizePreviewAccess("uid-outsider", "acme", null),
    ).resolves.toBe(false);
    expect(calls).toEqual([
      {
        url: "http://octogee-api:3001/internal/openclaw/previews/authorize",
        body: {
          gatewayId: "gw-walter",
          uid: "uid-member",
          workspaceSlug: "acme",
          projectSlug: "launch-room",
        },
      },
      {
        url: "http://octogee-api:3001/internal/openclaw/previews/authorize",
        body: {
          gatewayId: "gw-walter",
          uid: "uid-outsider",
          workspaceSlug: "acme",
          projectSlug: null,
        },
      },
    ]);
  });
});

describe("activity write receipts", () => {
  it("brokers every receipt transition with the bound gateway and channel path", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const eventKey = "a".repeat(64);
    const digest = "b".repeat(64);
    const receipt = {
      eventKey,
      payloadDigest: digest,
      state: "claimed",
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      leaseToken: "lease-1",
      leaseExpiresAt: 1_100,
      attachment: { state: "none" },
      updatedAt: 100,
    };
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/activity/write-receipts/claim")) {
        return new Response(JSON.stringify({ outcome: "claimed", receipt, recovered: false }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      if (url.endsWith("/activity/write-receipts/read")) {
        return new Response(JSON.stringify({ receipt }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    });
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-walter",
      fetchImpl,
    });
    const store = broker.activityWriteReceiptsFor("workspaces/bob/channels/coach-dm");

    await expect(store.claim({
      eventKey,
      payloadDigest: digest,
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      now: 100,
      leaseMs: 1_000,
    })).resolves.toEqual({ outcome: "claimed", receipt, recovered: false });
    await expect(store.read(eventKey)).resolves.toEqual(receipt);
    await store.markPosted(eventKey, "lease-1", "post-1", 101);
    await store.updateAttachment(eventKey, "lease-1", {
      state: "attached",
      fileId: "file-1",
      sha256: digest,
      byteLength: 8,
    }, 102);
    await store.commit(eventKey, "lease-1", 103);

    expect(calls.map(({ url, body }) => ({
      path: new URL(url).pathname,
      body,
    }))).toEqual([
      {
        path: "/internal/openclaw/activity/write-receipts/claim",
        body: {
          gatewayId: "gw-walter",
          channelDocPath: "workspaces/bob/channels/coach-dm",
          input: {
            eventKey,
            payloadDigest: digest,
            historyAnchorPostId: "anchor-1",
            leaseOwner: "pod-1",
            now: 100,
            leaseMs: 1_000,
          },
        },
      },
      {
        path: "/internal/openclaw/activity/write-receipts/read",
        body: { gatewayId: "gw-walter", channelDocPath: "workspaces/bob/channels/coach-dm", eventKey },
      },
      {
        path: "/internal/openclaw/activity/write-receipts/mark-posted",
        body: {
          gatewayId: "gw-walter",
          channelDocPath: "workspaces/bob/channels/coach-dm",
          eventKey,
          leaseToken: "lease-1",
          postId: "post-1",
          now: 101,
        },
      },
      {
        path: "/internal/openclaw/activity/write-receipts/attachment",
        body: {
          gatewayId: "gw-walter",
          channelDocPath: "workspaces/bob/channels/coach-dm",
          eventKey,
          leaseToken: "lease-1",
          attachment: {
            state: "attached",
            fileId: "file-1",
            sha256: digest,
            byteLength: 8,
          },
          now: 102,
        },
      },
      {
        path: "/internal/openclaw/activity/write-receipts/commit",
        body: {
          gatewayId: "gw-walter",
          channelDocPath: "workspaces/bob/channels/coach-dm",
          eventKey,
          leaseToken: "lease-1",
          now: 103,
        },
      },
    ]);
  });

  it("preserves receipt conflict and lease semantics across the broker", async () => {
    const broker = createOpenClawRuntimeBroker({
      baseUrl: "http://octogee-api:3001/",
      gatewayId: "gw-walter",
      fetchImpl: vi.fn(async (input) => new Response(
        JSON.stringify({
          error: String(input).endsWith("/claim") ? "receipt_conflict" : "receipt_leased",
        }),
        { headers: { "content-type": "application/json" }, status: 409 },
      )),
    });
    const store = broker.activityWriteReceiptsFor("workspaces/bob/channels/coach-dm");

    await expect(store.claim({
      eventKey: "a".repeat(64),
      payloadDigest: "b".repeat(64),
      historyAnchorPostId: "anchor-1",
      leaseOwner: "pod-1",
      now: 100,
      leaseMs: 1_000,
    })).rejects.toBeInstanceOf(ActivityReceiptConflictError);
    await expect(store.commit("a".repeat(64), "lease-1", 101))
      .rejects.toBeInstanceOf(ActivityReceiptLeaseError);
  });
});


describe("final reply notification broker", () => {
  const input = { schemaVersion: 1 as const, accountId: "alice-coach", sessionKey: `agent:octogee-alice-coach:mattermost:direct:${"o".repeat(26)}`,
    to: `user:${"o".repeat(26)}`, messageId: "p".repeat(26) };
  it("forwards only the native delivery identifiers with the bound gateway", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ accepted: true }, { status: 202 }));
    const broker = createOpenClawRuntimeBroker({ baseUrl: "http://octogee-api:3001", gatewayId: "gw-alice", fetchImpl });
    await expect(broker.notifyFinalReply(input)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith("http://octogee-api:3001/internal/openclaw/notifications/final-reply", expect.objectContaining({
      body: JSON.stringify({ gatewayId: "gw-alice", ...input }),
    }));
  });
  it("preserves a binding denial and upstream failure for local intake", async () => {
    await expect(brokerWithRedeemStatus(403, { error: "reply_binding_denied" }).notifyFinalReply(input)).rejects.toThrow("reply_binding_denied");
    await expect(brokerWithRedeemStatus(503, { error: "reply_notification_unavailable" }).notifyFinalReply(input)).rejects.toThrow();
  });
});
