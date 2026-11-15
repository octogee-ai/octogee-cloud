import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("openclaw/plugin-sdk/core", () => ({ definePluginEntry: (entry: unknown) => entry }));
import plugin from "../index.js";

afterEach(() => vi.unstubAllEnvs());

describe("native reply registration with Activity disabled", () => {
  it("relays the native final hook without opening custom Activity state or publishing projections", async () => {
    vi.stubEnv("GATEWAY_EDGE_INTERNAL_URL", "http://127.0.0.1:3001");
    vi.stubEnv("OCTOGEE_POD_RELAY_TOKEN", "relay-token");
    const hooks = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
    const openKeyedStore = vi.fn();
    const api = { config: {}, pluginConfig: { activityEnabled: false },
      logger: { error: vi.fn(), info: vi.fn() },
      runtime: { events: { onAgentEvent: vi.fn() }, state: { openKeyedStore } },
      registerGatewayMethod: vi.fn(), registerService: vi.fn(), on: vi.fn((name, handler) => hooks.set(name, handler)) };
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    try {
      plugin.register(api as never);
      expect(openKeyedStore).not.toHaveBeenCalled();
      expect(api.registerGatewayMethod).not.toHaveBeenCalled();
      const sessionKey = `agent:octogee-alice-coach:mattermost:channel:${"c".repeat(26)}`;
      const to = `channel:${"c".repeat(26)}`;
      const hook = hooks.get("message_sent");
      expect(hook).toBeDefined();
      await hook!({ success: true, isFinalReply: true, messageId: "m".repeat(26), sessionKey, to },
        { channelId: "mattermost", accountId: "alice-coach", conversationId: to, sessionKey });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "http://127.0.0.1:3001/internal/openclaw/notifications/v1/final-reply", expect.objectContaining({
          headers: { authorization: "Bearer relay-token", "content-type": "application/json" },
        }));
    } finally { globalThis.fetch = originalFetch; }
  });
});
