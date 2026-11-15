import { describe, test, expect } from "vitest";
import { deriveDesiredByotState } from "../../gateway-supervisor/lib/byot-sync";

describe("deriveDesiredByotState", () => {
  test("enabled when byotActive + complete + username present (defaults to anthropic)", () => {
    const out = deriveDesiredByotState({
      planInputs: {},
      byotActive: true,
      username: "smile-wring-011b",
      provisioning: { openclaw: { status: "complete" } },
    });
    expect(out.enabled).toBe(true);
    expect(out.input).toMatchObject({ slug: "smile-wring-011b", provider: "anthropic" });
  });

  test("Phase 2: provider/baseUrl/model propagate from systemConfig.byot", () => {
    const out = deriveDesiredByotState({
      planInputs: {},
      byotActive: true,
      username: "x",
      provisioning: { openclaw: { status: "complete" } },
      systemConfig: { byot: { provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-3.5-sonnet" } },
    });
    expect(out.input).toEqual({
      slug: "x",
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
    });
  });

  test("Phase 2: openai provider propagates", () => {
    const out = deriveDesiredByotState({
      planInputs: {},
      byotActive: true,
      username: "x",
      provisioning: { openclaw: { status: "complete" } },
      systemConfig: { byot: { provider: "openai", model: "openai/gpt-5" } },
    });
    expect(out.input?.provider).toBe("openai");
    expect(out.input?.model).toBe("openai/gpt-5");
  });

  test("unknown provider value falls back to anthropic (Phase 1 backwards compat)", () => {
    const out = deriveDesiredByotState({
      planInputs: {},
      byotActive: true,
      username: "x",
      provisioning: { openclaw: { status: "complete" } },
      systemConfig: { byot: { provider: "codex" } },
    });
    expect(out.input?.provider).toBe("anthropic");
  });

  test("disabled when byotActive is false", () => {
    const out = deriveDesiredByotState({
      planInputs: {},
      byotActive: false,
      username: "smile-wring-011b",
      provisioning: { openclaw: { status: "complete" } },
    });
    expect(out.enabled).toBe(false);
    expect(out.input).toBeNull();
  });

  test("disabled when byotActive is missing (undefined)", () => {
    const out = deriveDesiredByotState({
      planInputs: {},
      username: "smile-wring-011b",
      provisioning: { openclaw: { status: "complete" } },
    });
    expect(out.enabled).toBe(false);
  });

  test("disabled when provisioning status is not complete", () => {
    const out = deriveDesiredByotState({
      planInputs: {},
      byotActive: true,
      username: "smile-wring-011b",
      provisioning: { openclaw: { status: "in_progress" } },
    });
    expect(out.enabled).toBe(false);
  });

  test("disabled when slug is missing from both canonical paths", () => {
    const out = deriveDesiredByotState({
      planInputs: {},
      byotActive: true,
      provisioning: { openclaw: { status: "complete" } },
    });
    expect(out.enabled).toBe(false);
  });

  test("disabled when username is missing, even if provisioning status is complete", () => {
    const out = deriveDesiredByotState({
      planInputs: {},
      byotActive: true,
      provisioning: { openclaw: { status: "complete" } },
    });
    expect(out.enabled).toBe(false);
  });

  test("empty user data = disabled (defensive default)", () => {
    expect(deriveDesiredByotState({ planInputs: {} }).enabled).toBe(false);
  });
});
