import { describe, expect, it } from "vitest";
import { AlreadyExistsError, MissingRecordError } from "../../errors.js";
import type { ConnectorIntegrationInput, NewConnectFlow } from "../../users.js";
import { NOW, REVISION, useUserFixture } from "./fixtures/users.js";
import { dsn } from "./fixtures/harness.js";

const google: ConnectorIntegrationInput = {
  uid: "ada",
  connectorId: "google",
  status: "connected",
  accountLabel: "ada@example.com",
  scopes: ["openid", "https://www.googleapis.com/auth/calendar.readonly"],
  captureMethod: "oauth-web",
  error: null,
  detail: { capabilityCatalogVersion: 3, pickedFiles: [{ id: "f1", name: "Plan" }] },
  connectedAt: NOW,
  verifiedAt: null,
  updatedAt: NOW,
};

const oauthFlow: NewConnectFlow = {
  flowId: "nonce-1",
  uid: "ada",
  connectorId: "google",
  kind: "oauth-web",
  requestedScopes: ["openid"],
  codeVerifier: "verifier",
  encryptedDeviceCode: null,
  createdAt: NOW,
  expireAt: NOW + 600_000,
};

describe.skipIf(!dsn)("PostgreSQL connector integrations", () => {
  const fixture = useUserFixture();

  it("keeps one integration per user and connector, replaced on put", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    expect(await users.connectorIntegrations.get("ada", "google")).toBeNull();

    await users.connectorIntegrations.put(google);
    expect(await users.connectorIntegrations.get("ada", "google")).toEqual({ ...google, revision: expect.stringMatching(REVISION) });

    await users.connectorIntegrations.put({
      ...google,
      status: "disconnected",
      accountLabel: null,
      scopes: [],
      captureMethod: null,
      detail: {},
      connectedAt: null,
      updatedAt: { serverNow: true },
    });
    const replaced = await users.connectorIntegrations.get("ada", "google");
    expect(replaced).toMatchObject({ status: "disconnected", accountLabel: null, scopes: [], captureMethod: null, detail: {}, connectedAt: null });
    expect(replaced!.updatedAt).toBeGreaterThan(NOW);
  });

  it("lists a user's integrations by connector", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await admitted("bob");
    await users.connectorIntegrations.put({ ...google, connectorId: "notion", scopes: [], detail: {} });
    await users.connectorIntegrations.put(google);
    await users.connectorIntegrations.put({ ...google, uid: "bob" });

    expect((await users.connectorIntegrations.list("ada")).map((row) => row.connectorId)).toEqual(["google", "notion"]);
  });

  it("refuses a status or capture method it does not know", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await expect(users.connectorIntegrations.put({ ...google, status: "revoked" as never })).rejects.toThrow();
    await expect(users.connectorIntegrations.put({ ...google, captureMethod: "carrier-pigeon" as never })).rejects.toThrow();
  });
});

describe.skipIf(!dsn)("PostgreSQL connect flows", () => {
  const fixture = useUserFixture();

  it("creates a flow once and records its consumption and outcome", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await users.connectFlows.create(oauthFlow);
    expect(await users.connectFlows.get("nonce-1")).toEqual({
      ...oauthFlow,
      consumedAt: null,
      outcome: null,
      revision: expect.stringMatching(REVISION),
    });
    await expect(users.connectFlows.create(oauthFlow)).rejects.toBeInstanceOf(AlreadyExistsError);

    await users.connectFlows.update("nonce-1", { consumedAt: NOW + 1, outcome: "connected" });
    expect(await users.connectFlows.get("nonce-1")).toMatchObject({ consumedAt: NOW + 1, outcome: "connected" });
    await expect(users.connectFlows.update("nonce-1", { outcome: "finished" as never })).rejects.toThrow();
  });

  it("refuses to change a flow's owner and to update a flow that does not exist", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await users.connectFlows.create(oauthFlow);
    await expect(users.connectFlows.update("nonce-1", { uid: "bob" } as never)).rejects.toThrow(TypeError);
    await expect(users.connectFlows.update("missing", { consumedAt: NOW })).rejects.toBeInstanceOf(MissingRecordError);
  });

  it("deletes every flow a user started and leaves other users' flows", async () => {
    const { users, admitted, count } = fixture();
    await admitted("ada");
    await admitted("bob");
    await users.connectFlows.create(oauthFlow);
    await users.connectFlows.create({ ...oauthFlow, flowId: "device-1", kind: "device", requestedScopes: [], codeVerifier: null, encryptedDeviceCode: "enc" });
    await users.connectFlows.create({ ...oauthFlow, flowId: "bob-1", uid: "bob" });

    await users.connectFlows.deleteForUser("ada");

    expect(await count("connect_flows", "ada")).toBe(0);
    expect(await users.connectFlows.get("bob-1")).not.toBeNull();
  });

  it("drops a user's integrations and flows with the user", async () => {
    const { users, admitted, count } = fixture();
    await admitted("ada");
    await users.connectorIntegrations.put(google);
    await users.connectFlows.create(oauthFlow);

    await users.records.delete("ada");

    expect(await count("user_connector_integrations", "ada")).toBe(0);
    expect(await count("connect_flows", "ada")).toBe(0);
  });

  it("sweeps flows past their expiry", async () => {
    const { store, users, admitted } = fixture();
    await admitted("ada");
    await users.connectFlows.create(oauthFlow);
    await users.connectFlows.create({ ...oauthFlow, flowId: "fresh", expireAt: NOW + 10 * 600_000 });

    const swept = await store.sweepExpired(NOW + 600_001, 100);

    expect(swept.connectFlows).toBe(1);
    expect(await users.connectFlows.get("nonce-1")).toBeNull();
    expect(await users.connectFlows.get("fresh")).not.toBeNull();
  });
});
