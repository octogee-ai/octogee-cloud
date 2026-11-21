import { postgresUsersWatchSource } from "./user-records.js";
import { postgresConfigWatchSource } from "./config.js";
import { postgresFleetRegistryWatchSource } from "./fleet-registry.js";
import { postgresAssignmentsWatchSource, postgresGatewaysWatchSource } from "./gateways.js";
import { decodeOperation } from "./journal.js";
import { postgresMigrationTasksWatchSource } from "./migration-tasks.js";
import { postgresAgentIdentitiesWatchSource, postgresWorkspaceChannelsWatchSource, postgresWorkspaceMembersWatchSource, postgresWorkspaceProjectMembersWatchSource, postgresWorkspaceProjectsWatchSource, postgresWorkspacesWatchSource, } from "./workspaces.js";
const operationsWatchSource = (filter) => {
    if ("operationId" in filter) {
        const recordKey = filter.operationId;
        const selectOperation = (parameters) => `SELECT * FROM $schema.operations WHERE id = ${parameters.add(recordKey, "text")}`;
        return {
            aggregate: "operations",
            operation: "watch operation by id",
            recordKey,
            selectAll: selectOperation,
            selectKeys: (_keys, parameters) => selectOperation(parameters),
            keyOf: (row) => row.id,
            decode: decodeOperation,
            mayMatch: () => true,
        };
    }
    const statuses = [...filter.statuses];
    const terminal = ["failed", "rolled-back"];
    const watchedStatuses = filter.includeMigrationRecovery ? [...statuses, ...terminal] : statuses;
    const matching = (parameters) => {
        const active = `status = ANY(${parameters.add(statuses, "text[]")})`;
        if (!filter.includeMigrationRecovery)
            return active;
        return `(${active} OR (kind = 'migrate-user' AND status = ANY(${parameters.add(terminal, "text[]")})
      AND (retry_requested_at IS NOT NULL OR source_recovery_requested_at IS NOT NULL OR scheduler_handoff IS NOT NULL)))`;
    };
    return {
        aggregate: "operations",
        operation: "watch operations",
        selectAll: (parameters) => `SELECT * FROM $schema.operations WHERE ${matching(parameters)} ORDER BY id`,
        selectKeys: (keys, parameters) => `SELECT * FROM $schema.operations WHERE ${matching(parameters)} AND id = ANY(${parameters.add([...keys], "text[]")})`,
        keyOf: (row) => row.id,
        decode: decodeOperation,
        mayMatch: (filterKeys) => filterKeys.status === undefined || filterKeys.status.some(status => typeof status === "string" && watchedStatuses.includes(status)),
    };
};
const WATCH_SOURCES = {
    operations: operationsWatchSource,
    builders: postgresUsersWatchSource,
    workspaces: postgresWorkspacesWatchSource,
    workspaceMembers: postgresWorkspaceMembersWatchSource,
    workspaceProjects: postgresWorkspaceProjectsWatchSource,
    workspaceProjectMembers: postgresWorkspaceProjectMembersWatchSource,
    workspaceChannels: postgresWorkspaceChannelsWatchSource,
    agentIdentities: postgresAgentIdentitiesWatchSource,
    gateways: postgresGatewaysWatchSource,
    assignments: postgresAssignmentsWatchSource,
    fleetRegistry: postgresFleetRegistryWatchSource,
    migrationTasks: postgresMigrationTasksWatchSource,
    config: postgresConfigWatchSource,
};
export function postgresWatchSource(request) {
    const factory = WATCH_SOURCES[request.aggregate];
    return factory(request.filter);
}
