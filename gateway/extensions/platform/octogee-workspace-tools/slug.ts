import { WorkspaceToolError } from "./errors.js";

/**
 * Agent identity → workspace slug. The slug the commit endpoint acts on comes
 * ONLY from the agent's identity (`octogee-<slug>-coach`), never a tool
 * parameter — an agent can only ever commit its own workspace. Same convention
 * the preview + mattermost tools use.
 */
const SLUG_RE = /^octogee-(.+)-coach$/;
// `proj` is a reserved username segment (shared/types/identity), so `-proj-`
// appears in an agent id at most once and only as the project discriminator.
const PROJECT_MARKER = "-proj-";
const PROJECT_ID_RE = /^[a-z0-9]{1,16}$/;

export interface WorkspaceLane {
  /** Workspace username, e.g. "christopher". */
  slug: string;
  /** Project id for project agents — their commits target the project clone ONLY. */
  project: string | null;
}

export function parseAgentIdentity(agentId: string | undefined): WorkspaceLane | null {
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

export interface WorkspaceToolContext {
  agentId?: unknown;
}

export function resolveLane(ctx: WorkspaceToolContext): WorkspaceLane {
  const agentId = ctx?.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) {
    throw new WorkspaceToolError("no-agent", `no agentId in tool context (got ${typeof agentId})`);
  }
  const lane = parseAgentIdentity(agentId);
  if (!lane) {
    throw new WorkspaceToolError(
      "not-coach",
      `agentId ${agentId} is not a managed agent (expected octogee-<slug>[-proj-<pid>]-coach)`,
    );
  }
  return lane;
}

export function resolveSlug(ctx: WorkspaceToolContext): string {
  return resolveLane(ctx).slug;
}
