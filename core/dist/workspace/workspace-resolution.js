import { platformStateStore } from "../identity/platform-state-store.js";
export async function resolveWorkspaceUid(slug) {
    return (await platformStateStore.workspaces.records.get(slug))?.ownerUid ?? null;
}
