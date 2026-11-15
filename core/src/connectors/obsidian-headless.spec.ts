import { describe, expect, it, vi } from "vitest";

import {
  listObsidianRemoteVaults,
  obsidianHeadlessEnvironment,
  verifyObsidianConnection,
  type ObsidianCommandRunner,
} from "./obsidian-headless.js";

const DERIVED_KEY = `${"A".repeat(43)}=`;

describe("Obsidian Headless connection preparation", () => {
  it("does not expose service credentials or Node injection options to the Headless child", () => {
    expect(obsidianHeadlessEnvironment(
      { OBSIDIAN_AUTH_TOKEN: "official-token", XDG_CONFIG_HOME: "/tmp/isolated" },
      {
        GOOGLE_APPLICATION_CREDENTIALS: "/var/run/secrets/google.json",
        K_SERVICE: "octogee-api",
        NODE_OPTIONS: "--require=/tmp/injected.cjs",
        PATH: "/usr/bin",
      },
    )).toEqual({
      HOME: "/nonexistent",
      OBSIDIAN_AUTH_TOKEN: "official-token",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/tmp/isolated",
    });
    expect(() => obsidianHeadlessEnvironment({ NODE_OPTIONS: "--inspect" }, {}))
      .toThrow("Unsupported Obsidian child environment variable");
  });

  it("parses owned and shared remote vaults without exposing the auth token", async () => {
    const runner: ObsidianCommandRunner = vi.fn(async (_args, options) => {
      expect(options.env.OBSIDIAN_AUTH_TOKEN).toBe("official-token");
      return {
        stdout: [
          "Fetching vaults...",
          "",
          "Vaults:",
          '  vault_1  "Robert Notes"  (us)',
          "",
          "Shared vaults:",
          '  vault_2  "Friends"  (eu)',
        ].join("\n"),
        stderr: "",
      };
    });

    await expect(listObsidianRemoteVaults(" official-token ", runner)).resolves.toEqual([
      { id: "vault_1", name: "Robert Notes", region: "us", shared: false },
      { id: "vault_2", name: "Friends", region: "eu", shared: true },
    ]);
  });

  it("verifies that the stored vault is still visible to the account", async () => {
    const connection = JSON.stringify({
      schemaVersion: 1,
      vaultId: "vault_1",
      vaultName: "Robert Notes",
      headlessConfig: {
        vaultId: "vault_1",
        vaultName: "Robert Notes",
        host: "sync-1.obsidian.md",
        encryptionVersion: 3,
        encryptionKey: DERIVED_KEY,
        encryptionSalt: "salt",
        conflictStrategy: "merge",
      },
    });
    const runner: ObsidianCommandRunner = vi.fn(async () => ({
      stdout: 'Vaults:\n  vault_1  "Robert Notes"  (us)',
      stderr: "",
    }));
    await expect(verifyObsidianConnection({ authToken: "token", connection }, runner))
      .resolves.toMatchObject({ accountLabel: "Robert Notes" });
  });

  it("rejects untrusted Sync hosts and strips path-related configuration", async () => {
    const connection = JSON.stringify({
      schemaVersion: 1,
      vaultId: "vault_1",
      vaultName: "Robert Notes",
      headlessConfig: {
        vaultId: "vault_1",
        vaultName: "Robert Notes",
        host: "metadata.google.internal",
        encryptionVersion: 3,
        encryptionKey: DERIVED_KEY,
        encryptionSalt: "salt",
        conflictStrategy: "merge",
        vaultPath: "/etc",
        configDir: "../../../etc",
      },
    });
    const runner: ObsidianCommandRunner = vi.fn();
    await expect(verifyObsidianConnection({ authToken: "token", connection }, runner))
      .rejects.toMatchObject({ code: "runtime-failed" });
    expect(runner).not.toHaveBeenCalled();
  });
});
