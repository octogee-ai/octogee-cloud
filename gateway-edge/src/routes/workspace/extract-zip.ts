import { storeUploadedWorkspaceBlob as storeWorkspaceBlob } from "../../lib/project-blob-edit.js";
import { Router, Request, Response, NextFunction } from "express";
import JSZip from "jszip";
import { requestBlobStore, type BlobStore } from "../../lib/blob-store.js";
import { gcsBucket } from "../../lib/gcs-bucket.js";
import { logger } from "../../middleware/logging.js";
import { manifestStoreForBlobs, removeFromManifest } from "../../lib/manifest.js";
import { giteaApiAsUser } from "../../lib/gitea.js";
import { workspaceGiteaOrg, workspaceRepoName } from "@octogee/core/gitea-naming";
import {
  WorkspaceStorageQuotaError,
} from "../../lib/workspace-blob.js";
import type { FileTarget } from "../../lib/fileTarget.js";
import {
  ensureSlug,
  getExtension,
  getMimeType,
  isTextFile,
  validateWorkspacePath,
} from "./helpers.js";

const router = Router();
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_DECOMPRESSED_BYTES = 500 * 1024 * 1024;

type ExtractedKind = "git" | "blob";

export interface ZipEntryLike {
  dir: boolean;
  async(format: "nodebuffer"): Promise<Buffer>;
}

export interface SafeZipEntry<T extends ZipEntryLike> {
  relativePath: string;
  targetPath: string;
  zipEntry: T;
}

export type ZipEntriesValidation<T extends ZipEntryLike> =
  | { ok: true; entries: Array<SafeZipEntry<T>> }
  | { ok: false; status: 400 | 413; error: string };

interface ExtractZipContext {
  slug: string;
  zipPath: string;
  zip: { download(): Promise<Buffer | null>; delete(): Promise<unknown> };
  org: string;
  sudoUser: string;
  repoName: string;
  target: FileTarget;
}

interface ExtractZipResult {
  gitPaths: string[];
  blobPaths: string[];
}

interface WrittenEntry {
  kind: ExtractedKind;
  path: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function extractedZipBaseDir(zipPath: string): string {
  const zipName = zipPath.split("/").pop()?.replace(/\.zip$/i, "") ?? "extracted";
  return zipPath.includes("/")
    ? zipPath.slice(0, zipPath.lastIndexOf("/") + 1) + zipName
    : zipName;
}

export function validatedZipEntries<T extends ZipEntryLike>(
  zipFiles: Record<string, T>,
  baseDir: string,
): ZipEntriesValidation<T> {
  const fileEntries = Object.entries(zipFiles).filter(([, entry]) => !entry.dir);
  if (fileEntries.length > MAX_ENTRIES) {
    return {
      ok: false,
      status: 413,
      error: `Archive has ${fileEntries.length} entries (max ${MAX_ENTRIES})`,
    };
  }

  const entries: Array<SafeZipEntry<T>> = [];
  for (const [relativePath, zipEntry] of fileEntries) {
    if (relativePath.startsWith("__MACOSX/") || relativePath.includes("/.DS_Store")) continue;

    const targetPath = `${baseDir}/${relativePath}`;
    const targetPathError = validateWorkspacePath(targetPath);
    if (targetPathError) {
      return {
        ok: false,
        status: 400,
        error: `Blocked entry "${relativePath}": ${targetPathError}`,
      };
    }

    entries.push({ relativePath, targetPath, zipEntry });
  }

  return { ok: true, entries };
}

function zipObject(key: string, blobs?: BlobStore): ExtractZipContext["zip"] {
  if (blobs) {
    return {
      download: async () => (await blobs.download(key))?.bytes ?? null,
      delete: () => blobs.delete(key),
    };
  }
  const file = gcsBucket().file(key);
  return { download: async () => (await file.download())[0], delete: () => file.delete() };
}

function extractZipContext(slug: string, zipPath: string, blobStore?: BlobStore): ExtractZipContext {
  const gcsZipPath = `customers/${slug}/${zipPath}`;
  return {
    slug,
    zipPath,
    zip: zipObject(gcsZipPath, blobStore),
    org: workspaceGiteaOrg(slug),
    sudoUser: `ws-${slug}`,
    repoName: workspaceRepoName(),
    target: {
      slug,
      projectSlug: null,
      provider: "gitea",
      org: workspaceGiteaOrg(slug),
      repoName: workspaceRepoName(),
      gcsPrefix: `customers/${slug}`,
      blobStore,
      sudoUser: `ws-${slug}`,
      brokered: false,
      canvasFile: "README.md",
    },
  };
}

function requestZipPath(req: Request, res: Response): string | null {
  const { zipPath } = req.body as { zipPath: string };
  if (!zipPath) {
    res.status(400).json({ error: "Missing zipPath" });
    return null;
  }

  const zipPathError = validateWorkspacePath(zipPath);
  if (zipPathError) {
    res.status(400).json({ error: `Invalid zipPath: ${zipPathError}` });
    return null;
  }

  return zipPath;
}

async function loadZipArchive(context: ExtractZipContext, res: Response): Promise<JSZip | null> {
  const zipBuffer = await context.zip.download();
  if (!zipBuffer) {
    res.status(404).json({ error: "Archive not found" });
    return null;
  }
  if (zipBuffer.length > MAX_ARCHIVE_BYTES) {
    res.status(413).json({ error: "Archive exceeds 200MB limit" });
    return null;
  }

  return JSZip.loadAsync(zipBuffer);
}

async function existingTextSha(context: ExtractZipContext, targetPath: string): Promise<string | undefined> {
  try {
    const existing = (await giteaApiAsUser(
      context.sudoUser,
      context.org,
      `${context.repoName}/contents/${targetPath}`,
    )) as { sha?: string };
    return existing.sha;
  } catch (e) {
    if (errorMessage(e).includes("404")) return undefined;
    logger.warn(`Failed to read existing ZIP entry SHA for ${targetPath}: ${errorMessage(e)}`);
    return undefined;
  }
}

async function writeTextEntry(
  context: ExtractZipContext,
  entry: SafeZipEntry<ZipEntryLike>,
  fileBuffer: Buffer,
): Promise<WrittenEntry> {
  const sha = await existingTextSha(context, entry.targetPath);
  await giteaApiAsUser(context.sudoUser, context.org, `${context.repoName}/contents/${entry.targetPath}`, "PUT", {
    message: `zip-extract: ${entry.relativePath}`,
    content: fileBuffer.toString("base64"),
    ...(sha ? { sha } : {}),
  });

  return { kind: "git", path: entry.targetPath };
}

async function writeBlobEntry(
  context: ExtractZipContext,
  entry: SafeZipEntry<ZipEntryLike>,
  fileBuffer: Buffer,
): Promise<WrittenEntry> {
  const ext = getExtension(entry.relativePath);
  const mimeType = getMimeType(ext);
  await storeWorkspaceBlob(context.target, entry.targetPath, fileBuffer, mimeType);

  return { kind: "blob", path: entry.targetPath };
}

async function writeExtractedEntry(
  context: ExtractZipContext,
  entry: SafeZipEntry<ZipEntryLike>,
  fileBuffer: Buffer,
): Promise<WrittenEntry> {
  if (isTextFile(entry.relativePath)) {
    return writeTextEntry(context, entry, fileBuffer);
  }

  return writeBlobEntry(context, entry, fileBuffer);
}

function entrySizeError(relativePath: string, fileSize: number, totalSize: number): string | null {
  if (fileSize > MAX_ENTRY_BYTES) {
    return `Entry "${relativePath}" exceeds ${MAX_ENTRY_BYTES} bytes`;
  }

  if (totalSize > MAX_DECOMPRESSED_BYTES) {
    return `Total decompressed size exceeds ${MAX_DECOMPRESSED_BYTES} bytes`;
  }

  return null;
}

async function extractEntries(
  context: ExtractZipContext,
  entries: Array<SafeZipEntry<ZipEntryLike>>,
  res: Response,
): Promise<ExtractZipResult | null> {
  const result: ExtractZipResult = { gitPaths: [], blobPaths: [] };
  let totalDecompressedBytes = 0;

  for (const entry of entries) {
    const fileBuffer = await entry.zipEntry.async("nodebuffer");
    totalDecompressedBytes += fileBuffer.length;

    const sizeError = entrySizeError(entry.relativePath, fileBuffer.length, totalDecompressedBytes);
    if (sizeError) {
      res.status(413).json({ error: sizeError });
      return null;
    }

    const written = await writeExtractedEntry(context, entry, fileBuffer);
    if (written.kind === "git") {
      result.gitPaths.push(written.path);
    } else {
      result.blobPaths.push(written.path);
    }
  }

  return result;
}

async function deleteOriginalZip(context: ExtractZipContext): Promise<void> {
  try {
    await context.zip.delete();
  } catch (e) {
    logger.warn(`Failed to delete ZIP after extraction: ${errorMessage(e)}`);
  }
}

async function finalizeExtraction(context: ExtractZipContext): Promise<void> {
  await deleteOriginalZip(context);
  const { blobStore, gcsPrefix } = context.target;
  await removeFromManifest(gcsPrefix, context.zipPath, blobStore && manifestStoreForBlobs(blobStore));
}

async function extractZip(req: Request, res: Response): Promise<void> {
  const slug = ensureSlug(req, res);
  if (!slug) return;

  const zipPath = requestZipPath(req, res);
  if (!zipPath) return;

  const context = extractZipContext(slug, zipPath, requestBlobStore(req));
  const zip = await loadZipArchive(context, res);
  if (!zip) return;

  const validation = validatedZipEntries(zip.files, extractedZipBaseDir(zipPath));
  if (!validation.ok) {
    res.status(validation.status).json({ error: validation.error });
    return;
  }

  const result = await extractEntries(context, validation.entries, res);
  if (!result) return;

  await finalizeExtraction(context);
  res.json({ success: true, extracted: { git: result.gitPaths, blob: result.blobPaths } });
}

router.post("/extract-zip", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await extractZip(req, res);
  } catch (e) {
    if (e instanceof WorkspaceStorageQuotaError) {
      res.status(413).json({
        error: "Free workspace storage allowance exceeded",
        code: e.code,
        limitBytes: e.limitBytes,
        projectedBytes: e.projectedBytes,
      });
      return;
    }
    next(e);
  }
});

export default router;
