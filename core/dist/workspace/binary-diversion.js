import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { withProjectAssetManifest, projectAssetEntry } from "./project-asset-manifest.js";
import { withMaterializedProjectAssets } from "../project-asset-state.js";
import { dirname, join } from "node:path";
import { link, lstat, mkdtemp, open, rename, rmdir, unlink } from "node:fs/promises";
import { isDivertableWorkspacePath, looksLikeWorkspaceBinary, MAX_WORKSPACE_BINARY_BYTES, WORKSPACE_BINARY_SNIFF_BYTES, } from "../workspace-binary.js";
import { gitStatus, OPENCLAW_WORKSPACE_SCRATCH_PATH } from "./workspace-git.js";
import { logger } from "../http/logging.js";
import { storeWorkspaceBlob } from "./workspace-blob.js";
import { getMimeType, getExtension } from "./route-helpers.js";
export const BINARY_SNIFF_BYTES = WORKSPACE_BINARY_SNIFF_BYTES;
export const MAX_DIVERTED_BLOB_BYTES = MAX_WORKSPACE_BINARY_BYTES;
export function looksBinary(sample) {
    return looksLikeWorkspaceBinary(sample);
}
export function isDivertablePath(relativePath) {
    return isDivertableWorkspacePath(relativePath);
}
const DEFAULT_DEPS = { gitStatus, storeWorkspaceBlob };
const retainedSnapshots = new Map();
const MAX_RETAINED_SNAPSHOTS = 100_000;
function rememberRetainedSnapshot(key, snapshot, manifest) {
    retainedSnapshots.delete(key);
    if (retainedSnapshots.size >= MAX_RETAINED_SNAPSHOTS)
        retainedSnapshots.delete(retainedSnapshots.keys().next().value);
    const { dev, ino, size, mtimeMs, ctimeMs } = snapshot;
    retainedSnapshots.set(key, { snapshot: { dev, ino, size, mtimeMs, ctimeMs }, manifest });
}
function reuseRetainedSnapshot(key, stats, options) {
    const cached = options.retainLocalFiles ? retainedSnapshots.get(key) : undefined;
    if (cached && cached.manifest === options.materializedManifest && sameFileSnapshot(cached.snapshot, stats)) {
        rememberRetainedSnapshot(key, stats, cached.manifest);
        return true;
    }
    retainedSnapshots.delete(key);
    return false;
}
async function recordRetainedSnapshot(key, snapshot, manifest, handle) {
    if (!sameFileSnapshot(snapshot, await handle.stat()))
        throw new Error("file changed while recording materialization");
    rememberRetainedSnapshot(key, snapshot, manifest);
}
function descriptorChildPath(directory, name) {
    const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    return `${descriptorRoot}/${directory.fd}/${name}`;
}
async function closeHandles(handles) {
    const results = await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected")
        throw failed.reason;
}
function confinedPathSegments(relativePath) {
    const segments = relativePath.split("/");
    if (!isDivertablePath(relativePath) ||
        segments.length === 0 ||
        segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
        throw new Error("path is outside the user workspace");
    }
    return segments;
}
function confinedOpenError(error) {
    const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null;
    if (code === "ELOOP" || code === "ENOTDIR") {
        throw new Error("symlink or non-directory path component, not diverted");
    }
    throw error;
}
async function openConfinedEntry(customerDir, relativePath) {
    if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
        throw new Error("confined file opens are unavailable on this platform");
    }
    const segments = confinedPathSegments(relativePath);
    const handles = [];
    try {
        let directory = await open(customerDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(directory);
        for (const segment of segments.slice(0, -1)) {
            directory = await open(descriptorChildPath(directory, segment), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            handles.push(directory);
        }
        const entryPath = descriptorChildPath(directory, segments.at(-1));
        return {
            entryPath,
            close: () => closeHandles(handles),
        };
    }
    catch (error) {
        await closeHandles(handles);
        return confinedOpenError(error);
    }
}
async function openConfinedFile(customerDir, relativePath) {
    const entry = await openConfinedEntry(customerDir, relativePath);
    try {
        const handle = await open(entry.entryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        return {
            handle,
            entryPath: entry.entryPath,
            close: async () => {
                await handle.close();
                await entry.close();
            },
        };
    }
    catch (error) {
        await entry.close();
        return confinedOpenError(error);
    }
}
function sameFileSnapshot(left, right) {
    return left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs &&
        left.ctimeMs === right.ctimeMs;
}
function assertStableRead(contents, before, after) {
    if (contents.length !== before.size || !sameFileSnapshot(before, after))
        throw new Error("file changed while reading");
}
function sameFileIdentity(left, right) {
    return left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs;
}
async function restoreStagedEntry(stagedPath, entryPath) {
    try {
        await link(stagedPath, entryPath);
    }
    catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
            throw error;
        }
    }
    await unlink(stagedPath);
}
async function retainProjectBinary(input) {
    const { customerDir, relativePath, target, deps, contents, confined, afterRead } = input;
    let saved;
    await withProjectAssetManifest(customerDir, target.gcsPrefix, async (manifest) => {
        const sha256 = createHash("sha256").update(contents).digest("hex");
        if (manifest[relativePath]?.sha256 === sha256) {
            saved = manifest[relativePath];
            return;
        }
        const mimeType = getMimeType(getExtension(relativePath));
        const stored = await deps.storeWorkspaceBlob(target, relativePath, contents, mimeType, { immutable: true });
        if (!sameFileSnapshot(afterRead, await confined.handle.stat()))
            throw new Error("file changed during remote save");
        if (stored.sha256 !== sha256 || stored.size !== contents.length)
            throw new Error("project asset upload identity mismatch");
        manifest[relativePath] = projectAssetEntry(stored, mimeType);
        saved = manifest[relativePath];
    });
    await withMaterializedProjectAssets(customerDir, target.gcsPrefix, async (files) => { files[relativePath] = saved; });
    return JSON.stringify(saved);
}
async function divertBinaryEntry(customerDir, relativePath, target, deps, options = {}) {
    const confined = await openConfinedFile(customerDir, relativePath);
    let stagedPath = null;
    let stagingDir = null;
    try {
        const stats = await confined.handle.stat();
        if (!stats.isFile())
            return null;
        if (stats.size > MAX_DIVERTED_BLOB_BYTES) {
            throw new Error(`${stats.size} bytes exceeds the blob limit`);
        }
        const cacheKey = JSON.stringify([customerDir, target.gcsPrefix, relativePath]);
        if (reuseRetainedSnapshot(cacheKey, stats, options))
            return { path: relativePath, size: stats.size };
        const contents = await confined.handle.readFile();
        const afterRead = await confined.handle.stat();
        assertStableRead(contents, stats, afterRead);
        if (!options.knownAsset && !looksBinary(contents.subarray(0, BINARY_SNIFF_BYTES)))
            return null;
        if (options.retainLocalFiles) {
            const manifest = await retainProjectBinary({ customerDir, relativePath, target, deps, contents, confined, afterRead });
            await recordRetainedSnapshot(cacheKey, afterRead, manifest, confined.handle);
            return { path: relativePath, size: stats.size };
        }
        stagingDir = await mkdtemp(join(dirname(customerDir), ".octogee-diversion-"));
        stagedPath = join(stagingDir, "payload");
        await rename(confined.entryPath, stagedPath);
        const staged = await open(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stagedStats = await staged.stat();
            if (!stagedStats.isFile() || !sameFileIdentity(afterRead, stagedStats)) {
                await restoreStagedEntry(stagedPath, confined.entryPath);
                stagedPath = null;
                throw new Error("file changed before diversion");
            }
        }
        finally {
            await staged.close();
        }
        await deps.storeWorkspaceBlob(target, relativePath, contents, getMimeType(getExtension(relativePath)));
        await unlink(stagedPath);
        stagedPath = null;
        await rmdir(stagingDir);
        stagingDir = null;
        return { path: relativePath, size: stats.size };
    }
    catch (error) {
        if (stagedPath) {
            try {
                await restoreStagedEntry(stagedPath, confined.entryPath);
                stagedPath = null;
            }
            catch (restoreError) {
                throw new AggregateError([error, restoreError], "binary diversion failed and its staged file could not be restored");
            }
        }
        throw error;
    }
    finally {
        try {
            if (stagingDir)
                await rmdir(stagingDir);
        }
        finally {
            await confined.close();
        }
    }
}
export async function divertWorktreeBinaries(customerDir, target, deps = DEFAULT_DEPS, options = {}) {
    const result = await divertChangedBinaries(customerDir, target, deps, options);
    if (result.failures.length)
        logger.error("workspace binary diversion failed", { cwd: customerDir, failures: result.failures });
    return result;
}
async function divertChangedBinaries(customerDir, target, deps, options) {
    const status = await deps.gitStatus(customerDir, { untracked: "all" });
    if (!status.ok) {
        return { diverted: [], failures: [`git status failed: ${status.error.code}`], failedPaths: [] };
    }
    const diverted = [];
    const failures = [];
    const failedPaths = [];
    const assetPaths = new Set();
    const materializedManifests = new Map();
    if (options.retainLocalFiles) {
        await withMaterializedProjectAssets(customerDir, target.gcsPrefix, async (files) => {
            await withProjectAssetManifest(customerDir, target.gcsPrefix, async (manifest) => {
                for (const [name, prior] of Object.entries(files)) {
                    if (!manifest[name]) {
                        delete files[name];
                        continue;
                    }
                    if (manifest[name].gcsPath !== prior.gcsPath || manifest[name].uploadedAt !== prior.uploadedAt)
                        continue;
                    let entry;
                    try {
                        entry = await openConfinedEntry(customerDir, name);
                        await lstat(entry.entryPath);
                    }
                    catch (error) {
                        if (error.code !== "ENOENT")
                            throw error;
                        delete manifest[name];
                        delete files[name];
                    }
                    finally {
                        await entry?.close();
                    }
                }
                for (const name of Object.keys(manifest)) {
                    assetPaths.add(name);
                    const version = JSON.stringify(manifest[name]);
                    if (JSON.stringify(files[name]) === version)
                        materializedManifests.set(name, version);
                }
            });
        });
    }
    const candidates = new Set([...status.entries.filter(entry => entry.change !== "deleted").map(entry => entry.path), ...assetPaths]);
    const excludePaths = [OPENCLAW_WORKSPACE_SCRATCH_PATH, ...options.excludePaths ?? []];
    for (const name of candidates) {
        if (excludePaths.some(excluded => name === excluded || name.startsWith(`${excluded}/`)))
            continue;
        if (!isDivertablePath(name))
            continue;
        try {
            const divertedBlob = await divertBinaryEntry(customerDir, name, target, deps, { retainLocalFiles: options.retainLocalFiles, knownAsset: assetPaths.has(name), materializedManifest: materializedManifests.get(name) });
            if (divertedBlob)
                diverted.push(divertedBlob);
        }
        catch (err) {
            if (assetPaths.has(name) && err.code === "ENOENT")
                continue;
            failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
            failedPaths.push(name);
        }
    }
    return { diverted, failures, failedPaths };
}
