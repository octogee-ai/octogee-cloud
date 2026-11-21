import type { Stored, WatchAggregate, WatchFilters, WatchRecords, WatchRequest } from "../store.js";
import { postgresUsersWatchSource } from "./user-records.js";
import { postgresConfigWatchSource } from "./config.js";
import { postgresFleetRegistryWatchSource } from "./fleet-registry.js";
import { postgresAssignmentsWatchSource, postgresGatewaysWatchSource } from "./gateways.js";
import { decodeOperation } from "./journal.js";
import { postgresMigrationTasksWatchSource } from "./migration-tasks.js";
import type { Row, SqlParameters } from "./sql.js";
import {
  postgresAgentIdentitiesWatchSource,
  postgresWorkspaceChannelsWatchSource,
  postgresWorkspaceMembersWatchSource,
  postgresWorkspaceProjectMembersWatchSource,
  postgresWorkspaceProjectsWatchSource,
  postgresWorkspacesWatchSource,
} from "./workspaces.js";

export type FilterKeys = Readonly<Record<string, readonly unknown[]>>;

export interface PostgresWatchSource<A extends WatchAggregate> {
  readonly aggregate: A;
  readonly operation: string;
  readonly recordKey?: string;
  selectAll(parameters: SqlParameters): string;
  selectKeys(keys: readonly string[], parameters: SqlParameters): string;
  keyOf(row: Row): string;
  decode(row: Row): Stored<WatchRecords[A]>;
  mayMatch(filterKeys: FilterKeys): boolean;
}

type PostgresWatchSourceFactory<A extends WatchAggregate> = (filter: WatchFilters[A]) => PostgresWatchSource<A>;

const operationsWatchSource: PostgresWatchSourceFactory<"operations"> = (filter) => {
  if ("operationId" in filter) {
    const recordKey = filter.operationId;
    const selectOperation = (parameters: SqlParameters) =>
      `SELECT * FROM $schema.operations WHERE id = ${parameters.add(recordKey, "text")}`;
    return {
      aggregate: "operations",
      operation: "watch operation by id",
      recordKey,
      selectAll: selectOperation,
      selectKeys: (_keys, parameters) => selectOperation(parameters),
      keyOf: (row) => row.id as string,
      decode: decodeOperation,
      mayMatch: () => true,
    };
  }
  const statuses = [...filter.statuses];
  const terminal = ["failed", "rolled-back"];
  const watchedStatuses = filter.includeMigrationRecovery ? [...statuses, ...terminal] : statuses;
  const matching = (parameters: SqlParameters) => {
    const active = `status = ANY(${parameters.add(statuses, "text[]")})`;
    if (!filter.includeMigrationRecovery) return active;
    return `(${active} OR (kind = 'migrate-user' AND status = ANY(${parameters.add(terminal, "text[]")})
      AND (retry_requested_at IS NOT NULL OR source_recovery_requested_at IS NOT NULL OR scheduler_handoff IS NOT NULL)))`;
  };
  return {
    aggregate: "operations",
    operation: "watch operations",
    selectAll: (parameters) => `SELECT * FROM $schema.operations WHERE ${matching(parameters)} ORDER BY id`,
    selectKeys: (keys, parameters) =>
      `SELECT * FROM $schema.operations WHERE ${matching(parameters)} AND id = ANY(${parameters.add([...keys], "text[]")})`,
    keyOf: (row) => row.id as string,
    decode: decodeOperation,
    mayMatch: (filterKeys) =>
      filterKeys.status === undefined || filterKeys.status.some(status => typeof status === "string" && watchedStatuses.includes(status)),
  };
};

const WATCH_SOURCES: { readonly [A in WatchAggregate]: PostgresWatchSourceFactory<A> } = {
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

export function postgresWatchSource<A extends WatchAggregate>(request: WatchRequest<A>): PostgresWatchSource<A> {
  const factory = WATCH_SOURCES[request.aggregate] as PostgresWatchSourceFactory<A>;
  return factory(request.filter);
}
