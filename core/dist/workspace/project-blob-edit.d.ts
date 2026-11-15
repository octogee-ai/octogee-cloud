import { type Manifest, type ManifestEntry } from "../workspace-manifest.js";
import type { FileTarget } from "./fileTarget.js";
import { type WorkspaceBlobOptions, type StoredWorkspaceBlob } from "./workspace-blob.js";
import { divertWorktreeBinaries } from "./binary-diversion.js";
interface RemoteAssetDeps {
    read(target: FileTarget): Promise<unknown>;
    write(target: FileTarget, body: {
        sha?: string;
        message: string;
        content: string;
    }): Promise<unknown>;
    readLegacy(prefix: string): Promise<Manifest>;
}
export declare function editRemoteProjectAsset(target: FileTarget, name: string, entry: ManifestEntry | null, deps?: RemoteAssetDeps): Promise<void>;
interface LocalProjectAssetInput {
    target: FileTarget;
    dir: string;
    name: string;
    contents: Buffer | null;
    upload: () => Promise<StoredWorkspaceBlob>;
    mimeType?: string;
    divert?: typeof divertWorktreeBinaries;
}
export declare function commitLocalProjectAsset(input: LocalProjectAssetInput): Promise<StoredWorkspaceBlob | undefined>;
export declare function storeUploadedWorkspaceBlob(target: FileTarget, name: string, contents: Buffer, mimeType?: string, options?: WorkspaceBlobOptions): Promise<StoredWorkspaceBlob>;
export declare function removeUploadedWorkspaceBlob(target: FileTarget, name: string): Promise<void>;
export {};
