import { describe, expect, it, vi } from "vitest";

import {
  DISPATCH_CONTEXT_PATH,
  SESSION_CONTEXT_PATH,
  SessionContextError,
  createSessionContextClient,
} from "../session-context-client.js";

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

describe("session context client", () => {
  const externallyBounded = async (promise: Promise<unknown>): Promise<unknown> =>
    Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 30)),
    ]);

  it("authorizes a pre-dispatch route through the tenant-bound runtime broker", async () => {
    const fetchImpl = vi.fn(async () => response(200, { authorized: true }));
    const client = createSessionContextClient({
      brokerUrl: "http://broker.test:3001/",
      fetchImpl,
      tokenProvider: async () => "projected-token",
    });

    await expect(client.authorizeDispatch({
      agentId: "octogee-bob-coach",
      accountId: "bob-coach",
      conversationId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
      senderId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      sessionKey: "agent:octogee-bob-coach:mattermost:channel:bbbbbbbbbbbbbbbbbbbbbbbbbb",
    })).resolves.toEqual({ authorized: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://broker.test:3001${DISPATCH_CONTEXT_PATH}`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          agentId: "octogee-bob-coach",
          accountId: "bob-coach",
          conversationId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
          senderId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
          sessionKey: "agent:octogee-bob-coach:mattermost:channel:bbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
      }),
    );
  });

  it("reads the current channel purpose through the tenant-bound runtime broker", async () => {
    const fetchImpl = vi.fn(async () => response(200, {
      authorized: true,
      purpose: "Acceptance marker ALPHA",
    }));
    const client = createSessionContextClient({
      brokerUrl: "http://broker.test:3001/",
      fetchImpl,
      tokenProvider: async () => "projected-token",
    });

    await expect(
      client.read({ agentId: "octogee-bob-coach", accountId: "bob-coach", channelId: "mm-task-alpha" }),
    ).resolves.toEqual({ authorized: true, purpose: "Acceptance marker ALPHA" });
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://broker.test:3001${SESSION_CONTEXT_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-K8s-Sa-Token": "projected-token",
        },
        body: JSON.stringify({
          agentId: "octogee-bob-coach",
          accountId: "bob-coach",
          channelId: "mm-task-alpha",
        }),
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("carries the exact direct-message envelope when the run has one", async () => {
    const fetchImpl = vi.fn(async () => response(200, { authorized: true }));
    const client = createSessionContextClient({
      brokerUrl: "http://broker.test:3001/",
      fetchImpl,
      tokenProvider: async () => "projected-token",
    });
    const senderId = "pppppppppppppppppppppppppp";
    const sessionKey = `agent:octogee-bob-coach:mattermost:direct:${senderId}`;

    await expect(client.read({
      agentId: "octogee-bob-coach",
      accountId: "bob-coach",
      channelId: "direct-channel-id",
      senderId,
      sessionKey,
    })).resolves.toEqual({ authorized: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      `http://broker.test:3001${SESSION_CONTEXT_PATH}`,
      expect.objectContaining({
        body: JSON.stringify({
          agentId: "octogee-bob-coach",
          accountId: "bob-coach",
          channelId: "direct-channel-id",
          senderId,
          sessionKey,
        }),
      }),
    );
  });

  it("requires a positive authorization response for ordinary and unknown channels", async () => {
    const ordinary = createSessionContextClient({
      fetchImpl: vi.fn(async () => response(200, { authorized: true })),
      tokenProvider: async () => "projected-token",
    });
    await expect(
      ordinary.read({ agentId: "octogee-bob-coach", accountId: "bob-coach", channelId: "mm-general" }),
    ).resolves.toEqual({ authorized: true });

    const client = createSessionContextClient({
      fetchImpl: vi.fn(async () => response(404, { error: "not_found" })),
      tokenProvider: async () => "projected-token",
    });

    await expect(
      client.read({ agentId: "octogee-bob-coach", accountId: "bob-coach", channelId: "mm-general" }),
    ).rejects.toMatchObject({ code: "control-error" });
  });

  it("fails loudly on missing auth, broker denial, and malformed success", async () => {
    const withoutAuth = createSessionContextClient({
      fetchImpl: vi.fn(),
      tokenProvider: async () => null,
    });
    await expect(
      withoutAuth.read({ agentId: "octogee-bob-coach", accountId: "bob-coach", channelId: "mm-task" }),
    ).rejects.toMatchObject({ code: "auth-unavailable" });

    const denied = createSessionContextClient({
      fetchImpl: vi.fn(async () => response(403, { error: "forbidden" })),
      tokenProvider: async () => "projected-token",
    });
    await expect(
      denied.read({ agentId: "octogee-bob-coach", accountId: "bob-coach", channelId: "mm-task" }),
    ).rejects.toEqual(expect.objectContaining<Partial<SessionContextError>>({
      code: "control-error",
    }));

    const malformed = createSessionContextClient({
      fetchImpl: vi.fn(async () => response(200, { authorized: true, purpose: 42 })),
      tokenProvider: async () => "projected-token",
    });
    await expect(
      malformed.read({ agentId: "octogee-bob-coach", accountId: "bob-coach", channelId: "mm-task" }),
    ).rejects.toMatchObject({ code: "bad-response" });
  });

  it.each([[403, "control-error"], [404, "control-error"], [429, "control-error"], [500, "unavailable"], [503, "unavailable"]])("classifies HTTP %s without authorizing dispatch", async (status, code) => {
    const client = createSessionContextClient({
      fetchImpl: vi.fn(async () => response(status as number, { error: "broker detail" })),
      tokenProvider: async () => "projected-token",
    });
    await expect(client.authorizeDispatch({ agentId: "coach", accountId: "coach", conversationId: "channel", senderId: "sender", sessionKey: "session" })).rejects.toMatchObject({ code });
  });

  it("classifies a network failure as unavailable without authorizing dispatch", async () => {
    const client = createSessionContextClient({
      fetchImpl: vi.fn(async () => { throw new Error("connection reset"); }),
      tokenProvider: async () => "projected-token",
    });
    await expect(client.authorizeDispatch({ agentId: "coach", accountId: "coach", conversationId: "channel", senderId: "sender", sessionKey: "session" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("aborts a stalled lookup before the OpenClaw hook deadline", async () => {
    const fetchImpl = vi.fn(
      async (
        _url: string,
        init?: { signal?: AbortSignal },
      ): Promise<ReturnType<typeof response>> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(response(200, { authorized: true, purpose: "Too late" })),
            30,
          );
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    const client = createSessionContextClient({
      fetchImpl,
      tokenProvider: async () => "projected-token",
      timeoutMs: 5,
    });

    await expect(
      client.read({ agentId: "octogee-bob-coach", accountId: "bob-coach", channelId: "mm-task" }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("timed out"),
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("bounds token acquisition inside the lookup deadline", async () => {
    const client = createSessionContextClient({
      fetchImpl: vi.fn(),
      tokenProvider: async () => new Promise<string | null>(() => {}),
      timeoutMs: 5,
    });

    await expect(externallyBounded(client.authorizeDispatch({
      agentId: "octogee-bob-coach",
      accountId: "bob-coach",
      conversationId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
      senderId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      sessionKey: "agent:octogee-bob-coach:mattermost:channel:bbbbbbbbbbbbbbbbbbbbbbbbbb",
    }))).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("timed out"),
    });
  });

  it("rejects on deadline when fetch ignores the abort signal", async () => {
    const client = createSessionContextClient({
      fetchImpl: vi.fn(async () => new Promise<ReturnType<typeof response>>(() => {})),
      tokenProvider: async () => "projected-token",
      timeoutMs: 5,
    });

    await expect(externallyBounded(client.authorizeDispatch({
      agentId: "octogee-bob-coach",
      accountId: "bob-coach",
      conversationId: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
      senderId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      sessionKey: "agent:octogee-bob-coach:mattermost:channel:bbbbbbbbbbbbbbbbbbbbbbbbbb",
    }))).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("timed out"),
    });
  });

  it("keeps the lookup deadline active while reading the response body", async () => {
    const fetchImpl = vi.fn(async (
      _url: string,
      init?: { signal?: AbortSignal },
    ) => ({
      ...response(200, { authorized: true, purpose: "unused" }),
      json: vi.fn(
        async () =>
          new Promise<unknown>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      ),
    }));
    const client = createSessionContextClient({
      fetchImpl,
      tokenProvider: async () => "projected-token",
      timeoutMs: 5,
    });

    await expect(
      client.read({ agentId: "octogee-bob-coach", accountId: "bob-coach", channelId: "mm-task" }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("timed out"),
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("consumes a not-found response body under the lookup deadline", async () => {
    const fetchImpl = vi.fn(async (
      _url: string,
      init?: { signal?: AbortSignal },
    ) => ({
      ...response(404, { error: "not_found" }),
      json: vi.fn(
        async () =>
          new Promise<unknown>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          }),
      ),
    }));
    const client = createSessionContextClient({
      fetchImpl,
      tokenProvider: async () => "projected-token",
      timeoutMs: 5,
    });

    await expect(
      client.read({ agentId: "octogee-bob-coach", accountId: "bob-coach", channelId: "mm-task" }),
    ).rejects.toMatchObject({
      code: "control-error",
      message: expect.stringContaining("timed out"),
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
