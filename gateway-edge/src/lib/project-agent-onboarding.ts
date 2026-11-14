import { logger } from "../middleware/logging.js";
import {
  claimProjectDelivery,
  beginDeliveryPost,
  finishProjectDelivery,
  matchingDeliveryPost,
  openDeliveryIntent,
  pendingProjectDelivery,
  type DeliveryClaim,
  type OnboardingProject,
} from "./project-agent-delivery.js";
import {
  projectAgentDeliveryIntents,
  type DeliveryIntent,
  type DeliveryKind,
  type ProjectDeliveryTarget,
  type QueuedProjectHandoff,
} from "./project-agent-delivery-intents.js";
import { platformStateStore } from "./platform-state.js";
import { readMattermostSecret } from "./mattermost-secret.js";
import { mmApi } from "./mattermost.js";
import { projectAgentMmUsername } from "@octogee/shared/types/identity";
import { projectAgentConfigured } from "@octogee/shared/types/project";
import { projectAgentSecretDocId } from "@octogee/core/mattermost/project-agent";

export interface ProjectHandoff {
  name: string;
  emoji: string;
  persona: string;
  message: string;
}

export function parseProjectHandoff(value: unknown): ProjectHandoff | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const limits = { name: 80, emoji: 32, persona: 2000, message: 12000 };
  const result: Record<string, string> = {};
  for (const [key, max] of Object.entries(limits)) {
    const text = input[key];
    if (typeof text !== "string" || !text.trim() || text.trim().length > max) return null;
    result[key] = text.trim();
  }
  return result as unknown as ProjectHandoff;
}

type HandoffAgent = Record<string, unknown> & {
  kickoff?: { status?: string };
  handoff?: { status?: string; generation?: number };
  requestedName?: string;
  deliveryLeaseUntil?: number;
};

function initialPostStarted(state: { status?: string } | undefined, delivery: DeliveryIntent | null): boolean {
  return state?.status === "sent" || delivery?.postAttempted === true;
}

function handoffAlreadyQueued(existing: QueuedProjectHandoff | null, agent: HandoffAgent, requested: ProjectHandoff): boolean {
  return existing?.generation === agent.handoff?.generation
    && existing?.message === requested.message
    && (["name", "emoji", "persona"] as const).every(key => existing?.identity?.[key] === requested[key]);
}

export async function queueProjectHandoff(uid: string, workspaceId: string, projectSlug: string, handoff: ProjectHandoff): Promise<void> {
  const intents = projectAgentDeliveryIntents();
  if (!intents.recordsIntents) throw new Error("Project handoffs need a delivery intent store, and none is installed");
  const target = { workspaceId, projectSlug };
  const [existing, handoffDelivery, kickoffDelivery] = await Promise.all([
    intents.readHandoff(target),
    intents.readIntent(target, "handoff"),
    intents.readIntent(target, "kickoff"),
  ]);
  const queued = await platformStateStore.transaction({ label: "project-agent-onboarding.queue-handoff" }, async (tx) => {
    const { projects } = tx.workspaces;
    const project = await projects.get(workspaceId, projectSlug);
    if (project?.ownerUid !== uid || project.provisioningState !== "active" || !projectAgentConfigured(project.agent)) {
      throw new Error("An active project with its own agent is required");
    }
    const agent = project.agent as HandoffAgent;
    if (initialPostStarted(agent.kickoff, kickoffDelivery)) {
      throw new Error("This project already has its initial kickoff; continue in its chat");
    }
    const next = { name: agent.requestedName || handoff.name, emoji: handoff.emoji, persona: handoff.persona };
    if (handoffAlreadyQueued(existing, agent, { ...next, message: handoff.message })) return null;
    if (initialPostStarted(agent.handoff, handoffDelivery)) {
      throw new Error("This project already has its initial handoff; continue in its chat");
    }
    if ((agent.deliveryLeaseUntil ?? 0) > Date.now()) throw new Error("Project agent delivery is in progress");
    const remaining = Object.fromEntries(Object.entries(agent).filter(([key]) => key !== "kickoff"));
    const generation = (agent.handoff?.generation ?? 0) + 1;
    await projects.patch(
      workspaceId,
      projectSlug,
      { agent: { ...remaining, identity: next, handoff: { status: "pending", generation }, updatedAt: { serverNow: true } } },
      { revision: project.revision },
    );
    return { identity: next, generation };
  });
  if (queued) await intents.writeHandoff(target, { message: handoff.message, ...queued });
}

function deliveryMessage(project: OnboardingProject, kind: DeliveryKind, workspaceId: string, projectSlug: string): string {
  const { agent } = project;
  const privateWorkspace = project.repoSource?.provider === "github";
  if (kind === "handoff") {
    if (!agent.identity || !project.handoffMessage) throw new Error("Project handoff identity is missing");
    const workspace = privateWorkspace
      ? "in your private agent workspace. Keep those agent files there. Use the GitHub checkout, when available, for source and repository-owned instructions."
      : "in your project checkout. Preserve existing project instructions and decisions, read runbook/ and DECISIONS.md when present, and commit these files together with your work using octogee_project_commit.";
    return `@${projectAgentMmUsername(workspaceId, projectSlug)} ${project.handoffMessage}\n\nYou are ${agent.identity.name} ${agent.identity.emoji}. ${agent.identity.persona}\nBefore starting, save this handoff in BRIEF.md, update IDENTITY.md and SOUL.md with your assigned identity, and record relevant user context in USER.md ${workspace} Create a fitting avatar and set your chat identity with octogee_chat_set_identity.`;
  }
  if (!project.name) throw new Error("Project kickoff needs the project name");
  const identityHint = agent.requestedName ? `Your name is ${agent.requestedName}.` : "Choose your own fitting name.";
  const task = project.tagline?.trim()
    ? `The user's starting idea: ${project.tagline}\nIntroduce yourself and start with this idea.`
    : "Greet the user, ask what they would like to create, and wait for their direction.";
  return `@${projectAgentMmUsername(workspaceId, projectSlug)} You are the new agent for “${project.name}”. ${identityHint} Choose a fitting personality, emoji, and avatar, and set your chat identity with octogee_chat_set_identity. Keep your chosen identity files in your ${privateWorkspace ? "private agent workspace" : "project repo"}.\n${task}`;
}

async function prepareHandoff({ uid, projectSlug, project }: { uid: string; projectSlug: string; project: OnboardingProject }): Promise<void> {
  if (!project.agent.identity || !project.handoffMessage) throw new Error("Project handoff identity is missing");
  const secret = await readMattermostSecret(platformStateStore, uid, projectAgentSecretDocId(projectSlug));
  if (!secret?.mattermostUserId) throw new Error("Project agent has no chat identity");
  await mmApi(`/bots/${secret.mattermostUserId}`, "PUT", { display_name: project.agent.identity.name });
}

async function ensureDefaultAgentMembership(channelId: string, userDefaultAgentId: string): Promise<void> {
  try {
    await mmApi(`/channels/${channelId}/members/${userDefaultAgentId}`, "GET");
    return;
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    await mmApi(`/channels/${channelId}/members`, "POST", { user_id: userDefaultAgentId });
  }
}

async function readHandoffMessage(target: ProjectDeliveryTarget, generation: number | undefined): Promise<string | undefined> {
  const stored = await projectAgentDeliveryIntents().readHandoff(target);
  return stored && stored.generation === generation ? stored.message : undefined;
}

async function postOnboarding(uid: string, target: ProjectDeliveryTarget, claim: DeliveryClaim): Promise<string> {
  const { kind } = claim;
  const { workspaceId, projectSlug } = target;
  const project = { ...claim.project, handoffMessage: kind === "handoff"
    ? await readHandoffMessage(target, claim.agent.handoff?.generation) : undefined };
  const [defaultAgent, coachIdentity, channel] = await Promise.all([
    readMattermostSecret(platformStateStore, uid, "coachMattermost"),
    platformStateStore.workspaces.agentIdentities.get(uid),
    platformStateStore.workspaces.channels.get({ workspaceSlug: workspaceId, projectSlug }, "general"),
  ]);
  const userDefaultAgentId = coachIdentity?.mattermostUserId;
  const channelId = channel?.mattermostChannelId;
  const token = defaultAgent?.personalToken;
  if (!channelId || !token || !userDefaultAgentId) throw new Error("Project handoff chat credentials are not ready");
  const receipt = `${workspaceId}/${projectSlug}/${kind}`;
  if (kind === "handoff") await prepareHandoff({ uid, projectSlug, project });
  await ensureDefaultAgentMembership(channelId, userDefaultAgentId);
  let postId = await matchingDeliveryPost(target, claim, channelId, receipt, token);
  if (!postId) {
    const message = deliveryMessage(project, kind, workspaceId, projectSlug);
    await beginDeliveryPost(target, claim);
    const post = await mmApi("/posts", "POST", { channel_id: channelId,
      message,
      props: { octogee_project_delivery: receipt } }, token) as { id?: string };
    if (!post.id) throw new Error("Project handoff post returned no ID");
    postId = post.id;
  }
  return postId;
}

export async function deliverProjectAgentOnboarding(uid: string, workspaceId: string, projectSlug: string): Promise<void> {
  const target = { workspaceId, projectSlug };
  if (!projectAgentDeliveryIntents().recordsIntents) {
    const kind = await pendingProjectDelivery(target);
    if (kind) {
      logger.warn("Project agent delivery skipped: no delivery intent store is installed", { uid, workspaceId, projectSlug, kind });
    }
    return;
  }
  const lease = await claimProjectDelivery(target, uid);
  if (!lease) return;
  try {
    const claim = await openDeliveryIntent(target, lease);
    const postId = await postOnboarding(uid, target, claim);
    await finishProjectDelivery(target, lease, { postId });
  } catch (error) {
    logger.error("Project onboarding delivery failed", { uid, workspaceId, projectSlug, kind: lease.kind, error });
    try {
      await finishProjectDelivery(target, lease, { error: error instanceof Error ? error.message : String(error) });
    } catch (cleanupError) {
      logger.error("Project onboarding delivery cleanup failed", { uid, workspaceId, projectSlug, error: cleanupError });
    }
    throw error;
  }
}
