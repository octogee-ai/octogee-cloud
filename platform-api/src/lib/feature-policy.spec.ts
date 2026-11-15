import { describe, expect, it, vi } from "vitest";

import { FEATURE_FLAG_KEYS } from "@octogee/shared/types/feature-flags";

import { FeaturePolicy, configuredFeatureFlagProvider } from "./feature-policy.js";

const subject = { uid: "uid-alice", isAdmin: false, workspaceSlug: "private-workspace" };

describe("configuredFeatureFlagProvider", () => {
  async function enabledFlags(env: NodeJS.ProcessEnv) {
    const policy = new FeaturePolicy(configuredFeatureFlagProvider(env));
    const decisions = await policy.userVisibleDecisions(subject, "configured-flags");
    return FEATURE_FLAG_KEYS.filter((key) => decisions[key].state === "enabled");
  }

  it("leaves every flag disabled when ENABLED_FEATURE_FLAGS is unset", async () => {
    await expect(enabledFlags({})).resolves.toEqual([]);
  });

  it("enables exactly the listed flags for every user", async () => {
    await expect(enabledFlags({ ENABLED_FEATURE_FLAGS: " release-voice-talk,release-agent-import ,," }))
      .resolves.toEqual(["release-agent-import", "release-voice-talk"]);
  });

  it("refuses a key that is not a platform feature flag", () => {
    expect(() => configuredFeatureFlagProvider({ ENABLED_FEATURE_FLAGS: "release-agent-import,release-agent-imprt" }))
      .toThrow(/ENABLED_FEATURE_FLAGS.*release-agent-imprt/);
  });
});

describe("FeaturePolicy", () => {
  it("uses the verified subject and maps enabled and disabled provider values", async () => {
    const evaluate = vi.fn(async () => ({
      isEnabled: (key: string) => key === "release-openclaw-dashboard",
    }));
    const policy = new FeaturePolicy({ evaluate });

    await expect(policy.evaluate("release-openclaw-dashboard", subject, "openclaw-dashboard"))
      .resolves.toEqual({ state: "enabled", value: true });
    await expect(policy.evaluate("release-agent-import", subject, "agent-import"))
      .resolves.toEqual({ state: "disabled", value: false });
    expect(evaluate).toHaveBeenCalledWith(subject, ["release-openclaw-dashboard"]);
  });

  it("enables an adminBypass flag for admins without consulting the provider", async () => {
    const evaluate = vi.fn(async () => ({ isEnabled: () => false }));
    const policy = new FeaturePolicy({ evaluate });
    const admin = { ...subject, isAdmin: true };

    await expect(policy.evaluate("release-project-repo-source", admin, "repo-source"))
      .resolves.toEqual({ state: "enabled", value: true });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each(["release-workspace-sharing", "release-coach-readiness"] as const)("leaves %s to the provider for admins", async (key) => {
    const evaluate = vi.fn(async () => ({ isEnabled: () => false }));
    const policy = new FeaturePolicy({ evaluate });
    const admin = { ...subject, isAdmin: true };

    await expect(policy.evaluate(key, admin, "sharing"))
      .resolves.toEqual({ state: "disabled", value: false });
    expect(evaluate).toHaveBeenCalledWith(admin, [key]);
  });

  it("keeps an adminBypass flag enabled for admins when the provider is unavailable", async () => {
    const policy = new FeaturePolicy({
      evaluate: async () => { throw new Error("network unavailable"); },
    });
    const admin = { ...subject, isAdmin: true };

    const decisions = await policy.userVisibleDecisions(admin, "pwa-snapshot");

    expect(decisions["release-project-repo-source"]).toEqual({ state: "enabled", value: true });
    expect(decisions["release-workspace-sharing"])
      .toEqual({ state: "unavailable", value: false, reason: "provider_error" });
  });

  it("does not bypass an adminBypass flag for non-admins", async () => {
    const evaluate = vi.fn(async () => ({ isEnabled: () => false }));
    const policy = new FeaturePolicy({ evaluate });

    await expect(policy.evaluate("release-project-repo-source", subject, "repo-source"))
      .resolves.toEqual({ state: "disabled", value: false });
    expect(evaluate).toHaveBeenCalledWith(subject, ["release-project-repo-source"]);
  });

  it("does not turn a timeout or provider exception into an ordinary disabled flag", async () => {
    const timeout = new FeaturePolicy(
      { evaluate: () => new Promise(() => undefined) },
      { timeoutMs: 1 },
    );
    const providerError = new FeaturePolicy({
      evaluate: async () => { throw new Error("network unavailable"); },
    });

    await expect(timeout.evaluate("release-openclaw-dashboard", subject, "openclaw-dashboard"))
      .resolves.toEqual({ state: "unavailable", value: false, reason: "timeout" });
    await expect(providerError.evaluate("release-openclaw-dashboard", subject, "openclaw-dashboard"))
      .resolves.toEqual({ state: "unavailable", value: false, reason: "provider_error" });
  });

  it("logs the provider failure diagnostics alongside the coarse reason", async () => {
    const error = vi.fn();
    const policy = new FeaturePolicy(
      { evaluate: async () => { throw new Error("network unavailable"); } },
      { logger: { error } },
    );

    await policy.evaluate("release-openclaw-dashboard", subject, "openclaw-dashboard");

    expect(error).toHaveBeenCalledWith("Feature flag evaluation failed", expect.objectContaining({
      reason: "provider_error",
      err: expect.objectContaining({ message: "network unavailable" }),
    }));
  });
});
