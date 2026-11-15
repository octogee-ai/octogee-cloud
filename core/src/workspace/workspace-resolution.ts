import { platformStateStore } from "../identity/platform-state-store.js";

export async function resolveWorkspaceUid(slug: string): Promise<string | null> {
  return (await platformStateStore.workspaces.records.get(slug))?.ownerUid ?? null;
}
