import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DELETION_RETENTION_MS,
  accountAllowsInteractiveAccess,
  anonymousOperationalEnvironment,
  anonymousOperationalGatewayClass,
  buildUserDeletionSchedule,
  isAnonymousOperationalModelDimension,
} from "./account-lifecycle.js";

describe("account deletion lifecycle", () => {
  it("keeps legacy and explicitly active accounts accessible", () => {
    expect(accountAllowsInteractiveAccess({})).toBe(true);
    expect(accountAllowsInteractiveAccess({ accountLifecycle: { status: "active" } })).toBe(true);
  });

  it.each(["suspended", "deletion_scheduled", "erasing"])(
    "denies interactive access while status is %s",
    (status) => {
      expect(accountAllowsInteractiveAccess({ accountLifecycle: { status } })).toBe(false);
    },
  );

  it("schedules ordinary erasure exactly 90 days after suspension", () => {
    const schedule = buildUserDeletionSchedule({ now: 1_000, eraseNow: false });
    expect(schedule).toEqual({ requestedAt: 1_000, eraseAfter: 1_000 + ACCOUNT_DELETION_RETENTION_MS });
  });

  it("schedules verified immediate erasure at the request time", () => {
    expect(buildUserDeletionSchedule({ now: 4_000, eraseNow: true })).toEqual({
      requestedAt: 4_000,
      eraseAfter: 4_000,
    });
  });

  it("admits only closed-set PII-free operational model dimensions", () => {
    expect(isAnonymousOperationalModelDimension("anthropic", "sonnet")).toBe(true);
    expect(isAnonymousOperationalModelDimension("openai", "openai:unknown-fallback")).toBe(true);
    for (const model of ["openai:gpt-6-luna", "openai:gpt-6.1-terra", "openai:gpt-6.1-sol"]) {
      expect(isAnonymousOperationalModelDimension("openai", model)).toBe(true);
    }
    expect(
      isAnonymousOperationalModelDimension("openrouter", "openrouter:openai/gpt-5.6-luna"),
    ).toBe(true);
    expect(isAnonymousOperationalModelDimension("alice@example.com", "sonnet")).toBe(false);
    expect(isAnonymousOperationalModelDimension("anthropic", "alice@example.com")).toBe(false);
  });

  it("normalizes archive metadata through closed operational sets", () => {
    expect(anonymousOperationalEnvironment("test")).toBe("test");
    expect(anonymousOperationalEnvironment("alice@example.com")).toBe("unknown");
    expect(anonymousOperationalGatewayClass("isolated")).toBe("isolated");
    expect(anonymousOperationalGatewayClass("builder")).toBe("isolated");
    expect(anonymousOperationalGatewayClass("operator")).toBeNull();
    expect(anonymousOperationalGatewayClass("alice@example.com")).toBeNull();
  });
});
