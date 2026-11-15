import { describe, expect, it } from "vitest";

import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { MODEL_BROKER_TOKENS_COLLECTION } from "@octogee/shared/types/model-broker-usage";

import {
  createModelBrokerTokenStore,
  hashModelBrokerToken,
} from "../lib/model-broker-tokens.js";
const gatewayTokenInput = {
  gatewayId: "jack",
  ownerUid: "uid-jack",
  provider: "anthropic" as const,
  secretName: "gateway-model-key-jack",
};

function randomBytes(fill: number): (size: number) => Buffer {
  return (size) => Buffer.alloc(size, fill);
}

describe("model broker token store", () => {
  it("issues, looks up, revokes the previous token on reissue, and revokes active tokens", async () => {
    const platform = createDocumentFixtureStore(new Map());
    const store = createModelBrokerTokenStore(platform);

    const first = await store.issueToken({
      ...gatewayTokenInput,
      now: 1_000,
      randomBytes: randomBytes(1),
    });

    await expect(store.lookupToken(first.token, 1_001)).resolves.toMatchObject({
      outcome: "valid",
      record: {
        gatewayId: "jack",
        ownerUid: "uid-jack",
        provider: "anthropic",
        capped: true,
        revoked: false,
      },
    });

    const second = await store.issueToken({
      ...gatewayTokenInput,
      now: 2_000,
      randomBytes: randomBytes(2),
    });

    expect(second.token).not.toBe(first.token);
    await expect(store.lookupToken(first.token, 2_001)).resolves.toMatchObject({ outcome: "revoked" });
    await expect(store.lookupToken(second.token, 2_001)).resolves.toMatchObject({
      outcome: "valid",
      record: { gatewayId: "jack", revoked: false },
    });

    const pointer = await platform.access.modelBrokerGatewayTokens.get("jack");
    expect(pointer).toMatchObject({
      tokenHash: hashModelBrokerToken(second.token),
      gatewayId: "jack",
      secretName: "gateway-model-key-jack",
    });

    await expect(
      store.revokeGatewayToken({ ...gatewayTokenInput, now: 3_000 }),
    ).resolves.toEqual({ revoked: true });
    await expect(store.lookupToken(second.token, 3_001)).resolves.toMatchObject({ outcome: "revoked" });
    const deletedPointer = await platform.access.modelBrokerGatewayTokens.get("jack");
    expect(deletedPointer).toBeNull();
  });

  it("scopes revocation by pointerKey so per-user tokens on a shared gateway are independent", async () => {
    const platform = createDocumentFixtureStore(new Map());
    const store = createModelBrokerTokenStore(platform);

    const perUser = (ownerUid: string, fill: number, now: number) =>
      store.issueToken({
        gatewayId: "shared-1",
        ownerUid,
        provider: "anthropic" as const,
        secretName: `agent-model-token-shared-1-${ownerUid}`,
        pointerKey: `shared-1:${ownerUid}`,
        limits: null,
        now,
        randomBytes: randomBytes(fill),
      });

    const alice = await perUser("uid-alice", 10, 1_000);
    const bob = await perUser("uid-bob", 11, 1_000);

    // meter-only: no caps stamped
    await expect(store.lookupToken(alice.token, 1_001)).resolves.toMatchObject({
      outcome: "valid",
      record: {
        ownerUid: "uid-alice",
        revoked: false,
        limits: { spendWindowUsd: null, requestsPerMinute: null },
      },
    });
    // issuing bob did NOT revoke alice (same gateway, different pointerKey)
    await expect(store.lookupToken(bob.token, 1_001)).resolves.toMatchObject({
      outcome: "valid",
      record: { ownerUid: "uid-bob", revoked: false },
    });

    // reissuing alice revokes only alice's previous token, never bob's
    const alice2 = await perUser("uid-alice", 12, 2_000);
    await expect(store.lookupToken(alice.token, 2_001)).resolves.toMatchObject({ outcome: "revoked" });
    await expect(store.lookupToken(alice2.token, 2_001)).resolves.toMatchObject({ outcome: "valid" });
    await expect(store.lookupToken(bob.token, 2_001)).resolves.toMatchObject({ outcome: "valid" });
  });

  it("skipPointer mints a standalone TTL-bounded token — a re-mint never revokes the in-flight one", async () => {
    const platform = createDocumentFixtureStore(new Map());
    const store = createModelBrokerTokenStore(platform);

    const mint = (fill: number, now: number) =>
      store.issueToken({
        gatewayId: "shared-1",
        ownerUid: "uid-alice",
        provider: "anthropic" as const,
        secretName: "agent-model-token-shared-1-uid-alice",
        skipPointer: true,
        ttlSeconds: 3600,
        limits: null,
        trace: {
          source: "shared_agent_model_token",
          ownerSlug: "alice",
          agentId: "octogee-alice-coach",
        },
        now,
        randomBytes: randomBytes(fill),
      });

    const first = await mint(20, 1_000);
    const second = await mint(21, 2_000);

    // the re-mint did NOT revoke the first (still-in-flight) token
    await expect(store.lookupToken(first.token, 2_001)).resolves.toMatchObject({ outcome: "valid" });
    await expect(store.lookupToken(first.token, 2_001)).resolves.toMatchObject({
      record: {
        trace: {
          source: "shared_agent_model_token",
          ownerSlug: "alice",
          agentId: "octogee-alice-coach",
        },
      },
    });
    await expect(store.lookupToken(second.token, 2_001)).resolves.toMatchObject({ outcome: "valid" });
    expect(first.record.expiresAt).toBe(1_000 + 3_600 * 1000);
    // no pointer doc is written for standalone tokens
    const pointer = await platform.access.modelBrokerGatewayTokens.get("shared-1");
    expect(pointer).toBeNull();
    // and the stale token expires by TTL rather than being yanked
    await expect(store.lookupToken(first.token, 1_000 + 3_600 * 1000 + 1)).resolves.toMatchObject({ outcome: "expired" });
  });

  it("refuses a malformed token record instead of answering for it", async () => {
    const records = new Map<string, Record<string, unknown>>();
    const store = createModelBrokerTokenStore(createDocumentFixtureStore(records));
    const token = "ogk_jack_malformed";
    const tokenHash = hashModelBrokerToken(token);

    records.set(`${MODEL_BROKER_TOKENS_COLLECTION}/${tokenHash}`, {
      tokenHash,
      gatewayId: "jack",
      provider: "anthropic",
      capped: true,
      secretName: "gateway-model-key-jack",
      createdAt: "not-a-number",
      revoked: false,
    });

    await expect(store.lookupToken(token, 1_001)).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("does not create revoked-only tombstone docs for stale reissue pointers", async () => {
    const platform = createDocumentFixtureStore(new Map());
    const store = createModelBrokerTokenStore(platform);

    await platform.access.modelBrokerGatewayTokens.put({
      pointerKey: "jack",
      gatewayId: "jack",
      ownerUid: "uid-jack",
      provider: "anthropic",
      secretName: "gateway-model-key-jack",
      tokenHash: "missing-token-hash",
      updatedAt: 3_000,
    });

    const issued = await store.issueToken({
      ...gatewayTokenInput,
      now: 4_000,
      randomBytes: randomBytes(4),
    });

    const staleToken = await platform.access.modelBrokerTokens.get("missing-token-hash");
    expect(staleToken).toBeNull();
    const pointer = await platform.access.modelBrokerGatewayTokens.get("jack");
    expect(pointer).toMatchObject({ tokenHash: issued.record.tokenHash, updatedAt: 4_000 });
  });
});
