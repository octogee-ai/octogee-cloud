import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProjectRestoreReady, withMaterializedProjectAssets } from "@octogee/core/project-asset-state";
import { createBrokeredProjectBlobHydrator } from "../lib/project-blob-materialization.js";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";

const storageRoots = vi.hoisted(() => ({ users: "" }));
vi.mock("../lib/config.js", () => ({ get CUSTOMERS_DIR() { return storageRoots.users; } }));
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); storageRoots.users = ""; await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "project-blobs-")); roots.push(parent);
  const root = path.join(parent, "app"); await fs.mkdir(root); await fs.mkdir(path.join(root, ".git"));
  const body = Buffer.from("abc");
  const manifest = { "images/a.png": { type: "blob", gcsPath: "customers/owner/projects/app/images/a.png", size: body.length, mimeType: "image/png", uploadedAt: "2026-10-07T00:00:00Z" } };
  const md5Hash = "kAFQmDzST7DWlj99KOF/cg==";
  const client = { workspaceManifestReadUrl: vi.fn(async () => ({ url: "https://signed.test/manifest", method: "GET" })),
    blobMaterializationReadUrl: vi.fn(async () => ({ generation: "17", size: body.length, md5Hash: md5Hash,
      download: { url: "https://signed.test/blob?generation=17", method: "GET", gcsPath: manifest["images/a.png"].gcsPath } })) } as unknown as FleetBrokerClient;
  const fetchMock = vi.fn(async (url: string) => url.includes("manifest")
    ? new Response(JSON.stringify(manifest), { headers: { "x-goog-generation": "23" } })
    : new Response(body, { headers: { "x-goog-generation": "17" } }));
  vi.stubGlobal("fetch", fetchMock);
  return { root, body, manifest, client, fetchMock, hydrate: createBrokeredProjectBlobHydrator(client) };
}

describe("verified GCS project cache hydration", () => {
  it("defers assets outside the working set budget and restores a selected asset on demand", async () => {
    const h = await fixture();
    expect(await h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 2, allowDeferred: true })).toMatchObject({ files: 0, bytes: 0, deferred: 1 });
    expect(h.client.blobMaterializationReadUrl).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(path.join(h.root, ".files/manifest.json"), "utf8"))).toEqual(h.manifest);
    expect(await h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8, paths: ["images/a.png"] })).toMatchObject({ files: 1 });
    await expect(h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8, paths: ["../escape"] })).rejects.toThrow(/manifest/);
  });
  it("restores the committed asset revision and retains existing local edits", async () => {
    const h = await fixture();
    const sha256 = createHash("sha256").update(h.body).digest("hex");
    const entry = { ...h.manifest["images/a.png"], sha256, gcsPath: `customers/owner/projects/app/.objects/${sha256}` };
    await fs.mkdir(path.join(h.root, ".files"));
    await fs.writeFile(path.join(h.root, ".files/manifest.json"), JSON.stringify({ "images/a.png": entry }));
    vi.mocked(h.client.blobMaterializationReadUrl).mockResolvedValue({ generation: "17", size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==", download: { url: "https://signed.test/blob", method: "GET", gcsPath: entry.gcsPath, expiresAt: "later" } });
    await h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8, preserveExisting: true });
    expect(h.client.workspaceManifestReadUrl).not.toHaveBeenCalled();
    expect(h.client.blobMaterializationReadUrl).toHaveBeenCalledWith({ slug: "owner", path: "projects/app/images/a.png", size: 3, sha256 });
    expect(await fs.readFile(path.join(h.root, "images/a.png"), "utf8")).toBe("abc");
    await fs.writeFile(path.join(h.root, "images/a.png"), "local edits");
    expect(await h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8, preserveExisting: true })).toMatchObject({ files: 0, bytes: 0 });
    expect(await fs.readFile(path.join(h.root, "images/a.png"), "utf8")).toBe("local edits");
  });
  it.each(["authored edits", "checksum failure"])("retains prior bytes without readiness after a remote version encounters %s", async failure => {
    const h = await fixture();
    const sha256 = createHash("sha256").update(h.body).digest("hex");
    const entry = { ...h.manifest["images/a.png"], sha256, gcsPath: `customers/owner/projects/app/.objects/${sha256}` };
    await fs.mkdir(path.join(h.root, ".files"));
    await fs.writeFile(path.join(h.root, ".files/manifest.json"), JSON.stringify({ "images/a.png": entry }));
    vi.mocked(h.client.blobMaterializationReadUrl).mockResolvedValue({ generation: "17", size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==", download: { url: "https://signed.test/blob", method: "GET", gcsPath: entry.gcsPath, expiresAt: "later" } });
    const input = { slug: "owner", project: "app", destination: h.root, maxBytes: 8, preserveExisting: true, markRestoreReady: true };
    await h.hydrate(input);
    if (failure === "authored edits") await fs.writeFile(path.join(h.root, "images/a.png"), "authored local work");
    const remoteHash = createHash("sha256").update("xyz").digest("hex");
    await fs.writeFile(path.join(h.root, ".files/manifest.json"), JSON.stringify({ "images/a.png": { ...entry, sha256: remoteHash, gcsPath: `customers/owner/projects/app/.objects/${remoteHash}`, uploadedAt: "second" } }));

    if (failure === "checksum failure") vi.mocked(h.client.blobMaterializationReadUrl).mockResolvedValue({ generation: "17", size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==", download: { url: "https://signed.test/blob", method: "GET", gcsPath: `customers/owner/projects/app/.objects/${remoteHash}`, expiresAt: "later" } });
    await expect(h.hydrate({ ...input, requireRestoredCheckout: true })).rejects.toThrow(failure === "authored edits" ? /conflicts with local/ : /content hash mismatch/);

    expect(await fs.readFile(path.join(h.root, "images/a.png"), "utf8")).toBe(failure === "authored edits" ? "authored local work" : "abc");
    expect(await readProjectRestoreReady(h.root, "owner", "app")).toBe(false);
    expect(h.client.blobMaterializationReadUrl).toHaveBeenCalledTimes(failure === "authored edits" ? 1 : 2);
  });

  it.each(["committed", "missing"].flatMap(manifest => ["unchanged", "authored", "unproven"].map(state => ({ manifest, state }))))("reconciles a remote deletion for a $manifest manifest only when cached bytes are proven unchanged: $state", async ({ manifest, state }) => {
    const h = await fixture();
    const prefix = "customers/owner/projects/app", sha256 = createHash("sha256").update(h.body).digest("hex");
    const entry = { ...h.manifest["images/a.png"], sha256, gcsPath: `${prefix}/.objects/${sha256}` };
    await fs.mkdir(path.join(h.root, ".files"));
    await fs.writeFile(path.join(h.root, ".files/manifest.json"), JSON.stringify({ "images/a.png": entry }));
    vi.mocked(h.client.blobMaterializationReadUrl).mockResolvedValue({ generation: "17", size: 3, md5Hash: "kAFQmDzST7DWlj99KOF/cg==", download: { url: "https://signed.test/blob", method: "GET", gcsPath: entry.gcsPath, expiresAt: "later" } });
    const input = { slug: "owner", project: "app", destination: h.root, maxBytes: 8, preserveExisting: true, markRestoreReady: true };
    await h.hydrate(input);
    if (state === "authored") await fs.writeFile(path.join(h.root, "images/a.png"), "local authored bytes");
    if (state === "unproven") await withMaterializedProjectAssets(h.root, prefix, async files => {
      delete files["images/a.png"].sha256;
      files["images/a.png"].gcsPath = `${prefix}/images/a.png`;
    });
    if (manifest === "missing") {
      await fs.rm(path.join(h.root, ".files/manifest.json"));
      h.fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    } else await fs.writeFile(path.join(h.root, ".files/manifest.json"), "{}");

    if (state === "unchanged") {
      await expect(h.hydrate({ ...input, requireRestoredCheckout: true })).resolves.toMatchObject({ files: 0 });
      await expect(fs.stat(path.join(h.root, "images/a.png"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await withMaterializedProjectAssets(h.root, prefix, async files => files)).toEqual({});
      expect(await readProjectRestoreReady(h.root, "owner", "app")).toBe(true);
    } else {
      await expect(h.hydrate({ ...input, requireRestoredCheckout: true })).rejects.toThrow(/conflicts with local/);
      expect(await fs.readFile(path.join(h.root, "images/a.png"), "utf8")).toBe(state === "authored" ? "local authored bytes" : "abc");
      expect(await readProjectRestoreReady(h.root, "owner", "app")).toBe(false);
      expect(Object.keys(await withMaterializedProjectAssets(h.root, prefix, async files => files))).toEqual(["images/a.png"]);
    }
  });

  it("does not resurrect a materialized asset deleted locally during automatic restoration", async () => {
    const h = await fixture();
    await h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8, preserveExisting: true });
    await fs.rm(path.join(h.root, "images/a.png"));
    expect(await h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8, preserveExisting: true })).toMatchObject({ files: 0 });
    await expect(fs.stat(path.join(h.root, "images/a.png"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8, paths: ["images/a.png"] })).toMatchObject({ files: 1 });
  });
  it("hydrates a managed checkout with external Git metadata under the shared mutation lease", async () => {
    const h = await fixture();
    const parent = path.dirname(h.root);
    storageRoots.users = path.join(parent, "customers");
    const destination = path.join(storageRoots.users, "owner/projects/app");
    const metadata = path.join(parent, "git-metadata/owner/projects/app.git");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(h.root, destination);
    await fs.mkdir(path.dirname(metadata), { recursive: true });
    await fs.rename(path.join(destination, ".git"), metadata);
    await fs.writeFile(path.join(destination, ".git"), `gitdir: ${metadata}\n`);
    expect(await createBrokeredProjectBlobHydrator(h.client)({ slug: "owner", project: "app", destination, maxBytes: 8 })).toMatchObject({ files: 1 });
    expect(await fs.readFile(path.join(destination, "images/a.png"))).toEqual(h.body);
    expect((await fs.stat(path.join(parent, "git-source-switch-locks/owner/app.git"))).isDirectory()).toBe(true);
    expect(await fs.readdir(metadata)).toEqual([]);
  });
  it("rehydrates a recreated checkout despite its surviving materialization ledger", async () => {
    const h = await fixture();
    const input = { slug: "owner", project: "app", destination: h.root, maxBytes: 8, preserveExisting: true };
    await h.hydrate(input);
    await fs.rename(h.root, `${h.root}-retained`);
    await fs.mkdir(h.root);
    await fs.mkdir(path.join(h.root, ".git"));
    await fs.mkdir(path.join(h.root, ".files"));
    await fs.writeFile(path.join(h.root, ".files/manifest.json"), JSON.stringify(h.manifest));
    expect(await h.hydrate(input)).toMatchObject({ files: 1, bytes: 3 });
    expect(await fs.readFile(path.join(h.root, "images/a.png"))).toEqual(h.body);
  });
  it("hydrates the selected owner/project manifest into scratch and verifies exact generation, size and checksum", async () => {
    const h = await fixture();
    const result = await h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8 });
    expect(result).toEqual({ bytes: 3, files: 1, generation: "23" });
    expect(h.client.workspaceManifestReadUrl).toHaveBeenCalledWith({ slug: "owner", projectSlug: "app" });
    expect(h.client.blobMaterializationReadUrl).toHaveBeenCalledWith({ slug: "owner", path: "projects/app/images/a.png", size: 3 });
    expect(await fs.readFile(path.join(h.root, "images/a.png"), "utf8")).toBe("abc");
  });
  it.each(["checksum", "generation", "oversize", "interruption"])("refuses %s without publishing a partial file", async kind => {
    const h = await fixture();
    h.fetchMock.mockImplementation(async url => {
      if (url.includes("manifest")) return new Response(JSON.stringify(h.manifest), { headers: { "x-goog-generation": "23" } });
      if (kind === "interruption") return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("a")); controller.error(new Error("interrupted")); } }));
      return new Response(kind === "checksum" ? "xyz" : kind === "oversize" ? "abcdef" : "abc", { headers: { "x-goog-generation": kind === "generation" ? "18" : "17" } });
    });
    await expect(h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8 })).rejects.toThrow();
    await expect(fs.stat(path.join(h.root, "images/a.png"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(path.join(h.root, "images"))).toEqual([]);
  });
  it("rejects manifest quota and foreign object paths before requesting blob authority", async () => {
    const h = await fixture();
    await expect(h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 2 })).rejects.toThrow(/quota/);
    expect(h.client.blobMaterializationReadUrl).not.toHaveBeenCalled();
    await fs.rm(path.join(h.root, ".files/manifest.json"));
    h.manifest["images/a.png"].gcsPath = "customers/other/private";
    await expect(h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8 })).rejects.toThrow(/invalid entry/);
  });
  it("preserves committed files and rejects symlink parents rather than overwriting any target", async () => {
    const h = await fixture(); await fs.mkdir(path.join(h.root, "images")); await fs.writeFile(path.join(h.root, "images/a.png"), "committed");
    await expect(h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8 })).rejects.toThrow(/existing/);
    expect(await fs.readFile(path.join(h.root, "images/a.png"), "utf8")).toBe("committed");
    await fs.rm(path.join(h.root, "images"), { recursive: true });
    const durable = path.join(h.root, "durable"); await fs.mkdir(durable); await fs.symlink(durable, path.join(h.root, "images"));
    await expect(h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8 })).rejects.toThrow(/symlink/);
    expect(await fs.readdir(durable)).toEqual([]);
  });
  it("handles an absent manifest as an empty cache without downloading any object", async () => {
    const h = await fixture(); h.fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await h.hydrate({ slug: "owner", project: "app", destination: h.root, maxBytes: 8 })).toEqual({ bytes: 0, files: 0, generation: null });
    expect(h.client.blobMaterializationReadUrl).not.toHaveBeenCalled();
  });
});
