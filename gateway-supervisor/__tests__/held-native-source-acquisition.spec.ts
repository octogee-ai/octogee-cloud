import { generateKeyPairSync } from "node:crypto";
import type { Request, Response } from "express";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";
import { heldNativeSourceHoldAudience, heldNativeSourceHoldJobId, heldNativeSourceReconcileJobId, signFleetRequest } from "@octogee/core/fleet-signature";
import { SIGNATURE_HEADER, type HeldNativeSourceClaim } from "@octogee/shared/types/fleet-controller";
import { createHeldNativeSourceAcquisition, createHeldNativeSourceHoldHandler } from "../lib/held-native-source-acquisition.js";

import { createHeldNativeSourceMaintenanceApp } from "../lib/held-native-source-maintenance-app.js";

const key = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { format: "pem", type: "spki" },
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
});
const now = 20_000;
const claim: HeldNativeSourceClaim = {
  uid: "fixture-owner", slug: "owner", gatewayId: "isolated", targetGatewayId: "shared",
  operationId: "operation", sourceEpoch: 10, schedulerMigrationId: "migration", requestId: "a".repeat(64),
  vmId: "123", bootDiskId: "456", homeDiskId: "789", bootId: "e5d98ee3-c941-4ace-88fa-d3615db14121", claimStartedAt: 10_000,
};

function response() {
  const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  return { res, cast: res as unknown as Response };
}

function request(rawBody: string, signature?: string): Request {
  return { rawBody, params: { gatewayId: "isolated" }, header: (key: string) => key === SIGNATURE_HEADER ? signature : undefined } as unknown as Request;
}

function signed(raw: string, action: "read" | "acquire") {
  return request(raw, signFleetRequest(key.privateKey, heldNativeSourceHoldJobId(action, claim.operationId, claim.gatewayId), raw));
}

describe("held Native source ingress", () => {
  it("authenticates the hold with the exact signed request and guest instance audience", async () => {
    const hold = { generation: "c".repeat(64) };
    const read = vi.fn().mockResolvedValue(hold);
    const identityToken = vi.fn().mockResolvedValue("signed-by-instance");
    const acquisition = { read } as unknown as ReturnType<typeof createHeldNativeSourceAcquisition>;
    const handler = createHeldNativeSourceHoldHandler({ action: "read", publicKey: key.publicKey, gatewayId: "isolated", acquisition, identityToken, now: () => now });
    const nonce = "d".repeat(64);
    const raw = JSON.stringify({ claim, nonce, expiresAt: now + 100 });
    const { res, cast } = response();
    await handler(signed(raw, "read"), cast, vi.fn());
    expect(read).toHaveBeenCalledWith(claim);
    expect(identityToken).toHaveBeenCalledWith(heldNativeSourceHoldAudience("read", raw, hold));
    expect(res.json).toHaveBeenCalledWith({ hold, nonce, instanceIdentity: "signed-by-instance" });
  });

  it("withholds a minted identity token when the live hold changes during attestation", async () => {
    const read = vi.fn().mockResolvedValueOnce({ generation: "c".repeat(64) }).mockResolvedValueOnce({ generation: "e".repeat(64) });
    const identityToken = vi.fn().mockResolvedValue("signed-by-instance");
    const acquisition = { read } as unknown as ReturnType<typeof createHeldNativeSourceAcquisition>;
    const handler = createHeldNativeSourceHoldHandler({ action: "read", publicKey: key.publicKey, gatewayId: "isolated", acquisition, identityToken, now: () => now });
    const raw = JSON.stringify({ claim, nonce: "d".repeat(64), expiresAt: now + 100 });
    const { res, cast } = response();
    await handler(signed(raw, "read"), cast, vi.fn());
    expect(identityToken).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: "held_native_source_hold_unavailable" });
  });

  it("refuses unsigned, wrong-action, stale, and lost authority before issuing identity proof", async () => {
    const read = vi.fn().mockRejectedValue(new Error("owner SQL write hold was lost"));
    const identityToken = vi.fn();
    const acquisition = { read } as unknown as ReturnType<typeof createHeldNativeSourceAcquisition>;
    const handler = createHeldNativeSourceHoldHandler({ action: "read", publicKey: key.publicKey, gatewayId: "isolated", acquisition, identityToken, now: () => now });
    const nonce = "d".repeat(64);
    const raw = JSON.stringify({ claim, nonce, expiresAt: now + 100 });
    const expired = JSON.stringify({ claim, nonce, expiresAt: now - 100 });
    for (const req of [request(raw), signed(raw, "acquire"), signed(expired, "read")]) {
      const { res, cast } = response();
      await handler(req, cast, vi.fn());
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(read).not.toHaveBeenCalled();
    const { res, cast } = response();
    await handler(signed(raw, "read"), cast, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(identityToken).not.toHaveBeenCalled();
  });
});

describe("dedicated held Native maintenance app", () => {
  it("only exposes the signed held paths and requires a current real keeper there", async () => {
    const acquisition = createHeldNativeSourceAcquisition({ acquireHostHold: vi.fn(), now: Date.now });
    const actions = { readSnapshot: vi.fn(), restore: vi.fn(), drain: vi.fn(), flush: vi.fn(), exportManifest: vi.fn() };
    const app = createHeldNativeSourceMaintenanceApp({ gatewayId: claim.gatewayId, publicKey: key.publicKey, acquisition, actions });
    for (const endpoint of ["/restore/isolated", "/resume/isolated", "/scheduler/isolated", "/export/isolated"]) {
      await supertest(app).post(endpoint).send({}).expect(404);
    }
    const migrationId = `mig-${claim.operationId}`;
    const raw = JSON.stringify({ migrationId, slug: claim.slug, binding: { ...claim, holdGeneration: "c".repeat(64) }, nonce: "d".repeat(64), expiresAt: Date.now() + 10_000 });
    const url = "/held-native-source-reconcile/isolated";
    const signature = signFleetRequest(key.privateKey, heldNativeSourceReconcileJobId(migrationId, claim.gatewayId), raw);
    await supertest(app).post(url).set("Content-Type", "application/json").send(raw).expect(401);
    await supertest(app).post(url).set("Content-Type", "application/json").set(SIGNATURE_HEADER, signature).send(raw).expect(409);
    expect(actions.readSnapshot).not.toHaveBeenCalled();
    expect(actions.restore).not.toHaveBeenCalled();
  });
});
