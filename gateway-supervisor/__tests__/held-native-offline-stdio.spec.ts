import { generateKeyPairSync } from "node:crypto";
import { signOfflineNativeRequest, verifyOfflineNativeRequest } from "@octogee/core/held-native-offline-protocol";
import { expect, test, vi } from "vitest";
import { readHeldNativeStdioEnvelope, runHeldNativeOfflineStdio, type HeldNativeOfflineStdioOptions } from "../lib/held-native-offline-stdio.js";
import { assertOfflineListenSockets, readEligibleOfflineMount } from "../lib/held-native-offline-linux.js";

const { verifyWorkspace } = vi.hoisted(() => ({ verifyWorkspace: vi.fn() }));
vi.mock("../lib/held-native-offline-workspace.js", () => ({ createHeldNativeOfflineWorkspaceActor: verifyWorkspace }));

const expected = {
  uid: "fixture-uid", slug: "fixture", operationId: "return-fixture", sourceGatewayId: "gce-fixture", targetGatewayId: "shared-fixture",
  requestId: "a".repeat(64), schedulerMigrationId: "fixture-cron", sourceEpoch: 8, holdGeneration: "b".repeat(64),
  original: { instanceId: "123", bootDiskId: "124", homeDiskId: "125" },
  maintenance: { instanceId: "321", bootDiskId: "322", bootId: "fixture-boot", acceptedImageId: "323", cloneDiskId: "324" },
  immutableSnapshotId: "901", cleanFileSha256: "c".repeat(64), ownerAnchorSha256: "d".repeat(64), ownerStoreSha256: "e".repeat(64),
    desiredSnapshotSha256: "d".repeat(64),
};
const keys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const sampleSigned = (claimStartedAt: number, nonce = "f".repeat(64), identity = expected) => signOfflineNativeRequest({
  identity: { ...identity, claimStartedAt }, action: "reconcile", nonce, expiresAt: 1000,
}, keys.privateKey);
async function* frames(...data: string[]) { for (const chunk of data) yield chunk; }

test("only accepts one bounded JSON envelope and rejects foreign fixed recovery identity", async () => {
  expect(await readHeldNativeStdioEnvelope(frames(...JSON.stringify(sampleSigned(700)).match(/.{1,31}/g)!))).toEqual(sampleSigned(700));
  const runtime = {
    expected, earliestClaimStartedAt: 650, fleetPublicKey: keys.publicKey, now: () => 800,
    workspace: { assertIsolatedRuntime: vi.fn(async () => {}), assertReadOnlyOriginal: vi.fn(async () => {}) },
    prepareProjection: vi.fn(async () => () => ({ patch: {}, replacePaths: [] })),
  } as HeldNativeOfflineStdioOptions;
  verifyWorkspace.mockImplementation(options => async input => {
    const verified = verifyOfflineNativeRequest({ ...input, expected: options.expected, fleetPublicKey: options.fleetPublicKey, now: options.now() });
    await options.assertCurrent(verified);
    return input;
  });
  await expect(runHeldNativeOfflineStdio(runtime, frames(JSON.stringify(sampleSigned(700))))).resolves.toEqual(sampleSigned(700));
  await expect(runHeldNativeOfflineStdio(runtime, frames(JSON.stringify(sampleSigned(640))))).rejects.toThrow("no enrolled claim");
  await expect(runHeldNativeOfflineStdio(runtime, frames(JSON.stringify(sampleSigned(700, undefined, { ...expected, uid: "foreign" })))))
    .rejects.toThrow("mismatched authority");
  await expect(readHeldNativeStdioEnvelope(frames("a".repeat(24577)))).rejects.toThrow("too large");
  await expect(readHeldNativeStdioEnvelope(frames(JSON.stringify(sampleSigned(700)), JSON.stringify(sampleSigned(700)))))
    .rejects.toThrow();
});

test("permits only management sockets and a unique exact clone mount with no journal replay", () => {
  const mount = "/mnt/octogee-held-native-original";
  const eligible = { target: mount, source: "/dev/sdb", options: "ro,noexec,nodev,nosuid,norecovery", "maj:min": "8:16" };
  expect(readEligibleOfflineMount({ filesystems: [eligible] }, mount)).toEqual(eligible);
  expect(() => readEligibleOfflineMount({ filesystems: [{ ...eligible, options: "ro,noexec,nodev,nosuid" }] }, mount)).toThrow("without journal replay");
  expect(() => readEligibleOfflineMount({ filesystems: [{ ...eligible, children: [eligible] }] }, mount)).toThrow("exact enrolled volume");
  expect(() => readEligibleOfflineMount({ filesystems: [eligible, eligible] }, mount)).toThrow("ambiguous");
  const header = " sl local_address rem_address st";
  expect(() => assertOfflineListenSockets(`${header}\n0: 00000000:0016 00000000:0000 0A\n1: 3500007F:0035 00000000:0000 0A`))
    .not.toThrow();
  expect(() => assertOfflineListenSockets(`${header}\n0: 00000000:4961 00000000:0000 0A`)).toThrow("unexpected TCP listener");
});
