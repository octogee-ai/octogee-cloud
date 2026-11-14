import type { WorkspaceChannelScope } from "@octogee/core/platform-state";

export type PresentationDocument = Record<string, unknown>;

export type ProjectRepoProvider = "github" | "gitea";

export interface PendingProjectDeletion {
  ownerUid: string;
  repoProvider: ProjectRepoProvider;
}

export interface ProjectPresentation {
  readProject(workspaceSlug: string, projectSlug: string): Promise<PresentationDocument | null>;
  createProject(workspaceSlug: string, projectSlug: string, fields: PresentationDocument): Promise<void>;
  publishProjectMemberCount(workspaceSlug: string, projectSlug: string, memberCount: number): Promise<void>;
  markProjectPendingDeletion(workspaceSlug: string, projectSlug: string, pending: PendingProjectDeletion): Promise<void>;
  readChannel(scope: WorkspaceChannelScope, channelId: string): Promise<PresentationDocument | null>;
  writeChannel(scope: WorkspaceChannelScope, channelId: string, fields: PresentationDocument): Promise<void>;
}

export const NO_PROJECT_PRESENTATION: ProjectPresentation = {
  readProject: async () => null,
  createProject: async () => undefined,
  publishProjectMemberCount: async () => undefined,
  markProjectPendingDeletion: async () => undefined,
  readChannel: async () => null,
  writeChannel: async () => undefined,
};

let active: ProjectPresentation = NO_PROJECT_PRESENTATION;

export function installProjectPresentation(presentation: ProjectPresentation): void {
  active = presentation;
}

export function projectPresentation(): ProjectPresentation {
  return active;
}
