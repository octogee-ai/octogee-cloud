import { signingKey, verificationKey } from "../test-setup/signature-keys.js";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModelCredentialSyncAuthHeaders } from "@octogee/core/model-credentials/byot-sync-internal-auth";

const h = vi.hoisted(() => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@octogee/core/http/logging", () => ({ logger: h.logger }));

const { requireByotSyncInternalAuth } = await import("../middleware/byot-sync-auth.js");

const ENV_KEYS = ["INTERNAL_SERVICE_KEY", "BYOT_SYNC_INTERNAL_PUBLIC_KEY", "GATEWAY_ID"] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function app(): express.Express {
  const instance = express();
  instance.use(express.json());
  instance.post("/sync", requireByotSyncInternalAuth, (_req, res) => res.json({ ok: true }));
  return instance;
}

describe("requireByotSyncInternalAuth", () => {
  beforeEach(() => {
    restoreEnv();
    process.env.GATEWAY_ID = "walter";
    h.logger.error.mockClear();
    h.logger.warn.mockClear();
    h.logger.info.mockClear();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("refuses retired shared-secret auth even when the environment contains its key", async () => {
    process.env.INTERNAL_SERVICE_KEY = "platform-secret";
    delete process.env.BYOT_SYNC_INTERNAL_PUBLIC_KEY;

    const res = await request(app())
      .post("/sync")
      .set("X-Internal-Service-Key", "platform-secret")
      .send({ username: "mira" })
      .expect(503, { error: "Internal auth unavailable" });

    expect(res.body).toEqual({ error: "Internal auth unavailable" });
  });

  it("returns 503 when no model credential sync signing secret is configured", async () => {
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.BYOT_SYNC_INTERNAL_PUBLIC_KEY;

    await request(app()).post("/sync").send({ username: "mira" }).expect(503, {
      error: "Internal auth unavailable",
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      "model credential sync public key or gateway identity is not configured",
    );
  });

  it("accepts a valid model credential sync signature", async () => {
    process.env.BYOT_SYNC_INTERNAL_PUBLIC_KEY = verificationKey;
    const body = {
      username: "mira",
      provisioning: { openclaw: { status: "complete" } },
    };

    const res = await request(app())
      .post("/sync")
      .set(createModelCredentialSyncAuthHeaders({ body, secret: signingKey, gatewayId: "walter", nowMs: Date.now() }))
      .send(body)
      .expect(200, { ok: true });

    expect(res.body).toEqual({ ok: true });
  });

  it("rejects invalid signatures and logs the caller", async () => {
    process.env.BYOT_SYNC_INTERNAL_PUBLIC_KEY = verificationKey;

    await request(app())
      .post("/sync")
      .set("X-Byot-Sync-Timestamp", `${Date.now()}`)
      .set("X-Byot-Sync-Signature", "bad")
      .send({ username: "mira" })
      .expect(401, { error: "Invalid internal auth" });

    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("model credential sync internal auth rejected from"),
    );
  });

  it("logs the socket peer, never spoofable XFF, even on a trust-proxy app", async () => {
    process.env.BYOT_SYNC_INTERNAL_PUBLIC_KEY = verificationKey;
    const instance = app();
    instance.set("trust proxy", 2);

    await request(instance)
      .post("/sync")
      .set("X-Forwarded-For", "6.6.6.6, 7.7.7.7")
      .set("X-Byot-Sync-Timestamp", `${Date.now()}`)
      .set("X-Byot-Sync-Signature", "bad")
      .send({ username: "mira" })
      .expect(401, { error: "Invalid internal auth" });

    const line = h.logger.warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("rejected from"));
    expect(line).toContain("127.0.0.1");
    expect(line).not.toContain("6.6.6.6");
  });
});
