import { blobStatus, type BlobStore } from "./blob-store.js";
import { createGcsBlobStore } from "./gcs-blob-store.js";
import { db } from "./db.js";
import { gcsBucket } from "./gcs-bucket.js";
import { platformStateStore } from "./platform-state.js";
import { uploadProjectBlobViaBroker, uploadWorkspaceBlobViaBroker } from "./project-blob-upload.js";
import { createHash } from "node:crypto";
import { isManifestPath } from "@octogee/core/workspace-manifest";
import { readPlatformFreeConfig } from "./platform-free-config.js";
import { logger } from "../middleware/logging.js";
import {
  getManifestForQuota,
  manifestStoreForBlobs,
  updateManifest,
  removeFromManifest,
} from "./manifest.js";
import type { FileTarget } from "./fileTarget.js";

export interface WorkspaceBlobTarget {
  slug: string;
  projectSlug: string | null;
  gcsPrefix: string;
  blobStore?: BlobStore;
  provider?: FileTarget["provider"];
  org?: string;
  repoName?: string;
}

function invalidateListingCacheIfAddressable(target: WorkspaceBlobTarget): void {
  if (!target.provider || target.org === undefined || target.repoName === undefined) return;
  invalidateWorkspaceFileResponseCache(target as FileTarget);
}
import {
  getExtension,
  getMimeType,
  IMAGE_EXTENSIONS,
} from "../routes/workspace/helpers.js";
import { invalidateWorkspaceFileResponseCache } from "../routes/workspace/file-response-cache.js";
import { freeWorkspaceStorageLimitBytes } from "./free-storage.js";
import {
  finalizeWorkspaceStorageReservation,
  releaseWorkspaceStorage,
  reserveWorkspaceStorage,
  rollbackWorkspaceStorageReservation,
  type WorkspaceStorageReservation,
} from "./workspace-storage-quota.js";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export { WorkspaceStorageQuotaError } from "./workspace-storage-quota.js";

export interface StoredWorkspaceBlob {
  gcsPath: string;
  size: number;
  thumbnailUrl?: string;
  thumbnailError?: string;
  sha256?: string;
}

export interface WorkspaceBlobOptions {
  maxStorageBytes?: number;
  immutable?: boolean;
  blobStore?: BlobStore;
}

export const BLOB_SIGNED_URL_TTL_MS = 60 * 60 * 1000;

interface ThumbnailResult {
  hasThumbnail?: boolean;
  thumbnailUrl?: string;
  thumbnailError?: string;
}

async function configuredWorkspaceStorageLimitBytes(
  target: WorkspaceBlobTarget,
): Promise<number | undefined> {
  if (target.projectSlug !== null) return undefined;
  const ownerUid = (await platformStateStore.workspaces.records.get(target.slug))?.ownerUid;
  if (!ownerUid) throw new Error(`workspace ${target.slug} has no storage owner`);
  const [owner, config] = await Promise.all([
    db.doc(`users/${ownerUid}`).get(),
    readPlatformFreeConfig(),
  ]);
  if (!owner.exists) throw new Error(`workspace storage owner ${ownerUid} was not found`);
  return freeWorkspaceStorageLimitBytes(owner.data() ?? {}, false, config);
}

async function reserveBlobStorage(
  target: WorkspaceBlobTarget,
  filePath: string,
  fileSize: number,
  options: WorkspaceBlobOptions,
): Promise<WorkspaceStorageReservation | null> {
  const { blobStore, maxStorageBytes } = options;
  const limitBytes = maxStorageBytes ?? await configuredWorkspaceStorageLimitBytes(target);
  if (limitBytes === undefined) return null;
  const manifest = await getManifestForQuota(target.gcsPrefix, blobStore ? manifestStoreForBlobs(blobStore) : undefined);
  const currentBytes = Object.values(manifest)
    .reduce((sum, entry) => sum + entry.size, 0);
  return reserveWorkspaceStorage(db, {
    slug: target.slug,
    path: filePath,
    newSize: fileSize,
    manifestBytes: currentBytes,
    manifestPathBytes: manifest[filePath]?.size ?? 0,
    limitBytes,
  });
}

async function createBlobThumbnail(
  target: WorkspaceBlobTarget,
  filePath: string,
  fileBuffer: Buffer,
  extension: string,
  blobs: BlobStore,
): Promise<ThumbnailResult> {
  if (!IMAGE_EXTENSIONS.has(extension)) return {};
  try {
    const sharp = (await import("sharp")).default;
    const thumbBuffer = await sharp(fileBuffer)
      .resize(128, 128, { fit: "inside" })
      .png()
      .toBuffer();
    const key = `${target.gcsPrefix}/.thumbs/${filePath}.png`;
    await blobs.save(key, thumbBuffer, { contentType: "image/png" });
    const { url } = await blobs.signedUrl({ gcsPath: key, action: "read" }, Date.now() + BLOB_SIGNED_URL_TTL_MS);
    return { hasThumbnail: true, thumbnailUrl: url };
  } catch (error) {
    const thumbnailError = error instanceof Error ? error.message : String(error);
    logger.warn(`Thumbnail generation failed for ${filePath}: ${thumbnailError}`);
    return { thumbnailError };
  }
}

async function rollbackReservation(
  reservation: WorkspaceStorageReservation | null,
  error: unknown,
): Promise<never> {
  if (!reservation) throw error;
  try {
    await rollbackWorkspaceStorageReservation(db, reservation);
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      "workspace blob write failed and its storage reservation could not be rolled back",
    );
  }
  throw error;
}

async function saveBlobObject(blobs: BlobStore, key: string, fileBuffer: Buffer, contentType: string, sha256?: string): Promise<void> {
  try {
    await blobs.save(key, fileBuffer, { contentType, ...(sha256 ? { ifGenerationMatch: 0 } : {}) });
  } catch (error) {
    if (!sha256 || blobStatus(error) !== "412") throw error;
  }
  if (sha256) {
    const metadata = await blobs.metadata(key);
    // eslint-disable-next-line sonarjs/hashing -- transport checksum; immutable identity uses SHA-256
    if (Number(metadata.size) !== fileBuffer.length || metadata.md5Hash !== createHash("md5").update(fileBuffer).digest("base64")) {
      throw new Error("immutable asset size or checksum mismatch");
    }
  }
}

/**
 * The single way a binary lands in a workspace: save to GCS, generate a 128²
 * thumbnail for images, and write the `.files/manifest.json` placeholder in
 * Gitea. GCS durability + boot-time recovery come for free via blob-sync, and
 * the Files view reads the manifest. Used by `/upload-blob` and by the agent
 * avatar path — one path, no duplication.
 */
export async function storeWorkspaceBlob(
  target: WorkspaceBlobTarget,
  filePath: string,
  fileBuffer: Buffer,
  mimeType?: string,
  options: WorkspaceBlobOptions = {},
): Promise<StoredWorkspaceBlob> {
  const ext = getExtension(filePath);
  const contentType = mimeType || getMimeType(ext);
  const blobStore = options.blobStore ?? target.blobStore;
  if (blobStore) return storeWorkspaceBlobCentrally(target, filePath, fileBuffer, contentType, { ...options, blobStore });
  if (options.immutable && process.env.FLEET_BROKER_URL) {
    return uploadProjectBlobViaBroker(process.env.FLEET_BROKER_URL, target, fileBuffer, contentType);
  }
  if (target.projectSlug === null && (process.env.GATEWAY_CLASS === "shared" || isIsolatedGatewayClassValue(process.env.GATEWAY_CLASS))) {
    if (!process.env.FLEET_BROKER_URL) throw new Error("workspace blob upload requires its configured fleet broker");
    return uploadWorkspaceBlobViaBroker(process.env.FLEET_BROKER_URL, target, filePath, fileBuffer, contentType);
  }
  return storeWorkspaceBlobCentrally(target, filePath, fileBuffer, contentType, options);
}

function validateBlobTarget(target: WorkspaceBlobTarget, filePath: string, blobs?: BlobStore): void {
  if (!isManifestPath(filePath)) throw new Error("invalid workspace blob path");
  if (blobs && target.projectSlug === null && filePath.split("/")[0] === "projects") {
    throw new Error("project paths require a project upload target");
  }
}

export async function storeWorkspaceBlobCentrally(
  target: WorkspaceBlobTarget,
  filePath: string,
  fileBuffer: Buffer,
  mimeType?: string,
  options: WorkspaceBlobOptions = {},
): Promise<StoredWorkspaceBlob> {
  validateBlobTarget(target, filePath, options.blobStore);
  const ext = getExtension(filePath);
  const contentType = mimeType || getMimeType(ext);
  const sha256 = options.immutable ? createHash("sha256").update(fileBuffer).digest("hex") : undefined;
  const reservation = await reserveBlobStorage(target, filePath, fileBuffer.length, options);
  try {
    const blobs = options.blobStore ?? createGcsBlobStore(gcsBucket);
    const gcsPath = sha256 ? `${target.gcsPrefix}/.objects/${sha256}` : `${target.gcsPrefix}/${filePath}`;
    await saveBlobObject(blobs, gcsPath, fileBuffer, contentType, sha256);

    const { hasThumbnail, thumbnailUrl, thumbnailError } = await createBlobThumbnail(
      target,
      filePath,
      fileBuffer,
      ext,
      blobs,
    );

    const entries = {
      [filePath]: {
        type: "blob" as const,
        gcsPath,
        size: fileBuffer.length,
        mimeType: contentType,
        uploadedAt: new Date().toISOString(),
        ...(sha256 ? { sha256 } : {}),
        ...(hasThumbnail ? { hasThumbnail: true } : {}),
      },
    };
    await updateManifest(target.gcsPrefix, entries, options.blobStore && manifestStoreForBlobs(options.blobStore));
    if (reservation) await finalizeWorkspaceStorageReservation(db, reservation);
    invalidateListingCacheIfAddressable(target);

    return {
      gcsPath,
      size: fileBuffer.length,
      ...(sha256 ? { sha256 } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(thumbnailError ? { thumbnailError } : {}),
    };
  } catch (error) {
    return rollbackReservation(reservation, error);
  }
}

/** Remove a workspace blob, its thumbnail, and its manifest entry — no orphans. */
export async function removeWorkspaceBlob(target: WorkspaceBlobTarget, filePath: string): Promise<void> {
  const manifests = target.blobStore && manifestStoreForBlobs(target.blobStore);
  const manifest = target.projectSlug === null ? await getManifestForQuota(target.gcsPrefix, manifests) : {};
  const removedBytes = manifest[filePath]?.size ?? 0;
  const blobs = target.blobStore ?? createGcsBlobStore(gcsBucket);
  await blobs.delete(`${target.gcsPrefix}/${filePath}`);
  if (IMAGE_EXTENSIONS.has(getExtension(filePath))) {
    await blobs.delete(`${target.gcsPrefix}/.thumbs/${filePath}.png`);
  }
  await removeFromManifest(target.gcsPrefix, filePath, manifests);
  if (target.projectSlug === null && removedBytes > 0) {
    await releaseWorkspaceStorage(db, {
      slug: target.slug,
      path: filePath,
      removedBytes,
    });
  }
  invalidateListingCacheIfAddressable(target);
}
