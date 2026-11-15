import { describe, expect, it } from "vitest";
import { databaseConnection, databaseSettingsFromEnvironment } from "./database-settings.js";

const ENV = {
  PROVISIONING_DB_HOST: "10.1.2.3",
  PROVISIONING_DB_NAME: "provisioning",
  PROVISIONING_DB_USER: "provisioning",
  PROVISIONING_DB_PASSWORD: "secret",
  PROVISIONING_DB_SSLMODE: "verify-full",
  PROVISIONING_DB_CA_CERT: "-----BEGIN CERTIFICATE-----",
  PROVISIONING_DB_TLS_SERVER_IDENTITY: "db.internal",
};

describe("database settings", () => {
  it("verifies the server against the CA and the configured identity when the host is an address", () => {
    const connection = databaseConnection(databaseSettingsFromEnvironment(ENV));
    expect(connection).toMatchObject({ host: "10.1.2.3", port: 5432, database: "provisioning", user: "provisioning" });
    expect(connection.ssl).toEqual({ rejectUnauthorized: true, host: "db.internal", servername: "db.internal", ca: "-----BEGIN CERTIFICATE-----" });
  });

  it("refuses a CA or server identity without verify-full, and an unknown sslmode", () => {
    expect(() => databaseSettingsFromEnvironment({ ...ENV, PROVISIONING_DB_SSLMODE: "require" })).toThrow("PROVISIONING_DB_CA_CERT");
    expect(() => databaseSettingsFromEnvironment({ ...ENV, PROVISIONING_DB_CA_CERT: "", PROVISIONING_DB_SSLMODE: "require" })).toThrow("PROVISIONING_DB_TLS_SERVER_IDENTITY");
    expect(() => databaseSettingsFromEnvironment({ ...ENV, PROVISIONING_DB_SSLMODE: "prefer" })).toThrow("PROVISIONING_DB_SSLMODE");
    expect(() => databaseSettingsFromEnvironment({ ...ENV, PROVISIONING_DB_PASSWORD: "" })).toThrow("PROVISIONING_DB_PASSWORD is required");
  });
});
