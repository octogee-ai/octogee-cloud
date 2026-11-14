import { blobStatus, type BlobStore } from "./blob-store.js";
import {
  createGcsManifestStore,
  ManifestGenerationConflict,
  putManifestEntries,
  readManifest,
  removeManifestEntries,
  type Manifest,
  type ManifestEntry,
  type ManifestStore,
} from "@octogee/core/workspace-manifest";

import { logger } from "../middleware/logging.js";
import { gcsBucket } from "./gcs-bucket.js";

export type { Manifest, ManifestEntry };

const MANIFEST_TTL_MS = 60_000;

interface CacheEntry {
  data: Manifest;
  ts: number;
}

const manifestCache = new Map<string, CacheEntry>();

function store(): ManifestStore {
  return createGcsManifestStore(gcsBucket());
}

export function manifestStoreForBlobs(blobs: BlobStore): ManifestStore {
  return {
    async read(key) {
      const object = await blobs.download(key);
      return object && { contents: object.bytes.toString("utf8"), generation: object.revision };
    },
    async write(key, contents, ifGenerationMatch) {
      try {
        await blobs.save(key, contents, { contentType: "application/json", ifGenerationMatch });
      } catch (error) {
        if (blobStatus(error) === "412") throw new ManifestGenerationConflict(key);
        throw error;
      }
    },
  };
}

export async function getManifest(gcsPrefix: string, bustCache = false, blobs?: BlobStore): Promise<Manifest> {
  if (blobs) return readManifest(manifestStoreForBlobs(blobs), gcsPrefix);
  if (!bustCache) {
    const cached = manifestCache.get(gcsPrefix);
    if (cached && Date.now() - cached.ts < MANIFEST_TTL_MS) return cached.data;
  }
  let data: Manifest;
  try {
    data = await readManifest(store(), gcsPrefix);
  } catch (err) {
    logger.error("blob manifest unreadable; listing blobs as empty", { err, gcsPrefix });
    return {};
  }
  manifestCache.set(gcsPrefix, { data, ts: Date.now() });
  return data;
}

export async function getManifestForQuota(gcsPrefix: string, manifests = store()): Promise<Manifest> {
  return readManifest(manifests, gcsPrefix);
}

export async function updateManifest(gcsPrefix: string, entries: Manifest, manifests = store()): Promise<void> {
  await putManifestEntries(manifests, gcsPrefix, entries);
  manifestCache.delete(gcsPrefix);
}

export async function removeFromManifest(
  gcsPrefix: string,
  paths: string | string[],
  manifests = store(),
): Promise<void> {
  await removeManifestEntries(manifests, gcsPrefix, paths);
  manifestCache.delete(gcsPrefix);
}

export function invalidateManifestCache(gcsPrefix: string): void {
  manifestCache.delete(gcsPrefix);
}
