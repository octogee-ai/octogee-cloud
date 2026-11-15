import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({
  home: `/tmp/octogee-git-home-${process.pid}`,
  projects: `${process.platform === "linux" ? "/dev/shm" : "/tmp"}/octogee-git-projects-${process.pid}`,
}));
vi.mock("../lib/config.js", () => ({
  log: vi.fn(), dlog: vi.fn(), GIT_API_URL: "https://gitea.test/api/v1", GIT_SSH_HOST: "gitea.test",
  OPENCLAW_DIR: paths.home, CUSTOMERS_DIR: paths.projects,
  CUSTOMER_KEYS_DIR: `${paths.home}/keys`, AGENTS_DIR: `${paths.home}/agents`,
}));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, cpSync: vi.fn(actual.cpSync), statSync: vi.fn(actual.statSync) };
});
const { externalizeUserGitDir } = await import("../lib/git.js");

afterEach(() => {
  fs.rmSync(paths.home, { recursive: true, force: true });
  fs.rmSync(paths.projects, { recursive: true, force: true });
});

it.skipIf(process.platform !== "linux")("quarantines project Git metadata across mounts without following its links or losing working files", () => {
  const repo = path.join(paths.projects, "alice", "projects", "sample");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(paths.home, { recursive: true });
  expect(fs.statSync(repo).dev).not.toBe(fs.statSync(paths.home).dev);
  execFileSync("/usr/bin/git", ["init", "--initial-branch=main", repo], { stdio: "pipe" });
  const originalHead = fs.readFileSync(path.join(repo, ".git/HEAD"));
  const outside = path.join(paths.home, "outside.txt");
  fs.writeFileSync(outside, "must remain outside\n");
  fs.symlinkSync(outside, path.join(repo, ".git/untrusted-link"));
  fs.writeFileSync(path.join(repo, "unpublished.txt"), "unpublished project work\n");

  const metadata = externalizeUserGitDir(repo, { fetchCanonical: () => {} });

  expect(metadata).toBe(path.join(paths.home, "git-metadata/alice/projects/sample.git"));
  expect(fs.readFileSync(path.join(repo, "unpublished.txt"), "utf8")).toBe("unpublished project work\n");
  expect(fs.readFileSync(path.join(repo, ".git"), "utf8")).toBe(`gitdir: ${metadata}\n`);
  const quarantine = path.join(paths.home, "git-metadata-quarantine/alice");
  const entries = fs.readdirSync(quarantine);
  expect(entries).toHaveLength(1);
  const retained = path.join(quarantine, entries[0]);
  expect(fs.readFileSync(path.join(retained, "HEAD"))).toEqual(originalHead);
  expect(fs.lstatSync(path.join(retained, "untrusted-link")).isSymbolicLink()).toBe(true);
  expect(fs.readlinkSync(path.join(retained, "untrusted-link"))).toBe(outside);
  expect(fs.readFileSync(outside, "utf8")).toBe("must remain outside\n");
});

it("removes a partial cross-mount quarantine while keeping original metadata after copy failure", () => {
  const repo = path.join(paths.projects, "alice", "projects", "sample");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(paths.home, { recursive: true });
  execFileSync("/usr/bin/git", ["init", "--initial-branch=main", repo], { stdio: "pipe" });
  const originalHead = fs.readFileSync(path.join(repo, ".git/HEAD"));
  fs.writeFileSync(path.join(repo, "unpublished.txt"), "keep this work\n");
  const quarantine = path.join(paths.home, "git-metadata-quarantine/alice");
  if (process.platform !== "linux") {
    const actual = vi.mocked(fs.statSync).getMockImplementation()!;
    vi.mocked(fs.statSync).mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      const value = actual(...args);
      if (String(args[0]) === quarantine) Object.assign(value, { dev: Number(value.dev) + 1 });
      return value;
    }) as typeof fs.statSync);
  }
  vi.mocked(fs.cpSync).mockImplementationOnce((_source, target) => {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(String(target), "partial-copy"), "partial data");
    throw Object.assign(new Error("quarantine volume is full"), { code: "ENOSPC" });
  });

  expect(() => externalizeUserGitDir(repo, { fetchCanonical: () => {} })).toThrow("quarantine volume is full");

  expect(fs.readFileSync(path.join(repo, ".git/HEAD"))).toEqual(originalHead);
  expect(fs.readFileSync(path.join(repo, "unpublished.txt"), "utf8")).toBe("keep this work\n");
  expect(fs.readdirSync(quarantine)).toEqual([]);
});
