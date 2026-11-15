import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reconcilePlatformInvariants } from "../lib/system-config-invariants.js";
import { readSystemConfigCommitBlob } from "../lib/system-config-durable-files.js";
import { checkpointDurableSystemConfigForSlug } from "../lib/system-config.js";
import {
  convergeSystemConfigToRemoteCommit,
  recoverSystemConfigHead,
} from "../lib/system-config-recovery.js";

const dirs: string[] = [];
const env = {
  GATEWAY_CLASS: "shared",
  GATEWAY_ID: "walter",
  API_PUBLIC_URL: "https://api.example.test",
  GATEWAY_REVISION_ID: "walter-r9",
  OPENCLAW_VERSION: "2026.7.1",
};

function validConfig(extra: Record<string, unknown> = {}): string {
  const value = { ...extra };
  reconcilePlatformInvariants(value, env);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixture(activeContents: string): { openclawDir: string; repoDir: string; configPath: string } {
  const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-recovery-"));
  dirs.push(openclawDir);
  const repoDir = path.join(openclawDir, "system_config");
  fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  const configPath = path.join(repoDir, "openclaw.json");
  fs.writeFileSync(configPath, activeContents);
  fs.writeFileSync(path.join(repoDir, ".octogee.json"), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.bak\n*.tmp\n");
  return { openclawDir, repoDir, configPath };
}

function git(repoDir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}

function localGitExec(repoDir: string, args: string[]): string | null {
  try {
    return git(repoDir, ...args);
  } catch {
    return null;
  }
}

function realGitFixture(configContents = validConfig({ accepted: true })) {
  const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-real-git-"));
  dirs.push(openclawDir);
  const repoDir = path.join(openclawDir, "system_config");
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.email", "test@octogee.test");
  git(repoDir, "config", "user.name", "Octogee Test");
  const configPath = path.join(repoDir, "openclaw.json");
  fs.writeFileSync(configPath, configContents);
  fs.writeFileSync(path.join(repoDir, ".octogee.json"), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "*.bak\n*.tmp\n");
  git(repoDir, "add", "openclaw.json", ".octogee.json", ".gitignore");
  git(repoDir, "commit", "-m", "accepted");
  return { openclawDir, repoDir, configPath, acceptedCommit: git(repoDir, "rev-parse", "HEAD") };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("system config accepted-head recovery", () => {
  it("validates and adopts the exact fetched source commit without touching external secrets", () => {
    const h = fixture(validConfig({ staleTarget: true }));
    const expectedCommit = "a".repeat(40);
    const secretsPath = path.join(h.openclawDir, "secrets", "mattermost-accounts.json");
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, '{"alice-coach":"secret-token"}\n', { mode: 0o600 });
    const commands: string[] = [];
    let head = "f".repeat(40);
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      commands.push(command);
      if (command === "fetch origin main") return "";
      if (command === "rev-parse FETCH_HEAD") return expectedCommit;
      if (command === `show ${expectedCommit}:openclaw.json`) {
        return JSON.stringify({ sourceFinal: true });
      }
      if (command === `show ${expectedCommit}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${expectedCommit}:.gitignore`) return "*.bak\n*.tmp\n";
      if (command === `reset --hard ${expectedCommit}`) {
        head = expectedCommit;
        return "";
      }
      if (command === "rev-parse HEAD") return head;
      return null;
    });

    expect(convergeSystemConfigToRemoteCommit({
      ...h,
      slug: "ceckert",
      expectedCommit,
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toEqual({ outcome: "adopted", adoptedCommit: expectedCommit });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({
      sourceFinal: true,
      gateway: {
        port: 18789,
        controlUi: {
          allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
        },
      },
    });
    expect(fs.readFileSync(secretsPath, "utf8"))
      .toBe('{"alice-coach":"secret-token"}\n');
    expect(commands).toEqual([
      "fetch origin main",
      "rev-parse FETCH_HEAD",
      "rev-parse HEAD",
      `show ${expectedCommit}:openclaw.json`,
      `show ${expectedCommit}:.octogee.json`,
      `show ${expectedCommit}:.gitignore`,
      `reset --hard ${expectedCommit}`,
      "rev-parse HEAD",
    ]);
    expect(commands.join("\n")).not.toMatch(/^(?:add|commit|push) /mu);
  });

  it("accepts a replayed target checkpoint only when it is the attributed child of the source pin", () => {
    const h = fixture(validConfig({ staleTarget: true }));
    const sourceCommit = "a".repeat(40);
    const targetCommit = "b".repeat(40);
    const targetConfig = validConfig({ sourceFinal: true });
    let head = "f".repeat(40);
    const commitMessage = [
      "migration-checkpoint: sync openclaw config 2026-07-21T10:00:00.000Z",
      "",
      "Octogee-Config-Source: migration-checkpoint",
      "Octogee-Gateway: walter",
      "OpenClaw-Version: 2026.7.1",
      `Octogee-Migration-Source: ${sourceCommit}`,
    ].join("\n");
    const commands: string[] = [];
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      commands.push(command);
      if (command === "fetch origin main") return "";
      if (command === "rev-parse FETCH_HEAD") return targetCommit;
      if (command === `rev-parse ${targetCommit}^`) return sourceCommit;
      if (command === `show -s --format=%B ${targetCommit}`) return commitMessage;
      if (command === `show ${targetCommit}:openclaw.json`) return targetConfig;
      if (command === `show ${targetCommit}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${targetCommit}:.gitignore`) return "*.bak\n*.tmp\n";
      if (command === `reset --hard ${targetCommit}`) {
        head = targetCommit;
        return "";
      }
      if (command === "rev-parse HEAD") return head;
      return null;
    });

    expect(convergeSystemConfigToRemoteCommit({
      ...h,
      slug: "ceckert",
      expectedCommit: sourceCommit,
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toEqual({ outcome: "adopted", adoptedCommit: targetCommit });
    expect(commands).toContain(`reset --hard ${targetCommit}`);
  });

  it("accepts the target boot checkpoint when activation normalized the exact source pin", () => {
    const h = fixture(validConfig({ staleTarget: true }));
    const sourceCommit = "a".repeat(40);
    const targetCommit = "b".repeat(40);
    const targetConfig = validConfig({ sourceFinal: true });
    let head = "f".repeat(40);
    const commitMessage = [
      "boot-migration: sync openclaw config 2026-07-21T10:00:00.000Z",
      "",
      "Octogee-Config-Source: boot-migration",
      "Octogee-Gateway: walter",
      "OpenClaw-Version: 2026.7.1",
    ].join("\n");
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      if (command === "fetch origin main") return "";
      if (command === "rev-parse FETCH_HEAD") return targetCommit;
      if (command === `rev-parse ${targetCommit}^`) return sourceCommit;
      if (command === `show -s --format=%B ${targetCommit}`) return commitMessage;
      if (command === `show ${targetCommit}:openclaw.json`) return targetConfig;
      if (command === `show ${targetCommit}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${targetCommit}:.gitignore`) return "*.bak\n*.tmp\n";
      if (command === `reset --hard ${targetCommit}`) {
        head = targetCommit;
        return "";
      }
      if (command === "rev-parse HEAD") return head;
      return null;
    });

    expect(convergeSystemConfigToRemoteCommit({
      ...h,
      slug: "ceckert",
      expectedCommit: sourceCommit,
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toEqual({ outcome: "adopted", adoptedCommit: targetCommit });
    expect(gitExec).toHaveBeenCalledWith(
      h.repoDir,
      ["reset", "--hard", targetCommit],
      expect.any(String),
    );
  });

  it.each([
    ["a non-direct descendant", "c".repeat(40), "migration-checkpoint", "walter", "a".repeat(40)],
    ["another gateway", "a".repeat(40), "migration-checkpoint", "other", "a".repeat(40)],
    ["an ordinary config commit", "a".repeat(40), "auto-watch", "walter", "a".repeat(40)],
    ["another gateway boot checkpoint", "a".repeat(40), "boot-migration", "other", "a".repeat(40)],
    ["another source pin", "a".repeat(40), "migration-checkpoint", "walter", "c".repeat(40)],
  ])("rejects a fetched target tip attributed to %s", (
    _case,
    parentCommit,
    source,
    gatewayId,
    migrationSourceCommit,
  ) => {
    const h = fixture(validConfig({ staleTarget: true }));
    const sourceCommit = "a".repeat(40);
    const targetCommit = "b".repeat(40);
    const message = [
      `Octogee-Config-Source: ${source}`,
      `Octogee-Gateway: ${gatewayId}`,
      `Octogee-Migration-Source: ${migrationSourceCommit}`,
    ].join("\n");
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      if (command === "fetch origin main") return "";
      if (command === "rev-parse FETCH_HEAD") return targetCommit;
      if (command === `rev-parse ${targetCommit}^`) return parentCommit;
      if (command === `show -s --format=%B ${targetCommit}`) return message;
      return null;
    });

    expect(convergeSystemConfigToRemoteCommit({
      ...h,
      slug: "ceckert",
      expectedCommit: sourceCommit,
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toEqual({ outcome: "unavailable", errorCode: "remote-commit-mismatch" });
    expect(gitExec).not.toHaveBeenCalledWith(
      h.repoDir,
      ["reset", "--hard", targetCommit],
      expect.any(String),
    );
  });

  it("checkpoints activation edits made on top of the fenced commit instead of discarding them", () => {
    const h = realGitFixture(validConfig({ seeded: true }));
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-real-remote-"));
    dirs.push(remoteDir);
    execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
    git(h.repoDir, "remote", "add", "origin", remoteDir);
    git(h.repoDir, "push", "-u", "origin", "main");
    const activated = validConfig({
      seeded: true,
      channels: { mattermost: { accounts: { "oct06-coach": { enabled: true } } } },
    });
    fs.writeFileSync(h.configPath, activated);

    const result = checkpointDurableSystemConfigForSlug("oct06", {
      openclawDir: h.openclawDir,
      expectedRemoteCommit: h.acceptedCommit,
      env,
      gitExec: localGitExec,
      readCommitBlob: readSystemConfigCommitBlob,
      validateConfig: vi.fn(),
      setRepoSshCommand: vi.fn(),
      userSshKeyPath: () => "/tmp/key",
      log: () => {},
    });

    expect(fs.readFileSync(h.configPath, "utf8")).toBe(activated);
    expect(execFileSync("git", ["--git-dir", remoteDir, "show", "main:openclaw.json"], { encoding: "utf8" }))
      .toBe(activated);
    expect(execFileSync("git", ["--git-dir", remoteDir, "rev-parse", "main^"], { encoding: "utf8" }).trim())
      .toBe(h.acceptedCommit);
    expect(result.acceptedCommit).toBe(git(h.repoDir, "rev-parse", "HEAD"));
  });

  it("rejects an invalid pinned commit before fetching or changing the checkout", () => {
    const h = fixture(validConfig({ staleTarget: true }));
    const gitExec = vi.fn();

    expect(convergeSystemConfigToRemoteCommit({
      ...h,
      slug: "ceckert",
      expectedCommit: "--upload-pack=evil",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toEqual({ outcome: "unavailable", errorCode: "invalid-expected-commit" });
    expect(gitExec).not.toHaveBeenCalled();
  });

  it("reads exact committed durable blobs without trimming trailing newlines", () => {
    const h = realGitFixture();

    expect(readSystemConfigCommitBlob(h.repoDir, h.acceptedCommit, "openclaw.json"))
      .toEqual(fs.readFileSync(h.configPath));
    expect(readSystemConfigCommitBlob(h.repoDir, h.acceptedCommit, ".octogee.json"))
      .toEqual(Buffer.from('{"schemaVersion":1}\n'));
    expect(readSystemConfigCommitBlob(h.repoDir, h.acceptedCommit, ".gitignore"))
      .toEqual(Buffer.from("*.bak\n*.tmp\n"));
  });

  it("recovers from a real accepted ancestor while preserving exact support-file bytes", () => {
    const h = realGitFixture(validConfig({ ancestor: true }));
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-config-real-remote-"));
    dirs.push(remoteDir);
    execFileSync("git", ["init", "--bare", remoteDir]);
    git(h.repoDir, "remote", "add", "origin", remoteDir);
    fs.writeFileSync(h.configPath, "not-json\n");
    git(h.repoDir, "add", "openclaw.json");
    git(h.repoDir, "commit", "-m", "invalid head");
    git(h.repoDir, "push", "-u", "origin", "main");

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec: localGitExec,
      readCommitBlob: readSystemConfigCommitBlob,
      validateConfig: vi.fn(),
    })).toMatchObject({
      outcome: "recovered",
      recoveredFromCommit: h.acceptedCommit,
    });
    expect(fs.readFileSync(path.join(h.repoDir, ".octogee.json")))
      .toEqual(Buffer.from('{"schemaVersion":1}\n'));
    expect(fs.readFileSync(path.join(h.repoDir, ".gitignore")))
      .toEqual(Buffer.from("*.bak\n*.tmp\n"));
  });
  it("appends and pushes a recovery commit from the newest valid ancestor", () => {
    const h = fixture('{"gateway":{"port":9999}}\n');
    const commands: string[] = [];
    let head = "bad111";
    const newestValidAncestor = "b".repeat(40);
    const olderValidAncestor = "c".repeat(40);
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      commands.push(command);
      if (command === "rev-parse HEAD") return head;
      if (command === "rev-list HEAD") return `bad111\n${newestValidAncestor}\n${olderValidAncestor}`;
      if (command === `show ${newestValidAncestor}:openclaw.json`) return '{"userSetting":true}\n';
      if (command === `show ${olderValidAncestor}:openclaw.json`) return validConfig({ userSetting: false });
      if (command === `show ${newestValidAncestor}:.octogee.json` ||
          command === `show ${olderValidAncestor}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${newestValidAncestor}:.gitignore` ||
          command === `show ${olderValidAncestor}:.gitignore`) return "*.bak\n*.tmp\n";
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        head = "recovered444";
        return "";
      }
      if (command === "push origin main") return "";
      return null;
    });

    const result = recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: (candidatePath) => {
        const parsed = JSON.parse(fs.readFileSync(candidatePath, "utf8")) as Record<string, unknown>;
        if (parsed.userSetting === undefined) throw new Error("invalid head");
      },
      now: () => new Date("2026-07-14T20:00:00.000Z"),
    });

    expect(result).toEqual({
      outcome: "recovered",
      rejectedCommit: "bad111",
      recoveredFromCommit: newestValidAncestor,
      acceptedCommit: "recovered444",
    });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({ userSetting: true });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({
      gateway: {
        port: 18789,
        controlUi: {
          allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
        },
      },
    });
    expect(commands.some((command) => command.includes("Octogee-Config-Source: recovery"))).toBe(true);
    expect(commands.some((command) => command.includes("Octogee-Gateway: walter"))).toBe(true);
    expect(commands.some((command) => command.includes("OpenClaw-Version: 2026.7.1"))).toBe(true);
    expect(commands.at(-1)).toBe("rev-parse HEAD");
  });

  it("keeps the rejected head available for repair when no valid ancestor exists", () => {
    const h = fixture("not-json\n");
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      if (command === "rev-parse HEAD") return "bad111";
      if (command === "rev-list HEAD") return "bad111\nbad000";
      if (command === "show bad000:openclaw.json") return '{"gateway":{"port":1}}\n';
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: () => {
        throw new Error("invalid");
      },
    })).toEqual({ outcome: "unavailable", rejectedCommit: "bad111" });
    expect(fs.readFileSync(h.configPath, "utf8")).toBe("not-json\n");
    expect(gitExec.mock.calls.some(([cwd, argv]) => cwd === h.repoDir && argv[0] === "commit")).toBe(false);
  });

  it("ignores non-SHA recovery history entries before building a git show command", () => {
    const h = fixture("not-json\n");
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      if (command === "rev-parse HEAD") return "a".repeat(40);
      if (command === "rev-list HEAD") return `${"a".repeat(40)}\n--help`;
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(() => {
        throw new Error("invalid");
      }),
    })).toMatchObject({ outcome: "unavailable" });
    expect(gitExec.mock.calls.some(([cwd, argv]) => cwd === h.repoDir && argv.join(" ") === "show --help:openclaw.json")).toBe(false);
  });

  it("records the current head when it already passes policy and validation", () => {
    const h = fixture(validConfig({ harmless: "value" }));
    const gitExec = vi.fn((_cwd: string, argv: string[]) => argv.join(" ") === "rev-parse HEAD" ? "good222" : null);

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toEqual({ outcome: "accepted", acceptedCommit: "good222" });
  });

  it("restores a valid committed HEAD after Doctor mutates the worktree without creating commits", () => {
    const h = fixture(validConfig({ doctorMutation: true }));
    const head = "a".repeat(40);
    const acceptedConfig = validConfig({ acceptedHead: true });
    const commands: string[] = [];
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      commands.push(command);
      if (command === "rev-parse HEAD") return head;
      if (command === `show ${head}:openclaw.json`) return acceptedConfig;
      if (command === `show ${head}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${head}:.gitignore`) return "*.bak\n*.tmp\n";
      return null;
    });
    const options = {
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
      acceptCurrent: false,
    };

    expect(recoverSystemConfigHead(options)).toEqual({ outcome: "accepted", acceptedCommit: head });
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(acceptedConfig);
    fs.writeFileSync(h.configPath, validConfig({ secondDoctorMutation: true }));
    expect(recoverSystemConfigHead(options)).toEqual({ outcome: "accepted", acceptedCommit: head });
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(acceptedConfig);
    expect(commands).not.toContain("rev-list HEAD");
    expect(commands.join("\n")).not.toMatch(/^(?:add|commit|push) /m);
  });

  it("restores valid committed HEAD before older history when ordinary working bytes are invalid", () => {
    const h = fixture("not-json\n");
    const head = "d".repeat(40);
    const acceptedConfig = validConfig({ acceptedHead: true });
    const commands: string[] = [];
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      commands.push(command);
      if (command === "rev-parse HEAD") return head;
      if (command === `show ${head}:openclaw.json`) return acceptedConfig;
      if (command === `show ${head}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${head}:.gitignore`) return "*.bak\n*.tmp\n";
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toEqual({ outcome: "accepted", acceptedCommit: head });
    expect(fs.readFileSync(h.configPath, "utf8")).toBe(acceptedConfig);
    expect(commands).not.toContain("rev-list HEAD");
    expect(commands.join("\n")).not.toMatch(/^(?:add|commit|push) /m);
  });

  it("reconciles the latest committed config before considering an older ancestor", () => {
    const latest = "a".repeat(40);
    const ancestor = "b".repeat(40);
    const h = fixture('{"gateway":{"port":9000},"userSetting":"latest"}\n');
    let head = latest;
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      if (command === "rev-parse HEAD") return head;
      if (command === "rev-list HEAD") return `${latest}\n${ancestor}`;
      if (command === `show ${latest}:openclaw.json`) {
        return '{"gateway":{"port":9000},"userSetting":"latest"}\n';
      }
      if (command === `show ${ancestor}:openclaw.json`) {
        return validConfig({ userSetting: "ancestor" });
      }
      if (command.endsWith(":.octogee.json")) return '{"schemaVersion":1}\n';
      if (command.endsWith(":.gitignore")) return "*.bak\n*.tmp\n";
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        head = "c".repeat(40);
        return "";
      }
      if (command === "push origin main") return "";
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toMatchObject({
      outcome: "recovered",
      rejectedCommit: latest,
      recoveredFromCommit: latest,
      acceptedCommit: "c".repeat(40),
    });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({
      gateway: { port: 18789, mode: "local", bind: "lan" },
      userSetting: "latest",
    });
    expect(gitExec.mock.calls.filter(([, argv]) => argv[0] === "commit")).toHaveLength(1);
    expect(gitExec.mock.calls.filter(([, argv]) => argv.join(" ") === "push origin main")).toHaveLength(1);
  });

  it("recovers a committed openclaw.json deletion from the newest complete ancestor", () => {
    const h = fixture(validConfig({ deletedAtHead: true }));
    fs.rmSync(h.configPath);
    const head = "a".repeat(40);
    const ancestor = "b".repeat(40);
    let recoveredHead = head;
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      if (command === "rev-parse HEAD") return recoveredHead;
      if (command === "rev-list HEAD") return `${head}\n${ancestor}`;
      if (command === `show ${ancestor}:openclaw.json`) return validConfig({ recovered: true });
      if (command === `show ${ancestor}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${ancestor}:.gitignore`) return "*.bak\n*.tmp\n";
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        recoveredHead = "c".repeat(40);
        return "";
      }
      if (command === "push origin main") return "";
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toMatchObject({
      outcome: "recovered",
      rejectedCommit: head,
      recoveredFromCommit: ancestor,
      acceptedCommit: "c".repeat(40),
    });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({ recovered: true });
  });

  it("skips a committed candidate with an unknown pending state cleanup", () => {
    const h = fixture("not-json\n");
    const head = "a".repeat(40);
    const ancestor = "b".repeat(40);
    let recoveredHead = head;
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      if (command === "rev-parse HEAD") return recoveredHead;
      if (command === "rev-list HEAD") return `${head}\n${ancestor}`;
      if (command === `show ${head}:openclaw.json`) return validConfig({ rejected: true });
      if (command === `show ${head}:.octogee.json`) {
        return '{"schemaVersion":1,"pendingStateCleanup":"unknown"}\n';
      }
      if (command === `show ${ancestor}:openclaw.json`) return validConfig({ recovered: true });
      if (command === `show ${ancestor}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command.endsWith(":.gitignore")) return "*.bak\n*.tmp\n";
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        recoveredHead = "c".repeat(40);
        return "";
      }
      if (command === "push origin main") return "";
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toMatchObject({
      outcome: "recovered",
      recoveredFromCommit: ancestor,
    });
    expect(JSON.parse(fs.readFileSync(h.configPath, "utf8"))).toMatchObject({ recovered: true });
  });

  it("rejects malformed current metadata and restores the complete accepted ancestor", () => {
    const h = fixture(validConfig({ current: true }));
    fs.writeFileSync(path.join(h.repoDir, ".octogee.json"), "{ invalid");
    const head = "a".repeat(40);
    const ancestor = "b".repeat(40);
    let recoveredHead = head;
    const gitExec = vi.fn((_cwd: string, commandArgv: string[]) => {
      const command = commandArgv.join(" ");
      if (command === "rev-parse HEAD") return recoveredHead;
      if (command === "rev-list HEAD") return `${head}\n${ancestor}`;
      if (command === `show ${ancestor}:openclaw.json`) return validConfig({ recovered: true });
      if (command === `show ${ancestor}:.octogee.json`) return '{"schemaVersion":1}\n';
      if (command === `show ${ancestor}:.gitignore`) return "*.bak\n*.tmp\n";
      if (command.startsWith("add ")) return "";
      if (command.startsWith("commit ")) {
        recoveredHead = "c".repeat(40);
        return "";
      }
      if (command === "push origin main") return "";
      return null;
    });

    expect(recoverSystemConfigHead({
      ...h,
      slug: "ceckert",
      env,
      gitExec,
      validateConfig: vi.fn(),
    })).toMatchObject({ outcome: "recovered", recoveredFromCommit: ancestor });
    expect(JSON.parse(fs.readFileSync(path.join(h.repoDir, ".octogee.json"), "utf8")))
      .toEqual({ schemaVersion: 1 });
  });

});
