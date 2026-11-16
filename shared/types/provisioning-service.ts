export const PROVISIONING_API_VERSION = "v1" as const;
export const PROVISIONING_SERVICE_AUDIENCE = "provisioning-service" as const;

export type ConditionStatus = "True" | "False" | "Unknown";

export const USER_PROVISIONING_CONDITION_TYPES = ["ChatReady", "GitReady", "CredentialsIssued", "Ready"] as const;
export type UserProvisioningConditionType = (typeof USER_PROVISIONING_CONDITION_TYPES)[number];

export const GIT_KEY_CONDITION_TYPES = ["Registered"] as const;
export type GitKeyConditionType = (typeof GIT_KEY_CONDITION_TYPES)[number];

export const PROVISIONING_CONDITION_REASONS = [
  "Converged",
  "Pending",
  "ChatUserFailed",
  "ChatTeamFailed",
  "ChatChannelsFailed",
  "ChatAgentFailed",
  "UserChatTokenFailed",
  "GitOwnerFailed",
  "GitRepositoryFailed",
  "GitKeyFailed",
  "GitKeyHeldElsewhere",
  "ChatNotReady",
  "GitNotReady",
  "CredentialsNotIssued",
] as const;
export type ProvisioningConditionReason = (typeof PROVISIONING_CONDITION_REASONS)[number];

export interface ProvisioningCondition<Type extends string = string> {
  type: Type;
  status: ConditionStatus;
  reason: ProvisioningConditionReason;
  message: string;
  lastTransitionTime: string;
  observedGeneration: number;
}

export const PROVISIONING_WORK_STATES = ["queued", "running", "retrying", "parked", "idle"] as const;
export type ProvisioningWorkState = (typeof PROVISIONING_WORK_STATES)[number];

export const GIT_REPOSITORY_ROLES = ["workspace", "project-coaches"] as const;
export type GitRepositoryRole = (typeof GIT_REPOSITORY_ROLES)[number];

export const PROVISIONING_CREDENTIAL_NAMES = ["agent-chat-token", "user-chat-token"] as const;
export type ProvisioningCredentialName = (typeof PROVISIONING_CREDENTIAL_NAMES)[number];

export interface UserProvisioningSpec {
  slug: string;
  displayName: { first: string; last: string };
  email: string;
  avatarUrl: string | null;
  chat: {
    teamDisplayName: string;
    defaultAgent: { enabled: boolean };
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
  channels: { general: string; agent?: string };
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
  nextAttemptAt: string | null;
  observedPutSequence: number;
}

export interface GitKey {
  uid: string;
  gatewayId: string;
  holder: string;
  generation: number;
  putSequence: number;
  resourceVersion: string;
  deletionRequestedAt: string | null;
  spec: GitKeySpec;
  status: GitKeyStatus;
}

export interface GitKeyHolderSummary {
  holder: string;
  gatewayId: string;
}

export interface GitKeyHoldersResponse {
  holders: GitKeyHolderSummary[];
}

export interface GitKeyRelease {
  remaining: number;
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

export interface UserProvisioningDeletion {
  uid: string;
  resourceVersion: string;
}

export interface UserProvisioningWatchResponse {
  items: UserProvisioning[];
  deleted?: UserProvisioningDeletion[];
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
  limit?: number;
}

export const PROVISIONING_STEPS = [
  "chat-user",
  "chat-team",
  "chat-channels",
  "chat-agent",
  "user-chat-token",
  "git-owner",
  "git-repositories",
  "git-keys",
] as const;
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

export const PROVISIONING_ERROR_CODES = [
  "invalid-request",
  "unauthenticated",
  "forbidden",
  "not-found",
  "precondition-failed",
  "idempotency-conflict",
  "work-running",
  "not-retryable",
  "not-issued",
  "resource-version-expired",
  "rate-limited",
  "unavailable",
] as const;
export type ProvisioningErrorCode = (typeof PROVISIONING_ERROR_CODES)[number];

export interface ProvisioningErrorBody {
  code: ProvisioningErrorCode;
  error: string;
}

export const PROVISIONING_ROLES = ["writer", "key-writer", "key-retirer", "reader", "credential-reader"] as const;
export type ProvisioningRole = (typeof PROVISIONING_ROLES)[number];
