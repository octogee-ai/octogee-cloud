export type ProjectVisibility = 'private' | 'public' | 'unlisted';
export type ProjectStatus = 'idea' | 'building' | 'launched' | 'paused' | 'archived';
export type ProjectProvisioningState = 'provisioning' | 'active' | 'failed';
export type ProjectType =
  | 'game'
  | 'social'
  | 'planner'
  | 'trip'
  | 'research'
  | 'event'
  | 'other';

// How Preview and Publish run the project.
export type ProjectRecipeId = 'static-site' | 'vite-static' | 'astro-static';
export const PROJECT_RECIPE_IDS: readonly ProjectRecipeId[] = [
  'static-site',
  'vite-static',
  'astro-static',
];
export const DEFAULT_PROJECT_RECIPE: ProjectRecipeId = 'static-site';

export function isProjectRecipeId(value: unknown): value is ProjectRecipeId {
  return typeof value === 'string'
    && (PROJECT_RECIPE_IDS as readonly string[]).includes(value);
}

export function defaultProjectRecipe(projectType: string | null): ProjectRecipeId {
  switch (projectType) {
    case 'game':
    case 'social':
    case 'planner':
      return 'vite-static';
    case 'trip':
    case 'research':
    case 'event':
      return 'astro-static';
    default:
      return DEFAULT_PROJECT_RECIPE;
  }
}

export interface ProjectRepoSource {
  provider: 'github';
  owner: string;
  repo: string;
}

export type ProjectAgentStatus = 'provisioning' | 'ready' | 'error';

export interface ProjectAgentIdentity {
  name: string;
  emoji: string;
  persona: string;
  avatar?: { path: string; gcsPath: string; updatedAt?: unknown };
  avatarVersion?: number;
}

export interface ProjectAgentConfig {
  voice?: string;
  identity?: ProjectAgentIdentity;
  requestedName?: string;
  kickoff?: { status: 'pending' | 'sent'; postId?: string };
  handoff?: { status: 'pending' | 'sent'; postId?: string; generation?: number };
  status?: ProjectAgentStatus;
  activationId?: string | null;
  lastError?: string | null;
  updatedAt?: unknown;
}

export function projectAgentConfigured(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function projectCheckoutEnabled(value: unknown): boolean {
  return value !== false;
}

export function projectRepoSourceFromDoc(value: unknown): ProjectRepoSource | null {
  if (!value || typeof value !== 'object') return null;
  const { provider, owner, repo } = value as {
    provider?: unknown;
    owner?: unknown;
    repo?: unknown;
  };
  if (provider !== 'github') return null;
  if (typeof owner !== 'string' || owner.length === 0) return null;
  if (typeof repo !== 'string' || repo.length === 0) return null;
  return { provider: 'github', owner, repo };
}

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

export const PROJECT_AGENT_WORKSPACE_PARTS = [".system", "project-coaches"] as const;
export const PROJECT_AGENT_REPO = "project_coaches";
