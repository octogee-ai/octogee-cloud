import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  exportActivationManifestWithSecret,
  materializeActivationManifestSecret,
} from "../lib/migration-activation-secrets.js";
import { updateMattermostAccountSecrets } from "../lib/mattermost-account-secrets.js";
import { saveAppliedFingerprints } from "../lib/applied-fingerprint-store.js";

const dirs: string[] = [];

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "octogee-activation-secret-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("migration activation Mattermost secrets", () => {
  it.each([undefined, "!import-reconcile-pending", "invalid!import-reconcile-pending"])(
    "rejects export without a genuine applied fingerprint (%s)", async (fingerprint) => {
    const openclawDir = await tmp();
    if (fingerprint !== undefined) {
      saveAppliedFingerprints(path.join(openclawDir, "applied-fingerprints.json"), new Map([["alice", fingerprint]]));
    }

    await expect(exportActivationManifestWithSecret(
      path.join(openclawDir, "system_config", "openclaw.json"),
      openclawDir,
      "alice",
    )).rejects.toThrow("source has no applied fingerprint; converge it before migration");
  });

  it.each(["fp-alice-v1", "0123456789abcdef!import-reconcile-pending"])(
    "exports the applied receipt and token outside tracked config (%s)", async (fingerprint) => {
    const openclawDir = await tmp();
    const configPath = path.join(openclawDir, "system_config", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      agents: {
        list: [
          { id: "octogee-alice-coach" },
          { id: "octogee-alice-proj-orbit-coach" },
          { id: "octogee-bob-coach" },
        ],
      },
      channels: { mattermost: { accounts: {
        "alice-coach": { botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-coach" } },
        "alice-proj-orbit": { botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-proj-orbit" } },
        "bob-coach": { botToken: { source: "file", provider: "octogee-mattermost", id: "/bob-coach" } },
      } } },
      bindings: [
        {
          agentId: "octogee-alice-coach",
          match: { channel: "mattermost", accountId: "alice-coach" },
        },
        {
          agentId: "octogee-alice-proj-orbit-coach",
          match: { channel: "mattermost", accountId: "alice-proj-orbit" },
        },
        {
          agentId: "octogee-bob-coach",
          match: { channel: "mattermost", accountId: "bob-coach" },
        },
      ],
    }));
    await updateMattermostAccountSecrets(openclawDir, {
      set: { "alice-coach": "default-agent-pat", "alice-proj-orbit": "orbit-pat" },
    });
    saveAppliedFingerprints(
      path.join(openclawDir, "applied-fingerprints.json"),
      new Map([["alice", fingerprint]]),
    );

    const manifest = await exportActivationManifestWithSecret(configPath, openclawDir, "alice");

    expect(manifest.mattermostAccount.botToken).toBe("default-agent-pat");
    expect(manifest.appliedFingerprint).toBe(fingerprint);
    expect(manifest.projectAgents).toMatchObject([
      {
        agentId: "octogee-alice-proj-orbit-coach",
        accountId: "alice-proj-orbit",
        mattermostAccount: { botToken: "orbit-pat" },
      },
    ]);
    expect(await fs.readFile(configPath, "utf8")).not.toContain("default-agent-pat");
    expect(await fs.readFile(configPath, "utf8")).not.toContain("orbit-pat");
  });

  it("writes the transferred token locally and applies only a SecretRef", async () => {
    const openclawDir = await tmp();
    await updateMattermostAccountSecrets(openclawDir, {
      set: { "alice-proj-retired": "retired-pat", "bob-proj-orbit": "foreign-pat" },
    });
    const manifest = {
      version: 2 as const,
      slug: "alice",
      appliedFingerprint: "fp-alice-v1",
      agentId: "octogee-alice-coach",
      accountId: "alice-coach",
      agent: { id: "octogee-alice-coach" },
      mattermostAccount: { botToken: "default-agent-pat", groupPolicy: "open" },
      bindings: [{ agentId: "octogee-alice-coach" }],
      projectAgents: [
        {
          agentId: "octogee-alice-proj-orbit-coach",
          accountId: "alice-proj-orbit",
          agent: { id: "octogee-alice-proj-orbit-coach" },
          mattermostAccount: { botToken: "orbit-pat", groupPolicy: "open" },
          bindings: [{ agentId: "octogee-alice-proj-orbit-coach" }],
        },
      ],
    };

    const { manifest: safe, secretsChanged } = await materializeActivationManifestSecret(openclawDir, manifest);

    expect(secretsChanged).toBe(true);
    expect(safe.mattermostAccount.botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/alice-coach",
    });
    expect(safe.projectAgents[0]?.mattermostAccount.botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/alice-proj-orbit",
    });
    expect(JSON.parse(await fs.readFile(path.join(openclawDir, "secrets", "mattermost-accounts.json"), "utf8"))).toEqual({
      "alice-coach": "default-agent-pat",
      "alice-proj-orbit": "orbit-pat",
      "bob-proj-orbit": "foreign-pat",
    });

    await expect(materializeActivationManifestSecret(openclawDir, manifest))
      .resolves.toMatchObject({ manifest: safe, secretsChanged: false });
  });
});
