export interface ProjectCreateAdmissionRequest {
  uid: string;
  workspaceId: string;
  projectSlug: string;
  source: "ui" | "agent";
}

export type ProjectCreateAdmissionDecision =
  | { allowed: true }
  | { allowed: false; status: number; body: Record<string, unknown> };

export type ProjectCreateAdmission = (
  request: ProjectCreateAdmissionRequest,
) => Promise<ProjectCreateAdmissionDecision>;

export const ADMIT_EVERY_PROJECT_CREATE: ProjectCreateAdmission = async () => ({ allowed: true });

let active: ProjectCreateAdmission = ADMIT_EVERY_PROJECT_CREATE;

export function installProjectCreateAdmission(admission: ProjectCreateAdmission): void {
  active = admission;
}

export function projectCreateAdmission(): ProjectCreateAdmission {
  return active;
}
