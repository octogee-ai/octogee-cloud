import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ root: `/tmp/octogee-placeholder-transfer-${process.pid}` }));
vi.mock("../lib/config.js", () => ({
  log: vi.fn(), OPENCLAW_DIR: `${paths.root}/source`,
  CUSTOMERS_DIR: `${paths.root}/source/customers`,
}));
const { seedDeferredProjectWorkspace } = await import("../lib/deferred-project-workspace.js");
const { sourceTransferRsyncArgs } = await import("../lib/source-transfer-rsync.js");
const source = `${paths.root}/source`;
const stage = `${paths.root}/stage`;
const target = `${paths.root}/target`;
const relative = "customers/alice/projects/octogee";

function transfer(mode: "pre" | "final", preparedArgs?: string[]) {
  fs.mkdirSync(stage, { recursive: true });
  const args = preparedArgs ?? sourceTransferRsyncArgs(
    [{ cwd: source, path: "customers/alice" }], "/unused/local-transfer-password", stage, mode,
  );
  execFileSync("rsync", [
    "-a", "--relative", ...(mode === "final" ? ["--delete-delay"] : []),
    ...args.filter((arg) => arg.startsWith("--exclude=") || arg.startsWith("--filter=")),
    "customers/alice", `${stage}/`,
  ], { cwd: source });
}

function installStage() {
  fs.mkdirSync(target, { recursive: true });
  execFileSync("rsync", ["-a", `${stage}/`, `${target}/`]);
}

beforeEach(() => { fs.rmSync(paths.root, { recursive: true, force: true }); });
afterEach(() => { fs.rmSync(paths.root, { recursive: true, force: true }); });

describe("deferred project workspace transfer", () => {
  it("deletes a placeholder staged when its project appeared after pre-copy planning", () => {
    fs.mkdirSync(path.join(source, "customers/alice/projects"), { recursive: true });
    const preArgs = sourceTransferRsyncArgs(
      [{ cwd: source, path: "customers/alice" }], "/unused/local-transfer-password", stage, "pre",
    );
    seedDeferredProjectWorkspace("alice", "octogee");
    fs.writeFileSync(path.join(source, relative, "SOUL.md"), "existing project context\n");
    transfer("pre", preArgs);
    expect(fs.lstatSync(path.join(stage, relative, "AGENTS.md")).isFile()).toBe(true);
    installStage();
    const project = path.join(target, relative);
    fs.rmSync(path.join(project, "AGENTS.md"));
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "canonical project instructions\n");
    fs.symlinkSync("CLAUDE.md", path.join(project, "AGENTS.md"));

    transfer("final");
    installStage();

    expect(fs.existsSync(path.join(stage, relative, "AGENTS.md"))).toBe(false);
    expect(fs.lstatSync(path.join(project, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(project, "AGENTS.md"))).toBe("CLAUDE.md");
    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("canonical project instructions\n");
    expect(fs.readFileSync(path.join(project, "SOUL.md"), "utf8")).toBe("existing project context\n");
    expect(fs.existsSync(path.join(source, relative, "AGENTS.md"))).toBe(true);
  });

  it("keeps the prepared canonical AGENTS symlink through the final Shared placeholder transfer", () => {
    seedDeferredProjectWorkspace("alice", "octogee");
    for (const name of ["SOUL.md", "USER.md", "IDENTITY.md"]) {
      fs.writeFileSync(path.join(source, relative, name), `existing ${name}\n`);
    }
    transfer("pre");
    installStage();
    const project = path.join(target, relative);
    fs.rmSync(path.join(project, "AGENTS.md"), { force: true });
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "canonical project instructions\n");
    fs.symlinkSync("CLAUDE.md", path.join(project, "AGENTS.md"));
    execFileSync("git", ["init", "-q", project]);
    execFileSync("git", ["-C", project, "add", "AGENTS.md", "CLAUDE.md"]);
    execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@octogee.test", "commit", "-qm", "canonical checkout"]);

    transfer("final");
    installStage();

    expect(fs.lstatSync(path.join(project, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(project, "AGENTS.md"))).toBe("CLAUDE.md");
    expect(fs.readFileSync(path.join(project, "CLAUDE.md"), "utf8")).toBe("canonical project instructions\n");
    expect(execFileSync("git", ["-C", project, "diff", "--name-only"], { encoding: "utf8" })).toBe("");
    for (const name of ["SOUL.md", "USER.md", "IDENTITY.md"]) {
      expect(fs.readFileSync(path.join(project, name), "utf8")).toBe(`existing ${name}\n`);
    }
    expect(fs.existsSync(path.join(source, relative, "AGENTS.md"))).toBe(true);
  });

  it("transfers authored AGENTS instructions instead of treating all project context as disposable", () => {
    seedDeferredProjectWorkspace("alice", "octogee");
    fs.appendFileSync(path.join(source, relative, "AGENTS.md"), "User authored instructions.\n");

    transfer("final");
    installStage();

    expect(fs.readFileSync(path.join(target, relative, "AGENTS.md"), "utf8"))
      .toBe(fs.readFileSync(path.join(source, relative, "AGENTS.md"), "utf8"));
  });
});

describe("user Git metadata transfer", () => {
  it.each([
    ["customers/alice", "git-metadata/alice/workspace.git"],
    ["customers/alice/projects/octogee", "git-metadata/alice/projects/octogee.git"],
  ])("omits transient locks from %s while retaining staged Git state", (worktreeRelative, metadataRelative) => {
    const worktree = path.join(source, worktreeRelative);
    const metadata = path.join(source, metadataRelative);
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(path.dirname(metadata), { recursive: true });
    execFileSync("git", ["init", "-q", "--initial-branch=main", `--separate-git-dir=${metadata}`, worktree]);
    fs.writeFileSync(path.join(worktree, "notes.md"), "committed\n");
    execFileSync("git", ["-C", worktree, "add", "notes.md"]);
    execFileSync("git", ["-C", worktree, "-c", "user.name=Test", "-c", "user.email=test@octogee.test", "commit", "-qm", "baseline"]);
    fs.writeFileSync(path.join(worktree, "notes.md"), "staged\n");
    execFileSync("git", ["-C", worktree, "add", "notes.md"]);
    fs.writeFileSync(path.join(worktree, "notes.md"), "unstaged\n");
    fs.writeFileSync(path.join(worktree, "package.lock"), "user lock\n");
    const locks = ["index.lock", "config.lock", "packed-refs.lock", "refs/heads/main.lock"];
    for (const lock of locks) fs.writeFileSync(path.join(metadata, lock), "Git transaction\n");
    const index = fs.readFileSync(path.join(metadata, "index"));
    const head = fs.readFileSync(path.join(metadata, "refs/heads/main"));
    const staged = execFileSync("git", [`--git-dir=${metadata}`, "ls-files", "--stage"], { encoding: "utf8" });
    const sources = [
      { cwd: source, path: "customers/alice" },
      { cwd: source, path: "git-metadata/alice" },
    ];
    const copy = (mode: "pre" | "final") => {
      fs.mkdirSync(stage, { recursive: true });
      const args = sourceTransferRsyncArgs(sources, "/unused/local-transfer-password", stage, mode);
      execFileSync("rsync", [
        "-a", "--relative", ...(mode === "final" ? ["--delete-delay"] : []),
        ...args.filter(arg => arg.startsWith("--exclude=") || arg.startsWith("--filter=")),
        ...sources.map(entry => entry.path), `${stage}/`,
      ], { cwd: source });
    };

    copy("pre");
    for (const lock of locks) expect(fs.existsSync(path.join(stage, metadataRelative, lock))).toBe(false);
    fs.writeFileSync(path.join(stage, metadataRelative, "index.lock"), "previously staged lock\n");
    fs.rmSync(path.join(metadata, "index.lock"));
    copy("final");
    installStage();

    const imported = path.join(target, metadataRelative);
    for (const lock of locks) expect(fs.existsSync(path.join(imported, lock))).toBe(false);
    expect(fs.readFileSync(path.join(imported, "index"))).toEqual(index);
    expect(fs.readFileSync(path.join(imported, "refs/heads/main"))).toEqual(head);
    expect(execFileSync("git", [`--git-dir=${imported}`, "ls-files", "--stage"], { encoding: "utf8" })).toBe(staged);
    expect(execFileSync("git", [`--git-dir=${imported}`, "show", ":notes.md"], { encoding: "utf8" })).toBe("staged\n");
    expect(fs.readFileSync(path.join(target, worktreeRelative, "notes.md"), "utf8")).toBe("unstaged\n");
    expect(fs.readFileSync(path.join(target, worktreeRelative, "package.lock"), "utf8")).toBe("user lock\n");
    expect(fs.existsSync(path.join(metadata, "refs/heads/main.lock"))).toBe(true);
  });
});
