import { createHash } from "node:crypto";
export const WORKSPACE_REPO = "workspace";
export const SYSTEM_CONFIG_REPO = "system_config";
export function workspaceGiteaOrg(slug) {
    return slug;
}
export function workspaceRepoName() {
    return WORKSPACE_REPO;
}
export function systemConfigRepoName() {
    return SYSTEM_CONFIG_REPO;
}
export function projectRepoName(projectSlug) {
    return projectSlug;
}
export function giteaUsername(slug) {
    return `ws-${slug}`;
}
export const GATEWAY_KEY_TITLE = "octogee-gateway";
export function gatewayKeyOwnerId(gatewayId, podName) {
    return `${gatewayId}/${podName}`;
}
export function gatewayKeyTitle(identity) {
    const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
    return `${GATEWAY_KEY_TITLE}-${digest}`;
}
export function isManagedGatewayKeyTitle(title) {
    return title === GATEWAY_KEY_TITLE || title.startsWith(`${GATEWAY_KEY_TITLE}-`);
}
export function publicKeyIdentity(publicKey) {
    return publicKey.trim().split(/\s+/u).slice(0, 2).join(" ");
}
