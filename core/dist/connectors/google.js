import { GOOGLE_CAPABILITY_SCOPES, GOOGLE_OAUTH_REVOCATION_URL, googleAuthRequestScopes, googleCapabilitiesFromScopes, googleEscalationRequestScopes, } from "@octogee/shared/types/connectors";
import { catalogMeta } from "./def.js";
const CAPABILITY_PROBES = {
    calendar: {
        name: "calendar.events",
        url: "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1",
    },
    gmail: {
        name: "gmail.profile",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    },
    drive: {
        name: "drive.about",
        url: "https://www.googleapis.com/drive/v3/about?fields=user",
    },
    tasks: {
        name: "tasks.tasklists",
        url: "https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1",
    },
    contacts: {
        name: "people.connections",
        url: "https://people.googleapis.com/v1/people/me/connections?personFields=names&pageSize=1",
    },
};
async function probeCapability(accessToken, capability) {
    const probe = CAPABILITY_PROBES[capability];
    const resp = await fetch(probe.url, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
        throw new Error(`Google ${probe.name} probe failed: ${resp.status}`);
    }
}
function isGoogleCapability(value) {
    return Object.prototype.hasOwnProperty.call(GOOGLE_CAPABILITY_SCOPES, value);
}
function capabilityListRequestScopes(capabilities) {
    const requested = capabilities.split(",");
    if (!requested.every(isGoogleCapability)) {
        return requested.length === 1 ? googleEscalationRequestScopes(capabilities) : null;
    }
    return [...new Set(requested.flatMap(googleAuthRequestScopes))];
}
export const googleConnector = {
    meta: catalogMeta("google"),
    oauth: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        revocationUrl: GOOGLE_OAUTH_REVOCATION_URL,
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
        redirectUriEnv: "GOOGLE_OAUTH_REDIRECT_URI",
        pkce: true,
        accountHintParam: "login_hint",
        extraAuthParams: {
            access_type: "offline",
            prompt: "consent",
            include_granted_scopes: "true",
        },
    },
    capabilityRequestScopes: capabilityListRequestScopes,
    fetchIdentity: async (accessToken) => {
        const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!resp.ok) {
            throw new Error(`Google identity check failed: ${resp.status}`);
        }
        const user = (await resp.json());
        if (!user.email) {
            throw new Error("Google identity response has no email");
        }
        return { accountLabel: user.email };
    },
    deepProbe: async (accessToken, grantedScopes) => {
        const capabilities = googleCapabilitiesFromScopes(grantedScopes);
        if (capabilities.length === 0) {
            return { probe: "identity", detail: "no capability scopes granted" };
        }
        await Promise.all(capabilities.map((capability) => probeCapability(accessToken, capability)));
        return {
            probe: capabilities.map((capability) => CAPABILITY_PROBES[capability].name).join("+"),
            detail: capabilities.join(", "),
        };
    },
};
