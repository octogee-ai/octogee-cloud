import { describe, expect, it } from "vitest";
import { AlreadyExistsError, MissingRecordError } from "../../errors.js";
import type { ModelCredentialInput } from "../../users.js";
import { NOW, REVISION, useUserFixture } from "./fixtures/users.js";
import { dsn } from "./fixtures/harness.js";

const apiKey: ModelCredentialInput = {
  uid: "ada",
  active: true,
  provider: "openrouter",
  mode: "api_key",
  status: "active",
  reasonCode: "ok",
  secretName: "byok-ada-openrouter",
  fingerprint: "sk-or-…1234",
  keyHash: "hash-1",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "openrouter/auto",
  addedAt: NOW,
  lastUsedAt: null,
};

describe.skipIf(!dsn)("PostgreSQL model credentials", () => {
  const fixture = useUserFixture();

  it("keeps one credential per user, replaces it on put and removes it on delete", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await users.modelCredentials.put(apiKey);
    expect(await users.modelCredentials.get("ada")).toEqual({ ...apiKey, revision: expect.stringMatching(REVISION) });

    await users.modelCredentials.put({
      ...apiKey,
      provider: "claude-cli",
      mode: "oauth",
      secretName: "byosub-ada-anthropic",
      fingerprint: null,
      keyHash: null,
      baseUrl: null,
      model: null,
      addedAt: { serverNow: true },
    });
    const replaced = await users.modelCredentials.get("ada");
    expect(replaced).toMatchObject({ provider: "claude-cli", mode: "oauth", fingerprint: null, baseUrl: null, model: null });
    expect(replaced!.addedAt).toBeGreaterThan(NOW);

    await users.modelCredentials.delete("ada");
    await users.modelCredentials.delete("ada");
    expect(await users.modelCredentials.get("ada")).toBeNull();
  });

  it("refuses a credential mode it does not know", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await expect(users.modelCredentials.put({ ...apiKey, mode: "password" as never })).rejects.toThrow();
  });

  it("drops a user's credential, subscription links and flows with the user", async () => {
    const { users, admitted, count } = fixture();
    await admitted("ada");
    await users.modelCredentials.put(apiKey);
    await users.subscriptionLinks.put({
      uid: "ada", provider: "openai", modelCredentialProvider: "openai-codex", status: "connected",
      gatewayId: "gw-ada", flowId: null, reason: null, updatedAt: NOW,
    });
    await users.subscriptionFlows.create({
      flowId: "flow-1", uid: "ada", gatewayId: "gw-ada", agentId: "octogee-ada-coach",
      provider: "openai", modelCredentialProvider: "openai-codex", createdAt: NOW, expireAt: NOW + 600_000,
    });

    await users.records.delete("ada");

    expect(await count("user_model_credentials", "ada")).toBe(0);
    expect(await count("user_subscription_links", "ada")).toBe(0);
    expect(await count("subscription_flows", "ada")).toBe(0);
  });
});

describe.skipIf(!dsn)("PostgreSQL subscription links", () => {
  const fixture = useUserFixture();

  it("keeps one link per provider and replaces its status, gateway, flow and reason", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await users.subscriptionLinks.put({
      uid: "ada", provider: "openai", modelCredentialProvider: "openai-codex", status: "connected",
      gatewayId: "gw-ada", flowId: "flow-1", reason: null, updatedAt: NOW,
    });
    await users.subscriptionLinks.put({
      uid: "ada", provider: "anthropic", modelCredentialProvider: "claude-cli", status: "connected",
      gatewayId: "gw-ada", flowId: null, reason: null, updatedAt: NOW,
    });
    await users.subscriptionLinks.put({
      uid: "ada", provider: "openai", modelCredentialProvider: "openai-codex", status: "needs_reauth",
      gatewayId: null, flowId: null, reason: "refresh rejected", updatedAt: { serverNow: true },
    });

    const links = await users.subscriptionLinks.list("ada");
    expect(links.map(({ provider, status, gatewayId, flowId, reason }) => ({ provider, status, gatewayId, flowId, reason }))).toEqual([
      { provider: "anthropic", status: "connected", gatewayId: "gw-ada", flowId: null, reason: null },
      { provider: "openai", status: "needs_reauth", gatewayId: null, flowId: null, reason: "refresh rejected" },
    ]);
    expect(links[1]!.updatedAt).toBeGreaterThan(NOW);
    expect(await users.subscriptionLinks.list("nobody")).toEqual([]);
  });
});

describe.skipIf(!dsn)("PostgreSQL subscription flows", () => {
  const fixture = useUserFixture();
  const flow = {
    flowId: "flow-1",
    uid: "ada",
    gatewayId: "gw-ada",
    agentId: "octogee-ada-coach",
    provider: "openai",
    modelCredentialProvider: "openai-codex",
    createdAt: NOW,
    expireAt: NOW + 600_000,
  };

  it("starts a flow unclaimed, then records its claim and its consumption", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await users.subscriptionFlows.create(flow);
    expect(await users.subscriptionFlows.get("flow-1")).toEqual({
      ...flow,
      consumedAt: null,
      captureClaimId: null,
      captureClaimedAt: null,
      modelPinnedAt: null,
      revision: expect.stringMatching(REVISION),
    });

    await users.subscriptionFlows.update("flow-1", { captureClaimId: "claim-1", captureClaimedAt: NOW + 1 });
    expect(await users.subscriptionFlows.get("flow-1")).toMatchObject({ captureClaimId: "claim-1", captureClaimedAt: NOW + 1, consumedAt: null });

    await users.subscriptionFlows.update("flow-1", { consumedAt: NOW + 2, captureClaimId: null, captureClaimedAt: null });
    expect(await users.subscriptionFlows.get("flow-1")).toMatchObject({ consumedAt: NOW + 2, captureClaimId: null, captureClaimedAt: null });

    await users.subscriptionFlows.update("flow-1", { modelPinnedAt: NOW + 3 });
    expect(await users.subscriptionFlows.get("flow-1")).toMatchObject({ consumedAt: NOW + 2, modelPinnedAt: NOW + 3 });
    expect(await users.subscriptionFlows.get("flow-absent")).toBeNull();
  });

  it("refuses a second flow with the same id and progress on a flow that was never started", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await users.subscriptionFlows.create(flow);

    await expect(users.subscriptionFlows.create(flow)).rejects.toBeInstanceOf(AlreadyExistsError);
    await expect(users.subscriptionFlows.update("flow-absent", { consumedAt: NOW })).rejects.toBeInstanceOf(MissingRecordError);
  });

  it("sweeps flows past their expiry and keeps live ones", async () => {
    const { store, users, admitted } = fixture();
    await admitted("ada");
    await users.subscriptionFlows.create({ ...flow, flowId: "flow-expired", expireAt: NOW - 1 });
    await users.subscriptionFlows.create(flow);

    expect(await store.sweepExpired(NOW, 10)).toMatchObject({ subscriptionFlows: 1 });
    expect(await users.subscriptionFlows.get("flow-expired")).toBeNull();
    expect(await users.subscriptionFlows.get("flow-1")).not.toBeNull();
  });

  it("serializes two claims on one flow so only the first sees it unclaimed", async () => {
    const { store, users, admitted } = fixture();
    await admitted("ada");
    await users.subscriptionFlows.create(flow);

    const claim = (claimId: string) => store.transaction({ label: "test.flow.claim" }, async (tx) => {
      const current = await tx.users.subscriptionFlows.get("flow-1");
      if (current?.captureClaimId !== null) return false;
      await tx.users.subscriptionFlows.update("flow-1", { captureClaimId: claimId, captureClaimedAt: NOW });
      return true;
    });
    const results = await Promise.allSettled([claim("claim-a"), claim("claim-b")]);

    const won = results.filter((result) => result.status === "fulfilled" && result.value === true);
    expect(won).toHaveLength(1);
    expect((await users.subscriptionFlows.get("flow-1"))?.captureClaimId).toMatch(/^claim-[ab]$/);
  });
});
