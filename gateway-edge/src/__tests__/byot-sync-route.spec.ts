import { signingKey, verificationKey } from "../test-setup/signature-keys.js";
import request from "supertest";
import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const syncModelCredentialsForUserSpy = vi.fn(async () => {});
const refreshModelCredentialRuntimeSessionsSpy = vi.fn(async () => ({ refreshed: false, resetCount: 0 }));
const applyConfigPatchSpy = vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 }));
const releaseLeaseSpy = vi.fn(async () => {});
const acquireLeaseSpy = vi.fn(async () => ({
  ok: true as const,
  lease: { release: releaseLeaseSpy },
}));

vi.mock("@octogee/core/model-credential-sync-runtime", () => ({
  syncModelCredentialsForUser: (
    userData: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) => syncModelCredentialsForUserSpy(userData, deps),
  refreshModelCredentialRuntimeSessions: refreshModelCredentialRuntimeSessionsSpy,
}));
vi.mock("@octogee/core/apply-config-patch", () => ({
  applyConfigPatch: (...args: unknown[]) => applyConfigPatchSpy(...args),
}));
vi.mock("@octogee/core/system-config-mutation-lease", () => ({
  acquireSystemConfigMutationLease: (...args: unknown[]) => acquireLeaseSpy(...args),
}));

const { createApp } = await import("../index.js");
const {
  createLeasedModelConfigWriter,
  default: byotSyncRoutes,
} = await import("../routes/internal/byot-sync.js");

const userData = {
  byotActive: true,
  username: "smile-wring-011b",
  planInputs: { subscription: { tier: "personal", status: "active" } },
  provisioning: { openclaw: { status: "complete" } },
  systemConfig: { byot: { provider: "openai" } },
};

const PRIMARY_SYNC_PATH = "/api/g/walter/internal/model-credential-sync";
const LEGACY_SYNC_PATH = "/api/g/walter/internal/byot-sync";

type RouteLayer = {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
  };
};

function routeSignatures(router: unknown): string[] {
  const stack = (router as { stack: RouteLayer[] }).stack;
  return stack
    .filter((layer) => layer.route)
    .map((layer) => {
      const route = layer.route;
      if (!route) throw new Error("expected route layer");
      const methods = Object.entries(route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => method.toUpperCase())
        .sort()
        .join(",");
      return `${methods} ${JSON.stringify(route.path)}`;
    });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function byotSyncHeaders(body: unknown, secret = signingKey, timestamp = `${Date.now()}`): Record<string, string> {
  return {
    "X-Byot-Sync-Timestamp": timestamp,
    "X-Byot-Sync-Signature": crypto.sign(null, Buffer.from(`v1\nwalter\n${timestamp}\n${canonicalJson(body)}`), secret).toString("hex"),
  };
}

describe("POST /api/g/:gatewayId/internal/byot-sync", () => {
  beforeEach(() => {
    syncModelCredentialsForUserSpy.mockClear();
    refreshModelCredentialRuntimeSessionsSpy.mockClear();
    applyConfigPatchSpy.mockClear();
    releaseLeaseSpy.mockClear();
    acquireLeaseSpy.mockClear();
    delete process.env.INTERNAL_SERVICE_KEY;
    process.env.BYOT_SYNC_INTERNAL_PUBLIC_KEY = verificationKey;
    process.env.GATEWAY_ID = "walter";
    delete process.env.GATEWAY_PROFILE;
    process.env.K8S_NAMESPACE = "octogee-test";
    process.env.OPENCLAW_DIR = "/home/node/.openclaw";
  });

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.BYOT_SYNC_INTERNAL_PUBLIC_KEY;
    delete process.env.GATEWAY_ID;
    delete process.env.K8S_NAMESPACE;
    delete process.env.GATEWAY_PROFILE;
    delete process.env.OPENCLAW_DIR;
  });

  it("rejects unauthenticated calls before sync", async () => {
    const res = await request(createApp())
      .post(PRIMARY_SYNC_PATH)
      .send(userData);
    expect(res.status).toBe(401);
    expect(syncModelCredentialsForUserSpy).not.toHaveBeenCalled();
  });

  it("mounts both canonical and legacy sync route aliases", () => {
    expect(routeSignatures(byotSyncRoutes)).toEqual([
      'POST ["/model-credential-sync","/byot-sync"]',
    ]);
  });

  it("validates the sync payload", async () => {
    const body = { byotActive: true };
    const res = await request(createApp())
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(body))
      .send(body);
    expect(res.status).toBe(400);
    expect(syncModelCredentialsForUserSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["a previous API's payload with plan fields at the top level and no bag", (() => {
      const { planInputs, ...withoutBag } = userData;
      return { ...withoutBag, ...planInputs, tier: "personal", selectedTier: "personal" };
    })()],
    ["plan inputs that are not an object", { ...userData, planInputs: "personal" }],
    ["plan inputs that are an array", { ...userData, planInputs: [] }],
    ["null plan inputs", { ...userData, planInputs: null }],
  ])("refuses %s instead of syncing the user as having no plan", async (_label, body) => {
    const res = await request(createApp())
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(body))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "username, planInputs and provisioning.openclaw.status required" });
    expect(syncModelCredentialsForUserSpy).not.toHaveBeenCalled();
    expect(applyConfigPatchSpy).not.toHaveBeenCalled();
  });

  it("accepts an empty plan input bag from a sender that knows no plan", async () => {
    const body = { ...userData, planInputs: {} };
    const res = await request(createApp())
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(syncModelCredentialsForUserSpy).toHaveBeenCalledWith(body, expect.anything());
  });

  it("runs model config writes under the shared system-config lease", async () => {
    const res = await request(createApp())
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(userData))
      .send(userData);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(syncModelCredentialsForUserSpy).toHaveBeenCalledWith(
      userData,
      expect.objectContaining({
        applyConfigPatch: expect.any(Function),
        refreshDefaultAgentRuntimeSessions: refreshModelCredentialRuntimeSessionsSpy,
      }),
    );

    const deps = syncModelCredentialsForUserSpy.mock.calls[0]?.[1];
    await deps.applyConfigPatch({ buildPatch: () => ({}) }, { maxRetries: 2 });

    expect(acquireLeaseSpy).toHaveBeenCalledWith({ openclawDir: "/home/node/.openclaw" });
    expect(applyConfigPatchSpy).toHaveBeenCalledWith(
      { buildPatch: expect.any(Function) },
      { maxRetries: 2 },
    );
    expect(releaseLeaseSpy).toHaveBeenCalledTimes(1);
  });

  it("retries transient writer-lock collisions before applying the patch", async () => {
    acquireLeaseSpy
      .mockResolvedValueOnce({ ok: false, code: "writer-lock-busy" })
      .mockResolvedValueOnce({ ok: false, code: "writer-lock-busy" });
    const wait = vi.fn(async () => {});
    const writer = createLeasedModelConfigWriter({
      acquireLease: acquireLeaseSpy as never,
      applyPatch: applyConfigPatchSpy as never,
      openclawDir: () => "/home/node/.openclaw",
      wait,
    });

    await writer({ buildPatch: () => ({}) }, { maxRetries: 2 });

    expect(wait.mock.calls).toEqual([[250], [750]]);
    expect(acquireLeaseSpy).toHaveBeenCalledTimes(3);
    expect(applyConfigPatchSpy).toHaveBeenCalledTimes(1);
    expect(releaseLeaseSpy).toHaveBeenCalledTimes(1);
  });

  it("does not patch when bounded writer-lock retries are exhausted", async () => {
    acquireLeaseSpy.mockResolvedValue({ ok: false, code: "writer-lock-busy" });
    const wait = vi.fn(async () => {});
    const writer = createLeasedModelConfigWriter({
      acquireLease: acquireLeaseSpy as never,
      applyPatch: applyConfigPatchSpy as never,
      openclawDir: () => "/home/node/.openclaw",
      wait,
    });

    await expect(writer({ buildPatch: () => ({}) })).rejects.toThrow(
      "system config writer lock is busy",
    );

    expect(wait.mock.calls).toEqual([[250], [750]]);
    expect(acquireLeaseSpy).toHaveBeenCalledTimes(3);
    expect(applyConfigPatchSpy).not.toHaveBeenCalled();
    expect(releaseLeaseSpy).not.toHaveBeenCalled();
  });

  it("keeps the legacy BYOT sync route as an authenticated alias", async () => {
    const res = await request(createApp())
      .post(LEGACY_SYNC_PATH)
      .set(byotSyncHeaders(userData))
      .send(userData);

    expect(res.status).toBe(200);
    expect(syncModelCredentialsForUserSpy).toHaveBeenCalledWith(
      userData,
      expect.objectContaining({ applyConfigPatch: expect.any(Function) }),
    );
  });

  it("accepts canonical model credential sync payloads", async () => {
    const body = {
      username: userData.username,
      planInputs: userData.planInputs,
      provisioning: userData.provisioning,
      systemConfig: {
        modelCredential: {
          active: true,
          provider: "claude-cli",
          mode: "oauth",
        },
      },
    };

    const res = await request(createApp())
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(syncModelCredentialsForUserSpy).toHaveBeenCalledWith(
      body,
      expect.objectContaining({ applyConfigPatch: expect.any(Function) }),
    );
  });

  it("rejects projected service-account tokens without the BYOT sync signature", async () => {
    process.env.GATEWAY_PROFILE = "standard";

    const res = await request(createApp())
      .post(PRIMARY_SYNC_PATH)
      .set("X-K8s-SA-Token", "octogee-api-jwt")
      .send(userData);

    expect(res.status).toBe(401);
    expect(syncModelCredentialsForUserSpy).not.toHaveBeenCalled();
  });

  it("rejects stale BYOT sync signatures", async () => {
    const staleTimestamp = `${Date.now() - 10 * 60 * 1000}`;
    const res = await request(createApp())
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(userData, signingKey, staleTimestamp))
      .send(userData);

    expect(res.status).toBe(401);
    expect(syncModelCredentialsForUserSpy).not.toHaveBeenCalled();
  });

  it("surfaces sync failures to the internal caller", async () => {
    syncModelCredentialsForUserSpy.mockRejectedValueOnce(new Error("config.patch failed"));
    const res = await request(createApp())
      .post(PRIMARY_SYNC_PATH)
      .set(byotSyncHeaders(userData))
      .send(userData);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).toContain("config.patch failed");
  });
});
