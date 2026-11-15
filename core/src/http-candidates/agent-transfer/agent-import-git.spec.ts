import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentImportGitError,
  agentImportRepositoryApplied,
  applyAgentImportRepository as applyAgentImportRepositoryWithPolicy,
  assertAgentImportRepositoryExpansionSafe,
  buildAgentImportGitEnvironment,
  compareAgentImportWorkspaces as compareAgentImportWorkspacesWithPolicy,
  inspectAgentImportRepository,
  rollbackAgentImportRepository,
  sanitizeAgentImportRepositoryHistory,
  scanAgentImportSecrets,
} from "./agent-import-git.js";

const roots: string[] = [];
const HOUSE_ONLY_WORKSPACE_POLICY = { preserveConvergedContextFiles: true };
const USER_OWNED_CONTEXT_POLICY = { preserveConvergedContextFiles: false };

type ApplyOptions = Parameters<typeof applyAgentImportRepositoryWithPolicy>[0];

function applyAgentImportRepository(
  options: Omit<ApplyOptions, "workspacePolicy"> & Partial<Pick<ApplyOptions, "workspacePolicy">>,
) {
  return applyAgentImportRepositoryWithPolicy({
    workspacePolicy: USER_OWNED_CONTEXT_POLICY,
    ...options,
  });
}

function compareAgentImportWorkspaces(
  sourceDir: string,
  targetDir: string,
  workspacePolicy = USER_OWNED_CONTEXT_POLICY,
) {
  return compareAgentImportWorkspacesWithPolicy(sourceDir, targetDir, workspacePolicy);
}

function temp(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  roots.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(name: string, files: Record<string, string | Buffer>): string {
  const dir = temp(name);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Octogee Test");
  git(dir, "config", "user.email", "test@octogee.invalid");
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), contents);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

function reconcileOpenClawWorkspace(
  dir: string,
  options: { skipBootstrap: boolean },
): string[] {
  if (options.skipBootstrap) return [];
  const statePath = path.join(dir, "openclaw-workspace-state.json");
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8")) as { setupCompletedAt?: string }
    : {};
  const required = ["AGENTS.md", "TOOLS.md"];
  const optional = state.setupCompletedAt ? [] : ["IDENTITY.md", "USER.md"];
  const changed: string[] = [];
  const seed = (filename: string, content: string) => {
    try {
      fs.writeFileSync(path.join(dir, filename), content, { flag: "wx" });
      changed.push(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  };
  for (const file of [...required, ...optional]) {
    seed(file, `# OpenClaw ${file}\n`);
  }
  seed("openclaw-workspace-state.json", `${JSON.stringify({ version: 1, setupCompletedAt: "2026-07-20T00:00:00.000Z" })}\n`);
  return changed;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("inspectAgentImportRepository", () => {
  it("reports reachable history and fails closed on secret findings", async () => {
    const source = repo("agent-import-source", { "MEMORY.md": "old memory\n" });
    fs.writeFileSync(path.join(source, "MEMORY.md"), "new memory\n");
    git(source, "add", "MEMORY.md");
    git(source, "commit", "-q", "-m", "remember");

    const clean = await inspectAgentImportRepository(source, {
      scanSecrets: vi.fn(async () => []),
    });
    expect(clean).toMatchObject({ commitCount: 2, fileCount: 1, secretFindings: [] });
    expect(clean.head).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.workspaceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    await expect(inspectAgentImportRepository(source, {
      scanSecrets: vi.fn(async () => [{ ruleId: "generic-api-key", path: "MEMORY.md", commit: clean.head }]),
    })).rejects.toMatchObject({ code: "secret_findings" });
  });

  it("rejects symlinks and submodules before checkout", async () => {
    const source = repo("agent-import-symlink", { "MEMORY.md": "memory\n" });
    fs.symlinkSync("MEMORY.md", path.join(source, "linked-memory"));
    git(source, "add", "linked-memory");
    git(source, "commit", "-q", "-m", "link");

    await expect(inspectAgentImportRepository(source, { scanSecrets: async () => [] }))
      .rejects.toMatchObject({ code: "unsafe_git_entry" });
  });

  it("rejects credential and raw config paths anywhere in reachable history", async () => {
    const source = repo("agent-import-sensitive-history", { ".env": "TOKEN=historical\n" });
    fs.rmSync(path.join(source, ".env"));
    fs.writeFileSync(path.join(source, "MEMORY.md"), "safe tip\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "remove credential file");

    await expect(inspectAgentImportRepository(source, { scanSecrets: async () => [] }))
      .rejects.toMatchObject({
        code: "unsafe_git_entry",
        message: expect.stringMatching(/\.env.*[0-9a-f]{40}/),
      });
  });

  it("rewrites blocked history before inspection so only durable workspace files reach destination refs", async () => {
    const source = repo("agent-import-sanitize-history", {
      "AGENTS.md": "# Agent instructions\n",
      "SOUL.md": "# Soul\n",
      "USER.md": "# User\n",
      "MEMORY.md": "remember this\n",
      ".openclaw/workspace-state.json": "{\"token\":\"must-not-survive\"}\n",
      ".env": "API_KEY=must-not-survive\n",
      "sessions/last.json": "{\"session\":\"must-not-survive\"}\n",
    });
    const blockedBlobs = [
      git(source, "rev-parse", "HEAD:.openclaw/workspace-state.json"),
      git(source, "rev-parse", "HEAD:.env"),
      git(source, "rev-parse", "HEAD:sessions/last.json"),
    ];
    fs.rmSync(path.join(source, ".openclaw"), { recursive: true, force: true });
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "remove runtime state");

    const cloneRoot = temp("agent-import-sanitize-clone");
    const clonedSource = path.join(cloneRoot, "source");
    git(cloneRoot, "clone", "-q", source, clonedSource);
    expect(git(clonedSource, "for-each-ref", "--format=%(refname)", "refs/remotes/origin")).toContain(
      "refs/remotes/origin/HEAD",
    );
    const sourceHead = await sanitizeAgentImportRepositoryHistory(source, git(source, "rev-parse", "HEAD"));
    const clonedHead = await sanitizeAgentImportRepositoryHistory(clonedSource, git(clonedSource, "rev-parse", "HEAD"));
    expect(clonedHead).toBe(sourceHead);
    expect(git(clonedSource, "for-each-ref", "--format=%(refname)", "refs"))
      .toBe("refs/heads/octogee-import");
    const inspected = await inspectAgentImportRepository(source, { scanSecrets: async () => [] });
    expect(inspected.head).toBe(sourceHead);
    expect(git(source, "log", "--all", "--", ".openclaw/workspace-state.json")).toBe("");
    expect(git(source, "log", "--all", "--", ".env")).toBe("");
    expect(git(source, "log", "--all", "--", "sessions/last.json")).toBe("");

    const target = repo("agent-import-sanitize-target", { "README.md": "starter\n" });
    const applied = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead,
      targetDir: target,
      destinationHead: git(target, "rev-parse", "HEAD"),
      importId: "import-sanitized-history",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      push: false,
    });

    for (const file of ["AGENTS.md", "SOUL.md", "USER.md", "MEMORY.md"]) {
      expect(fs.existsSync(path.join(target, file))).toBe(true);
    }
    expect(fs.existsSync(path.join(target, ".openclaw", "workspace-state.json"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(target, "sessions", "last.json"))).toBe(false);
    expect(git(target, "log", "--all", "--", ".openclaw/workspace-state.json")).toBe("");
    const reachableObjects = git(target, "rev-list", "--objects", "--all");
    for (const blockedBlob of blockedBlobs) expect(reachableObjects).not.toContain(blockedBlob);
    expect(git(target, "rev-parse", `refs/octogee/imports/import-sanitized-history/source`)).toBe(sourceHead);
    expect(git(target, "rev-list", "--parents", "-n", "1", applied.importCommit).split(" ")[2]).toBe(sourceHead);
  });

  it("rejects nested credential directories and OpenClaw config backups in history", async () => {
    const source = repo("agent-import-sensitive-backup", {
      "backup/credentials/custom.key": "historical credential\n",
      "archive/openclaw.json.bak": "{}\n",
    });

    await expect(inspectAgentImportRepository(source, { scanSecrets: async () => [] }))
      .rejects.toMatchObject({
        code: "unsafe_git_entry",
        message: expect.stringMatching(/(?:credentials|openclaw\.json\.bak).*[0-9a-f]{40}/),
      });
  });

  it("rejects Git LFS pointers instead of importing them as workspace text", async () => {
    const source = repo("agent-import-lfs", {
      "model.bin": "version https://git-lfs.github.com/spec/v1\noid sha256:0123456789abcdef\nsize 1234\n",
    });
    fs.rmSync(path.join(source, "model.bin"));
    fs.writeFileSync(path.join(source, "MEMORY.md"), "safe current tip\n");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "remove LFS pointer");

    await expect(inspectAgentImportRepository(source, { scanSecrets: async () => [] }))
      .rejects.toMatchObject({ code: "git_lfs_unsupported" });
  });

  it("caps non-blob Git objects before full verification", async () => {
    const source = repo("agent-import-large-commit", { "MEMORY.md": "memory\n" });
    git(source, "commit", "--allow-empty", "-q", "-m", "x".repeat(4096));

    await expect(assertAgentImportRepositoryExpansionSafe(
      source,
      git(source, "rev-parse", "HEAD"),
      { maxBlobBytes: 1024 },
    )).rejects.toMatchObject({ code: "archive_too_large" });
  });

  it("does not expose pod credentials to imported Git operations", () => {
    const env = buildAgentImportGitEnvironment({
      PATH: "/attacker/bin",
      OPENCLAW_GATEWAY_TOKEN: "pod-secret",
      GITEA_TOKEN: "admin-secret",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });

    expect(env).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
    expect(env).not.toHaveProperty("GITEA_TOKEN");
    expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
  });

  it("rejects symlink modes that exist only in historical trees", async () => {
    const source = repo("agent-import-historical-symlink", { "MEMORY.md": "memory\n" });
    fs.symlinkSync("MEMORY.md", path.join(source, "linked-memory"));
    git(source, "add", "linked-memory");
    git(source, "commit", "-q", "-m", "historical link");
    fs.rmSync(path.join(source, "linked-memory"));
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "remove link");

    await expect(inspectAgentImportRepository(source, { scanSecrets: async () => [] }))
      .rejects.toMatchObject({ code: "unsafe_git_entry" });
  });
});

describe("applyAgentImportRepository", () => {
  it("keeps a Trial import clean through OpenClaw reconciliation and exact rollback", async () => {
    const platformFiles = {
      "AGENTS.md": "# User agent instructions\n",
      "IDENTITY.md": "# User identity\n",
      "TOOLS.md": "# User tools\n",
      "USER.md": "# User profile\n",
      "openclaw-workspace-state.json":
        "{\"version\":1,\"setupCompletedAt\":\"2026-07-20T00:00:00.000Z\"}\n",
    };
    const source = repo("agent-import-managed-source", { "MEMORY.md": "Three minutes.\n" });
    const target = repo("agent-import-managed-target", {
      "README.md": "starter\n",
      ...platformFiles,
    });
    const destinationHead = git(target, "rev-parse", "HEAD");

    const preview = await compareAgentImportWorkspaces(
      source,
      target,
      USER_OWNED_CONTEXT_POLICY,
    );
    expect(preview.conflicts).toEqual([
      "delete:AGENTS.md",
      "delete:IDENTITY.md",
      "delete:README.md",
      "delete:TOOLS.md",
      "delete:USER.md",
    ]);
    expect(preview.preservedPaths).toEqual([
      ".files",
      "openclaw-workspace-state.json",
      "projects",
    ]);

    const applied = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead,
      importId: "import-managed-files",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      workspacePolicy: USER_OWNED_CONTEXT_POLICY,
      push: false,
    });

    for (const file of ["AGENTS.md", "IDENTITY.md", "TOOLS.md", "USER.md"]) {
      expect(fs.existsSync(path.join(target, file))).toBe(false);
    }
    expect(fs.readFileSync(path.join(target, "openclaw-workspace-state.json"), "utf8"))
      .toBe(platformFiles["openclaw-workspace-state.json"]);
    expect(fs.readFileSync(path.join(target, "MEMORY.md"), "utf8")).toBe("Three minutes.\n");
    expect(git(target, "status", "--porcelain", "--untracked-files=all")).toBe("");

    expect(reconcileOpenClawWorkspace(target, { skipBootstrap: false }))
      .toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(git(target, "status", "--porcelain", "--untracked-files=all")).not.toBe("");
    fs.rmSync(path.join(target, "AGENTS.md"));
    fs.rmSync(path.join(target, "TOOLS.md"));
    expect(reconcileOpenClawWorkspace(target, { skipBootstrap: true })).toEqual([]);
    expect(git(target, "status", "--porcelain", "--untracked-files=all")).toBe("");

    fs.writeFileSync(path.join(target, "user-note.md"), "do not discard\n");
    await expect(rollbackAgentImportRepository({
      targetDir: target,
      importCommit: applied.importCommit,
      destinationHead,
      importId: "import-managed-files",
      push: false,
    })).rejects.toMatchObject({ code: "destination_dirty" });
    fs.rmSync(path.join(target, "user-note.md"));

    const rolledBack = await rollbackAgentImportRepository({
      targetDir: target,
      importCommit: applied.importCommit,
      destinationHead,
      importId: "import-managed-files",
      push: false,
    });
    expect(git(target, "rev-parse", `${rolledBack.rollbackCommit}^{tree}`))
      .toBe(git(target, "rev-parse", `${destinationHead}^{tree}`));
    expect(git(target, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  it("preserves only exact context files for house-only plans", async () => {
    const source = repo("agent-import-path-shape-source", { "MEMORY.md": "source\n" });
    const target = repo("agent-import-path-shape-target", {
      "AGENTS.md/custom-user-file": "nested\n",
      "TOOLS.md": "platform tools\n",
    });

    const comparison = await compareAgentImportWorkspaces(
      source,
      target,
      HOUSE_ONLY_WORKSPACE_POLICY,
    );

    expect(comparison.conflicts).toEqual(["delete:AGENTS.md/custom-user-file"]);
    expect(comparison.preservedPaths).toEqual([
      ".files",
      "AGENTS.md",
      "TOOLS.md",
      "openclaw-workspace-state.json",
      "projects",
    ]);

    await applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead: git(target, "rev-parse", "HEAD"),
      importId: "import-path-shape",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      workspacePolicy: HOUSE_ONLY_WORKSPACE_POLICY,
      push: false,
    });

    expect(fs.existsSync(path.join(target, "AGENTS.md"))).toBe(false);
    expect(fs.readFileSync(path.join(target, "TOOLS.md"), "utf8")).toBe("platform tools\n");
  });

  it("removes an imported directory collision at an absent reserved file path", async () => {
    const source = repo("agent-import-reserved-file-source", {
      "MEMORY.md": "source\n",
      "openclaw-workspace-state.json/imported-child": "collision\n",
    });
    const target = repo("agent-import-reserved-file-target", { "README.md": "target\n" });

    await applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead: git(target, "rev-parse", "HEAD"),
      importId: "import-reserved-file",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      push: false,
    });

    expect(fs.existsSync(path.join(target, "openclaw-workspace-state.json"))).toBe(false);
    expect(fs.readFileSync(path.join(target, "MEMORY.md"), "utf8")).toBe("source\n");
  });

  it("preserves converged context only for house-only plans", async () => {
    const source = repo("agent-import-plan-source", {
      "AGENTS.md": "imported agents\n",
      "TOOLS.md": "imported tools\n",
    });
    const houseTarget = repo("agent-import-house-target", {
      "AGENTS.md": "free agents\n",
      "TOOLS.md": "free tools\n",
    });
    const trialTarget = repo("agent-import-trial-target", {
      "AGENTS.md": "trial agents\n",
      "TOOLS.md": "trial tools\n",
    });

    expect((await compareAgentImportWorkspaces(
      source,
      houseTarget,
      HOUSE_ONLY_WORKSPACE_POLICY,
    )).conflicts).toEqual([]);
    expect((await compareAgentImportWorkspaces(
      source,
      trialTarget,
      USER_OWNED_CONTEXT_POLICY,
    )).conflicts).toEqual(["overwrite:AGENTS.md", "overwrite:TOOLS.md"]);

    await applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: houseTarget,
      destinationHead: git(houseTarget, "rev-parse", "HEAD"),
      importId: "import-house-context",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      workspacePolicy: HOUSE_ONLY_WORKSPACE_POLICY,
      push: false,
    });
    await applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: trialTarget,
      destinationHead: git(trialTarget, "rev-parse", "HEAD"),
      importId: "import-trial-context",
      slug: "jill",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      workspacePolicy: USER_OWNED_CONTEXT_POLICY,
      push: false,
    });

    expect(fs.readFileSync(path.join(houseTarget, "AGENTS.md"), "utf8")).toBe("free agents\n");
    expect(fs.readFileSync(path.join(houseTarget, "TOOLS.md"), "utf8")).toBe("free tools\n");
    expect(fs.readFileSync(path.join(trialTarget, "AGENTS.md"), "utf8")).toBe("imported agents\n");
    expect(fs.readFileSync(path.join(trialTarget, "TOOLS.md"), "utf8")).toBe("imported tools\n");
  });

  it("summarizes destination overwrites and deletions before approval", async () => {
    const source = repo("agent-import-conflicts-source", { "README.md": "source\n" });
    const target = repo("agent-import-conflicts-target", {
      "README.md": "target\n", "NOTES.md": "existing\n", ".files/manifest.json": "{}\n",
    });

    const comparison = await compareAgentImportWorkspaces(source, target);

    expect(comparison).toMatchObject({
      conflicts: ["delete:NOTES.md", "overwrite:README.md"],
      conflictCount: 2,
    });
    expect(comparison.conflictDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("deletes uploaded import blobs when repository construction fails before publication", async () => {
    const source = repo("agent-import-cleanup-source", {
      "a.png": Buffer.from([0, 1, 2]),
      "b.png": Buffer.from([0, 3, 4]),
    });
    const target = repo("agent-import-cleanup-target", { "README.md": "starter\n" });
    const cleanupBlobs = vi.fn(async () => undefined);
    const storeBlob = vi.fn()
      .mockResolvedValueOnce({
        type: "blob", gcsPath: "customers/jack/a.png", size: 3, mimeType: "image/png", uploadedAt: "now",
      })
      .mockRejectedValueOnce(new Error("GCS unavailable"));

    await expect(applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead: git(target, "rev-parse", "HEAD"),
      importId: "import-cleanup",
      slug: "jack",
      storeBlob,
      cleanupBlobs,
      push: false,
    })).rejects.toThrow("GCS unavailable");
    expect(cleanupBlobs).toHaveBeenCalledOnce();
  });

  it("creates a two-parent import commit, preserves platform paths, and normalizes binaries", async () => {
    const source = repo("agent-import-source", {
      "AGENTS.md": "# Moof\n",
      "README.md": "source readme\n",
      "memory/2026-07-20.md": "met Jack\n",
      "photo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
      ".gitignore": "node_modules/\n",
    });
    const sourceHead = git(source, "rev-parse", "HEAD");
    const target = repo("agent-import-target", {
      "AGENTS.md": "# Octogee instructions\n",
      "README.md": "octogee starter\n",
      ".files/manifest.json": JSON.stringify({ "avatar.png": { type: "blob", gcsPath: "customers/jack/avatar.png" } }),
      "projects/existing/PROJECT.md": "keep project\n",
      ".gitignore": ".files/cache/\nprojects/*/.git/\n",
    });
    const destinationHead = git(target, "rev-parse", "HEAD");
    const storeBlob = vi.fn(async (filePath: string, contents: Buffer) => ({
      type: "blob" as const,
      gcsPath: `customers/jack/${filePath}`,
      size: contents.length,
      mimeType: "image/png",
      uploadedAt: "2026-07-20T00:00:00.000Z",
    }));

    const applied = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead,
      targetDir: target,
      destinationHead,
      importId: "import-123",
      slug: "jack",
      storeBlob,
      cleanupBlobs: vi.fn(),
      push: false,
    });

    expect(await agentImportRepositoryApplied(target, "import-123")).toBe(true);

    expect(git(target, "rev-list", "--parents", "-n", "1", applied.importCommit).split(" "))
      .toEqual([applied.importCommit, destinationHead, sourceHead]);
    expect(fs.readFileSync(path.join(target, "AGENTS.md"), "utf8")).toBe("# Moof\n");
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("source readme\n");
    expect(fs.readFileSync(path.join(target, "projects/existing/PROJECT.md"), "utf8")).toBe("keep project\n");
    expect(fs.existsSync(path.join(target, "photo.png"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(target, ".files/manifest.json"), "utf8")))
      .toMatchObject({
        "avatar.png": { gcsPath: "customers/jack/avatar.png" },
        "photo.png": { gcsPath: "customers/jack/photo.png", size: 7 },
      });
    expect(fs.readFileSync(path.join(target, ".gitignore"), "utf8")).toContain("node_modules/");
    expect(fs.readFileSync(path.join(target, ".gitignore"), "utf8")).toContain("projects/*/.git/");
    expect(storeBlob).toHaveBeenCalledWith("photo.png", expect.any(Buffer), "image/png");
    expect(git(target, "rev-parse", "refs/octogee/imports/import-123/source")).toBe(sourceHead);
  });

  it("reports no repository provenance before an import is applied", async () => {
    const target = repo("agent-import-provenance-target", { "README.md": "starter\n" });

    expect(await agentImportRepositoryApplied(target, "import-not-applied")).toBe(false);
  });

  it("removes a stale destination blob manifest entry when source imports text at the same path", async () => {
    const source = repo("agent-import-text-over-blob-source", { "memory/current.txt": "source text\n" });
    const target = repo("agent-import-text-over-blob-target", {
      "README.md": "starter\n",
      ".files/manifest.json": JSON.stringify({
        "memory/current.txt": { type: "blob", gcsPath: "customers/jack/old.txt", size: 99, mimeType: "text/plain" },
        "avatar.png": { type: "blob", gcsPath: "customers/jack/avatar.png", size: 10, mimeType: "image/png" },
      }),
    });

    await applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead: git(target, "rev-parse", "HEAD"),
      importId: "import-text-over-blob",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      push: false,
    });

    expect(fs.readFileSync(path.join(target, "memory/current.txt"), "utf8")).toBe("source text\n");
    expect(JSON.parse(fs.readFileSync(path.join(target, ".files/manifest.json"), "utf8")))
      .toEqual({
        "avatar.png": { type: "blob", gcsPath: "customers/jack/avatar.png", size: 10, mimeType: "image/png" },
      });
  });

  it("atomically publishes the imported main branch and provenance refs", async () => {
    const source = repo("agent-import-source", { "AGENTS.md": "Moof\n" });
    const sourceHead = git(source, "rev-parse", "HEAD");
    const target = repo("agent-import-target", { "README.md": "starter\n" });
    const destinationHead = git(target, "rev-parse", "HEAD");
    const remote = temp("agent-import-remote");
    git(remote, "init", "-q", "--bare");
    git(target, "remote", "add", "origin", remote);
    git(target, "push", "-q", "-u", "origin", "main");

    const applied = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead,
      targetDir: target,
      destinationHead,
      importId: "import-push",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
    });

    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(applied.importCommit);
    expect(git(remote, "rev-parse", "refs/octogee/imports/import-push/source")).toBe(sourceHead);
    expect(git(remote, "rev-parse", "refs/octogee/imports/import-push/commit")).toBe(applied.importCommit);
  });

  it("rejects a stale destination preview instead of overwriting new work", async () => {
    const source = repo("agent-import-source", { "AGENTS.md": "Moof\n" });
    const target = repo("agent-import-target", { "README.md": "starter\n" });
    const staleHead = git(target, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(target, "new.md"), "new\n");
    git(target, "add", "new.md");
    git(target, "commit", "-q", "-m", "new target work");

    await expect(applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead: staleHead,
      importId: "import-stale",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      push: false,
    })).rejects.toMatchObject({ code: "destination_changed" });
  });

  it("does not reset destination edits made while binary blobs are staged", async () => {
    const source = repo("agent-import-racing-source", { "photo.png": Buffer.from([0, 1, 2, 3]) });
    const target = repo("agent-import-racing-target", { "README.md": "starter\n" });
    const destinationHead = git(target, "rev-parse", "HEAD");
    const storeBlob = vi.fn(async () => {
      fs.writeFileSync(path.join(target, "README.md"), "user edit\n");
      return {
        type: "blob" as const,
        gcsPath: "customers/jack/agent-imports/import-racing/photo.png",
        size: 4,
        mimeType: "image/png",
        uploadedAt: "2026-07-20T12:00:00.000Z",
      };
    });

    await expect(applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead,
      importId: "import-racing",
      slug: "jack",
      storeBlob,
      cleanupBlobs: vi.fn(),
      push: false,
    })).rejects.toMatchObject({ code: "destination_dirty" });
    expect(git(target, "rev-parse", "HEAD")).toBe(destinationHead);
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("user edit\n");
  });

  it("preserves a workspace write injected after the final cleanliness check", async () => {
    const source = repo("agent-import-final-write-source", { "AGENTS.md": "Moof\n" });
    const target = repo("agent-import-final-write-target", { "README.md": "starter\n" });
    const destinationHead = git(target, "rev-parse", "HEAD");

    await expect(applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead,
      importId: "import-final-write",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      push: false,
      beforeTargetUpdate: () => {
        fs.writeFileSync(path.join(target, "README.md"), "user write after check\n");
      },
    })).rejects.toBeInstanceOf(AgentImportGitError);

    expect(git(target, "rev-parse", "HEAD")).toBe(destinationHead);
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("user write after check\n");
  });

  it("preserves a workspace commit injected after the final cleanliness check", async () => {
    const source = repo("agent-import-final-commit-source", { "AGENTS.md": "Moof\n" });
    const target = repo("agent-import-final-commit-target", { "README.md": "starter\n" });
    const destinationHead = git(target, "rev-parse", "HEAD");
    let concurrentCommit = "";

    await expect(applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead,
      importId: "import-final-commit",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      push: false,
      beforeTargetUpdate: () => {
        fs.writeFileSync(path.join(target, "user.md"), "concurrent commit\n");
        git(target, "add", "user.md");
        git(target, "commit", "-q", "-m", "concurrent user commit");
        concurrentCommit = git(target, "rev-parse", "HEAD");
      },
    })).rejects.toBeInstanceOf(AgentImportGitError);

    expect(concurrentCommit).not.toBe(destinationHead);
    expect(git(target, "rev-parse", "HEAD")).toBe(concurrentCommit);
    expect(fs.readFileSync(path.join(target, "user.md"), "utf8")).toBe("concurrent commit\n");
  });

  it("returns a retryable error while another workspace writer holds the shared lease", async () => {
    const source = repo("agent-import-busy-source", { "AGENTS.md": "Moof\n" });
    const target = repo("agent-import-busy-target", { "README.md": "starter\n" });

    await expect(applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead: git(target, "rev-parse", "HEAD"),
      importId: "import-busy",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      push: false,
      acquireMutationLease: () => null,
    })).rejects.toMatchObject({ code: "workspace_busy" });
  });

  it("returns the exact prior import when a checkpoint retry sees its own merge commit", async () => {
    const source = repo("agent-import-source", { "AGENTS.md": "Moof\n" });
    const sourceHead = git(source, "rev-parse", "HEAD");
    const target = repo("agent-import-target", { "README.md": "starter\n" });
    const destinationHead = git(target, "rev-parse", "HEAD");
    const storeBlob = vi.fn();
    const first = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead,
      targetDir: target,
      destinationHead,
      importId: "import-retry",
      slug: "jack",
      storeBlob,
      cleanupBlobs: vi.fn(),
      push: false,
    });

    const retried = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead,
      targetDir: target,
      destinationHead,
      importId: "import-retry",
      slug: "jack",
      storeBlob,
      cleanupBlobs: vi.fn(),
      push: false,
    });

    expect(retried).toEqual(first);
    expect(storeBlob).not.toHaveBeenCalled();
    expect(git(target, "rev-list", "--count", "main")).toBe("3");
  });

  it("publishes missing remote refs when retrying an exact local import after a crash", async () => {
    const source = repo("agent-import-source", { "AGENTS.md": "Moof\n" });
    const sourceHead = git(source, "rev-parse", "HEAD");
    const target = repo("agent-import-target", { "README.md": "starter\n" });
    const destinationHead = git(target, "rev-parse", "HEAD");
    const remote = temp("agent-import-crash-remote");
    git(remote, "init", "-q", "--bare");
    git(target, "remote", "add", "origin", remote);
    git(target, "push", "-q", "-u", "origin", "main");
    const first = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead,
      targetDir: target,
      destinationHead,
      importId: "import-crash",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      push: false,
    });

    const retried = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead,
      targetDir: target,
      destinationHead,
      importId: "import-crash",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
    });

    expect(retried).toEqual(first);
    expect(git(remote, "rev-parse", "refs/heads/main")).toBe(first.importCommit);
    expect(git(remote, "rev-parse", "refs/octogee/imports/import-crash/source")).toBe(sourceHead);
    expect(git(remote, "rev-parse", "refs/octogee/imports/import-crash/commit")).toBe(first.importCommit);
  });

  it("rolls back with a forward commit only while the import commit is still current", async () => {
    const source = repo("agent-import-source", { "AGENTS.md": "Moof\n" });
    const target = repo("agent-import-target", { "README.md": "starter\n" });
    const destinationHead = git(target, "rev-parse", "HEAD");
    const applied = await applyAgentImportRepository({
      sourceDir: source,
      sourceHead: git(source, "rev-parse", "HEAD"),
      targetDir: target,
      destinationHead,
      importId: "import-rollback",
      slug: "jack",
      storeBlob: vi.fn(),
      cleanupBlobs: vi.fn(),
      push: false,
    });

    const rolledBack = await rollbackAgentImportRepository({
      targetDir: target,
      importCommit: applied.importCommit,
      destinationHead,
      importId: "import-rollback",
      push: false,
    });
    expect(git(target, "rev-list", "--parents", "-n", "1", rolledBack.rollbackCommit).split(" "))
      .toEqual([rolledBack.rollbackCommit, applied.importCommit]);
    expect(git(target, "rev-parse", "refs/octogee/imports/import-rollback/rollback"))
      .toBe(rolledBack.rollbackCommit);
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toBe("starter\n");

    const retried = await rollbackAgentImportRepository({
      targetDir: target,
      importCommit: applied.importCommit,
      destinationHead,
      importId: "import-rollback",
      push: false,
    });
    expect(retried).toEqual(rolledBack);

    await expect(rollbackAgentImportRepository({
      targetDir: target,
      importCommit: applied.importCommit,
      destinationHead,
      importId: "import-rollback",
      push: false,
    })).resolves.toEqual(rolledBack);
  });
});

describe("scanAgentImportSecrets", () => {
  it("returns redacted finding coordinates and never returns match values", async () => {
    const source = repo("agent-import-scan", {
      "MEMORY.md": "ghp_secret gitleaks:allow\n",
      ".gitleaks.toml": "[allowlist]\npaths=['MEMORY.md']\n",
      ".gitleaksignore": "a:MEMORY.md:github-pat:1\n",
    });
    const run = vi.fn((_command: string, args: string[], options: { env?: NodeJS.ProcessEnv; maxOutput?: number }) => {
      expect(options.env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
      expect(options.maxOutput).toBe(4 * 1024 * 1024);
      expect(args).toContain("--ignore-gitleaks-allow");
      expect(args[args.indexOf("--config") + 1]).toBe("/gateway-edge/agent-import-gitleaks.toml");
      expect(args[args.indexOf("--gitleaks-ignore-path") + 1]).not.toContain(source);
      const reportPath = args[args.indexOf("--report-path") + 1];
      expect(reportPath).not.toBe("/dev/stdout");
      expect(path.dirname(reportPath)).not.toBe(source);
      fs.writeFileSync(reportPath, JSON.stringify([{
        RuleID: "github-pat",
        File: "MEMORY.md",
        Commit: "a".repeat(40),
        Secret: "ghp_must_not_escape",
        Match: "ghp_must_not_escape",
      }]));
      return { status: 1, stdout: "", stderr: "" };
    });

    const prior = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "pod-secret";
    const findings = await scanAgentImportSecrets(source, { run });
    if (prior === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = prior;
    expect(findings).toEqual([{
      ruleId: "github-pat",
      path: "MEMORY.md",
      commit: "a".repeat(40),
    }]);
    expect(JSON.stringify(findings)).not.toContain("ghp_must_not_escape");
  });

  it("fails closed when the scanner is unavailable", async () => {
    const source = repo("agent-import-scan", { "MEMORY.md": "memory\n" });
    await expect(scanAgentImportSecrets(source, {
      run: vi.fn(() => ({ status: null, stdout: "", stderr: "", error: new Error("ENOENT") })),
    })).rejects.toBeInstanceOf(AgentImportGitError);
  });

  it("terminates oversized scanner process output at the streaming byte cap", async () => {
    const source = repo("agent-import-scan-large", { "MEMORY.md": "memory\n" });
    await expect(scanAgentImportSecrets(source, {
      run: vi.fn((_command, _args, options: { maxOutput?: number }) => {
        expect(options.maxOutput).toBe(4 * 1024 * 1024);
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("command output exceeded limit"), { code: "ENOBUFS" }),
        };
      }),
    })).rejects.toMatchObject({ code: "secret_findings", findings: undefined });
  });

  it("rejects a scanner report larger than the report byte cap before reading it", async () => {
    const source = repo("agent-import-scan-report-large", { "MEMORY.md": "memory\n" });
    await expect(scanAgentImportSecrets(source, {
      run: vi.fn((_command, args) => {
        const reportPath = args[args.indexOf("--report-path") + 1];
        fs.writeFileSync(reportPath, "");
        fs.truncateSync(reportPath, (4 * 1024 * 1024) + 1);
        return { status: 1, stdout: "", stderr: "" };
      }),
    })).rejects.toMatchObject({ code: "secret_findings", findings: undefined });
  });

  it("rejects a scanner report that grows after its initial size check", async () => {
    const source = repo("agent-import-scan-growing", { "MEMORY.md": "memory\n" });
    const realFstat = fs.fstatSync;
    const stat = vi.spyOn(fs, "fstatSync");
    try {
      await expect(scanAgentImportSecrets(source, {
        run: vi.fn((_command, args) => {
          const reportPath = args[args.indexOf("--report-path") + 1];
          fs.writeFileSync(reportPath, "[]");
          stat.mockImplementationOnce(((fd: number) => {
            const initial = realFstat(fd);
            fs.truncateSync(reportPath, (4 * 1024 * 1024) + 1);
            return initial;
          }) as typeof fs.fstatSync);
          return { status: 1, stdout: "", stderr: "" };
        }),
      })).rejects.toMatchObject({ code: "secret_findings" });
    } finally { stat.mockRestore(); }
  });

  it("fails closed when status one has no reported findings", async () => {
    const source = repo("agent-import-scan-empty", { "MEMORY.md": "memory\n" });
    await expect(scanAgentImportSecrets(source, {
      run: vi.fn(() => ({ status: 1, stdout: "[]", stderr: "" })),
    })).rejects.toMatchObject({ code: "secret_scan_failed" });
  });
});
