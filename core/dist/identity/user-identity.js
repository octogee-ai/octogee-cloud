import { USER_IDENTITY_ROUTE, parseUserIdentity, } from "@octogee/shared/types/builder-identity";
import { gatewayCredentialHeaders, internalFetch } from "../internal-fetch.js";
export const USER_IDENTITY_POLL_MS = 1_000;
export const USER_IDENTITY_RETRY_MS = 5_000;
function defaultSchedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    if (typeof timer.unref === "function")
        timer.unref();
    return () => clearTimeout(timer);
}
function settled(identity) {
    return identity.state === "claimed" || (identity.state === "unavailable" && identity.reason === "retired");
}
export function createUserIdentityStore(input) {
    const schedule = input.schedule ?? defaultSchedule;
    let identity = null;
    return {
        current: () => identity,
        start() {
            let stopped = false;
            let cancel = null;
            const poll = async () => {
                let delay = USER_IDENTITY_POLL_MS;
                try {
                    const next = await input.read();
                    if (stopped)
                        return;
                    identity = next;
                    if (settled(next))
                        return;
                }
                catch (error) {
                    if (stopped)
                        return;
                    input.log(`[builder-identity] broker read failed: ${error instanceof Error ? error.message : String(error)}`);
                    delay = USER_IDENTITY_RETRY_MS;
                }
                cancel = schedule(() => { void poll(); }, delay);
            };
            void poll();
            return () => {
                stopped = true;
                cancel?.();
            };
        },
    };
}
export function brokerUserIdentityReader(env = process.env) {
    const gatewayId = env.GATEWAY_ID?.trim();
    const base = (env.FLEET_BROKER_URL || env.OCTOGEE_API_URL)?.replace(/\/$/u, "");
    if (!gatewayId || !base)
        throw new Error("User identity requires GATEWAY_ID and FLEET_BROKER_URL");
    return async () => {
        const response = await internalFetch(`${base}${USER_IDENTITY_ROUTE}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...await gatewayCredentialHeaders() },
            body: JSON.stringify({ gatewayId }),
        });
        if (!response.ok)
            throw new Error(`fleet broker user identity returned ${response.status}`);
        const body = await response.json();
        const identity = parseUserIdentity(body.identity, gatewayId);
        if (!identity)
            throw new Error("fleet broker returned a malformed user identity");
        return identity;
    };
}
let activeStore = null;
export function installUserIdentityStore(store) {
    activeStore = store;
}
export function builderIdentity() {
    return activeStore?.current() ?? null;
}
export function claimedUserIdentity() {
    const identity = builderIdentity();
    return identity?.state === "claimed" ? identity : null;
}
