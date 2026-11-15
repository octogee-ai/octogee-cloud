import { type BlobStore } from "./blob-store.js";
import { type Manifest, type ManifestEntry, type ManifestStore } from "../workspace-manifest.js";
export type { Manifest, ManifestEntry };
export declare function manifestStoreForBlobs(blobs: BlobStore): ManifestStore;
export declare function getManifest(gcsPrefix: string, bustCache?: boolean, blobs?: BlobStore): Promise<Manifest>;
export declare function getManifestForQuota(gcsPrefix: string, manifests?: ManifestStore): Promise<Manifest>;
export declare function updateManifest(gcsPrefix: string, entries: Manifest, manifests?: ManifestStore): Promise<void>;
export declare function removeFromManifest(gcsPrefix: string, paths: string | string[], manifests?: ManifestStore): Promise<void>;
export declare function invalidateManifestCache(gcsPrefix: string): void;
