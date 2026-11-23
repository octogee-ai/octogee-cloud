export const AUTOMATION_AUTHORIZATION_TIMEOUT_MS = 5_000;
export const AUTOMATION_OPENCLAW_CONNECT_TIMEOUT_MS = 10_000;
export const AUTOMATION_OPENCLAW_RPC_TIMEOUT_MS = 10_000;
export const AUTOMATION_READ_CLIENT_TIMEOUT_MS = 15_000;
export const OWNER_AUTOMATION_TOOLS = [
    "octogee_google_calendar_events",
    "octogee_google_gmail_search",
    "octogee_google_gmail_get",
    "octogee_google_tasks_lists",
    "octogee_google_tasks_list",
];
export const OWNER_AUTOMATION_KEY_PREFIX = "octogee:owner-automation:";
export const OWNER_AUTOMATION_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/u;
export function ownerAutomationAccountId(tenant) {
    return `${tenant.slug}-coach`;
}
export function ownerAutomationSessionKey(tenant) {
    return `agent:${tenant.agentId}:mattermost:group:${tenant.coachChannelId}`;
}
export function ownerAutomationKeyPrefix(tenant) {
    return `${OWNER_AUTOMATION_KEY_PREFIX}${tenant.agentId}:`;
}
export function ownerAutomationDefinition(tenant, save) {
    const sessionKey = ownerAutomationSessionKey(tenant);
    const accountId = ownerAutomationAccountId(tenant);
    return {
        name: save.key,
        displayName: save.name,
        declarationKey: `${ownerAutomationKeyPrefix(tenant)}${save.key}`,
        owner: { agentId: tenant.agentId, sessionKey, accountId },
        agentId: tenant.agentId,
        enabled: true,
        schedule: { kind: "cron", expr: save.schedule.expr, tz: save.schedule.tz },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: save.prompt, toolsAllow: [...OWNER_AUTOMATION_TOOLS] },
        delivery: { mode: "announce", channel: "mattermost", accountId, to: `channel:${tenant.coachChannelId}` },
        scheduledToolPolicy: { version: 1, mode: "account", ownerSessionKey: sessionKey, ownerAccountId: accountId },
        toolsAllowProvenance: {
            version: 1,
            source: "authenticated-requester",
            callerOrigin: { kind: "external", channel: "mattermost" },
            channelRequester: { version: 1, channel: "mattermost", accountId, senderId: tenant.ownerMattermostUserId },
        },
    };
}
const AUTOMATION_READ_METHODS = new Set([
    "automations.context",
    "cron.list",
    "cron.get",
    "cron.status",
    "cron.runs",
]);
export function hasAutomationReadClientDeadline(method) {
    return AUTOMATION_READ_METHODS.has(method);
}
