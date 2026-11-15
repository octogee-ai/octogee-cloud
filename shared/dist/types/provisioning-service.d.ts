export declare const PROVISIONING_API_VERSION: "v1";
export declare const PROVISIONING_SERVICE_AUDIENCE: "provisioning-service";
export type ConditionStatus = "True" | "False" | "Unknown";
export declare const USER_PROVISIONING_CONDITION_TYPES: readonly ["ChatReady", "GitReady", "CredentialsIssued", "Ready"];
export type UserProvisioningConditionType = (typeof USER_PROVISIONING_CONDITION_TYPES)[number];
export declare const GIT_KEY_CONDITION_TYPES: readonly ["Registered"];
export type GitKeyConditionType = (typeof GIT_KEY_CONDITION_TYPES)[number];
export declare const PROVISIONING_CONDITION_REASONS: readonly ["Converged", "Pending", "ChatUserFailed", "ChatTeamFailed", "ChatChannelsFailed", "ChatAgentFailed", "UserChatTokenFailed", "GitOwnerFailed", "GitRepositoryFailed", "GitKeyFailed", "ChatNotReady", "GitNotReady", "CredentialsNotIssued"];
export type ProvisioningConditionReason = (typeof PROVISIONING_CONDITION_REASONS)[number];
export interface ProvisioningCondition<Type extends string = string> {
    type: Type;
    status: ConditionStatus;
    reason: ProvisioningConditionReason;
    message: string;
    lastTransitionTime: string;
    observedGeneration: number;
}
export declare const PROVISIONING_WORK_STATES: readonly ["queued", "running", "retrying", "parked", "idle"];
export type ProvisioningWorkState = (typeof PROVISIONING_WORK_STATES)[number];
export declare const GIT_REPOSITORY_ROLES: readonly ["workspace", "project-coaches"];
export type GitRepositoryRole = (typeof GIT_REPOSITORY_ROLES)[number];
export declare const PROVISIONING_CREDENTIAL_NAMES: readonly ["agent-chat-token", "user-chat-token"];
export type ProvisioningCredentialName = (typeof PROVISIONING_CREDENTIAL_NAMES)[number];
export interface UserProvisioningSpec {
    slug: string;
    displayName: {
        first: string;
        last: string;
    };
    email: string;
    avatarUrl: string | null;
    chat: {
        teamDisplayName: string;
        defaultAgent: {
            enabled: boolean;
        };
    };
    git: {
        repositories: GitRepositoryRole[];
        systemConfigRepository: boolean;
    };
    agentIds: string[];
}
export interface ChatOutputs {
    userId: string;
    teamId: string;
    channels: {
        general: string;
        agent?: string;
    };
    agentBotUserId?: string;
}
export interface GitRepositoryOutput {
    cloneUrl: string;
    sshUrl: string;
}
export interface GitOutputs {
    owner: string;
    repositories: Partial<Record<GitRepositoryRole | "system-config", GitRepositoryOutput>>;
}
export interface UserProvisioningOutputs {
    chat?: ChatOutputs;
    git?: GitOutputs;
    credentials: ProvisioningCredentialName[];
}
export interface ProvisioningWorkStatus {
    state: ProvisioningWorkState;
    attempts: number;
    nextAttemptAt: string | null;
    lastAttemptAt: string | null;
}
export interface UserProvisioningStatus {
    observedGeneration: number;
    conditions: ProvisioningCondition<UserProvisioningConditionType>[];
    outputs: UserProvisioningOutputs;
    work: ProvisioningWorkStatus;
}
export interface UserProvisioning {
    uid: string;
    generation: number;
    resourceVersion: string;
    spec: UserProvisioningSpec;
    status: UserProvisioningStatus;
}
export interface PutUserProvisioningRequest {
    spec: UserProvisioningSpec;
    expectedResourceVersion?: string;
}
export interface GitKeySpec {
    publicKey: string;
}
export interface GitKeyStatus {
    observedGeneration: number;
    conditions: ProvisioningCondition<GitKeyConditionType>[];
}
export interface GitKey {
    uid: string;
    gatewayId: string;
    generation: number;
    resourceVersion: string;
    deletionRequestedAt: string | null;
    spec: GitKeySpec;
    status: GitKeyStatus;
}
export interface PutGitKeyRequest {
    spec: GitKeySpec;
}
export interface ProvisioningCredential {
    name: ProvisioningCredentialName;
    value: string;
    version: number;
}
export interface RetryProvisioningRequest {
    expectedAttempts?: number;
}
export interface UserProvisioningList {
    items: UserProvisioning[];
    resourceVersion: string;
    nextPageToken?: string;
}
export interface UserProvisioningWatchResponse {
    items: UserProvisioning[];
    resourceVersion: string;
}
export interface UserProvisioningListQuery {
    ready?: boolean;
    reason?: ProvisioningConditionReason;
    workState?: Exclude<ProvisioningWorkState, "idle">;
    limit?: number;
    pageToken?: string;
}
export interface UserProvisioningWatchQuery {
    watch: true;
    resourceVersion: string;
    timeoutSeconds?: number;
}
export declare const PROVISIONING_STEPS: readonly ["chat-user", "chat-team", "chat-channels", "chat-agent", "user-chat-token", "git-owner", "git-repositories", "git-keys"];
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];
export type ProvisioningStepOutcome = "succeeded" | "failed" | "skipped";
export interface ProvisioningStepRecord {
    step: ProvisioningStep;
    outcome: ProvisioningStepOutcome;
    reason?: ProvisioningConditionReason;
    message?: string;
    durationMs: number;
}
export type ProvisioningAttemptResult = "succeeded" | "failed" | "parked" | "lease-lost";
export interface ProvisioningAttempt {
    generation: number;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    result: ProvisioningAttemptResult;
    reason?: ProvisioningConditionReason;
    steps: ProvisioningStepRecord[];
}
export interface ProvisioningEventsResponse {
    items: ProvisioningAttempt[];
}
export declare const PROVISIONING_ERROR_CODES: readonly ["invalid-request", "unauthenticated", "forbidden", "not-found", "precondition-failed", "idempotency-conflict", "work-running", "not-retryable", "not-issued", "resource-version-expired", "rate-limited", "unavailable"];
export type ProvisioningErrorCode = (typeof PROVISIONING_ERROR_CODES)[number];
export interface ProvisioningErrorBody {
    code: ProvisioningErrorCode;
    error: string;
}
export declare const PROVISIONING_ROLES: readonly ["writer", "key-writer", "reader", "credential-reader"];
export type ProvisioningRole = (typeof PROVISIONING_ROLES)[number];
