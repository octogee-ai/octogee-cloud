import { describe, expect, it } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import {
  createModelBrokerTokenStore,
  hashModelBrokerToken,
} from "../lib/model-broker-tokens.js";

const TOKEN = "ogk_jack_stored";

function storeWith(documents: Record<string, Record<string, unknown>>) {
  return createModelBrokerTokenStore(createDocumentFixtureStore(new Map(Object.entries(documents))));
}

function storedRecord(provider: string): Record<string, unknown> {
  return {
    tokenHash: hashModelBrokerToken(TOKEN),
    gatewayId: "jack",
    ownerUid: "uid-jack",
    provider,
    purpose: "model",
    capped: true,
    secretName: `agent-model-token-${provider}-jack-uid-jack`,
    createdAt: 1_000,
    expiresAt: null,
    revoked: false,
  };
}

describe("stored broker token record shape", () => {
  it("parses a vertex record on lookup", async () => {
    const store = storeWith({ [`modelBrokerTokens/${hashModelBrokerToken(TOKEN)}`]: storedRecord("vertex") });
    await expect(store.lookupToken(TOKEN, 2_000)).resolves.toMatchObject({
      outcome: "valid",
      record: { provider: "vertex", gatewayId: "jack", ownerUid: "uid-jack" },
    });
  });

  it("refuses a record with an unknown provider", async () => {
    const store = storeWith({ [`modelBrokerTokens/${hashModelBrokerToken(TOKEN)}`]: storedRecord("bedrock") });
    await expect(store.lookupToken(TOKEN, 2_000)).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("refuses to reissue over a gateway pointer that is not a complete record", async () => {
    const documents = new Map<string, Record<string, unknown>>([[
      "modelBrokerGatewayTokens/jack",
      { gatewayId: "jack", provider: "anthropic", secretName: "gateway-model-key-jack", tokenHash: "previous" },
    ]]);
    const store = createModelBrokerTokenStore(createDocumentFixtureStore(documents));

    await expect(store.issueToken({
      gatewayId: "jack",
      ownerUid: "uid-jack",
      provider: "anthropic",
      secretName: "gateway-model-key-jack",
      now: 2_000,
    })).rejects.toBeInstanceOf(MalformedRecordError);
    expect([...documents.keys()]).toEqual(["modelBrokerGatewayTokens/jack"]);
  });
});
