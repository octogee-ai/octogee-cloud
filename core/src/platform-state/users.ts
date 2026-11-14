import type { AccountLifecycle } from "@octogee/shared/types/account-lifecycle";
import type {
  UserAuxiliaryFamily,
  FleetBrokerUserRuntimeReset,
} from "@octogee/shared/types/fleet-broker";
import type { ScheduleTransferDoc } from "@octogee/shared/types/fleet-controller";
import type { UserParkedVm, GatewayProfile, GatewayVmHomeCheckpoint } from "@octogee/shared/types/glm";
import type { PlacementReceipt, PlacementReceiptKind } from "@octogee/shared/types/placement-receipts";
import type { WorkspaceMigrationMarker } from "@octogee/shared/types/workspace-migration";
import type {
  Clearable,
  OpaqueMap,
  Page,
  PageRequest,
  RecordPatch,
  Revision,
  Stored,
  TimeInput,
} from "./store.js";

export type UserRole = "user" | "admin";

export type UserActivationLeaseStatus =
  | "requested"
  | "provisioning"
  | "activating"
  | "active"
  | "returning"
  | "parked"
  | "failed";

export interface UserActivationLease {
  readonly leaseId: string;
  readonly generation: number;
  readonly status: UserActivationLeaseStatus;
  readonly targetGatewayId?: string | null;
  readonly sourceGatewayId?: string;
  readonly sourceAssignmentEpoch?: number;
  readonly lastActiveAt?: number | null;
  readonly [field: string]: unknown;
}

export interface ActivationLeaseFence {
  readonly leaseId: string | null;
  readonly generation: number | null;
  readonly status?: readonly UserActivationLeaseStatus[];
}

export interface SourceTransferFence {
  readonly sourceGatewayId: string;
  readonly targetGatewayId: string;
  readonly [field: string]: unknown;
}

export interface VmRecoveryFence {
  readonly operationId: string;
  readonly gatewayId: string;
  readonly instanceId?: string | null;
  readonly sharedGatewayId?: string | null;
  readonly assignmentEpoch?: number;
}

export type IsolatedRuntimeReset =
  | FleetBrokerUserRuntimeReset
  | (Omit<FleetBrokerUserRuntimeReset, "status"> & { readonly status: "acknowledged"; readonly acknowledgedAt: TimeInput });

export interface UserFences {
  readonly restoreFence?: OpaqueMap;
  readonly sourceTransferFence?: SourceTransferFence;
  readonly computerRecovery?: VmRecoveryFence;
  readonly migration?: WorkspaceMigrationMarker;
  readonly pendingNativeSchedulerRetirement?: OpaqueMap;
  readonly runtimeReset?: IsolatedRuntimeReset & OpaqueMap;
}

export type UserFenceName = keyof UserFences;

export interface UserProvisioning {
  readonly status?: string;
  readonly startedAt?: number;
  readonly gitRepoUrl?: string;
  readonly gitCreatedAt?: number;
}

export interface IsolatedGatewayMirror {
  readonly gatewayId: string;
  readonly gatewayAssignedAt?: number;
  readonly gatewayProfile?: GatewayProfile;
  readonly controlUiEnabled?: boolean;
}

export type IsolatedGatewayMirrorInput = Omit<IsolatedGatewayMirror, "gatewayAssignedAt"> & {
  readonly gatewayAssignedAt?: TimeInput;
};

export interface UserOpenClawState {
  readonly status?: string;
  readonly version?: string;
  readonly agentId?: string;
  readonly customerDir?: string;
  readonly provisionedAt?: number;
  readonly mounted?: boolean;
  readonly managedBy?: "cowboy" | "operator";
  readonly greeting?: OpaqueMap;
  readonly toolchain?: OpaqueMap;
}

export interface UserHomeState {
  readonly computer?: UserParkedVm;
  readonly homeCheckpoint?: GatewayVmHomeCheckpoint;
  readonly homeDisk?: OpaqueMap;
  readonly homeStorage?: OpaqueMap;
  readonly homeMigration?: OpaqueMap;
  readonly homeErasure?: readonly OpaqueMap[];
  readonly homeCapacity?: OpaqueMap;
  readonly projectStorageNativeBoot?: boolean;
}

export interface UserAgentRoster {
  readonly agentIds: readonly string[];
  readonly activatedAgents: readonly string[];
}

export type UserPersona = OpaqueMap;

export interface PlatformUserRecord {
  readonly uid: string;
  readonly slug: string | null;
  readonly mattermostUserId: string | null;
  readonly admitted: boolean;
  readonly persona: UserPersona | null;
  readonly workspaceId: string | null;
  readonly role: UserRole | null;
  readonly createdAt: number | null;
  readonly updatedAt: number;
  readonly provisioning: UserProvisioning;
  readonly gateway: IsolatedGatewayMirror | null;
  readonly openclaw: UserOpenClawState;
  readonly agents: UserAgentRoster;
  readonly accountLifecycle: AccountLifecycle | null;
  readonly activationLease: UserActivationLease | null;
  readonly fences: UserFences;
  readonly home: UserHomeState;
}

export interface NewUserRecord {
  readonly uid: string;
  readonly createdAt: TimeInput;
}

export interface AdmitUserInput {
  readonly slug: string;
  readonly persona: UserPersona | null;
  readonly createdAt: TimeInput;
  readonly provisioningStartedAt: TimeInput;
}

export interface UserPatch {
  readonly slug?: Clearable<string>;
  readonly mattermostUserId?: Clearable<string>;
  readonly workspaceId?: Clearable<string>;
  readonly role?: Clearable<UserRole>;
  readonly provisioning?: RecordPatch<Omit<UserProvisioning, "startedAt" | "gitCreatedAt">> & {
    readonly startedAt?: Clearable<TimeInput>;
    readonly gitCreatedAt?: Clearable<TimeInput>;
  };
  readonly openclaw?: RecordPatch<Omit<UserOpenClawState, "provisionedAt">> & {
    readonly provisionedAt?: Clearable<TimeInput>;
  };
  readonly accountLifecycle?: Clearable<AccountLifecycle>;
  readonly home?: RecordPatch<UserHomeState>;
}

export interface UserFence {
  readonly revision?: Revision;
  readonly gatewayId?: string | null;
  readonly provisioningStatus?: string | "absent";
}

export interface GatewayFenceHolders {
  readonly assigned: readonly Stored<PlatformUserRecord>[];
  readonly sourceTransferSource: readonly Stored<PlatformUserRecord>[];
  readonly sourceTransferTarget: readonly Stored<PlatformUserRecord>[];
  readonly computerRecovery: readonly Stored<PlatformUserRecord>[];
}

export interface IsolatedGatewayFilter {
  readonly openclawStatus?: string;
  readonly limit?: number;
}

export interface UserRecordsRepository {
  get(uid: string): Promise<Stored<PlatformUserRecord> | null>;
  getRole(uid: string): Promise<UserRole | null>;
  getMany(uids: readonly string[]): Promise<ReadonlyMap<string, Stored<PlatformUserRecord>>>;
  findBySlug(slug: string): Promise<Stored<PlatformUserRecord> | null>;
  findByMattermostUserId(mattermostUserId: string): Promise<Stored<PlatformUserRecord> | null>;
  findByVmInstanceId(instanceId: string): Promise<Stored<PlatformUserRecord> | null>;
  listByAgentId(agentId: string, limit: number): Promise<readonly Stored<PlatformUserRecord>[]>;
  listByGateway(gatewayId: string, filter?: IsolatedGatewayFilter): Promise<readonly Stored<PlatformUserRecord>[]>;
  listGatewayFenceHolders(gatewayId: string): Promise<GatewayFenceHolders>;
  listAdmitted(): Promise<readonly Stored<PlatformUserRecord>[]>;
  listAll(): Promise<readonly Stored<PlatformUserRecord>[]>;
  listByOpenClawStatus(openclawStatus: string): Promise<readonly Stored<PlatformUserRecord>[]>;
  list(page: PageRequest): Promise<Page<Stored<PlatformUserRecord>>>;
  create(record: NewUserRecord): Promise<void>;
  patch(uid: string, patch: UserPatch, fence?: UserFence): Promise<void>;
  admit(uid: string, input: AdmitUserInput): Promise<void>;
  setGatewayMirror(uid: string, mirror: Clearable<IsolatedGatewayMirrorInput>, fence?: UserFence): Promise<void>;
  addAgents(uid: string, agentIds: readonly string[]): Promise<void>;
  removeAgents(uid: string, agentIds: readonly string[]): Promise<void>;
  setActivatedAgents(uid: string, activatedAgents: readonly string[]): Promise<void>;
  setActivationLease(uid: string, lease: Clearable<UserActivationLease>, fence: ActivationLeaseFence): Promise<void>;
  patchActivationLease(
    uid: string,
    patch: RecordPatch<UserActivationLease, "leaseId" | "generation">,
    fence: ActivationLeaseFence,
  ): Promise<void>;
  setFence<F extends UserFenceName>(
    uid: string,
    fence: F,
    value: Clearable<NonNullable<UserFences[F]>>,
    expected?: NonNullable<UserFences[F]> | "absent",
  ): Promise<void>;
  delete(uid: string): Promise<void>;
}

export interface PlacementReceiptsRepository {
  get(uid: string, leaseId: string, generation: number, kind: PlacementReceiptKind): Promise<PlacementReceipt | null>;
  list(uid: string, page: PageRequest): Promise<Page<PlacementReceipt>>;
  create(uid: string, receipt: PlacementReceipt): Promise<void>;
}

export interface UnrestoredScheduleTransfer {
  readonly uid: string;
  readonly transfer: Stored<ScheduleTransferDoc>;
}

export interface ScheduleTransfersRepository {
  get(uid: string, migrationId: string): Promise<Stored<ScheduleTransferDoc> | null>;
  put(uid: string, transfer: ScheduleTransferDoc): Promise<void>;
  patch(uid: string, migrationId: string, patch: RecordPatch<ScheduleTransferDoc, "migrationId">): Promise<void>;
  listUnrestored(): Promise<readonly UnrestoredScheduleTransfer[]>;
}

export type AgentStoreAnchor =
  | { readonly kind: "agent"; readonly storeId: string; readonly agentId: string; readonly schema: string }
  | { readonly kind: "gateway-state"; readonly storeId: string; readonly schema: string }
  | { readonly kind: "auxiliary"; readonly storeId: string; readonly schema: string; readonly family: UserAuxiliaryFamily };

export type AgentStoreRecord = AgentStoreAnchor & {
  readonly gatewayId: string | null;
  readonly generation: number | null;
  readonly assignmentEpoch: number | null;
  readonly recordedAt: number;
};

export interface AgentStoresRepository {
  list(uid: string): Promise<readonly Stored<AgentStoreRecord>[]>;
  put(uid: string, record: AgentStoreRecord): Promise<void>;
  delete(uid: string, storeKey: string): Promise<void>;
}

export interface UserAccountRecord {
  readonly uid: string;
  readonly name: string;
  readonly email: string;
  readonly createdAt: number;
}

export type NewUserAccountRecord = Omit<UserAccountRecord, "createdAt"> & { readonly createdAt: TimeInput };

export interface UserAccountsRepository {
  get(uid: string): Promise<Stored<UserAccountRecord> | null>;
  getMany(uids: readonly string[]): Promise<ReadonlyMap<string, Stored<UserAccountRecord>>>;
  listAll(): Promise<readonly Stored<UserAccountRecord>[]>;
  create(account: NewUserAccountRecord): Promise<void>;
}

export interface AgentModelSelectionRecord {
  readonly uid: string;
  readonly agentId: string;
  readonly primary: string;
  readonly fallbacks: readonly string[];
  readonly updatedAt: number;
}

export type AgentModelSelectionInput = Omit<AgentModelSelectionRecord, "updatedAt"> & { readonly updatedAt: TimeInput };

export interface AgentModelSelectionsRepository {
  list(uid: string): Promise<readonly Stored<AgentModelSelectionRecord>[]>;
  put(selection: AgentModelSelectionInput): Promise<void>;
  delete(uid: string, agentId: string): Promise<void>;
}

export type SessionModelOperationName =
  | "getSessionModel"
  | "listModels"
  | "listModelsByProvider"
  | "setSessionModel"
  | "resetSessionModel";

export type SessionModelAuditOutcome = "pending" | "failed" | "applied" | "rejected" | "unknown";

export interface SessionModelAuditRecord {
  readonly auditId: string;
  readonly actorUid: string;
  readonly channelId: string;
  readonly workspaceSlug: string;
  readonly projectId: string | null;
  readonly agentId: string;
  readonly operation: SessionModelOperationName;
  readonly requestedModel: string | null;
  readonly outcome: SessionModelAuditOutcome;
  readonly commandPostId: string | null;
  readonly replyPostId: string | null;
  readonly resultingModel: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
}

export type NewSessionModelAudit = Omit<
  SessionModelAuditRecord,
  "outcome" | "commandPostId" | "replyPostId" | "resultingModel" | "createdAt" | "completedAt"
> & { readonly createdAt: TimeInput };

export interface SessionModelAuditCompletion {
  readonly outcome: Exclude<SessionModelAuditOutcome, "pending">;
  readonly commandPostId: string | null;
  readonly replyPostId: string | null;
  readonly resultingModel: string | null;
  readonly completedAt: TimeInput;
}

export interface SessionModelAuditRepository {
  get(auditId: string): Promise<Stored<SessionModelAuditRecord> | null>;
  create(entry: NewSessionModelAudit): Promise<void>;
  complete(auditId: string, completion: SessionModelAuditCompletion): Promise<void>;
}

export interface UserRepositories {
  readonly records: UserRecordsRepository;
  readonly accounts: UserAccountsRepository;
  readonly placementReceipts: PlacementReceiptsRepository;
  readonly scheduleTransfers: ScheduleTransfersRepository;
  readonly agentStores: AgentStoresRepository;
  readonly agentModels: AgentModelSelectionsRepository;
  readonly sessionModelAudit: SessionModelAuditRepository;
}

export type PlacementAdmissionDecision =
  | { readonly kind: "admitted" }
  | { readonly kind: "pending"; readonly reason: string }
  | { readonly kind: "refused"; readonly code: string; readonly reason: string };

export interface PlacementAdmissionPolicy {
  decide(uid: string): Promise<PlacementAdmissionDecision>;
}

export interface UserPlacementPolicy {
  readonly uid: string;
  readonly sizingKey: string | null;
  readonly byot: boolean;
  readonly workspacePermissions: boolean;
}

export interface UserPlacementPolicies {
  resolve(uid: string, now: number): Promise<UserPlacementPolicy>;
  resolveMany(uids: readonly string[], now: number): Promise<ReadonlyMap<string, UserPlacementPolicy>>;
}

export interface PlatformUserProfile {
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly lastName: string | null;
  readonly photoUrl: string | null;
}

export interface UserProfiles {
  resolve(uid: string): Promise<PlatformUserProfile | null>;
}

export interface ControlSessionAttachment {
  readonly uid: string;
  readonly gatewayId: string;
  readonly workspaceSlug: string;
  readonly attachmentId: string;
}

export interface ControlSessionChecks {
  current(attachment: ControlSessionAttachment, now: number): Promise<boolean>;
}

