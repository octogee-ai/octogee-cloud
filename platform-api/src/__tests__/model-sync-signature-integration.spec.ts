import { createHmac, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signingKey, verificationKey } from "../test-setup/signature-keys.js";

const syncRuntime = vi.fn(async (_body: unknown) => undefined);

const { postGatewayModelCredentialSync } = await import("../lib/byot-sync-trigger.js");
const { requireByotSyncInternalAuth } = await import("@octogee/core/model-credentials/byot-sync-auth");
const servers: Server[] = [];
const otherKey = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
}).publicKey;
const legacySecret = "local-test-legacy-model-sync-secret";
const userData = {
  username: "alice",
  planInputs: { subscription: { tier: "personal", status: "active", currentPeriodEnd: { _seconds: 1_800_000_000 } } },
  provisioning: { openclaw: { status: "complete" } },
  byotActive: true,
  systemConfig: { byot: { provider: "openai", model: "openai/gpt-5", baseUrl: undefined } },
};

function canonicalLegacyBody(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalLegacyBody).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalLegacyBody(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

beforeEach(() => {
  syncRuntime.mockClear();
  vi.stubEnv("GATEWAY_ID", "walter");
  vi.stubEnv("BYOT_SYNC_INTERNAL_PUBLIC_KEY", verificationKey);
  vi.stubEnv("INTERNAL_SERVICE_KEY", "");
  vi.stubEnv("OCTOGEE_API_SA_TOKEN_PATH", "/dev/null");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function syncReceiver() {
  const received: Array<{ url: string; body: unknown; signature: string | undefined }> = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    received.push({ url: req.url, body: req.body, signature: req.get("x-byot-sync-signature") });
    next();
  });
  app.post("/api/g/:gatewayId/internal/model-credential-sync", requireByotSyncInternalAuth, async (req, res) => {
    await syncRuntime(req.body);
    res.json({ ok: true });
  });
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  return {
    received,
    push: (fetchImpl?: typeof fetch) => postGatewayModelCredentialSync({
      gatewayId: "walter", userData,
      env: {
        GATEWAY_EDGE_INTERNAL_URL_TEMPLATE: `http://127.0.0.1:${address.port}`,
        BYOT_SYNC_INTERNAL_SIGNING_SECRET: signingKey,
      },
      fetchImpl,
    }),
  };
}

describe("model sync signatures from the platform trigger through the gateway verifier", () => {
  it("delivers the enriched, JSON-serialized selection through real signing, transport and verification", async () => {
    const receiver = await syncReceiver();
    await expect(receiver.push()).resolves.toBeUndefined();
    expect(receiver.received).toHaveLength(1);
    const wire = receiver.received[0];
    expect(wire.url).toBe("/api/g/walter/internal/model-credential-sync");
    expect(wire.signature).toMatch(/^[a-f0-9]{128}$/);
    expect(wire.body).toMatchObject({
      username: "alice", byotActive: true,
      planInputs: userData.planInputs,
      provisioning: userData.provisioning,
      systemConfig: { byot: { provider: "openai", model: "openai/gpt-5" } },
      freeTierModelRef: expect.any(String),
      builderAgentDefault: { primary: expect.any(String), fallbacks: expect.any(Array) },
    });
    expect(wire.body).not.toHaveProperty("systemConfig.byot.baseUrl");
    expect(syncRuntime).toHaveBeenCalledExactlyOnceWith(wire.body);
  });

  it.each([
    { name: "another public key", field: "BYOT_SYNC_INTERNAL_PUBLIC_KEY", value: otherKey, status: 401 },
    { name: "another gateway", field: "GATEWAY_ID", value: "other-user", status: 401 },
    { name: "an unconfigured public key", field: "BYOT_SYNC_INTERNAL_PUBLIC_KEY", value: "", status: 503 },
    { name: "a legacy secret in the public-key slot", field: "BYOT_SYNC_INTERNAL_PUBLIC_KEY", value: legacySecret, status: 503 },
  ])("reports $status for $name without writing runtime state", async ({ field, value, status }) => {
    vi.stubEnv(field, value);
    const receiver = await syncReceiver();
    await expect(receiver.push()).rejects.toThrow(`gateway model credential sync ${status}`);
    expect(receiver.received).toHaveLength(1);
    expect(syncRuntime).not.toHaveBeenCalled();
  });

  it("rejects a selection changed after the real trigger signs it", async () => {
    const receiver = await syncReceiver();
    const alteredFetch: typeof fetch = (url, init) => fetch(url, {
      ...init, body: JSON.stringify({ ...JSON.parse(String(init?.body)), username: "other-user" }),
    });
    await expect(receiver.push(alteredFetch)).rejects.toThrow("gateway model credential sync 401");
    expect(syncRuntime).not.toHaveBeenCalled();
  });

  it("rejects a legacy HMAC signature instead of falling back to shared-secret verification", async () => {
    const receiver = await syncReceiver();
    const legacyFetch: typeof fetch = (url, init) => {
      const headers = new Headers(init?.headers);
      const payload = `${headers.get("x-byot-sync-timestamp")}.${canonicalLegacyBody(JSON.parse(String(init?.body)))}`;
      headers.set("x-byot-sync-signature", createHmac("sha256", legacySecret).update(payload).digest("hex"));
      return fetch(url, { ...init, headers });
    };
    await expect(receiver.push(legacyFetch)).rejects.toThrow("gateway model credential sync 401");
    expect(syncRuntime).not.toHaveBeenCalled();
  });
});
