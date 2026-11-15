import { gitStatus } from "./workspace-git.js";
import { storeWorkspaceBlob, type WorkspaceBlobTarget } from "./workspace-blob.js";
export declare const BINARY_SNIFF_BYTES = 8000;
export declare const MAX_DIVERTED_BLOB_BYTES: number;
export declare function looksBinary(sample: Buffer): boolean;
export declare function isDivertablePath(relativePath: string): boolean;
export interface DivertedBlob {
    path: string;
    size: number;
}
export interface DivertBinariesResult {
    diverted: DivertedBlob[];
    failures: string[];
    failedPaths: string[];
}
export interface DivertBinariesDeps {
    gitStatus: typeof gitStatus;
    storeWorkspaceBlob: typeof storeWorkspaceBlob;
}
export declare function divertWorktreeBinaries(customerDir: string, target: WorkspaceBlobTarget, deps?: DivertBinariesDeps, options?: {
    retainLocalFiles?: boolean;
    excludePaths?: string[];
}): Promise<DivertBinariesResult>;
