import { isDeepStrictEqual } from "node:util";
import type { WorkspaceProject } from "@octogee/core/platform-state";
import type { Agent, Project } from "@octogee/shared/types/index";
import { db } from "./db.js";
import { platformStateStore } from "./platform-state.js";
import { projectPresentation } from "./project-presentation.js";
import { storedForm } from "./user-platform-state.js";

type ProductDocument = Record<string, unknown>;

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
] as const satisfies readonly (keyof WorkspaceProject)[];

function isMap(value: unknown): value is ProductDocument {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function projectWithPlatformState(product: ProductDocument, record: WorkspaceProject): Project {
  const project: ProductDocument = {
    ...product,
    id: product.id ?? record.projectSlug,
    slug: product.slug ?? record.projectSlug,
    workspaceId: product.workspaceId ?? record.workspaceSlug,
  };
  for (const field of PROJECT_PLATFORM_FIELDS) {
    const stored = record[field] ?? null;
    if (!isDeepStrictEqual(storedForm(product[field]), stored)) project[field] = stored;
  }
  const lifecycle = isMap(product.commercialLifecycle) ? product.commercialLifecycle : null;
  if ((lifecycle?.status ?? null) !== record.commercialLifecycleStatus) {
    project.commercialLifecycle = { ...lifecycle, status: record.commercialLifecycleStatus };
  }
  return project as unknown as Project;
}

export async function readProject(workspaceSlug: string, projectSlug: string): Promise<Project | null> {
  const [record, product] = await Promise.all([
    platformStateStore.workspaces.projects.get(workspaceSlug, projectSlug),
    projectPresentation().readProject(workspaceSlug, projectSlug),
  ]);
  if (record === null) return null;
  return projectWithPlatformState(product ?? {}, record);
}

export async function readAgent(uid: string): Promise<Agent | null> {
  const snap = await db.doc(`agents/${uid}`).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data ? (data as Agent) : null;
}
