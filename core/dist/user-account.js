import { userEntitlements } from "@octogee/shared/types/user-entitlements";
function map(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
function millis(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (value instanceof Date)
        return value.getTime();
    const timestamp = value;
    return typeof timestamp?.toMillis === "function" ? timestamp.toMillis() : null;
}
export function userAccountFromData(uid, data) {
    const mattermostUsername = map(data.mattermost).username;
    return {
        uid,
        username: nonEmptyString(data.username),
        email: nonEmptyString(data.email),
        displayName: nonEmptyString(data.displayName),
        lastActive: millis(data.lastActive),
        planInputs: userEntitlements().pickInputs(data),
        usage: map(data.usage),
        mattermostUsername: typeof mattermostUsername === "string" ? mattermostUsername : null,
    };
}
export const noUserAccounts = {
    get: async () => null,
    getMany: async () => new Map(),
    list: async () => new Map(),
};
