import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const BASE = {
  PROVISIONING_DB_HOST: "10.1.2.3",
  PROVISIONING_DB_NAME: "provisioning",
  PROVISIONING_DB_USER: "provisioning",
  PROVISIONING_DB_PASSWORD: "database-password",
  PROVISIONING_DB_SSLMODE: "verify-full",
  PROVISIONING_CALLER_NAMESPACE: "platform",
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

  it("uses the fakes only when asked for them by name, and rejects any other adapter value", () => {
    expect(loadConfig({ ...BASE, PROVISIONING_HOST_ADAPTERS: "fake" }).hosts).toEqual({ kind: "fake" });
    expect(() => loadConfig({ ...BASE, PROVISIONING_HOST_ADAPTERS: "mattermost" })).toThrow("PROVISIONING_HOST_ADAPTERS");
  });

  it("rejects a credential key that is not 32 bytes and a schema that is not an identifier", () => {
    expect(() => loadConfig({ ...BASE, ...REAL, PROVISIONING_CREDENTIAL_KEY: "c2hvcnQ=" })).toThrow("PROVISIONING_CREDENTIAL_KEY");
    expect(() => loadConfig({ ...BASE, ...REAL, PROVISIONING_DATABASE_SCHEMA: "x; DROP" })).toThrow("PROVISIONING_DATABASE_SCHEMA");
  });
});
