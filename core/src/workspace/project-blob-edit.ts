import { withMaterializedProjectAssets, readProjectRestoreReady } from "../project-asset-state.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isManifestPath, manifestObjectPath, parseManifest, serializeManifest, type Manifest, type ManifestEntry } from "../workspace-manifest.js";
import type { FileTarget } from "./fileTarget.js";
import { giteaApiAsUserAllowNotFound } from "../git-host/gitea-client.js";
import { getMimeType, getExtension, targetGiteaApi } from "./route-helpers.js";
import { getManifestForQuota, manifestStoreForBlobs } from "./manifest.js";
import { storeWorkspaceBlob, removeWorkspaceBlob, type WorkspaceBlobOptions, type StoredWorkspaceBlob } from "./workspace-blob.js";
import { commitAndPushWorkspace, resolveProjectDir } from "./workspace-git.js";
import { divertWorktreeBinaries } from "./binary-diversion.js";
import { projectAssetEntry, withProjectAssetManifest } from "./project-asset-manifest.js";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

interface RemoteAssetDeps {
  read(target: FileTarget): Promise<unknown>;
  write(target: FileTarget, body: { sha?: string; message: string; content: string }): Promise<unknown>;
  readLegacy(prefix: string): Promise<Manifest>;
}
const remoteDefaults: RemoteAssetDeps = {
  read: target => {
    if (!target.sudoUser) throw new Error("project asset edit requires its authorized Gitea user");
    return giteaApiAsUserAllowNotFound(target.sudoUser, target.org, `${target.repoName}/contents/.files/manifest.json`);
  },
  write: (target, body) => targetGiteaApi(target, `${target.repoName}/contents/.files/manifest.json`, "PUT", body),
  readLegacy: getManifestForQuota,
};

async function remoteManifest(target: FileTarget, deps: RemoteAssetDeps) {
  const objectPath = manifestObjectPath(target.gcsPrefix);
    const current = await deps.read(target) as { sha?: string; encoding?: string; content?: string } | null;
    if (current && (!current.sha || current.encoding !== "base64" || typeof current.content !== "string" || current.content.length > 14 * 1024 * 1024)) throw new Error("invalid project asset manifest response");
    const manifest = current ? parseManifest(objectPath, Buffer.from(current.content!, "base64").toString("utf8")) : await readLegacyManifest(target, deps);
  return { current, manifest };
}

function readLegacyManifest(target: FileTarget, deps: RemoteAssetDeps): Promise<Manifest> {
  if (target.blobStore) return getManifestForQuota(target.gcsPrefix, manifestStoreForBlobs(target.blobStore));
  return deps.readLegacy(target.gcsPrefix);
}

function assertProjectAssetEdit(target: FileTarget, name: string): void {
  if (target.provider !== "gitea" || !target.projectSlug || !isManifestPath(name)) throw new Error("invalid project asset edit");
}

function updateAssetEntry(manifest: Manifest, name: string, entry: ManifestEntry | null): void {
  if (entry !== null) {
    const descriptor = { value: entry, enumerable: true, writable: true, configurable: true };
    Object.defineProperties(manifest, Object.fromEntries([[name, descriptor]]));
    return;
  }
  if (!Reflect.deleteProperty(manifest, name)) {
    throw new Error("project asset manifest entry could not be deleted");
  }
}

export async function editRemoteProjectAsset(target: FileTarget, name: string, entry: ManifestEntry | null, deps: RemoteAssetDeps = remoteDefaults): Promise<void> {
  assertProjectAssetEdit(target, name);
  const objectPath = manifestObjectPath(target.gcsPrefix);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { current, manifest } = await remoteManifest(target, deps);
    const before = serializeManifest(manifest);
    updateAssetEntry(manifest, name, entry);
    const contents = serializeManifest(manifest);
    parseManifest(objectPath, contents);
    if (current && before === contents) return;
    try {
      const result = await deps.write(target, { ...(current && { sha: current.sha }), message: `assets: ${entry ? "save" : "delete"} ${name}`, content: Buffer.from(contents).toString("base64") }) as { content?: { sha?: string } };
      if (!result?.content?.sha) throw new Error("project asset manifest commit was not confirmed");
      return;
    } catch (error) {
      if (attempt === 2 || !/Gitea API (409|422)\b/u.test(String(error))) throw error;
    }
  }
}

async function editLocalAsset(root: string, name: string, contents: Buffer | null): Promise<void> {
  const handles = [await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)];
  const fdRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  let temporary: string | undefined;
  try {
    const parts = name.split("/");
    for (const part of parts.slice(0, -1)) {
      const next = `${fdRoot}/${handles.at(-1)!.fd}/${part}`;
      if (contents) await mkdir(next).catch(error => { if (error.code !== "EEXIST") throw error; });
      try { handles.push(await open(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)); }
      catch (error) { if (!contents && (error as NodeJS.ErrnoException).code === "ENOENT") { return; }
          throw error; }
    }
    const directory = `${fdRoot}/${handles.at(-1)!.fd}`;
    const destination = `${directory}/${parts.at(-1)}`;
    try { if (!(await lstat(destination)).isFile()) throw new Error("project asset is not a regular file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!contents) { await unlink(destination).catch(error => { if (error.code !== "ENOENT") throw error; }); return; }
    temporary = `${directory}/.asset-${randomUUID()}`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await rename(temporary, destination); temporary = undefined;
    await handles.at(-1)!.sync();
  } finally {
    if (temporary) await unlink(temporary);
    for (const handle of handles.reverse()) await handle.close();
  }
}

async function localProject(target: FileTarget): Promise<string | null> {
  if (!isIsolatedGatewayClassValue(process.env.GATEWAY_CLASS) || !process.env.OCTOGEE_PROJECTS_MOUNT) return null;
  const root = process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers";
  const dir = await resolveProjectDir(root, target.slug, target.projectSlug!);
  if (!dir) return null;
  if (!await readProjectRestoreReady(dir, target.slug, target.projectSlug!)) throw new Error("project restoration is not complete");
  return dir;
}

interface LocalProjectAssetInput {
  target: FileTarget;
  dir: string;
  name: string;
  contents: Buffer | null;
  upload: () => Promise<StoredWorkspaceBlob>;
  mimeType?: string;
  divert?: typeof divertWorktreeBinaries;
}
export async function commitLocalProjectAsset(input: LocalProjectAssetInput): Promise<StoredWorkspaceBlob | undefined> {
  const { target, dir, name, contents, upload, mimeType, divert = divertWorktreeBinaries } = input;
  assertProjectAssetEdit(target, name);
  let stored: StoredWorkspaceBlob | undefined;
  const result = await commitAndPushWorkspace(dir, {
    message: `assets: ${contents ? "save" : "delete"} ${name}`,
    author: { name: target.slug, email: `${target.slug}@octogee.com` },
    beforeCommit: async () => {
      const other = await divert(dir, target, undefined, { retainLocalFiles: true });
      if (other.failures.length) return { ok: false, error: { code: "BLOB_DIVERSION_FAILED", cwd: dir, paths: other.failedPaths } };
      if (contents) stored = await upload();
      await editLocalAsset(dir, name, contents);
      const excludePaths = await withProjectAssetManifest(dir, target.gcsPrefix, async manifest => {
        const entry = stored ? projectAssetEntry(stored, mimeType || getMimeType(getExtension(name))) : null;
        updateAssetEntry(manifest, name, entry);
        await withMaterializedProjectAssets(dir, target.gcsPrefix, async files => { updateAssetEntry(files, name, entry); });
        return [...new Set([...Object.keys(manifest), name, ...other.diverted.map(blob => blob.path)])];
      });
      return { ok: true, excludePaths };
    },
  });
  if (!result.ok) throw new Error(`project asset commit failed: ${result.error.code}`);
  if (!result.result.pushed) throw new Error(`project asset remote save failed: ${result.result.pushError || "push unconfirmed"}`);
  return stored;
}

export async function storeUploadedWorkspaceBlob(target: FileTarget, name: string, contents: Buffer, mimeType?: string, options: WorkspaceBlobOptions = {}): Promise<StoredWorkspaceBlob> {
  if (!target.projectSlug) return storeWorkspaceBlob(target, name, contents, mimeType, options);
  assertProjectAssetEdit(target, name);
  const upload = () => storeWorkspaceBlob(target, name, contents, mimeType, { ...options, immutable: true });
  const local = await localProject(target);
  if (local) return (await commitLocalProjectAsset({ target, dir: local, name, contents, upload, mimeType }))!;
  const stored = await upload();
  await editRemoteProjectAsset(target, name, projectAssetEntry(stored, mimeType || getMimeType(getExtension(name))));
  return stored;
}

export async function removeUploadedWorkspaceBlob(target: FileTarget, name: string): Promise<void> {
  if (!target.projectSlug) return removeWorkspaceBlob(target, name);
  assertProjectAssetEdit(target, name);
  const local = await localProject(target);
  if (local) await commitLocalProjectAsset({ target, dir: local, name, contents: null, upload: async () => { throw new Error("deletion cannot upload an asset"); } });
  else await editRemoteProjectAsset(target, name, null);
}
