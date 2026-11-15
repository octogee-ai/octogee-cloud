export class WorkspaceStorageQuotaError extends Error {
    limitBytes;
    projectedBytes;
    name = "WorkspaceStorageQuotaError";
    code = "FREE_STORAGE_LIMIT";
    constructor(limitBytes, projectedBytes) {
        super(`Free workspace storage limit exceeded (${projectedBytes}/${limitBytes} bytes)`);
        this.limitBytes = limitBytes;
        this.projectedBytes = projectedBytes;
    }
}
function noAccountingStore() {
    throw new Error("A workspace storage limit applies but no storage accounting is installed");
}
export const NO_WORKSPACE_STORAGE_ACCOUNTING = {
    reserve: async () => noAccountingStore(),
    finalize: async () => noAccountingStore(),
    rollback: async () => noAccountingStore(),
    release: async () => { },
};
let installed = NO_WORKSPACE_STORAGE_ACCOUNTING;
export function installWorkspaceStorageAccounting(accounting) {
    installed = accounting;
}
export function workspaceStorageAccounting() {
    return installed;
}
