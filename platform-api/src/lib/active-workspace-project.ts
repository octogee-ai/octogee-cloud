import type { WorkspaceProject } from "@octogee/core/platform-state";

const ACTIVE_PROJECT_STATUSES = new Set(["idea", "building", "launched", "paused"]);

function nestedStatus(data: Record<string, unknown>, field: string): unknown {
  const value = data[field];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).status
    : undefined;
}

export function projectRetentionActive(data: Record<string, unknown> | undefined): boolean {
  return data === undefined || data.retention === undefined || nestedStatus(data, "retention") === "active";
}

export function isRunnableWorkspaceProject(project: WorkspaceProject, ownerUid: string): boolean {
  return project.ownerUid === ownerUid && isActiveWorkspaceProject(project);
}

export function isActiveWorkspaceProject(project: WorkspaceProject): boolean {
  return project.ownerActive === true
    && project.status !== null
    && ACTIVE_PROJECT_STATUSES.has(project.status)
    && project.provisioningState === "active"
    && (project.commercialLifecycleStatus === null || project.commercialLifecycleStatus === "active");
}
