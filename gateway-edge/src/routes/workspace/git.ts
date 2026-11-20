import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import * as path from "node:path";
import {
  authorizeWorkspaceGit,
  type WorkspaceGitAuthorization,
  type WorkspaceGitAuthorizationOutcome,
  type WorkspaceGitAuthorizationRequest,
  type WorkspaceGitLane,
} from "@octogee/core/internal-brokers/workspace-git-authorization-broker";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCommitDiff,
  gitDiff,
  gitLog,
  gitPush,
  gitStatus,
  resolveUserDir,
  resolveProjectDir,
  runWorkspaceGitMutation,
  type WorkspaceGitError,
} from "@octogee/core/workspace/workspace-git";
import { logger } from "@octogee/core/http/logging";
import { DEFAULT_RATE_LIMIT_OPTIONS } from "@octogee/core/http/security";

export interface WorkspaceGitRouterDeps {
  authorize(request: WorkspaceGitAuthorizationRequest): Promise<WorkspaceGitAuthorizationOutcome>;
  localGatewayId(): string | null;
}

const GIT_LANE_READ: WorkspaceGitLane = { access: "read", resolveGithubToken: false };
const GIT_LANE_WRITE: WorkspaceGitLane = { access: "write", resolveGithubToken: false };
const GIT_LANE_REMOTE_WRITE: WorkspaceGitLane = { access: "write", resolveGithubToken: true };

type AuthorizedHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
  target: WorkspaceGitAuthorization,
) => Promise<void>;

type GitLocals = { gitAuthorization: WorkspaceGitAuthorization };

function usersRoot(): string {
  return process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers";
}

async function resolveTargetDir(
  root: string,
  target: WorkspaceGitAuthorization,
): Promise<string | null> {
  if (target.projectSlug) {
    return resolveProjectDir(root, target.slug, target.projectSlug);
  }
  return resolveUserDir(root, target.slug);
}

function requestedGatewayId(req: Request): string | null {
  const raw = (req.params as { gatewayId?: unknown }).gatewayId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function requestedField(req: Request, key: string): string | null {
  const query = req.query as Record<string, unknown>;
  if (typeof query[key] === "string" && query[key]) return query[key] as string;
  const body = (req.body ?? {}) as Record<string, unknown>;
  return typeof body[key] === "string" && body[key] ? body[key] as string : null;
}

function requestedTarget(req: Request): { slug: string | null; projectSlug: string | null } {
  return { slug: requestedField(req, "slug"), projectSlug: requestedField(req, "project") };
}

function respondDenied(res: Response, outcome: Exclude<WorkspaceGitAuthorizationOutcome, { kind: "authorized" }>): void {
  if (outcome.kind === "unauthenticated") {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  res.status(outcome.status).json({
    error: outcome.error,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  });
}

function requireGitAuthorization(
  deps: WorkspaceGitRouterDeps,
  lane: WorkspaceGitLane,
) {
  return async (req: Request, res: Response<unknown, GitLocals>, next: NextFunction) => {
    try {
      const authorization = req.headers.authorization;
      if (!authorization?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Unauthenticated" });
        return;
      }
      const gatewayId = deps.localGatewayId();
      if (!gatewayId || requestedGatewayId(req) !== gatewayId) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const { slug, projectSlug } = requestedTarget(req);
      if (!slug) {
        res.status(400).json({ error: "Missing slug" });
        return;
      }
      let outcome: WorkspaceGitAuthorizationOutcome;
      try {
        outcome = await deps.authorize({ gatewayId, authorization, slug, projectSlug, lane });
      } catch (error) {
        logger.warn("workspace-git: authorization broker unavailable", {
          gatewayId,
          slug,
          projectSlug,
          message: (error as Error).message,
        });
        res.status(503).json({ error: "Authorization unavailable", code: "AUTH_BROKER_UNAVAILABLE" });
        return;
      }
      if (outcome.kind !== "authorized") {
        respondDenied(res, outcome);
        return;
      }
      res.locals.gitAuthorization = outcome.authorization;
      next();
    } catch (error) {
      next(error);
    }
  };
}

const MAX_CONCURRENT_PER_SLUG = 4;
const concurrencyBySlug = new Map<string, number>();

function acquireSlot(slug: string): boolean {
  const inflight = concurrencyBySlug.get(slug) ?? 0;
  if (inflight >= MAX_CONCURRENT_PER_SLUG) return false;
  concurrencyBySlug.set(slug, inflight + 1);
  return true;
}

function releaseSlot(slug: string): void {
  const inflight = concurrencyBySlug.get(slug) ?? 0;
  if (inflight <= 1) concurrencyBySlug.delete(slug);
  else concurrencyBySlug.set(slug, inflight - 1);
}

async function withSlugLimit<T>(
  slug: string,
  res: Response,
  body: () => Promise<T>,
): Promise<T | undefined> {
  if (!acquireSlot(slug)) {
    res.status(429).json({
      error: "Too many concurrent git operations for this workspace",
      code: "CONCURRENCY_LIMIT",
      limit: MAX_CONCURRENT_PER_SLUG,
    });
    return undefined;
  }
  try {
    return await body();
  } finally {
    releaseSlot(slug);
  }
}

function respondUserDirMissing(res: Response, slug: string): void {
  logger.warn(`git: working tree not accessible for slug=${slug} — verify sidecar volume mount`);
  res.status(503).json({
    error: "Working tree temporarily unavailable; retry in a few seconds.",
    code: "CUSTOMER_DIR_MISSING",
  });
}

function respondGitError(res: Response, err: WorkspaceGitError): void {
  switch (err.code) {
    case "NOT_A_REPO":
      res.status(503).json({ error: "Not a git repository", code: err.code });
      return;
    case "TIMEOUT":
      res.status(504).json({ error: "git timed out", code: err.code, durationMs: err.durationMs });
      return;
    case "OUTPUT_TOO_LARGE":
      res.status(413).json({ error: "git output exceeded cap", code: err.code, cap: err.cap });
      return;
    case "WORKSPACE_BUSY":
      res.status(409).json({ error: "workspace is busy", code: err.code });
      return;
    case "GIT_FAILED":
      logger.warn("workspace-git: git command failed", { status: err.status, stderr: err.stderr });
      res.status(500).json({ error: "git command failed", code: err.code, status: err.status });
      return;
    case "INTERNAL":
      logger.error("workspace-git: internal error", { message: err.message });
      res.status(500).json({ error: "internal error", code: err.code });
      return;
    default:
      res.status(500).json({ error: "git error", code: "UNKNOWN" });
  }
}

function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 1024) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\0")) return false;
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "..") return false;
  }
  const resolved = path.resolve("/cwd", p);
  if (!resolved.startsWith("/cwd/") && resolved !== "/cwd") return false;
  return true;
}

function isSafeRefName(ref: string): boolean {
  if (!ref || ref.length > 250) return false;
  if (ref.startsWith("-")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(ref);
}

const gitStatusHandler: AuthorizedHandler = async (req, res, _next, target) => {
    const start = Date.now();
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(usersRoot(), target);
      if (!dir) {
        respondUserDirMissing(res, target.slug);
        return;
      }
      const r = await gitStatus(dir);
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ entries: r.entries });
    });
    logger.info(`git/status slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
};

const gitDiffHandler: AuthorizedHandler = async (req, res, _next, target) => {
    const start = Date.now();
    const filePath = typeof req.query.path === "string" ? req.query.path : undefined;
    const ref = typeof req.query.ref === "string" ? req.query.ref : undefined;
    if (filePath && !isSafeRelativePath(filePath)) {
      res.status(400).json({ error: "Invalid path", code: "BAD_PATH" });
      return;
    }
    if (ref && !isSafeRefName(ref)) {
      res.status(400).json({ error: "Invalid ref", code: "BAD_REF" });
      return;
    }
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(usersRoot(), target);
      if (!dir) {
        respondUserDirMissing(res, target.slug);
        return;
      }
      const r = await gitDiff(dir, { path: filePath, ref });
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.type("text/plain; charset=utf-8").send(r.diff);
    });
    logger.info(`git/diff slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
};

const gitCommitDiffHandler: AuthorizedHandler = async (req, res, _next, target) => {
    const start = Date.now();
    const commit = typeof req.query.commit === "string" ? req.query.commit : undefined;
    if (!commit || !isSafeRefName(commit)) {
      res.status(400).json({ error: "Invalid commit ref", code: "BAD_REF" });
      return;
    }
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(usersRoot(), target);
      if (!dir) {
        respondUserDirMissing(res, target.slug);
        return;
      }
      const r = await gitCommitDiff(dir, commit);
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.type("text/plain; charset=utf-8").send(r.diff);
    });
    logger.info(`git/commit-diff slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
};

const gitLogHandler: AuthorizedHandler = async (req, res, _next, target) => {
    const start = Date.now();
    const limit = req.query.limit ? Number.parseInt(String(req.query.limit), 10) : undefined;
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    if (branch && !isSafeRefName(branch)) {
      res.status(400).json({ error: "Invalid branch", code: "BAD_BRANCH" });
      return;
    }
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(usersRoot(), target);
      if (!dir) {
        respondUserDirMissing(res, target.slug);
        return;
      }
      const r = await gitLog(dir, { limit, branch });
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ entries: r.entries });
    });
    logger.info(`git/log slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
};

const gitBranchesHandler: AuthorizedHandler = async (req, res, _next, target) => {
    const start = Date.now();
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(usersRoot(), target);
      if (!dir) {
        respondUserDirMissing(res, target.slug);
        return;
      }
      const r = await gitBranches(dir);
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ entries: r.entries });
    });
    logger.info(`git/branches slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
};

const gitCommitHandler: AuthorizedHandler = async (req, res, _next, target) => {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "Missing or empty `message`", code: "BAD_MESSAGE" });
      return;
    }
    if (message.length > 5_000) {
      res.status(400).json({ error: "Commit message too long (5000 char max)", code: "MESSAGE_TOO_LONG" });
      return;
    }
    const start = Date.now();
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(usersRoot(), target);
      if (!dir) {
        respondUserDirMissing(res, target.slug);
        return;
      }
      const mutation = await runWorkspaceGitMutation(
        dir,
        () => gitCommit(dir, { message, author: target.commitAuthor }),
      );
      if (!mutation.ok) {
        respondGitError(res, mutation.error);
        return;
      }
      const r = mutation.result;
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ sha: r.result.sha, empty: r.result.empty });
    });
    logger.info(`git/commit slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
};

const gitPushHandler: AuthorizedHandler = async (req, res, _next, target) => {
    if (target.githubToken) {
    res.status(409).json({ error: "GitHub project changes must be published through a pull request" });
    return;
  }
  const branch = typeof req.body?.branch === "string" ? req.body.branch : undefined;
    if (branch && !isSafeRefName(branch)) {
      res.status(400).json({ error: "Invalid branch", code: "BAD_BRANCH" });
      return;
    }
    const start = Date.now();
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(usersRoot(), target);
      if (!dir) {
        respondUserDirMissing(res, target.slug);
        return;
      }
      const mutation = await runWorkspaceGitMutation(
        dir,
        () => gitPush(dir, { branch }),
      );
      if (!mutation.ok) {
        respondGitError(res, mutation.error);
        return;
      }
      const r = mutation.result;
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ ok: true });
    });
    logger.info(`git/push slug=${target.slug} project=${target.projectSlug ?? "-"} dur=${Date.now() - start}ms status=${res.statusCode}`);
};

const gitBranchCheckoutHandler: AuthorizedHandler = async (req, res, _next, target) => {
    const branch = typeof req.body?.branch === "string" ? req.body.branch : "";
    const create = req.body?.create === true;
    if (!branch || !isSafeRefName(branch)) {
      res.status(400).json({ error: "Invalid branch", code: "BAD_BRANCH" });
      return;
    }
    const start = Date.now();
    await withSlugLimit(target.slug, res, async () => {
      const dir = await resolveTargetDir(usersRoot(), target);
      if (!dir) {
        respondUserDirMissing(res, target.slug);
        return;
      }
      const mutation = await runWorkspaceGitMutation(
        dir,
        () => gitCheckout(dir, { branch, create }),
      );
      if (!mutation.ok) {
        respondGitError(res, mutation.error);
        return;
      }
      const r = mutation.result;
      if (!r.ok) {
        respondGitError(res, r.error);
        return;
      }
      res.json({ ok: true, branch });
    });
    logger.info(`git/branch/checkout slug=${target.slug} project=${target.projectSlug ?? "-"} branch=${branch} create=${create} dur=${Date.now() - start}ms status=${res.statusCode}`);
};

export function createWorkspaceGitRouter(deps: WorkspaceGitRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const workspaceGitRateLimit = (limit: number) => rateLimit({
    ...DEFAULT_RATE_LIMIT_OPTIONS,
    windowMs: 60_000,
    limit,
    keyGenerator: (_req, res) => (res.locals as GitLocals).gitAuthorization.uid,
    message: { error: "Too many workspace Git requests, please try again later." },
  });
  const readLimit = workspaceGitRateLimit(300);
  const writeLimit = workspaceGitRateLimit(30);
  const authorized = (handler: AuthorizedHandler, lane: WorkspaceGitLane) => [
    requireGitAuthorization(deps, lane),
    lane.access === "read" ? readLimit : writeLimit,
    (req: Request, res: Response<unknown, GitLocals>, next: NextFunction) => handler(req, res, next, res.locals.gitAuthorization),
  ] as const;

  router.get("/git/status", ...authorized(gitStatusHandler, GIT_LANE_READ));
  router.get("/git/diff", ...authorized(gitDiffHandler, GIT_LANE_READ));
  router.get("/git/commit-diff", ...authorized(gitCommitDiffHandler, GIT_LANE_READ));
  router.get("/git/log", ...authorized(gitLogHandler, GIT_LANE_READ));
  router.get("/git/branches", ...authorized(gitBranchesHandler, GIT_LANE_READ));
  router.post("/git/commit", ...authorized(gitCommitHandler, GIT_LANE_WRITE));
  router.post("/git/push", ...authorized(gitPushHandler, GIT_LANE_REMOTE_WRITE));
  router.post("/git/branch/checkout", ...authorized(gitBranchCheckoutHandler, GIT_LANE_WRITE));

  return router;
}

const workspaceGitRouter = createWorkspaceGitRouter({
  authorize: authorizeWorkspaceGit,
  localGatewayId: () => process.env.GATEWAY_ID ?? null,
});

export default workspaceGitRouter;
