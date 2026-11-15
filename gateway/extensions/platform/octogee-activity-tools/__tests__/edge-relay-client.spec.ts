import { describe, expect, it, vi } from "vitest";
import { ActivityDeliveryError } from "../durable-outbox.js";
import {
  ACTIVITY_INGEST_PATH,
  FINAL_REPLY_RELAY_PATH,
  DIRECT_ACTIVITY_TARGET_PATH,
  VOICE_EVENT_RELAY_PATH,
  createEdgeRelayClient,
} from "../edge-relay-client.js";
import type { AgentActivityAppend, AgentActivityEnvelopeV1 } from "../activity-types.js";

const EDGE_URL = "http://127.0.0.1:3001";
const EDGE_ENV = { GATEWAY_EDGE_INTERNAL_URL: EDGE_URL } as NodeJS.ProcessEnv;

function envelope(): AgentActivityEnvelopeV1 {
  return {
    schemaVersion: 1,
    eventKey: "a".repeat(64),
    emittedAt: "2026-08-27T00:00:00.000Z",
    ref: {
      conversationId: "channel-1",
      turnId: "root-1",
      runId: "run-1",
      agentId: "coach-1",
      sessionKey: "agent:coach-1:mattermost:channel:channel-1",
      origin: "human",
      mainChannelId: "channel-1",
      mainRootPostId: "root-1",
      itemId: "octogee:run-root",
      ordinal: 0,
      semanticVersion: 1,
    },
    redaction: { policy: "octogee-v1", appliedAt: "producer" },
    type: "turn.started",
  };
}

function acknowledgement(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    outcome: "persisted",
    postIds: ["activity-root-1"],
    activityRootPostId: "activity-root-1",
    ...overrides,
  });
}

describe("gateway-edge relay client", () => {
  it("sends only final reply routing over the authenticated platform loopback relay", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    const client = createEdgeRelayClient({ gatewayToken: "relay-token", env: EDGE_ENV, fetchImpl: fetchMock });
    const input = { schemaVersion: 1 as const, accountId: "alice-coach", sessionKey: "canonical",
      to: "channel:provider-channel", messageId: "delivered-post" };
    await client.publishFinalReply(input);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${EDGE_URL}${FINAL_REPLY_RELAY_PATH}`, {
      method: "POST", redirect: "error",
      headers: { authorization: "Bearer relay-token", "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(client.publishFinalReply(input)).rejects.toThrow("reply relay returned 403");
  });
  it("resolves a physical direct channel only through the authenticated local edge", async () => {
    const candidate = {
      sessionKey: `agent:coach-1:mattermost:direct:${"o".repeat(26)}:thread:${"r".repeat(26)}`,
      agentId: "coach-1",
      ownerUserId: "o".repeat(26),
      rootPostId: "r".repeat(26),
      inboundPostId: "i".repeat(26),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      target: {
        sessionKey: candidate.sessionKey,
        agentId: candidate.agentId,
        conversationId: "d".repeat(26),
        rootPostId: candidate.rootPostId,
      },
    }), { status: 200 }));
    const client = createEdgeRelayClient({
      gatewayToken: "gateway-token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      env: EDGE_ENV,
    });

    await expect(client.resolveDirectActivityTarget(candidate)).resolves.toMatchObject({
      conversationId: "d".repeat(26),
      rootPostId: candidate.rootPostId,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${EDGE_URL}${DIRECT_ACTIVITY_TARGET_PATH}`,
      expect.objectContaining({
        method: "POST",
        headers: { authorization: "Bearer gateway-token", "content-type": "application/json" },
        body: JSON.stringify(candidate),
      }),
    );
  });

  it("authenticates durable Activity delivery and classifies the intake result", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(acknowledgement(), { status: 201 }));
    const client = createEdgeRelayClient({ edgeUrl: `${EDGE_URL}/`, gatewayToken: "gateway-token", fetchImpl: fetchMock as unknown as typeof fetch, env: EDGE_ENV });

    await client.deliverActivity({ envelope: envelope() });

    expect(fetchMock).toHaveBeenCalledWith(
      `${EDGE_URL}${ACTIVITY_INGEST_PATH}`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: { authorization: "Bearer gateway-token", "content-type": "application/json" },
      }),
    );
  });

  it("sends a durable redacted attachment through the gateway multipart intake contract", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(acknowledgement({
      outcome: "duplicate",
      postIds: ["activity-item-1"],
    }), { status: 200 }));
    const client = createEdgeRelayClient({ gatewayToken: "gateway-token", fetchImpl: fetchMock as unknown as typeof fetch, env: EDGE_ENV });
    const attached: AgentActivityAppend = {
      envelope: {
        ...envelope(),
        type: "item.completed",
        item: {
          kind: "plan",
          status: "completed",
          summary: "Plan updated",
          attachment: { filename: "source-plan.md", mediaType: "text/markdown", byteLength: 15, sha256: "a".repeat(64), multipartField: "detail" },
        },
      },
      attachmentBody: "redacted detail",
    };

    await client.deliverActivity(attached);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.redirect).toBe("error");
    expect(request.headers).toEqual({ authorization: "Bearer gateway-token" });
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect(JSON.parse(String(form.get("envelope")))).toEqual(attached.envelope);
    expect(await (form.get("detail") as File).text()).toBe("redacted detail");
  });

  it("rejects an attachment body without the durable attachment metadata", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = createEdgeRelayClient({ gatewayToken: "token", fetchImpl, env: EDGE_ENV });

    await expect(client.deliverActivity({ envelope: envelope(), attachmentBody: "redacted detail" })).rejects.toEqual(expect.objectContaining({ retryable: false }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps server failures retryable and rejects malformed envelopes permanently", async () => {
    const unavailable = createEdgeRelayClient({
      gatewayToken: "token",
      fetchImpl: vi.fn(async () => new Response("", { status: 503 })) as unknown as typeof fetch,
      env: EDGE_ENV,
    });
    const rejected = createEdgeRelayClient({
      gatewayToken: "token",
      fetchImpl: vi.fn(async () => new Response("", { status: 422 })) as unknown as typeof fetch,
      env: EDGE_ENV,
    });

    await expect(unavailable.deliverActivity({ envelope: envelope() })).rejects.toEqual(expect.objectContaining({
      name: "Error",
      retryable: true,
    } satisfies Partial<ActivityDeliveryError>));
    await expect(rejected.deliverActivity({ envelope: envelope() })).rejects.toEqual(expect.objectContaining({
      name: "Error",
      retryable: false,
    } satisfies Partial<ActivityDeliveryError>));
  });

  it.each([
    ["malformed", "not-json"],
    ["human root", acknowledgement({ activityRootPostId: "root-1", postIds: ["root-1"] })],
    ["missing post IDs", acknowledgement({ postIds: [] })],
    ["root creation mismatch", acknowledgement({ postIds: ["activity-item-1"] })],
  ])("keeps a 2xx %s acknowledgement durable for retry", async (_name, body) => {
    const client = createEdgeRelayClient({
      gatewayToken: "token",
      fetchImpl: vi.fn(async () => new Response(body, { status: 201 })) as unknown as typeof fetch,
      env: EDGE_ENV,
    });

    await expect(client.deliverActivity({ envelope: envelope() })).rejects.toEqual(expect.objectContaining({
      retryable: true,
    } satisfies Partial<ActivityDeliveryError>));
  });

  it("accepts a later item acknowledgement bound by the authenticated intake to the structured root", async () => {
    const fetchMock = vi.fn(async () => new Response(acknowledgement({
      postIds: ["activity-item-1"],
    }), { status: 201 }));
    const client = createEdgeRelayClient({
      gatewayToken: "token",
      fetchImpl: fetchMock as unknown as typeof fetch,
      env: EDGE_ENV,
    });
    const item: AgentActivityAppend = {
      envelope: {
        ...envelope(),
        type: "item.completed",
        ref: {
          ...envelope().ref,
          itemId: "tool-1:result",
          ordinal: 1,
        },
        item: {
          kind: "tool",
          status: "completed",
          summary: "Tool completed",
        },
      },
    };

    await expect(client.deliverActivity(item)).resolves.toBeUndefined();
  });

  it("uses the same authenticated local relay for heartbeats and voice events", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("", { status: 202 }));
    const client = createEdgeRelayClient({ gatewayToken: "token", fetchImpl: fetchMock as unknown as typeof fetch, env: EDGE_ENV });

    await client.heartbeat("mom-coach", 10);
    await client.publishVoice("mom-coach", { kind: "inbound", messageId: "post-1", sessionKey: "agent:mom-coach:mattermost:channel:c1", ts: 11 });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${EDGE_URL}${VOICE_EVENT_RELAY_PATH}`,
      `${EDGE_URL}${VOICE_EVENT_RELAY_PATH}`,
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      schemaVersion: 1,
      agentId: "mom-coach",
      kind: "ready",
      ts: 10,
    });
  });

  it.each([
    "http://attacker.example",
    "https://127.0.0.1:3001",
    "http://127.0.0.1:3002",
    "http://user@127.0.0.1:3001",
    "http://127.0.0.1:3001/relay",
  ])("rejects non-platform relay URL %s before transmitting credentials", (edgeUrl) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(() => createEdgeRelayClient({
      edgeUrl,
      gatewayToken: "gateway-token",
      fetchImpl,
      env: EDGE_ENV,
    })).toThrow(/platform-owned internal origin|HTTP loopback origin/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback platform relay environment before transmitting credentials", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(() => createEdgeRelayClient({
      gatewayToken: "gateway-token",
      fetchImpl,
      env: { GATEWAY_EDGE_INTERNAL_URL: "http://gateway-token-capture.example" },
    })).toThrow("platform gateway-edge URL must be an HTTP loopback origin");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

});
