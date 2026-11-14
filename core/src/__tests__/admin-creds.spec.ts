import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  setSpy: vi.fn(async () => {}),
  getMmAdminToken: vi.fn(),
  mmApiCall: vi.fn(),
  addSecretVersion: vi.fn(async () => [{ name: "v1" }]),
}));

// Secret Manager must NOT be touched anymore — mocked purely as a regression guard.
vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: class {
    addSecretVersion = h.addSecretVersion;
    listSecretVersions = vi.fn(async () => [[]]);
    destroySecretVersion = vi.fn(async () => [{}]);
    createSecret = vi.fn(async () => [{}]);
  },
}));
vi.mock("../provisioner-platform-state.js", () => ({ platformStateStore: { config: { mattermostAdmin: { put: h.setSpy } } } }));
vi.mock("../mattermost/client.js", () => ({
  getMmAdminToken: h.getMmAdminToken,
  mmApiCall: h.mmApiCall,
}));
vi.mock("../config.js", () => ({ log: vi.fn() }));

import { ensureAdminCredentials } from "../mattermost/admin-creds.js";

describe("ensureAdminCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MM_URL = "http://mm";
    process.env.MM_ADMIN_USER_ID = "admin-id";
    delete process.env.API_PUBLIC_URL;
    h.getMmAdminToken.mockResolvedValue("tok");
  });

  it("records the admin user id + proxy url in the platform store", async () => {
    process.env.API_PUBLIC_URL = "https://api.test";
    await ensureAdminCredentials();
    expect(h.setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "admin-id", proxyUrl: "https://api.test" }),
    );
  });

  it("does NOT write the admin token to Secret Manager (deprecated cruft removed)", async () => {
    await ensureAdminCredentials();
    expect(h.addSecretVersion).not.toHaveBeenCalled();
  });

  it("skips when MM_URL is unset", async () => {
    delete process.env.MM_URL;
    await ensureAdminCredentials();
    expect(h.setSpy).not.toHaveBeenCalled();
  });

  it("skips when no admin token is available", async () => {
    h.getMmAdminToken.mockResolvedValue("");
    await ensureAdminCredentials();
    expect(h.setSpy).not.toHaveBeenCalled();
  });
});
