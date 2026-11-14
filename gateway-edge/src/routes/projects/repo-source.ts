import { Router, type Request, type Response } from "express";
import {
  featureFlagBypassedForAdmin,
  type FeatureDecision,
  type FeaturePolicy,
  type FeatureSubject,
} from "@octogee/shared/types/feature-flags";
import type { ProjectRepoSource } from "@octogee/shared/types/index";
import { strictRateLimit } from "../../middleware/security.js";
import { platformStateStore } from "../../lib/platform-state.js";
import { logger } from "../../middleware/logging.js";
import { withProject } from "../../lib/withProject.js";
import {
  ConnectorTokenReadError,
  readConnectorAccessToken,
} from "../../lib/connector-tokens.js";
import {
  githubRepoApi,
  isValidGithubRepoSource,
  parseGithubRepoUrl,
  type GithubRepoSource,
} from "../../lib/github.js";

const PROJECT_REPO_SOURCE_FLAG = "release-project-repo-source" as const;

export type RepoSourceAccess = FeatureDecision["state"];

const REPO_SOURCE_DISABLED = "GitHub-backed projects are not enabled for this account";
const INVALID_REPO_SOURCE =
  "Invalid repoSource (expected { provider: 'github', owner, repo }, a github.com repo URL, or null)";

// GitHub answers 404 for a repo the token cannot see and 403 when it can see
// the repo but is barred from it; both mean "not yours to connect". Anything
// else is GitHub failing, not the caller being wrong, and must not be dressed
// up as a missing repo.
const UNREACHABLE_GITHUB_ERRORS = new Set(["GitHub API 404", "GitHub API 403"]);

function featureSubject(req: Request): FeatureSubject {
  return {
    uid: req.uid!,
    isAdmin: req.isAdmin === true,
    ...(typeof req.workspaceSlug === "string" ? { workspaceSlug: req.workspaceSlug } : {}),
  };
}

export async function projectRepoSourceAccess(
  featurePolicy: FeaturePolicy | undefined,
  req: Request,
  context: string,
): Promise<RepoSourceAccess> {
  if (
    typeof req.workspaceSlug !== "string"
    || !(await isolatedGatewayAssigned(req, req.uid!, req.workspaceSlug))
  ) return "disabled";
  const subject = featureSubject(req);
  if (featureFlagBypassedForAdmin(PROJECT_REPO_SOURCE_FLAG, subject)) return "enabled";
  if (!featurePolicy) return "disabled";
  const decision = await featurePolicy.evaluate(PROJECT_REPO_SOURCE_FLAG, subject, context);
  return decision.state;
}

function respondRepoSourceDenied(res: Response, access: RepoSourceAccess): void {
  if (access === "unavailable") {
    res.status(503).json({ error: "feature_evaluation_unavailable" });
    return;
  }
  res.status(403).json({ error: REPO_SOURCE_DISABLED });
}

type RequestedRepoSource =
  | { ok: true; value: GithubRepoSource | null }
  | { ok: false; error: string };

function requestedRepoSource(body: unknown): RequestedRepoSource {
  if (!body || typeof body !== "object" || !("repoSource" in body)) {
    return { ok: false, error: "repoSource is required (null disconnects)" };
  }
  const requested = (body as { repoSource: unknown }).repoSource;
  if (requested === null) return { ok: true, value: null };

  const candidate = typeof requested === "string" ? parseGithubRepoUrl(requested) : requested;
  if (!isValidGithubRepoSource(candidate)) return { ok: false, error: INVALID_REPO_SOURCE };
  return { ok: true, value: candidate };
}

function assignedGatewayId(req: Request): string | null {
  const user = req.user as Record<string, unknown> | undefined;
  const provisioning = user?.provisioning;
  if (!provisioning || typeof provisioning !== "object") return null;
  const openclaw = (provisioning as Record<string, unknown>).openclaw;
  if (!openclaw || typeof openclaw !== "object") return null;
  const gatewayId = (openclaw as Record<string, unknown>).gatewayId;
  return typeof gatewayId === "string" && gatewayId.length > 0 ? gatewayId : null;
}

async function isolatedGatewayAssigned(
  req: Request,
  uid: string,
  workspaceSlug: string,
): Promise<boolean> {
  const gatewayId = assignedGatewayId(req);
  if (!gatewayId || gatewayId.includes("/")) return false;
  const gateway = await platformStateStore.gateways.roots.get(gatewayId);
  return gateway?.gatewayClass === "isolated"
    && gateway.ownerUid === uid
    && gateway.builderSlug === workspaceSlug;
}

export type RepoReachability =
  | { ok: true }
  | { ok: false; status: number; error: string; reason: string };

export async function proveRepoReachable(
  uid: string,
  workspaceSlug: string,
  repoSource: GithubRepoSource,
): Promise<RepoReachability> {
  let token: string | null;
  try {
    token = await readConnectorAccessToken(uid, "github", {
      kind: "owner-runtime",
      builderSlug: workspaceSlug,
    });
  } catch (error) {
    if (error instanceof ConnectorTokenReadError && error.errorCode === "reauth_required") {
      return {
        ok: false,
        status: 409,
        error: "Reconnect GitHub before connecting this repository",
        reason: "github_reauth_required",
      };
    }
    throw error;
  }
  if (!token) {
    return {
      ok: false,
      status: 422,
      error: "GitHub not connected",
      reason: "github_not_connected",
    };
  }

  try {
    await githubRepoApi(repoSource.owner, repoSource.repo, token);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!UNREACHABLE_GITHUB_ERRORS.has(message)) throw err;
    logger.warn(
      `[repo-source] ${repoSource.owner}/${repoSource.repo} is not reachable with the caller's GitHub token`,
      { uid, message },
    );
    return {
      ok: false,
      status: 404,
      error: "That repo does not exist or your GitHub account cannot see it",
      reason: "repo_not_found_or_no_access",
    };
  }
}

function repoSourceLabel(repoSource: ProjectRepoSource | GithubRepoSource | null | undefined): string {
  return repoSource?.provider === "github"
    ? `github:${repoSource.owner}/${repoSource.repo}`
    : "gitea";
}

export function createProjectRepoSourceRoutes(
  { featurePolicy }: { featurePolicy?: FeaturePolicy } = {},
): Router {
  const router = Router();

  router.patch("/:wid/:pid/repo-source", strictRateLimit, async (req: Request, res: Response) => {
    const { wid, pid } = req.params as { wid: string; pid: string };

    await withProject(req, res, wid, pid, {
      ownerOnly: true,
      requireActive: true,
      ownerErrorMessage: "Only the project owner can change the connected repo",
      logTag: "[repo-source] crashed for",
      errorMessage: "Could not update the connected repo",
    }, async ({ projectRef, project, uid }) => {
      const requested = requestedRepoSource(req.body);
      if (!requested.ok) {
        res.status(400).json({ error: requested.error });
        return;
      }

      if (requested.value) {
        const access = await projectRepoSourceAccess(featurePolicy, req, "projects-repo-source");
        if (access !== "enabled") {
          respondRepoSourceDenied(res, access);
          return;
        }
        const reachable = await proveRepoReachable(uid, wid, requested.value);
        if (!reachable.ok) {
          res.status(reachable.status).json({ error: reachable.error, reason: reachable.reason });
          return;
        }
      }

      await platformStateStore.workspaces.projects.patch(wid, pid, {
        repoSource: requested.value ? { ...requested.value } : null,
        updatedAt: { serverNow: true },
      });

      logger.info(
        `[repo-source] ${projectRef.path}: ${repoSourceLabel(project.repoSource)} → ${repoSourceLabel(requested.value)}`,
        { uid },
      );
      res.json({ success: true, repoSource: requested.value });
    });
  });

  return router;
}

export default createProjectRepoSourceRoutes();
