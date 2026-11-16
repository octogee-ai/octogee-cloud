import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const BASE = {
  PROVISIONING_DB_HOST: "10.1.2.3",
  PROVISIONING_DB_NAME: "provisioning",
  PROVISIONING_DB_USER: "provisioning",
  PROVISIONING_DB_PASSWORD: "database-password",
  PROVISIONING_DB_SSLMODE: "verify-full",
  PROVISIONING_CALLER_NAMESPACE: "platform",
  PROVISIONING_FLEET_CONTROLLER_SERVICE_ACCOUNT: "fleet-controller-account",
  PROVISIONING_PLATFORM_API_SERVICE_ACCOUNT: "platform-api-account",
  PROVISIONING_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64"),
  KUBERNETES_SERVICE_HOST: "10.0.0.1",
};

const REAL = {
  PROVISIONING_HOST_ADAPTERS: "real",
  PROVISIONING_CHAT_HOST_URL: "http://chat.internal:8065/",
  PROVISIONING_CHAT_HOST_ADMIN_TOKEN: "chat-admin",
  PROVISIONING_CHAT_CONTROL_COMMAND_URL: "http://api.platform.svc/control",
  PROVISIONING_GIT_HOST_URL: "http://git.internal:3000",
  PROVISIONING_GIT_HOST_ADMIN_TOKEN: "git-admin",
};

describe("loadConfig", () => {
  it("defaults the per-caller limits and reads them when set", () => {
    expect(loadConfig({ ...BASE, ...REAL }).limits).toEqual({ requestsPerMinute: 3_000, concurrentWaits: 100 });
    const set = loadConfig({ ...BASE, ...REAL, PROVISIONING_CALLER_REQUESTS_PER_MINUTE: "50", PROVISIONING_CALLER_CONCURRENT_WAITS: "4" });
    expect(set.limits).toEqual({ requestsPerMinute: 50, concurrentWaits: 4 });
  });

  it.each([
    ["PROVISIONING_CALLER_REQUESTS_PER_MINUTE", "0"],
    ["PROVISIONING_CALLER_REQUESTS_PER_MINUTE", "1.5"],
    ["PROVISIONING_CALLER_CONCURRENT_WAITS", "-1"],
    ["PROVISIONING_CALLER_CONCURRENT_WAITS", "many"],
  ])("refuses to start with %s=%s", (name, value) => {
    expect(() => loadConfig({ ...BASE, ...REAL, [name]: value })).toThrow(name);
  });

  it("reads the real host settings and the in-cluster TokenReview defaults", () => {
    const config = loadConfig({ ...BASE, ...REAL });
    expect(config.hosts).toEqual({
      kind: "real",
      settings: {
        chatHostUrl: "http://chat.internal:8065",
        chatHostAdminToken: "chat-admin",
        chatHostAdminUserId: null,
        chatControlCommandUrl: "http://api.platform.svc/control",
        gitHostUrl: "http://git.internal:3000",
        gitHostAdminToken: "git-admin",
      },
    });
    expect(config.tokenReviewUrl).toBe("https://10.0.0.1:443/apis/authentication.k8s.io/v1/tokenreviews");
    expect(config.tokenReviewCaFile).toBe("/var/run/secrets/kubernetes-api/ca.crt");
    expect(config.databaseSchema).toBe("provisioning_service");
  });

  it("names each missing required setting instead of falling back", () => {
    for (const name of Object.keys(REAL).filter((key) => key !== "PROVISIONING_HOST_ADAPTERS")) {
      expect(() => loadConfig({ ...BASE, ...REAL, [name]: "" })).toThrow(name);
    }
    for (const name of Object.keys(BASE)) {
      expect(() => loadConfig({ ...BASE, ...REAL, [name]: undefined })).toThrow(name);
    }
    expect(() => loadConfig({ ...BASE })).toThrow("PROVISIONING_HOST_ADAPTERS");
  });

  it("refuses the fake host adapters unless the test-only consent is also set, and rejects any other adapter value", () => {
    expect(() => loadConfig({ ...BASE, PROVISIONING_HOST_ADAPTERS: "fake" })).toThrow("PROVISIONING_ALLOW_FAKE_HOST_ADAPTERS=for-tests-only");
    expect(() => loadConfig({ ...BASE, PROVISIONING_HOST_ADAPTERS: "fake", PROVISIONING_ALLOW_FAKE_HOST_ADAPTERS: "yes" })).toThrow("PROVISIONING_ALLOW_FAKE_HOST_ADAPTERS");
    const consent = { ...BASE, PROVISIONING_HOST_ADAPTERS: "fake", PROVISIONING_ALLOW_FAKE_HOST_ADAPTERS: "for-tests-only" };
    expect(loadConfig(consent).hosts).toEqual({ kind: "fake", delayMs: 0, gitKeys: {} });
    expect(loadConfig({ ...consent, PROVISIONING_FAKE_HOST_DELAY_MS: "200" }).hosts).toEqual({ kind: "fake", delayMs: 200, gitKeys: {} });
    expect(() => loadConfig({ ...BASE, PROVISIONING_HOST_ADAPTERS: "mattermost" })).toThrow("PROVISIONING_HOST_ADAPTERS");
  });

  it("seeds the fake git host's keys from PROVISIONING_FAKE_GIT_KEYS and refuses a malformed seed", () => {
    const consent = { ...BASE, PROVISIONING_HOST_ADAPTERS: "fake", PROVISIONING_ALLOW_FAKE_HOST_ADAPTERS: "for-tests-only" };
    const seed = { lin: [{ publicKey: "ssh-ed25519 AAAA gateway", holder: "gw-1/pod-1" }] };
    expect(loadConfig({ ...consent, PROVISIONING_FAKE_GIT_KEYS: JSON.stringify(seed) }).hosts).toEqual({ kind: "fake", delayMs: 0, gitKeys: seed });
    expect(() => loadConfig({ ...consent, PROVISIONING_FAKE_GIT_KEYS: "[1]" })).toThrow("PROVISIONING_FAKE_GIT_KEYS");
    expect(() => loadConfig({ ...consent, PROVISIONING_FAKE_GIT_KEYS: JSON.stringify({ lin: [{ holder: "x" }] }) })).toThrow("PROVISIONING_FAKE_GIT_KEYS");
  });

  it("gives the fleet controller's and the platform API's roles to the service accounts the environment names", () => {
    expect(loadConfig({ ...BASE, ...REAL }).callerRoles).toEqual({
      "fleet-controller-account": ["writer", "key-retirer", "credential-reader"],
      "platform-api-account": ["key-writer", "reader", "credential-reader"],
    });
  });

  it("refuses to start when both callers are given the same service account", () => {
    expect(() => loadConfig({ ...BASE, ...REAL, PROVISIONING_PLATFORM_API_SERVICE_ACCOUNT: "fleet-controller-account" }))
      .toThrow("PROVISIONING_FLEET_CONTROLLER_SERVICE_ACCOUNT and PROVISIONING_PLATFORM_API_SERVICE_ACCOUNT must name different service accounts");
  });

  it("keeps changes for a day unless PROVISIONING_CHANGE_RETENTION_SECONDS says otherwise", () => {
    expect(loadConfig({ ...BASE, ...REAL }).changeRetentionSeconds).toBe(86_400);
    expect(loadConfig({ ...BASE, ...REAL, PROVISIONING_CHANGE_RETENTION_SECONDS: "2" }).changeRetentionSeconds).toBe(2);
    expect(() => loadConfig({ ...BASE, ...REAL, PROVISIONING_CHANGE_RETENTION_SECONDS: "0" })).toThrow("PROVISIONING_CHANGE_RETENTION_SECONDS");
  });

  it("rejects a credential key that is not 32 bytes and a schema that is not an identifier", () => {
    expect(() => loadConfig({ ...BASE, ...REAL, PROVISIONING_CREDENTIAL_KEY: "c2hvcnQ=" })).toThrow("PROVISIONING_CREDENTIAL_KEY");
    expect(() => loadConfig({ ...BASE, ...REAL, PROVISIONING_DATABASE_SCHEMA: "x; DROP" })).toThrow("PROVISIONING_DATABASE_SCHEMA");
  });
});
