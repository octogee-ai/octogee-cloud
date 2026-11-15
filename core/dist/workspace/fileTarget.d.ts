import type { Request, Response, NextFunction, RequestHandler } from "express";
import { type BlobStore } from "./blob-store.js";
export interface FileTarget {
    slug: string;
    projectSlug: string | null;
    provider: "gitea" | "github";
    org: string;
    repoName: string;
    gcsPrefix: string;
    blobStore?: BlobStore;
    githubToken?: string;
    cacheAuthority?: string;
    sudoUser?: string;
    brokered?: boolean;
    workspaceMemberBrokered?: boolean;
    canvasFile?: string;
}
export interface FileTargetInput {
    slug: string | null | undefined;
    projectSlug: string | null | undefined;
    callerUid: string | undefined;
    callerWorkspaceSlug: string | null | undefined;
}
export type FileTargetResult = {
    ok: true;
    target: FileTarget;
} | {
    ok: false;
    status: 400 | 403 | 404 | 409 | 422;
    error: string;
    reason?: string;
};
export interface ResolveFileTargetOpts {
    resolveGithubToken?: boolean;
    allowWorkspaceMembers?: boolean;
    access?: "read" | "write";
}
export declare function resolveFileTarget(input: FileTargetInput, opts?: ResolveFileTargetOpts): Promise<FileTargetResult>;
export type TargetedHandler = (req: Request, res: Response, next: NextFunction, target: FileTarget) => Promise<void>;
export declare function withFileTarget(handler: TargetedHandler, opts?: ResolveFileTargetOpts): RequestHandler;
export declare function withGiteaTarget(handler: TargetedHandler, opts?: ResolveFileTargetOpts): RequestHandler;
