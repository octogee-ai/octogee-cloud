import { generateKeyPairSync } from "node:crypto";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import { expect, test, vi } from "vitest";
import { readHeldNativeOfflineDesiredProjection, signHeldNativeOfflineDesiredProjection } from "./held-native-offline-projection.js";

const keys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const scope = {
  uid: "fixture-owner", slug: "fixture", operationId: "fixture-return", gatewayId: "builder-fixture",
  requestId: "a".repeat(64), holdGeneration: "b".repeat(64),
};
const coachToken = "fixture-coach-plaintext", projectToken = "fixture-project-plaintext";
const snapshot: FleetBrokerUserSnapshot = {
  uid: scope.uid, slug: scope.slug, gatewayId: scope.gatewayId, status: "complete", runtimeMutationFenced: true,
  contextTemplateKey: "fixture", planInputs: {}, agentIds: ["octogee-fixture-coach"],
  email: "fixture@email.invalid", displayName: "Fixture", ownerName: "Fixture", lastName: "Example", photoURL: "",
  persona: null, repoUrl: "https://unexpected-fixture-user:fixture-repo-secret@fixture-repository.invalid/owner/repo",
  mattermostUserId: null, customerMmUserId: null, coachMmUserId: null, coachToken, channels: [], projects: [],
  projectAgents: [{ projectId: "work", enabled: true, mmUserId: null, token: projectToken }],
};

test("publishes only credential-free desired inputs and reconstructs the canonical owner credential set locally", async () => {
  const signed = signHeldNativeOfflineDesiredProjection({ scope, snapshot, fleetPrivateKey: keys.privateKey });
  expect(signed.raw).not.toContain(coachToken);
  expect(signed.raw).not.toContain(projectToken);
  expect(signed.raw).not.toContain("fixture-repo-secret");
  expect(signed.raw).not.toContain("fixture@email.invalid");
  const readRestoredCredential = vi.fn(async account => account === "fixture-coach" ? coachToken : projectToken);
  const restored = await readHeldNativeOfflineDesiredProjection({
    ...signed, scope, expectedSha256: signed.sha256, fleetPublicKey: keys.publicKey, readRestoredCredential,
  });
  expect(restored).toMatchObject({
    coachToken, projectAgents: [{ projectId: "work", token: projectToken }], runtimeMutationFenced: true,
  });
  expect(readRestoredCredential.mock.calls).toEqual([["fixture-coach"], ["fixture-proj-work"]]);
});

test("rejects stale or foreign recovery projection and mismatched retained credentials", async () => {
  const signed = signHeldNativeOfflineDesiredProjection({ scope, snapshot, fleetPrivateKey: keys.privateKey });
  const readRestoredCredential = vi.fn(async () => "stale-fixture-token");
  const options = { ...signed, scope, expectedSha256: signed.sha256, fleetPublicKey: keys.publicKey, readRestoredCredential };
  await expect(readHeldNativeOfflineDesiredProjection({ ...options, expectedSha256: "c".repeat(64) })).rejects.toThrow("signed maintenance request");
  await expect(readHeldNativeOfflineDesiredProjection({ ...options, scope: { ...scope, gatewayId: "foreign-fixture" } }))
    .rejects.toThrow("signed maintenance request");
  expect(readRestoredCredential).not.toHaveBeenCalled();
  await expect(readHeldNativeOfflineDesiredProjection(options)).rejects.toThrow("restored credential does not match");
  expect(readRestoredCredential.mock.calls).toEqual([["fixture-coach"]]);
  expect(() => signHeldNativeOfflineDesiredProjection({ scope, snapshot: { ...snapshot, runtimeMutationFenced: false }, fleetPrivateKey: keys.privateKey }))
    .toThrow("unfenced or foreign owner");
});
