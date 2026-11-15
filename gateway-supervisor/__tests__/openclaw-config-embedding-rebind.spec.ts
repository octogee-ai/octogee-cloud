import { describe, expect, it } from "vitest";
import {
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingSecretId,
  rebindPlatformEmbeddingRefs,
} from "../lib/openclaw-config-users.js";

function platformRef(agentId: string): Record<string, unknown> {
  return {
    provider: "openai-compatible",
    remote: {
      baseUrl: "https://api.openai.com/v1",
      apiKey: {
        source: "exec",
        provider: "gcp-secret-manager",
        id: platformOpenAiEmbeddingSecretId(agentId),
      },
    },
    model: "text-embedding-3-small",
  };
}

function defaultAgent(id: string, memorySearch?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name: `Agent (${id})`,
    workspace: `/customers/${id}`,
    ...(memorySearch !== undefined ? { memorySearch } : {}),
  };
}

describe("rebindPlatformEmbeddingRefs (redacted-array round-trip self-heal)", () => {
  it("uses the purpose-scoped embedding token ref", () => {
    expect(platformOpenAiEmbeddingSecretId("octogee-alice-coach")).toBe(
      "agent-embedding-token-openai-octogee-alice-coach",
    );
  });

  it("rewrites a platform ref copied from ANOTHER agent back to the owning agent id (the r2 shifted-ref corruption)", () => {
    const corrupted = defaultAgent("octogee-livefixture-coach", platformRef("octogee-tester5-coach"));

    const out = rebindPlatformEmbeddingRefs([corrupted]);

    expect(out).toEqual([
      defaultAgent("octogee-livefixture-coach", platformRef("octogee-livefixture-coach")),
    ]);
  });

  it("rebinds the beta memory.search representation without reviving memorySearch", () => {
    const corrupted = {
      ...defaultAgent("octogee-livefixture-coach"),
      memory: { search: platformRef("octogee-tester5-coach") },
    };

    const out = rebindPlatformEmbeddingRefs([corrupted]) as Array<{
      memory: { search: { remote: { apiKey: { id: string } } } };
      memorySearch?: unknown;
    }>;

    expect(out[0]?.memory.search.remote.apiKey.id).toBe(
      platformOpenAiEmbeddingSecretId("octogee-livefixture-coach"),
    );
    expect(out[0]).not.toHaveProperty("memorySearch");
  });

  it("keeps every agent bound to platformOpenAiEmbeddingSecretId(its own agent id) across a multi-coach list", () => {
    const list = [
      defaultAgent("octogee-alice-coach", platformRef("octogee-tester5-coach")),
      defaultAgent("octogee-bob-coach", platformRef("octogee-alice-coach")),
      defaultAgent("octogee-carol-coach", platformRef("octogee-carol-coach")),
    ];

    const out = rebindPlatformEmbeddingRefs(list) as Array<{
      id: string;
      memorySearch: { remote: { apiKey: { id: string } } };
    }>;

    for (const agent of out) {
      expect(agent.memorySearch.remote.apiKey.id).toBe(platformOpenAiEmbeddingSecretId(agent.id));
    }
  });

  it("returns correctly bound entries unchanged (same reference) and never mutates its input", () => {
    const bound = defaultAgent("octogee-alice-coach", platformOpenAiEmbeddingMemorySearch("octogee-alice-coach"));
    const corrupted = defaultAgent("octogee-bob-coach", platformRef("octogee-alice-coach"));
    const corruptedSnapshot = structuredClone(corrupted);

    const out = rebindPlatformEmbeddingRefs([bound, corrupted]);

    expect(out[0]).toBe(bound);
    expect(corrupted).toEqual(corruptedSnapshot);
  });

  it("leaves BYO api keys, absent/malformed memorySearch, and non-agent entries untouched", () => {
    const byo = defaultAgent("octogee-alice-coach", {
      provider: "openai-compatible",
      remote: { baseUrl: "https://api.example.com", apiKey: { source: "exec", provider: "gcp-secret-manager", id: "byo-openai-alice" } },
    });
    const noMemorySearch = defaultAgent("octogee-bob-coach");
    const malformedMemorySearch = defaultAgent("octogee-carol-coach", { remote: "nope" } as Record<string, unknown>);
    const list = [byo, noMemorySearch, malformedMemorySearch, "garbage", null, { name: "no-id" }];

    const out = rebindPlatformEmbeddingRefs(list);

    expect(out).toEqual(list);
    expect(out[0]).toBe(byo);
  });

  it("rebinds a REDACTED platform-shaped ref to the agent's own id — config.get sentinels are what the server shifts by index (2026-07-12 r9 wedge)", () => {
    const redacted = defaultAgent("octogee-livefixture-coach", {
      provider: "openai-compatible",
      remote: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: { source: "exec", provider: "gcp-secret-manager", id: "__OPENCLAW_REDACTED__" },
      },
      model: "text-embedding-3-small",
    });

    const out = rebindPlatformEmbeddingRefs([redacted]);

    expect(
      (out[0] as { memorySearch: { remote: { apiKey: { id: string } } } }).memorySearch.remote
        .apiKey.id,
    ).toBe(platformOpenAiEmbeddingSecretId("octogee-livefixture-coach"));
  });

  it("leaves a redacted ref of a DIFFERENT provider/source shape untouched", () => {
    const foreign = defaultAgent("octogee-alice-coach", {
      provider: "openai-compatible",
      remote: { baseUrl: "https://api.example.com", apiKey: { source: "env", id: "__OPENCLAW_REDACTED__" } },
    });

    const out = rebindPlatformEmbeddingRefs([foreign]);

    expect(out[0]).toBe(foreign);
  });

  it("rebinds a project agent's platform ref to the project agent's own id", () => {
    const projectAgent = defaultAgent("octogee-alice-proj-p1-coach", platformRef("octogee-alice-coach"));

    const out = rebindPlatformEmbeddingRefs([projectAgent]);

    expect(out).toEqual([
      defaultAgent("octogee-alice-proj-p1-coach", platformRef("octogee-alice-proj-p1-coach")),
    ]);
  });
});
