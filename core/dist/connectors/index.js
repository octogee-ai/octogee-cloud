import { githubConnector } from "./github.js";
import { googleConnector } from "./google.js";
import { microsoftConnector } from "./microsoft.js";
import { vercelConnector } from "./vercel.js";
import { cloudflareConnector } from "./cloudflare.js";
import { geminiConnector } from "./gemini.js";
import { netlifyConnector } from "./netlify.js";
import { npmConnector } from "./npm.js";
import { dockerConnector } from "./docker.js";
import { awsConnector } from "./aws.js";
import { gcpConnector } from "./gcp.js";
import { azureConnector } from "./azure.js";
import { obsidianConnector } from "./obsidian.js";
const IMPLEMENTED = {
    github: githubConnector,
    google: googleConnector,
    microsoft: microsoftConnector,
    vercel: vercelConnector,
    cloudflare: cloudflareConnector,
    gemini: geminiConnector,
    netlify: netlifyConnector,
    npm: npmConnector,
    docker: dockerConnector,
    aws: awsConnector,
    gcp: gcpConnector,
    azure: azureConnector,
    obsidian: obsidianConnector,
};
export function getConnector(id) {
    return IMPLEMENTED[id];
}
export function listConnectors() {
    return Object.values(IMPLEMENTED);
}
export function isConnectorTokenBrokerable(id) {
    const def = getConnector(id);
    return def?.meta.consumption === "platform-read" && def.meta.family === "code-hosting";
}
export function isConnectorAgentRuntimeTokenMaterializable(id) {
    const def = getConnector(id);
    if (!def)
        return false;
    if (def.meta.family === "productivity")
        return false;
    if (def.meta.consumption !== "agent-runtime" && def.meta.agentRuntimeMaterializable !== true) {
        return false;
    }
    return def.meta.captureMethods.some((method) => method === "pat" || method === "oauth-web" || method === "device");
}
export function connectorRedirectUri(def) {
    if (!def.oauth) {
        throw new Error(`Connector ${def.meta.id} has no oauth-web config`);
    }
    const override = process.env[def.oauth.redirectUriEnv];
    if (override)
        return override;
    const base = process.env.API_PUBLIC_URL || "https://api.octogee.com";
    return `${base}/api/connect/${def.meta.id}/callback`;
}
