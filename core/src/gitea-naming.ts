import { createHash } from "node:crypto";



export const WORKSPACE_REPO = "workspace";
export const SYSTEM_CONFIG_REPO = "system_config";

export function workspaceGiteaOrg(slug: string): string {
  return slug;
}

export function workspaceRepoName(): string {
  return WORKSPACE_REPO;
}

export function systemConfigRepoName(): string {
  return SYSTEM_CONFIG_REPO;
}

export function projectRepoName(projectSlug: string): string {
  return projectSlug;
}

export function giteaUsername(slug: string): string {
  return `ws-${slug}`;
}

export const GATEWAY_KEY_TITLE = "octogee-gateway";

export function gatewayKeyOwnerId(gatewayId: string, podName: string): string {
  return `${gatewayId}/${podName}`;
}

export function gatewayKeyTitle(identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `${GATEWAY_KEY_TITLE}-${digest}`;
}

export function isManagedGatewayKeyTitle(title: string): boolean {
  return title === GATEWAY_KEY_TITLE || title.startsWith(`${GATEWAY_KEY_TITLE}-`);
}

export function publicKeyIdentity(publicKey: string): string {
  return publicKey.trim().split(/\s+/u).slice(0, 2).join(" ");
}
