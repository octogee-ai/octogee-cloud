import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";
import { workspaceMutationLeaseGitDir } from "@octogee/core/workspace/workspace-git";
import {
  cloneGithubProjectCheckout,
  githubCloneCredentialEnv,
} from "./github-project-clone.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset().mockImplementation(realSpawn);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function seedProjectPlaceholder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-project-checkout-"));
  roots.push(root);
  const usersRoot = path.join(root, "customers");
  vi.stubEnv("CUSTOMERS_DIR", usersRoot);
  const destination = path.join(usersRoot, "alice", "projects", "octo");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "SOUL.md"), "preserve this identity\n");
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  fs.writeFileSync(path.join(source, "README.md"), "canonical project\n");
  execFileSync("git", ["add", "README.md"], { cwd: source });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd: source });
  vi.mocked(spawn).mockImplementationOnce((command, args, options) => realSpawn(command, [
    ...args!.map((arg) => {
      if (arg === "https://github.com/octogee-ai/octogee.git") return source;
      if (arg === "protocol.file.allow=never") return "protocol.file.allow=always";
      return arg;
    }),
  ], options));
  const input = { usersRoot, builderSlug: "alice", projectSlug: "octo",
    repository: { owner: "octogee-ai", repo: "octogee" }, accessToken: "test-token" };
  return { root, destination, input };
}

describe("GitHub project clone broker", () => {
  it("quarantines the existing checkout across the Projects and Home volume boundary", async () => {
    const { root, destination, input } = seedProjectPlaceholder();
    fs.symlinkSync("../reference", path.join(destination, "reference-link"));
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
      if (source === destination) throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" });
      return rename(source, target);
    });

    await expect(cloneGithubProjectCheckout(input)).resolves.toBe("cloned");

    expect(fs.readFileSync(path.join(destination, "README.md"), "utf8")).toBe("canonical project\n");
    expect(fs.statSync(path.join(destination, ".git")).isDirectory()).toBe(true);
    const quarantine = path.join(root, "git-worktree-quarantine", "alice");
    const saved = fs.readdirSync(quarantine);
    expect(saved).toHaveLength(1);
    expect(fs.readFileSync(path.join(quarantine, saved[0]!, "SOUL.md"), "utf8"))
      .toBe("preserve this identity\n");
    expect(fs.readlinkSync(path.join(quarantine, saved[0]!, "reference-link"))).toBe("../reference");
    expect(fs.existsSync(path.join(destination, "SOUL.md"))).toBe(false);
  });

  it("retains the existing checkout and removes a partial quarantine when copying fails", async () => {
    const { root, destination, input } = seedProjectPlaceholder();
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
      if (source === destination) throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" });
      return rename(source, target);
    });
    vi.spyOn(fs.promises, "cp").mockImplementationOnce(async (_source, target) => {
      fs.writeFileSync(path.join(path.dirname(String(target)), "partial"), "incomplete");
      throw new Error("quarantine copy failed");
    });

    await expect(cloneGithubProjectCheckout(input)).rejects.toThrow("quarantine copy failed");

    expect(fs.readFileSync(path.join(destination, "SOUL.md"), "utf8")).toBe("preserve this identity\n");
    expect(fs.readdirSync(path.dirname(destination))).toEqual(["octo"]);
    expect(fs.readdirSync(path.join(root, "git-worktree-quarantine", "alice"))).toEqual([]);
  });

  it("installs a checkout over a template-only directory and preserves its files in quarantine", async () => {
    const { root, destination, input } = seedProjectPlaceholder();

    await expect(cloneGithubProjectCheckout(input)).resolves.toBe("cloned");

    expect(fs.readFileSync(path.join(destination, "README.md"), "utf8")).toBe("canonical project\n");
    expect(fs.statSync(path.join(destination, ".git")).isDirectory()).toBe(true);
    const quarantine = path.join(root, "git-worktree-quarantine", "alice");
    const saved = fs.readdirSync(quarantine);
    expect(saved).toHaveLength(1);
    expect(fs.readFileSync(path.join(quarantine, saved[0]!, "SOUL.md"), "utf8"))
      .toBe("preserve this identity\n");
    expect(await cloneGithubProjectCheckout(input)).toBe("exists");
  });

  it("preserves the placeholder when another project mutation owns its external lease", async () => {
    const { destination, input } = seedProjectPlaceholder();
    const lease = acquireWorkspaceMutationLeaseSync({
      workspaceDir: destination,
      gitDir: workspaceMutationLeaseGitDir(destination),
    });
    expect(lease).not.toBeNull();
    try {
      await expect(cloneGithubProjectCheckout(input)).rejects.toThrow("workspace mutation lease unavailable");
      expect(fs.readFileSync(path.join(destination, "SOUL.md"), "utf8")).toBe("preserve this identity\n");
      expect(fs.readdirSync(path.dirname(destination))).toEqual(["octo"]);
    } finally {
      lease?.release();
    }
  });

  it("does not install a first checkout while another project mutation holds the lease", async () => {
    const { destination, input } = seedProjectPlaceholder();
    fs.rmSync(destination, { recursive: true });
    const lease = acquireWorkspaceMutationLeaseSync({ workspaceDir: destination, gitDir: workspaceMutationLeaseGitDir(destination) });
    expect(lease).not.toBeNull();
    try {
      await expect(cloneGithubProjectCheckout(input)).rejects.toThrow("workspace mutation lease unavailable");
      expect(fs.existsSync(destination)).toBe(false);
    } finally { lease?.release(); }
  });

  it("preserves a checkout installed by another operation during the clone", async () => {
    const { destination, input } = seedProjectPlaceholder();
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      if (args?.includes("config")) fs.mkdirSync(path.join(destination, ".git"), { recursive: true });
      return realSpawn(command, args!, options);
    });
    await expect(cloneGithubProjectCheckout(input)).resolves.toBe("exists");
    expect(fs.readFileSync(path.join(destination, "SOUL.md"), "utf8")).toBe("preserve this identity\n");
    expect(fs.readdirSync(path.dirname(destination))).toEqual(["octo"]);
  });

  it("keeps the clone credential in an environment variable for a scoped Git helper", () => {
    expect(githubCloneCredentialEnv("gho_secret")).toEqual({
      OCTOGEE_GITHUB_TOKEN: "gho_secret",
    });
  });

  it("rejects an unsafe destination before attempting a clone", async () => {
    await expect(cloneGithubProjectCheckout({
      usersRoot: "/tmp/customers",
      builderSlug: "../alice",
      projectSlug: "octo",
      repository: { owner: "octogee-ai", repo: "octogee" },
      accessToken: "gho_secret",
    })).rejects.toThrow("invalid GitHub project clone request");
  });

  it("rejects a symlinked customers root before attempting a clone", async () => {
    const { root, input } = seedProjectPlaceholder();
    const alias = path.join(root, "linked-customers");
    fs.symlinkSync(input.usersRoot, alias, "dir");
    await expect(cloneGithubProjectCheckout({ ...input, usersRoot: alias }))
      .rejects.toThrow("GitHub project clone parent is not a directory");
    expect(spawn).not.toHaveBeenCalled();
  });
});
