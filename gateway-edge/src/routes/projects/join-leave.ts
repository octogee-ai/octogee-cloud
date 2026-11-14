import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { platformStateStore } from "../../lib/platform-state.js";
import { removeProjectMember, syncProjectMemberCount } from "../../lib/project-platform-state.js";
import { mmApi } from "../../lib/mattermost.js";
import { giteaApi } from "../../lib/gitea.js";
import { workspaceGiteaOrg, projectRepoName } from "@octogee/core/gitea-naming";
import { logger } from "../../middleware/logging.js";
import { getWorkspaceMmContext } from "../../lib/mattermost-context.js";
import { withProject, type ProjectCtx } from "../../lib/withProject.js";

const router = Router();

interface ProjectActor {
  mmUserId: string | undefined;
  giteaUser: string | null;
}

function errorIncludes(err: unknown, expected: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(expected);
}

async function readProjectActor(uid: string): Promise<ProjectActor> {
  const user = await platformStateStore.users.records.get(uid);
  return {
    mmUserId: user?.mattermostUserId ?? undefined,
    giteaUser: user?.slug ? `ws-${user.slug}` : null,
  };
}

function respondProjectPrivate(res: Response): void {
  res.status(403).json({ error: "This project is private. You need an invite to join." });
}

async function respondAlreadyMember(ctx: ProjectCtx, res: Response): Promise<void> {
  await syncProjectMemberCount(ctx.wid, ctx.pid);
  res.json({ success: true, alreadyMember: true });
}

async function projectJoinable(ctx: ProjectCtx, res: Response): Promise<boolean> {
  if (ctx.project.ownerUid === ctx.uid) {
    res.status(400).json({ error: "You already own this project" });
    return false;
  }

  if (ctx.project.visibility === "private") {
    respondProjectPrivate(res);
    return false;
  }

  if (await platformStateStore.workspaces.projectMembers.get(ctx.wid, ctx.pid, ctx.uid)) {
    await respondAlreadyMember(ctx, res);
    return false;
  }

  return true;
}

async function addMattermostTeamMember(
  teamId: string,
  mmUserId: string,
  res: Response,
): Promise<boolean> {
  try {
    await mmApi(`/teams/${teamId}/members/${mmUserId}`);
    return true;
  } catch {
    try {
      await mmApi(`/teams/${teamId}/members`, "POST", {
        team_id: teamId,
        user_id: mmUserId,
      });
      return true;
    } catch (addErr) {
      if (errorIncludes(addErr, "409")) return true;
      logger.error(`[projects] Failed to add user to MM team:`, { err: addErr });
      res.status(500).json({ error: "Failed to join project — could not add to chat team" });
      return false;
    }
  }
}

async function ensureProjectJoinerTeamMember(
  ctx: ProjectCtx,
  actor: ProjectActor,
  res: Response,
): Promise<boolean> {
  const ownerCtx = await getWorkspaceMmContext(ctx.project.ownerUid, ctx.wid);
  const teamId = ownerCtx?.teamId;
  if (!teamId || !actor.mmUserId) {
    res.status(422).json({ error: "Project chat membership is not provisioned" });
    return false;
  }
  return addMattermostTeamMember(teamId, actor.mmUserId, res);
}

type ProjectJoinCommit = "joined" | "already-member" | "not-joinable";

async function commitProjectJoin(ctx: ProjectCtx): Promise<ProjectJoinCommit> {
  return platformStateStore.transaction({ label: "project.join" }, async (tx) => {
    const { projects, projectMembers } = tx.workspaces;
    const project = await projects.get(ctx.wid, ctx.pid);
    if (!project || project.visibility === "private") return "not-joinable";
    if (await projectMembers.get(ctx.wid, ctx.pid, ctx.uid)) return "already-member";
    await projectMembers.put({
      workspaceSlug: ctx.wid,
      projectSlug: ctx.pid,
      uid: ctx.uid,
      role: "member",
      joinedAt: { serverNow: true },
    });
    await projects.patch(ctx.wid, ctx.pid, { updatedAt: { serverNow: true } });
    return "joined";
  });
}

async function grantProjectGiteaAccess(ctx: ProjectCtx, actor: ProjectActor): Promise<void> {
  if (!ctx.project.giteaRepoName || !actor.giteaUser) return;
  try {
    await giteaApi(
      workspaceGiteaOrg(ctx.wid),
      `${projectRepoName(ctx.pid)}/collaborators/${actor.giteaUser}`,
      "PUT",
      { permission: "read" },
    );
  } catch (err) {
    logger.warn(`[projects] Gitea access grant failed:`, { err });
  }
}

async function joinProject(ctx: ProjectCtx, res: Response): Promise<void> {
  if (!(await projectJoinable(ctx, res))) return;

  const actor = await readProjectActor(ctx.uid);
  const { addChannelMember, ensureActiveMattermostUser, removeChannelMember } = await import("../../lib/channel-lifecycle.js");
  if (actor.mmUserId) await ensureActiveMattermostUser(actor.mmUserId);
  if (!(await ensureProjectJoinerTeamMember(ctx, actor, res))) return;

  const channelPath = `${ctx.projectPath}/channels/general`;
  await addChannelMember(channelPath, actor.mmUserId!);
  const commit = await commitProjectJoin(ctx);
  if (commit === "not-joinable") {
    await removeChannelMember(channelPath, actor.mmUserId!);
    respondProjectPrivate(res);
    return;
  }
  if (commit === "already-member") {
    await respondAlreadyMember(ctx, res);
    return;
  }
  await syncProjectMemberCount(ctx.wid, ctx.pid);
  await grantProjectGiteaAccess(ctx, actor);

  logger.info(`[projects] ${ctx.uid} joined ${ctx.wid}/${ctx.pid}`);
  res.json({ success: true });
}

router.post("/:wid/:pid/join", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, {
    requireActive: true,
    logTag: "[projects] Join failed for",
    errorMessage: "Failed to join project",
  }, async (ctx) => joinProject(ctx, res));
});

async function projectLeavable(ctx: ProjectCtx, res: Response): Promise<boolean> {
  if (ctx.project.ownerUid === ctx.uid) {
    res.status(400).json({ error: "You cannot leave your own project" });
    return false;
  }

  if (!(await platformStateStore.workspaces.projectMembers.get(ctx.wid, ctx.pid, ctx.uid))) {
    await syncProjectMemberCount(ctx.wid, ctx.pid);
    res.json({ success: true, notAMember: true });
    return false;
  }

  return true;
}

async function revokeProjectGiteaAccess(ctx: ProjectCtx, actor: ProjectActor): Promise<void> {
  if (!ctx.project.giteaRepoName || !actor.giteaUser) return;
  try {
    await giteaApi(
      workspaceGiteaOrg(ctx.wid),
      `${projectRepoName(ctx.pid)}/collaborators/${actor.giteaUser}`,
      "DELETE",
    );
  } catch (err) {
    logger.warn(`[projects] Gitea leave failed:`, { err });
  }
}

async function leaveProject(ctx: ProjectCtx, res: Response): Promise<void> {
  if (!(await projectLeavable(ctx, res))) return;

  const actor = await readProjectActor(ctx.uid);
  if (actor.mmUserId) {
    const { removeChannelMember } = await import("../../lib/channel-lifecycle.js");
    await removeChannelMember(`${ctx.projectPath}/channels/general`, actor.mmUserId);
  }
  await removeProjectMember(ctx.wid, ctx.pid, ctx.uid);
  await revokeProjectGiteaAccess(ctx, actor);

  logger.info(`[projects] ${ctx.uid} left ${ctx.wid}/${ctx.pid}`);
  res.json({ success: true });
}

router.post("/:wid/:pid/leave", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, {
    logTag: "[projects] Leave failed for",
    errorMessage: "Failed to leave project",
  }, async (ctx) => leaveProject(ctx, res));
});

export default router;
