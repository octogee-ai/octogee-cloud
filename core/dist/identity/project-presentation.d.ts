import type { WorkspaceChannelScope } from "../platform-state/index.js";
export type PresentationDocument = Record<string, unknown>;
export type ProjectRepoProvider = "github" | "gitea";
export interface PendingProjectDeletion {
    ownerUid: string;
    repoProvider: ProjectRepoProvider;
}
export interface ProjectPresentation {
    readonly remembersChannels: boolean;
    readProject(workspaceSlug: string, projectSlug: string): Promise<PresentationDocument | null>;
    createProject(workspaceSlug: string, projectSlug: string, fields: PresentationDocument): Promise<void>;
    publishProjectMemberCount(workspaceSlug: string, projectSlug: string, memberCount: number): Promise<void>;
    markProjectPendingDeletion(workspaceSlug: string, projectSlug: string, pending: PendingProjectDeletion): Promise<void>;
    readChannel(scope: WorkspaceChannelScope, channelId: string): Promise<PresentationDocument | null>;
    writeChannel(scope: WorkspaceChannelScope, channelId: string, fields: PresentationDocument): Promise<void>;
}
export declare const NO_PROJECT_PRESENTATION: ProjectPresentation;
export declare function installProjectPresentation(presentation: ProjectPresentation): void;
export declare function projectPresentation(): ProjectPresentation;
