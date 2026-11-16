export const PROVISIONING_API_VERSION = "v1";
export const PROVISIONING_SERVICE_AUDIENCE = "provisioning-service";
export const USER_PROVISIONING_CONDITION_TYPES = ["ChatReady", "GitReady", "CredentialsIssued", "Ready"];
export const GIT_KEY_CONDITION_TYPES = ["Registered"];
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
    "GitKeyNotOnHost",
    "GitKeyReplacedOnHost",
    "ChatNotReady",
    "GitNotReady",
    "CredentialsNotIssued",
];
export const PROVISIONING_WORK_STATES = ["queued", "running", "retrying", "parked", "idle"];
export const GIT_REPOSITORY_ROLES = ["workspace", "project-coaches"];
export const PROVISIONING_CREDENTIAL_NAMES = ["agent-chat-token", "user-chat-token"];
export const PROVISIONING_STEPS = [
    "chat-user",
    "chat-team",
    "chat-channels",
    "chat-agent",
    "user-chat-token",
    "git-owner",
    "git-repositories",
    "git-keys",
];
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
];
export const PROVISIONING_ROLES = ["writer", "key-writer", "key-retirer", "reader", "credential-reader"];
