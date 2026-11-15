import { describe, expect, it, vi } from "vitest";
import {
  ChannelSessionMattermostError,
  createChannelSessionMattermostClient,
  parseNativeModelResult,
  pickCorrelatedAgentReply,
} from "./channel-session-model-control.js";

describe("channel session native model control", () => {
  it('sends caller-authenticated multipart files to the fixed internal Mattermost upload endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ file_infos: [] }), { status: 200 }));
    const client = createChannelSessionMattermostClient({ baseUrl: 'http://mattermost.octogee.svc.cluster.local:8065', token: 'a'.repeat(32), fetchImpl });
    await client.uploadFiles('c'.repeat(26), [{ fileName: 'photo.png', mimeType: 'image/png', bytes: Buffer.from([0, 1, 2]) }]);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('http://mattermost.octogee.svc.cluster.local:8065/api/v4/files', expect.objectContaining({ method: 'POST', redirect: 'error' }));
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: `Bearer ${'a'.repeat(32)}` });
    expect(init.headers).not.toHaveProperty('content-type');
    const form = init.body as FormData;
    expect(form.get('channel_id')).toBe('c'.repeat(26));
    const file = form.get('files') as File;
    expect(file.name).toBe('photo.png'); expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([0, 1, 2]));
  });
  it("accepts only the earliest correlated reply from the bound Agent", () => {
    const reply = pickCorrelatedAgentReply([
      { id: "foreign", type: "", root_id: "root", channel_id: "channel", user_id: "other", create_at: 11, message: "no" },
      { id: "late", type: "", root_id: "root", channel_id: "channel", user_id: "agent", create_at: 13, message: "late" },
      { id: "early", type: "", root_id: "root", channel_id: "channel", user_id: "agent", create_at: 12, message: "early" },
      { id: "old", type: "", root_id: "root", channel_id: "channel", user_id: "agent", create_at: 9, message: "old" },
    ], { rootPostId: "root", channelId: "channel", agentUserId: "agent", commandCreatedAt: 10 });
    expect(reply?.id).toBe("early");
  });

  it("parses providers, nested model refs, current model, and native outcomes", () => {
    expect(parseNativeModelResult("listModels", "Providers:\n- anthropic (2)\n- claude-cli (5)\n\nUse: /models <provider>")).toMatchObject({ providers: ["anthropic", "claude-cli"], outcome: "unknown" });
    expect(parseNativeModelResult("listModelsByProvider", "Models (OpenRouter) — showing 1-2 of 2 (page 1/1)\n- platform-openrouter/z-ai/glm-5.2\n- platform-openrouter/deepseek/deepseek-v4-pro")).toMatchObject({ models: ["platform-openrouter/z-ai/glm-5.2", "platform-openrouter/deepseek/deepseek-v4-pro"] });
    expect(parseNativeModelResult("getSessionModel", "🦞 OpenClaw 2026.7.1\n🧠 Model: claude-cli/claude-sonnet-5 · 🔑 api-key")).toMatchObject({ currentModel: "claude-cli/claude-sonnet-5" });
    expect(parseNativeModelResult("setSessionModel", "Model set to claude-cli/claude-sonnet-5 for this session.")).toMatchObject({ outcome: "applied", currentModel: "claude-cli/claude-sonnet-5" });
    expect(parseNativeModelResult("resetSessionModel", "Model reset to default (platform-openrouter/z-ai/glm-5.2).")).toMatchObject({ outcome: "applied", currentModel: "platform-openrouter/z-ai/glm-5.2" });
    expect(parseNativeModelResult("setSessionModel", "Model ‘x/y’ is not allowed.")).toMatchObject({ outcome: "rejected" });
  });

  it("proves the bearer identity and bounds Mattermost responses", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "caller" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("x".repeat(1025), { status: 200 }));
    const client = createChannelSessionMattermostClient({
      baseUrl: "http://mattermost.octogee.svc.cluster.local:8065",
      token: "a".repeat(32),
      fetchImpl,
      maxResponseBytes: 1024,
    });
    await expect(client.getCurrentUserId()).resolves.toBe("caller");
    await expect(client.getJson(["channels", "channel", "members", "caller"])).rejects.toThrow(/size limit/);
  });

  it("accepts a verbose bounded Mattermost page above the former 64 KiB cap", async () => {
    const payload = { value: "x".repeat(70 * 1024) };
    const client = createChannelSessionMattermostClient({
      baseUrl: "http://mattermost.octogee.svc.cluster.local:8065",
      token: "a".repeat(32),
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })),
    });

    await expect(client.getJson(["channels", "channel"])).resolves.toEqual(payload);
    expect(() => createChannelSessionMattermostClient({
      baseUrl: "http://mattermost.octogee.svc.cluster.local:8065",
      token: "a".repeat(32),
      maxResponseBytes: 8 * 1024 * 1024 + 1,
    })).toThrow("invalid Mattermost response size limit");
  });

  it("rejects external Mattermost endpoints before fetch", () => {
    expect(() => createChannelSessionMattermostClient({ baseUrl: "https://evil.example", token: "a".repeat(32) })).toThrow(/base URL/);
  });

  it("classifies Mattermost transport failures as upstream failures", async () => {
    const client = createChannelSessionMattermostClient({
      baseUrl: "http://mattermost.octogee.svc.cluster.local:8065",
      token: "a".repeat(32),
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    });
    await expect(client.getJson(["users", "me"])).rejects.toBeInstanceOf(ChannelSessionMattermostError);
  });

  it("propagates a caller deadline into in-flight Mattermost requests", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const client = createChannelSessionMattermostClient({
      baseUrl: "http://mattermost.octogee.svc.cluster.local:8065",
      token: "a".repeat(32),
      signal: controller.signal,
      fetchImpl: vi.fn(async (_url, init) => {
        const signal = init?.signal as AbortSignal;
        requestSignal = signal;
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    });
    const request = client.getJson(["users", "me"]);

    controller.abort(new Error("RPC deadline expired"));

    await expect(request).rejects.toThrow("RPC deadline expired");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("reads bounded channel history in provider order with an exact cursor", async () => {
    const channelId = "c".repeat(26);
    const older = "o".repeat(26);
    const first = "a".repeat(26);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      order: [first],
      posts: {
        [first]: {
          id: first,
          type: "",
          root_id: "",
          channel_id: channelId,
          user_id: "u".repeat(26),
          create_at: 100,
          update_at: 110,
          edit_at: 90,
          delete_at: 0,
          pending_post_id: "persisted-idempotency-key",
          message: "hello",
          props: { octogee: { projectionKind: "run" } },
        },
      },
      prev_post_id: older,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createChannelSessionMattermostClient({
      baseUrl: "http://mattermost.octogee.svc.cluster.local:8065",
      token: "a".repeat(32),
      fetchImpl,
    });

    await expect(client.listChannelPosts(channelId, undefined, 1)).resolves.toEqual({
      posts: [expect.objectContaining({
        id: first,
        message: "hello",
        edit_at: 90,
        pending_post_id: "persisted-idempotency-key",
        file_ids: [],
      })],
      nextBefore: older,
      reachedEnd: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://mattermost.octogee.svc.cluster.local:8065/api/v4/channels/${channelId}/posts?per_page=1`,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it.each([
    ["edit timestamp", { edit_at: 1.5 }],
    ["delete timestamp", { delete_at: -1 }],
    ["file ids", { file_ids: [1] }],
    ["post type", { type: 1 }],
  ])("rejects an invalid optional post %s", async (_label, invalid) => {
    const channelId = "c".repeat(26);
    const postId = "p".repeat(26);
    const client = createChannelSessionMattermostClient({
      baseUrl: "http://mattermost.octogee.svc.cluster.local:8065",
      token: "a".repeat(32),
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        order: [postId],
        posts: {
          [postId]: {
            id: postId,
            type: "",
            root_id: "",
            channel_id: channelId,
            user_id: "u".repeat(26),
            create_at: 100,
            update_at: 100,
            edit_at: 0,
            delete_at: 0,
            pending_post_id: "",
            file_ids: [],
            message: "hello",
            props: {},
            ...invalid,
          },
        },
      }), { status: 200 })),
    });

    await expect(client.listChannelPosts(channelId)).rejects.toThrow(
      "Mattermost channel history response was invalid",
    );
  });

  it.each(["type", "update_at", "edit_at", "delete_at", "pending_post_id", "props"])(
    "rejects a history post without required %s evidence",
    async (missingField) => {
      const channelId = "c".repeat(26);
      const postId = "p".repeat(26);
      const value: Record<string, unknown> = {
        id: postId,
        type: "",
        root_id: "",
        channel_id: channelId,
        user_id: "u".repeat(26),
        create_at: 100,
        update_at: 100,
        edit_at: 0,
        delete_at: 0,
        pending_post_id: "",
        message: "hello",
        props: {},
      };
      delete value[missingField];
      const client = createChannelSessionMattermostClient({
        baseUrl: "http://mattermost.octogee.svc.cluster.local:8065",
        token: "a".repeat(32),
        fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({
          order: [postId],
          posts: { [postId]: value },
        }), { status: 200 })),
      });

      await expect(client.listChannelPosts(channelId)).rejects.toThrow(
        "Mattermost channel history response was invalid",
      );
    },
  );
});
