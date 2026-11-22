import { generateKeyPairSync } from "node:crypto";
import { link, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signHeldNativeOfflineDesiredProjection, type OfflineNativeRequest } from "@octogee/core/held-native-offline-protocol";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import { expect, it, vi } from "vitest";
import { readVerifiedHeldNativeDesired, validateHeldNativeMaintenanceEnrollment } from "../entrypoints/held-native-offline-maintenance.js";

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn(() => () => ({ patch: {}, replacePaths: [] })) }));
vi.mock("../lib/user-lifecycle-broker-adapter.js", () => ({ prepareHeldBrokerNativeProjectionFromSnapshot: prepare }));

const scope = {
  uid: "uid-owner", slug: "owner", gatewayId: "builder-owner", operationId: "return-owner",
  requestId: "a".repeat(64), holdGeneration: "b".repeat(64),
};
const keys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const desired = signHeldNativeOfflineDesiredProjection({
  scope, fleetPrivateKey: keys.privateKey, snapshot: {
    uid: scope.uid, slug: scope.slug, gatewayId: scope.gatewayId, status: "complete", runtimeMutationFenced: true,
    coachToken: "private-fixture-token", agentIds: ["octogee-owner-coach"], channels: [], projects: [],
  } as FleetBrokerUserSnapshot,
});
const identity = {
  ...scope, sourceGatewayId: scope.gatewayId, targetGatewayId: "shared", sourceEpoch: 1, schedulerMigrationId: "scheduler",
  claimStartedAt: 10, desiredSnapshotSha256: desired.sha256,
  original: { instanceId: "1", bootDiskId: "2", homeDiskId: "3" },
  maintenance: { instanceId: "4", bootDiskId: "5", bootId: "336053f2-c076-4202-9851-d713bce658a3", acceptedImageId: "6", cloneDiskId: "7" },
  immutableSnapshotId: "8", cleanFileSha256: "c".repeat(64), ownerAnchorSha256: "d".repeat(64), ownerStoreSha256: "e".repeat(64),
};
const request: OfflineNativeRequest = { identity, action: "reconcile", nonce: "f".repeat(64), expiresAt: 20 };

it("requires the originally restored inode and retained roster before composing the owner", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "held-native-entrypoint-")));
  try {
    const cleanCredential = join(home, "clean.json");
    const aliasCredential = join(home, "alias.json");
    const credentials = JSON.stringify({ "owner-coach": "private-fixture-token" });
    const options = { cleanCredential, aliasCredential, readReviewedDesired: async () => Buffer.from(JSON.stringify(desired)) };
    await writeFile(cleanCredential, credentials);
    await writeFile(aliasCredential, credentials);
    await expect(readVerifiedHeldNativeDesired(request, ["octogee-owner-coach"], keys.publicKey, options))
      .rejects.toThrow("not the exact restored file");
    await rm(aliasCredential);
    await link(cleanCredential, aliasCredential);
    await expect(readVerifiedHeldNativeDesired(request, ["octogee-foreign-coach"], keys.publicKey, options))
      .rejects.toThrow("roster differs");
    expect(prepare).not.toHaveBeenCalled();
    const project = await readVerifiedHeldNativeDesired(request, ["octogee-owner-coach"], keys.publicKey, options);
    expect(project({})).toEqual({ patch: {}, replacePaths: [] });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ uid: scope.uid, coachToken: "private-fixture-token" }));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("refuses root, a different maintenance UID and malformed enrollment anchors", () => {
  const { claimStartedAt: _claim, ...expected } = identity;
  const enrollment = {
    version: 1 as const, expected, maintenanceUid: 1000, earliestClaimStartedAt: 10, cloneDevice: "fixture-disk",
    originalConfig: ".openclaw/openclaw.json", originalOwnerAnchor: ".openclaw/owner.md",
    anchorWitnesses: [{ path: ".openclaw/owner.md", sha256: "0".repeat(64) }], agentIds: ["octogee-owner-coach"],
  };
  expect(() => validateHeldNativeMaintenanceEnrollment(enrollment, 1000)).not.toThrow();
  expect(() => validateHeldNativeMaintenanceEnrollment(enrollment, 1002)).toThrow("enrollment is invalid");
  expect(() => validateHeldNativeMaintenanceEnrollment({ ...enrollment, maintenanceUid: 0 }, 0)).toThrow("enrollment is invalid");
  expect(() => validateHeldNativeMaintenanceEnrollment({
    ...enrollment, anchorWitnesses: [{ path: "../foreign", sha256: "0".repeat(64) }],
  }, 1000)).toThrow("clone-relative file");
});
