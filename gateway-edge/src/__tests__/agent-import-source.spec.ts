import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

import { buildAgentImportConfigArtifacts } from "@octogee/shared/types/agent-import";
import {
  AgentImportSourceError,
  extractLocalAgentImportArchive,
  githubAgentImportCloneCommandArgs,
  githubAgentImportCloneEnvironment,
  githubAgentImportCloneUrl,
} from "../lib/agent-import-source.js";
import { workspaceGitEnvironment } from "@octogee/core/workspace/workspace-git";

const roots: string[] = [];

function temp(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sourceRepo(): string {
  const repo = temp("agent-import-local-source");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Jack");
  git(repo, "config", "user.email", "jack@example.invalid");
  fs.writeFileSync(path.join(repo, "MEMORY.md"), "old memory\n");
  fs.mkdirSync(path.join(repo, "bin"));
  fs.writeFileSync(path.join(repo, "bin", "moof"), "#!/bin/sh\necho moof\n", { mode: 0o755 });
  git(repo, "add", "MEMORY.md", "bin/moof");
  git(repo, "commit", "-q", "-m", "old memory");
  fs.writeFileSync(path.join(repo, "MEMORY.md"), "new uncommitted memory\n");
  fs.writeFileSync(path.join(repo, "SOUL.md"), "I am Moof.\n");
  return repo;
}

function artifacts() {
  return buildAgentImportConfigArtifacts({
    meta: { lastTouchedVersion: "2025.4.3" },
    agents: { list: [{ id: "moof", name: "Moof", heartbeat: { every: "30m" } }] },
    gateway: { auth: { token: "must-not-be-in-artifacts" } },
  }, "moof");
}

async function localArchive(repo: string): Promise<Buffer> {
  const zip = new JSZip();
  const config = artifacts();
  zip.file("manifest.json", JSON.stringify({
    formatVersion: 1,
    sourceAgentId: "moof",
    hadGit: true,
    uncommittedFileCount: 2,
  }));
  zip.file("portable-agent.json", JSON.stringify(config.portableAgent));
  zip.file("config-inventory.json", JSON.stringify(config.configInventory));
  zip.file("doctor-candidate.json", JSON.stringify(config.doctorCandidate));
  zip.file("workspace/MEMORY.md", fs.readFileSync(path.join(repo, "MEMORY.md")));
  zip.file("workspace/SOUL.md", fs.readFileSync(path.join(repo, "SOUL.md")));
  zip.file("workspace/bin/moof", fs.readFileSync(path.join(repo, "bin", "moof")));
  for (const relative of ["HEAD", "packed-refs", "shallow"]) {
    const file = path.join(repo, ".git", relative);
    if (fs.existsSync(file)) zip.file(`git/${relative}`, fs.readFileSync(file));
  }
  for (const rootName of ["objects", "refs"]) {
    const root = path.join(repo, ".git", rootName);
    if (!fs.existsSync(root)) continue;
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else {
          const relative = path.relative(path.join(repo, ".git"), absolute).split(path.sep).join("/");
          try {
            const contents = fs.readFileSync(absolute);
            if (!entry.name.endsWith(".lock")) zip.file(`git/${relative}`, contents);
          } catch (error) {
            if (entry.name.endsWith(".lock") && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
        }
      }
    };
    visit(root);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("GitHub agent import source", () => {
  it("uses a token-free URL and passes OAuth through a scoped Git credential helper", () => {
    expect(githubAgentImportCloneUrl("jack", "moof")).toBe("https://github.com/jack/moof.git");
    const env = githubAgentImportCloneEnvironment("gho_private", { PATH: "/bin", OTHER_SECRET: "drop" });
    expect(env).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
      OCTOGEE_GITHUB_TOKEN: "gho_private",
    });
    expect(env).not.toHaveProperty("OTHER_SECRET");
    expect(env).not.toHaveProperty("GIT_CONFIG_COUNT");
    const args = githubAgentImportCloneCommandArgs(["clone", "https://github.com/jack/moof.git"]);
    expect(args).toContain("credential.helper=");
    expect(args.join(" ")).toContain("OCTOGEE_GITHUB_TOKEN");
    expect(args.join(" ")).not.toContain("gho_private");
    expect(workspaceGitEnvironment(env, undefined, env.OCTOGEE_GITHUB_TOKEN).OCTOGEE_GITHUB_TOKEN)
      .toBe("gho_private");
    expect(githubAgentImportCloneUrl("jack", "moof")).not.toContain("gho_private");
  });

  it("rejects owner, repo, and branch injection", () => {
    expect(() => githubAgentImportCloneUrl("jack/evil", "moof")).toThrow(AgentImportSourceError);
    expect(() => githubAgentImportCloneUrl("jack", "--upload-pack=evil")).toThrow(AgentImportSourceError);
  });
});

describe("local agent import archive", () => {
  it("reconstructs safe Git history and commits the uploaded working tree tip", async () => {
    const source = sourceRepo();
    const extracted = await extractLocalAgentImportArchive(await localArchive(source), { tmpRoot: temp("extract-root") });
    try {
      expect(extracted.artifacts.portableAgent.name).toBe("Moof");
      expect(extracted.manifest).toMatchObject({ hadGit: true, uncommittedFileCount: 2 });
      expect(git(extracted.repoDir, "rev-list", "--count", extracted.sourceHead)).toBe("2");
      expect(fs.readFileSync(path.join(extracted.repoDir, "MEMORY.md"), "utf8"))
        .toBe("new uncommitted memory\n");
      expect(fs.readFileSync(path.join(extracted.repoDir, "SOUL.md"), "utf8")).toBe("I am Moof.\n");
      expect(git(extracted.repoDir, "ls-tree", extracted.sourceHead, "bin/moof")).toContain("100755");
      expect(JSON.stringify(extracted.artifacts)).not.toContain("must-not-be-in-artifacts");
    } finally {
      extracted.cleanup();
    }
  });

  it("rewrites blocked runtime history while retaining the durable workspace tip", async () => {
    const source = sourceRepo();
    fs.mkdirSync(path.join(source, ".openclaw"));
    fs.writeFileSync(path.join(source, ".openclaw", "workspace-state.json"), "token=must-not-survive\n");
    git(source, "add", ".openclaw/workspace-state.json");
    git(source, "commit", "-q", "-m", "runtime state");

    const extracted = await extractLocalAgentImportArchive(await localArchive(source), { tmpRoot: temp("extract-root") });
    try {
      expect(fs.readFileSync(path.join(extracted.repoDir, "MEMORY.md"), "utf8"))
        .toBe("new uncommitted memory\n");
      expect(fs.readFileSync(path.join(extracted.repoDir, "SOUL.md"), "utf8")).toBe("I am Moof.\n");
      expect(git(extracted.repoDir, "log", "--all", "--", ".openclaw/workspace-state.json")).toBe("");
      expect(fs.existsSync(path.join(extracted.repoDir, ".openclaw", "workspace-state.json"))).toBe(false);
    } finally {
      extracted.cleanup();
    }
  });

  it("reconstructs the same sanitized local head for preview and apply", async () => {
    const source = sourceRepo();
    fs.mkdirSync(path.join(source, ".openclaw"));
    fs.writeFileSync(path.join(source, ".openclaw", "workspace-state.json"), "token=must-not-survive\n");
    git(source, "add", ".openclaw/workspace-state.json");
    git(source, "commit", "-q", "-m", "runtime state");
    const archive = await localArchive(source);

    const preview = await extractLocalAgentImportArchive(archive, { tmpRoot: temp("extract-preview") });
    const apply = await extractLocalAgentImportArchive(archive, { tmpRoot: temp("extract-apply") });
    try {
      expect(apply.sourceHead).toBe(preview.sourceHead);
    } finally {
      preview.cleanup();
      apply.cleanup();
    }
  });

  it("omits transient Git lock files from the local archive", async () => {
    const source = sourceRepo();
    fs.writeFileSync(path.join(source, ".git", "objects", "maintenance.lock"), "temporary maintenance state");

    const archive = await localArchive(source);
    const zip = await JSZip.loadAsync(archive);

    expect(zip.file("git/objects/maintenance.lock")).toBeNull();
  });

  it("drops forbidden archive entries while retaining safe workspace files", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({ formatVersion: 1, sourceAgentId: "moof", hadGit: false, uncommittedFileCount: 0 }));
    const config = artifacts();
    zip.file("portable-agent.json", JSON.stringify(config.portableAgent));
    zip.file("config-inventory.json", JSON.stringify(config.configInventory));
    zip.file("doctor-candidate.json", JSON.stringify(config.doctorCandidate));
    zip.file("workspace/.env", "API_KEY=nope");
    zip.file("workspace/MEMORY.md", "durable memory\n");

    const extracted = await extractLocalAgentImportArchive(
      await zip.generateAsync({ type: "nodebuffer" }),
      { tmpRoot: temp("extract-root") },
    );
    try {
      expect(fs.readFileSync(path.join(extracted.repoDir, "MEMORY.md"), "utf8")).toBe("durable memory\n");
      expect(fs.existsSync(path.join(extracted.repoDir, ".env"))).toBe(false);
    } finally {
      extracted.cleanup();
    }
  });

  it("rejects declared expansion limits before extracting ZIP entry contents", async () => {
    const zip = new JSZip();
    const config = artifacts();
    zip.file("manifest.json", JSON.stringify({ formatVersion: 1, sourceAgentId: "moof", hadGit: false, uncommittedFileCount: 0 }));
    zip.file("portable-agent.json", JSON.stringify(config.portableAgent));
    zip.file("config-inventory.json", JSON.stringify(config.configInventory));
    zip.file("doctor-candidate.json", JSON.stringify(config.doctorCandidate));
    zip.file("workspace/MEMORY.md", "x".repeat(128));

    await expect(extractLocalAgentImportArchive(
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      { tmpRoot: temp("extract-root"), maxEntryBytes: 64 },
    )).rejects.toMatchObject({ code: "archive_too_large" });
  });

  it("rejects a highly compressed oversized blob on a non-HEAD ref before checkout", async () => {
    const source = sourceRepo();
    git(source, "checkout", "-q", "-b", "hidden-large-object");
    fs.writeFileSync(path.join(source, "huge.txt"), "x".repeat(4096));
    git(source, "add", "huge.txt");
    git(source, "commit", "-q", "-m", "compressed oversized blob");
    git(source, "checkout", "-q", "main");

    await expect(extractLocalAgentImportArchive(
      await localArchive(source),
      { tmpRoot: temp("extract-root"), maxGitBlobBytes: 1024 },
    )).rejects.toMatchObject({ code: "archive_too_large" });
  });

  it("rejects replacement refs smuggled through packed-refs", async () => {
    const source = sourceRepo();
    const zip = await JSZip.loadAsync(await localArchive(source));
    const head = git(source, "rev-parse", "HEAD");
    zip.file("git/packed-refs", `# pack-refs with: peeled fully-peeled sorted\n${head} refs/replace/${head}\n`);

    await expect(extractLocalAgentImportArchive(
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      { tmpRoot: temp("extract-root") },
    )).rejects.toMatchObject({ code: "unsafe_archive_entry" });
  });

  it("drops an ordinary packed remote-tracking ref while retaining importable history", async () => {
    const source = sourceRepo();
    const head = git(source, "rev-parse", "HEAD");
    git(source, "update-ref", "refs/remotes/origin/main", head);
    git(source, "pack-refs", "--all");

    const extracted = await extractLocalAgentImportArchive(
      await localArchive(source),
      { tmpRoot: temp("extract-root") },
    );
    try {
      expect(git(extracted.repoDir, "rev-parse", "HEAD")).toBe(extracted.sourceHead);
      expect(fs.readFileSync(path.join(extracted.repoDir, ".git", "packed-refs"), "utf8"))
        .not.toContain("refs/remotes/origin/main");
    } finally {
      extracted.cleanup();
    }
  });
});
