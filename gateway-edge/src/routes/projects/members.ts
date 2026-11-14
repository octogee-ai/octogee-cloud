import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { platformStateStore } from "../../lib/platform-state.js";
import { removeProjectMember, syncProjectMemberCount } from "../../lib/project-platform-state.js";
import { giteaApi } from "../../lib/gitea.js";
import { workspaceGiteaOrg, projectRepoName } from "@octogee/core/gitea-naming";
import { logger } from "../../middleware/logging.js";
import { withProject, type ProjectCtx } from "../../lib/withProject.js";

const router = Router();

interface GuestActor {
  mmUserId: string | undefined;
  giteaUser: string | null;
}

async function guestRemovable(ctx: ProjectCtx, guestUid: string, res: Response): Promise<boolean> {
  if (guestUid === ctx.project.ownerUid) {
    res.status(400).json({ error: "Cannot remove the project owner" });
    return false;
  }

  if (!(await platformStateStore.workspaces.projectMembers.get(ctx.wid, ctx.pid, guestUid))) {
    await syncProjectMemberCount(ctx.wid, ctx.pid);
    res.json({ success: true, notAMember: true });
    return false;
  }

  return true;
}

async function readGuestActor(guestUid: string): Promise<GuestActor> {
  const user = await platformStateStore.users.records.get(guestUid);
  return {
    mmUserId: user?.mattermostUserId ?? undefined,
    giteaUser: user?.slug ? `ws-${user.slug}` : null,
  };
}

async function revokeGuestGiteaAccess(ctx: ProjectCtx, guest: GuestActor): Promise<void> {
  if (!ctx.project.giteaRepoName || !guest.giteaUser) return;
  try {
    await giteaApi(
      workspaceGiteaOrg(ctx.wid),
      `${projectRepoName(ctx.pid)}/collaborators/${guest.giteaUser}`,
      "DELETE",
    );
  } catch (err) {
    logger.warn(`[projects] Gitea removal failed:`, { err });
  }
}

async function removeProjectGuest(ctx: ProjectCtx, guestUid: string, res: Response): Promise<void> {
  if (!(await guestRemovable(ctx, guestUid, res))) return;

  const guest = await readGuestActor(guestUid);
  if (guest.mmUserId) {
    const { removeChannelMember } = await import("../../lib/channel-lifecycle.js");
    await removeChannelMember(`${ctx.projectRef.path}/channels/general`, guest.mmUserId);
  }
  await removeProjectMember(ctx.wid, ctx.pid, guestUid);
  await revokeGuestGiteaAccess(ctx, guest);

  logger.info(`[projects] ${ctx.uid} removed ${guestUid} from ${ctx.wid}/${ctx.pid}`);
  res.json({ success: true });
}

router.delete("/:wid/:pid/members/:guestUid", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid, guestUid } = req.params as { wid: string; pid: string; guestUid: string };
  await withProject(req, res, wid, pid, {
    ownerOnly: true,
    ownerErrorMessage: "Only the project owner can remove guests",
    logTag: "[projects] Remove guest failed for",
    errorMessage: "Failed to remove guest",
  }, async (ctx) => removeProjectGuest(ctx, guestUid, res));
});

export default router;
