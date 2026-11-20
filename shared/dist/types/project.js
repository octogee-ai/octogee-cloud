export const PROJECT_RECIPE_IDS = [
    'static-site',
    'vite-static',
    'astro-static',
];
export const DEFAULT_PROJECT_RECIPE = 'static-site';
export function isProjectRecipeId(value) {
    return typeof value === 'string'
        && PROJECT_RECIPE_IDS.includes(value);
}
export function defaultProjectRecipe(projectType) {
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
const GITHUB_CHECKPOINT_REPO = /^github_checkpoint_([a-f0-9]{32})$/u;
export function githubCheckpointRepo(id) {
    return `github_checkpoint_${id}`;
}
export function githubCheckpointBranch(repo) {
    const id = GITHUB_CHECKPOINT_REPO.exec(repo)?.[1];
    return id ? `octogee-${id}` : null;
}
export const GITHUB_PROJECT_METADATA_PATHS = ['.files/manifest.json', '.octogee/avatar.svg'];
function githubWorkingCopyFromDoc(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const copy = value;
    if (typeof copy.id !== 'string' || !/^[a-f0-9]{32}$/u.test(copy.id)
        || typeof copy.repositoryId !== 'number' || !Number.isSafeInteger(copy.repositoryId) || copy.repositoryId < 1
        || typeof copy.baseBranch !== 'string' || !copy.baseBranch || copy.baseBranch.length > 255
        || typeof copy.baseCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(copy.baseCommit)
        || typeof copy.ready !== 'boolean')
        return undefined;
    return copy;
}
export function projectAgentConfigured(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function projectCheckoutEnabled(value) {
    return value !== false;
}
export function projectRepoSourceFromDoc(value) {
    if (!value || typeof value !== 'object')
        return null;
    const { provider, owner, repo, workingCopy } = value;
    if (provider !== 'github')
        return null;
    if (typeof owner !== 'string' || owner.length === 0)
        return null;
    if (typeof repo !== 'string' || repo.length === 0)
        return null;
    const copy = githubWorkingCopyFromDoc(workingCopy);
    return { provider: 'github', owner, repo, ...(copy ? { workingCopy: copy } : {}) };
}
export const PROJECT_AGENT_WORKSPACE_PARTS = [".system", "project-coaches"];
export const PROJECT_AGENT_REPO = "project_coaches";
