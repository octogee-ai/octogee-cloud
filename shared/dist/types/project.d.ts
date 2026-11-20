export type ProjectVisibility = 'private' | 'public' | 'unlisted';
export type ProjectStatus = 'idea' | 'building' | 'launched' | 'paused' | 'archived';
export type ProjectProvisioningState = 'provisioning' | 'active' | 'failed';
export type ProjectType = 'game' | 'social' | 'planner' | 'trip' | 'research' | 'event' | 'other';
export type ProjectRecipeId = 'static-site' | 'vite-static' | 'astro-static';
export declare const PROJECT_RECIPE_IDS: readonly ProjectRecipeId[];
export declare const DEFAULT_PROJECT_RECIPE: ProjectRecipeId;
export declare function isProjectRecipeId(value: unknown): value is ProjectRecipeId;
export declare function defaultProjectRecipe(projectType: string | null): ProjectRecipeId;
export interface ProjectRepoSource {
    provider: 'github';
    owner: string;
    repo: string;
    workingCopy?: GitHubProjectWorkingCopy;
}
export interface GitHubProjectWorkingCopy {
    id: string;
    repositoryId: number;
    baseBranch: string;
    baseCommit: string;
    ready: boolean;
    pullRequestUrl?: string;
}
export declare function githubCheckpointRepo(id: string): string;
export declare function githubCheckpointBranch(repo: string): string | null;
export declare const GITHUB_PROJECT_METADATA = ".files/manifest.json";
export type ProjectAgentStatus = 'provisioning' | 'ready' | 'error';
export interface ProjectAgentIdentity {
    name: string;
    emoji: string;
    persona: string;
    avatar?: {
        path: string;
        gcsPath: string;
        updatedAt?: unknown;
    };
    avatarVersion?: number;
}
export interface ProjectAgentConfig {
    voice?: string;
    identity?: ProjectAgentIdentity;
    requestedName?: string;
    kickoff?: {
        status: 'pending' | 'sent';
        postId?: string;
    };
    handoff?: {
        status: 'pending' | 'sent';
        postId?: string;
        generation?: number;
    };
    status?: ProjectAgentStatus;
    activationId?: string | null;
    lastError?: string | null;
    updatedAt?: unknown;
}
export declare function projectAgentConfigured(value: unknown): boolean;
export declare function projectCheckoutEnabled(value: unknown): boolean;
export declare function projectRepoSourceFromDoc(value: unknown): ProjectRepoSource | null;
export interface Project {
    reusePreviewUrl?: boolean;
    id: string;
    ownerUid: string;
    workspaceId: string;
    slug: string;
    name: string;
    tagline: string;
    description: string;
    category: string;
    projectType: ProjectType | null;
    status: ProjectStatus;
    visibility: ProjectVisibility;
    provisioningState: ProjectProvisioningState;
    provisioningError?: string | null;
    pendingVisibility?: ProjectVisibility | null;
    giteaRepoName: string | null;
    repoSource?: ProjectRepoSource | null;
    /** Owner-controlled: should this project be checked out on the user's gateway?
     *  Distinct from provisioningState, which is the server's record of what provisioning
     *  did. A repo the gateway cannot reach (a GitHub project on a shared pod) is turned
     *  off here rather than misreported as a provisioning failure. Absent means enabled. */
    checkoutEnabled?: boolean;
    commercialLifecycle?: {
        status: "active" | "archived";
        archivedAt?: unknown;
    };
    agent?: ProjectAgentConfig;
    canvasFile: string;
    recipe?: ProjectRecipeId | null;
    publishedUrl: string | null;
    starCount: number;
    memberCount: number;
    createdAt: unknown;
    updatedAt: unknown;
}
export declare const PROJECT_AGENT_WORKSPACE_PARTS: readonly [".system", "project-coaches"];
export declare const PROJECT_AGENT_REPO = "project_coaches";
