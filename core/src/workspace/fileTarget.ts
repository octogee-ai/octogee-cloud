import type { Request, Response, NextFunction, RequestHandler } from "express";
import { requestBlobStore, type BlobStore } from "./blob-store.js";
import { userAccounts } from "../identity/user-accounts.js";
import { readProject } from "./firestoreReads.js";
import { platformStateStore } from "../identity/platform-state-store.js";
import { githubCheckpointBranch, githubCheckpointRepo, projectRepoSourceFromDoc } from "@octogee/shared/types/project";
import { USERNAME_RE } from "@octogee/shared/types/identity";
import { readConnectorAccessToken } from "../connectors/connector-tokens.js";
import { workspaceGiteaOrg, workspaceRepoName, projectRepoName } from "../gitea-naming.js";
import { logger } from "../http/logging.js";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { isCanonicalWorkspaceMembership } from "../gateway-principal-access.js";

export interface FileTarget {
  slug: string;
  projectSlug: string | null;
  provider: "gitea" | "github";

  org: string;

  repoName: string;
  gcsPrefix: string;
  blobStore?: BlobStore;
  githubToken?: string;
  cacheAuthority?: string;
  checkpointBranch?: string;
  // Gitea: the username to impersonate via admin Sudo (no per-user PAT). The caller's
  // own gitea identity where they hold real ACL (owner / project collaborator), or the
  // workspace owner's when brokering for a workspace member who has no repo access.
  sudoUser?: string;
  // Writes restricted to the knowledge-store allowlist (notes/* + canvasFile): true for
  // workspace members (brokered as the owner) and all GitHub targets; false for the
  // owner / project collaborators who get unrestricted write.
  brokered?: boolean;
  workspaceMemberBrokered?: boolean;
  canvasFile?: string;
}

export interface FileTargetInput {
  slug: string | null | undefined;
  projectSlug: string | null | undefined;
  callerUid: string | undefined;
  callerWorkspaceSlug: string | null | undefined;
}

export type FileTargetResult =
  | { ok: true; target: FileTarget }
  | { ok: false; status: 400 | 403 | 404 | 409 | 422; error: string; reason?: string };

export interface ResolveFileTargetOpts {
  resolveGithubToken?: boolean;
  allowWorkspaceMembers?: boolean;
  access?: "read" | "write";
  useProjectCheckpoint?: boolean;
}

export async function resolveFileTarget(
  input: FileTargetInput,
  opts: ResolveFileTargetOpts = {},
): Promise<FileTargetResult> {
  const { slug, projectSlug, callerUid, callerWorkspaceSlug } = input;

  if (!slug) {
    return { ok: false, status: 400, error: "Missing slug" };
  }

  if (projectSlug) {
    return resolveProjectTarget({ ...input, projectSlug, slug }, opts);
  }

  return resolveWorkspaceTarget(slug, callerUid, callerWorkspaceSlug, opts);
}

async function resolveProjectTarget(
  input: FileTargetInput & { slug: string; projectSlug: string },
  opts: ResolveFileTargetOpts,
): Promise<FileTargetResult> {
  const { slug, projectSlug, callerUid, callerWorkspaceSlug } = input;
  const project = await readProject(slug, projectSlug);
  if (!project) {
    return { ok: false, status: 404, error: "Project not found" };
  }
  const isOwner = project.ownerUid === callerUid;
  const isMember = !isOwner && callerUid
    ? (await platformStateStore.workspaces.projectMembers.get(slug, projectSlug, callerUid)) !== null
    : false;
  if (!isOwner && !isMember) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  if (opts.access === "write" && await projectMutationIsBlocked(project)) {
    return {
      ok: false,
      status: 409,
      error: "Project is archived",
      reason: "project_archived",
    };
  }
  const github = projectRepoSourceFromDoc(project.repoSource);
  if (opts.useProjectCheckpoint && github?.workingCopy?.ready) {
    if (!isOwner) return { ok: false, status: 403, error: "Private project checkpoint is only available to its owner" };
    const repoName = githubCheckpointRepo(github.workingCopy.id);
    return {
      ok: true,
      target: {
        ...giteaProjectTarget(slug, projectSlug, slug, project.canvasFile),
        repoName,
        checkpointBranch: githubCheckpointBranch(repoName)!,
        cacheAuthority: callerUid,
      },
    };
  }
  if (github) {
    return resolveGithubProjectTarget({
      callerUid,
      github,
      project,
      projectSlug,
      resolveGithubToken: opts.resolveGithubToken ?? true,
      slug,
    });
  }
  return {
    ok: true,
    target: giteaProjectTarget(slug, projectSlug, callerWorkspaceSlug, project.canvasFile),
  };
}

async function projectMutationIsBlocked(
  project: { ownerUid: string; commercialLifecycle?: { status?: unknown } },
): Promise<boolean> {
  if (project.commercialLifecycle?.status === "archived") return true;
  const owner = await userAccounts().get(project.ownerUid);
  return userEntitlements().projectMode(owner?.planInputs ?? {}) !== "active";
}

function giteaProjectTarget(
  slug: string,
  projectSlug: string,
  callerWorkspaceSlug: string | null | undefined,
  canvasFile: string | undefined,
): FileTarget {
  return {
    slug,
    projectSlug,
    provider: "gitea",
    org: workspaceGiteaOrg(slug),
    repoName: projectRepoName(projectSlug),
    gcsPrefix: `customers/${slug}/projects/${projectSlug}`,
    sudoUser: `ws-${callerWorkspaceSlug ?? slug}`,
    brokered: false,
    canvasFile,
  };
}

async function resolveGithubProjectTarget(args: {
  callerUid: string | undefined;
  github: { owner: string; repo: string };
  project: { ownerUid: string; canvasFile?: string };
  projectSlug: string;
  resolveGithubToken: boolean;
  slug: string;
}): Promise<FileTargetResult> {
  const { callerUid, github, project, projectSlug, resolveGithubToken, slug } = args;
  const githubTarget: FileTarget = {
    slug,
    projectSlug,
    provider: "github",
    org: github.owner,
    repoName: github.repo,
    gcsPrefix: `customers/${slug}/projects/${projectSlug}`,
    canvasFile: project.canvasFile,
    ...(callerUid ? { cacheAuthority: callerUid } : {}),
  };
  if (!resolveGithubToken) {
    return { ok: true, target: githubTarget };
  }
  const githubToken = await readConnectorAccessToken(callerUid!, "github", {
    kind: "project",
    requestingUid: callerUid!,
    workspaceSlug: slug,
    projectSlug,
  });
  if (!githubToken) {
    const isOwner = callerUid === project.ownerUid;
    return {
      ok: false,
      status: 422,
      error: isOwner ? "GitHub files unavailable" : "Connect GitHub to access this project",
      reason: isOwner ? "owner_github_not_connected" : "caller_github_not_connected",
    };
  }
  logger.info(
    `[fileTarget] caller-bound github token repo=${github.owner}/${github.repo} caller=${callerUid}`,
  );
  return { ok: true, target: { ...githubTarget, githubToken, brokered: true } };
}

async function resolveWorkspaceTarget(
  slug: string,
  callerUid: string | undefined,
  callerWorkspaceSlug: string | null | undefined,
  opts: ResolveFileTargetOpts,
): Promise<FileTargetResult> {
  const workspaceTarget: FileTarget = {
    slug,
    projectSlug: null,
    provider: "gitea",
    org: workspaceGiteaOrg(slug),
    repoName: workspaceRepoName(),
    gcsPrefix: `customers/${slug}`,
    sudoUser: `ws-${slug}`,
    brokered: false,
    canvasFile: "README.md",
  };

  if (callerWorkspaceSlug === slug) {
    return { ok: true, target: workspaceTarget };
  }
  if (!opts.allowWorkspaceMembers || !callerUid) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return resolveWorkspaceMemberTarget(workspaceTarget, slug, callerUid);
}

// Workspace members have no direct ACL on the workspace repo (no collaborator wiring —
// only projects get that). We broker: impersonate the workspace OWNER (ws-${slug}) and
// cap writes to the knowledge-store allowlist (brokered=true). No owner PAT to read,
// so the old owner_gitea_not_provisioned failure mode is gone — the admin token always
// backs the Sudo.
async function resolveWorkspaceMemberTarget(
  workspaceTarget: FileTarget,
  slug: string,
  callerUid: string,
): Promise<FileTargetResult> {
  if (!USERNAME_RE.test(slug)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const member = await platformStateStore.workspaces.members.get(slug, callerUid);
  if (member === null || !isCanonicalWorkspaceMembership(member)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  logger.info(`[fileTarget] brokered gitea sudo workspace=${slug} caller=${callerUid} as=ws-${slug}`);
  return {
    ok: true,
    target: { ...workspaceTarget, brokered: true, workspaceMemberBrokered: true },
  };
}

function readTargetInput(req: Request): { slug: string | null; projectSlug: string | null } {
  const slug = ((req.query.slug as string) || (req.body?.slug as string) || null) as string | null;
  const projectSlug = ((req.query.project as string) || (req.body?.project as string) || null) as string | null;
  return { slug, projectSlug };
}

export type TargetedHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  target: FileTarget,
) => Promise<void>;

export function withFileTarget(
  handler: TargetedHandler,
  opts?: ResolveFileTargetOpts,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const { slug, projectSlug } = readTargetInput(req);
      const result = await resolveFileTarget(
        {
          slug,
          projectSlug,
          callerUid: req.uid,
          callerWorkspaceSlug: req.workspaceSlug,
        },
        opts,
      );
      if (!result.ok) {
        res
          .status(result.status)
          .json({ error: result.error, ...(result.reason ? { reason: result.reason } : {}) });
        return;
      }
      if (result.target.provider === "gitea") {
        const blobStore = requestBlobStore(req);
        if (blobStore) result.target.blobStore = blobStore;
      }
      await handler(req, res, next, result.target);
    } catch (e) {
      next(e);
    }
  };
}

export function withGiteaTarget(
  handler: TargetedHandler,
  opts: ResolveFileTargetOpts = {},
): RequestHandler {
  return withFileTarget(
    async (req, res, next, target) => {
      if (target.provider !== "gitea") {
        res.status(409).json({
          error: "Not available for GitHub-backed projects",
          code: "GITHUB_READ_ONLY",
        });
        return;
      }
      await handler(req, res, next, target);
    },
    { ...opts, resolveGithubToken: false },
  );
}
