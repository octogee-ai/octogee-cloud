import type { PlatformStateRepositories } from "@octogee/core/platform-state";

export async function projectMemberExists(
  state: Pick<PlatformStateRepositories, "workspaces">,
  workspaceSlug: string,
  projectSlug: string,
  uid: string,
): Promise<boolean> {
  return (await state.workspaces.projectMembers.get(workspaceSlug, projectSlug, uid)) !== null;
}
