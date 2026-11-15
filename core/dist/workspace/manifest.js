import { blobStatus } from "./blob-store.js";
import { createGcsManifestStore, ManifestGenerationConflict, putManifestEntries, readManifest, removeManifestEntries, } from "../workspace-manifest.js";
import { logger } from "../http/logging.js";
import { gcsBucket } from "./gcs-bucket.js";
const MANIFEST_TTL_MS = 60_000;
const manifestCache = new Map();
function store() {
    return createGcsManifestStore(gcsBucket());
}
export function manifestStoreForBlobs(blobs) {
    return {
        async read(key) {
            const object = await blobs.download(key);
            return object && { contents: object.bytes.toString("utf8"), generation: object.revision };
        },
        async write(key, contents, ifGenerationMatch) {
            try {
                await blobs.save(key, contents, { contentType: "application/json", ifGenerationMatch });
            }
            catch (error) {
                if (blobStatus(error) === "412")
                    throw new ManifestGenerationConflict(key);
                throw error;
            }
        },
    };
}
export async function getManifest(gcsPrefix, bustCache = false, blobs) {
    if (blobs)
        return readManifest(manifestStoreForBlobs(blobs), gcsPrefix);
    if (!bustCache) {
        const cached = manifestCache.get(gcsPrefix);
        if (cached && Date.now() - cached.ts < MANIFEST_TTL_MS)
            return cached.data;
    }
    let data;
    try {
        data = await readManifest(store(), gcsPrefix);
    }
    catch (err) {
        logger.error("blob manifest unreadable; listing blobs as empty", { err, gcsPrefix });
        return {};
    }
    manifestCache.set(gcsPrefix, { data, ts: Date.now() });
    return data;
}
export async function getManifestForQuota(gcsPrefix, manifests = store()) {
    return readManifest(manifests, gcsPrefix);
}
export async function updateManifest(gcsPrefix, entries, manifests = store()) {
    await putManifestEntries(manifests, gcsPrefix, entries);
    manifestCache.delete(gcsPrefix);
}
export async function removeFromManifest(gcsPrefix, paths, manifests = store()) {
    await removeManifestEntries(manifests, gcsPrefix, paths);
    manifestCache.delete(gcsPrefix);
}
export function invalidateManifestCache(gcsPrefix) {
    manifestCache.delete(gcsPrefix);
}
