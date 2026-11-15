import { describe, test, expect } from "vitest";
import { validateAnthropicKey } from "../model-credentials/anthropic-key-format.js";

describe("validateAnthropicKey", () => {
  test("accepts a realistic Anthropic key shape", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGHIJKLMNOP";
    expect(validateAnthropicKey(key)).toMatchObject({ valid: true, normalized: key });
  });

  test("rejects empty string", () => {
    const r = validateAnthropicKey("");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/required|empty/i);
  });

  test("rejects whitespace-only input", () => {
    const r = validateAnthropicKey("   \n\t ");
    expect(r.valid).toBe(false);
  });

  test("rejects non-string input", () => {
    expect(validateAnthropicKey(undefined as unknown as string).valid).toBe(false);
    expect(validateAnthropicKey(null as unknown as string).valid).toBe(false);
    expect(validateAnthropicKey(42 as unknown as string).valid).toBe(false);
  });

  test("rejects keys without the sk-ant prefix", () => {
    const r = validateAnthropicKey("sk-proj-not-an-anthropic-key-at-all-just-openai");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/sk-ant-/);
  });

  test("rejects suspiciously short keys even if prefix matches", () => {
    const r = validateAnthropicKey("sk-ant-tiny");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/too short|length/i);
  });

  test("rejects keys with embedded whitespace", () => {
    const r = validateAnthropicKey("sk-ant-api03-valid-prefix but has spaces in the middle");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/whitespace/i);
  });

  test("trims leading/trailing whitespace before evaluating", () => {
    expect(
      validateAnthropicKey(
        "  sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGHIJKLMNOP  ",
      ).valid,
    ).toBe(true);
  });

  test("returns the normalized key so callers use the trimmed form", () => {
    const raw = "  sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGHIJKLMNOP\n";
    const r = validateAnthropicKey(raw);
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe(raw.trim());
    expect(r.normalized).not.toContain(" ");
  });

  test("rejects realistic-length OpenAI keys (wrong prefix) with a clear reason", () => {
    const r = validateAnthropicKey("sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/sk-ant-/);
  });
});
