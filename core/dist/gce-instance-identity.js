import { OAuth2Client } from "google-auth-library";
export const GOOGLE_TOKEN_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
export function createGoogleIdTokenVerifier() {
    const client = new OAuth2Client();
    return async (idToken, audience) => {
        const ticket = await client.verifyIdToken({ idToken, audience });
        return ticket.getPayload() ?? null;
    };
}
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
export function computeInstanceFromPayload(payload, expected) {
    if (payload.email !== expected.serviceAccountEmail || payload.email_verified !== true)
        return null;
    const google = payload.google;
    const engine = google?.compute_engine;
    if (!engine)
        return null;
    const projectId = nonEmptyString(engine.project_id);
    const zone = nonEmptyString(engine.zone);
    const instanceId = nonEmptyString(engine.instance_id);
    const instanceName = nonEmptyString(engine.instance_name);
    if (!projectId || !zone || !instanceId || !instanceName || projectId !== expected.projectId)
        return null;
    return { projectId, zone, instanceId, instanceName };
}
