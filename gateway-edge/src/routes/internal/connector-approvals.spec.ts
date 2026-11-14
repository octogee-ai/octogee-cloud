import { generateKeyPairSync } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelCredentialSyncAuthHeaders } from "../../lib/byot-sync-internal-auth.js";

const h = vi.hoisted(() => ({ run: vi.fn(), identity: vi.fn() }));
vi.mock("../../lib/native-connector-approval.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../lib/native-connector-approval.js")>(), runNativeConnectorApproval: h.run,
}));
vi.mock("../../lib/workspace-native-access.js", () => ({ resolveWorkspaceNativeIdentity: h.identity }));
import { NativeConnectorApprovalAccessError } from "../../lib/native-connector-approval.js";
import { createInternalConnectorApprovalRouter } from "./connector-approvals.js";

const keys = generateKeyPairSync("ed25519");
const secret = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const gatewayId = "b-alice";
const command = { operation: "resolve", gatewayId, ownerUid: "alice", agentId: "octogee-alice-coach", nativeId: "plugin:approval", reviewerUid: "delegate", decision: "deny" };
function app() {
  const server = express(); server.use(express.json());
  server.use("/api/g/:gatewayId/internal/connector-approvals", createInternalConnectorApprovalRouter());
  return server;
}
function send(body = { purpose: "connector-approval", command, authorization: "Bearer firebase-token" }, sign = body) {
  return request(app()).post(`/api/g/${gatewayId}/internal/connector-approvals`)
    .set(createModelCredentialSyncAuthHeaders({ body: sign, gatewayId, secret })).send(body);
}
beforeEach(() => {
  vi.stubEnv("BYOT_SYNC_INTERNAL_PUBLIC_KEY", keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  vi.stubEnv("GATEWAY_ID", gatewayId); vi.stubEnv("GATEWAY_CLASS", "isolated");
  h.run.mockReset().mockResolvedValue({ approval: { status: "allowed" } });
  h.identity.mockReset().mockResolvedValue({ uid: "delegate", gatewayId });
});
afterEach(() => vi.unstubAllEnvs());
describe("API-signed connector approval bridge", () => {
  it("returns a non-cacheable forbidden result for native permission denial", async () => {
    h.run.mockRejectedValue(new NativeConnectorApprovalAccessError("Native approval permission is required"));
    const response = await send();
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "approval_forbidden" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("requires an API signature over the exact operation and passes the authenticated delegate to native roles", async () => {
    expect((await send()).status).toBe(200);
    expect(h.identity).toHaveBeenCalledWith({ gatewayId, authorization: "Bearer firebase-token" });
    expect(h.run).toHaveBeenCalledWith(command, expect.objectContaining({ isolated: true }));
  });
  it("rejects a tampered reviewer before opening a native connection", async () => {
    const body = { purpose: "connector-approval", command, authorization: "Bearer firebase-token" };
    expect((await send({ ...body, command: { ...command, reviewerUid: "attacker" } }, body)).status).toBe(401);
    expect(h.run).not.toHaveBeenCalled();
  });
  it("rejects a signed identity that does not match the verified Firebase principal", async () => {
    h.identity.mockResolvedValue({ uid: "someone-else", gatewayId });
    expect((await send()).status).toBe(403);
    expect(h.run).not.toHaveBeenCalled();
  });
  it("refuses to resolve a connector approval to allow, because approval happens only in Octogee", async () => {
    const body = { purpose: "connector-approval", command: { ...command, decision: "allow-once" }, authorization: "Bearer firebase-token" };
    expect((await send(body)).status).toBe(400);
    expect(h.run).not.toHaveBeenCalled();
  });
  it("does not accept an operation addressed to another gateway", async () => {
    expect((await send({ purpose: "connector-approval", command: { ...command, gatewayId: "b-bob" }, authorization: "Bearer firebase-token" })).status).toBe(409);
    expect(h.run).not.toHaveBeenCalled();
  });
  it("does not expose arbitrary gateway RPCs through the signed bridge", async () => {
    expect((await send({ purpose: "connector-approval", command: { ...command, operation: "config.patch" }, authorization: "Bearer firebase-token" })).status).toBe(400);
    expect(h.run).not.toHaveBeenCalled();
  });
});
