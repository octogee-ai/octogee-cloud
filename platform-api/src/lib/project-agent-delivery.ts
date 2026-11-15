import { randomUUID } from "node:crypto";
import type { OpaqueMap, PlatformStateTransaction, Stored, WorkspaceProject } from "@octogee/core/platform-state";
import type { ProjectAgentConfig } from "@octogee/shared/types/project";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { mmApi } from "./mattermost.js";
import { projectPresentation } from "@octogee/core/identity/project-presentation";
import {
  DeliveryIntentReplacedError,
  projectAgentDeliveryIntents,
  type DeliveryIntentPatch,
  type DeliveryKind,
  type OpenedDeliveryIntent,
  type ProjectDeliveryTarget,
} from "./project-agent-delivery-intents.js";

export type OnboardingProject = { name?: string; tagline?: string; agent: ProjectAgentConfig; repoSource: OpaqueMap | null; handoffMessage?: string };
export interface DeliveryLease {
  kind: DeliveryKind;
  leaseId: string;
  agent: ProjectAgentConfig;
  repoSource: OpaqueMap | null;
}
export interface DeliveryClaim extends DeliveryLease {
  project: OnboardingProject;
  startedAt: number;
  postAttempted: boolean;
  recoveryBefore?: string;
  intent: OpenedDeliveryIntent;
}
export type DeliveryOutcome = { postId: string } | { error: string };

type DeliveryAgent = ProjectAgentConfig & { deliveryLeaseId?: string; deliveryLeaseUntil?: number };
type LeasedProject = { project: Stored<WorkspaceProject>; agent: DeliveryAgent };

const DELIVERY_LEASE_MS = 120_000;
const LEASE_REPLACED = "Project delivery lease was replaced";

function pendingDelivery(agent: ProjectAgentConfig): DeliveryKind | null {
  if (agent.handoff) return agent.handoff.status === "pending" ? "handoff" : null;
  return agent.kickoff?.status === "pending" ? "kickoff" : null;
}

async function readLeasedProject(
  tx: PlatformStateTransaction,
  target: ProjectDeliveryTarget,
  leaseId: string,
  lost: string,
): Promise<LeasedProject> {
  const project = await tx.workspaces.projects.get(target.workspaceId, target.projectSlug);
  const agent = project?.agent as DeliveryAgent | null | undefined;
  if (!project || !agent || agent.deliveryLeaseId !== leaseId) throw new Error(lost);
  return { project, agent };
}

async function writeAgent(tx: PlatformStateTransaction, project: Stored<WorkspaceProject>, agent: OpaqueMap): Promise<void> {
  await tx.workspaces.projects.patch(project.workspaceSlug, project.projectSlug, { agent }, { revision: project.revision });
}

async function assertLeaseHeld(target: ProjectDeliveryTarget, leaseId: string): Promise<void> {
  const current = await platformStateStore.workspaces.projects.get(target.workspaceId, target.projectSlug);
  if ((current?.agent as DeliveryAgent | null | undefined)?.deliveryLeaseId !== leaseId) throw new Error(LEASE_REPLACED);
}

async function updateIntent(claim: DeliveryClaim, patch: DeliveryIntentPatch): Promise<void> {
  try {
    await claim.intent.update(patch);
  } catch (error) {
    if (error instanceof DeliveryIntentReplacedError) throw new Error(LEASE_REPLACED, { cause: error });
    throw error;
  }
}

export async function pendingProjectDelivery(target: ProjectDeliveryTarget): Promise<DeliveryKind | null> {
  const project = await platformStateStore.workspaces.projects.get(target.workspaceId, target.projectSlug);
  const agent = project?.agent as ProjectAgentConfig | null | undefined;
  return agent ? pendingDelivery(agent) : null;
}

export async function claimProjectDelivery(target: ProjectDeliveryTarget, uid: string): Promise<DeliveryLease | null> {
  return platformStateStore.transaction({ label: "project-agent-delivery.claim" }, async (tx) => {
    const project = await tx.workspaces.projects.get(target.workspaceId, target.projectSlug);
    const agent = project?.agent as DeliveryAgent | null | undefined;
    if (!project || project.ownerUid !== uid || !agent || agent.status !== "ready") return null;
    const kind = pendingDelivery(agent);
    if (!kind) return null;
    if ((agent.deliveryLeaseUntil ?? 0) > Date.now()) throw new Error("Project agent delivery is in progress");
    const leaseId = randomUUID();
    await writeAgent(tx, project, { ...agent, deliveryLeaseId: leaseId, deliveryLeaseUntil: Date.now() + DELIVERY_LEASE_MS });
    return { kind, leaseId, agent, repoSource: project.repoSource };
  });
}

export async function openDeliveryIntent(target: ProjectDeliveryTarget, lease: DeliveryLease): Promise<DeliveryClaim> {
  const [intent, product] = await Promise.all([
    projectAgentDeliveryIntents().openIntent(target, lease.kind, { startedAt: Date.now() - 5_000 }),
    projectPresentation().readProject(target.workspaceId, target.projectSlug),
  ]);
  if (intent.created) await assertLeaseHeld(target, lease.leaseId);
  return {
    ...lease,
    project: {
      name: typeof product?.name === "string" ? product.name : undefined,
      tagline: typeof product?.tagline === "string" ? product.tagline : undefined,
      agent: lease.agent,
      repoSource: lease.repoSource,
    },
    startedAt: intent.startedAt,
    postAttempted: intent.postAttempted,
    recoveryBefore: intent.recoveryBefore,
    intent,
  };
}

export async function beginDeliveryPost(target: ProjectDeliveryTarget, claim: DeliveryClaim): Promise<void> {
  const expired = "Project delivery lease expired before posting";
  await platformStateStore.transaction({ label: "project-agent-delivery.begin" }, async (tx) => {
    const { project, agent } = await readLeasedProject(tx, target, claim.leaseId, expired);
    if ((agent.deliveryLeaseUntil ?? 0) <= Date.now()) throw new Error(expired);
    await writeAgent(tx, project, { ...agent, deliveryLeaseUntil: Date.now() + DELIVERY_LEASE_MS });
  });
  await updateIntent(claim, { postAttempted: true, startedAt: Date.now() - 5_000, recoveryBefore: null });
}

function deliveredAgent(agent: DeliveryAgent, kind: DeliveryKind, outcome: DeliveryOutcome): OpaqueMap {
  const { deliveryLeaseId: _leaseId, deliveryLeaseUntil: _leaseUntil, ...released } = agent;
  if ("error" in outcome) return { ...released, lastError: outcome.error };
  return { ...released, [kind]: { ...released[kind], status: "sent", postId: outcome.postId }, lastError: null };
}

export async function finishProjectDelivery(target: ProjectDeliveryTarget, claim: DeliveryLease, outcome: DeliveryOutcome): Promise<void> {
  await platformStateStore.transaction({ label: "project-agent-delivery.finish" }, async (tx) => {
    const { project, agent } = await readLeasedProject(tx, target, claim.leaseId, LEASE_REPLACED);
    await writeAgent(tx, project, deliveredAgent(agent, claim.kind, outcome));
  });
}

export async function matchingDeliveryPost(target: ProjectDeliveryTarget, claim: DeliveryClaim, channelId: string, receipt: string, token: string): Promise<string | null> {
  if (!claim.postAttempted) return null;
  let before = claim.recoveryBefore;
  for (let page = 0; page < 3; page += 1) {
    const cursor = before ? `&before=${encodeURIComponent(before)}` : "";
    const history = await mmApi(`/channels/${channelId}/posts?per_page=100${cursor}`, "GET", undefined, token) as {
      order: string[]; posts: Record<string, { id: string; create_at: number; props?: Record<string, unknown> }>;
    };
    const posts = Object.values(history.posts);
    const match = posts.find((post) => post.props?.octogee_project_delivery === receipt);
    if (match) return match.id;
    if (history.order.length < 100 || posts.some((post) => post.create_at < claim.startedAt)) return null;
    const nextBefore = history.order.at(-1);
    if (!nextBefore || nextBefore === before) throw new Error("Project delivery receipt history did not advance");
    before = nextBefore;
  }
  await assertLeaseHeld(target, claim.leaseId);
  await updateIntent(claim, { recoveryBefore: before });
  throw new Error("Project delivery receipt history limit reached; recovery will continue on retry");
}
