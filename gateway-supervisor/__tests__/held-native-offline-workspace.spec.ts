import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { signOfflineNativeRequest, verifyOfflineNativeResult, type OfflineNativeRecoveryIdentity } from "@octogee/core/held-native-offline-protocol";
import { createHeldNativeOfflineWorkspaceActor } from "../lib/held-native-offline-workspace.js";

const slug = "fixture";
const node = "octogee-fixture-coach";
const content = JSON.stringify({ agents: { entries: { [node]: { identity: { name: "Previously retained" } } } } });
const desired = { agents: { entries: { [node]: { identity: { name: "Verified synthetic" } } } } };
const anchor = "Synthetic retained owner";
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const seed: OfflineNativeRecoveryIdentity = {
  uid: slug, slug, operationId: "op", sourceGatewayId: "source", targetGatewayId: "target", sourceEpoch: 10,
  requestId: "a".repeat(64), schedulerMigrationId: "journal", claimStartedAt: 12, holdGeneration: "c".repeat(64),
  original: { instanceId: "11", bootDiskId: "12", homeDiskId: "13" },
  maintenance: { instanceId: "21", bootDiskId: "22", bootId: "336053f2-c076-4202-9851-d713bce658a3", acceptedImageId: "23", cloneDiskId: "24" },
  immutableSnapshotId: "31", cleanFileSha256: digest(content), ownerAnchorSha256: digest(anchor), ownerStoreSha256: "e".repeat(64),
    desiredSnapshotSha256: "d".repeat(64),
};

function keys() {
  return generateKeyPairSync("ed25519", { publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" } });
}

describe.skipIf(process.platform !== "linux")("trusted offline Native actor", () => {
  it("durably consumes requests, preserves original bytes, and restores from them after an interrupted stage", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "held-native-actor-")));
    const stateDirectory = join(root, "stage");
    const controlDirectory = join(root, "control");
    const originalConfig = join(root, "clean-config.json");
    const originalOwnerAnchor = join(root, "clean-owner.md");
    const stageConfig = join(stateDirectory, "openclaw.json");
    const fleet = keys();
    const maintenance = keys();
    try {
      await mkdir(stateDirectory, { mode: 0o700 });
      await mkdir(controlDirectory, { mode: 0o700 });
      await writeFile(originalConfig, content);
      await writeFile(originalOwnerAnchor, anchor);
      const assertCurrent = vi.fn().mockResolvedValue(undefined);
      const actor = createHeldNativeOfflineWorkspaceActor({
        expected: seed, fleetPublicKey: fleet.publicKey, maintenancePrivateKey: maintenance.privateKey, now: () => 100,
        assertCurrent,
        workspace: {
          stateDirectory, controlDirectory, originalConfig, originalOwnerAnchor, stageEnvironment: {},
          assertReadOnlyOriginal: vi.fn().mockResolvedValue(undefined), assertIsolatedRuntime: vi.fn().mockResolvedValue(undefined),
          assertOwnerAnchorsAndRoster: vi.fn().mockResolvedValue(undefined),
          readStage: async () => {
            const bytes = await readFile(stageConfig);
            return { value: JSON.parse(bytes.toString()), contentSha256: digest(bytes) };
          },
        },
        compose: () => ({ patch: desired, replacePaths: [] }),
        runNative: async (args, invocation) => {
          expect(invocation.env.OPENCLAW_CONFIG_PATH).toBe(stageConfig);
          if (args.includes("--dry-run")) {
            return { code: 0, stdout: JSON.stringify({ ok: true, checks: { schema: true, resolvability: true, resolvabilityComplete: true }, skippedExecRefs: 0 }) };
          }
          if (args.includes("patch")) await writeFile(stageConfig, JSON.stringify(desired));
          return { code: 0, stdout: "" };
        },
      });
      const request = { identity: seed, action: "reconcile" as const, nonce: "a".repeat(64), expiresAt: 200 };
      const attempt = signOfflineNativeRequest(request, fleet.privateKey);
      const proof = await actor(attempt);
      expect(verifyOfflineNativeResult({ ...proof, request, maintenancePublicKey: maintenance.publicKey, now: 100 }).outcome).toBe("staged");
      await expect(actor(attempt)).rejects.toThrow("EEXIST");
      await writeFile(stageConfig, '{"interrupted":true}');
      const rollback = { ...request, action: "rollback" as const, nonce: "b".repeat(64) };
      const recovered = await actor(signOfflineNativeRequest(rollback, fleet.privateKey));
      expect(verifyOfflineNativeResult({ ...recovered, request: rollback, maintenancePublicKey: maintenance.publicKey, now: 100 }).fileSha256).toBe(seed.cleanFileSha256);
      await expect(readFile(stageConfig, "utf8")).resolves.toBe(content);
      await expect(readFile(originalConfig, "utf8")).resolves.toBe(content);
      await expect(readFile(originalOwnerAnchor, "utf8")).resolves.toBe(anchor);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
