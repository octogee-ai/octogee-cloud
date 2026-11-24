import { randomUUID } from "node:crypto";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { readMattermostSecret } from "@octogee/core/identity/mattermost-secret";
import { logger } from "@octogee/core/http/logging";
import { mmApi } from "./mattermost.js";
import {
  createProjectAgentBot,
  retireProjectAgentBot,
  projectAgentSecretDocId,
  type ProjectAgentDeps,
} from "@octogee/core/mattermost/project-agent";
import type { ProjectAgentStatus } from "@octogee/shared/types/project";
import { isValidProjectId, projectAgentId } from "@octogee/shared/types/identity";
import { addChannelMember, mapMattermostMembershipError } from "./channel-lifecycle.js";

export interface ProjectAgentActor {
  uid: string;
  workspaceId: string | null | undefined;
}

export interface ProjectAgentProvisionResult {
  status: number;
  body: Record<string, unknown>;
}

interface ProjectAgentProvisionContext {
  workspaceId: string;
}

const PROVISION_FAILED = "Project Agent provisioning failed - retry from project settings";

function bad(status: number, error: string): ProjectAgentProvisionResult {
  return { status, body: { error } };
}

function isProvisionResult(
  value: ProjectAgentProvisionContext | ProjectAgentProvisionResult,
): value is ProjectAgentProvisionResult {
  return "body" in value;
}

function errorFrom(result: ProjectAgentProvisionResult): string {
  const error = result.body.error;
  return typeof error === "string" ? error : "Project Agent operation failed";
}

interface ProjectAgentTarget {
  workspaceId: string;
  project: string;
}

async function writeProjectAgentState(
  target: ProjectAgentTarget,
  status: ProjectAgentStatus,
  lastError: string | null = null,
  activationId: string | null = null,
): Promise<void> {
  await platformStateStore.transaction({ label: "project-agent.state" }, async (tx) => {
    const current = await tx.workspaces.projects.get(target.workspaceId, target.project);
    if (!current) throw new Error(`Project ${target.workspaceId}/${target.project} no longer exists`);
    await tx.workspaces.projects.patch(
      target.workspaceId,
      target.project,
      { agent: { ...current.agent, status, activationId, lastError, updatedAt: { serverNow: true } } },
      { revision: current.revision },
    );
  });
}

async function settleProjectAgentError(
  target: ProjectAgentTarget,
  result: ProjectAgentProvisionResult,
): Promise<ProjectAgentProvisionResult> {
  try {
    await writeProjectAgentState(target, "error", errorFrom(result));
  } catch (err) {
    logger.error("[project-agent] failed to record terminal error state:", { err });
  }
  return result;
}

// The gateway-edge mmApi is (path, method, body); core primitives expect
// (method, endpoint, body).
const coreDeps = (): ProjectAgentDeps => ({
  mmApiCall: (method: string, endpoint: string, body?: unknown) => mmApi(endpoint, method, body),
  secrets: platformStateStore.secrets,
  log: (msg: string) => logger.info(msg),
});

interface ProjectChannelBinding {
  channelId: string;
  docPath: string;
}

async function projectChannelBindings(
  workspaceId: string,
  project: string,
): Promise<ProjectChannelBinding[]> {
  const channels = await platformStateStore.workspaces.channels.list({ workspaceSlug: workspaceId, projectSlug: project });
  return channels.flatMap((channel) => channel.mattermostChannelId
    ? [{
        channelId: channel.mattermostChannelId,
        docPath: `workspaces/${workspaceId}/projects/${project}/channels/${channel.channelId}`,
      }]
    : []);
}

function projectAgentDisplayName(agent: Record<string, unknown> | null, project: string): string {
  const identity = agent?.identity as { name?: unknown } | undefined;
  return typeof identity?.name === "string" ? identity.name : project;
}

async function resolveProjectAgentProvisionContext(
  actor: ProjectAgentActor,
  project: string,
): Promise<ProjectAgentProvisionContext | ProjectAgentProvisionResult> {
  if (!isValidProjectId(project)) return bad(400, "Invalid project");
  if (!actor.workspaceId) return bad(422, "Workspace not provisioned");
  const workspaceId = actor.workspaceId;
  const record = await platformStateStore.workspaces.projects.get(workspaceId, project);
  if (!record) return bad(404, "Project not found");
  if (record.ownerUid !== actor.uid) {
    return bad(403, "Only the project owner can manage its agent");
  }
  if (record.commercialLifecycleStatus === "archived") {
    return bad(409, "Project is archived");
  }
  return { workspaceId };
}

// Every active project has its agent. Provisioning writes the server-managed
// state and mints the MM bot here, server-side with admin creds — the
// broker-tier mint locus (zero-cred gateways only ever receive pre-minted
// tokens via the snapshot); the prod-path reconcile converges the gateway
// config afterwards. Re-running is the retry path after a failed mint.
export async function provisionProjectAgent(
  actor: ProjectAgentActor,
  project: string,
): Promise<ProjectAgentProvisionResult> {
  const context = await resolveProjectAgentProvisionContext(actor, project);
  if (isProvisionResult(context)) return context;
  const { workspaceId } = context;
  const target = { workspaceId, project };

  await writeProjectAgentState(target, "provisioning");

  // Roster precedes the mint outcome: the byok broker refuses tokens for
  // unrostered agent ids, and an unresolvable boot-time SecretRef probe-kills
  // the whole gateway pod. Keying on the project keeps the roster a superset of
  // every agent the gateway config can demand, whatever partial-failure state
  // provisioning lands in.
  const agentId = projectAgentId(workspaceId, project);
  try {
    await platformStateStore.users.records.addAgents(actor.uid, [agentId]);
  } catch (err) {
    logger.error(`[project-agent] roster update failed for ${workspaceId}/${project}:`, { err });
    return settleProjectAgentError(target, bad(502, PROVISION_FAILED));
  }

  const teamId = (await platformStateStore.workspaces.records.get(workspaceId))?.mattermostTeamId;
  if (!teamId) {
    logger.error(`[project-agent] no MM teamId for ${workspaceId} — cannot mint ${project}`);
    return settleProjectAgentError(target, bad(502, PROVISION_FAILED));
  }
  try {
    const channelBindings = await projectChannelBindings(workspaceId, project);
    const record = await platformStateStore.workspaces.projects.get(workspaceId, project);
    const minted = await createProjectAgentBot(coreDeps(), {
      uid: actor.uid,
      username: workspaceId,
      project,
      teamId,
      displayName: projectAgentDisplayName(record?.agent ?? null, project),
      projectChannelIds: channelBindings.map((binding) => binding.channelId),
    });
    for (const binding of channelBindings) {
      await addChannelMember(binding.docPath, minted.mmUserId);
    }
    await writeProjectAgentState(target, "provisioning", null, randomUUID());
  } catch (err) {
    logger.error(`[project-agent] mint failed for ${workspaceId}/${project}:`, { err });
    return settleProjectAgentError(
      target,
      mapMattermostMembershipError(err) ?? bad(502, PROVISION_FAILED),
    );
  }
  logger.info(`[project-agent] minted ${workspaceId}/${project}`, { uid: actor.uid });
  return {
    status: 200,
    body: { success: true, status: "provisioning", provisioned: true },
  };
}

// Deletion-time convergence: bot retirement plus roster cleanup. The secret
// doc is config demand for the owner's gateway, so it must be gone before the
// roster id is removed — an unrostered agent that is still in the config
// wedges the whole pod. A throw here therefore leaves the roster entry in
// place (a lingering superset is safe; the caller retries).
export async function retireProjectAgentForDeletion(
  uid: string,
  workspaceId: string,
  project: string,
): Promise<void> {
  const secretId = projectAgentSecretDocId(project);
  const secret = await readMattermostSecret(platformStateStore, uid, secretId);
  const mmUserId = secret?.mattermostUserId;
  if (mmUserId) {
    await retireProjectAgentBot(coreDeps(), { uid, project, mmUserId });
  } else if (secret) {
    logger.warn(
      `[project-agent] dropping ${workspaceId}/${project} secret without an mmUserId — PAT not revoked`,
    );
    await platformStateStore.secrets.delete(uid, secretId);
  }
  const agentId = projectAgentId(workspaceId, project);
  await platformStateStore.transaction({ label: "project-agent.retire-for-deletion" }, async (tx) => {
    await tx.users.records.removeAgents(uid, [agentId]);
    await tx.users.agentStores.delete(uid, agentId);
  });
}
