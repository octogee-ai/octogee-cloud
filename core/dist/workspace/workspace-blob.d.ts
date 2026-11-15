import { type BlobStore } from "./blob-store.js";
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
export { WorkspaceStorageQuotaError } from "@octogee/shared/types/workspace-storage-quota";
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
export declare const BLOB_SIGNED_URL_TTL_MS: number;
/**
 * The single way a binary lands in a workspace: save to GCS, generate a 128²
 * thumbnail for images, and write the `.files/manifest.json` placeholder in
 * Gitea. GCS durability + boot-time recovery come for free via blob-sync, and
 * the Files view reads the manifest. Used by `/upload-blob` and by the agent
 * avatar path — one path, no duplication.
 */
export declare function storeWorkspaceBlob(target: WorkspaceBlobTarget, filePath: string, fileBuffer: Buffer, mimeType?: string, options?: WorkspaceBlobOptions): Promise<StoredWorkspaceBlob>;
export declare function storeWorkspaceBlobCentrally(target: WorkspaceBlobTarget, filePath: string, fileBuffer: Buffer, mimeType?: string, options?: WorkspaceBlobOptions): Promise<StoredWorkspaceBlob>;
/** Remove a workspace blob, its thumbnail, and its manifest entry — no orphans. */
export declare function removeWorkspaceBlob(target: WorkspaceBlobTarget, filePath: string): Promise<void>;
