import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProjectRestoreReady, writeProjectRestoreReady } from "@octogee/core/project-asset-state";
import { acquireWorkspaceMutationLeaseSync, projectMutationLeaseGitDir } from "@octogee/core/workspace-mutation-lease";
import { createBrokeredProjectBlobHydrator } from "../lib/project-blob-materialization.js";
import { prepareUserProjectAssets } from "../lib/user-project-assets.js";

const storageRoots = vi.hoisted(() => ({ users: "" }));
vi.mock("../lib/config.js", () => ({ get CUSTOMERS_DIR() { return storageRoots.users; } }));
let parent: string;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (parent) await fs.rm(parent, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("User project restore publication", () => {
  it.each(["missing", "replaced", "unowned"])("refuses source preparation of a %s checkout under its lease", async state => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "user-source-ready-"));
    storageRoots.users = path.join(parent, "customers");
    const projects = path.join(storageRoots.users, "owner/projects"), destination = path.join(projects, "app");
    await fs.mkdir(destination, { recursive: true });
    await writeProjectRestoreReady(destination, "owner", "app");
    if (state === "missing") await fs.rm(path.join(projects, ".octogee-state/app.json"));
    else if (state === "replaced") { await fs.rename(destination, `${destination}-retained`); await fs.mkdir(destination); }
    else await writeProjectRestoreReady(destination, "another", "app");
    const read = vi.fn();
    const hydrate = createBrokeredProjectBlobHydrator({ workspaceManifestReadUrl: read, blobMaterializationReadUrl: vi.fn() });
    await expect(prepareUserProjectAssets({ projects, slug: "owner", project: "app", hydrate, requireRestoredCheckout: true })).rejects.toThrow(/previously restored checkout|owner differs/);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not mark a replacement checkout ready after the hydrated checkout releases its lease", async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "user-project-ready-"));
    storageRoots.users = path.join(parent, "customers");
    const projects = path.join(storageRoots.users, "owner/projects");
    const destination = path.join(projects, "app");
    await fs.mkdir(destination, { recursive: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const hydrate = createBrokeredProjectBlobHydrator({
      workspaceManifestReadUrl: vi.fn(async () => ({ url: "https://signed.test/manifest", method: "GET" as const, gcsPath: "manifest", expiresAt: "later" })),
      blobMaterializationReadUrl: vi.fn(),
    });
    await prepareUserProjectAssets({ projects, slug: "owner", project: "app", hydrate: async input => {
      const result = await hydrate(input);
      expect(await readProjectRestoreReady(destination, "owner", "app")).toBe(true);
      const lease = acquireWorkspaceMutationLeaseSync({ workspaceDir: destination, gitDir: projectMutationLeaseGitDir(destination, storageRoots.users)! });
      expect(lease).not.toBeNull();
      try {
        await fs.rename(destination, `${destination}-retained`);
        await fs.mkdir(destination);
      } finally { lease!.release(); }
      return result;
    } });
    expect(await readProjectRestoreReady(destination, "owner", "app")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await expect(prepareUserProjectAssets({ projects, slug: "owner", project: "app", hydrate })).rejects.toThrow(/manifest failed/);
    expect(await readProjectRestoreReady(destination, "owner", "app")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await prepareUserProjectAssets({ projects, slug: "owner", project: "app", hydrate });
    expect(await readProjectRestoreReady(destination, "owner", "app")).toBe(true);
  });
});
