import { clientRequestLimit } from "../http/authenticated-request-limit.js";
import { PROJECT_AGENT_WORKSPACE_PARTS } from "@octogee/shared/types/project";
import { Router, type Request, type Response } from "express";
import {
  resolveUserDir,
  resolveProjectDir,
  commitAndPushWorkspace,
  isTrustedGithubUserCheckout,
  isGithubProjectCheckpoint,
  isSafeSlug,
  type WorkspaceGitError,
} from "../workspace/workspace-git.js";
import { isValidProjectId } from "@octogee/shared/types/identity";
import { resolveCommitAuthor } from "../workspace/route-helpers.js";
import { logger } from "../http/logging.js";
import { verifyWorkspaceCommitProofViaBroker } from "../internal-brokers/workspace-commit-proof-broker.js";
import { divertWorktreeBinaries } from "../workspace/binary-diversion.js";
import type { WorkspaceBlobTarget } from "../workspace/workspace-blob.js";

const router: Router = Router();

const DEFAULT_MESSAGE = "agent: workspace commit";
const MAX_MESSAGE_LEN = 5_000;

function usersRoot(): string {
  return process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers";
}

function blobTarget(slug: string, project: string | null): WorkspaceBlobTarget {
  return {
    slug,
    projectSlug: project,
    gcsPrefix: project ? `customers/${slug}/projects/${project}` : `customers/${slug}`,
  };
}

async function divertBinaries(
  dir: string,
  slug: string,
  project: string | null,
): Promise<{ diverted: Array<{ path: string; size: number }>; failures: string[]; failedPaths: string[] }> {
  return project
    ? divertWorktreeBinaries(dir, blobTarget(slug, project), undefined, { retainLocalFiles: true })
    : divertWorktreeBinaries(dir, blobTarget(slug, project), undefined, { excludePaths: [PROJECT_AGENT_WORKSPACE_PARTS.join("/")] });
}

function gitErrorDetail(error: WorkspaceGitError): string {
  switch (error.code) {
    case "GIT_FAILED":
      return ` status=${error.status} stderr=${error.stderr}`;
    case "TIMEOUT":
      return ` durationMs=${error.durationMs}`;
    case "OUTPUT_TOO_LARGE":
      return ` cap=${error.cap}`;
    case "INTERNAL":
      return ` message=${error.message}`;
    default:
      return "";
  }
}

type CommitRequest = { agentId: string; slug: string; project: string | null; message: string };
type CommitRequestError = { status: number; error: string; code: string };

function parseCommitRequest(
  body: Record<string, unknown> | undefined,
): CommitRequest | CommitRequestError {
  const slug = typeof body?.slug === "string" ? body.slug : "";
  if (!isSafeSlug(slug)) return { status: 400, error: "Invalid slug", code: "BAD_SLUG" };
  const agentId = typeof body?.agentId === "string" ? body.agentId : "";
  if (!agentId) return { status: 400, error: "Invalid agent identity", code: "BAD_AGENT" };
  const project = typeof body?.project === "string" ? body.project : null;
  if (project !== null && !isValidProjectId(project)) {
    return { status: 400, error: "Invalid project", code: "BAD_PROJECT" };
  }
  const raw = typeof body?.message === "string" ? body.message.trim() : "";
  if (raw.length > MAX_MESSAGE_LEN) {
    return { status: 400, error: "Commit message too long", code: "MESSAGE_TOO_LONG" };
  }
  return { agentId, slug, project, message: raw || DEFAULT_MESSAGE };
}

router.post("/commit", clientRequestLimit(1200, true), async (req: Request, res: Response) => {
  const parsed = parseCommitRequest(req.body as Record<string, unknown> | undefined);
  if ("code" in parsed) {
    res.status(parsed.status).json({ error: parsed.error, code: parsed.code });
    return;
  }
  const { agentId, slug, project, message } = parsed;

  let authorized: boolean;
  try {
    authorized = await verifyWorkspaceCommitProofViaBroker(req, { agentId, slug, project });
  } catch (error) {
    logger.warn(
      `internal/workspace/commit: identity proof lookup failed slug=${slug}: ${error instanceof Error ? error.message : String(error)}`,
    );
    res.status(503).json({ error: "Agent identity verification temporarily unavailable.", code: "PROOF_UNAVAILABLE" });
    return;
  }
  if (!authorized) {
    logger.warn(`internal/workspace/commit: rejected agent identity proof slug=${slug}`);
    res.status(403).json({ error: "Agent identity proof rejected.", code: "PROOF_REJECTED" });
    return;
  }

  const start = Date.now();
  const customerDir = await resolveUserDir(usersRoot(), slug);
  if (!customerDir) {
    logger.warn(`internal/workspace/commit: working tree not accessible slug=${slug}`);
    res.status(503).json({
      error: "Working tree temporarily unavailable; retry shortly.",
      code: "CUSTOMER_DIR_MISSING",
    });
    return;
  }
  // Project agents commit their project clone ONLY; the lane comes from the
  // tool's identity-derived request, and a missing clone must fail loudly
  // rather than fall back to the workspace repo.
  let dir = customerDir;
  if (project) {
    const projectDir = await resolveProjectDir(usersRoot(), slug, project);
    if (!projectDir) {
      logger.warn(`internal/workspace/commit: project clone missing slug=${slug} project=${project}`);
      res.status(503).json({
        error: "Project working tree temporarily unavailable; retry shortly.",
        code: "PROJECT_DIR_MISSING",
      });
      return;
    }
    dir = projectDir;
  }

  const author = resolveCommitAuthor(undefined, slug);
  const githubProject = isTrustedGithubUserCheckout(dir) || isGithubProjectCheckpoint(dir);

  let divertedBlobs = 0;
  const r = await commitAndPushWorkspace(dir, {
    message,
    author,
    beforeCommit: async () => {
      if (githubProject) return { ok: true };
      const diverted = await divertBinaries(dir, slug, project);
      if (diverted.failures.length > 0) {
        return {
          ok: false,
          error: {
            code: "BLOB_DIVERSION_FAILED" as const,
            cwd: dir,
            paths: diverted.failedPaths,
          },
        };
      }
      divertedBlobs = diverted.diverted.length;
      return { ok: true, ...(project ? { excludePaths: diverted.diverted.map(blob => blob.path) } : {}) };
    },
  });
  if (!r.ok) {
    if (r.error.code === "BLOB_DIVERSION_FAILED") {
      res.status(503).json({
        error: "Binary files could not be stored; no commit was created.",
        code: r.error.code,
        paths: r.error.paths,
      });
      return;
    }
    logger.warn(
      `internal/workspace/commit: git error slug=${slug} code=${r.error.code}${gitErrorDetail(r.error)}`,
    );
    if (r.error.code === "WORKSPACE_BUSY") {
      res.status(409).json({ error: "Workspace is busy; retry shortly.", code: r.error.code });
      return;
    }
    res.status(500).json({ error: "git command failed", code: r.error.code });
    return;
  }
  if (r.result.pushError) {
    logger.warn(`internal/workspace/commit: committed but push failed slug=${slug}: ${r.result.pushError}`);
    res.status(502).json({
      error: "Commit was created locally, but the remote rejected the push. Do not build or publish until a later commit succeeds.",
      code: "PUSH_FAILED",
      committed: r.result.committed,
      pushed: false,
      nothingToCommit: r.result.nothingToCommit,
    });
    return;
  }
  const laneSuffix = project ? ` project=${project}` : "";
  logger.info(
    `internal/workspace/commit slug=${slug}${laneSuffix} committed=${r.result.committed} pushed=${r.result.pushed} nothing=${r.result.nothingToCommit} dur=${Date.now() - start}ms`,
  );
  res.json({
    committed: r.result.committed,
    pushed: r.result.pushed,
    nothingToCommit: r.result.nothingToCommit,
    commit: r.result.commit,
    divertedBlobs,
  });
});

export default router;
