import { describe, expect, it } from "vitest";
import { modelCredentialConfig, subscriptionIntegration } from "./model-credential-records.js";
import type { ModelCredentialRecord, SubscriptionLinkRecord } from "./platform-state/users.js";

const credential: ModelCredentialRecord = {
  uid: "uid-ada",
  active: true,
  provider: "openrouter",
  mode: "api_key",
  status: "active",
  reasonCode: "ok",
  secretName: "byok-ada-openrouter",
  fingerprint: "sk-or-…1234",
  keyHash: null,
  baseUrl: null,
  model: "openrouter/auto",
  addedAt: 5,
  lastUsedAt: null,
};

function link(overrides: Partial<SubscriptionLinkRecord>): SubscriptionLinkRecord {
  return {
    uid: "uid-ada",
    provider: "openai",
    modelCredentialProvider: "openai-codex",
    status: "connected",
    gatewayId: "gw-ada",
    flowId: null,
    reason: null,
    updatedAt: 1,
    ...overrides,
  };
}

describe("modelCredentialConfig", () => {
  it("projects the stored credential without its absent fields", () => {
    expect(modelCredentialConfig(credential)).toEqual({
      modelCredential: {
        active: true,
        provider: "openrouter",
        mode: "api_key",
        status: "active",
        reasonCode: "ok",
        secretName: "byok-ada-openrouter",
        addedAt: 5,
        lastUsedAt: null,
        fingerprint: "sk-or-…1234",
        model: "openrouter/auto",
      },
    });
    expect(modelCredentialConfig(null)).toBeUndefined();
  });
});

describe("subscriptionIntegration", () => {
  it("is connected while any provider is connected and carries the latest link's gateway", () => {
    expect(subscriptionIntegration([
      link({ provider: "openai", status: "needs_reauth", gatewayId: "gw-old", reason: "refresh rejected", updatedAt: 1 }),
      link({ provider: "anthropic", modelCredentialProvider: "claude-cli", status: "connected", gatewayId: "gw-ada", flowId: "flow-1", updatedAt: 2 }),
    ])).toEqual({
      connected: true,
      gatewayId: "gw-ada",
      updatedAt: 2,
      providers: {
        openai: { provider: "openai", modelCredentialProvider: "openai-codex", status: "needs_reauth", connected: false, gatewayId: "gw-old", reason: "refresh rejected" },
        anthropic: { provider: "anthropic", modelCredentialProvider: "claude-cli", status: "connected", connected: true, gatewayId: "gw-ada", flowId: "flow-1" },
      },
    });
  });

  it("is disconnected when every link is disconnected or needs reauth, and absent with no links", () => {
    expect(subscriptionIntegration([link({ status: "disconnected" }), link({ provider: "anthropic", status: "needs_reauth" })]))
      .toMatchObject({ connected: false });
    expect(subscriptionIntegration([])).toBeUndefined();
  });
});
