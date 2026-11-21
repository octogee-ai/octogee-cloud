export function migrationTransferTaskId({ migrationId, mode = "pre" }) {
    return `${migrationId.replace(/[^A-Za-z0-9._-]/g, "_")}__${mode}`;
}
export function retargetedMigrationTransferId(migrationId, gatewayId) {
    return `${migrationId}:retarget:${gatewayId}`;
}
