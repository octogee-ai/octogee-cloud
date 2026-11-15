import { describe, test, expect } from "vitest";
import { validateProviderKey, isSupportedProvider, type Provider } from "../model-credentials/provider-key-format.js";

describe("isSupportedProvider", () => {
  test.each<[string, boolean]>([
    ["anthropic", true],
    ["openai", true],
    ["openai-compatible", true],
    ["grok", true],
    ["openrouter", true],
    ["minimax", true],
    ["codex", false],
    ["bogus", false],
    ["", false],
  ])("%s → %s", (input, expected) => {
    expect(isSupportedProvider(input)).toBe(expected);
  });
});

describe("validateProviderKey — anthropic (Phase 1 preserved)", () => {
  test("delegates to validateAnthropicKey", () => {
    const r = validateProviderKey(
      "anthropic",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGHIJKLMNOP",
    );
    expect(r.valid).toBe(true);
  });

  test("rejects sk-proj keys for anthropic provider", () => {
    const r = validateProviderKey("anthropic", "sk-proj-abc123def456ghi789jkl012mno345pqr678");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/sk-ant-/);
  });
});

describe("validateProviderKey — openai", () => {
  test("accepts standard sk-... keys", () => {
    const r = validateProviderKey("openai", "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(r.valid).toBe(true);
    expect(r.normalized).toBeDefined();
  });

  test("accepts sk-proj-... project keys", () => {
    const r = validateProviderKey("openai", "sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1234");
    expect(r.valid).toBe(true);
  });

  test("accepts sk-svcacct-... service-account keys", () => {
    const r = validateProviderKey(
      "openai",
      "sk-svcacct-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(r.valid).toBe(true);
  });

  test("rejects keys without sk- prefix", () => {
    const r = validateProviderKey("openai", "not-an-openai-key-format-at-all-just-random");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/sk-/);
  });

  test("rejects sk-ant- (would silently succeed format but never work at OpenAI)", () => {
    const r = validateProviderKey("openai", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGHIJKLMNOP");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/openai/i);
  });

  test("rejects too-short keys", () => {
    expect(validateProviderKey("openai", "sk-x").valid).toBe(false);
  });

  test("rejects whitespace in middle", () => {
    expect(
      validateProviderKey("openai", "sk-aaaaaaaaaaaaaaaaaaaa bb has space ccccccccc").valid,
    ).toBe(false);
  });

  test("trims surrounding whitespace", () => {
    const r = validateProviderKey(
      "openai",
      "  sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ",
    );
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe("sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

describe("validateProviderKey — openai-compatible", () => {
  test("accepts any non-empty trimmed string (probe is the validator)", () => {
    const r = validateProviderKey("openai-compatible", "literally-anything-the-upstream-likes");
    expect(r.valid).toBe(true);
  });

  test("accepts groq-style gsk_ keys", () => {
    expect(validateProviderKey("openai-compatible", "gsk_abc123XYZ").valid).toBe(true);
  });

  test("accepts openrouter-style sk-or-v1-* keys", () => {
    expect(validateProviderKey("openai-compatible", "sk-or-v1-abc123def456").valid).toBe(true);
  });

  test("rejects empty / whitespace-only", () => {
    expect(validateProviderKey("openai-compatible", "").valid).toBe(false);
    expect(validateProviderKey("openai-compatible", "   ").valid).toBe(false);
  });

  test("rejects whitespace inside the key", () => {
    expect(validateProviderKey("openai-compatible", "valid prefix has space").valid).toBe(false);
  });

  test("trims surrounding whitespace and normalizes", () => {
    const r = validateProviderKey("openai-compatible", "  gsk_xyz  ");
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe("gsk_xyz");
  });
});

describe("validateProviderKey — invalid provider", () => {
  test("returns valid:false with helpful reason for unknown provider", () => {
    const r = validateProviderKey("codex" as Provider, "anything");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/provider/i);
  });
});
