import { acquireWorkspaceMutationLeaseSync } from "../workspace-mutation-lease.js";
export type WorkspaceGitError = {
    code: "NOT_A_REPO";
    cwd: string;
} | {
    code: "CUSTOMER_DIR_MISSING";
    cwd: string;
} | {
    code: "TIMEOUT";
    cwd: string;
    durationMs: number;
} | {
    code: "GIT_FAILED";
    cwd: string;
    status: number;
    stderr: string;
} | {
    code: "OUTPUT_TOO_LARGE";
    cwd: string;
    cap: number;
} | {
    code: "WORKSPACE_BUSY";
    cwd: string;
} | {
    code: "BLOB_DIVERSION_FAILED";
    cwd: string;
    paths: string[];
} | {
    code: "INTERNAL";
    message: string;
};
export interface WorkspaceGitStatusEntry {
    path: string;
    change: "modified" | "added" | "deleted" | "untracked" | "renamed";
}
export interface WorkspaceGitLogEntry {
    sha: string;
    author: string;
    ts: number;
    subject: string;
}
export declare function isSafeSlug(slug: string): boolean;
export declare function resolveUserDir(usersRoot: string, slug: string): Promise<string | null>;
export declare function resolveProjectDir(usersRoot: string, slug: string, projectSlug: string): Promise<string | null>;
export declare function gitStatus(customerDir: string, options?: {
    untracked?: "normal" | "all";
}): Promise<{
    ok: true;
    entries: WorkspaceGitStatusEntry[];
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
export declare function gitDiff(customerDir: string, options?: {
    path?: string;
    ref?: string;
}): Promise<{
    ok: true;
    diff: string;
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
export declare function gitCommitDiff(customerDir: string, sha: string): Promise<{
    ok: true;
    diff: string;
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
export declare function gitLog(customerDir: string, options?: {
    limit?: number;
    branch?: string;
}): Promise<{
    ok: true;
    entries: WorkspaceGitLogEntry[];
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
export interface CommitAuthor {
    name: string;
    email: string;
}
export interface CommitResult {
    sha: string;
    empty: boolean;
}
export declare function gitCommit(customerDir: string, options: {
    message: string;
    author: CommitAuthor;
    excludePaths?: string[];
}): Promise<{
    ok: true;
    result: CommitResult;
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
export interface CommitAndPushResult {
    committed: boolean;
    pushed: boolean;
    nothingToCommit: boolean;
    commit?: string;
    pushError?: string;
}
export declare function gitHeadCommit(customerDir: string): Promise<{
    ok: true;
    commit: string;
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
export type WorkspaceCommitPreparation = {
    ok: true;
    excludePaths?: string[];
} | {
    ok: false;
    error: WorkspaceGitError;
};
export interface CommitAndPushOptions {
    message: string;
    author: CommitAuthor;
    beforeCommit?: () => Promise<WorkspaceCommitPreparation>;
    assertCurrent?: () => Promise<void>;
}
export interface CommitAndPushDeps {
    gitCommit: typeof gitCommit;
    gitPreparePush: typeof gitPreparePush;
    gitPush: typeof gitPush;
    gitHeadCommit: typeof gitHeadCommit;
    acquireMutationLease: typeof acquireWorkspaceMutationLeaseSync;
}
export type WorkspaceRemoteSyncState = "fast-forwarded" | "up-to-date" | "dirty" | "no-upstream";
export declare function syncCleanWorkspaceToRemote(customerDir: string): Promise<{
    ok: true;
    result: {
        state: WorkspaceRemoteSyncState;
    };
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
/**
 * Commit local workspace changes and push them — the explicit "save now" an
 * exec-off agent triggers via `workspace_commit`. `gitCommit` reports `empty`
 * when there was nothing to stage (a clean no-op). A push that fails AFTER a
 * successful commit is not fatal: the commit is durable on the PVC and the
 * autosave / pre-stop flush retries the push — we surface `pushed:false` +
 * `pushError` so the caller can tell the user rather than silently swallow it.
 */
export declare function commitAndPushWorkspace(customerDir: string, options: CommitAndPushOptions, deps?: CommitAndPushDeps): Promise<{
    ok: true;
    result: CommitAndPushResult;
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
export interface WorkspaceGitBranchEntry {
    name: string;
    current: boolean;
}
export declare function gitBranches(customerDir: string): Promise<{
    ok: true;
    entries: WorkspaceGitBranchEntry[];
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
export declare function gitCheckout(customerDir: string, options: {
    branch: string;
    create?: boolean;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
export declare function gitPush(customerDir: string, options?: {
    branch?: string;
    setUpstream?: boolean;
    commit?: string;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
interface WorkspacePushTarget {
    branch: string;
    setUpstream: boolean;
}
type GitFailure = {
    ok: false;
    error: WorkspaceGitError;
};
type WorkspacePushPreparation = {
    ok: true;
    target: WorkspacePushTarget;
} | GitFailure;
export declare function gitPreparePush(customerDir: string, options: {
    author: CommitAuthor;
}): Promise<WorkspacePushPreparation>;
export declare const WORKSPACE_GIT_HARDENING_PINS: ReadonlyArray<string>;
export declare const WORKSPACE_GIT_HARDENING_ENV: Readonly<Record<string, string>>;
export declare function userGitMetadataDir(cwd: string): string | null;
export declare function trustedWorkspaceGitDir(cwd: string): string;
export declare function workspaceMutationLeaseGitDir(cwd: string): string;
export declare function runWorkspaceGitMutation<T>(cwd: string, work: () => Promise<T>): Promise<{
    ok: true;
    result: T;
} | {
    ok: false;
    error: WorkspaceGitError;
}>;
export declare function workspaceGitCommandArgs(cwd: string, args: ReadonlyArray<string>, callerGithubCredential?: boolean): string[];
export declare function workspaceGitEnvironment(source?: NodeJS.ProcessEnv, cwd?: string, githubToken?: string): NodeJS.ProcessEnv;
export declare function isTrustedGithubUserCheckout(cwd: string): boolean;
export declare function isTrustedGiteaUserCheckout(cwd: string, repoName: string): boolean;
export declare function isGithubProjectCheckpoint(cwd: string): boolean;
export declare function parsePorcelain(stdout: string): WorkspaceGitStatusEntry[];
export declare function parseLog(stdout: string): WorkspaceGitLogEntry[];
export declare function parseBranchList(stdout: string): WorkspaceGitBranchEntry[];
export {};
