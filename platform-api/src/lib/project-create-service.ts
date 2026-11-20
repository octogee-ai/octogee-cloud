import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { projectPresentation } from "@octogee/core/identity/project-presentation";
import { projectAgentDeliveryIntents } from "./project-agent-delivery-intents.js";
import { logger } from "@octogee/core/http/logging";
import { mmApi } from "./mattermost.js";
import { ChannelNameInUseError, createFreshPrivateChannel } from "./mattermost-channel-name.js";
import { getWorkspaceMmContext, type WorkspaceMmContext } from "./mattermost-context.js";
import {
  projectGeneralChannelName,
  isValidProjectId,
  PROJECT_ID_MIN_LENGTH,
  PROJECT_ID_MAX_LENGTH,
} from "@octogee/shared/types/identity";
import { projectRepoName } from "@octogee/core/gitea-naming";
import { deleteProjectRepo, provisionProjectRepoResult } from "../routes/projects/provisioning.js";
import { isValidGithubRepoSource } from "@octogee/core/git-host/github";
import type { RepoSourceAccess } from "../routes/projects/repo-source.js";
import { defaultProjectRecipe, type ProjectRecipeId } from "@octogee/shared/types/project";
import { requestedProjectRecipe } from "./project-recipe.js";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import type { FleetBrokerProjectCreateInput } from "@octogee/shared/types/fleet-broker";
import { provisionProjectAgent } from "./project-agent-service.js";

// "workspace" would collide with the workspace repo in Gitea (projectRepoName
// is the slug itself) — a project by that name adopts and shares the repo.
const RESERVED_PROJECT_SLUGS = new Set([
  "channels", "members", "files", "canvas", "chat",
  "settings", "discover", "admin", "new", "create", "workspace",
]);

export interface ProjectCreateActor {
  uid: string;
  userData: Record<string, unknown> | undefined;
  workspaceId: string | null | undefined;
  repoSourceAccess?: RepoSourceAccess;
  proveRepoSource?: (
    repoSource: { provider: "github"; owner: string; repo: string },
  ) => Promise<ProjectCreateResult | null>;
  source?: "ui" | "agent";
}

export type ProjectCreateInput = FleetBrokerProjectCreateInput;

export interface ProjectCreateResult {
  status: number;
  body: Record<string, unknown>;
}

interface ProjectCreatePlan {
  uid: string;
  userData: Record<string, unknown> | undefined;
  workspaceId: string;
  slug: string;
  trimmedName: string;
  trimmedTagline: string;
  agentName: string;
  category: string;
  projectType: string | null;
  status: string;
  targetVisibility: string;
  ghRepoSource: { provider: "github"; owner: string; repo: string } | null;
  recipe: ProjectRecipeId;
  giteaRepoName: string;
  source: "ui" | "agent";
  queuesKickoff: boolean;
}

interface NormalizedProjectCreateRequest {
  name: string;
  agentName: unknown;
  slug: string;
  tagline: string;
  category: string;
  projectType: string | null;
  status: string;
  visibility: string;
  repoSource: unknown;
  recipe: unknown;
}

interface MattermostMemberAdd {
  id: string | null;
  label: string;
}

interface ProjectProvisioningArtifacts {
  primaryChannel?: { channelId: string; teamId: string; name: string };
  generalChannelStored: boolean;
  repoCreated: boolean;
}

class ProjectProvisioningError extends Error {
  constructor(
    message: string,
    readonly responseError: string,
  ) {
    super(message);
    this.name = "ProjectProvisioningError";
  }
}

export function validateProjectSlug(slug: string): string | null {
  if (!isValidProjectId(slug)) {
    return `Slug must be ${PROJECT_ID_MIN_LENGTH}-${PROJECT_ID_MAX_LENGTH} chars, lowercase letters and digits only (no hyphens).`;
  }
  if (RESERVED_PROJECT_SLUGS.has(slug)) return "That slug is reserved.";
  return null;
}

type RepoSourceResult =
  | { ok: true; value: { provider: "github"; owner: string; repo: string } | null }
  | { ok: false; status: number; error: string };

function resolveCreateRepoSource(repoSource: unknown, access: RepoSourceAccess): RepoSourceResult {
  if (repoSource === undefined || repoSource === null) return { ok: true, value: null };
  if (access === "unavailable") {
    return { ok: false, status: 503, error: "feature_evaluation_unavailable" };
  }
  if (access !== "enabled") {
    return { ok: false, status: 403, error: "GitHub-backed projects are not enabled for this account" };
  }
  if (!isValidGithubRepoSource(repoSource)) {
    return { ok: false, status: 400, error: "Invalid repoSource (expected { provider: 'github', owner, repo })" };
  }
  return { ok: true, value: { provider: "github", owner: repoSource.owner, repo: repoSource.repo } };
}

function bad(status: number, error: string, extra: Record<string, unknown> = {}): ProjectCreateResult {
  return { status, body: { error, ...extra } };
}

export async function createProjectForActor(
  actor: ProjectCreateActor,
  input: ProjectCreateInput | null | undefined,
  prewarmProjectRunCapacity?: () => Promise<void>,
): Promise<ProjectCreateResult> {
  const planResult = buildProjectCreatePlan(actor, input);
  if (!planResult.ok) return planResult.result;
  const plan = planResult.plan;

  const existing = await platformStateStore.workspaces.projects.get(plan.workspaceId, plan.slug);
  if (existing) {
    // Deterministic 409 before the plan gate — a duplicate slug is a slug
    // problem, not an upgrade prompt, and this avoids the aggregate count read.
    return slugTaken();
  }

  const limitFailure = await enforceProjectLimit(plan);
  if (limitFailure) return limitFailure;

  if (plan.ghRepoSource) {
    if (!actor.proveRepoSource) {
      return bad(503, "GitHub repository authorization could not be verified");
    }
    const proofFailure = await actor.proveRepoSource(plan.ghRepoSource);
    if (proofFailure) return proofFailure;
  }

  const reservationFailure = await reserveProvisioningProject(plan);
  if (reservationFailure) return reservationFailure;
  if (plan.source === "ui" && !plan.queuesKickoff) {
    logger.warn(`[projects] Kickoff skipped for ${plan.workspaceId}/${plan.slug}: no project agent delivery intent store is installed`);
  }
  if (plan.recipe !== "static-site" && prewarmProjectRunCapacity) {
    void prewarmProjectCapacity(plan, prewarmProjectRunCapacity);
  }
  const artifacts: ProjectProvisioningArtifacts = {
    generalChannelStored: false,
    repoCreated: false,
  };

  try {
    await writeProjectProductFields(plan);
    await writeProjectOwnerMember(plan);
    const callerCtx = await getWorkspaceMmContext(plan.uid, plan.workspaceId);
    const channel = await provisionProjectMattermost(plan, callerCtx, artifacts);
    await provisionProjectCodeRepo(plan, artifacts);
    await markProjectActive(plan);
    await provisionProjectAgentByDefault(plan);
    logger.info(`[projects] Created project ${plan.workspaceId}/${plan.slug}`, {
      source: plan.source,
      uid: plan.uid,
    });

    return {
      status: 200,
      body: {
        success: true,
        workspaceId: plan.workspaceId,
        slug: plan.slug,
        channelId: channel.mmChannelId,
      },
    };
  } catch (error) {
    return failProjectProvisioning(plan, artifacts, error);
  }
}

async function prewarmProjectCapacity(plan: ProjectCreatePlan, prewarm: () => Promise<void>): Promise<void> {
  try {
    await prewarm();
  } catch (error) {
    logger.error("[projects] capacity prewarm failed", {
      workspaceId: plan.workspaceId,
      projectSlug: plan.slug,
      error,
    });
  }
}

// Per-plan project ceiling (pricing v3): Personal Free 0, Personal 1, Pro 5,
// Pro Max + any user unlimited. Counts only the actor's OWN projects in the
// workspace (membership is independent), and skips the read entirely on an
// unlimited plan. A 402 so the client can route to upgrade.
async function enforceProjectLimit(
  plan: ProjectCreatePlan,
): Promise<ProjectCreateResult | null> {
  if (userEntitlements().projectMode(plan.userData ?? {}) !== "active") {
    return bad(402, "Projects are available on paid plans — upgrade to start building", {
      maxProjects: 0,
    });
  }
  const maxProjects = userEntitlements().maxProjects(plan.userData ?? {});
  if (maxProjects === "unlimited") return null;

  // Personal Free (0) can never create — 402 without the count read.
  if (maxProjects <= 0) {
    return bad(402, "Projects are available on paid plans — upgrade to start building", { maxProjects });
  }

  const owned = await platformStateStore.workspaces.projects.listByOwner(plan.uid, plan.workspaceId);
  return owned.length < maxProjects ? null : projectLimitReached(maxProjects);
}

function slugTaken(): ProjectCreateResult {
  return bad(409, "A project with this slug already exists in your workspace");
}

function projectLimitReached(maxProjects: number): ProjectCreateResult {
  return bad(
    402,
    `Your plan includes ${maxProjects} project${maxProjects === 1 ? "" : "s"}. Upgrade for more.`,
    { maxProjects },
  );
}

function buildProjectCreatePlan(
  actor: ProjectCreateActor,
  input: ProjectCreateInput | null | undefined,
): { ok: true; plan: ProjectCreatePlan } | { ok: false; result: ProjectCreateResult } {
  const { uid, userData, workspaceId } = actor;
  const request = normalizeProjectCreateRequest(input);
  const validation = validateProjectCreateRequest(request);
  if (!validation.ok) return validation;

  const rs = resolveCreateRepoSource(request.repoSource, actor.repoSourceAccess ?? "disabled");
  if (!rs.ok) return { ok: false, result: bad(rs.status, rs.error) };

  const recipe = request.recipe === undefined
    ? { ok: true as const, value: defaultProjectRecipe(request.projectType) }
    : requestedProjectRecipe(request.recipe);
  if (!recipe.ok) return { ok: false, result: bad(400, recipe.error) };

  if (!workspaceId) {
    return { ok: false, result: bad(422, "Workspace not provisioned") };
  }

  return {
    ok: true,
    plan: {
      uid,
      userData,
      workspaceId,
      slug: request.slug,
      trimmedName: validation.trimmedName,
      agentName: typeof request.agentName === "string" ? request.agentName.trim() : "",
      trimmedTagline: request.tagline.trim(),
      category: request.category,
      projectType: request.projectType,
      status: request.status,
      targetVisibility: request.visibility,
      ghRepoSource: rs.value,
      recipe: recipe.value,
      giteaRepoName: projectRepoName(request.slug),
      source: actor.source ?? "ui",
      queuesKickoff: (actor.source ?? "ui") === "ui" && projectAgentDeliveryIntents().recordsIntents,
    },
  };
}

function normalizeProjectCreateRequest(
  input: ProjectCreateInput | null | undefined,
): NormalizedProjectCreateRequest {
  const request = input && typeof input === "object" ? input : {};
  return {
    name: stringValue(request.name),
    agentName: request.agentName,
    slug: stringValue(request.slug),
    tagline: stringValue(request.tagline),
    category: nonEmptyStringOr(request.category, "other"),
    projectType: nonEmptyStringOr(request.projectType, null),
    status: nonEmptyStringOr(request.status, "building"),
    visibility: nonEmptyStringOr(request.visibility, "private"),
    repoSource: request.repoSource,
    recipe: request.recipe,
  };
}

function validateProjectCreateRequest(
  request: NormalizedProjectCreateRequest,
): { ok: true; trimmedName: string } | { ok: false; result: ProjectCreateResult } {
  if (request.agentName !== undefined && (typeof request.agentName !== "string" || request.agentName.trim().length > 80)) {
    return { ok: false, result: bad(400, "Agent name must be text with 80 characters or fewer") };
  }
  const trimmedName = request.name.trim();
  if (trimmedName.length === 0) {
    return { ok: false, result: bad(400, "Project name is required") };
  }
  if (request.slug.length === 0) {
    return { ok: false, result: bad(400, "Project slug is required") };
  }
  const slugErr = validateProjectSlug(request.slug);
  return slugErr
    ? { ok: false, result: bad(400, slugErr) }
    : { ok: true, trimmedName };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonEmptyStringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

async function reserveProvisioningProject(plan: ProjectCreatePlan): Promise<ProjectCreateResult | null> {
  const maxProjects = userEntitlements().maxProjects(plan.userData ?? {});
  return platformStateStore.transaction({ label: "project-create.reserve" }, async (tx) => {
    const { projects } = tx.workspaces;
    if (await projects.get(plan.workspaceId, plan.slug)) return slugTaken();
    if (maxProjects !== "unlimited") {
      const owned = await projects.listByOwner(plan.uid, plan.workspaceId);
      if (owned.length >= maxProjects) return projectLimitReached(maxProjects);
    }
    await projects.put({
      workspaceSlug: plan.workspaceId,
      projectSlug: plan.slug,
      ownerUid: plan.uid,
      ownerActive: true,
      giteaRepoName: plan.giteaRepoName,
      provisioningState: "provisioning",
      provisioningError: null,
      pendingVisibility: plan.targetVisibility,
      visibility: "private",
      checkoutEnabled: plan.ghRepoSource ? false : null,
      status: plan.status,
      archived: null,
      archivedAt: null,
      commercialLifecycleStatus: null,
      repoSource: plan.ghRepoSource,
      agent: {
        requestedName: plan.agentName,
        identity: { name: plan.agentName || plan.slug, emoji: "🤖", persona: "" },
        ...(plan.queuesKickoff ? { kickoff: { status: "pending" } } : {}),
      },
      updatedAt: { serverNow: true },
    });
    return null;
  });
}

async function writeProjectProductFields(plan: ProjectCreatePlan): Promise<void> {
  await projectPresentation().createProject(plan.workspaceId, plan.slug, {
    id: plan.slug,
    workspaceId: plan.workspaceId,
    slug: plan.slug,
    ownerUid: plan.uid,
    name: plan.trimmedName,
    tagline: plan.trimmedTagline,
    description: "",
    category: plan.category,
    projectType: plan.projectType,
    canvasFile: "README.md",
    recipe: plan.recipe,
    publishedUrl: null,
    starCount: 0,
    memberCount: 1,
  });
}

async function writeProjectOwnerMember(plan: ProjectCreatePlan): Promise<void> {
  await platformStateStore.workspaces.projectMembers.put({
    workspaceSlug: plan.workspaceId,
    projectSlug: plan.slug,
    uid: plan.uid,
    role: "owner",
    joinedAt: { serverNow: true },
  });
}

async function provisionProjectMattermost(
  plan: ProjectCreatePlan,
  callerCtx: WorkspaceMmContext | null,
  artifacts: ProjectProvisioningArtifacts,
): Promise<{ teamId: string; mmChannelId: string }> {
  const teamId = callerCtx?.teamId;
  if (!teamId) {
    throw new ProjectProvisioningError(
      "Workspace has no Mattermost team context",
      "Project provisioning failed - workspace chat is not ready",
    );
  }

  const mmChannelId = await createMattermostProjectChannel(plan, teamId, artifacts);
  try {
    await writeProjectGeneralChannel(plan, mmChannelId);
    artifacts.generalChannelStored = true;
  } catch (error) {
    throw new ProjectProvisioningError(
      errorMessage(error),
      "Project provisioning failed - could not record chat channel",
    );
  }

  const memberAdds = mattermostMemberAdds(callerCtx);
  const memberFailure = await addMattermostChannelMembers(mmChannelId, memberAdds);
  if (memberFailure) {
    throw new ProjectProvisioningError(
      memberFailure,
      "Project provisioning failed - could not add channel members",
    );
  }

  return { teamId, mmChannelId };
}

async function createMattermostProjectChannel(
  plan: ProjectCreatePlan,
  teamId: string,
  artifacts: ProjectProvisioningArtifacts,
): Promise<string> {
  const channelName = projectGeneralChannelName(plan.workspaceId, plan.slug);
  try {
    const channelId = await createFreshPrivateChannel(teamId, channelName, plan.trimmedName);
    artifacts.primaryChannel = { channelId, teamId, name: channelName };
    return channelId;
  } catch (err) {
    throw new ProjectProvisioningError(
      errorMessage(err),
      err instanceof ChannelNameInUseError
        ? "Project provisioning failed - chat channel name is in use"
        : "Project provisioning failed - could not create chat channel",
    );
  }
}

function mattermostMemberAdds(callerCtx: WorkspaceMmContext): MattermostMemberAdd[] {
  return [
    { id: callerCtx.userId, label: "owner" },
  ];
}

async function addMattermostChannelMembers(
  mmChannelId: string,
  memberAdds: MattermostMemberAdd[],
): Promise<string | null> {
  for (const m of memberAdds) {
    const failure = await addMattermostChannelMember(mmChannelId, m);
    if (failure) return failure;
  }
  return null;
}

async function addMattermostChannelMember(
  mmChannelId: string,
  member: MattermostMemberAdd,
): Promise<string | null> {
  if (!member.id) return `${member.label} has no Mattermost userId - provisioning incomplete`;
  try {
    await mmApi(`/channels/${mmChannelId}/members`, "POST", { user_id: member.id });
    return null;
  } catch (err) {
    return `Add ${member.label} ${member.id} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function writeProjectGeneralChannel(plan: ProjectCreatePlan, mmChannelId: string): Promise<void> {
  await platformStateStore.workspaces.channels.put({
    scope: { workspaceSlug: plan.workspaceId, projectSlug: plan.slug },
    channelId: "general",
    kind: "general",
    mattermostChannelId: mmChannelId,
    archivedAt: null,
    createdBy: null,
    createdAt: { serverNow: true },
  });
  await projectPresentation().writeChannel({ workspaceSlug: plan.workspaceId, projectSlug: plan.slug }, "general", { name: "general" });
}

async function provisionProjectCodeRepo(
  plan: ProjectCreatePlan,
  artifacts: ProjectProvisioningArtifacts,
): Promise<void> {
  const repoResult = await provisionProjectRepoResult({
    workspaceId: plan.workspaceId,
    slug: plan.slug,
    name: plan.trimmedName,
    tagline: plan.trimmedTagline,
    projectType: plan.projectType,
    visibility: plan.targetVisibility,
    recipe: plan.recipe,
    githubBacked: plan.ghRepoSource !== null,
  });
  artifacts.repoCreated = repoResult.created;
  if (!repoResult.error) return;
  throw new ProjectProvisioningError(
    repoResult.error,
    "Project provisioning failed - could not create code repo",
  );
}

async function failProjectProvisioning(
  plan: ProjectCreatePlan,
  artifacts: ProjectProvisioningArtifacts,
  error: unknown,
): Promise<ProjectCreateResult> {
  const provisioningError = errorMessage(error);
  const responseError = error instanceof ProjectProvisioningError
    ? error.responseError
    : "Project provisioning failed - could not complete setup";
  await platformStateStore.workspaces.projects.patch(plan.workspaceId, plan.slug, {
    provisioningState: "failed",
    provisioningError: provisioningError.slice(0, 500),
    provisioningCleanup: {
      status: "in_progress",
      error: null,
    },
    updatedAt: { serverNow: true },
  });
  logger.error(`[projects] Provisioning failed for ${plan.workspaceId}/${plan.slug}: ${provisioningError}`);

  try {
    await cleanupProjectProvisioning(plan, artifacts);
    await platformStateStore.workspaces.projects.patch(plan.workspaceId, plan.slug, {
      provisioningCleanup: {
        status: "complete",
        error: null,
        completedAt: { serverNow: true },
      },
      updatedAt: { serverNow: true },
    });
    return bad(502, responseError, {
      workspaceId: plan.workspaceId,
      slug: plan.slug,
      cleanupState: "complete",
    });
  } catch (cleanupError) {
    const cleanupMessage = errorMessage(cleanupError);
    await platformStateStore.workspaces.projects.patch(plan.workspaceId, plan.slug, {
      provisioningCleanup: {
        status: "failed",
        error: cleanupMessage.slice(0, 500),
      },
      updatedAt: { serverNow: true },
    });
    logger.error(
      `[projects] Provisioning cleanup failed for ${plan.workspaceId}/${plan.slug}: ${cleanupMessage}`,
    );
    return bad(502, responseError, {
      workspaceId: plan.workspaceId,
      slug: plan.slug,
      cleanupState: "failed",
    });
  }
}

async function cleanupProjectProvisioning(
  plan: ProjectCreatePlan,
  artifacts: ProjectProvisioningArtifacts,
): Promise<void> {
  const failures: string[] = [];
  if (artifacts.primaryChannel) {
    try {
      await archiveUnstoredProjectChannel(artifacts.primaryChannel);
    } catch (error) {
      failures.push(`Mattermost cleanup: ${errorMessage(error)}`);
    }
  }
  if (artifacts.repoCreated) {
    try {
      await deleteProjectRepo({ workspaceId: plan.workspaceId, slug: plan.slug });
    } catch (error) {
      failures.push(`Gitea cleanup: ${errorMessage(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}

async function archiveUnstoredProjectChannel(
  channel: NonNullable<ProjectProvisioningArtifacts["primaryChannel"]>,
): Promise<void> {
  const initial = await verifiedProjectChannel(channel);
  if (channelIsArchived(initial)) return;
  await mmApi(`/channels/${channel.channelId}`, "DELETE");
  const archived = await verifiedProjectChannel(channel);
  if (!channelIsArchived(archived)) {
    throw new Error(`Mattermost channel ${channel.channelId} was not archived`);
  }
}

async function verifiedProjectChannel(
  expected: NonNullable<ProjectProvisioningArtifacts["primaryChannel"]>,
): Promise<Record<string, unknown>> {
  const raw = await mmApi(`/channels/${expected.channelId}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Mattermost returned an invalid channel for ${expected.channelId}`);
  }
  const channel = raw as Record<string, unknown>;
  if (
    channel.id !== expected.channelId
    || channel.name !== expected.name
    || channel.team_id !== expected.teamId
    || channel.type !== "P"
  ) {
    throw new Error(`Mattermost channel binding mismatch for ${expected.channelId}`);
  }
  return channel;
}

function channelIsArchived(channel: Record<string, unknown>): boolean {
  return typeof channel.delete_at === "number" && channel.delete_at > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function markProjectActive(plan: ProjectCreatePlan): Promise<void> {
  await platformStateStore.workspaces.projects.patch(plan.workspaceId, plan.slug, {
    provisioningState: "active",
    provisioningError: null,
    visibility: plan.targetVisibility,
    pendingVisibility: null,
    updatedAt: { serverNow: true },
  });
}

// Every new project gets its agent, so a project is useful the moment it
// exists and nothing has to reach in from the workspace agent. A mint failure is
// not a create failure — the project is already active and the owner retries
// from project settings.
async function provisionProjectAgentByDefault(plan: ProjectCreatePlan): Promise<void> {
  try {
    const result = await provisionProjectAgent({ uid: plan.uid, workspaceId: plan.workspaceId }, plan.slug);
    if (result.status !== 200) {
      logger.warn(
        `[projects] Default project agent not provisioned for ${plan.workspaceId}/${plan.slug}`,
        { status: result.status, body: result.body },
      );
    }
  } catch (err) {
    logger.error(
      `[projects] Default project agent failed for ${plan.workspaceId}/${plan.slug}:`,
      { err },
    );
  }
}

export function projectSlugAvailability(slug: string): { ok: true } | { ok: false; reason: string } {
  const err = validateProjectSlug(slug);
  return err ? { ok: false, reason: err } : { ok: true };
}
