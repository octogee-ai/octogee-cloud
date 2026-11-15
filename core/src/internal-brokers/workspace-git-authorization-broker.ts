import { isValidGatewayId } from "@octogee/shared/types/glm";

import { trustedBrokerBaseUrl } from "./automation-authorization-broker.js";
import { internalFetch } from "../internal-fetch.js";

export const WORKSPACE_GIT_AUTHORIZATION_BROKER_PATH = "/internal/workspace-git/authorize";
export const WORKSPACE_GIT_AUTHORIZATION_TIMEOUT_MS = 5_000;

export interface WorkspaceGitLane {
  access: "read" | "write";
  resolveGithubToken: boolean;
}

export interface WorkspaceGitAuthorization {
  gatewayId: string;
  uid: string;
  slug: string;
  projectSlug: string | null;
  githubToken: string | null;
  commitAuthor: { name: string; email: string };
}

export type WorkspaceGitDeniedStatus = 400 | 403 | 404 | 409 | 422;

export type WorkspaceGitAuthorizationOutcome =
  | { kind: "authorized"; authorization: WorkspaceGitAuthorization }
  | { kind: "unauthenticated" }
  | { kind: "denied"; status: WorkspaceGitDeniedStatus; error: string; reason?: string };

export interface WorkspaceGitAuthorizationRequest {
  gatewayId: string;
  authorization: string | undefined;
  slug: string;
  projectSlug: string | null;
  lane: WorkspaceGitLane;
}

const DENIED_STATUSES: ReadonlySet<number> = new Set<WorkspaceGitDeniedStatus>([400, 403, 404, 409, 422]);

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function workspaceGitAuthorizationBrokerBaseUrlFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const value = nonBlank(env.OPENCLAW_RUNTIME_BROKER_URL);
  if (!value) throw new Error("OPENCLAW_RUNTIME_BROKER_URL is required");
  return trustedBrokerBaseUrl(value, env);
}

function authorizationFromResponse(
  value: unknown,
  request: WorkspaceGitAuthorizationRequest,
): WorkspaceGitAuthorization | null {
  const body = record(value);
  const author = record(body?.commitAuthor);
  if (
    !body ||
    body.gatewayId !== request.gatewayId ||
    typeof body.uid !== "string" ||
    body.uid.length === 0 ||
    body.slug !== request.slug ||
    body.projectSlug !== request.projectSlug ||
    (body.githubToken !== null && typeof body.githubToken !== "string") ||
    !author ||
    typeof author.name !== "string" ||
    typeof author.email !== "string"
  ) return null;
  return {
    gatewayId: request.gatewayId,
    uid: body.uid,
    slug: request.slug,
    projectSlug: request.projectSlug,
    githubToken: body.githubToken,
    commitAuthor: { name: author.name, email: author.email },
  };
}

function deniedFromResponse(
  status: number,
  value: unknown,
): Extract<WorkspaceGitAuthorizationOutcome, { kind: "denied" }> | null {
  const body = record(value);
  if (!DENIED_STATUSES.has(status) || !body || typeof body.error !== "string") return null;
  return {
    kind: "denied",
    status: status as WorkspaceGitDeniedStatus,
    error: body.error,
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
  };
}

export async function authorizeWorkspaceGit(
  args: WorkspaceGitAuthorizationRequest & {
    baseUrl?: string;
    env?: Record<string, string | undefined>;
    tokenPath?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<WorkspaceGitAuthorizationOutcome> {
  if (!args.authorization?.startsWith("Bearer ")) return { kind: "unauthenticated" };
  if (!isValidGatewayId(args.gatewayId)) return { kind: "denied", status: 404, error: "not_found" };
  const baseUrl = args.baseUrl
    ? trustedBrokerBaseUrl(args.baseUrl, args.env ?? process.env)
    : workspaceGitAuthorizationBrokerBaseUrlFromEnv(args.env);
  const response = await internalFetch(
    `${baseUrl}${WORKSPACE_GIT_AUTHORIZATION_BROKER_PATH}`,
    {
      method: "POST",
      headers: { authorization: args.authorization, "content-type": "application/json" },
      body: JSON.stringify({
        gatewayId: args.gatewayId,
        slug: args.slug,
        projectSlug: args.projectSlug,
        access: args.lane.access,
        resolveGithubToken: args.lane.resolveGithubToken,
      }),
      redirect: "error",
    },
    {
      tokenPath: args.tokenPath,
      fetchImpl: args.fetchImpl,
      requireProjectedToken: true,
      timeoutMs: WORKSPACE_GIT_AUTHORIZATION_TIMEOUT_MS,
    },
  );
  if (response.status === 401) return { kind: "unauthenticated" };
  if (!response.ok && !DENIED_STATUSES.has(response.status)) {
    throw new Error(`workspace git authorization broker returned ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error("workspace git authorization broker returned malformed JSON", { cause: error });
  }
  if (!response.ok) {
    const denied = deniedFromResponse(response.status, body);
    if (!denied) throw new Error("workspace git authorization broker returned a malformed refusal");
    return denied;
  }
  const authorization = authorizationFromResponse(body, args);
  if (!authorization) throw new Error("workspace git authorization broker returned a malformed grant");
  return { kind: "authorized", authorization };
}
