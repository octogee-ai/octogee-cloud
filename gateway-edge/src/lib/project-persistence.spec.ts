import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistUserProjects } from "./project-persistence.js";
import { writeProjectRestoreReady } from "@octogee/core/project-asset-state";
import type { FleetBrokerProjectRestore } from "@octogee/shared/types/fleet-broker";

vi.mock("@octogee/core/connectors/connector-tokens", () => ({ readOwnerRuntimeConnectorAccessToken: vi.fn() }));

let root: string;
function deps() {
  return { readUser: vi.fn(async (slug: string) => ({ uid: `uid-${slug}`, slug, gatewayId: "builder-one", status: "complete" as const,
      checkpointEpoch: 1, projects: [{ projectSlug: "demo", giteaRepoName: "demo", provisioningState: "active" }] as FleetBrokerProjectRestore[] })),
    resolveProject: vi.fn(async (_root, slug, project): Promise<string | null> => path.join(root, slug, "projects", project)),
    githubToken: vi.fn(async () => undefined),
    prepare: vi.fn(async () => undefined),
    divert: vi.fn(async () => ({ failures: [] as string[], failedPaths: [] as string[], diverted: [] })),
    commit: vi.fn(async (_dir, options) => {
      const prepared = await options.beforeCommit();
      return prepared.ok ? { ok: true, result: { pushed: true } } : prepared;
    }) };
}
describe.skipIf(process.platform !== "linux")("User project persistence", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "projects-save-"));
    await mkdir(path.join(root, "builder", "projects", "demo"), { recursive: true });
    await writeProjectRestoreReady(path.join(root, "builder/projects/demo"), "builder", "demo");
  });
  afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });

  it.each(["gitea", "github"])("does not restore, save or commit a disabled %s checkout recreated by Native agent bootstrap", async provider => {
    const disabled = path.join(root, "builder/projects/octogee");
    await mkdir(path.join(disabled, ".git"), { recursive: true });
    await writeFile(path.join(disabled, "AGENTS.md"), "Native bootstrap files are not a checkout\n");
    const d = deps();
    const user = await d.readUser("builder");
    user.projects.push({ projectSlug: "octogee", giteaRepoName: provider === "gitea" ? "octogee" : null, checkoutEnabled: false,
      ...(provider === "github" ? { repoSource: { provider: "github", owner: "builder", repo: "octogee" } as const } : {}) });
    d.readUser.mockResolvedValue(user);
    await expect(persistUserProjects({ root, slug: "builder" }, d)).resolves.toEqual({ projects: 1 });
    expect(d.resolveProject.mock.calls.map(call => call[2])).toEqual(["demo"]);
    expect(d.commit).toHaveBeenCalledTimes(1);
    expect(d.prepare).not.toHaveBeenCalled();
  });

  it("ignores orphaned agent workspaces but refuses a missing enabled project", async () => {
    await rename(path.join(root, "builder/projects/demo"), path.join(root, "builder/projects/orphan"));
    const d = deps();
    d.resolveProject.mockResolvedValue(null);
    await expect(persistUserProjects({ root, slug: "builder" }, d)).rejects.toThrow(/ENOENT|repository/);
    expect(d.commit).not.toHaveBeenCalled();
  });

  it("does not fall back to directories when checkout policy is unavailable", async () => {
    const d = deps();
    d.readUser.mockRejectedValue(new Error("fleet broker unavailable"));
    await expect(persistUserProjects({ root, slug: "builder" }, d)).rejects.toThrow(/fleet broker unavailable/);
    expect(d.resolveProject).not.toHaveBeenCalled();
    expect(d.commit).not.toHaveBeenCalled();
  });

  it("requires restoration again after checkout is re-enabled", async () => {
    const d = deps();
    const user = await d.readUser("builder");
    user.projects[0].checkoutEnabled = false;
    d.readUser.mockImplementation(async () => structuredClone(user));
    await rm(path.join(root, "builder/projects/.octogee-state/demo.json"));
    await expect(persistUserProjects({ root, slug: "builder" }, d)).resolves.toEqual({ projects: 0 });
    expect(d.commit).not.toHaveBeenCalled();
    user.projects[0].checkoutEnabled = true;
    await expect(persistUserProjects({ root, slug: "builder" }, d)).rejects.toThrow(/restore/);
    await writeProjectRestoreReady(path.join(root, "builder/projects/demo"), "builder", "demo");
    await expect(persistUserProjects({ root, slug: "builder" }, d)).resolves.toEqual({ projects: 1 });
    expect(d.commit).toHaveBeenCalledTimes(1);
  });

  it("rechecks checkout authority before committing when the owner turns it off", async () => {
    const d = deps();
    const user = await d.readUser("builder");
    d.readUser.mockImplementation(async () => structuredClone(user));
    d.commit.mockImplementation(async (_dir, options) => {
      user.projects[0].checkoutEnabled = false;
      const prepared = await options.beforeCommit();
      return prepared.ok ? { ok: true, result: { pushed: true } } : prepared;
    });
    await expect(persistUserProjects({ root, slug: "builder" }, d)).rejects.toThrow(/authority changed/);
    expect(d.divert).not.toHaveBeenCalled();
  });

  it("serializes lifecycle flush behind autosave and performs its own fresh save", async () => {
    const d = deps();
    let release!: () => void;
    let started!: () => void;
    let holding = true;
    let calls = 0;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    d.commit.mockImplementation(async (dir, options) => {
      if (++calls === 1) { started(); await blocked; }
      else if (holding) return { ok: false, error: { code: "WORKSPACE_BUSY", cwd: dir } };
      const prepared = await options.beforeCommit();
      return prepared.ok ? { ok: true, result: { pushed: true } } : prepared;
    });
    const autosave = persistUserProjects({ root, slug: "builder" }, d);
    await entered;
    await mkdir(path.join(root, "builder/projects/later"));
    await writeProjectRestoreReady(path.join(root, "builder/projects/later"), "builder", "later");
    d.readUser.mockImplementation(async slug => ({ uid: `uid-${slug}`, slug, gatewayId: "builder-one", status: "complete", checkpointEpoch: 1,
      projects: ["demo", "later"].map(project => ({ projectSlug: project, giteaRepoName: project, provisioningState: "active" })) }));
    const lifecycle = persistUserProjects({ root, slug: "builder" }, d);
    const timer = setTimeout(() => { holding = false; release(); }, 500);
    try { await expect(lifecycle).resolves.toEqual({ projects: 2 }); }
    finally { clearTimeout(timer); holding = false; release(); }
    await expect(autosave).resolves.toEqual({ projects: 1 });
    expect(d.commit).toHaveBeenCalledTimes(3);
  });

  it("times out a queued save without letting its successor pass the still-active writer", async () => {
    const d = deps();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    d.commit.mockImplementationOnce(async () => { started(); await blocked; return { ok: true, result: { pushed: true } }; });
    const autosave = persistUserProjects({ root, slug: "builder" }, d);
    await entered;
    vi.useFakeTimers();
    const lifecycle = persistUserProjects({ root, slug: "builder" }, d);
    const rejected = expect(lifecycle).rejects.toThrow(/persistence.*busy|queue.*timeout/iu);
    await vi.advanceTimersByTimeAsync(30_000);
    const successor = persistUserProjects({ root, slug: "builder" }, d);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(d.commit).toHaveBeenCalledTimes(1);
    release();
    await autosave;
    await expect(successor).resolves.toEqual({ projects: 1 });
    expect(d.commit).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    await expect(persistUserProjects({ root, slug: "builder" }, d)).resolves.toEqual({ projects: 1 });
    expect(d.commit).toHaveBeenCalledTimes(3);
  });

  it("lets the next queued save proceed after a predecessor's remote failure", async () => {
    const d = deps();
    d.commit.mockResolvedValueOnce({ ok: true, result: { pushed: false, pushError: "remote unavailable" } });
    const first = persistUserProjects({ root, slug: "builder" }, d);
    const second = persistUserProjects({ root, slug: "builder" }, d);
    await expect(first).rejects.toThrow(/remote unavailable/u);
    await expect(second).resolves.toEqual({ projects: 1 });
    expect(d.commit).toHaveBeenCalledTimes(2);
  });

  it("does not serialize independent user owners behind a blocked save", async () => {
    const d = deps();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    d.commit.mockImplementationOnce(async () => { started(); await blocked; return { ok: true, result: { pushed: true } }; });
    const first = persistUserProjects({ root, slug: "builder" }, d);
    await entered;
    await mkdir(path.join(root, "other/projects/demo"), { recursive: true });
    await writeProjectRestoreReady(path.join(root, "other/projects/demo"), "other", "demo");
    try {
      await expect(persistUserProjects({ root, slug: "other" }, d)).resolves.toEqual({ projects: 1 });
    } finally { release(); }
    await first;
  });

  it("does not retry or acknowledge a lease held by another project mutation", async () => {
    const d = deps();
    d.commit.mockResolvedValueOnce({ ok: false, error: { code: "WORKSPACE_BUSY", cwd: path.join(root, "builder/projects/demo") } });
    await expect(persistUserProjects({ root, slug: "builder" }, d)).rejects.toThrow(/WORKSPACE_BUSY/u);
    expect(d.commit).toHaveBeenCalledTimes(1);
    expect(d.divert).not.toHaveBeenCalled();
  });
  it("does not save a replacement checkout before its own restoration completes", async () => {
    const dir = path.join(root, "builder/projects/demo");
    await rename(dir, path.join(root, "retained-demo"));
    await mkdir(dir);
    const d = deps();
    await expect(persistUserProjects({ root, slug: "builder" }, d)).rejects.toThrow(/restore/);
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.prepare).not.toHaveBeenCalled();
    await writeProjectRestoreReady(dir, "builder", "demo");
    await expect(persistUserProjects({ root, slug: "builder" }, d)).resolves.toEqual({ projects: 1 });
  });
  it("refuses to save until project restoration has completed", async () => {
    await rm(path.join(root, "builder/projects/.octogee-state/demo.json"));
    const d = deps();
    await expect(persistUserProjects({ root, slug: "builder" }, d)).rejects.toThrow();
    expect(d.commit).not.toHaveBeenCalled();
    expect(d.prepare).not.toHaveBeenCalled();
  });
  it("uses the leased commit path and waits for remote binary storage before committing", async () => {
    const d = deps();
    expect(await persistUserProjects({ root, slug: "builder" }, d)).toEqual({ projects: 1 });
    expect(d.divert).toHaveBeenCalledWith(path.join(root, "builder/projects/demo"), { slug: "builder", projectSlug: "demo", gcsPrefix: "customers/builder/projects/demo" });
    expect(d.commit.mock.calls[0][1].message).toBe("autosave: project changes");
  });
  it("does not acknowledge a local commit whose remote push failed", async () => {
    const d = deps();
    d.commit.mockResolvedValue({ ok: true, result: { pushed: false, pushError: "remote unavailable" } });
    await expect(persistUserProjects({ root, slug: "builder" }, d)).rejects.toThrow(/remote/);
    d.commit.mockResolvedValue({ ok: true, result: { pushed: true } });
    await expect(persistUserProjects({ root, slug: "builder" }, d)).resolves.toEqual({ projects: 1 });
    expect(d.commit).toHaveBeenCalledTimes(2);
  });
  it("fails on binary save failure without creating a commit", async () => {
    const d = deps();
    d.divert.mockResolvedValue({ failures: ["offline"], failedPaths: ["asset.png"], diverted: [] });
    await expect(persistUserProjects({ root, slug: "builder" }, d)).rejects.toThrow(/BLOB_DIVERSION_FAILED/);
  });
  it("refuses missing repositories and symlinks instead of claiming they are backed up", async () => {
    const d = deps();
    d.resolveProject.mockResolvedValue(null);
    await expect(persistUserProjects({ root, slug: "builder" }, d)).rejects.toThrow(/repository/);
    await rename(path.join(root, "builder/projects/demo"), path.join(root, "retained-demo"));
    await symlink(path.join(root, "retained-demo"), path.join(root, "builder/projects/demo"));
    await expect(persistUserProjects({ root, slug: "builder" }, deps())).rejects.toThrow(/directory/);
  });
});
