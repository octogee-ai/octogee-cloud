import type { UserAuxiliaryFamily } from "@octogee/shared/types/fleet-broker";
import type { AgentStoreRecord, IsolatedGatewayMirror, PlatformUserRecord, UserActivationLease, UserActivationLeaseStatus, UserOpenClawState, UserPersona, UserRole } from "../users.js";
import { type RecordKey } from "../errors.js";
import type { OpaqueMap } from "../store.js";
export declare const GATEWAY_STATE_STORE_KEY = "_gateway-state";
export declare const GATEWAY_STATE_KIND = "gateway-state";
export declare const AUXILIARY_STORE_KEY_PREFIX = "_gateway-";
export declare const AUXILIARY_STORED_KIND = "gateway-auxiliary";
export declare const USER_ROLES: readonly UserRole[];
export declare const MANAGERS: readonly NonNullable<UserOpenClawState["managedBy"]>[];
export declare const AUXILIARY_FAMILIES: readonly UserAuxiliaryFamily[];
export declare const LEASE_STATUSES: readonly UserActivationLeaseStatus[];
export declare const SLUG_PATH = "provisioning.openclaw.slug";
export declare const MATTERMOST_USER_ID_PATH = "mattermost.userId";
export declare const USER_ACTIVATION_LEASE_PATH = "provisioning.openclaw.activationLease";
export declare const AGENT_IDS_PATH = "provisioning.openclaw.agentIds";
export declare const ACTIVATED_AGENTS_PATH = "provisioning.openclaw.activatedAgents";
export declare const ADMITTED_STEP = "complete";
export declare const PROVISIONING_PATHS: {
    readonly status: "provisioning.status";
    readonly startedAt: "provisioning.startedAt";
    readonly gitRepoUrl: "provisioning.git.repoUrl";
    readonly gitCreatedAt: "provisioning.git.createdAt";
};
export declare const USER_MIRROR_PATHS: {
    readonly gatewayId: "provisioning.openclaw.gatewayId";
    readonly gatewayAssignedAt: "provisioning.openclaw.gatewayAssignedAt";
    readonly gatewayProfile: "provisioning.openclaw.gatewayProfile";
    readonly controlUiEnabled: "provisioning.openclaw.controlUiEnabled";
};
export declare const OPENCLAW_PATHS: {
    readonly status: "provisioning.openclaw.status";
    readonly version: "provisioning.openclaw.version";
    readonly agentId: "provisioning.openclaw.agentId";
    readonly customerDir: "provisioning.openclaw.customerDir";
    readonly provisionedAt: "provisioning.openclaw.provisionedAt";
    readonly mounted: "provisioning.openclaw.mounted";
    readonly managedBy: "provisioning.openclaw.managedBy";
    readonly greeting: "provisioning.openclaw.greeting";
    readonly toolchain: "provisioning.openclaw.toolchain";
};
export declare const USER_FENCE_PATHS: {
    readonly restoreFence: "provisioning.openclaw.restoreFence";
    readonly sourceTransferFence: "provisioning.openclaw.sourceTransferFence";
    readonly computerRecovery: "provisioning.computerRecovery";
    readonly migration: "provisioning.openclaw.migration";
    readonly pendingNativeSchedulerRetirement: "provisioning.pendingNativeSchedulerRetirement";
    readonly runtimeReset: "provisioning.openclaw.runtimeReset";
};
export declare const HOME_PATHS: {
    readonly computer: "provisioning.computer";
    readonly homeCheckpoint: "provisioning.homeCheckpoint";
    readonly homeDisk: "provisioning.homeDisk";
    readonly homeArchive: "provisioning.homeArchive";
    readonly homeStorage: "provisioning.homeStorage";
    readonly homeMigration: "provisioning.homeMigration";
    readonly homeErasure: "provisioning.homeErasure";
    readonly homeCapacity: "provisioning.homeCapacity";
    readonly projectStorageNativeBoot: "provisioning.projectStorage.nativeBoot";
};
export declare const TOP_LEVEL_PATHS: {
    readonly slug: "provisioning.openclaw.slug";
    readonly mattermostUserId: "mattermost.userId";
    readonly workspaceId: "workspaceId";
    readonly accountLifecycle: "accountLifecycle";
    readonly scheduleCheckpoint: "scheduleCheckpoint";
    readonly workspaceCheckpoint: "workspaceCheckpoint";
};
export declare const PATCH_GROUPS: {
    readonly provisioning: {
        readonly status: "provisioning.status";
        readonly startedAt: "provisioning.startedAt";
        readonly gitRepoUrl: "provisioning.git.repoUrl";
        readonly gitCreatedAt: "provisioning.git.createdAt";
    };
    readonly openclaw: {
        readonly status: "provisioning.openclaw.status";
        readonly version: "provisioning.openclaw.version";
        readonly agentId: "provisioning.openclaw.agentId";
        readonly customerDir: "provisioning.openclaw.customerDir";
        readonly provisionedAt: "provisioning.openclaw.provisionedAt";
        readonly mounted: "provisioning.openclaw.mounted";
        readonly managedBy: "provisioning.openclaw.managedBy";
        readonly greeting: "provisioning.openclaw.greeting";
        readonly toolchain: "provisioning.openclaw.toolchain";
    };
    readonly home: {
        readonly computer: "provisioning.computer";
        readonly homeCheckpoint: "provisioning.homeCheckpoint";
        readonly homeDisk: "provisioning.homeDisk";
        readonly homeArchive: "provisioning.homeArchive";
        readonly homeStorage: "provisioning.homeStorage";
        readonly homeMigration: "provisioning.homeMigration";
        readonly homeErasure: "provisioning.homeErasure";
        readonly homeCapacity: "provisioning.homeCapacity";
        readonly projectStorageNativeBoot: "provisioning.projectStorage.nativeBoot";
    };
};
export declare const userKey: (uid: string) => RecordKey;
export declare const agentStoreKey: (uid: string, storeKey: string) => RecordKey;
export type PlainObject = Record<string, unknown>;
export declare function isMap(value: unknown): value is PlainObject;
export declare function present<T extends object>(fields: {
    readonly [K in keyof T]: T[K] | undefined;
}): T;
export declare function productValue(data: PlainObject, path: string): unknown;
export declare class StoredFields {
    private readonly record;
    private readonly data;
    constructor(record: RecordKey, data: PlainObject);
    private malformed;
    private value;
    private typed;
    string(path: string): string | undefined;
    number(path: string): number | undefined;
    boolean(path: string): boolean | undefined;
    oneOf<T extends string>(path: string, allowed: readonly T[]): T | undefined;
    map<T = OpaqueMap>(path: string): T | undefined;
    maps(path: string): OpaqueMap[] | undefined;
    strings(path: string): string[];
    requiredString(path: string): string;
    requiredNumber(path: string): number;
    requiredOneOf<T extends string>(path: string, allowed: readonly T[]): T;
}
export declare function userRoleFromData(uid: string, config: PlainObject | undefined): UserRole | null;
export declare function decodePersona(data: PlainObject): UserPersona | null;
export declare function decodeSlug(fields: StoredFields, data: PlainObject): string | null;
export declare function decodeActivationLease(fields: StoredFields): UserActivationLease | null;
export declare function decodeGatewayMirror(fields: StoredFields): IsolatedGatewayMirror | null;
export declare function userRecordFromData(uid: string, data: PlainObject, updatedAt: number, role: UserRole | null): PlatformUserRecord;
export declare function mappedGroup(group: object, paths: Readonly<Record<string, string>>, groupName: string): PlainObject;
export declare function userPatchPaths(patch: object): PlainObject;
export declare function auxiliaryFamilyOf(storeKey: string): UserAuxiliaryFamily | null;
export declare function agentStoreKeyOf(record: AgentStoreRecord): string;
export declare function agentStoreFromData(uid: string, storeKey: string, data: PlainObject): AgentStoreRecord;
