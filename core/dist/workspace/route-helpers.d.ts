import type { Request, Response } from "express";
import type { FileTarget } from "./fileTarget.js";
import type { CommitAuthor } from "./workspace-git.js";
export declare const CANVAS_DASHBOARD_DOCUMENT_PATH = ".octogee/canvas.json";
export declare function isCanvasDashboardDocumentPath(path: string): boolean;
export declare function isBrokeredWritablePath(path: string, canvasFile: string | undefined): boolean;
export declare function isTargetPathWritable(target: FileTarget, path: string): boolean;
export declare function isTargetPathReadable(target: FileTarget, path: string): boolean;
export declare function isTargetDirectoryReadable(target: FileTarget, path: string): boolean;
export declare function isTargetDirectoryEntryReadable(target: FileTarget, path: string, type: "dir" | "file"): boolean;
export declare function resolveCommitAuthor(user: Record<string, unknown> | undefined, slug: string): CommitAuthor;
export declare function giteaSudoUser(target: FileTarget): string;
export declare function targetGiteaApi(target: FileTarget, path: string, method?: string, body?: unknown): Promise<unknown>;
export declare function repoContentsApi(target: FileTarget, filePath: string, ref?: string): Promise<unknown>;
export interface BranchInfo {
    name: string;
    isDefault: boolean;
}
export declare function repoDefaultBranch(target: FileTarget): Promise<string>;
export declare function repoBranchesApi(target: FileTarget): Promise<{
    branches: BranchInfo[];
    default: string;
}>;
export declare function repoTreeApi(target: FileTarget, ref: string): Promise<{
    paths: string[];
    truncated: boolean;
}>;
export interface LastCommit {
    message: string;
    date: string;
    authorName: string;
    sha: string;
}
export declare function repoCommitsApi(target: FileTarget, filePath: string, ref?: string): Promise<LastCommit | null>;
export declare const HIDDEN: Set<string>;
export declare function pathHasReservedOrHiddenSegment(filePath: string): string | null;
export declare function validateWorkspacePath(filePath: string): string | null;
export declare function validateEditableWorkspacePath(filePath: string): string | null;
export declare const EDITABLE_EXTENSIONS: Set<string>;
export declare const IMAGE_EXTENSIONS: Set<string>;
export declare function getExtension(filename: string): string;
export declare function getMimeType(ext: string): string;
export declare function isTextFile(filename: string): boolean;
export declare function ensureSlug(req: Request, res: Response): string | null;
