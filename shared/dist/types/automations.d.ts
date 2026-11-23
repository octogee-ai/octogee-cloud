export declare const AUTOMATION_AUTHORIZATION_TIMEOUT_MS = 5000;
export declare const AUTOMATION_OPENCLAW_CONNECT_TIMEOUT_MS = 10000;
export declare const AUTOMATION_OPENCLAW_RPC_TIMEOUT_MS = 10000;
export declare const AUTOMATION_READ_CLIENT_TIMEOUT_MS = 15000;
export declare const OWNER_AUTOMATION_TOOLS: readonly ["octogee_google_calendar_events", "octogee_google_gmail_search", "octogee_google_gmail_get", "octogee_google_tasks_lists", "octogee_google_tasks_list"];
export declare const OWNER_AUTOMATION_KEY_PREFIX = "octogee:owner-automation:";
export declare const OWNER_AUTOMATION_KEY: RegExp;
export interface OwnerAutomationTenant {
    slug: string;
    agentId: string;
    ownerMattermostUserId: string;
    coachChannelId: string;
}
export interface OwnerAutomationSave {
    key: string;
    name: string;
    schedule: {
        expr: string;
        tz: string;
    };
    prompt: string;
}
export declare function ownerAutomationAccountId(tenant: OwnerAutomationTenant): string;
export declare function ownerAutomationSessionKey(tenant: OwnerAutomationTenant): string;
export declare function ownerAutomationKeyPrefix(tenant: OwnerAutomationTenant): string;
export declare function ownerAutomationDefinition(tenant: OwnerAutomationTenant, save: OwnerAutomationSave): Record<string, unknown>;
export declare function hasAutomationReadClientDeadline(method: string): boolean;
export interface HostedAutomationJobCapabilities {
    history: boolean;
}
export interface HostedAutomationsContext {
    agentId: string;
    canManage: false;
    readOnlyReason: string;
    capabilities: {
        runTranscripts: false;
        scratch: false;
    };
}
