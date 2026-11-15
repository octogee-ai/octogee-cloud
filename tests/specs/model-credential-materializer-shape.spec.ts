import { describe, test, expect } from "vitest";
import {
  buildModelCredentialConfigForProvider,
  type ModelCredentialConfigInput,
} from "../../gateway-supervisor/lib/model-credential-materializer";

describe("buildModelCredentialConfigForProvider — anthropic (Phase 1 shape preserved)", () => {
  test("emits auth-profiles.json with anthropic:default + provider + keyRef", () => {
    const out = buildModelCredentialConfigForProvider({
      slug: "smile-wring-011b",
      provider: "anthropic",
    });
    expect(out.authProfiles).toEqual({
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          keyRef: {
            source: "exec",
            provider: "gcp-secret-manager",
            id: "byok-smile-wring-011b-anthropic/latest",
          },
        },
      },
    });
    expect(out.models).toBeNull();
    expect(out.agentModelOverride).toBeNull();
  });
});

describe("buildModelCredentialConfigForProvider — openai (direct)", () => {
  test("emits auth-profiles.json with openai:default + provider + keyRef", () => {
    const out = buildModelCredentialConfigForProvider({
      slug: "smile-wring-011b",
      provider: "openai",
      model: "openai/gpt-5",
    });
    expect(out.authProfiles).toEqual({
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: {
            source: "exec",
            provider: "gcp-secret-manager",
            id: "byok-smile-wring-011b-openai/latest",
          },
        },
      },
    });
    expect(out.models).toBeNull();
    expect(out.agentModelOverride).toBe("openai/gpt-5");
  });

  test("agentModelOverride defaults when no model is specified", () => {
    const out = buildModelCredentialConfigForProvider({ slug: "x", provider: "openai" });
    expect(out.agentModelOverride).toBeTruthy();
    expect(out.agentModelOverride!.startsWith("openai/")).toBe(true);
  });
});

describe("buildModelCredentialConfigForProvider — openai-compatible", () => {
  test("emits models.json with api adapter, baseUrl, keyRef apiKey, and explicit models[]", () => {
    const out = buildModelCredentialConfigForProvider({
      slug: "smile-wring-011b",
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
    });
    expect(out.models).toEqual({
      providers: {
        "custom-smile-wring-011b": {
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: {
            source: "exec",
            provider: "gcp-secret-manager",
            id: "byok-smile-wring-011b-openai-compatible/latest",
          },
          models: [{ id: "anthropic/claude-3.5-sonnet", name: "anthropic/claude-3.5-sonnet" }],
        },
      },
    });
    expect(out.authProfiles).toBeNull();
    expect(out.agentModelOverride).toBe("custom-smile-wring-011b/anthropic/claude-3.5-sonnet");
  });

  test("rejects missing baseUrl", () => {
    expect(() =>
      buildModelCredentialConfigForProvider({ slug: "x", provider: "openai-compatible" }),
    ).toThrow(/baseUrl is required/i);
  });

  test("rejects malformed baseUrl (must be http(s) URL)", () => {
    expect(() =>
      buildModelCredentialConfigForProvider({
        slug: "x",
        provider: "openai-compatible",
        baseUrl: "not-a-url",
      }),
    ).toThrow(/baseUrl/i);
  });

  test("rejects missing model (openai-compatible needs explicit model)", () => {
    expect(() =>
      buildModelCredentialConfigForProvider({
        slug: "x",
        provider: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
    ).toThrow(/model is required/i);
  });

  test("rejects model strings with characters outside [A-Za-z0-9._/-]", () => {
    for (const bad of ["../etc/passwd", "model;rm", "model name", "model$x", "model\\x"]) {
      expect(() =>
        buildModelCredentialConfigForProvider({
          slug: "x",
          provider: "openai-compatible",
          baseUrl: "https://example.com/v1",
          model: bad,
        }),
      ).toThrow(/invalid model/i);
    }
  });

  test("rejects baseUrls with query strings or fragments (avoid surprise composition)", () => {
    expect(() =>
      buildModelCredentialConfigForProvider({
        slug: "x",
        provider: "openai-compatible",
        baseUrl: "https://example.com/v1?foo=bar",
        model: "x/y",
      }),
    ).toThrow(/baseUrl/i);
    expect(() =>
      buildModelCredentialConfigForProvider({
        slug: "x",
        provider: "openai-compatible",
        baseUrl: "https://example.com/v1#frag",
        model: "x/y",
      }),
    ).toThrow(/baseUrl/i);
  });

  test("does not accept inline plaintext apiKey field (defense in depth)", () => {
    const out = buildModelCredentialConfigForProvider({
      slug: "smile-wring-011b",
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "x/y",
    });
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/"apiKey"\s*:\s*"sk-/);
    expect(json).not.toMatch(/"apiKey"\s*:\s*"gsk_/);
  });
});

describe("buildModelCredentialConfigForProvider — slug grammar", () => {
  test("rejects slugs with characters that would break SM ids", () => {
    for (const bad of ["has/slash", "has.dot", "has space", ""]) {
      expect(() => buildModelCredentialConfigForProvider({ slug: bad, provider: "anthropic" })).toThrow(
        /invalid slug/i,
      );
    }
  });
});

describe("buildModelCredentialConfigForProvider — never embeds plaintext", () => {
  test.each<ModelCredentialConfigInput>([
    { slug: "smile-wring-011b", provider: "anthropic" },
    { slug: "smile-wring-011b", provider: "openai", model: "openai/gpt-5" },
    {
      slug: "smile-wring-011b",
      provider: "openai-compatible",
      baseUrl: "https://api.openrouter.ai/v1",
      model: "x/y",
    },
  ])("provider=$provider produces no plaintext key", (input) => {
    const out = buildModelCredentialConfigForProvider(input);
    const json = JSON.stringify(out);
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("gsk_");
  });
});
