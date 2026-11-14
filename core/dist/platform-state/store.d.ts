import type { OperationStatus } from "@octogee/shared/types/glm";
import type { UserRepositories, PlatformUserRecord } from "./users.js";
import type { ChannelIdentitiesRepository } from "./channel-identities.js";
import type { ConfigRepositories, ConfigRecord } from "./config.js";
import type { ControllerStateRepositories } from "./controller-state.js";
import type { PlatformStateError } from "./errors.js";
import type { FleetRegistryRecord, FleetRegistryRepository } from "./fleet-registry.js";
import type { GatewayAssignment, GatewayRepositories, GatewayRoot } from "./gateways.js";
import type { JobRepositories } from "./jobs.js";
import type { MigrationTransferTask, MigrationTransferTaskStatus, MigrationTasksRepository } from "./migration-tasks.js";
import type { JournalRepositories, OperationRecord } from "./operations.js";
import type { AccessRepositories, SecretsRepository } from "./secrets.js";
import type { UserAgentIdentity, WorkspaceChannel, WorkspaceMember, WorkspaceProject, WorkspaceProjectMember, WorkspaceRecord, WorkspaceRepositories } from "./workspaces.js";
export interface ServerNow {
    readonly serverNow: true;
}
export type TimeInput = number | ServerNow;
export interface ClearField {
    readonly clear: true;
}
export type Clearable<T> = T | ClearField;
export type RecordPatch<T, Fixed extends keyof T = never> = {
    readonly [K in Exclude<keyof T, Fixed>]?: undefined extends T[K] ? Clearable<Exclude<T[K], undefined>> : null extends T[K] ? Clearable<T[K]> : T[K];
};
export type Revision = string & {
    readonly __platformStateRevision: true;
};
export type Stored<T> = T & {
    readonly revision: Revision;
};
export type OpaqueMap = Readonly<Record<string, unknown>>;
export type UntypedRecord = Record<string, any>;
export interface PageRequest {
    readonly limit: number;
    readonly after?: string;
}
export interface Page<T> {
    readonly items: readonly T[];
    readonly next: string | null;
}
export interface PlatformStateRepositories {
    readonly journal: JournalRepositories;
    readonly gateways: GatewayRepositories;
    readonly fleetRegistry: FleetRegistryRepository;
    readonly controllerState: ControllerStateRepositories;
    readonly migrationTasks: MigrationTasksRepository;
    readonly config: ConfigRepositories;
    readonly users: UserRepositories;
    readonly workspaces: WorkspaceRepositories;
    readonly secrets: SecretsRepository;
    readonly channelIdentities: ChannelIdentitiesRepository;
    readonly access: AccessRepositories;
    readonly jobs: JobRepositories;
}
export interface TransactionOptions {
    readonly label: string;
    readonly readOnly?: boolean;
    readonly maxAttempts?: number;
}
export interface PlatformStateTransaction extends PlatformStateRepositories {
    readonly label: string;
    readonly readOnly: boolean;
    readonly attempt: number;
}
export interface WatchFilters {
    readonly operations: {
        readonly statuses: readonly OperationStatus[];
    };
    readonly gateways: {
        readonly gatewayId?: string;
    };
    readonly assignments: {
        readonly gatewayId?: string;
    };
    readonly fleetRegistry: {
        readonly gatewayId?: string;
    };
    readonly builders: {
        readonly gatewayId?: string;
        readonly uid?: string;
    };
    readonly config: Readonly<Record<string, never>>;
    readonly migrationTasks: {
        readonly statuses?: readonly MigrationTransferTaskStatus[];
    };
    readonly workspaces: {
        readonly ownerUid?: string;
    };
    readonly workspaceMembers: {
        readonly workspaceSlug?: string;
        readonly uid?: string;
    };
    readonly workspaceProjects: {
        readonly workspaceSlug?: string;
    };
    readonly workspaceProjectMembers: {
        readonly workspaceSlug?: string;
        readonly uid?: string;
    };
    readonly workspaceChannels: {
        readonly workspaceSlug?: string;
    };
    readonly agentIdentities: {
        readonly uid?: string;
    };
}
export interface WatchRecords {
    readonly operations: OperationRecord;
    readonly gateways: GatewayRoot;
    readonly assignments: GatewayAssignment;
    readonly fleetRegistry: FleetRegistryRecord;
    readonly builders: PlatformUserRecord;
    readonly config: ConfigRecord;
    readonly migrationTasks: MigrationTransferTask;
    readonly workspaces: WorkspaceRecord;
    readonly workspaceMembers: WorkspaceMember;
    readonly workspaceProjects: WorkspaceProject;
    readonly workspaceProjectMembers: WorkspaceProjectMember;
    readonly workspaceChannels: WorkspaceChannel;
    readonly agentIdentities: UserAgentIdentity;
}
export type WatchAggregate = keyof WatchFilters;
export type WatchCursor = string & {
    readonly __platformStateWatchCursor: true;
};
export interface WatchRequest<A extends WatchAggregate> {
    readonly aggregate: A;
    readonly filter: WatchFilters[A];
    readonly resumeFrom?: WatchCursor;
}
export interface WatchChange<A extends WatchAggregate> {
    readonly type: "added" | "modified" | "removed";
    readonly key: string;
    readonly record: Stored<WatchRecords[A]> | null;
}
export type WatchResyncReason = "cursor-expired" | "notification-gap" | "backend-restart";
export type WatchEvent<A extends WatchAggregate> = {
    readonly kind: "snapshot";
    readonly records: readonly Stored<WatchRecords[A]>[];
    readonly cursor: WatchCursor;
} | {
    readonly kind: "changes";
    readonly changes: readonly WatchChange<A>[];
    readonly cursor: WatchCursor;
} | {
    readonly kind: "resync";
    readonly reason: WatchResyncReason;
};
export interface WatchListener<A extends WatchAggregate> {
    onEvent(event: WatchEvent<A>): void | Promise<void>;
    onError(error: PlatformStateError): void;
}
export interface WatchSubscription {
    readonly closed: Promise<void>;
    close(): Promise<void>;
}
export interface PlatformStateStore extends PlatformStateRepositories {
    transaction<T>(options: TransactionOptions, body: (transaction: PlatformStateTransaction) => Promise<T>): Promise<T>;
    watch<A extends WatchAggregate>(request: WatchRequest<A>, listener: WatchListener<A>): WatchSubscription;
    sweepExpired(now: number, limit: number): Promise<ExpirySweepResult>;
    close(): Promise<void>;
}
export interface ExpirySweepResult {
    readonly operations: number;
    readonly operationAudits: number;
    readonly accessGrants: number;
    readonly modelBrokerUsageEvents: number;
    readonly subscriptionFlows: number;
}
