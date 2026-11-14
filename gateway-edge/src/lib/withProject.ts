import type { Request, Response } from "express";
import type { Project } from "@octogee/shared/types/index";
import { userAccounts } from "./user-accounts.js";
import { readProject } from "./firestoreReads.js";
import { logger } from "../middleware/logging.js";
import { mapMattermostMembershipError } from "./channel-lifecycle.js";
import { isValidProjectId, USERNAME_RE } from "@octogee/shared/types/identity";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";

export type ProjectCtx = {
  projectPath: string;
  project: Project;
  uid: string;
  wid: string;
  pid: string;
};

export type WithProjectOptions = {
  ownerOnly?: boolean;
  ownerErrorMessage?: string;
  allowStates?: string[];
  requireActive?: boolean;
  logTag?: string;
  errorMessage?: string;
};

function invalidProjectIdentifier(wid: string, pid: string): boolean {
  return !USERNAME_RE.test(wid) || !isValidProjectId(pid);
}

function ownerForbidden(
  opts: WithProjectOptions,
  project: Project,
  uid: string | undefined,
): boolean {
  return opts.ownerOnly === true && project.ownerUid !== uid;
}

function stateForbidden(opts: WithProjectOptions, project: Project): boolean {
  return opts.allowStates !== undefined &&
    !opts.allowStates.includes(project.provisioningState);
}

export async function projectIsArchived(project: Project): Promise<boolean> {
  if (project.commercialLifecycle?.status === "archived") return true;
  const owner = await userAccounts().get(project.ownerUid);
  return userEntitlements().projectMode(owner?.planInputs ?? {}) !== "active";
}

function respondToHandlerError(res: Response, err: unknown, fallbackErrorMessage: string): void {
  if (res.headersSent) return;
  const mapped = mapMattermostMembershipError(err);
  res.status(mapped?.status ?? 500).json(mapped?.body ?? { error: fallbackErrorMessage });
}

// eslint-disable-next-line max-params -- Route wrapper API keeps call sites readable until route handlers are split.
export async function withProject(
  req: Request,
  res: Response,
  wid: string,
  pid: string,
  opts: WithProjectOptions,
  handler: (ctx: ProjectCtx) => Promise<void>,
): Promise<void> {
  const logTag = opts.logTag ?? "[projects]";
  try {
    if (invalidProjectIdentifier(wid, pid)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const project = await readProject(wid, pid);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (ownerForbidden(opts, project, req.uid)) {
      res.status(403).json({
        error:
          opts.ownerErrorMessage ??
          "Only the project owner can perform this action",
      });
      return;
    }

    if (stateForbidden(opts, project)) {
      res.status(409).json({
        error: `Project is not in a valid state for this action (current: ${project.provisioningState ?? "unknown"})`,
      });
      return;
    }

    if (opts.requireActive && await projectIsArchived(project)) {
      res.status(409).json({
        error: "Project is archived",
        code: "PROJECT_ARCHIVED",
      });
      return;
    }

    await handler({ projectPath: `workspaces/${wid}/projects/${pid}`, project, uid: req.uid!, wid, pid });
  } catch (err: unknown) {
    logger.error(`${logTag} ${wid}/${pid}:`, { err });
    respondToHandlerError(res, err, opts.errorMessage ?? "Operation failed");
  }
}
