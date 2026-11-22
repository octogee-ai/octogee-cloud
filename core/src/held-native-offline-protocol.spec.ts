import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  signOfflineNativeRequest, signOfflineNativeResult, verifyOfflineNativeRequest, verifyOfflineNativeResult, type OfflineNativeRequest,
} from "./held-native-offline-protocol.js";

function signer() {
  return generateKeyPairSync("ed25519", { privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
}
const fleet = signer();
const maintenance = signer();
const original = signer();
const request: OfflineNativeRequest = {
  action: "reconcile", nonce: "e".repeat(64), expiresAt: 120,
  identity: {
    uid: "synthetic", slug: "owner", operationId: "operation", sourceGatewayId: "s", targetGatewayId: "t",
    requestId: "b".repeat(64), sourceEpoch: 20, schedulerMigrationId: "journal", claimStartedAt: 40, holdGeneration: "c".repeat(64),
    original: { instanceId: "81", bootDiskId: "82", homeDiskId: "83" },
    maintenance: { instanceId: "91", bootDiskId: "92", bootId: "336053f2-c076-4202-9851-d713bce658a3", acceptedImageId: "93", cloneDiskId: "94" },
    immutableSnapshotId: "84", cleanFileSha256: "d".repeat(64), ownerStoreSha256: "f".repeat(64),
  },
};

describe("alternate held Native source protocol", () => {
  it("pins separately authenticated original and maintenance identities and accepts the scoped result", () => {
    const signed = signOfflineNativeRequest(request, fleet.privateKey);
    expect(verifyOfflineNativeRequest({ ...signed, expected: request.identity, fleetPublicKey: fleet.publicKey, now: 80 })).toEqual(request);
    const proof = { request, outcome: "staged" as const, fileSha256: "a".repeat(64), ownerAnchorSha256: "b".repeat(64) };
    const result = signOfflineNativeResult(proof, maintenance.privateKey);
    expect(verifyOfflineNativeResult({ ...result, request, maintenancePublicKey: maintenance.publicKey, now: 80 })).toEqual(proof);
    expect(() => verifyOfflineNativeResult({ ...result, request, maintenancePublicKey: original.publicKey, now: 80 })).toThrow("fresh maintenance authority");
    expect(() => verifyOfflineNativeResult({ ...result, request: { ...request, nonce: "0".repeat(64) }, maintenancePublicKey: maintenance.publicKey, now: 80 })).toThrow("fresh maintenance authority");
    expect(() => verifyOfflineNativeRequest({ ...signed, expected: { ...request.identity, sourceEpoch: 21 }, fleetPublicKey: fleet.publicKey, now: 80 })).toThrow("mismatched authority");
    expect(() => verifyOfflineNativeRequest({ ...signed, expected: request.identity, fleetPublicKey: fleet.publicKey, now: 121 })).toThrow("stale");
  });

  it("accepts rollback only for the pre-authorized clean retained file hash", () => {
    const rollback = { ...request, action: "rollback" as const };
    const bad = signOfflineNativeResult({
      request: rollback, outcome: "restored", fileSha256: "0".repeat(64), ownerAnchorSha256: "b".repeat(64),
    }, maintenance.privateKey);
    expect(() => verifyOfflineNativeResult({ ...bad, request: rollback, maintenancePublicKey: maintenance.publicKey, now: 80 })).toThrow("fresh maintenance authority");
  });
});
