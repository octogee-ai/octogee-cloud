import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, rename, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { captureAgentExport } from "./agent-export-snapshot.js";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "authored-export-")); directories.push(root);
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "SOUL.md"), "unpublished persona");
  const contents = Buffer.from([0, 1, 2, 3]);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const manifest = { "portrait.png": { type: "blob" as const, gcsPath: `customers/alice/.objects/${sha256}`, sha256, size: 4, mimeType: "image/png", uploadedAt: "2026-10-23T00:00:00Z" } };
  return { root, contents, manifest, deps: { defaultAgentWorkspace: true, assertCurrent: vi.fn(async () => {}), readAssets: vi.fn(async () => ({ manifest, deleted: [] as string[] })), readBlob: vi.fn(async () => contents), scan: vi.fn(async () => []) } };
}
describe.skipIf(process.platform !== "linux")("authored agent capture", () => {
  it("captures unpublished instructions and manifest-only shared gateway binary bytes, without publishing metadata", async () => {
    const f = await fixture(); await mkdir(join(f.root, ".files")); await writeFile(join(f.root, ".files/manifest.json"), JSON.stringify(f.manifest));
    const captured = await captureAgentExport(f.root, f.deps);
    expect(captured.files.map(file => file.path)).toEqual(["SOUL.md", "portrait.png"]);
    expect(Buffer.from(captured.files[1].content, "base64")).toEqual(f.contents);
    expect(f.deps.scan).toHaveBeenCalledOnce();
  });
  it.each([true, false])("keeps authored projects paths and isolates only defaultAgent siblings (defaultAgent=%s)", async defaultAgentWorkspace => {
    const f = await fixture();
    for (const name of ["src/projects/list.ts", "projects/local.ts"]) {
      await mkdir(join(f.root, name, ".."), { recursive: true });
      await writeFile(join(f.root, name), "authored code");
    }
    const result = await captureAgentExport(f.root, { ...f.deps, defaultAgentWorkspace });
    const names = result.files.map(file => file.path);
    expect(names).toContain("src/projects/list.ts");
    expect(names.includes("projects/local.ts")).toBe(!defaultAgentWorkspace);
  });
  it("preserves authored executable mode while GCS-only binaries remain ordinary files", async () => {
    const f = await fixture(); await writeFile(join(f.root, "run.sh"), "#!/bin/sh\necho authored\n"); await chmod(join(f.root, "run.sh"), 0o755);
    const result = await captureAgentExport(f.root, f.deps);
    expect(result.files.find(file => file.path === "run.sh")?.mode).toBe("100755");
    expect(result.files.find(file => file.path === "portrait.png")?.mode).toBe("100644");
  });
  it("uses unpublished local binary edits and preserves materialized deletion intent", async () => {
    const f = await fixture(); await writeFile(join(f.root, "portrait.png"), "new authored bytes");
    let result = await captureAgentExport(f.root, f.deps);
    expect(Buffer.from(result.files[1].content, "base64").toString()).toBe("new authored bytes");
    await rm(join(f.root, "portrait.png")); f.deps.readAssets.mockResolvedValue({ manifest: f.manifest, deleted: ["portrait.png"] });
    result = await captureAgentExport(f.root, f.deps);
    expect(result.files.map(file => file.path)).toEqual(["SOUL.md"]);
    expect(f.deps.readBlob).not.toHaveBeenCalled();
  });
  it("excludes credentials, databases, platform state, and sibling project workspaces", async () => {
    const f = await fixture();
    for (const name of [".env", "state.sqlite-wal", "openclaw.json", "projects/other/SOUL.md", ".octogee-state/a.json"]) {
      await mkdir(join(f.root, name, ".."), { recursive: true }); await writeFile(join(f.root, name), "private");
    }
    const result = await captureAgentExport(f.root, f.deps);
    expect(result.files.map(file => file.path)).toEqual(["SOUL.md", "portrait.png"]);
  });
  it("refuses symlinks, corrupt blob bytes, and scanner findings", async () => {
    const f = await fixture(); await symlink("SOUL.md", join(f.root, "alias.md"));
    await expect(captureAgentExport(f.root, f.deps)).rejects.toThrow(/regular|symlink/);
    await rm(join(f.root, "alias.md")); f.deps.readBlob.mockResolvedValue(Buffer.from("bad"));
    await expect(captureAgentExport(f.root, f.deps)).rejects.toThrow(/identity/);
    f.deps.readBlob.mockResolvedValue(f.contents); f.deps.scan.mockResolvedValue([{}] as never[]);
    await expect(captureAgentExport(f.root, f.deps)).rejects.toThrow(/secret/);
  });
  it("refuses a parent symlink swap after source authorization instead of capturing another workspace", async () => {
    const f = await fixture();
    const owned = join(f.root, "owned"), other = join(f.root, "other"), held = join(f.root, "held");
    for (const directory of [owned, other]) {
      await mkdir(join(directory, "workspace/.git"), { recursive: true });
      await writeFile(join(directory, "workspace/SOUL.md"), directory === owned ? "owned" : "foreign private persona");
    }
    let swapped = false;
    f.deps.assertCurrent.mockImplementation(async () => {
      if (!swapped) { await rename(owned, held); await symlink(other, owned); swapped = true; }
    });
    f.deps.readAssets.mockResolvedValue({ manifest: {} as typeof f.manifest, deleted: [] });
    await expect(captureAgentExport(join(owned, "workspace"), f.deps)).rejects.toThrow();
    expect(f.deps.scan).not.toHaveBeenCalled();
  });
  it("rejects source contents or authority changing during capture", async () => {
    const f = await fixture();
    f.deps.scan.mockImplementation(async () => { await writeFile(join(f.root, "SOUL.md"), "changed"); return []; });
    await expect(captureAgentExport(f.root, f.deps)).rejects.toThrow(/changed/);
    f.deps.assertCurrent.mockRejectedValue(new Error("assignment changed"));
    await expect(captureAgentExport(f.root, f.deps)).rejects.toThrow("assignment changed");
  });
});
