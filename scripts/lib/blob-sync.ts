import * as fs from "fs";
import * as path from "path";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import {
  isManifestPath,
  putManifestEntries,
  readManifest,
  type Manifest,
  type ManifestEntry,
  type ManifestStore,
} from "@octogee/core/workspace-manifest";
import {
  dlog,
  log,
  CUSTOMERS_DIR,
  BLOB_SYNC_MAX_CONCURRENT,
  BLOB_SYNC_MAX_SIZE,
} from "./config.js";
import { replaceFileAtomically } from "./atomic-file.js";
import { MIME_TYPES } from "./helpers.js";

export type { Manifest, ManifestEntry };

export interface LocalFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface BlobStore {
  manifestFor(slug: string): ManifestStore;
  download(input: {
    slug: string;
    relativePath: string;
    gcsPath: string;
    destination: string;
    size: number;
  }): Promise<void>;
  upload(input: {
    slug: string;
    relativePath: string;
    gcsPath: string;
    localPath: string;
    mimeType: string;
    size: number;
  }): Promise<void>;
}

export type BlobStoreFactory = (slug: string) => BlobStore | Promise<BlobStore>;

export interface BlobSyncOptions {
  store: BlobStore;
  strict?: boolean;
}

export interface BlobSyncAllOptions {
  storeForSlug: BlobStoreFactory;
  strict?: boolean;
}

export interface BlobSyncActions {
  toDownload: Array<{ path: string; entry: ManifestEntry }>;
  toUpload: string[];
  toDelete: string[];
  skippedDownload: Array<{ path: string; size: number }>;
  skippedUpload: Array<{ path: string; size: number }>;
}

export interface BlobSyncInputs {
  manifest: Manifest;
  localFiles: LocalFile[];
  prevSyncedPaths: string[];
  maxSize?: number;
}

type ManifestBlobAction = "download" | "skip-download" | "skip";

function manifestBlobAction(
  entry: ManifestEntry,
  local: LocalFile | undefined,
  maxSize: number,
): ManifestBlobAction {
  if (entry.size > maxSize) return "skip-download";
  return !local || new Date(entry.uploadedAt).getTime() > local.mtimeMs ? "download" : "skip";
}

export function computeBlobSyncActions(inputs: BlobSyncInputs): BlobSyncActions {
  const {
    manifest,
    localFiles,
    prevSyncedPaths,
    maxSize = BLOB_SYNC_MAX_SIZE,
  } = inputs;

  const toDownload: BlobSyncActions["toDownload"] = [];
  const toUpload: string[] = [];
  const toDelete: string[] = [];
  const skippedDownload: BlobSyncActions["skippedDownload"] = [];
  const skippedUpload: BlobSyncActions["skippedUpload"] = [];

  const blobEntries = Object.entries(manifest).filter(([, e]) => e.type === "blob");
  const manifestBlobPaths = new Set(blobEntries.map(([p]) => p));
  const prevSet = new Set(prevSyncedPaths);
  const localByPath = new Map(localFiles.map(f => [f.path, f] as const));

  for (const [blobPath, entry] of blobEntries) {
    const local = localByPath.get(blobPath);
    const action = manifestBlobAction(entry, local, maxSize);
    if (action === "skip-download") {
      skippedDownload.push({ path: blobPath, size: entry.size });
    } else if (action === "download") {
      toDownload.push({ path: blobPath, entry });
    }
  }

  for (const local of localFiles) {
    if (manifestBlobPaths.has(local.path) || prevSet.has(local.path)) continue;
    if (local.size > maxSize) {
      skippedUpload.push({ path: local.path, size: local.size });
      continue;
    }
    toUpload.push(local.path);
  }

  for (const prevPath of prevSyncedPaths) {
    if (!manifestBlobPaths.has(prevPath) && localByPath.has(prevPath)) {
      toDelete.push(prevPath);
    }
  }

  return { toDownload, toUpload, toDelete, skippedDownload, skippedUpload };
}

function pathExists(p: string): boolean {
  return fs.existsSync(p);
}


async function withBlobDirectory<T>(
  root: string,
  parts: string[],
  create: boolean,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const handles: FileHandle[] = [];
  let directory = root;
  try {
    for (const part of parts) {
      if (create) await mkdir(path.join(directory, part)).catch(error => {
        if (error.code !== "EEXIST") throw error;
      });
      directory = path.join(directory, part);
      const handle = await open(directory, flags);
      handles.push(handle);
      if (process.platform === "linux") directory = `/proc/self/fd/${handle.fd}`;
    }
    return await operation(directory);
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

function statOrNull(filePath: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function mimeTypeForPath(relativePath: string): string {
  const ext = path.extname(relativePath).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MIME_TYPES, ext)
    ? MIME_TYPES[ext as keyof typeof MIME_TYPES]
    : "application/octet-stream";
}

export function listFilesRecursive(dir: string, base: string): string[] {
  if (!pathExists(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full, base));
    } else {
      results.push(path.relative(base, full));
    }
  }
  return results;
}

function discoverLocalFiles(blobsDir: string): LocalFile[] {
  const relPaths = listFilesRecursive(blobsDir, blobsDir);
  const files: LocalFile[] = [];
  for (const rel of relPaths) {
    const stats = statOrNull(path.join(blobsDir, rel));
    if (!stats) continue;
    files.push({ path: rel, mtimeMs: stats.mtimeMs, size: stats.size });
  }
  return files;
}

function recordUpload(
  manifest: Manifest,
  relativePath: string,
  slug: string,
  size: number,
): void {
  const mimeType = mimeTypeForPath(relativePath);
  Object.defineProperty(manifest, relativePath, {
    value: {
      type: "blob",
      gcsPath: `customers/${slug}/${relativePath}`,
      size,
      mimeType,
      uploadedAt: new Date().toISOString(),
    },
    enumerable: true,
    configurable: true,
    writable: true,
  });
}


export async function blobSyncAllWithOptions(opts: BlobSyncAllOptions): Promise<void> {
  if (!pathExists(CUSTOMERS_DIR)) return;

  const slugs = fs.readdirSync(CUSTOMERS_DIR).filter(d => {
    return fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory();
  });

  const failures: string[] = [];
  for (const slug of slugs) {
    try {
      await blobSyncForSlug(slug, {
        store: await opts.storeForSlug(slug),
        strict: opts.strict,
      });
    } catch (err) {
      log(`⚠ [blob-sync] ${slug}: ${err}`);
      failures.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (opts.strict && failures.length > 0) {
    throw new Error(`[blob-sync] durable flush failed: ${failures.join("; ")}`);
  }
}

function loadPrevSyncState(syncStatePath: string): string[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(syncStatePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("invalid blob sync state file");
    const state: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!Array.isArray(state) || !state.every(key => typeof key === "string" && isManifestPath(key))) {
      throw new Error("invalid blob sync state entries");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`⚠ [blob-sync] could not load sync state: ${error}`);
    }
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function gcsPrefixForSlug(slug: string): string {
  return `customers/${slug}`;
}

export async function blobSyncForSlug(slug: string, opts: BlobSyncOptions): Promise<void> {
  if (!isManifestPath(slug) || slug.includes("/")) throw new Error("invalid blob workspace slug");
  const store = opts.store;
  await mkdir(CUSTOMERS_DIR, { recursive: true });
  await withBlobDirectory(fs.realpathSync(CUSTOMERS_DIR), [slug, ".blobs"], true, blobsDir =>
    syncBlobDirectory(slug, blobsDir, store, opts.strict));
}

async function syncBlobDirectory(
  slug: string, blobsDir: string, store: BlobStore, strict?: boolean,
): Promise<void> {
  const manifestStore = store.manifestFor(slug);
  const manifest = await readManifest(manifestStore, gcsPrefixForSlug(slug));
  const syncStatePath = path.join(blobsDir, ".sync-state.json");
  const prevSyncedPaths = loadPrevSyncState(syncStatePath);
  const localFiles = discoverLocalFiles(blobsDir);
  const actions = computeBlobSyncActions({ manifest, localFiles, prevSyncedPaths });

  for (const { path: p, size } of actions.skippedDownload) {
    log(`⚠ [blob-sync] ${slug}: skipping ${p} (${mb(size)}MB > ${mb(BLOB_SYNC_MAX_SIZE)}MB)`);
  }
  for (const { path: p, size } of actions.skippedUpload) {
    log(`⚠ [blob-sync] ${slug}: skipping upload ${p} (${mb(size)}MB > ${mb(BLOB_SYNC_MAX_SIZE)}MB)`);
  }

  const downloads = await runDownloads(slug, blobsDir, actions.toDownload, store);
  const uploads = await runUploads(slug, blobsDir, actions.toUpload, store);
  const failures = [...downloads.failures, ...uploads.failures];
  if (strict && failures.length > 0) {
    throw new Error(failures.join("; "));
  }
  const cleanupCount = await runCleanup(blobsDir, actions.toDelete);

  if (uploads.count > 0) {
    await putManifestEntries(manifestStore, gcsPrefixForSlug(slug), uploads.recorded);
    Object.assign(manifest, uploads.recorded);
  }
  replaceFileAtomically(syncStatePath, JSON.stringify(Object.keys(manifest)));

  logSummary(slug, {
    downloadCount: downloads.count,
    uploadCount: uploads.count,
    cleanupCount,
  });
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

async function runDownloads(
  slug: string,
  blobsDir: string,
  queue: BlobSyncActions["toDownload"],
  store: BlobStore,
): Promise<{ count: number; failures: string[] }> {
  let count = 0;
  const failures: string[] = [];
  for (let i = 0; i < queue.length; i += BLOB_SYNC_MAX_CONCURRENT) {
    const batch = queue.slice(i, i + BLOB_SYNC_MAX_CONCURRENT);
    await Promise.all(batch.map(async ({ path: blobPath, entry }) => {
      const parts = blobPath.split("/");
      const name = parts.pop()!;
      try {
        await withBlobDirectory(blobsDir, parts, true, async directory => {
          const destination = path.join(directory, name);
          const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
          if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error("unsafe blob destination");
          await store.download({ slug, relativePath: blobPath, gcsPath: entry.gcsPath, destination, size: entry.size });
        });
        count++;
      } catch (err) {
        log(`⚠ [blob-sync] ${slug}: failed to download ${blobPath}: ${err}`);
        failures.push(`download ${blobPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }));
  }
  return { count, failures };
}

async function runUploads(
  slug: string,
  blobsDir: string,
  queue: string[],
  store: BlobStore,
): Promise<{ count: number; failures: string[]; recorded: Manifest }> {
  let count = 0;
  const failures: string[] = [];
  const recorded: Manifest = {};
  for (const relativePath of queue) {
    if (!isManifestPath(relativePath)) continue;
    const parts = relativePath.split("/");
    const name = parts.pop()!;
    try {
      await withBlobDirectory(blobsDir, parts, false, async directory => {
        const localPath = path.join(directory, name);
        const stats = statOrNull(localPath);
        if (!stats) return;
        const gcsPath = `customers/${slug}/${relativePath}`;
        const mimeType = mimeTypeForPath(relativePath);
        await store.upload({ slug, relativePath, gcsPath, localPath, mimeType, size: stats.size });
        recordUpload(recorded, relativePath, slug, stats.size);
        count++;
      });
    } catch (err) {
      log(`⚠ [blob-sync] ${slug}: failed to upload ${relativePath}: ${err}`);
      failures.push(`upload ${relativePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { count, failures, recorded };
}

async function runCleanup(blobsDir: string, toDelete: string[]): Promise<number> {
  let count = 0;
  for (const relativePath of toDelete) {
    const parts = relativePath.split("/");
    const name = parts.pop()!;
    await withBlobDirectory(blobsDir, parts, false, async directory => {
      try {
        fs.unlinkSync(path.join(directory, name));
        count++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
  }
  return count;
}

function logSummary(
  slug: string,
  counts: { downloadCount: number; uploadCount: number; cleanupCount: number },
): void {
  if (counts.downloadCount === 0 && counts.uploadCount === 0 && counts.cleanupCount === 0) {
    dlog(`[blob-sync] ${slug} up to date`);
    return;
  }
  const parts: string[] = [];
  if (counts.downloadCount) parts.push(`${counts.downloadCount} downloaded`);
  if (counts.uploadCount) parts.push(`${counts.uploadCount} uploaded`);
  if (counts.cleanupCount) parts.push(`${counts.cleanupCount} cleaned up`);
  log(`[blob-sync] ${slug}: ${parts.join(", ")}`);
}
