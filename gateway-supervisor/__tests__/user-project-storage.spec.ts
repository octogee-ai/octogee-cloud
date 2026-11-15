import * as fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareUserProjectStorage } from "../lib/user-project-storage.js";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

let root: string;
let home: string;
let projects: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "user-projects-"));
  home = path.join(root, "home"); projects = path.join(root, "projects");
  await mkdir(path.join(home, ".openclaw/customers/alice/projects/demo"), { recursive: true });
  await mkdir(projects);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const mounted = { assertMount: vi.fn(async () => {}) };
it("copies editable project state to the separate mount and preserves its source until remote save", async () => {
  const source = path.join(home, ".openclaw/customers/alice/projects/demo");
  await writeFile(path.join(source, "unsaved.txt"), "dirty");
  await writeFile(path.join(source, ".env"), "ignored local state");
  await writeFile(path.join(source, ".git"), "gitdir: /home/node/.openclaw/git-metadata/alice/projects/demo.git\n");
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  for (const name of ["unsaved.txt", ".env", ".git"]) expect(await readFile(path.join(projects, "projects/demo", name), "utf8")).toBe(await readFile(path.join(home, ".openclaw/project-imports/alice/demo", name), "utf8"));
  expect(await readdir(path.dirname(source))).toEqual([]);
  await writeFile(path.join(projects, "projects/demo/unsaved.txt"), "newer");
  await mkdir(path.join(projects, "projects/.octogee-state"));
  await writeFile(path.join(projects, "projects/.octogee-state/demo.assets.json"), "materialization state");
  await writeFile(path.join(projects, "projects/.octogee-state/demo.json"), "previous ready marker");
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readFile(path.join(projects, "projects/demo/unsaved.txt"), "utf8")).toBe("newer");
  expect(await readdir(path.join(projects, "projects/.octogee-state"))).toEqual(["demo.assets.json"]);
});
it("invalidates the user fingerprint on boot so cleared project receipts are reconciled", async () => {
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  const marker = path.join(home, ".openclaw/applied-fingerprints.json");
  await writeFile(marker, JSON.stringify({ alice: "matching-snapshot", other: "unchanged" }));
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ other: "unchanged" });
});

it.each([false, true])("removes only empty legacy project placeholders at boot without reimporting them: %s", async (emptyGit) => {
  const source = path.join(home, ".openclaw/customers/alice/projects/demo");
  if (emptyGit) await mkdir(path.join(source, ".git"));
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readdir(path.join(projects, "projects"))).toEqual([]);
  expect(await readdir(path.join(home, ".openclaw/project-imports/alice/demo"))).toEqual(emptyGit ? [".git"] : []);
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readdir(path.join(projects, "projects"))).toEqual([]);
});
it("removes an empty placeholder left in an initialized working set", async () => {
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  const placeholder = path.join(projects, "projects/orphan");
  await mkdir(path.join(placeholder, ".git"), { recursive: true });
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  await expect(readdir(placeholder)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["file", "git-metadata", "asset-state"])("preserves a project containing %s", async (kind) => {
  const source = path.join(home, ".openclaw/customers/alice/projects/demo");
  if (kind === "file") await writeFile(path.join(source, "local.txt"), "keep");
  if (kind === "git-metadata") {
    await mkdir(path.join(source, ".git"));
    await writeFile(path.join(source, ".git/HEAD"), "keep");
  }
  if (kind === "asset-state") {
    const state = path.join(path.dirname(source), ".octogee-state");
    await mkdir(state);
    await writeFile(path.join(state, "demo.assets.json"), "keep");
  }
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect((await fs.lstat(path.join(projects, "projects/demo"))).isDirectory()).toBe(true);
  const location = kind === "file" ? "demo/local.txt" : kind === "git-metadata" ? "demo/.git/HEAD" : ".octogee-state/demo.assets.json";
  expect(await readFile(path.join(projects, "projects", location), "utf8")).toBe("keep");
});
it.each(["project", "git"])("refuses a symlink %s placeholder without touching its target", async (kind) => {
  const source = path.join(home, ".openclaw/customers/alice/projects/demo");
  const target = path.join(root, "foreign");
  await mkdir(target);
  if (kind === "project") { await rm(source, { recursive: true }); await symlink(target, source); }
  else await symlink(target, path.join(source, ".git"));
  await expect(prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted)).rejects.toThrow();
  expect(await readdir(target)).toEqual([]);
  expect((await fs.lstat(path.join(projects, "projects/demo", ...(kind === "git" ? [".git"] : [])))).isSymbolicLink()).toBe(true);
});
it.each([false, true])("preserves a concurrent write and stops boot during empty removal: %s", async (emptyGit) => {
  const source = path.join(home, ".openclaw/customers/alice/projects/demo");
  if (emptyGit) await mkdir(path.join(source, ".git"));
  const rmdir = fs.rmdir;
  const created = path.join(projects, "projects/demo", ...(emptyGit ? [".git"] : []), "concurrent.txt");
  vi.spyOn(fs, "rmdir").mockImplementationOnce(async (...args) => {
    await writeFile(created, "keep concurrent work");
    return rmdir(...args);
  });
  await expect(prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted)).rejects.toMatchObject({ code: "ENOTEMPTY" });
  expect(await readFile(created, "utf8")).toBe("keep concurrent work");
  expect(JSON.parse(await readFile(path.join(projects, ".octogee-storage.json"), "utf8"))).toMatchObject({ status: "preparing" });
});
it("preserves a project replaced by a symlink during empty removal", async () => {
  const location = path.join(projects, "projects/demo");
  const target = path.join(root, "foreign");
  await mkdir(target);
  await writeFile(path.join(target, "foreign.txt"), "keep foreign work");
  const rmdir = fs.rmdir;
  vi.spyOn(fs, "rmdir").mockImplementationOnce(async (...args) => {
    await rename(location, `${location}-retained`);
    await symlink(target, location);
    return rmdir(...args);
  });
  await expect(prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted)).rejects.toThrow();
  expect((await fs.lstat(location)).isSymbolicLink()).toBe(true);
  expect(await readFile(path.join(target, "foreign.txt"), "utf8")).toBe("keep foreign work");
  expect(await readdir(`${location}-retained`)).toEqual([]);
});
it.each([false, true])("recreates writable mount parents when reusing scratch after runtime cleanup: %s", async (keepGeneration) => {
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  await rm(path.join(home, keepGeneration ? ".openclaw/customers" : ".openclaw"), { recursive: true });
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  const user = path.join(home, ".openclaw/customers/alice");
  await mkdir(path.join(user, ".system"));
  expect((await fs.lstat(path.join(user, "projects"))).isDirectory()).toBe(true);
  expect((await fs.lstat(user)).uid).toBe(process.getuid!());
});
it("invalidates a retained working set when the home returns from another project mount", async () => {
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  await mkdir(path.join(projects, "projects/demo"));
  await writeFile(path.join(projects, "projects/demo/unsaved.txt"), "retained Hobby work");
  const native = path.join(root, "native-projects");
  await mkdir(native);
  await prepareUserProjectStorage({ home, projects: native, slug: "alice" }, mounted);
  await mkdir(path.join(native, "projects/demo"));
  await writeFile(path.join(native, "projects/demo/newer.txt"), "native work saved remotely");
  const metadata = path.join(home, ".openclaw/git-metadata/alice/projects");
  await mkdir(metadata, { recursive: true });
  await writeFile(path.join(metadata, "local-commit"), "preserve unpublished commit objects");
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readdir(path.join(projects, "projects"))).toEqual([]);
  await expect(readdir(metadata)).rejects.toMatchObject({ code: "ENOENT" });
  const history = path.join(home, ".openclaw/project-storage-history/alice");
  const [generation] = await readdir(history);
  expect(await readFile(path.join(history, generation, "local-commit"), "utf8")).toBe("preserve unpublished commit objects");
  const retained = await readdir(path.join(projects, ".octogee-retained"));
  expect(retained).toHaveLength(1);
  expect(await readFile(path.join(projects, ".octogee-retained", retained[0], "demo/unsaved.txt"), "utf8")).toBe("retained Hobby work");
  await mkdir(path.join(projects, "projects/demo"));
  await writeFile(path.join(projects, "projects/demo/newer.txt"), "new canonical checkout");
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readFile(path.join(projects, "projects/demo/newer.txt"), "utf8")).toBe("new canonical checkout");
});
it.each([false, true])("resumes an interrupted runtime transition after retaining the old checkout: %s", async (alreadyRetained) => {
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  await mkdir(path.join(projects, "projects/demo"));
  await writeFile(path.join(projects, "projects/demo/local.txt"), "keep");
  const marker = path.join(projects, ".octogee-storage.json");
  const previous = JSON.parse(await readFile(marker, "utf8"));
  await writeFile(marker, JSON.stringify({ ...previous, status: "preparing", generation: randomUUID(), previousGeneration: previous.generation }));
  const retained = path.join(projects, ".octogee-retained", previous.generation);
  if (alreadyRetained) {
    await mkdir(path.dirname(retained));
    await rename(path.join(projects, "projects"), retained);
  }
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readdir(path.join(projects, "projects"))).toEqual([]);
  expect(await readFile(path.join(retained, "demo/local.txt"), "utf8")).toBe("keep");
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readdir(path.dirname(retained))).toEqual([previous.generation]);
});
it("returns to Hobby at the canonical native commit and can push again", async () => {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remote = path.join(root, "remote.git"), seed = path.join(root, "seed");
  git("init", "--bare", "--initial-branch=main", remote);
  git("clone", remote, seed);
  const commit = async (repo: string, text: string) => {
    await writeFile(path.join(repo, "file.txt"), text);
    git("-C", repo, "add", "file.txt");
    git("-C", repo, "-c", "user.name=User", "-c", "user.email=builder@example.test", "commit", "-m", text);
    git("-C", repo, "push", "origin", "main");
  };
  await commit(seed, "Hobby version");
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  const hobby = path.join(projects, "projects/demo");
  git("clone", remote, hobby);
  const native = path.join(root, "native-projects");
  await mkdir(native);
  await prepareUserProjectStorage({ home, projects: native, slug: "alice" }, mounted);
  const nativeRepo = path.join(native, "projects/demo");
  git("clone", remote, nativeRepo);
  await commit(nativeRepo, "Native version");
  const nativeHead = git("-C", nativeRepo, "rev-parse", "HEAD");
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  git("clone", remote, hobby);
  expect(git("-C", hobby, "rev-parse", "HEAD")).toBe(nativeHead);
  expect(await readFile(path.join(hobby, "file.txt"), "utf8")).toBe("Native version");
  await commit(hobby, "Returned Hobby version");
  expect(git("--git-dir", remote, "rev-parse", "main")).toBe(git("-C", hobby, "rev-parse", "HEAD"));
});
it("refuses an unverified existing mount instead of overwriting work", async () => {
  await mkdir(path.join(projects, "demo"));
  await writeFile(path.join(projects, "demo/local.txt"), "keep");
  await expect(prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted)).rejects.toThrow(/uninitialized/);
  expect(await readFile(path.join(projects, "demo/local.txt"), "utf8")).toBe("keep");
});
it("initializes an ext4 project volume while preserving its recovery directory", async () => {
  await mkdir(path.join(projects, "lost+found"));
  await writeFile(path.join(projects, "lost+found/recovered-file"), "filesystem recovery data");
  await prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(JSON.parse(await readFile(path.join(projects, ".octogee-storage.json"), "utf8"))).toMatchObject({ slug: "alice", status: "ready" });
  expect(await readFile(path.join(projects, "lost+found/recovered-file"), "utf8")).toBe("filesystem recovery data");
});
it.each(["file", "symlink"])("refuses a %s masquerading as the filesystem recovery directory", async (kind) => {
  const recovery = path.join(projects, "lost+found");
  if (kind === "file") await writeFile(recovery, "existing work");
  else await symlink(home, recovery);
  await expect(prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted)).rejects.toThrow(/uninitialized/);
  expect(await readdir(projects)).toEqual(["lost+found"]);
});
it("fails before copying if the working set is not separately mounted", async () => {
  await expect(prepareUserProjectStorage({ home, projects, slug: "alice" })).rejects.toThrow(/filesystem/);
  expect(await readdir(projects)).toEqual([]);
});
it("rejects a symlink source root and foreign mount ownership", async () => {
  await rm(path.join(home, ".openclaw/customers/alice/projects"), { recursive: true });
  await symlink(projects, path.join(home, ".openclaw/customers/alice/projects"));
  await expect(prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted)).rejects.toThrow(/directory/);
  await rm(path.join(home, ".openclaw/customers/alice/projects"));
  await writeFile(path.join(projects, ".octogee-storage.json"), JSON.stringify({ version: 1, slug: "bob" }));
  await expect(prepareUserProjectStorage({ home, projects, slug: "alice" }, mounted)).rejects.toThrow(/owner/);
});
