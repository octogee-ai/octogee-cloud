import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { issueSharedMaintenanceCompletion, issueSharedMaintenanceStartupPair } from "./shared-maintenance-startup-authority.js";
import { allowSharedMaintenanceLaunch, allowSharedMaintenanceRestart, projectedSharedMaintenancePodUid } from "./shared-maintenance-startup.js";

const keys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const request = { namespace: "octogee-test", gatewayId: "shared-fixture", podUid: "fixture-pod", attemptId: "fixture-attempt",
  buildId: "a".repeat(40), artifactSetId: "d".repeat(64), nonce: "b".repeat(64), role: "gateway-edge" } as const;
const binding = { namespace: request.namespace, gatewayId: request.gatewayId, podUid: request.podUid,
  serviceAccountName: "octogee-gw-shared-fixture", execRole: "gateway-edge" as const };
const gatewayDigest = "sha256:" + "d".repeat(64), edgeDigest = "sha256:" + "e".repeat(64);
const authority = { ...binding, attemptId: request.attemptId, artifactSetId: request.artifactSetId, roles: {
  gateway: { previousContainerId: "g1", runningContainerId: "g2", buildId: request.buildId, acceptedImageId: gatewayDigest, runningImageId: gatewayDigest },
  "gateway-edge": { previousContainerId: "e1", runningContainerId: "e2", buildId: request.buildId, acceptedImageId: edgeDigest, runningImageId: edgeDigest },
}, verifiedRestoredArchive: { attemptId: String(request.attemptId), sha256: "c".repeat(64) } };

const gateway = { request: { ...request, role: "gateway" as const, nonce: "f".repeat(64) },
  binding: { ...binding, execRole: "gateway" as const } };
const edge = { request, binding };

it("binds separately observed exec roles and actual replaced runtime roles to one launch window", async () => {
  const readVerifiedAuthority = vi.fn(async () => authority);
  const proof = await issueSharedMaintenanceStartupPair({
    gateway, edge, readVerifiedAuthority, enrolledIssuerPrivateKey: keys.privateKey, now: () => 10,
  });
  expect(readVerifiedAuthority).toHaveBeenCalledTimes(2);
  expect(proof).not.toBeNull();
  expect(allowSharedMaintenanceLaunch({ request, proof: proof!["gateway-edge"], publicKey: keys.publicKey, now: 20 })).toBe(true);
  expect(allowSharedMaintenanceLaunch({ request: gateway.request, proof: proof!.gateway, publicKey: keys.publicKey, now: 20 })).toBe(true);
});

it("fails before trusted custody reads for wrong Pod or container role and refuses a retained old writer", async () => {
  const readVerifiedAuthority = vi.fn(async () => authority);
  const input = { gateway, edge, readVerifiedAuthority, enrolledIssuerPrivateKey: keys.privateKey };
  await expect(issueSharedMaintenanceStartupPair({ ...input, edge: { ...edge, binding: { ...binding, podUid: "another" } } })).resolves.toBeNull();
  await expect(issueSharedMaintenanceStartupPair({ ...input, edge: { ...edge, binding: { ...binding, execRole: "gateway" } } })).resolves.toBeNull();
  expect(readVerifiedAuthority).not.toHaveBeenCalled();
  readVerifiedAuthority.mockResolvedValueOnce({ ...authority, roles: { ...authority.roles, gateway: {
    ...authority.roles.gateway, runningContainerId: authority.roles.gateway.previousContainerId,
  } } });
  await expect(issueSharedMaintenanceStartupPair(input)).resolves.toBeNull();
});

it("fails closed on an old restore attempt, wrong artifact, or physical custody change", async () => {
  const readVerifiedAuthority = vi.fn(async () => authority);
  const input = { gateway, edge, readVerifiedAuthority, enrolledIssuerPrivateKey: keys.privateKey };
  readVerifiedAuthority.mockResolvedValueOnce({ ...authority, verifiedRestoredArchive: { attemptId: "prior-attempt", sha256: "c".repeat(64) } });
  await expect(issueSharedMaintenanceStartupPair(input)).resolves.toBeNull();
  readVerifiedAuthority.mockResolvedValueOnce({ ...authority, roles: { ...authority.roles, gateway: { ...authority.roles.gateway,
    runningImageId: edgeDigest,
  } } });
  await expect(issueSharedMaintenanceStartupPair(input)).resolves.toBeNull();
  readVerifiedAuthority.mockResolvedValueOnce(authority).mockResolvedValueOnce({ ...authority, roles: {
    ...authority.roles, gateway: { ...authority.roles.gateway, runningContainerId: "g3" },
  } });
  await expect(issueSharedMaintenanceStartupPair(input)).resolves.toBeNull();
});


it("authorizes reboot only after one stable publication for the exact Pod and artifact set", async () => {
  const { nonce: _nonce, role: _role, ...scope } = gateway.request;
  const publication = { release: 7, payloadHash: "a".repeat(64), publishedAt: 25 };
  const readVerifiedPublication = vi.fn(async () => ({ ...authority, publication }));
  const input = { gateway, edge, readVerifiedPublication, enrolledIssuerPrivateKey: keys.privateKey, now: () => 30 };
  const proof = await issueSharedMaintenanceCompletion(input);
  expect(proof).not.toBeNull();
  const validate = { scope, localBoundPodUid: scope.podUid, proof: proof!, publicKey: keys.publicKey, now: 30 };
  expect(JSON.parse(proof!.raw)).toMatchObject({ images: { gateway: gatewayDigest, "gateway-edge": edgeDigest }, publication });
  expect(allowSharedMaintenanceRestart(validate)).toBe(true);
  expect(allowSharedMaintenanceRestart({ ...validate, localBoundPodUid: "replacement" })).toBe(false);
  expect(allowSharedMaintenanceRestart({ ...validate, scope: { ...scope, artifactSetId: "2".repeat(64) } })).toBe(false);
  expect(allowSharedMaintenanceRestart({ ...validate, scope: { ...scope, attemptId: "another-attempt" } })).toBe(false);
  expect(allowSharedMaintenanceRestart({ ...validate, proof: { ...proof!, raw: proof!.raw.replace(edgeDigest, gatewayDigest) } })).toBe(false);
  expect(allowSharedMaintenanceRestart({ ...validate, now: 21 })).toBe(false);
  readVerifiedPublication.mockResolvedValueOnce({ ...authority, publication: { ...publication, release: 0 } });
  await expect(issueSharedMaintenanceCompletion(input)).resolves.toBeNull();
  readVerifiedPublication.mockResolvedValueOnce({ ...authority, publication }).mockResolvedValueOnce({
    ...authority, publication: { ...publication, payloadHash: "b".repeat(64) },
  });
  await expect(issueSharedMaintenanceCompletion(input)).resolves.toBeNull();
});

it("reads only the exact Pod UID from the local kubelet-projected identity hints", () => {
  const claims = Buffer.from(JSON.stringify({
    aud: ["octogee-api-gateway-credentials"],
    "kubernetes.io": { namespace: "octogee-test", pod: { uid: "bound-fixture" } }, ignored: "private-fixture",
  })).toString("base64url");
  expect(projectedSharedMaintenancePodUid(`fixture.${claims}.signature`, "octogee-test")).toBe("bound-fixture");
  expect(projectedSharedMaintenancePodUid(`fixture.${claims}.signature`, "foreign")).toBeNull();
  expect(projectedSharedMaintenancePodUid("invalid", "octogee-test")).toBeNull();
});
