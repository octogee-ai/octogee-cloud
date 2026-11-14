import { Router } from "express";
import { gcsBucket } from "../../lib/gcs-bucket.js";
import { validateFilePath } from "../../lib/path-validation.js";
import { withFileTarget } from "../../lib/fileTarget.js";
import { getManifest } from "../../lib/manifest.js";
import { BLOB_SIGNED_URL_TTL_MS } from "../../lib/workspace-blob.js";
import type { Manifest } from "../../lib/manifest.js";
import { manifestObjectPath, parseManifest } from "@octogee/core/workspace-manifest";
import { isOversizeFile } from "../../lib/github.js";
import { logger } from "../../middleware/logging.js";
import {
  HIDDEN,
  isCanvasDashboardDocumentPath,
  isTargetDirectoryEntryReadable,
  isTargetDirectoryReadable,
  isTargetPathReadable,
  isTargetPathWritable,
  pathHasReservedOrHiddenSegment,
  repoBranchesApi,
  repoCommitsApi,
  repoContentsApi,
  repoDefaultBranch,
  repoTreeApi,
  type LastCommit,
} from "./helpers.js";
import {
  cachedWorkspaceFileResponse,
  clearWorkspaceFileResponseCache,
  FILE_COMMIT_CACHE_TTL_MS,
  FILE_CONTENT_CACHE_TTL_MS,
  FILE_INDEX_CACHE_TTL_MS,
  FILE_LIST_CACHE_TTL_MS,
  workspaceFileCacheKey,
} from "./file-response-cache.js";

const router = Router();

export interface RepoContentEntry {
  name: string;
  path: string;
  type: string;
  size?: number;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  source: "git" | "blob";
  thumbnailUrl?: string;
}

export interface WorkspaceFilesResponse {
  files: WorkspaceFileEntry[];
  readOnly?: boolean;
}

export interface WorkspaceFileCommitsResponse {
  commits: Record<string, LastCommit>;
  truncated?: boolean;
}

export interface WorkspaceFileIndexEntry {
  path: string;
  source: "git" | "blob";
}

export interface WorkspaceFileIndexResponse {
  files: WorkspaceFileIndexEntry[];
  paths: string[];
  truncated: boolean;
}

export interface WorkspaceFileCommitEntry {
  path: string;
  source?: "git" | "blob";
}

export type WorkspaceFileResponse =
  | {
      content: null;
      downloadUrl: string;
      mimeType: string;
      size: number;
      path: string;
      source: "blob";
    }
  | {
      content: string;
      path: string;
      sha?: string;
      source: "git";
      writable: boolean;
    }
  | {
      error: "File too large to display inline";
      code: "FILE_TOO_LARGE";
      size: number | null;
      path: string;
    };

type ListPathValidation = { ok: true } | { ok: false; status: 400 | 403; error: string };
const ACCESS_DENIED = "Access denied";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function validateListPath(path: string): ListPathValidation {
  if (!path) return { ok: true };

  const pathError = validateFilePath(path);
  if (pathError) return { ok: false, status: 400, error: pathError };

  if (pathHasReservedOrHiddenSegment(path)) {
    return { ok: false, status: 403, error: ACCESS_DENIED };
  }

  return { ok: true };
}

const REF_RE = /^[A-Za-z0-9._/-]{1,255}$/;

// A git ref (branch name) from the client. Reject anything outside safe branch-name
// characters — the value flows into a provider API URL.
function refFromReq(req: { query: Record<string, unknown> }): string | undefined {
  const ref = req.query.ref;
  return typeof ref === "string" && REF_RE.test(ref) ? ref : undefined;
}

async function repoContentEntries(
  target: Parameters<typeof repoContentsApi>[0],
  path: string,
  ref?: string,
): Promise<RepoContentEntry[] | null> {
  try {
    const raw = await repoContentsApi(target, path, ref);
    return (Array.isArray(raw) ? raw : [raw]) as RepoContentEntry[];
  } catch (e) {
    if (errorMessage(e).includes("404")) return null;
    throw e;
  }
}

export function repoFileEntries(
  contents: RepoContentEntry[],
  target?: Parameters<typeof repoContentsApi>[0],
): WorkspaceFileEntry[] {
  return contents
    .filter((file) => !HIDDEN.has(file.name) && !file.name.startsWith("."))
    .map((file) => ({
      name: file.name,
      path: file.path,
      type: file.type === "dir" ? "dir" : "file",
      size: file.size ?? 0,
      source: "git",
    } satisfies WorkspaceFileEntry))
    .filter((file) => !target || isTargetDirectoryEntryReadable(target, file.path, file.type));
}

function directBlobPaths(manifest: Manifest, prefix: string, gitPaths: Set<string>): Set<string> {
  return new Set(Object.keys(manifest).filter((manifestPath) => {
    if (!manifestPath.startsWith(prefix) || gitPaths.has(manifestPath)) return false;
    const relative = manifestPath.slice(prefix.length);
    return relative.length > 0 && !relative.includes("/");
  }));
}

interface BlobDirectoryEntryInput {
  target: Parameters<typeof repoContentsApi>[0] | undefined;
  manifestPath: string;
  entryPath: string;
  name: string;
  emittedPaths: Set<string>;
  directBlobPaths: Set<string>;
}

function blobDirectoryEntry({
  target,
  manifestPath,
  entryPath,
  name,
  emittedPaths,
  directBlobPaths,
}: BlobDirectoryEntryInput,
): WorkspaceFileEntry | null {
  if (directBlobPaths.has(entryPath) || emittedPaths.has(entryPath)) return null;
  if (target && (!isTargetPathReadable(target, manifestPath) || !isTargetDirectoryEntryReadable(target, entryPath, "dir"))) {
    return null;
  }
  emittedPaths.add(entryPath);
  return { name, path: entryPath, type: "dir", size: 0, source: "blob" };
}

function blobFileEntry(
  target: Parameters<typeof repoContentsApi>[0] | undefined,
  manifestPath: string,
  entry: Manifest[string],
  name: string,
  emittedPaths: Set<string>,
): WorkspaceFileEntry | null {
  if (emittedPaths.has(manifestPath) || (target && !isTargetPathReadable(target, manifestPath))) return null;
  emittedPaths.add(manifestPath);
  return { name, path: manifestPath, type: "file", size: entry.size ?? 0, source: "blob" };
}

export function blobFileEntries(
  manifest: Manifest,
  path: string,
  gitPaths: Set<string>,
  target?: Parameters<typeof repoContentsApi>[0],
): WorkspaceFileEntry[] {
  const prefix = path ? `${path}/` : "";
  const entries: WorkspaceFileEntry[] = [];
  const emittedPaths = new Set(gitPaths);
  const directPaths = directBlobPaths(manifest, prefix, gitPaths);

  for (const [manifestPath, entry] of Object.entries(manifest)) {
    if (!manifestPath.startsWith(prefix) || gitPaths.has(manifestPath)) continue;

    const relative = manifestPath.slice(prefix.length);
    if (!relative) continue;

    const [name, ...remainder] = relative.split("/");
    const entryPath = `${prefix}${name}`;
    if (remainder.length > 0) {
      const directory = blobDirectoryEntry({
        target,
        manifestPath,
        entryPath,
        name,
        emittedPaths,
        directBlobPaths: directPaths,
      });
      if (directory) entries.push(directory);
      continue;
    }

    const file = blobFileEntry(target, manifestPath, entry, name, emittedPaths);
    if (file) entries.push(file);
  }

  return entries;
}

async function signWorkspaceBlob(target: Parameters<typeof repoContentsApi>[0], key: string): Promise<string> {
  const expires = Date.now() + BLOB_SIGNED_URL_TTL_MS;
  if (target.blobStore) return (await target.blobStore.signedUrl({ gcsPath: key, action: "read" }, expires)).url;
  const [url] = await gcsBucket().file(key).getSignedUrl({ action: "read", expires });
  return url;
}

async function signThumbnailUrls(
  target: Parameters<typeof repoContentsApi>[0],
  manifest: Manifest,
  entries: WorkspaceFileEntry[],
): Promise<WorkspaceFileEntry[]> {
  return Promise.all(entries.map(async (file) => {
    if (!manifest[file.path]?.hasThumbnail) return file;
    try {
      const thumbnailUrl = await signWorkspaceBlob(target, `${target.gcsPrefix}/.thumbs/${file.path}.png`);
      return { ...file, thumbnailUrl };
    } catch (err) {
      logger.error("thumbnail url signing failed", { err, path: file.path });
      return file;
    }
  }));
}

export function sortWorkspaceFiles(files: WorkspaceFileEntry[]): WorkspaceFileEntry[] {
  return [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function targetAssetManifest(target: Parameters<typeof repoContentsApi>[0], bustCache = false, ref?: string): Promise<Manifest> {
  if (!target.projectSlug) return getManifest(target.gcsPrefix, bustCache, target.blobStore);
  let file;
  try { file = await repoContentsApi(target, ".files/manifest.json", ref) as { encoding?: string; content?: string }; }
  catch (error) {
    if (!errorMessage(error).includes("404")) throw error;
    return ref ? {} : getManifest(target.gcsPrefix, bustCache, target.blobStore);
  }
  if (!file || file.encoding !== "base64" || typeof file.content !== "string" || file.content.length > 14 * 1024 * 1024) throw new Error("project asset manifest is invalid");
  return parseManifest(manifestObjectPath(target.gcsPrefix), Buffer.from(file.content, "base64").toString("utf8"));
}

async function loadWorkspaceFileEntries(
  target: Parameters<typeof repoContentsApi>[0],
  path: string,
  bustCache = false,
  ref?: string,
): Promise<WorkspaceFileEntry[] | null> {
  const contents = await repoContentEntries(target, path, ref);
  const gitFiles = contents ? repoFileEntries(contents, target) : [];
  if (target.provider === "github") return contents ? sortWorkspaceFiles(gitFiles) : null;

  const manifest = await targetAssetManifest(target, bustCache, ref);
  const gitPaths = new Set(gitFiles.map((file) => file.path));
  const blobs = await signThumbnailUrls(target, manifest, blobFileEntries(manifest, path, gitPaths, target));
  if (!contents && blobs.length === 0) return null;
  return sortWorkspaceFiles([...gitFiles, ...blobs]);
}

async function workspaceFileEntries(
  target: Parameters<typeof repoContentsApi>[0],
  path: string,
  bustCache: boolean,
  ref?: string,
): Promise<WorkspaceFileEntry[] | null> {
  return cachedWorkspaceFileResponse(
    workspaceFileCacheKey("list", target, path, ref),
    FILE_LIST_CACHE_TTL_MS,
    () => loadWorkspaceFileEntries(target, path, bustCache, ref),
    bustCache,
  );
}

export async function workspaceFilesResponse(
  target: Parameters<typeof repoContentsApi>[0],
  path: string,
  bustCache: boolean,
  ref?: string,
): Promise<WorkspaceFilesResponse> {
  const files = await workspaceFileEntries(target, path, bustCache, ref);
  if (!files) return { files: [] };

  return { files, readOnly: target.provider !== "gitea" };
}

function validIndexPath(path: string): boolean {
  return !validateFilePath(path) && !pathHasReservedOrHiddenSegment(path);
}

function sortFileIndexEntries(entries: WorkspaceFileIndexEntry[]): WorkspaceFileIndexEntry[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}

async function loadWorkspaceFileIndex(
  target: Parameters<typeof repoContentsApi>[0],
  ref: string,
): Promise<WorkspaceFileIndexResponse> {
  const tree = await repoTreeApi(target, ref);
  const readableTreePaths = tree.paths.filter((path) => isTargetPathReadable(target, path));
  const gitPaths = new Set(readableTreePaths);
  const entries: WorkspaceFileIndexEntry[] = readableTreePaths.map((path) => ({ path, source: "git" }));

  if (target.provider !== "github") {
    const manifest = await targetAssetManifest(target, false, ref);
    for (const path of Object.keys(manifest)) {
      if (gitPaths.has(path) || !validIndexPath(path) || !isTargetPathReadable(target, path)) continue;
      entries.push({ path, source: "blob" });
    }
  }

  const files = sortFileIndexEntries(entries);
  return {
    files,
    paths: files.map((file) => file.path),
    // Reflects only the git tree's truncation (provider-capped for huge repos);
    // blob (GCS-manifest) entries are always fully enumerated.
    truncated: tree.truncated,
  };
}

export async function workspaceFileIndexResponse(
  target: Parameters<typeof repoContentsApi>[0],
  ref: string,
  bustCache: boolean,
): Promise<WorkspaceFileIndexResponse> {
  return cachedWorkspaceFileResponse(
    workspaceFileCacheKey("index", target, "", ref),
    FILE_INDEX_CACHE_TTL_MS,
    () => loadWorkspaceFileIndex(target, ref),
    bustCache,
  );
}

const COMMIT_FETCH_CONCURRENCY = 8;
export const COMMIT_LOOKUP_ENTRY_LIMIT = 40;

function parentDir(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function commitEntriesFromFiles(files: WorkspaceFileEntry[]): WorkspaceFileCommitEntry[] {
  return files.map((file) => ({ path: file.path, source: file.source }));
}

function capCommitEntries(entries: WorkspaceFileCommitEntry[]): {
  entries: WorkspaceFileCommitEntry[];
  truncated: boolean;
} {
  const gitEntries = entries.filter((entry) => entry.source !== "blob");
  return {
    entries: gitEntries.slice(0, COMMIT_LOOKUP_ENTRY_LIMIT),
    truncated: gitEntries.length > COMMIT_LOOKUP_ENTRY_LIMIT,
  };
}

async function cachedCommitForEntry(
  target: Parameters<typeof repoContentsApi>[0],
  entryPath: string,
  ref?: string,
): Promise<LastCommit | null> {
  return cachedWorkspaceFileResponse(
    workspaceFileCacheKey("commit", target, entryPath, ref),
    FILE_COMMIT_CACHE_TTL_MS,
    () => repoCommitsApi(target, entryPath, ref),
  );
}

export async function workspaceFileCommitsResponse(
  target: Parameters<typeof repoContentsApi>[0],
  path: string,
  requestedEntries?: WorkspaceFileCommitEntry[],
  ref?: string,
): Promise<WorkspaceFileCommitsResponse> {
  const files = requestedEntries ? null : await workspaceFileEntries(target, path, false, ref);
  if (!requestedEntries && !files) return { commits: {} };

  const capped = capCommitEntries(requestedEntries ?? commitEntriesFromFiles(files ?? []));
  const gitEntries = capped.entries;
  const commits: Record<string, LastCommit> = {};
  const failures: string[] = [];
  let lastError = "";

  for (let i = 0; i < gitEntries.length; i += COMMIT_FETCH_CONCURRENCY) {
    const batch = gitEntries.slice(i, i + COMMIT_FETCH_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(async (entry) => {
        try {
          return [entry.path, await cachedCommitForEntry(target, entry.path, ref)] as const;
        } catch (e) {
          failures.push(entry.path);
          lastError = errorMessage(e);
          return [entry.path, null] as const;
        }
      }),
    );
    for (const [entryPath, commit] of resolved) {
      if (commit) commits[entryPath] = commit;
    }
  }

  // Degrade gracefully but don't spam: one line per request summarizing the drop.
  if (failures.length > 0) {
    logger.warn(`workspace file commit lookup failed for ${failures.length}/${gitEntries.length} entries under "${path}": ${lastError}`);
  }

  return { commits, ...(capped.truncated ? { truncated: true } : {}) };
}

async function loadWorkspaceFileResponse(
  target: Parameters<typeof repoContentsApi>[0],
  path: string,
  ref?: string,
): Promise<WorkspaceFileResponse | null> {
  if (target.provider !== "github") {
    const manifest = await targetAssetManifest(target, false, ref);
    const blobEntry = manifest[path];

    if (blobEntry) {
      const signedUrl = await signWorkspaceBlob(target, blobEntry.gcsPath);
      return {
        content: null,
        downloadUrl: signedUrl,
        mimeType: blobEntry.mimeType,
        size: blobEntry.size,
        path,
        source: "blob",
      };
    }
  }

  let file: {
    content?: string;
    sha?: string;
    encoding?: string;
    size?: number;
  };
  try {
    file = (await repoContentsApi(target, path, ref)) as {
      content?: string;
      sha?: string;
      encoding?: string;
      size?: number;
    };
  } catch (e) {
    if (errorMessage(e).includes("404")) return null;
    throw e;
  }

  if (isOversizeFile(file)) {
    return {
      error: "File too large to display inline",
      code: "FILE_TOO_LARGE",
      size: file.size ?? null,
      path,
    };
  }
  const content = Buffer.from(file.content ?? "", "base64").toString("utf-8");
  return {
    content,
    path,
    sha: file.sha,
    source: "git",
    writable: isTargetPathWritable(target, path),
  };
}

export async function workspaceFileResponse(
  target: Parameters<typeof repoContentsApi>[0],
  path: string,
  ref?: string,
  bustCache = false,
): Promise<WorkspaceFileResponse | null> {
  return cachedWorkspaceFileResponse(
    workspaceFileCacheKey("file", target, path, ref),
    FILE_CONTENT_CACHE_TTL_MS,
    () => loadWorkspaceFileResponse(target, path, ref),
    bustCache,
  );
}

function commitEntryValidationError(entryPath: string, dirPath: string): string | null {
  const pathError = validateFilePath(entryPath);
  if (pathError) return pathError;
  if (pathHasReservedOrHiddenSegment(entryPath)) return ACCESS_DENIED;
  if (parentDir(entryPath) !== dirPath) return "Commit entry is outside the requested directory";
  return null;
}

function parseCommitEntries(body: unknown, dirPath: string): WorkspaceFileCommitEntry[] | null {
  const entries = body && typeof body === "object"
    ? (body as { entries?: unknown }).entries
    : undefined;
  if (!Array.isArray(entries)) return null;

  const parsed: WorkspaceFileCommitEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return null;
    const { path, source } = entry as { path?: unknown; source?: unknown };
    if (typeof path !== "string") return null;
    if (source !== undefined && source !== "git" && source !== "blob") return null;
    if (commitEntryValidationError(path, dirPath)) return null;
    parsed.push({ path, ...(source ? { source } : {}) });
  }
  return parsed;
}

export { clearWorkspaceFileResponseCache };

router.get("/branches", withFileTarget(async (_req, res, _next, target) => {
  res.json(await repoBranchesApi(target));
}, { allowWorkspaceMembers: true }));

router.get("/tree", withFileTarget(async (req, res, _next, target) => {
  const ref = refFromReq(req) ?? (await repoDefaultBranch(target));
  const bustCache = req.query.nocache === "1";
  res.json(await workspaceFileIndexResponse(target, ref, bustCache));
}, { allowWorkspaceMembers: true }));

router.get("/files", withFileTarget(async (req, res, _next, target) => {
  const path = (req.query.path as string) ?? "";
  const bustCache = req.query.nocache === "1";
  const ref = refFromReq(req);
  const pathValidation = validateListPath(path);
  if (!pathValidation.ok) {
    res.status(pathValidation.status).json({ error: pathValidation.error });
    return;
  }
  if (!isTargetDirectoryReadable(target, path)) {
    res.status(403).json({ error: ACCESS_DENIED });
    return;
  }

  res.json(await workspaceFilesResponse(target, path, bustCache, ref));
}, { allowWorkspaceMembers: true }));

router.get("/files/commits", withFileTarget(async (req, res, _next, target) => {
  const path = (req.query.path as string) ?? "";
  const ref = refFromReq(req);
  const pathValidation = validateListPath(path);
  if (!pathValidation.ok) {
    res.status(pathValidation.status).json({ error: pathValidation.error });
    return;
  }
  if (!isTargetDirectoryReadable(target, path)) {
    res.status(403).json({ error: ACCESS_DENIED });
    return;
  }

  res.json(await workspaceFileCommitsResponse(target, path, undefined, ref));
}, { allowWorkspaceMembers: true }));

router.post("/files/commits", withFileTarget(async (req, res, _next, target) => {
  const path = ((req.query.path as string | undefined) ?? (req.body as { path?: string } | undefined)?.path) ?? "";
  const ref = refFromReq(req);
  const pathValidation = validateListPath(path);
  if (!pathValidation.ok) {
    res.status(pathValidation.status).json({ error: pathValidation.error });
    return;
  }

  const entries = parseCommitEntries(req.body, path);
  if (!entries) {
    res.status(400).json({ error: "Invalid commit entries" });
    return;
  }
  if (!isTargetDirectoryReadable(target, path)
    || entries.some((entry) => !isTargetPathReadable(target, entry.path))) {
    res.status(403).json({ error: ACCESS_DENIED });
    return;
  }

  res.json(await workspaceFileCommitsResponse(target, path, entries, ref));
}, { allowWorkspaceMembers: true }));

router.get("/file", withFileTarget(async (req, res, _next, target) => {
  const path = req.query.path as string;
  if (!path) { res.status(400).json({ error: "Missing path" }); return; }
  const ref = refFromReq(req);
  const bustCache = req.query.nocache === "1";

  const pathError = validateFilePath(path);
  if (pathError) { res.status(400).json({ error: pathError }); return; }

  if (pathHasReservedOrHiddenSegment(path) && !isCanvasDashboardDocumentPath(path)) {
    res.status(403).json({ error: ACCESS_DENIED });
    return;
  }
  if (!isTargetPathReadable(target, path)) {
    res.status(403).json({ error: ACCESS_DENIED });
    return;
  }

  const response = await workspaceFileResponse(target, path, ref, bustCache);
  if (!response) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  if ("code" in response && response.code === "FILE_TOO_LARGE") {
    res.status(413).json(response);
    return;
  }
  res.json(response);
}, { allowWorkspaceMembers: true }));

export default router;
