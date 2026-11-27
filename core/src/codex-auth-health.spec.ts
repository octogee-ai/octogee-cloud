import { describe, it, expect, vi } from "vitest";
import {
  deriveCodexAuthHealth,
  checkSubscriptionAuthHealth,
  type SubscriptionAuthTarget,
} from "./codex-auth-health.js";
import {
  CLAUDE_CLI_DEFAULT_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "./model-credential-materializer.js";

const P = OPENAI_CODEX_DEFAULT_PROFILE_ID; 
const NOW = 1_780_000_000_000;

const state = (usageStats: Record<string, unknown>) =>
  JSON.stringify({ version: 1, usageStats });

describe("deriveCodexAuthHealth — absence/garbage is OK (no state ≠ failure)", () => {
  it.each([null, undefined, "", "   ", "not json", "[]", "5", "null", '"x"'])(
    "%j → ok",
    (raw) => {
      expect(deriveCodexAuthHealth(raw as string | null, P, NOW)).toBe("ok");
    },
  );

  it("record without usageStats → ok", () => {
    expect(deriveCodexAuthHealth(JSON.stringify({ version: 1 }), P, NOW)).toBe("ok");
    expect(
      deriveCodexAuthHealth(JSON.stringify({ version: 1, usageStats: 7 }), P, NOW),
    ).toBe("ok");
  });

  it("usageStats has no entry for the codex profile → ok", () => {
    expect(deriveCodexAuthHealth(state({ "anthropic:default": {} }), P, NOW)).toBe(
      "ok",
    );
  });
});

describe("deriveCodexAuthHealth — only an ACTIVE auth_permanent disable = needs_reauth", () => {
  it("disabledReason=auth_permanent + disabledUntil in the future → needs_reauth", () => {
    expect(
      deriveCodexAuthHealth(
        state({ [P]: { disabledReason: "auth_permanent", disabledUntil: NOW + 60_000 } }),
        P,
        NOW,
      ),
    ).toBe("needs_reauth");
  });

  it("realistic openclaw payload (order/lastGood/failureCounts) → needs_reauth", () => {
    const raw = JSON.stringify({
      version: 1,
      order: { [P]: 0 },
      lastGood: { [P]: NOW - 999_999 },
      usageStats: {
        [P]: {
          disabledReason: "auth_permanent",
          disabledUntil: NOW + 600_000,
          errorCount: 3,
          failureCounts: { auth_permanent: 3 },
        },
      },
    });
    expect(deriveCodexAuthHealth(raw, P, NOW)).toBe("needs_reauth");
  });

  it("auth_permanent but disabledUntil already elapsed (≤ now) → ok (openclaw will retry)", () => {
    expect(
      deriveCodexAuthHealth(
        state({ [P]: { disabledReason: "auth_permanent", disabledUntil: NOW - 1 } }),
        P,
        NOW,
      ),
    ).toBe("ok");
  });

  it("fail-safe: auth_permanent with no/garbage disabledUntil → needs_reauth", () => {
    expect(
      deriveCodexAuthHealth(state({ [P]: { disabledReason: "auth_permanent" } }), P, NOW),
    ).toBe("needs_reauth");
    expect(
      deriveCodexAuthHealth(
        state({ [P]: { disabledReason: "auth_permanent", disabledUntil: "soon" } }),
        P,
        NOW,
      ),
    ).toBe("needs_reauth");
  });

  it("a different disabledReason (billing) or transient cooldown is NOT reauth", () => {
    expect(
      deriveCodexAuthHealth(
        state({ [P]: { disabledReason: "billing", disabledUntil: NOW + 60_000 } }),
        P,
        NOW,
      ),
    ).toBe("ok");
    expect(
      deriveCodexAuthHealth(
        state({ [P]: { cooldownReason: "auth_permanent", cooldownUntil: NOW + 60_000 } }),
        P,
        NOW,
      ),
    ).toBe("ok");
  });

  it("per-profile isolation: a different profile disabled does not flag codex", () => {
    expect(
      deriveCodexAuthHealth(
        state({
          "anthropic:default": { disabledReason: "auth_permanent", disabledUntil: NOW + 60_000 },
        }),
        P,
        NOW,
      ),
    ).toBe("ok");
  });
});

describe("checkSubscriptionAuthHealth — reports a rejected subscription login with the time it was rejected", () => {
  const FAILED_AT = NOW - 120_000;
  const rejected = (profileId: string) =>
    state({
      [profileId]: {
        disabledReason: "auth_permanent",
        disabledUntil: NOW + 600_000,
        lastFailureAt: FAILED_AT,
      },
    });
  const target = (
    agentId: string,
    provider: SubscriptionAuthTarget["provider"],
    stateText: string | null,
  ): SubscriptionAuthTarget => ({
    agentId,
    provider,
    profileId: provider === "anthropic" ? CLAUDE_CLI_DEFAULT_PROFILE_ID : P,
    readAuthState: async () => stateText,
  });

  it("signals each provider whose login was rejected, with the rejection time", async () => {
    const signal = vi.fn(async () => {});
    const r = await checkSubscriptionAuthHealth({
      targets: [
        target("octogee-a-coach", "openai", rejected(P)),
        target("octogee-a-coach", "anthropic", rejected(CLAUDE_CLI_DEFAULT_PROFILE_ID)),
        target("octogee-b-coach", "openai", state({ [P]: { errorCount: 0 } })),
      ],
      now: NOW,
      signalNeedsReauth: signal,
    });
    expect(r).toEqual({ checked: 3, needsReauth: 2, signalled: 2 });
    expect(signal.mock.calls).toEqual([
      [{ agentId: "octogee-a-coach", provider: "openai", observedAt: FAILED_AT }],
      [{ agentId: "octogee-a-coach", provider: "anthropic", observedAt: FAILED_AT }],
    ]);
  });

  it.each([
    ["a rate limit cooldown", { cooldownReason: "rate_limit", cooldownUntil: NOW + 60_000, lastFailureAt: FAILED_AT }],
    ["a transient auth cooldown", { cooldownReason: "auth", cooldownUntil: NOW + 60_000, lastFailureAt: FAILED_AT }],
    ["a provider outage", { cooldownReason: "overloaded", cooldownUntil: NOW + 60_000, lastFailureAt: FAILED_AT }],
    ["an expired rejection window", { disabledReason: "auth_permanent", disabledUntil: NOW - 1, lastFailureAt: FAILED_AT }],
  ])("does not signal %s", async (_label, stats) => {
    const signal = vi.fn(async () => {});
    const r = await checkSubscriptionAuthHealth({
      targets: [target("octogee-a-coach", "openai", state({ [P]: stats }))],
      now: NOW,
      signalNeedsReauth: signal,
    });
    expect(r).toEqual({ checked: 1, needsReauth: 0, signalled: 0 });
    expect(signal).not.toHaveBeenCalled();
  });

  it("logs and skips a rejection that carries no failure time", async () => {
    const logs: string[] = [];
    const signal = vi.fn(async () => {});
    const r = await checkSubscriptionAuthHealth({
      targets: [
        target(
          "octogee-a-coach",
          "openai",
          state({ [P]: { disabledReason: "auth_permanent", disabledUntil: NOW + 600_000 } }),
        ),
      ],
      now: NOW,
      signalNeedsReauth: signal,
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ checked: 1, needsReauth: 1, signalled: 0 });
    expect(signal).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/octogee-a-coach.*lastFailureAt/);
  });

  it("a failed read skips that target and the sweep continues", async () => {
    const logs: string[] = [];
    const signal = vi.fn(async () => {});
    const r = await checkSubscriptionAuthHealth({
      targets: [
        {
          agentId: "octogee-explode",
          provider: "openai",
          profileId: P,
          readAuthState: async () => {
            throw new Error("EACCES agent store");
          },
        },
        target("octogee-bad-coach", "openai", rejected(P)),
      ],
      now: NOW,
      signalNeedsReauth: signal,
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ checked: 1, needsReauth: 1, signalled: 1 });
    expect(logs.join("\n")).toMatch(/octogee-explode.*EACCES/);
  });

  it("a failed signal is counted and logged, not thrown", async () => {
    const logs: string[] = [];
    const r = await checkSubscriptionAuthHealth({
      targets: [target("octogee-bad-coach", "openai", rejected(P))],
      now: NOW,
      signalNeedsReauth: async () => {
        throw new Error("auth-state 503");
      },
      logFn: (m) => logs.push(m),
    });
    expect(r).toEqual({ checked: 1, needsReauth: 1, signalled: 0 });
    expect(logs.join("\n")).toMatch(/octogee-bad-coach.*503/);
  });
});
