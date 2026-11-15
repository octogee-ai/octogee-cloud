import { trustedBrokerBaseUrl } from "../trusted-broker-url.js";
export { trustedBrokerBaseUrl } from "../trusted-broker-url.js";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { isValidUsername } from "@octogee/shared/types/identity";
import { AUTOMATION_AUTHORIZATION_TIMEOUT_MS } from "@octogee/shared/types/automations";
import { internalFetch } from "../internal-fetch.js";
const MATTERMOST_ID = /^[a-z0-9]{26}$/;
function nonBlank(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}
export function automationAuthorizationBrokerBaseUrlFromEnv(env = process.env) {
    const value = nonBlank(env.AUTOMATIONS_BROKER_URL) ?? nonBlank(env.OPENCLAW_RUNTIME_BROKER_URL);
    if (!value) {
        throw new Error("AUTOMATIONS_BROKER_URL or OPENCLAW_RUNTIME_BROKER_URL is required");
    }
    return trustedBrokerBaseUrl(value, env);
}
function authorizedResponse(value, requestedGatewayId) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const body = value;
    if (body.gatewayId !== requestedGatewayId ||
        typeof body.slug !== "string" ||
        !isValidUsername(body.slug) ||
        typeof body.coachChannelId !== "string" ||
        !MATTERMOST_ID.test(body.coachChannelId))
        return null;
    return {
        kind: "authorized",
        slug: body.slug,
        gatewayId: requestedGatewayId,
        coachChannelId: body.coachChannelId,
    };
}
async function outcomeFromBrokerResponse(response, gatewayId, timeout, signal) {
    if (response.status === 401)
        return { kind: "unauthenticated" };
    if (response.status === 403)
        return { kind: "forbidden" };
    if (response.status === 404)
        return { kind: "not_found" };
    if (response.status === 409)
        return { kind: "coach_channel_not_ready" };
    if (!response.ok) {
        throw new Error(`automation authorization broker returned ${response.status}`);
    }
    let body;
    try {
        body = await Promise.race([response.json(), timeout]);
    }
    catch (error) {
        if (signal.aborted)
            throw error;
        throw new Error("automation authorization broker returned malformed authorization response");
    }
    const authorized = authorizedResponse(body, gatewayId);
    if (!authorized) {
        throw new Error("automation authorization broker returned malformed authorization response");
    }
    return authorized;
}
export async function authorizeAutomationOwner(args) {
    if (!isValidGatewayId(args.gatewayId))
        return { kind: "not_found" };
    if (!args.authorization?.startsWith("Bearer "))
        return { kind: "unauthenticated" };
    const timeoutMs = args.timeoutMs ?? AUTOMATION_AUTHORIZATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error("automation authorization broker timeout must be a positive integer");
    }
    const baseUrl = args.baseUrl
        ? trustedBrokerBaseUrl(args.baseUrl, args.env ?? process.env)
        : automationAuthorizationBrokerBaseUrlFromEnv(args.env);
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`automation authorization broker timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });
    try {
        const response = await Promise.race([
            internalFetch(`${baseUrl}/internal/automations/authorize`, {
                method: "POST",
                headers: {
                    authorization: args.authorization,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ gatewayId: args.gatewayId }),
                redirect: "error",
                signal: controller.signal,
            }, {
                tokenPath: args.tokenPath,
                fetchImpl: args.fetchImpl,
                requireProjectedToken: true,
            }),
            timeout,
        ]);
        return await outcomeFromBrokerResponse(response, args.gatewayId, timeout, controller.signal);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
