import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  deriveDesiredModelCredentialState,
  legacyByotSyncUserDataFromModelCredentialState,
} from "@octogee/core/model-credential-sync";
import { syncModelCredentialsForUser } from "../lib/model-credential-sync-runtime.js";
import { houseOnlyUserEntitlements, installUserEntitlementsForTest } from "./helpers/user-entitlements.js";

const COMPLETE_USER = {
  username: "tester-70",
  planInputs: {},
  provisioning: { openclaw: { status: "complete" } },
};

describe("deriveDesiredModelCredentialState", () => {
  it("derives a static provider from canonical modelCredential state", () => {
    const desired = deriveDesiredModelCredentialState({
      ...COMPLETE_USER,
      systemConfig: {
        modelCredential: {
          active: true,
          provider: "openai-compatible",
          mode: "api_key",
          baseUrl: "https://llm.example.com/v1",
          model: "custom/fast",
        },
      },
    });

    expect(desired).toMatchObject({
      enabled: true,
      input: {
        slug: "tester-70",
        provider: "openai-compatible",
        baseUrl: "https://llm.example.com/v1",
        model: "custom/fast",
      },
    });
  });

  it.each(["openai-codex", "claude-cli"] as const)(
    "derives OAuth provider %s from canonical modelCredential state",
    (provider) => {
      const desired = deriveDesiredModelCredentialState({
        ...COMPLETE_USER,
        systemConfig: {
          modelCredential: {
            active: true,
            provider,
            mode: "oauth",
          },
        },
      });

      expect(desired).toMatchObject({
        enabled: true,
        input: {
          slug: "tester-70",
          provider,
          baseUrl: undefined,
          model: undefined,
        },
      });
    },
  );

  it("inactive canonical modelCredential state overrides stale legacy BYOT state", () => {
    const normalized = legacyByotSyncUserDataFromModelCredentialState({
      ...COMPLETE_USER,
      byotActive: true,
      systemConfig: {
        modelCredential: {
          active: false,
          provider: "openai",
          mode: "api_key",
          model: "openai/gpt-5",
        },
        byot: { provider: "anthropic" },
      },
    });

    expect(normalized.byotActive).toBe(false);
    expect(normalized.systemConfig).toBeUndefined();
    expect(deriveDesiredModelCredentialState(normalized).enabled).toBe(false);
  });

  it("keeps the legacy BYOT projection as a compatibility input", () => {
    const desired = deriveDesiredModelCredentialState({
      ...COMPLETE_USER,
      byotActive: true,
      systemConfig: {
        byot: { provider: "openai", model: "openai/gpt-5" },
      },
    });

    expect(desired.input).toMatchObject({
      slug: "tester-70",
      provider: "openai",
      model: "openai/gpt-5",
    });
  });
});

describe("syncModelCredentialsForUser", () => {
  it("suppresses user OAuth state instead of materializing its runtime credential", async () => {
    installUserEntitlementsForTest(houseOnlyUserEntitlements);
    const applyModelCredentialState = vi.fn(() => true);
    const restoreOauthStoreForSlug = vi.fn(async () => ({ restored: true, present: true }));
    const applyDefaultAgentModelPatch = vi.fn(async () => true);
    const triggerSecretsReload = vi.fn(async () => {});
    const purgeUserOauthRuntime = vi.fn(async () => ({ changed: true, resetCount: 0 }));
    const requestGatewayRestart = vi.fn(async () => true);

    await syncModelCredentialsForUser(
      {
        ...COMPLETE_USER,
        systemConfig: {
          modelCredential: {
            active: true,
            provider: "claude-cli",
            mode: "oauth",
          },
        },
      },
      {
        isSharedGateway: () => false,
        usesLlmBrokerToken: () => false,
        applyModelCredentialState,
        restoreOauthStoreForSlug,
        applyDefaultAgentModelPatch,
        triggerSecretsReload,
        purgeUserOauthRuntime,
        requestGatewayRestart,
      },
    );

    expect(applyModelCredentialState).toHaveBeenCalledWith(
      "tester-70",
      null,
      undefined,
      { preserveAuthProfileStore: false },
    );
    expect(purgeUserOauthRuntime).toHaveBeenCalledWith(
      "tester-70",
      "platform-openai/gpt-6-luna",
      { forceSafeAll: true },
    );
    expect(restoreOauthStoreForSlug).not.toHaveBeenCalled();
    expect(applyDefaultAgentModelPatch).toHaveBeenCalledWith({
      slug: "tester-70",
      source: "house-model",
      model: "platform-openai/gpt-6-luna",
    });
    expect(requestGatewayRestart).not.toHaveBeenCalled();
    expect(triggerSecretsReload).toHaveBeenCalledTimes(1);
  });
});

describe("model credential sync facade adoption", () => {
  it.each([
    "user-lifecycle-broker-adapter.ts",
  ])("%s uses the model credential sync runtime facade", (file) => {
    const src = readFileSync(join(import.meta.dirname, "..", "lib", file), "utf8");
    expect(src).toContain("model-credential-sync-runtime");
    expect(src).not.toContain("byot-sync-runtime");
  });
});
