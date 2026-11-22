import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { signOfflineNativeResult, verifyOfflineNativeRequest, type OfflineNativeRecoveryIdentity } from "@octogee/core/held-native-offline-protocol";
import { createHeldNativeOfflineSourceClient, digestHeldOfflineStoreBackups } from "./held-native-offline-source-client.js";
import type { NativeReturnVerifiedBackup } from "./held-native-return-backup.js";
import type { OfflineNativeReturnCustody } from "./held-native-offline-custody.js";

function keys() {
  return generateKeyPairSync("ed25519", { publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" } });
}
const scope = {
  uid: "fixture", slug: "fixture", operationId: "op", sourceGatewayId: "source", targetGatewayId: "target",
  sourceEpoch: 10, requestId: "a".repeat(64), schedulerMigrationId: "journal",
};
const bootId = "336053f2-c076-4202-9851-d713bce658a3";
const source = { vmId: "11", bootId, bootDiskId: "12", homeDiskId: "13" };
const store = { storeId: "owner", databaseIdentity: "fixture-owner-db" };
const backup: NativeReturnVerifiedBackup = {
  scope, source, holdGeneration: "b".repeat(64), heldSince: 100,
  homeBackup: { artifactId: "immutable-home", artifactSha256: "c".repeat(64), immutableGeneration: "90" },
  storeBackups: [{ store, artifactId: "immutable-db", artifactSha256: "d".repeat(64), immutableGeneration: "91" }],
};
const custody: OfflineNativeReturnCustody = {
  scope,
  original: { projectId: "test", zone: "zone", instanceName: "old", instanceId: "11", bootDiskId: "12", homeDiskId: "13" },
  maintenance: { projectId: "test", zone: "zone", instanceName: "clean", instanceId: "21", bootDiskId: "22",
    bootId, imageId: "23", lastStartedAt: 30, serviceAccountEmail: null, readOnlyCloneDiskId: "24" },
  immutableHomeSnapshotId: "90",
};
const identity: OfflineNativeRecoveryIdentity = {
  ...scope, claimStartedAt: 10, holdGeneration: backup.holdGeneration,
  original: { instanceId: "11", bootDiskId: "12", homeDiskId: "13" },
  maintenance: { instanceId: "21", bootDiskId: "22", acceptedImageId: "23", cloneDiskId: "24", bootId },
  immutableSnapshotId: "90", cleanFileSha256: "e".repeat(64), ownerAnchorSha256: "f".repeat(64),
  ownerStoreSha256: digestHeldOfflineStoreBackups(backup),
};

function fixture() {
  const fleet = keys();
  const guest = keys();
  const enrollment = { custody, identity, maintenancePublicKey: guest.publicKey, verifiedHomeBackup: backup.homeBackup };
  const readHold = vi.fn().mockResolvedValue({ scope, source, generation: backup.holdGeneration, stores: [store], heldSince: 100 });
  const loadInvocation = vi.fn().mockResolvedValue(enrollment);
  const dispatch = vi.fn(async (_vm, signed) => {
    const request = verifyOfflineNativeRequest({ ...signed, expected: identity, fleetPublicKey: fleet.publicKey, now: 120 });
    return signOfflineNativeResult({
      request, fileSha256: "a".repeat(64), ownerAnchorSha256: identity.ownerAnchorSha256, outcome: "staged",
    }, guest.privateKey);
  });
  const client = createHeldNativeOfflineSourceClient({ privateKey: fleet.privateKey, readHold, loadInvocation, dispatch, now: () => 120 });
  return { client, readHold, loadInvocation, dispatch, enrollment, input: { backup, claimStartedAt: 10, action: "reconcile" as const, assertJournalCurrent: vi.fn().mockResolvedValue(undefined) } };
}

describe("held offline alternate source client", () => {
  it("dispatches only to the exact clean enrolled VM and verifies a scoped staged receipt", async () => {
    const f = fixture();
    await expect(f.client(f.input)).resolves.toMatchObject({ outcome: "staged", ownerAnchorSha256: identity.ownerAnchorSha256 });
    expect(f.dispatch).toHaveBeenCalledWith(custody.maintenance, expect.any(Object));
    expect(f.readHold).toHaveBeenCalledTimes(2);
  });

  it("refuses to dispatch a different backup or retired maintenance boot", async () => {
    const f = fixture();
    const stale = { ...identity, ownerStoreSha256: "0".repeat(64) };
    f.loadInvocation.mockResolvedValueOnce({ ...f.enrollment, identity: stale });
    await expect(f.client(f.input)).rejects.toThrow("backup evidence");
    f.loadInvocation.mockResolvedValueOnce({ ...f.enrollment, identity: { ...identity, maintenance: { ...identity.maintenance, bootId: "foreign" } } });
    await expect(f.client(f.input)).rejects.toThrow("maintenance compute");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
