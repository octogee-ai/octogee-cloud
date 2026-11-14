import type { WorkspaceChannelScope } from "@octogee/core/platform-state";
import { installProjectPresentation, type PresentationDocument } from "../../lib/project-presentation.js";

interface FakeDocument {
  get(): Promise<{ data(): unknown }>;
  set(data: PresentationDocument, options: { merge: true }): Promise<unknown>;
  update(data: PresentationDocument): Promise<unknown>;
}

function projectPath(workspaceSlug: string, projectSlug: string): string {
  return `workspaces/${workspaceSlug}/projects/${projectSlug}`;
}

function channelPath(scope: WorkspaceChannelScope, channelId: string): string {
  return scope.projectSlug === null
    ? `workspaces/${scope.workspaceSlug}/channels/${channelId}`
    : `${projectPath(scope.workspaceSlug, scope.projectSlug)}/channels/${channelId}`;
}

async function read(document: FakeDocument): Promise<PresentationDocument | null> {
  const data = (await document.get()).data();
  return data === undefined || data === null ? null : data as PresentationDocument;
}

export function installDocumentPresentation(doc: (path: string) => Partial<FakeDocument>): void {
  const at = (path: string) => doc(path) as FakeDocument;
  installProjectPresentation({
    readProject: (workspaceSlug, projectSlug) => read(at(projectPath(workspaceSlug, projectSlug))),
    createProject: async (workspaceSlug, projectSlug, fields) => {
      await at(projectPath(workspaceSlug, projectSlug)).set(fields, { merge: true });
    },
    publishProjectMemberCount: async (workspaceSlug, projectSlug, memberCount) => {
      await at(projectPath(workspaceSlug, projectSlug)).update({ memberCount });
    },
    markProjectPendingDeletion: async (workspaceSlug, projectSlug, pendingDeletion) => {
      await at(projectPath(workspaceSlug, projectSlug)).set({ pendingDeletion }, { merge: true });
    },
    readChannel: (scope, channelId) => read(at(channelPath(scope, channelId))),
    writeChannel: async (scope, channelId, fields) => {
      await at(channelPath(scope, channelId)).set(fields, { merge: true });
    },
  });
}
