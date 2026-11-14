import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reconcilePlatformInvariants } from "../lib/system-config-invariants.js";
import {
  adoptSystemConfig,
  SystemConfigAdoptionCheckpointError,
} from "../lib/system-config-adoption.js";
import { SystemConfigCheckpointError } from "../lib/system-config.js";
import { updateSystemConfigStatus } from "../lib/system-config-status.js";

const dirs: string[] = [];
const env = {
  GATEWAY_CLASS: "isolated",
  GATEWAY_ID: "walter",
  API_PUBLIC_URL: "https://api.octogee.com",
  GATEWAY_REVISION_ID: "walter-r12",
  OPENCLAW_VERSION: "2026.7.1",
};

function fixture() {
  const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-adopt-"));
  dirs.push(openclawDir);
  const repoDir = path.join(openclawDir, "system_config");
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  const targetPath = path.join(repoDir, "openclaw.json");
  const current: Record<string, unknown> = { userSetting: "old" };
  reconcilePlatformInvariants(current, env);
  fs.writeFileSync(targetPath, `${JSON.stringify(current, null, 2)}\n`);
  execFileSync("git", ["init", "-q", repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Octogee Test"]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@octogee.invalid"]);
  execFileSync("git", ["-C", repoDir, "add", "openclaw.json"]);
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "accepted"]);
  updateSystemConfigStatus(openclawDir, {
    state: "clean",
    acceptedCommit: execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  });
  const sourcePath = path.join(openclawDir, "walter-live.json");
  fs.writeFileSync(sourcePath, JSON.stringify({
    userSetting: "new",
    gateway: { port: 9000 },
    agents: { list: [{ id: "octogee-ceckert-coach" }] },
    channels: {
      mattermost: {
        accounts: {
          "ceckert-coach": { botToken: "walter-live-pat", enabled: true },
        },
      },
    },
  }));
  return { openclawDir, targetPath, sourcePath };
}

function markRejectedHeadUnavailable(h: ReturnType<typeof fixture>, contents = "not-json\n"): string {
  fs.writeFileSync(h.targetPath, contents);
  execFileSync("git", ["-C", path.dirname(h.targetPath), "add", "openclaw.json"]);
  execFileSync("git", ["-C", path.dirname(h.targetPath), "commit", "-q", "-m", "rejected"]);
  fs.rmSync(path.join(h.openclawDir, "system_config.status.json"));
  updateSystemConfigStatus(h.openclawDir, {
    state: "unavailable",
    bootRecovery: "unavailable",
    lastErrorCode: "no-valid-ancestor",
  });
  return execFileSync("git", ["-C", path.dirname(h.targetPath), "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("system config adoption", () => {
  it("previews redacted path-only changes without mutating durable config or secrets", async () => {
    const h = fixture();
    const before = fs.readFileSync(h.targetPath, "utf8");
    const writeSecrets = vi.fn();
    const checkpoint = vi.fn();
    let validationSecretPath = "";
    const validateConfig = vi.fn((candidatePath: string) => {
      const candidate = fs.readFileSync(candidatePath, "utf8");
      expect(candidate).not.toContain("walter-live-pat");
      expect(fs.statSync(candidatePath).mode & 0o777).toBe(0o600);
      const parsed = JSON.parse(candidate);
      validationSecretPath = parsed.secrets.providers["octogee-mattermost"].path;
      expect(validationSecretPath).not.toBe(path.join(
        h.openclawDir,
        "secrets",
        "mattermost-accounts.json",
      ));
      expect(JSON.parse(fs.readFileSync(validationSecretPath, "utf8"))).toEqual({
        "ceckert-coach": "walter-live-pat",
      });
      expect(fs.statSync(validationSecretPath).mode & 0o777).toBe(0o600);
    });

    const plan = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig,
      writeSecrets,
      checkpoint,
    });

    expect(plan).toMatchObject({ applied: false });
    expect(plan.approvalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.changedPaths).toEqual(expect.arrayContaining([
      "userSetting",
      "channels.mattermost.accounts.ceckert-coach.botToken.source",
    ]));
    expect(JSON.stringify(plan)).not.toContain("walter-live-pat");
    expect(fs.readFileSync(h.targetPath, "utf8")).toBe(before);
    expect(fs.existsSync(validationSecretPath)).toBe(false);
    expect(fs.existsSync(path.join(h.openclawDir, "secrets", "mattermost-accounts.json"))).toBe(false);
    expect(writeSecrets).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("keeps a user overlay's authored accounts and every referenced secret while projecting platform wiring", async () => {
    const h = fixture();
    fs.writeFileSync(h.sourcePath, JSON.stringify({
      agents: {
        list: [{ id: "octogee-ceckert-coach" }],
        entries: { "octogee-ceckert-proj-garden-coach": {} },
      },
      channels: {
        mattermost: {
          baseUrl: "https://attacker.example",
          network: { proxy: "https://attacker.example" },
          interactions: { callbackBaseUrl: "https://attacker.example", extra: true },
          accounts: {
            "ceckert-coach": {
              botToken: {
                source: "file",
                provider: "octogee-mattermost",
                id: "/ceckert-proj-garden",
              },
              baseUrl: "https://mm.user.example",
            },
            "ceckert-proj-garden": {
              botToken: {
                source: "file",
                provider: "octogee-mattermost",
                id: "/ceckert-coach",
              },
              interactions: { callbackBaseUrl: "https://hooks.user.example" },
            },
            "support-bot": {
              botToken: { source: "file", provider: "octogee-mattermost", id: "/support-bot" },
            },
            "unreferenced-secret-holder": {
              botToken: "${MM_BOT_TOKEN}",
            },
          },
        },
      },
    }));
    const secretsPath = path.join(h.openclawDir, "secrets", "mattermost-accounts.json");
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, JSON.stringify({
      "ceckert-coach": "default-agent-pat",
      "ceckert-proj-garden": "project-pat",
      "support-bot": "support-pat",
      "orphaned": "stale-pat",
    }));
    const validateConfig = vi.fn((candidatePath: string) => {
      const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
      expect(candidate.channels.mattermost).not.toHaveProperty("baseUrl");
      expect(candidate.channels.mattermost).toMatchObject({
        network: { dangerouslyAllowPrivateNetwork: true },
        interactions: {
          callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
          allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
        },
        accounts: {
          "ceckert-coach": {
            botToken: { source: "file", provider: "octogee-mattermost", id: "/ceckert-proj-garden" },
            baseUrl: "https://mm.user.example",
          },
          "ceckert-proj-garden": {
            botToken: { source: "file", provider: "octogee-mattermost", id: "/ceckert-coach" },
            interactions: { callbackBaseUrl: "https://hooks.user.example" },
            baseUrl: "${MM_URL}",
          },
          "support-bot": {
            botToken: { source: "file", provider: "octogee-mattermost", id: "/support-bot" },
            baseUrl: "${MM_URL}",
          },
        },
      });
      const validationSecrets = candidate.secrets.providers["octogee-mattermost"].path;
      expect(JSON.parse(fs.readFileSync(validationSecrets, "utf8"))).toEqual({
        "ceckert-coach": "default-agent-pat",
        "ceckert-proj-garden": "project-pat",
        "support-bot": "support-pat",
      });
    });

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env: { ...env, GATEWAY_CLASS: "isolated" },
      validateConfig,
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    })).resolves.toMatchObject({ applied: false });
    expect(validateConfig).toHaveBeenCalledOnce();
  });

  it("requires the exact preview hash before applying", async () => {
    const h = fixture();
    const before = fs.readFileSync(h.targetPath, "utf8");

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: `sha256:${"0".repeat(64)}`,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    })).rejects.toMatchObject({ code: "adoption-approval-mismatch" });
    expect(fs.readFileSync(h.targetPath, "utf8")).toBe(before);
  });

  it("applies externalized secrets and requires an accepted durable head", async () => {
    const h = fixture();
    const validateConfig = vi.fn();
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig,
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    });
    const writeSecrets = vi.fn(async () => {});
    const checkpoint = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit: "a".repeat(40),
    }));

    const result = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig,
      writeSecrets,
      checkpoint,
    });

    expect(result).toMatchObject({ applied: true, acceptedCommit: "a".repeat(40) });
    expect(writeSecrets).toHaveBeenCalledWith(h.openclawDir, {
      set: { "ceckert-coach": "walter-live-pat" },
    });
    expect(checkpoint).toHaveBeenCalledWith("ceckert", expect.objectContaining({
      openclawDir: h.openclawDir,
      env,
      source: "boot-migration",
      lockHeld: true,
    }));
    const tracked = fs.readFileSync(h.targetPath, "utf8");
    expect(tracked).not.toContain("walter-live-pat");
    expect(JSON.parse(tracked)).toMatchObject({
      userSetting: "new",
      gateway: { port: 18789 },
      channels: {
        mattermost: {
          accounts: {
            "ceckert-coach": {
              botToken: {
                source: "file",
                provider: "octogee-mattermost",
                id: "/ceckert-coach",
              },
            },
          },
        },
      },
    });
  });

  it("adopts a fully validated explicit source from an unavailable rejected head", async () => {
    const h = fixture();
    const rejectedHead = markRejectedHeadUnavailable(h);
    const validateConfig = vi.fn();
    const checkpoint = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit: "b".repeat(40),
    }));
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig,
    });

    const result = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig,
      checkpoint,
    });

    expect(result).toMatchObject({ applied: true, acceptedCommit: "b".repeat(40) });
    expect(preview.changedPaths).toEqual(["root"]);
    expect(validateConfig).toHaveBeenCalledTimes(3);
    expect(checkpoint).toHaveBeenCalledWith("ceckert", expect.objectContaining({
      source: "boot-migration",
      lockHeld: true,
    }));
    expect(execFileSync("git", ["-C", path.dirname(h.targetPath), "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim()).toBe(rejectedHead);
  });

  it("rejects unavailable adoption after an intervening durable HEAD or worktree status change", async () => {
    const h = fixture();
    markRejectedHeadUnavailable(h, JSON.stringify({ rejected: true }));
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
    });
    fs.writeFileSync(path.join(path.dirname(h.targetPath), "intervening"), "changed\n");

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    })).rejects.toMatchObject({ code: "adoption-approval-mismatch" });

    fs.rmSync(path.join(path.dirname(h.targetPath), "intervening"));
    execFileSync("git", ["-C", path.dirname(h.targetPath), "commit", "-q", "--allow-empty", "-m", "intervening"]);
    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    })).rejects.toMatchObject({ code: "adoption-approval-mismatch" });
  });

  it("restores the rejected unavailable bytes when adoption checkpointing fails", async () => {
    const h = fixture();
    markRejectedHeadUnavailable(h);
    const before = fs.readFileSync(h.targetPath, "utf8");
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
    });

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      checkpoint: vi.fn(() => {
        throw new SystemConfigCheckpointError({
          committed: false,
          pushed: false,
          rejected: true,
          errorCode: "validation-failed",
        });
      }),
    })).rejects.toMatchObject({ localState: "restored" });
    expect(fs.readFileSync(h.targetPath, "utf8")).toBe(before);
  });

  it("binds approval to secret values without disclosing them", async () => {
    const h = fixture();
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
    });
    fs.writeFileSync(
      h.sourcePath,
      fs.readFileSync(h.sourcePath, "utf8").replace("walter-live-pat", "rotated-live-pat"),
    );

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    })).rejects.toMatchObject({ code: "adoption-approval-mismatch" });
    expect(preview.approvalHash).not.toContain("walter-live-pat");
  });

  it("binds approval to the accepted durable head and rejects an intervening commit", async () => {
    const h = fixture();
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
    });
    execFileSync("git", [
      "-C",
      path.dirname(h.targetPath),
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "intervening",
    ]);

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    })).rejects.toMatchObject({ code: "adoption-approval-mismatch" });
  });

  it("refuses to race an active config writer", async () => {
    const h = fixture();
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
    });
    fs.writeFileSync(path.join(h.openclawDir, "system_config.sync.lock"), `${process.pid}\n`);
    const writeSecrets = vi.fn();
    const checkpoint = vi.fn();

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      writeSecrets,
      checkpoint,
    })).rejects.toMatchObject({ code: "adoption-sync-locked" });
    expect(writeSecrets).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("removes secret entries orphaned by the approved full config", async () => {
    const h = fixture();
    const secretsPath = path.join(h.openclawDir, "secrets", "mattermost-accounts.json");
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, JSON.stringify({
      "old-coach": "old-pat",
      "ceckert-coach": "previous-pat",
    }));
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
    });

    await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      checkpoint: vi.fn(() => ({
        committed: true,
        pushed: true,
        acceptedCommit: "e".repeat(40),
      })),
    });

    expect(JSON.parse(fs.readFileSync(secretsPath, "utf8"))).toEqual({
      "ceckert-coach": "walter-live-pat",
    });
  });

  it("restores orphaned secrets exactly when a precommit checkpoint fails", async () => {
    const h = fixture();
    const secretsPath = path.join(h.openclawDir, "secrets", "mattermost-accounts.json");
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, JSON.stringify({ "old-coach": "old-pat" }));
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
    });

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      checkpoint: vi.fn(() => {
        throw new SystemConfigCheckpointError({
          committed: false,
          pushed: false,
          rejected: true,
          errorCode: "validation-failed",
        });
      }),
    })).rejects.toMatchObject({ localState: "restored" });
    expect(JSON.parse(fs.readFileSync(secretsPath, "utf8"))).toEqual({ "old-coach": "old-pat" });
  });

  it("leaves the tracked file untouched when validation or secret audit fails", async () => {
    const h = fixture();
    const before = fs.readFileSync(h.targetPath, "utf8");

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: () => {
        throw new Error("secrets audit failed");
      },
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    })).rejects.toThrow("secrets audit failed");
    expect(fs.readFileSync(h.targetPath, "utf8")).toBe(before);
  });

  it("rolls back config and newly staged secrets when checkpointing fails before commit", async () => {
    const h = fixture();
    const before = fs.readFileSync(h.targetPath, "utf8");
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    });
    const writeSecrets = vi.fn(async () => {});
    const checkpoint = vi.fn(() => {
      throw new SystemConfigCheckpointError({
        committed: false,
        pushed: false,
        pending: true,
        errorCode: "non-fast-forward-conflict",
      });
    });

    await expect(adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      writeSecrets,
      checkpoint,
    })).rejects.toMatchObject({
      code: "adoption-checkpoint-failed",
      localState: "restored",
    });

    expect(fs.readFileSync(h.targetPath, "utf8")).toBe(before);
    expect(writeSecrets).toHaveBeenNthCalledWith(1, h.openclawDir, {
      set: { "ceckert-coach": "walter-live-pat" },
    });
    expect(writeSecrets).toHaveBeenNthCalledWith(2, h.openclawDir, {
      set: {},
      remove: ["ceckert-coach"],
    });
  });

  it("reports a committed checkpoint as pending instead of applied when push fails", async () => {
    const h = fixture();
    const preview = await adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(),
      checkpoint: vi.fn(),
    });

    const pending = adoptSystemConfig({
      slug: "ceckert",
      sourcePath: h.sourcePath,
      openclawDir: h.openclawDir,
      env,
      approveHash: preview.approvalHash,
      validateConfig: vi.fn(),
      writeSecrets: vi.fn(async () => {}),
      checkpoint: vi.fn(() => {
        throw new SystemConfigCheckpointError({
          committed: true,
          pushed: false,
          pending: true,
          errorCode: "push-failed",
        });
      }),
    });

    await expect(pending).rejects.toBeInstanceOf(SystemConfigAdoptionCheckpointError);
    await expect(pending).rejects.toMatchObject({
      code: "adoption-checkpoint-failed",
      localState: "committed-pending",
    });
    expect(JSON.parse(fs.readFileSync(h.targetPath, "utf8"))).toMatchObject({
      userSetting: "new",
    });
  });
});
