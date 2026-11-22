import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { HeldNativeSourceClaim } from "@octogee/shared/types/fleet-controller";
import { requestHeldNativeSourceHold } from "./fleet-migration-client.js";
import { heldNativeSourceHoldAudience, heldNativeSourceHoldJobId, verifyFleetRequest } from "./fleet-signature.js";

const key = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "pem", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const scope = {
  uid: "fixture-owner", slug: "owner", targetGatewayId: "shared", operationId: "operation",
  sourceEpoch: 10, schedulerMigrationId: "migration", requestId: "a".repeat(64),
};
const source = { vmId: "123", bootDiskId: "456", homeDiskId: "789", bootId: "e5d98ee3-c941-4ace-88fa-d3615db14121" };
const claim: HeldNativeSourceClaim = { ...scope, ...source, gatewayId: "isolated", claimStartedAt: 123 };
const hold = {
  scope: { ...scope, sourceGatewayId: "isolated" }, source, generation: "b".repeat(64), heldSince: 124,
  stores: [{ storeId: "primary", databaseIdentity: "fixture-db-primary" }],
};
const gce = { projectId: "fixture-project", zone: "fixture-zone", instanceName: "fixture-instance", serviceAccountEmail: "fixture@example.test" };
const identity = { iss: "accounts.google.com", email_verified: true, email: gce.serviceAccountEmail,
  google: { compute_engine: { project_id: gce.projectId, zone: gce.zone, instance_name: gce.instanceName, instance_id: claim.vmId } } };
const input = { claim, gce, action: "read" as const, sourceUrl: "https://fixture.local", privateKey: key.privateKey };


describe("held Native source live hold reads", () => {
  it("signs the scoped fresh challenge and validates the response", async () => {
    let audience: string;
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(String(url)).toBe("https://fixture.local/held-native-source-hold/read/isolated");
      expect(init?.redirect).toBe("error");
      const raw = String(init?.body);
      const signed = new Headers(init?.headers).get("x-fleet-controller-signature") ?? undefined;
      expect(verifyFleetRequest(key.publicKey, heldNativeSourceHoldJobId("read", "operation", "isolated"), raw, signed)).toBe(true);
      audience = heldNativeSourceHoldAudience(input.action, raw, hold);
      return Response.json({ nonce: JSON.parse(raw).nonce, hold, instanceIdentity: "signed-instance" });
    });
    const verifyInstanceIdentity = vi.fn(async (token, signedAudience) => {
      expect(token).toBe("signed-instance");
      expect(signedAudience).toBe(audience);
      return identity;
    });
    await expect(requestHeldNativeSourceHold({ ...input, fetch, verifyInstanceIdentity })).resolves.toEqual(hold);
    await expect(requestHeldNativeSourceHold({ ...input, fetch, verifyInstanceIdentity })).resolves.toEqual(hold);
    await expect(requestHeldNativeSourceHold({ ...input, sourceUrl: "http://10.20.30.40", fetch: async (_url, init) => {
      const raw = String(init?.body);
      audience = heldNativeSourceHoldAudience(input.action, raw, hold);
      return Response.json({ nonce: JSON.parse(raw).nonce, hold, instanceIdentity: "signed-instance" });
    }, verifyInstanceIdentity })).resolves.toEqual(hold);
    expect(fetch.mock.calls[0]?.[1]?.body).not.toBe(fetch.mock.calls[1]?.[1]?.body);
  });

  it("rejects another authenticated GCE instance", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      Response.json({ nonce: JSON.parse(String(init?.body)).nonce, hold, instanceIdentity: "signed-other-instance" }));
    await expect(requestHeldNativeSourceHold({ ...input, fetch, verifyInstanceIdentity: async () => ({
      ...identity, google: { compute_engine: { ...identity.google.compute_engine, instance_id: "987" } },
    }) })).rejects.toThrow("unexpected GCE instance");
  });

  it("rejects plaintext, stale nonces, changed backing, and duplicate store identities", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(requestHeldNativeSourceHold({ ...input, sourceUrl: "http://fixture.local", fetch })).rejects.toThrow("HTTPS");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(Response.json({ nonce: "a".repeat(64), hold }));
    await expect(requestHeldNativeSourceHold({ ...input, fetch })).rejects.toThrow("stale");
    for (const changed of [{ ...hold, source: { ...source, homeDiskId: "654" } }, { ...hold, stores: [...hold.stores, ...hold.stores] }]) {
      fetch.mockImplementationOnce(async (_url, init) => Response.json({ nonce: JSON.parse(String(init?.body)).nonce, hold: changed }));
      await expect(requestHeldNativeSourceHold({ ...input, fetch })).rejects.toThrow("mismatched");
    }
  });
});
