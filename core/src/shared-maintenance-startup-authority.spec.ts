import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { issueSharedMaintenanceStartupPermit } from "./shared-maintenance-startup-authority.js";
import { allowSharedMaintenanceLaunch } from "./shared-maintenance-startup.js";

const keys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "pem", type: "spki" }, privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const request = { namespace: "octogee-test", gatewayId: "shared-fixture", podUid: "fixture-pod", attemptId: "fixture-attempt",
  buildId: "a".repeat(40), nonce: "b".repeat(64), role: "gateway-edge" } as const;
const binding = { namespace: request.namespace, gatewayId: request.gatewayId, podUid: request.podUid,
  serviceAccountName: "octogee-gw-shared-fixture", sidecarAudience: true };
const gatewayDigest = "sha256:" + "d".repeat(64), edgeDigest = "sha256:" + "e".repeat(64);
const authority = { ...binding, attemptId: request.attemptId, roles: {
  gateway: { previousContainerId: "g1", runningContainerId: "g2", buildId: request.buildId, acceptedImageId: gatewayDigest, runningImageId: gatewayDigest },
  "gateway-edge": { previousContainerId: "e1", runningContainerId: "e2", buildId: request.buildId, acceptedImageId: edgeDigest, runningImageId: edgeDigest },
}, verifiedRestoredArchive: { attemptId: request.attemptId, sha256: "c".repeat(64) } };

it("binds the sidecar token and both actual replaced runtime roles to a new launch nonce", async () => {
  const readVerifiedAuthority = vi.fn(async () => authority);
  const proof = await issueSharedMaintenanceStartupPermit({ request, binding, readVerifiedAuthority, fleetPrivateKey: keys.privateKey, now: () => 10 });
  expect(readVerifiedAuthority).toHaveBeenCalledTimes(2);
  expect(proof).not.toBeNull();
  expect(allowSharedMaintenanceLaunch({ request, proof: proof!, publicKey: keys.publicKey, now: 20 })).toBe(true);
});

it("fails before trusted custody reads for wrong Pod or missing sidecar audience, and refuses an in-place role that did not replace its writer", async () => {
  const readVerifiedAuthority = vi.fn(async () => authority);
  const input = { request, binding, readVerifiedAuthority, fleetPrivateKey: keys.privateKey };
  await expect(issueSharedMaintenanceStartupPermit({ ...input, binding: { ...binding, podUid: "another" } })).resolves.toBeNull();
  await expect(issueSharedMaintenanceStartupPermit({ ...input, binding: { ...binding, sidecarAudience: false } })).resolves.toBeNull();
  expect(readVerifiedAuthority).not.toHaveBeenCalled();
  readVerifiedAuthority.mockResolvedValueOnce({ ...authority, roles: { ...authority.roles, gateway: {
    ...authority.roles.gateway, runningContainerId: authority.roles.gateway.previousContainerId,
  } } });
  await expect(issueSharedMaintenanceStartupPermit(input)).resolves.toBeNull();
});

it("fails closed when the archive belongs to a prior attempt or live custody changes during the read", async () => {
  const readVerifiedAuthority = vi.fn(async () => authority);
  const input = { request, binding, readVerifiedAuthority, fleetPrivateKey: keys.privateKey };
  readVerifiedAuthority.mockResolvedValueOnce({ ...authority, verifiedRestoredArchive: { attemptId: "prior-attempt", sha256: "c".repeat(64) } });
  await expect(issueSharedMaintenanceStartupPermit(input)).resolves.toBeNull();
  readVerifiedAuthority.mockResolvedValueOnce({ ...authority, roles: { ...authority.roles, gateway: { ...authority.roles.gateway,
    runningImageId: edgeDigest,
  } } });
  await expect(issueSharedMaintenanceStartupPermit(input)).resolves.toBeNull();
  readVerifiedAuthority.mockResolvedValueOnce(authority).mockResolvedValueOnce({ ...authority, roles: {
    ...authority.roles, gateway: { ...authority.roles.gateway, runningContainerId: "g3" },
  } });
  await expect(issueSharedMaintenanceStartupPermit(input)).resolves.toBeNull();
});
