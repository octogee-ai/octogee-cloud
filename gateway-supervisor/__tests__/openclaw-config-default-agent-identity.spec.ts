import { describe, it, expect } from "vitest";
import {
  buildUserAgent,
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingsEnabled,
  resolveDefaultAgentIdentity,
  type UserAgentInput,
} from "../lib/openclaw-config-users.js";

const DEFAULT_AGENT = { name: "Octo", emoji: "🐙", model: "platform-openrouter/z-ai/glm-5.2" };

function mkUser(overrides: Partial<UserAgentInput> = {}): UserAgentInput {
  return {
    uid: "uid-chris",
    slug: "chris-builds-a3f2",
    customerDir: "/home/node/.openclaw/customers/chris-builds-a3f2",
    agentDir: "/home/node/.openclaw/agents/octogee-chris-builds-a3f2-coach/agent",
    defaultAgent: DEFAULT_AGENT,
    ...overrides,
  };
}

describe("resolveDefaultAgentIdentity", () => {
  const DEFAULTS = { name: "Octo", emoji: "🐙" };

  it("returns defaults when custom is undefined", () => {
    expect(resolveDefaultAgentIdentity(undefined, DEFAULTS)).toEqual(DEFAULTS);
  });

  it("uses the customized name + emoji when both are set", () => {
    expect(
      resolveDefaultAgentIdentity({ name: "Scout", emoji: "🧠" }, DEFAULTS),
    ).toEqual({ name: "Scout", emoji: "🧠" });
  });

  it("falls back to default emoji when only name is customized", () => {
    expect(
      resolveDefaultAgentIdentity({ name: "Scout", emoji: "" }, DEFAULTS),
    ).toEqual({ name: "Scout", emoji: "🐙" });
  });

  it("falls back to default name when only emoji is customized", () => {
    expect(
      resolveDefaultAgentIdentity({ name: "", emoji: "🧠" }, DEFAULTS),
    ).toEqual({ name: "Octo", emoji: "🧠" });
  });

  it("treats empty strings as missing (regression guard against `||` → `??` refactor)", () => {
    expect(
      resolveDefaultAgentIdentity({ name: "", emoji: "" }, DEFAULTS),
    ).toEqual(DEFAULTS);
  });
});

describe("buildUserAgent", () => {
  it("writes the user's agent identity into the agent's identity block", () => {
    const agent = buildUserAgent(
      mkUser({ defaultAgent: { name: "Scout", emoji: "🧠", model: "anthropic/claude-sonnet-4-6" } }),
    );
    expect(agent.identity).toEqual({ name: "Scout", emoji: "🧠" });
  });

  it("falls back to platform default identity when caller supplies the shared defaults", () => {
    const agent = buildUserAgent(mkUser());
    expect(agent.identity).toEqual({ name: "Octo", emoji: "🐙" });
  });

  it("does NOT write a `mattermost` key on the agent (OpenClaw schema rejects it)", () => {
    const agent = buildUserAgent(mkUser());
    expect(agent).not.toHaveProperty("mattermost");
  });

  it("preserves the stable agent shape without retired heartbeat config", () => {
    const agent = buildUserAgent(mkUser());
    expect(agent).not.toHaveProperty("heartbeat");
    expect(agent).toMatchObject({
      id: "octogee-chris-builds-a3f2-coach",
      name: "Octo (chris-builds-a3f2)",
      workspace: "/home/node/.openclaw/customers/chris-builds-a3f2",
      agentDir: "/home/node/.openclaw/agents/octogee-chris-builds-a3f2-coach/agent",
      model: "platform-openrouter/z-ai/glm-5.2",
      tools: { fs: { workspaceOnly: true } },
    });
  });

  it("locks a shared-gateway agent down but hands a isolated gateway agent its full OpenClaw", () => {
    const shared = buildUserAgent(mkUser());
    expect(shared.tools).toMatchObject({
      profile: "coding",
      deny: expect.arrayContaining(["exec", "process", "subagents", "terminal", "browser"]),
      fs: { workspaceOnly: true },
    });

    const user = buildUserAgent(mkUser({ hostCode: "builder-full" }));
    expect(user).not.toHaveProperty("tools");
  });

  it("threads the user's slug into the agent display name", () => {
    const agent = buildUserAgent(
      mkUser({ slug: "chris-shop", defaultAgent: { ...DEFAULT_AGENT, name: "Scout" } }),
    );
    expect(agent.name).toBe("Scout (chris-shop)");
  });

  it("emits caller-provided memory search at the native canonical path", () => {
    const memorySearch = platformOpenAiEmbeddingMemorySearch(
      "octogee-chris-builds-a3f2-coach",
      {},
    );

    const agent = buildUserAgent(mkUser({ memorySearch }));

    expect(agent).not.toHaveProperty("memorySearch");
    expect(agent).toHaveProperty("memory.search", {
      provider: "openai-compatible",
      remote: {
        baseUrl: "http://llm-broker:3010/v1",
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-embedding-token-openai-octogee-chris-builds-a3f2-coach",
        },
      },
      model: "text-embedding-3-small",
    });
  });
});

describe("platformOpenAiEmbeddingMemorySearch", () => {
  it("normalizes the operator-selected endpoint and model", () => {
    expect(
      platformOpenAiEmbeddingMemorySearch("octogee-alice-coach", {
        PLATFORM_OPENAI_BASE_URL: "https://llm-broker.example.test/v1/",
        OPENAI_EMBEDDINGS_MODEL: "custom-embed-v1",
      }),
    ).toEqual({
      provider: "openai-compatible",
      remote: {
        baseUrl: "https://llm-broker.example.test/v1",
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-embedding-token-openai-octogee-alice-coach",
        },
      },
      model: "custom-embed-v1",
    });
  });

  it("treats only explicit true-like env values as enabled", () => {
    expect(platformOpenAiEmbeddingsEnabled({ OPENAI_EMBEDDINGS_ENABLED: "true" })).toBe(true);
    expect(platformOpenAiEmbeddingsEnabled({ OPENAI_EMBEDDINGS_ENABLED: "1" })).toBe(true);
    expect(platformOpenAiEmbeddingsEnabled({ OPENAI_EMBEDDINGS_ENABLED: "false" })).toBe(false);
    expect(platformOpenAiEmbeddingsEnabled({})).toBe(false);
  });
});
