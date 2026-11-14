type JsonObject = Record<string, unknown>;
declare const ABSENT: unique symbol;
declare const REQUIRED_ARRAY: "required-array";
declare const USER_AGENT_WORKSPACE: "customer-agent-workspace";
declare const USER_AGENT_TOOL_POLICY: "customer-agent-tool-policy";
declare const PROJECT_AGENT_TOOL_POLICY: "project-agent-tool-policy";
declare const FORBIDDEN_ARRAY: "forbidden-array";
export type GatewayConfigClass = "shared" | "isolated";
export type GatewayControlIdentityMode = "shared-operator" | "per-user";
type BrokerProviderEnvironment = Partial<Pick<NodeJS.ProcessEnv, "OPENROUTER_BASE_URL" | "PLATFORM_OPENAI_BASE_URL" | "PLATFORM_VERTEX_BASE_URL" | "PLATFORM_META_BASE_URL">>;
/** Declare provider ownership; API, model rows and credentials remain agent-local. */
export declare function platformBrokerProviderDeclarations(env: BrokerProviderEnvironment): Record<string, {
    baseUrl: string;
    models: never[];
}>;
/** Missing public declarations are a safe addition; existing routes and auth must match exactly. */
export declare function userModelProviderDeclarationsMatch(current: Record<string, unknown>, expected: Record<string, unknown>): boolean;
export interface SystemConfigInvariantContext {
    gatewayClass: GatewayConfigClass;
    gatewayId?: string;
    apiOrigin?: string;
    controlIdentity?: GatewayControlIdentityMode;
    ownerUid?: string;
    workspaceSlug?: string;
    brokerProviderEnv?: BrokerProviderEnvironment;
}
type ExactInvariant = {
    kind: "exact";
    path: string;
    value: unknown | typeof ABSENT;
    project?: boolean;
};
type RequiredArrayInvariant = {
    kind: typeof REQUIRED_ARRAY;
    path: string;
    values: readonly string[];
};
type ForbiddenArrayInvariant = {
    kind: typeof FORBIDDEN_ARRAY;
    path: string;
    values: readonly string[];
};
type UserAgentWorkspaceInvariant = {
    kind: typeof USER_AGENT_WORKSPACE;
    path: "agents.list[].tools.fs.workspaceOnly" | "agents.entries.*.tools.fs.workspaceOnly";
};
type MattermostAccountProjectionInvariant = {
    kind: "mattermost-account-projection";
    path: "channels.mattermost.accounts";
    platformOwned: boolean;
};
type UserAgentToolPolicyInvariant = {
    kind: typeof USER_AGENT_TOOL_POLICY;
    path: "agents.list[].tools" | "agents.entries.*.tools";
};
type ProjectAgentToolPolicyInvariant = {
    kind: typeof PROJECT_AGENT_TOOL_POLICY;
    path: "agents.list[].tools" | "agents.entries.*.tools";
};
export type PlatformInvariant = ExactInvariant | RequiredArrayInvariant | ForbiddenArrayInvariant | UserAgentWorkspaceInvariant | UserAgentToolPolicyInvariant | ProjectAgentToolPolicyInvariant | MattermostAccountProjectionInvariant;
export declare const USER_CODE_DENIED_TOOLS: readonly ["exec", "process", "subagents", "sessions_spawn", "terminal", "preview_start", "preview_stop", "preview_list", "octogee_publish", "bundle-mcp", "skill_workshop", "skill_library", "conversations_list", "conversations_send", "conversations_turn", "browser", "computer"];
export declare const USER_WORKFLOW_TOOLS: readonly ["automations", "message", "octogee_project_create", "octogee_project_delegate", "octogee_project_commit", "octogee_project_list", "octogee_project_set_recipe", "octogee_project_capability", "octogee_project_build", "octogee_project_test", "octogee_project_preview", "octogee_project_run_status", "octogee_project_publish", "octogee_board_list", "octogee_board_card_read", "octogee_board_card_create", "octogee_board_card_update", "octogee_board_card_move", "octogee_board_card_comment", "workspace_commit", "brave_search", "tavily_search", "tavily_extract", "octogee_chat_search", "octogee_chat_history", "octogee_chat_set_identity", "octogee_connection_request", "octogee_status", "octogee_ask_ops", "octogee_google_calendar_events", "octogee_google_calendar_create", "octogee_google_calendar_create_approved", "octogee_google_calendar_update", "octogee_google_calendar_update_approved", "octogee_google_calendar_delete", "octogee_google_calendar_delete_approved", "octogee_google_gmail_search", "octogee_google_gmail_get", "octogee_google_gmail_triage", "octogee_google_gmail_triage_approved", "octogee_google_gmail_draft_create", "octogee_google_gmail_draft_create_approved", "octogee_google_gmail_draft_send", "octogee_google_gmail_draft_send_approved", "octogee_google_drive_read", "octogee_google_docs_read", "octogee_google_docs_write", "octogee_google_contacts_read", "octogee_google_tasks_lists", "octogee_google_tasks_list", "octogee_google_tasks_add", "octogee_google_tasks_add_approved", "octogee_google_tasks_update", "octogee_google_tasks_update_approved", "octogee_google_sheets_read", "octogee_google_sheets_write", "octogee_obsidian_read", "octogee_obsidian_write", "octogee_owner_automations"];
export declare const PRODUCTIVITY_TOOL_NAMES: ("automations" | "brave_search" | "message" | "octogee_ask_ops" | "octogee_board_card_comment" | "octogee_board_card_create" | "octogee_board_card_move" | "octogee_board_card_read" | "octogee_board_card_update" | "octogee_board_list" | "octogee_chat_history" | "octogee_chat_search" | "octogee_chat_set_identity" | "octogee_connection_request" | "octogee_google_calendar_create" | "octogee_google_calendar_create_approved" | "octogee_google_calendar_delete" | "octogee_google_calendar_delete_approved" | "octogee_google_calendar_events" | "octogee_google_calendar_update" | "octogee_google_calendar_update_approved" | "octogee_google_contacts_read" | "octogee_google_docs_read" | "octogee_google_docs_write" | "octogee_google_drive_read" | "octogee_google_gmail_draft_create" | "octogee_google_gmail_draft_create_approved" | "octogee_google_gmail_draft_send" | "octogee_google_gmail_draft_send_approved" | "octogee_google_gmail_get" | "octogee_google_gmail_search" | "octogee_google_gmail_triage" | "octogee_google_gmail_triage_approved" | "octogee_google_sheets_read" | "octogee_google_sheets_write" | "octogee_google_tasks_add" | "octogee_google_tasks_add_approved" | "octogee_google_tasks_list" | "octogee_google_tasks_lists" | "octogee_google_tasks_update" | "octogee_google_tasks_update_approved" | "octogee_obsidian_read" | "octogee_obsidian_write" | "octogee_owner_automations" | "octogee_project_build" | "octogee_project_capability" | "octogee_project_commit" | "octogee_project_create" | "octogee_project_delegate" | "octogee_project_list" | "octogee_project_preview" | "octogee_project_publish" | "octogee_project_run_status" | "octogee_project_set_recipe" | "octogee_project_test" | "octogee_status" | "tavily_extract" | "tavily_search" | "workspace_commit")[];
export declare const PROJECT_AGENT_ALLOWED_TOOLS: readonly ["octogee_chat_set_identity", "octogee_connection_request", "octogee_ask_ops", "message", "read", "ls", "write", "edit", "apply_patch", "web_search", "web_fetch", "brave_search", "tavily_search", "tavily_extract", "octogee_project_build", "octogee_project_capability", "octogee_project_test", "octogee_project_preview", "octogee_project_run_status", "octogee_project_commit", "octogee_project_set_recipe", "octogee_board_list", "octogee_board_card_read", "octogee_board_card_create", "octogee_board_card_update", "octogee_board_card_move", "octogee_board_card_comment"];
export declare const PROJECT_AGENT_DENIED_TOOLS: readonly [...("automations" | "brave_search" | "message" | "octogee_ask_ops" | "octogee_board_card_comment" | "octogee_board_card_create" | "octogee_board_card_move" | "octogee_board_card_read" | "octogee_board_card_update" | "octogee_board_list" | "octogee_chat_history" | "octogee_chat_search" | "octogee_chat_set_identity" | "octogee_connection_request" | "octogee_google_calendar_create" | "octogee_google_calendar_create_approved" | "octogee_google_calendar_delete" | "octogee_google_calendar_delete_approved" | "octogee_google_calendar_events" | "octogee_google_calendar_update" | "octogee_google_calendar_update_approved" | "octogee_google_contacts_read" | "octogee_google_docs_read" | "octogee_google_docs_write" | "octogee_google_drive_read" | "octogee_google_gmail_draft_create" | "octogee_google_gmail_draft_create_approved" | "octogee_google_gmail_draft_send" | "octogee_google_gmail_draft_send_approved" | "octogee_google_gmail_get" | "octogee_google_gmail_search" | "octogee_google_gmail_triage" | "octogee_google_gmail_triage_approved" | "octogee_google_sheets_read" | "octogee_google_sheets_write" | "octogee_google_tasks_add" | "octogee_google_tasks_add_approved" | "octogee_google_tasks_list" | "octogee_google_tasks_lists" | "octogee_google_tasks_update" | "octogee_google_tasks_update_approved" | "octogee_obsidian_read" | "octogee_obsidian_write" | "octogee_owner_automations" | "octogee_project_build" | "octogee_project_capability" | "octogee_project_commit" | "octogee_project_create" | "octogee_project_delegate" | "octogee_project_list" | "octogee_project_preview" | "octogee_project_publish" | "octogee_project_run_status" | "octogee_project_set_recipe" | "octogee_project_test" | "octogee_status" | "tavily_extract" | "tavily_search" | "workspace_commit")[], "exec", "process", "subagents", "sessions_spawn", "terminal", "preview_start", "preview_stop", "preview_list", "octogee_publish", "workspace_commit", "octogee_project_create", "octogee_project_delegate", "octogee_project_publish", "octogee_status", "octogee_chat_search", "octogee_chat_history", "octogee_owner_automations", "bundle-mcp", "automations", "skill_workshop", "skill_library", "conversations_list", "conversations_send", "conversations_turn", "browser"];
export declare function platformInvariantTable(context: SystemConfigInvariantContext): readonly PlatformInvariant[];
export declare function reconcileSharedGatewayAgentEntry(agentId: string, entry: Record<string, unknown>): Record<string, unknown>;
export declare function reconcileIsolatedGatewayAgentEntry(agentId: string, entry: Record<string, unknown>): Record<string, unknown>;
export declare function projectIsolatedMattermostRootEndpoint(mattermost: JsonObject): boolean;
export declare class PlatformInvariantPolicyError extends Error {
    readonly paths: string[];
    readonly code = "platform-invariant-violation";
    constructor(paths: string[]);
}
export declare function platformInvariantViolations(config: JsonObject, context: SystemConfigInvariantContext): string[];
export declare function assertPlatformInvariants(config: JsonObject, context: SystemConfigInvariantContext): void;
export declare function reconcilePlatformProjections(config: JsonObject, context: SystemConfigInvariantContext): {
    changedPaths: string[];
};
export declare function reconcilePlatformInvariants(config: JsonObject, context: SystemConfigInvariantContext): {
    changedPaths: string[];
};
export {};
