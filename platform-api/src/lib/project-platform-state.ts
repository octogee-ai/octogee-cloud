import { giteaDeleteVerifiedRepo } from "@octogee/core/git-host/gitea-client";
import { githubCheckpointRepo, projectRepoSourceFromDoc } from "@octogee/shared/types/project";
import type { WorkspaceProject } from "@octogee/core/platform-state";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { projectPresentation, type PendingProjectDeletion, type ProjectRepoProvider } from "@octogee/core/identity/project-presentation";
import { logger } from "@octogee/core/http/logging";

const MEMBER_COUNT_SYNC_ATTEMPTS = 5;

export type { PendingProjectDeletion, ProjectRepoProvider };

export function projectRepoProvider(project: Pick<WorkspaceProject, "repoSource">): ProjectRepoProvider {
  return project.repoSource?.provider === "github" ? "github" : "gitea";
}

async function storedMemberCount(workspaceSlug: string, projectSlug: string): Promise<number | null> {
  const { projects, projectMembers } = platformStateStore.workspaces;
  const [project, members] = await Promise.all([
    projects.get(workspaceSlug, projectSlug),
    projectMembers.list(workspaceSlug, projectSlug),
  ]);
  if (!project) return null;
  return new Set([...members.map((member) => member.uid), project.ownerUid]).size;
}

export async function syncProjectMemberCount(workspaceSlug: string, projectSlug: string): Promise<void> {
  let published: number | null = null;
  for (let attempt = 0; attempt < MEMBER_COUNT_SYNC_ATTEMPTS; attempt += 1) {
    const memberCount = await storedMemberCount(workspaceSlug, projectSlug);
    if (memberCount === null || memberCount === published) return;
    await projectPresentation().publishProjectMemberCount(workspaceSlug, projectSlug, memberCount);
    published = memberCount;
  }
  logger.warn(`[projects] member count for ${workspaceSlug}/${projectSlug} kept changing after ${MEMBER_COUNT_SYNC_ATTEMPTS} writes`);
}

export async function removeProjectMember(workspaceSlug: string, projectSlug: string, uid: string): Promise<void> {
  await platformStateStore.transaction({ label: "project-member.remove" }, async (tx) => {
    const { projects, projectMembers } = tx.workspaces;
    const member = await projectMembers.get(workspaceSlug, projectSlug, uid);
    const project = await projects.get(workspaceSlug, projectSlug);
    if (!member) return;
    await projectMembers.delete(workspaceSlug, projectSlug, uid);
    if (project) await projects.patch(workspaceSlug, projectSlug, { updatedAt: { serverNow: true } });
  });
  await syncProjectMemberCount(workspaceSlug, projectSlug);
}

export async function addProjectMember(workspaceSlug: string, projectSlug: string, uid: string): Promise<void> {
  await platformStateStore.transaction({ label: "project-member.add" }, async (tx) => {
    const { projects, projectMembers } = tx.workspaces;
    const member = await projectMembers.get(workspaceSlug, projectSlug, uid);
    const project = await projects.get(workspaceSlug, projectSlug);
    if (member) return;
    if (!project) throw new Error(`project ${workspaceSlug}/${projectSlug} not found`);
    await projectMembers.put({ workspaceSlug, projectSlug, uid, role: "member", joinedAt: { serverNow: true } });
    await projects.patch(workspaceSlug, projectSlug, { updatedAt: { serverNow: true } });
  });
  await syncProjectMemberCount(workspaceSlug, projectSlug);
}

export async function deleteProjectPlatformState(
  workspaceSlug: string,
  projectSlug: string,
  pendingDeletion: PendingProjectDeletion,
): Promise<void> {
  await projectPresentation().markProjectPendingDeletion(workspaceSlug, projectSlug, pendingDeletion);
  const stored = await platformStateStore.workspaces.projects.get(workspaceSlug, projectSlug);
  const workingCopy = projectRepoSourceFromDoc(stored?.repoSource)?.workingCopy;
  if (workingCopy) await giteaDeleteVerifiedRepo(workspaceSlug, githubCheckpointRepo(workingCopy.id));
  await platformStateStore.transaction({ label: "project.delete" }, async (tx) => {
    const { projects, projectMembers, channels } = tx.workspaces;
    const scope = { workspaceSlug, projectSlug };
    const storedChannels = await channels.list(scope);
    const members = await projectMembers.list(workspaceSlug, projectSlug);
    for (const channel of storedChannels) await channels.delete(scope, channel.channelId);
    for (const member of members) await projectMembers.delete(workspaceSlug, projectSlug, member.uid);
    await projects.delete(workspaceSlug, projectSlug);
  });
}
