/**
 * Thin client for the fleet broker's chat endpoints.
 *
 * The extension holds ZERO Mattermost PATs: the agent runtime is
 * injection-reachable, so PAT resolution and every MM read run server-side
 * behind the broker's gateway-identity auth (X-K8s-Sa-Token — the same
 * channel as set-coach-identity). Only a verified workspace-owner agent
 * turn can reach the user PAT there.
 */

import { readFile } from "node:fs/promises";
import { defaultBrokerUrl, DEFAULT_TOKEN_PATH, type FetchLike } from "./identity-client.js";

const SLUG_RE = /^octogee-(.+)-coach$/;
// `proj` is a reserved username segment (shared/types/identity), so `-proj-`
// appears in an agent id at most once and only as the project discriminator.
const PROJECT_MARKER = "-proj-";
const PROJECT_ID_RE = /^[a-z0-9]{1,16}$/;

export interface AgentIdentity {
  /** Workspace username, e.g. "christopher". */
  slug: string;
  /** Project id for project agents (octogee-<slug>-proj-<pid>-coach), else null. */
  project: string | null;
}

export function parseAgentIdentity(agentId: string | undefined): AgentIdentity | null {
  if (!agentId || typeof agentId !== "string") return null;
  const m = agentId.match(SLUG_RE);
  const body = m?.[1];
  if (!body) return null;
  const markerIdx = body.indexOf(PROJECT_MARKER);
  if (markerIdx === -1) return { slug: body, project: null };
  const slug = body.slice(0, markerIdx);
  const project = body.slice(markerIdx + PROJECT_MARKER.length);
  if (!slug || !PROJECT_ID_RE.test(project)) return null;
  return { slug, project };
}

export function extractSlug(agentId: string | undefined): string | null {
  return parseAgentIdentity(agentId)?.slug ?? null;
}

export type ChatToolErrorCode =
  | "no-agent"
  | "not-coach"
  | "auth-unavailable"
  | "control-error"
  | string; // bounded server codes pass through (mm-*, param-*, no-project-pat, …)

export class ChatToolError extends Error {
  constructor(
    public readonly code: ChatToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatToolError";
  }
}

export interface ChatSearchInput {
  agentId: unknown;
  siteUrl: string;
  query: string;
  scope?: string;
  limit?: number;
  currentChannelId?: string;
}

export interface ChatHistoryInput {
  agentId: unknown;
  siteUrl: string;
  channel?: string;
  direction?: string;
  cursor?: string;
  limit?: number;
  fromUsername?: string;
  currentChannelId?: string;
}

export interface ChatClient {
  search(input: ChatSearchInput): Promise<Record<string, unknown>>;
  history(input: ChatHistoryInput): Promise<Record<string, unknown>>;
}

export interface ChatClientOptions {
  brokerUrl?: string;
  fetchImpl?: FetchLike;
  tokenPath?: string;
  tokenProvider?: () => Promise<string | null>;
}

async function readProjectedToken(tokenPath: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function createChatClient(opts: ChatClientOptions = {}): ChatClient {
  const base = stripTrailingSlashes(opts.brokerUrl || defaultBrokerUrl());
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const tokenPath = opts.tokenPath || process.env.OCTOGEE_API_SA_TOKEN_PATH || DEFAULT_TOKEN_PATH;
  const tokenProvider = opts.tokenProvider ?? (() => readProjectedToken(tokenPath));

  async function post(
    path: string,
    agentId: unknown,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (typeof agentId !== "string" || agentId.length === 0) {
      throw new ChatToolError("no-agent", `no agentId in tool context (got ${typeof agentId})`);
    }
    const identity = parseAgentIdentity(agentId);
    if (!identity) {
      throw new ChatToolError(
        "not-coach",
        `agentId ${agentId} is not a managed agent (expected octogee-<slug>[-proj-<pid>]-coach)`,
      );
    }
    if (identity.project !== null) {
      throw new ChatToolError(
        "not-coach",
        `agentId ${agentId} is not the workspace agent`,
      );
    }
    const token = await tokenProvider();
    if (!token) {
      throw new ChatToolError(
        "auth-unavailable",
        `projected gateway service-account token unavailable at ${tokenPath}`,
      );
    }

    let resp: Awaited<ReturnType<FetchLike>>;
    try {
      resp = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-K8s-Sa-Token": token,
        },
        body: JSON.stringify({
          workspaceSlug: identity.slug,
          agentId,
          ...fields,
        }),
      });
    } catch (err) {
      throw new ChatToolError(
        "control-error",
        `fleet broker unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = (await resp.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    if (!resp.ok) {
      const code = typeof parsed?.code === "string" ? parsed.code : "control-error";
      const message =
        typeof parsed?.error === "string" ? parsed.error : `chat broker call failed (${resp.status})`;
      throw new ChatToolError(code, message);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new ChatToolError("control-error", "chat broker returned a non-JSON response");
    }
    return parsed;
  }

  return {
    search: (input) =>
      post("/internal/fleet/agent/chat-search", input.agentId, {
        siteUrl: input.siteUrl,
        query: input.query,
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.currentChannelId !== undefined
          ? { currentChannelId: input.currentChannelId }
          : {}),
      }),
    history: (input) =>
      post("/internal/fleet/agent/chat-history", input.agentId, {
        siteUrl: input.siteUrl,
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
        ...(input.direction !== undefined ? { direction: input.direction } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.fromUsername !== undefined ? { fromUsername: input.fromUsername } : {}),
        ...(input.currentChannelId !== undefined
          ? { currentChannelId: input.currentChannelId }
          : {}),
      }),
  };
}
