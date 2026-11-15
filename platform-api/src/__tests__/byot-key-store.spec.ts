import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformStateStore } from "@octogee/core/platform-state";

const h = vi.hoisted(() => ({
  store: null as unknown as PlatformStateStore,
  writeSecret: vi.fn(),
  archiveSecret: vi.fn(),
  triggerSync: vi.fn(),
}));

vi.mock("@octogee/core/identity/platform-state-store", () => ({
  get platformStateStore() { return h.store; },
}));
vi.mock("@octogee/core/secret-store", () => ({
  writeSecret: h.writeSecret,
  archiveSecret: h.archiveSecret,
}));
vi.mock("../model-credentials/provider-key-format.js", async (original) => ({
  ...(await original<typeof import("../model-credentials/provider-key-format.js")>()),
  validateProviderKey: (_provider: string, key: unknown) => ({ valid: true, normalized: String(key) }),
}));
vi.mock("../model-credentials/provider-probe.js", () => ({ probeProviderKey: async () => ({ ok: true }) }));
vi.mock("../lib/byot-sync-trigger.js", () => ({ triggerGatewayModelCredentialSync: h.triggerSync }));

const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
const { saveModelCredentialKey, deleteModelCredentialKey } = await import("../routes/billing/byot.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    Object.assign(req, { uid: "uid-ada", workspaceSlug: "ada", user: { provisioning: { openclaw: { gatewayId: "gw-ada" } } } });
    next();
  });
  a.put("/key", saveModelCredentialKey);
  a.delete("/key", deleteModelCredentialKey);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.writeSecret.mockResolvedValue({ versionName: "projects/p/secrets/byok-ada-openrouter/versions/1" });
  h.archiveSecret.mockResolvedValue({ disabledCount: 1 });
  h.store = createDocumentFixtureStore({});
});

describe("model credential API keys on the platform store", () => {
  it("stores an active API key credential and syncs it to the gateway", async () => {
    await request(app()).put("/key").send({ provider: "openrouter", apiKey: "sk-or-v1-abcdef1234", model: "openrouter/auto" }).expect(200);

    expect(await h.store.users.modelCredentials.get("uid-ada")).toMatchObject({
      active: true,
      provider: "openrouter",
      mode: "api_key",
      status: "active",
      secretName: "byok-ada-openrouter",
      fingerprint: "sk-or-…1234",
      keyHash: expect.any(String),
      baseUrl: null,
      model: "openrouter/auto",
    });
    expect(h.triggerSync.mock.calls[0]?.[0].userData).toMatchObject({
      byotActive: true,
      systemConfig: { byot: { provider: "openrouter", model: "openrouter/auto" } },
    });
  });

  it("archives the previous provider's secret when the key switches provider", async () => {
    await request(app()).put("/key").send({ provider: "anthropic", apiKey: "sk-ant-abcdef1234" }).expect(200);

    await request(app()).put("/key").send({ provider: "openrouter", apiKey: "sk-or-v1-abcdef1234" }).expect(200);

    expect(h.archiveSecret).toHaveBeenCalledExactlyOnceWith("byok-ada-anthropic");
    expect(await h.store.users.modelCredentials.get("uid-ada")).toMatchObject({ provider: "openrouter" });
  });

  it("removes the stored credential and archives its secret", async () => {
    await request(app()).put("/key").send({ provider: "openrouter", apiKey: "sk-or-v1-abcdef1234" }).expect(200);

    await request(app()).delete("/key").expect(200);

    expect(h.archiveSecret).toHaveBeenCalledWith("byok-ada-openrouter");
    expect(await h.store.users.modelCredentials.get("uid-ada")).toBeNull();
    expect(h.triggerSync.mock.calls.at(-1)?.[0].userData).toMatchObject({ byotActive: false });
  });
});
