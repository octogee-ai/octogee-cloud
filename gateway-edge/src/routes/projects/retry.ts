import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { platformStateStore } from "../../lib/platform-state.js";
import { projectPresentation } from "../../lib/project-presentation.js";
import { mmApi } from "../../lib/mattermost.js";
import { createFreshPrivateChannel } from "../../lib/mattermost-channel-name.js";
import { logger } from "../../middleware/logging.js";
import { projectGeneralChannelName } from "@octogee/shared/types/identity";
import { defaultProjectRecipe, isProjectRecipeId } from "@octogee/shared/types/project";
import { getWorkspaceMmContext } from "../../lib/mattermost-context.js";
import { withProject, type ProjectCtx } from "../../lib/withProject.js";
import { provisionProjectRepo } from "./provisioning.js";
import { projectRepoName } from "@octogee/core/gitea-naming";
import { provisionProjectAgent } from "../../lib/project-agent-service.js";

const router = Router();

type WorkspaceMmContext = NonNullable<Awaited<ReturnType<typeof getWorkspaceMmContext>>>;
type RetryMattermostContext = WorkspaceMmContext & {
  teamId: string;
};

interface RetryMember {
  id: string | null;
  label: string;
}

interface RetryChannel {
  id: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function generalChannelScope(ctx: ProjectCtx): { workspaceSlug: string; projectSlug: string } {
  return { workspaceSlug: ctx.wid, projectSlug: ctx.pid };
}

async function markRetryFailed(ctx: ProjectCtx, provisioningError: string): Promise<void> {
  await platformStateStore.workspaces.projects.patch(ctx.wid, ctx.pid, {
    provisioningState: "failed",
    provisioningError: provisioningError.slice(0, 500),
    updatedAt: { serverNow: true },
  });
}

async function claimProjectRetry(ctx: ProjectCtx): Promise<boolean> {
  return platformStateStore.transaction({ label: "project-retry.claim" }, async (tx) => {
    const { projects, channels } = tx.workspaces;
    const project = await projects.get(ctx.wid, ctx.pid);
    if (!project || project.ownerUid !== ctx.uid || project.provisioningCleanup?.status === "in_progress") {
      return false;
    }
    if (project.provisioningState !== "failed") {
      if (project.provisioningState !== "active") return false;
      if (await channels.get(generalChannelScope(ctx), "general")) return false;
    }
    await projects.patch(ctx.wid, ctx.pid, {
      provisioningState: "provisioning",
      provisioningError: null,
      provisioningCleanup: null,
      updatedAt: { serverNow: true },
    }, { revision: project.revision });
    return true;
  });
}

async function restoreInterruptedProductFields(ctx: ProjectCtx): Promise<void> {
  if (ctx.project.name !== undefined) return;
  await projectPresentation().createProject(ctx.wid, ctx.pid, {
    name: ctx.pid,
    tagline: "",
    description: "",
    category: "other",
    projectType: null,
    canvasFile: "README.md",
    recipe: defaultProjectRecipe(null),
    publishedUrl: null,
    starCount: 0,
    memberCount: 1,
  });
}

async function retryMattermostContext(ctx: ProjectCtx, res: Response): Promise<RetryMattermostContext | null> {
  const callerCtx = await getWorkspaceMmContext(ctx.uid, ctx.wid);
  if (callerCtx?.teamId) return { ...callerCtx, teamId: callerCtx.teamId };
  await markRetryFailed(ctx, "Workspace has no Mattermost team context");
  res.status(502).json({ error: "Retry failed — workspace chat is not ready" });
  return null;
}

async function lookupRetryChannel(
  teamId: string,
  channelName: string,
): Promise<{ id?: string; type?: string } | null> {
  try {
    return (await mmApi(`/teams/${teamId}/channels/name/${channelName}`)) as { id?: string; type?: string } | null;
  } catch (lookupErr) {
    if ((lookupErr as { status?: number } | null)?.status !== 404) throw lookupErr;
    return null;
  }
}

async function createRetryChannel(teamId: string, channelName: string, displayName: string): Promise<string> {
  return createFreshPrivateChannel(teamId, channelName, displayName);
}

async function ensureRetryChannel(ctx: ProjectCtx, teamId: string, channelName: string): Promise<string> {
  const existing = await lookupRetryChannel(teamId, channelName);
  if (existing?.id) {
    if (existing.type === "O") {
      await mmApi(`/channels/${existing.id}/privacy`, "PUT", { privacy: "P" });
    }
    return existing.id;
  }
  return createRetryChannel(teamId, channelName, ctx.project.name || ctx.pid);
}

async function restoreStoredRetryChannel(
  ctx: ProjectCtx,
  teamId: string,
  channelName: string,
): Promise<string | null> {
  const stored = await platformStateStore.workspaces.channels.get(generalChannelScope(ctx), "general");
  const channelId = stored?.mattermostChannelId;
  if (!channelId) return null;
  const channel = await loadStoredRetryChannel(channelId);
  if (!channel) return null;
  assertStoredRetryChannelBinding(channel, channelId, teamId, channelName, ctx);
  await restoreArchivedRetryChannel(channel, channelId);
  return channelId;
}

async function loadStoredRetryChannel(channelId: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await mmApi(`/channels/${channelId}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Mattermost returned an invalid channel for ${channelId}`);
    }
    return raw as Record<string, unknown>;
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status === 404) return null;
    throw error;
  }
}

function assertStoredRetryChannelBinding(
  channel: Record<string, unknown>,
  channelId: string,
  teamId: string,
  channelName: string,
  ctx: ProjectCtx,
): void {
  const bindingMatches = channel.id === channelId
    && channel.name === channelName
    && channel.team_id === teamId
    && channel.type === "P";
  if (!bindingMatches) throw new Error(`Stored project channel binding mismatch for ${ctx.wid}/${ctx.pid}`);
}

async function restoreArchivedRetryChannel(channel: Record<string, unknown>, channelId: string): Promise<void> {
  if (typeof channel.delete_at === "number" && channel.delete_at > 0) {
    await mmApi(`/channels/${channelId}/restore`, "POST");
  }
}

async function retryChannelId(
  ctx: ProjectCtx,
  res: Response,
  teamId: string,
  channelName: string,
): Promise<RetryChannel | null> {
  try {
    const restored = await restoreStoredRetryChannel(ctx, teamId, channelName);
    if (restored) return { id: restored };
    return { id: await ensureRetryChannel(ctx, teamId, channelName) };
  } catch (err) {
    const message = errorMessage(err);
    await markRetryFailed(ctx, message);
    logger.error(`[projects] Retry provisioning failed for ${ctx.wid}/${ctx.pid}:`, { err });
    res.status(502).json({ error: "Retry failed — could not create chat channel" });
    return null;
  }
}

function retryMembers(callerCtx: RetryMattermostContext): RetryMember[] {
  return [
    { id: callerCtx.userId, label: "owner" },
  ];
}

async function addRetryMembers(mmChannelId: string, members: RetryMember[]): Promise<string | null> {
  for (const member of members) {
    if (!member.id) return `${member.label} has no Mattermost userId — provisioning incomplete`;
    try {
      await mmApi(`/channels/${mmChannelId}/members`, "POST", { user_id: member.id });
    } catch (err) {
      return `Add ${member.label} ${member.id} failed: ${errorMessage(err)}`;
    }
  }
  return null;
}

async function addRetryMembersOrFail(
  ctx: ProjectCtx,
  res: Response,
  mmChannelId: string,
  members: RetryMember[],
): Promise<boolean> {
  const memberFailure = await addRetryMembers(mmChannelId, members);
  if (!memberFailure) return true;
  await markRetryFailed(ctx, memberFailure);
  logger.error(`[projects] Retry membership failed for ${ctx.wid}/${ctx.pid}: ${memberFailure}`);
  res.status(502).json({ error: "Retry failed — could not add channel members" });
  return false;
}

async function writeRetryGeneralChannel(
  ctx: ProjectCtx,
  mmChannelId: string,
): Promise<void> {
  await platformStateStore.workspaces.channels.put({
    scope: generalChannelScope(ctx),
    channelId: "general",
    kind: "general",
    mattermostChannelId: mmChannelId,
    archivedAt: null,
    createdBy: null,
    createdAt: { serverNow: true },
  });
  await projectPresentation().writeChannel(generalChannelScope(ctx), "general", { name: "general" });
}

function restoredVisibility(ctx: ProjectCtx): string {
  return typeof ctx.project.pendingVisibility === "string"
    ? ctx.project.pendingVisibility
    : ctx.project.visibility;
}

async function reconcileRetryRepoOrFail(ctx: ProjectCtx, res: Response, visibility: string): Promise<boolean> {
  const projectType = typeof ctx.project.projectType === "string" ? ctx.project.projectType : null;
  const repoErr = await provisionProjectRepo({
    workspaceId: ctx.wid,
    slug: ctx.pid,
    name: ctx.project.name || ctx.pid,
    tagline: typeof ctx.project.tagline === "string" ? ctx.project.tagline : "",
    projectType,
    visibility,
    githubBacked: ctx.project.repoSource?.provider === "github",
    recipe: isProjectRecipeId(ctx.project.recipe)
      ? ctx.project.recipe
      : defaultProjectRecipe(projectType),
  });
  if (!repoErr) return true;
  await markRetryFailed(ctx, repoErr);
  logger.error(`[projects] Gitea reconcile failed for ${ctx.wid}/${ctx.pid}: ${repoErr}`);
  res.status(502).json({ error: "Retry failed — could not reconcile code repo" });
  return false;
}

async function activateRetriedProject(ctx: ProjectCtx, visibility: string): Promise<void> {
  await platformStateStore.workspaces.projects.patch(ctx.wid, ctx.pid, {
    provisioningState: "active",
    provisioningError: null,
    visibility,
    pendingVisibility: null,
    giteaRepoName: ctx.project.giteaRepoName || projectRepoName(ctx.pid),
    updatedAt: { serverNow: true },
  });
}

async function provisionRetriedProjectAgent(ctx: ProjectCtx): Promise<void> {
  try {
    const result = await provisionProjectAgent({ uid: ctx.uid, workspaceId: ctx.wid }, ctx.pid);
    if (result.status !== 200) {
      logger.warn(`[projects] Retry project agent not provisioned for ${ctx.wid}/${ctx.pid}`, {
        status: result.status,
        body: result.body,
      });
    }
  } catch (err) {
    logger.error(`[projects] Retry project agent failed for ${ctx.wid}/${ctx.pid}:`, { err });
  }
}

async function retryProjectProvisioning(ctx: ProjectCtx, res: Response): Promise<void> {
  await restoreInterruptedProductFields(ctx);
  const callerCtx = await retryMattermostContext(ctx, res);
  if (!callerCtx) return;

  const channelName = projectGeneralChannelName(ctx.wid, ctx.pid);
  const channel = await retryChannelId(ctx, res, callerCtx.teamId, channelName);
  if (!channel) return;

  const members = retryMembers(callerCtx);
  if (!(await addRetryMembersOrFail(ctx, res, channel.id, members))) return;
  await writeRetryGeneralChannel(ctx, channel.id);

  const visibility = restoredVisibility(ctx);
  if (!(await reconcileRetryRepoOrFail(ctx, res, visibility))) return;
  await activateRetriedProject(ctx, visibility);
  await provisionRetriedProjectAgent(ctx);

  logger.info(`[projects] Retry provisioning succeeded for ${ctx.wid}/${ctx.pid}`);
  res.json({ success: true, channelId: channel.id });
}

router.post("/:wid/:pid/retry-provisioning", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, {
    ownerOnly: true,
    requireActive: true,
    ownerErrorMessage: "Only the project owner can retry provisioning",
    logTag: "[projects] Retry provisioning crashed for",
    errorMessage: "Retry provisioning failed",
  }, async (ctx) => {
    if (!(await claimProjectRetry(ctx))) {
      res.status(409).json({ error: "Project setup is already running or no longer needs retrying." });
      return;
    }
    try {
      await retryProjectProvisioning(ctx, res);
    } catch (error) {
      await markRetryFailed(ctx, errorMessage(error));
      throw error;
    }
  });
});

export default router;
