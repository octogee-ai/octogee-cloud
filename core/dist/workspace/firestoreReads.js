import { isDeepStrictEqual } from "node:util";
import { platformStateStore } from "../identity/platform-state-store.js";
import { projectPresentation } from "../identity/project-presentation.js";
import { storedForm } from "../identity/user-platform-state.js";
const PROJECT_PLATFORM_FIELDS = [
    "ownerUid",
    "ownerActive",
    "giteaRepoName",
    "provisioningState",
    "provisioningError",
    "provisioningCleanup",
    "pendingVisibility",
    "visibility",
    "checkoutEnabled",
    "status",
    "archived",
    "archivedAt",
    "repoSource",
    "agent",
];
function isMap(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function projectWithPlatformState(product, record) {
    const project = {
        ...product,
        id: product.id ?? record.projectSlug,
        slug: product.slug ?? record.projectSlug,
        workspaceId: product.workspaceId ?? record.workspaceSlug,
    };
    for (const field of PROJECT_PLATFORM_FIELDS) {
        const stored = record[field] ?? null;
        if (!isDeepStrictEqual(storedForm(product[field]), stored))
            project[field] = stored;
    }
    const lifecycle = isMap(product.commercialLifecycle) ? product.commercialLifecycle : null;
    if ((lifecycle?.status ?? null) !== record.commercialLifecycleStatus) {
        project.commercialLifecycle = { ...lifecycle, status: record.commercialLifecycleStatus };
    }
    return project;
}
export async function readProject(workspaceSlug, projectSlug) {
    const [record, product] = await Promise.all([
        platformStateStore.workspaces.projects.get(workspaceSlug, projectSlug),
        projectPresentation().readProject(workspaceSlug, projectSlug),
    ]);
    if (record === null)
        return null;
    return projectWithPlatformState(product ?? {}, record);
}
