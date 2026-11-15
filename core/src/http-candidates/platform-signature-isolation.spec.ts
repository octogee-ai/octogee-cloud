import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signAgentControlRouterRequest, verifyAgentControlRouterRequest } from "./agent-control-callback-router.js";
import { createModelCredentialSyncAuthHeaders, isValidModelCredentialSyncSignature } from "../model-credentials/byot-sync-internal-auth.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("platform signatures across tenant-owned runtimes", () => {
  it("verifies callback requests using a key that cannot sign another gateway's request", () => {
    const body = Buffer.from('{"user_id":"owner"}');
    const proof = { gatewayId: "b-one", timestamp: "1000", signature: signAgentControlRouterRequest(body, "b-one", "1000", privateKey) };
    expect(verifyAgentControlRouterRequest(body, proof, publicKey, 1000)).toBe(true);
    expect(verifyAgentControlRouterRequest(body, { ...proof, gatewayId: "b-two" }, publicKey, 1000)).toBe(false);
    expect(() => signAgentControlRouterRequest(body, "b-two", "1000", publicKey)).toThrow();
  });

  it("binds signed model syncs to their destination and gives the runtime no signing authority", () => {
    const body = { username: "one" };
    const headers = createModelCredentialSyncAuthHeaders({ body, gatewayId: "b-one", secret: privateKey, nowMs: 1000 });
    const args = { body, gatewayId: "b-one", publicKey, timestamp: headers["x-byot-sync-timestamp"], signature: headers["x-byot-sync-signature"], nowMs: 1000 };
    expect(isValidModelCredentialSyncSignature(args)).toBe(true);
    expect(isValidModelCredentialSyncSignature({ ...args, gatewayId: "b-two" })).toBe(false);
    expect(isValidModelCredentialSyncSignature({ ...args, body: { username: "two" } })).toBe(false);
    expect(isValidModelCredentialSyncSignature({ ...args, nowMs: 301001 })).toBe(false);
    expect(() => createModelCredentialSyncAuthHeaders({ body, gatewayId: "b-two", secret: publicKey })).toThrow();
  });
});
