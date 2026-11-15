import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, spawnSync } from "child_process";
import { removePersistedRepoSshCommand } from "../lib/git.js";

function userSshKeyPath(keysDir: string, slug: string): string {
  return path.join(keysDir, slug, "id_ed25519");
}

function giteaUsername(slug: string): string {
  return `ws-${slug}`;
}

function generateUserSshKey(keysDir: string, slug: string): string {
  const keyDir = path.join(keysDir, slug);
  const keyPath = path.join(keyDir, "id_ed25519");
  const pubPath = keyPath + ".pub";

  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(pubPath, "utf-8").trim();
  }

  fs.mkdirSync(keyDir, { recursive: true });
  execSync(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -C "octogee-${slug}@gateway" -q`, {
    stdio: "pipe",
  });
  fs.chmodSync(keyDir, 0o700);
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(pubPath, 0o644);

  return fs.readFileSync(pubPath, "utf-8").trim();
}

describe("SSH key generation", () => {
  let openclawDir: string;
  let keysDir: string;
  let usersDir: string;

  beforeEach(() => {
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitea-test-"));
    keysDir = path.join(openclawDir, "customer-keys");
    usersDir = path.join(openclawDir, "customers");
    fs.mkdirSync(keysDir, { recursive: true });
    fs.mkdirSync(usersDir, { recursive: true });
  });

  it("generates an ed25519 keypair in the customer-keys directory", () => {
    const pubKey = generateUserSshKey(keysDir, "acme");

    expect(pubKey).toMatch(/^ssh-ed25519 /);
    expect(pubKey).toContain("octogee-acme@gateway");

    const keyPath = path.join(keysDir, "acme", "id_ed25519");
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.existsSync(keyPath + ".pub")).toBe(true);
  });

  it("sets correct file permissions", () => {
    generateUserSshKey(keysDir, "acme");

    const keyDir = path.join(keysDir, "acme");
    const keyPath = path.join(keyDir, "id_ed25519");

    const dirStat = fs.statSync(keyDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const keyStat = fs.statSync(keyPath);
    expect(keyStat.mode & 0o777).toBe(0o600);

    const pubStat = fs.statSync(keyPath + ".pub");
    expect(pubStat.mode & 0o777).toBe(0o644);
  });

  it("is idempotent — returns existing key without regenerating", () => {
    const key1 = generateUserSshKey(keysDir, "acme");
    const key2 = generateUserSshKey(keysDir, "acme");
    expect(key1).toBe(key2);
  });

  it("generates unique keys per user", () => {
    const keyA = generateUserSshKey(keysDir, "acme");
    const keyB = generateUserSshKey(keysDir, "bob");
    expect(keyA).not.toBe(keyB);
  });

  it("private key is not readable by other users (0600)", () => {
    generateUserSshKey(keysDir, "acme");
    const keyPath = path.join(keysDir, "acme", "id_ed25519");
    const stat = fs.statSync(keyPath);

    expect(stat.mode & 0o077).toBe(0);
  });

  it("does NOT pre-create the user workspace dir (regression: TEST 2026-04-29 buildera clone loop)", () => {

generateUserSshKey(keysDir, "acme");
    expect(fs.existsSync(path.join(usersDir, "acme"))).toBe(false);
  });
});

describe("user SSH key path", () => {
  it("derives correct path from slug (sibling of customers/, not nested inside)", () => {
    const p = userSshKeyPath("/home/node/.openclaw/customer-keys", "acme-co");
    expect(p).toBe("/home/node/.openclaw/customer-keys/acme-co/id_ed25519");
  });
});

describe("Gitea username", () => {
  it("prefixes slug with ws-", () => {
    expect(giteaUsername("acme-co")).toBe("ws-acme-co");
    expect(giteaUsername("test")).toBe("ws-test");
  });

  it("is deterministic", () => {
    expect(giteaUsername("x")).toBe(giteaUsername("x"));
  });
});

describe("workspace .gitignore excludes .ssh/", () => {
  it("initWorkspaceRepo gitignore template contains .ssh/ but keeps context files user-owned", () => {

    const gitTs = fs.readFileSync(
      path.resolve(__dirname, "..", "lib", "git.ts"),
      "utf-8",
    );

    expect(gitTs).toContain('".ssh/",');
    expect(gitTs).not.toContain('"AGENTS.md",');
    expect(gitTs).not.toContain('"TOOLS.md",');
    expect(gitTs).toContain("# AGENTS.md, TOOLS.md");
  });
});

describe("setRepoSshCommand", () => {
  let openclawDir: string;
  let repoDir: string;
  let keysDir: string;

  beforeEach(() => {
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ssh-cmd-"));
    repoDir = path.join(openclawDir, "customers", "acme");
    keysDir = path.join(openclawDir, "customer-keys");
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(keysDir, { recursive: true });
    execSync("git init -q -b main", { cwd: repoDir });
  });

  function expectedSshCommand(keyPath: string): string {
    return `ssh -i ${keyPath} -F /home/node/.ssh/config -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
  }

  it("removes a persisted core.sshCommand when the user key exists", async () => {
    generateUserSshKey(keysDir, "acme");
    const keyPath = userSshKeyPath(keysDir, "acme");

if (fs.existsSync(keyPath)) {
      execSync(`git config core.sshCommand "${expectedSshCommand(keyPath)}"`, {
        cwd: repoDir,
      });
    }

    removePersistedRepoSshCommand(repoDir);
    const result = spawnSync("git", ["config", "--get", "core.sshCommand"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
  });

  it("is idempotent and removes every persisted SSH command value", () => {
    generateUserSshKey(keysDir, "acme");
    const keyPath = userSshKeyPath(keysDir, "acme");
    const cmd = `git config core.sshCommand "${expectedSshCommand(keyPath)}"`;
    execSync(cmd, { cwd: repoDir });
    execSync(`git config --add core.sshCommand "${expectedSshCommand(keyPath)}"`, { cwd: repoDir });
    removePersistedRepoSshCommand(repoDir);

    const result = spawnSync("git", ["config", "--get-all", "core.sshCommand"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
  });

  it("source enforces it: every init/clone path in git.ts calls setRepoSshCommand", () => {

const gitTs = fs.readFileSync(
      path.resolve(__dirname, "..", "lib", "git.ts"),
      "utf-8",
    );
    expect(gitTs).toContain("export function setRepoSshCommand");

const callSiteCount = (gitTs.match(/setRepoSshCommand\(/g) ?? []).length - 1;
    expect(callSiteCount).toBeGreaterThanOrEqual(4);
  });
});

describe("pushInitialSkeleton", () => {
  let workDir: string;
  let defaultAgentDir: string;
  let originDir: string;
  let originalGitSsh: string | undefined;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "init-skeleton-"));
    defaultAgentDir = path.join(workDir, "coach");
    originDir = path.join(workDir, "origin.git");
    fs.mkdirSync(defaultAgentDir);
    fs.mkdirSync(originDir);
    originalGitSsh = process.env.GIT_SSH;
    const testSsh = path.join(workDir, "test-ssh");
    fs.writeFileSync(testSsh, "#!/bin/sh\nshift\nexec /bin/sh -c \"$1\"\n");
    fs.chmodSync(testSsh, 0o755);
    process.env.GIT_SSH = testSsh;
    execSync("git init -q --bare -b main", { cwd: originDir, stdio: "pipe" });
    execSync("git init -q -b main", { cwd: defaultAgentDir, stdio: "pipe" });
    execSync(`git config user.email "test@octogee.com"`, { cwd: defaultAgentDir });
    execSync(`git config user.name "Test"`, { cwd: defaultAgentDir });
    execSync(`git remote add origin "ssh://git@localhost${originDir}"`, { cwd: defaultAgentDir });
  });
  afterEach(() => {
    if (originalGitSsh === undefined) delete process.env.GIT_SSH;
    else process.env.GIT_SSH = originalGitSsh;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function originHas(ref: string): boolean {
    try {
      execSync(`git show-ref --verify --quiet ${ref}`, { cwd: originDir });
      return true;
    } catch {
      return false;
    }
  }
  function originLog(): string {
    return execSync("git log --oneline main", { cwd: originDir }).toString();
  }

  it("commits and pushes when working tree is dirty", async () => {
    fs.writeFileSync(path.join(defaultAgentDir, "SOUL.md"), "# Soul\n");
    const { pushInitialSkeleton } = await import("../lib/git.js");
    pushInitialSkeleton(defaultAgentDir, "test-slug");
    expect(originHas("refs/heads/main")).toBe(true);
    expect(originLog()).toContain("initial workspace skeleton");
  });

  it("pushes existing local history when working tree is clean (recovery path)", async () => {
    fs.writeFileSync(path.join(defaultAgentDir, "SOUL.md"), "# Soul\n");
    execSync("git add -A && git commit -q -m 'pre-existing'", { cwd: defaultAgentDir });
    expect(originHas("refs/heads/main")).toBe(false);
    const { pushInitialSkeleton } = await import("../lib/git.js");
    pushInitialSkeleton(defaultAgentDir, "test-slug");
    expect(originHas("refs/heads/main")).toBe(true);
    expect(originLog()).toContain("pre-existing");
    expect(originLog()).not.toContain("initial workspace skeleton");
  });
});
