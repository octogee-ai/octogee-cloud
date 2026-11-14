import type { OpaqueMap, Stored, WorkspaceChannel, WorkspaceChannelScope } from "@octogee/core/platform-state";
import { platformStateStore } from "./platform-state.js";
import { projectPresentation } from "./project-presentation.js";
import { readMattermostSecret } from "./mattermost-secret.js";
import { logger } from "../middleware/logging.js";
import { mmApi } from "./mattermost.js";
import { getWorkspaceMmContext } from "./mattermost-context.js";
import { enrollWorkspaceChannelMembers } from "./workspace-channel-membership.js";
import {
  workspaceCustomChannelName,
  projectChannelName,
  isValidCustomChannelName,
  isValidProjectId,
  RESERVED_USERNAMES,
  CUSTOM_CHANNEL_MIN_LENGTH,
  CUSTOM_CHANNEL_MAX_LENGTH,
} from "@octogee/shared/types/identity";
import { projectAgentConfigured } from "@octogee/shared/types/project";
import { projectAgentSecretDocId } from "@octogee/core/mattermost/project-agent";

const MM_DISPLAY_NAME_MAX_LENGTH = 64;
const MM_PURPOSE_MAX_LENGTH = 250;
const MM_MEMBER_PAGE_SIZE = 200;

export interface SessionChannelActor {
  uid: string;
  userData: FirebaseFirestore.DocumentData | undefined;
  workspaceId: string | null | undefined;
}

export interface SessionChannelCreateInput {
  name?: unknown;
  displayName?: unknown;
  purpose?: unknown;
}

export interface SessionChannelPatchInput {
  displayName?: unknown;
  purpose?: unknown;
}

export interface SessionChannelResult {
  status: number;
  body: Record<string, unknown>;
}

export function sessionChannelNameAvailability(
  name: string,
): { ok: true } | { ok: false; reason: string } {
  if (!isValidCustomChannelName(name)) {
    return {
      ok: false,
      reason: `Channel name must be ${CUSTOM_CHANNEL_MIN_LENGTH}-${CUSTOM_CHANNEL_MAX_LENGTH} chars, lowercase letters and digits only.`,
    };
  }
  if (RESERVED_USERNAMES.has(name)) {
    return { ok: false, reason: "That channel name is reserved." };
  }
  return { ok: true };
}

function bad(status: number, error: string): SessionChannelResult {
  return { status, body: { error } };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// A session channel lives in one of two naming lanes: the workspace lane
// ({slug}-{name}) or a project lane ({slug}-proj-{pid}-{name}). project=null
// selects the workspace lane throughout.
function channelDocPath(workspaceId: string, project: string | null, name: string): string {
  return project
    ? `workspaces/${workspaceId}/projects/${project}/channels/${name}`
    : `workspaces/${workspaceId}/channels/${name}`;
}

function laneChannelScope(workspaceId: string, project: string | null): WorkspaceChannelScope {
  return { workspaceSlug: workspaceId, projectSlug: project };
}

function laneChannelName(workspaceId: string, project: string | null, name: string): string {
  return project
    ? projectChannelName(workspaceId, project, name)
    : workspaceCustomChannelName(workspaceId, name);
}

function laneScope(workspaceId: string, project: string | null, name: string): string {
  return project ? `${workspaceId}/${project}/${name}` : `${workspaceId}/${name}`;
}

export async function createSessionChannel(
  actor: SessionChannelActor,
  input: SessionChannelCreateInput,
): Promise<SessionChannelResult> {
  return createSessionChannelImpl(actor, input, null);
}

export async function createProjectSessionChannel(
  actor: SessionChannelActor,
  project: string,
  input: SessionChannelCreateInput,
): Promise<SessionChannelResult> {
  if (!isValidProjectId(project)) return bad(400, "Invalid project");
  if (!actor.workspaceId) return bad(422, "Workspace not provisioned");
  const record = await platformStateStore.workspaces.projects.get(actor.workspaceId, project);
  if (!record) return bad(404, "Project not found");
  const projectAgentMember = await projectAgentChannelMember(actor.uid, project, record.agent);
  if (!projectAgentMember.ok) return bad(502, projectAgentMember.error);
  return createSessionChannelImpl(actor, input, project, projectAgentMember.mmUserId);
}

async function projectAgentChannelMember(
  uid: string,
  project: string,
  agent: OpaqueMap | null,
): Promise<{ ok: true; mmUserId: string | null } | { ok: false; error: string }> {
  if (!projectAgentConfigured(agent)) return { ok: true, mmUserId: null };
  const secret = await readMattermostSecret(platformStateStore, uid, projectAgentSecretDocId(project));
  const mmUserId = secret?.mattermostUserId;
  if (mmUserId) return { ok: true, mmUserId };
  return { ok: false, error: "Channel creation failed - project agent is not ready" };
}

async function createSessionChannelImpl(
  actor: SessionChannelActor,
  input: SessionChannelCreateInput,
  project: string | null,
  projectAgentMmUserId: string | null = null,
): Promise<SessionChannelResult> {
  const normalized = normalizeSessionChannelCreateInput(input);
  const invalidInput = invalidSessionChannelCreateInput(normalized);
  if (invalidInput) return invalidInput;
  if (!actor.workspaceId) return bad(422, "Workspace not provisioned");
  const workspaceId = actor.workspaceId;
  const scope = laneScope(workspaceId, project, normalized.name);

  const channelScope = laneChannelScope(workspaceId, project);
  const existingResult = await existingSessionChannelResult(channelScope, normalized, actor.uid);
  if (existingResult) return completeExistingSessionChannel(project, workspaceId, normalized.name, existingResult);

  const ctx = await getWorkspaceMmContext(actor.uid, workspaceId, actor.userData);
  if (!ctx?.teamId) {
    logger.error(`[channels] Create failed - no MM teamId for workspace ${workspaceId}`);
    return bad(502, "Channel creation failed - workspace chat is not ready");
  }

  const channelName = laneChannelName(workspaceId, project, normalized.name);
  const agentMember = project
    ? { id: projectAgentMmUserId, label: "project agent" }
    : { id: ctx.coachUserId, label: "coach" };
  const memberAdds = [
    { id: ctx.userId, label: "owner" },
    ...(agentMember.id ? [agentMember] : []),
  ];
  const channelId = await createPrimarySessionChannel(
    ctx.teamId,
    channelName,
    normalized,
    scope,
    memberAdds.map((member) => member.id),
  );
  if (!channelId) return bad(502, "Channel creation failed - could not create chat channel");

  const memberFailure = await addChannelMembers(channelId, memberAdds);
  if (memberFailure) {
    logger.error(`[channels] Channel membership failed for ${scope}: ${memberFailure}`);
    return bad(502, "Channel creation failed - could not add channel members");
  }

  await platformStateStore.workspaces.channels.put({
    scope: channelScope,
    channelId: normalized.name,
    kind: "session",
    mattermostChannelId: channelId,
    archivedAt: null,
    createdBy: actor.uid,
    createdAt: { serverNow: true },
  });
  await writeSessionChannelPresentation(channelScope, normalized);
  if (!project) {
    const failure = await enrollWorkspaceGroup(workspaceId, normalized.name);
    if (failure) return failure;
  }
  logger.info(`[channels] Created session channel ${scope}`, { uid: actor.uid });

  return { status: 200, body: { success: true, channelId, name: normalized.name } };
}

async function completeExistingSessionChannel(
  project: string | null,
  workspaceId: string,
  name: string,
  result: SessionChannelResult,
): Promise<SessionChannelResult> {
  if (project || result.status !== 200) return result;
  return await enrollWorkspaceGroup(workspaceId, name) ?? result;
}

async function enrollWorkspaceGroup(workspaceId: string, name: string): Promise<SessionChannelResult | null> {
  try {
    await enrollWorkspaceChannelMembers(workspaceId, name);
    return null;
  } catch (error) {
    logger.error(`[channels] Workspace group enrollment failed for ${workspaceId}/${name}:`, { err: error });
    return bad(502, "Channel creation failed - could not add workspace members");
  }
}

interface NormalizedSessionChannelCreateInput {
  name: string;
  displayName: string;
  purpose: string;
}

function normalizeSessionChannelCreateInput(
  input: SessionChannelCreateInput,
): NormalizedSessionChannelCreateInput {
  return {
    name: stringValue(input.name).trim(),
    displayName: stringValue(input.displayName).trim(),
    purpose: stringValue(input.purpose).trim(),
  };
}

function invalidSessionChannelCreateInput(
  input: NormalizedSessionChannelCreateInput,
): SessionChannelResult | null {
  const availability = sessionChannelNameAvailability(input.name);
  if (!availability.ok) return bad(400, availability.reason);
  if (input.displayName.length === 0) return bad(400, "Channel display name is required");
  if (input.displayName.length > MM_DISPLAY_NAME_MAX_LENGTH) {
    return bad(400, `Channel display name must be at most ${MM_DISPLAY_NAME_MAX_LENGTH} characters`);
  }
  if (input.purpose.length > MM_PURPOSE_MAX_LENGTH) {
    return bad(400, `Channel purpose must be at most ${MM_PURPOSE_MAX_LENGTH} characters`);
  }
  return null;
}

async function writeSessionChannelPresentation(
  scope: WorkspaceChannelScope,
  request: NormalizedSessionChannelCreateInput,
): Promise<void> {
  await projectPresentation().writeChannel(scope, request.name, {
    name: request.name,
    purpose: request.purpose,
    createdDisplayName: request.displayName,
  });
}

async function existingSessionChannelResult(
  scope: WorkspaceChannelScope,
  request: NormalizedSessionChannelCreateInput,
  uid: string,
): Promise<SessionChannelResult | null> {
  const existing = await platformStateStore.workspaces.channels.get(scope, request.name);
  if (!existing) return null;
  if (existing.archivedAt !== null) {
    return bad(409, "A session with this name was archived; channel names cannot be reused");
  }
  const channelId = existing.mattermostChannelId;
  if (!channelId) {
    return bad(409, "A channel with this name already exists in your workspace");
  }
  const presentation = await projectPresentation().readChannel(scope, request.name);
  if (presentation?.name === undefined && presentation?.createdDisplayName === undefined && existing.createdBy === uid) {
    await writeSessionChannelPresentation(scope, request);
    return { status: 200, body: { success: true, channelId, name: request.name } };
  }
  if (presentation?.createdDisplayName !== request.displayName) {
    return bad(
      409,
      `A channel already uses the name "${request.name}". Choose a name that differs within its first ${CUSTOM_CHANNEL_MAX_LENGTH} letters and numbers.`,
    );
  }
  return { status: 200, body: { success: true, channelId, name: request.name } };
}

async function createPrimarySessionChannel(
  teamId: string,
  channelName: string,
  input: NormalizedSessionChannelCreateInput,
  scope: string,
  allowedMemberIds: Array<string | null>,
): Promise<string | null> {
  try {
    return await createOrAdoptMmChannel(
      teamId,
      channelName,
      input.displayName,
      input.purpose,
      allowedMemberIds,
    );
  } catch (err) {
    logger.error(`[channels] MM channel creation failed for ${scope}:`, { err });
    return null;
  }
}

async function createOrAdoptMmChannel(
  teamId: string,
  channelName: string,
  displayName: string,
  purpose: string,
  allowedMemberIds: Array<string | null>,
): Promise<string> {
  try {
    const ch = (await mmApi("/channels", "POST", {
      team_id: teamId,
      name: channelName,
      display_name: displayName,
      type: "P",
      purpose,
    })) as { id?: string };
    if (!ch?.id) throw new Error("MM returned no channel id");
    return ch.id;
  } catch (err) {
    if (!isMmNameConflict(err)) throw err;
    // Name already taken in MM but no Firestore doc — a prior create died between
    // the MM write and the doc write. Adopt the live channel and patch it to the
    // requested display/purpose so retry converges on what the user asked for;
    // archived channels are excluded from the by-name lookup, so their names
    // stay burned.
    const ch = (await mmApi(`/teams/${teamId}/channels/name/${channelName}`)) as { id?: string };
    if (!ch?.id) throw new Error(`MM channel name ${channelName} taken but not adoptable`);
    await removeUnexpectedChannelMembers(ch.id, allowedMemberIds);
    await mmApi(`/channels/${ch.id}/patch`, "PUT", { display_name: displayName, purpose });
    return ch.id;
  }
}

async function removeUnexpectedChannelMembers(
  channelId: string,
  allowedMemberIds: Array<string | null>,
): Promise<void> {
  const allowed = new Set(allowedMemberIds.filter((memberId): memberId is string => memberId !== null));
  const members = await listChannelMemberIds(channelId);
  for (const memberId of members) {
    if (!allowed.has(memberId)) {
      await mmApi(`/channels/${channelId}/members/${memberId}`, "DELETE");
    }
  }
  const verifiedMembers = await listChannelMemberIds(channelId);
  if (verifiedMembers.some((memberId) => !allowed.has(memberId))) {
    throw new Error(`MM channel ${channelId} membership changed during adoption`);
  }
}

async function listChannelMemberIds(channelId: string): Promise<string[]> {
  const memberIds: string[] = [];
  let page = 0;
  while (true) {
    const members = (await mmApi(
      `/channels/${channelId}/members?page=${page}&per_page=${MM_MEMBER_PAGE_SIZE}`,
    )) as Array<{ user_id?: unknown }>;
    if (!Array.isArray(members)) {
      throw new Error(`MM returned invalid members for channel ${channelId}`);
    }
    for (const member of members) {
      if (typeof member.user_id !== "string") {
        throw new Error(`MM returned member without user id for channel ${channelId}`);
      }
      memberIds.push(member.user_id);
    }
    if (members.length < MM_MEMBER_PAGE_SIZE) {
      return memberIds;
    }
    page += 1;
  }
}

function isMmNameConflict(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e.status === 400 && typeof e.message === "string" && e.message.includes("save_channel.exists");
}

async function addChannelMembers(
  channelId: string,
  members: Array<{ id: string | null; label: string }>,
): Promise<string | null> {
  for (const member of members) {
    if (!member.id) return `${member.label} has no Mattermost userId - provisioning incomplete`;
    try {
      await mmApi(`/channels/${channelId}/members`, "POST", { user_id: member.id });
    } catch (err) {
      return `Add ${member.label} ${member.id} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return null;
}

interface ResolvedSessionChannel {
  docPath: string;
  channel: Stored<WorkspaceChannel>;
  channelId: string;
}

async function readSessionChannel(
  workspaceId: string,
  project: string | null,
  name: string,
): Promise<ResolvedSessionChannel | null> {
  // Same gate as create: reserved names (general/coach/admin/...) can never
  // resolve as session channels, even from a forged kind:'session' doc whose
  // live MM name WOULD pass the binding check (e.g. a rewritten
  // projects/{pid}/channels/general pointing at the real general channel).
  if (!sessionChannelNameAvailability(name).ok) return null;
  const channel = await platformStateStore.workspaces.channels.get(laneChannelScope(workspaceId, project), name);
  if (!channel || channel.kind !== "session") return null;
  const channelId = channel.mattermostChannelId;
  if (!channelId) return null;
  return { docPath: channelDocPath(workspaceId, project, name), channel, channelId };
}

// Defense-in-depth for the admin-token MM mutations: channel docs are
// server-managed (rules deny client writes), but this boundary must hold even
// if the rules drift or a doc is corrupted — never act on a channelId unless
// the live MM channel name proves it sits in the caller's own naming lane.
async function verifyChannelBinding(
  workspaceId: string,
  project: string | null,
  name: string,
  channelId: string,
): Promise<SessionChannelResult | null> {
  const scope = laneScope(workspaceId, project, name);
  let mmName: string;
  try {
    const ch = (await mmApi(`/channels/${channelId}`)) as { name?: unknown };
    mmName = typeof ch?.name === "string" ? ch.name : "";
  } catch (err) {
    logger.error(`[channels] MM channel lookup failed for ${scope}:`, { err });
    return bad(502, "Channel lookup failed");
  }

  if (mmName !== laneChannelName(workspaceId, project, name)) {
    logger.error(
      `[channels] MM channel binding mismatch for ${scope} - doc points at ${channelId} (${mmName})`,
    );
    return bad(404, "Session channel not found");
  }

  return null;
}

export async function renameSessionChannel(
  actor: SessionChannelActor,
  name: string,
  patch: SessionChannelPatchInput,
): Promise<SessionChannelResult> {
  return renameSessionChannelImpl(actor, null, name, patch);
}

export async function renameProjectSessionChannel(
  actor: SessionChannelActor,
  project: string,
  name: string,
  patch: SessionChannelPatchInput,
): Promise<SessionChannelResult> {
  if (!isValidProjectId(project)) return bad(400, "Invalid project");
  return renameSessionChannelImpl(actor, project, name, patch);
}

async function renameSessionChannelImpl(
  actor: SessionChannelActor,
  project: string | null,
  name: string,
  patch: SessionChannelPatchInput,
): Promise<SessionChannelResult> {
  if (!actor.workspaceId) return bad(422, "Workspace not provisioned");
  const scope = laneScope(actor.workspaceId, project, name);

  if (patch.purpose !== undefined) {
    return bad(400, "Task purpose cannot be changed after creation");
  }
  const displayName = stringValue(patch.displayName).trim();
  const hasDisplayName = patch.displayName !== undefined && displayName.length > 0;
  if (!hasDisplayName) return bad(400, "Nothing to update");
  if (displayName.length > MM_DISPLAY_NAME_MAX_LENGTH) {
    return bad(400, `Channel display name must be at most ${MM_DISPLAY_NAME_MAX_LENGTH} characters`);
  }

  const found = await readSessionChannel(actor.workspaceId, project, name);
  if (!found) return bad(404, "Session channel not found");
  const bindingFailure = await verifyChannelBinding(actor.workspaceId, project, name, found.channelId);
  if (bindingFailure) return bindingFailure;

  try {
    await mmApi(`/channels/${found.channelId}/patch`, "PUT", {
      display_name: displayName,
    });
  } catch (err) {
    logger.error(`[channels] MM channel patch failed for ${scope}:`, { err });
    return bad(502, "Channel update failed");
  }

  return { status: 200, body: { success: true } };
}

export async function archiveSessionChannel(
  actor: SessionChannelActor,
  name: string,
): Promise<SessionChannelResult> {
  return archiveSessionChannelImpl(actor, null, name);
}

export async function archiveProjectSessionChannel(
  actor: SessionChannelActor,
  project: string,
  name: string,
): Promise<SessionChannelResult> {
  if (!isValidProjectId(project)) return bad(400, "Invalid project");
  return archiveSessionChannelImpl(actor, project, name);
}

async function archiveSessionChannelImpl(
  actor: SessionChannelActor,
  project: string | null,
  name: string,
): Promise<SessionChannelResult> {
  if (!actor.workspaceId) return bad(422, "Workspace not provisioned");
  const scope = laneScope(actor.workspaceId, project, name);

  const found = await readSessionChannel(actor.workspaceId, project, name);
  if (!found) return bad(404, "Session channel not found");
  if (found.channel.archivedAt !== null) return { status: 200, body: { success: true } };
  const bindingFailure = await verifyChannelBinding(actor.workspaceId, project, name, found.channelId);
  if (bindingFailure) return bindingFailure;

  try {
    const {
      setStoredChannelArchived,
    } = await import("./channel-lifecycle.js");
    await setStoredChannelArchived(found.docPath, true);
  } catch (err) {
    logger.error(`[channels] Channel archive failed for ${scope}:`, { err });
    return bad(502, "Channel archive failed");
  }

  await platformStateStore.workspaces.channels.patch(
    laneChannelScope(actor.workspaceId, project),
    name,
    { archivedAt: { serverNow: true } },
  );
  logger.info(`[channels] Archived session channel ${scope}`, { uid: actor.uid });

  return { status: 200, body: { success: true } };
}
