export declare const WORKSPACE_GIT_AUTHORIZATION_BROKER_PATH = "/internal/workspace-git/authorize";
export declare const WORKSPACE_GIT_AUTHORIZATION_TIMEOUT_MS = 5000;
export interface WorkspaceGitLane {
    access: "read" | "write";
    resolveGithubToken: boolean;
}
export interface WorkspaceGitAuthorization {
    gatewayId: string;
    uid: string;
    slug: string;
    projectSlug: string | null;
    githubToken: string | null;
    commitAuthor: {
        name: string;
        email: string;
    };
}
export type WorkspaceGitDeniedStatus = 400 | 403 | 404 | 409 | 422;
export type WorkspaceGitAuthorizationOutcome = {
    kind: "authorized";
    authorization: WorkspaceGitAuthorization;
} | {
    kind: "unauthenticated";
} | {
    kind: "denied";
    status: WorkspaceGitDeniedStatus;
    error: string;
    reason?: string;
};
export interface WorkspaceGitAuthorizationRequest {
    gatewayId: string;
    authorization: string | undefined;
    slug: string;
    projectSlug: string | null;
    lane: WorkspaceGitLane;
}
export declare function workspaceGitAuthorizationBrokerBaseUrlFromEnv(env?: Record<string, string | undefined>): string;
export declare function authorizeWorkspaceGit(args: WorkspaceGitAuthorizationRequest & {
    baseUrl?: string;
    env?: Record<string, string | undefined>;
    tokenPath?: string;
    fetchImpl?: typeof fetch;
}): Promise<WorkspaceGitAuthorizationOutcome>;
