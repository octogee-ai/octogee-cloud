import { type UserMigrationV2GatewayRootFence } from "@octogee/shared/types/glm";
import { type AssignmentSource, type AssignmentState } from "@octogee/shared/types/gateway-releases";
import type { FleetBrokerUserRestoreAuthority } from "@octogee/shared/types/fleet-broker";
import { type WorkspaceMigrationPhase } from "@octogee/shared/types/workspace-migration";
import { type SizingKeyReader } from "./sizing-key.js";
import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/index.js";
export interface FleetStateDeps {
    store: PlatformStateStore;
    now?: () => Date;
    log?: (msg: string) => void;
}
export interface CutoverDeps extends FleetStateDeps {
    readSizingKey: SizingKeyReader;
}
export declare function setWorkspaceMigrationPhase(deps: FleetStateDeps, params: {
    uid: string;
    sourceGatewayId: string;
    operationId: string;
    phase: WorkspaceMigrationPhase;
}): Promise<void>;
export interface WorkspaceMigrationPreparationParams {
    uid: string;
    sourceGatewayId: string;
    operationId: string;
    sourceAssignmentMode: "assigned" | "unassigned-live";
    sourceRelease: number;
    sourceEpoch: number;
    sourceRootUpdatedAt?: number;
}
export interface WorkspaceMigrationRecoveryParams {
    uid: string;
    sourceGatewayId: string;
    operationId: string;
    sourceEpoch: number;
    claimStartedAt: number;
}
export interface WorkspaceMigrationSourcePreparationParams extends WorkspaceMigrationRecoveryParams {
    slug: string;
    targetGatewayId: string;
}
export declare function assertWorkspaceMigrationSourcePreparationAuthority(deps: FleetStateDeps, params: WorkspaceMigrationSourcePreparationParams): Promise<void>;
export declare function assertWorkspaceMigrationRecoveryAuthority(deps: FleetStateDeps, params: WorkspaceMigrationRecoveryParams): Promise<void>;
export declare function userActivationRecoveryTargetMatches(params: {
    operationId: string;
    input: Record<string, unknown>;
    openclaw: Record<string, unknown>;
    sourceEpoch: number;
    targetRoot: unknown;
}): boolean;
export declare function completeWorkspaceMigrationRecovery(deps: FleetStateDeps, params: WorkspaceMigrationRecoveryParams): Promise<void>;
export declare function sharedRecoveryTargetCleaned(input: Record<string, unknown>, schedulerHandoff: unknown): boolean;
export declare function isolatedTargetBelongsToUser(targetRoot: unknown, input: Record<string, unknown>): boolean;
export declare function clearWorkspaceMigrationPreparation(deps: FleetStateDeps, params: WorkspaceMigrationPreparationParams): Promise<void>;
export declare function clearRetiredUserActivationPreparation(deps: FleetStateDeps, params: {
    uid: string;
    targetGatewayId: string;
    generation: number;
    retirementOperationId: string;
}): Promise<boolean>;
export interface UserRestoreInput {
    fromGatewayId: string;
    uid: string;
    slug: string;
    gatewayId: string;
    assignmentEpoch: number;
    operationId: string;
    claimStartedAt: number;
    attemptId: string;
}
export declare function readUserRestoreAuthoritySnapshot(deps: Pick<FleetStateDeps, "store">, scope: {
    uid: string;
    slug: string;
    gatewayId: string;
}): Promise<FleetBrokerUserRestoreAuthority | undefined>;
export declare function beginUserRestore(deps: FleetStateDeps, input: UserRestoreInput, options?: {
    resume?: boolean;
}): Promise<UserRestoreInput>;
export declare function acknowledgeUserRestore(deps: FleetStateDeps, input: UserRestoreInput): Promise<void>;
export interface CutoverCommitParams {
    uid: string;
    slug: string;
    toGatewayId: string;
    fromGatewayId: string;
    flipMirror: boolean;
    assignment: {
        source: AssignmentSource;
        updatedByOperationId: string | null;
    } | null;
    userMigrationV2Fence?: {
        claimStartedAt?: number;
        operationId: string;
        migrationId: string;
        uid: string;
        slug: string;
        sourceGatewayId: string;
        sourceEpoch: number;
        sourceRelease: number;
        sourceAssignmentMode: "assigned" | "unassigned-live";
        sourceRootFence: UserMigrationV2GatewayRootFence;
        targetGatewayId: string;
        targetRelease: number;
        targetRootFence: UserMigrationV2GatewayRootFence;
    };
    automatic?: boolean;
}
export declare function legacyForwardRecoveryMatches(operationId: string, input: Record<string, unknown>, handoff: Record<string, unknown>): boolean;
export declare function migrationCancellationDeferred(operation: Record<string, unknown>, operationId: string): boolean;
export declare function commitCutoverAtomic(deps: CutoverDeps, params: CutoverCommitParams): Promise<void>;
export interface UnavailableGatewayRecoveryParams {
    operationId: string;
    kind: "recover-shared-customer";
    uid: string;
    slug: string;
    fromGatewayId: string;
    toGatewayId: string;
    expectedSourceEpoch: number;
    sharedGatewayIds: readonly string[];
    targetHeartbeatMaxAgeMs: number;
    validateTarget?: (context: UnavailableGatewayRecoveryTargetValidationContext) => Promise<void>;
}
export interface UnavailableGatewayRecoveryTargetValidationContext {
    transaction: PlatformStateTransaction;
    targetGatewayId: string;
    targetRoot: Record<string, unknown>;
    targetRuntime: Record<string, unknown>;
}
export declare function commitUnavailableGatewayRecoveryAtomic(deps: FleetStateDeps, params: UnavailableGatewayRecoveryParams): Promise<{
    operationId: string;
}>;
export interface RecoveredDisposableRuntimeResetParams {
    operationId: string;
    previousRecoveryOperationId: string;
    uid: string;
    slug: string;
    targetGatewayId: string;
    expectedAssignmentEpoch: number;
    sharedGatewayIds: readonly string[];
    targetHeartbeatMaxAgeMs: number;
}
export declare function commitRecoveredDisposableRuntimeResetAtomic(deps: FleetStateDeps, params: RecoveredDisposableRuntimeResetParams): Promise<{
    operationId: string;
}>;
export interface MarkAssignmentStateParams {
    gatewayId: string;
    uid: string;
    state: AssignmentState;
    slug?: string;
    epoch?: number;
    updatedByOperationId?: string;
    createIfMissing?: boolean;
    expected?: {
        state: AssignmentState;
        updatedByOperationId: string | null;
        updatedAt?: number;
    };
    automatic?: boolean;
    clearSharedSurgeForwardRecovery?: {
        operationId: string;
        targetPodUid: string;
        receivingPodUid: string;
    };
}
interface SharedSurgeForwardRecoveryParams {
    gatewayId: string;
    uid: string;
    slug: string;
    epoch: number;
    operationId: string;
    targetPodUid: string;
    expectedUpdatedAt: number;
}
export declare function markSharedSurgeForwardRecovery(deps: FleetStateDeps, params: SharedSurgeForwardRecoveryParams): Promise<void>;
export declare function rebindSharedSurgeForwardRecovery(deps: FleetStateDeps, params: SharedSurgeForwardRecoveryParams & {
    expectedReceivingPodUid: string;
    receivingPodUid: string;
}): Promise<void>;
export declare function markAssignmentState(deps: FleetStateDeps, params: MarkAssignmentStateParams): Promise<void>;
export {};
