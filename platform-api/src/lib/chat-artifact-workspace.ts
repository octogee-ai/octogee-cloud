import type { PlatformStateRepositories } from "@octogee/core/platform-state";

import { userAllowsInteractiveAccess } from "./assigned-user.js";

export async function resolveActiveArtifactWorkspaceSlug(
  store: Pick<PlatformStateRepositories, "users" | "workspaces">,
  mattermostTeamId: string,
): Promise<{ workspaceSlug: string; workspaceOwnerUid: string } | null> {
  const workspace = await store.workspaces.records.findByMattermostTeamId(mattermostTeamId);
  if (!workspace) return null;
  const owner = await store.users.records.get(workspace.ownerUid);
  return owner && userAllowsInteractiveAccess(owner)
    ? { workspaceSlug: workspace.slug, workspaceOwnerUid: workspace.ownerUid }
    : null;
}
