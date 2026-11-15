import { isDeepStrictEqual } from "node:util";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { platformStateStore } from "./platform-state-store.js";
function isMap(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasMillis(value) {
    return value !== null && typeof value === "object" && typeof value.toMillis === "function";
}
export function storedForm(value) {
    if (value === undefined)
        return null;
    if (hasMillis(value))
        return value.toMillis();
    if (Array.isArray(value))
        return value.map(storedForm);
    if (isMap(value))
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, storedForm(item)]));
    return value;
}
function valueAt(document, path) {
    return path.reduce((value, segment) => (isMap(value) ? value[segment] : undefined), document);
}
function withValueAt(document, path, value) {
    const [head, ...rest] = path;
    if (rest.length === 0)
        return { ...document, [head]: value };
    const child = document[head];
    return { ...document, [head]: withValueAt(isMap(child) ? child : {}, rest, value) };
}
function withStoredValue(document, path, stored, current = valueAt(document, path)) {
    const normalized = stored ?? null;
    return isDeepStrictEqual(storedForm(current), normalized) ? document : withValueAt(document, path, normalized);
}
const SLUG_PATH = ["provisioning", "openclaw", "slug"];
const AGENT_IDS_PATH = ["provisioning", "openclaw", "agentIds"];
export function userDataWithUserState(userData, user) {
    const fields = [
        [["workspaceId"], user?.workspaceId],
        [["accountLifecycle"], user?.accountLifecycle],
        [["mattermost", "userId"], user?.mattermostUserId],
        [["provisioning", "openclaw", "gatewayId"], user?.gateway?.gatewayId],
    ];
    const projected = fields.reduce((document, [path, stored]) => withStoredValue(document, path, stored), userData);
    const withAgents = withStoredValue(projected, AGENT_IDS_PATH, user?.agents.agentIds ?? [], valueAt(userData, AGENT_IDS_PATH) ?? []);
    return withStoredValue(withAgents, SLUG_PATH, user?.slug, valueAt(userData, SLUG_PATH) ?? userData.username);
}
export async function accountActiveInStore(uid, store = platformStateStore) {
    const user = await store.users.records.get(uid);
    return accountAllowsInteractiveAccess(user ? { accountLifecycle: user.accountLifecycle ?? undefined } : undefined);
}
