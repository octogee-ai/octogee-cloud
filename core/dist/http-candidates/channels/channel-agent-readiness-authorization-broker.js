import { isValidGatewayId } from "@octogee/shared/types/glm";
import { isValidProjectId, isValidUsername } from "@octogee/shared/types/identity";
import { trustedBrokerBaseUrl } from "../../trusted-broker-url.js";
import { internalFetch } from "../../internal-fetch.js";
export const CHANNEL_READINESS_AUTHORIZATION_PATH = "/internal/channel-agent-readiness/authorize";
const MATTERMOST_ID = /^[a-z0-9]{26}$/u;
function validAgentId(value) {
    return typeof value === "string" && value.length <= 256 && value.trim().length > 0;
}
function parseAuthorization(value, request) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const body = value;
    if (body.gatewayId !== request.gatewayId || body.channelId !== request.channelId ||
        !isValidUsername(body.workspaceId) ||
        (body.project !== null && !isValidProjectId(body.project)) ||
        (body.peerKind !== "channel" && body.peerKind !== "group") ||
        !validAgentId(body.agentId) ||
        typeof body.agentMmUserId !== "string" || !MATTERMOST_ID.test(body.agentMmUserId))
        return null;
    return {
        gatewayId: request.gatewayId, channelId: request.channelId,
        workspaceId: body.workspaceId, project: body.project,
        peerKind: body.peerKind, agentId: body.agentId, agentMmUserId: body.agentMmUserId,
    };
}
export async function authorizeChannelAgentReadiness(args) {
    if (!args.authorization?.startsWith("Bearer "))
        return { kind: "unauthenticated" };
    if (!isValidGatewayId(args.gatewayId) || !MATTERMOST_ID.test(args.channelId))
        return { kind: "not_found" };
    const env = args.env ?? process.env;
    const brokerUrl = args.baseUrl ?? env.OPENCLAW_RUNTIME_BROKER_URL?.trim();
    if (!brokerUrl)
        throw new Error("OPENCLAW_RUNTIME_BROKER_URL is required");
    const response = await internalFetch(`${trustedBrokerBaseUrl(brokerUrl, env)}${CHANNEL_READINESS_AUTHORIZATION_PATH}`, {
        method: "POST", redirect: "error",
        headers: { authorization: args.authorization, "content-type": "application/json" },
        body: JSON.stringify({ gatewayId: args.gatewayId, channelId: args.channelId }),
    }, { tokenPath: args.tokenPath, fetchImpl: args.fetchImpl, requireProjectedToken: true, timeoutMs: 5_000 });
    if (response.status === 401)
        return { kind: "unauthenticated" };
    if (response.status === 403 || response.status === 404)
        return { kind: "not_found" };
    if (!response.ok)
        throw new Error(`channel readiness authorization broker returned ${response.status}`);
    const authorization = parseAuthorization(await response.json(), args);
    if (!authorization)
        throw new Error("channel readiness authorization broker returned malformed metadata");
    return { kind: "authorized", authorization };
}
