import { GITHUB_PROJECT_METADATA_PATHS } from "@octogee/shared/types/project";
import { Router, type Request, type Response } from "express";
import { withGiteaTarget, type FileTarget } from "@octogee/core/workspace/fileTarget";
import {
  isBrokeredWritablePath,
  isTextFile,
  resolveCommitAuthor,
  targetGiteaApi,
  validateEditableWorkspacePath,
} from "@octogee/core/workspace/route-helpers";
import { logger } from "@octogee/core/http/logging";
import { invalidateWorkspaceFileResponseCache } from "@octogee/core/workspace/file-response-cache";
import {
  resolveUserDir,
  resolveProjectDir,
  syncCleanWorkspaceToRemote,
  type WorkspaceRemoteSyncState,
} from "@octogee/core/workspace/workspace-git";

const router: Router = Router();

const MAX_SAVE_BYTES = 1024 * 1024;

export type ValidatedSaveRequest =
  | { ok: true; path: string; content: string }
  | { ok: false; status: 400 | 413; error: string; code?: string };

type SaveAuthor = ReturnType<typeof resolveCommitAuthor>;

interface SavePayload {
  author: SaveAuthor;
  contentBase64: string;
  message: string;
  start: number;
}

export interface SavedGiteaCheckoutSyncDeps {
  usersRoot: string;
  resolveUserDir: typeof resolveUserDir;
  resolveProjectDir: typeof resolveProjectDir;
  syncCleanWorkspaceToRemote: typeof syncCleanWorkspaceToRemote;
}

const SAVED_GITEA_CHECKOUT_SYNC_DEPS: SavedGiteaCheckoutSyncDeps = {
  usersRoot: process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers",
  resolveUserDir,
  resolveProjectDir,
  syncCleanWorkspaceToRemote,
};

export async function syncSavedGiteaCheckout(
  target: FileTarget,
  deps: SavedGiteaCheckoutSyncDeps = SAVED_GITEA_CHECKOUT_SYNC_DEPS,
): Promise<WorkspaceRemoteSyncState | "checkout-missing" | "sync-failed"> {
  const dir = target.projectSlug
    ? await deps.resolveProjectDir(deps.usersRoot, target.slug, target.projectSlug)
    : await deps.resolveUserDir(deps.usersRoot, target.slug);
  if (!dir) {
    logger.warn(
      `save gitea checkout missing repo=${target.org}/${target.repoName}`,
    );
    return "checkout-missing";
  }
  const result = await deps.syncCleanWorkspaceToRemote(dir);
  if (!result.ok) {
    logger.warn(
      `save gitea checkout sync failed repo=${target.org}/${target.repoName} code=${result.error.code}`,
    );
    return "sync-failed";
  }
  const level = result.result.state === "dirty" || result.result.state === "no-upstream"
    ? "warn"
    : "info";
  logger[level](
    `save gitea checkout sync repo=${target.org}/${target.repoName} state=${result.result.state}`,
  );
  return result.result.state;
}

function commitMessage(path: string, authorName: string): string {
  const kind = path.startsWith("notes/") ? "notes" : "canvas";
  return `${kind}: edit ${path} — ${authorName} via Octogee Canvas`;
}

function rethrowUnlessNotFound(e: unknown): undefined {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("404")) return undefined;
  throw e;
}

export function validatedSaveRequest(body: unknown): ValidatedSaveRequest {
  const { path, content } = body && typeof body === "object"
    ? body as { path?: unknown; content?: unknown }
    : {};
  const savePath = typeof path === "string" ? path : "";
  const saveContent = typeof content === "string" ? content : null;
  if (!savePath) return { ok: false, status: 400, error: "Missing path" };
  if (saveContent === null) return { ok: false, status: 400, error: "Missing content" };

  const pathError = validateEditableWorkspacePath(savePath);
  if (pathError) return { ok: false, status: 400, error: pathError };
  if (!isTextFile(savePath)) {
    return { ok: false, status: 400, error: "Only text files can be saved", code: "NOT_TEXT" };
  }
  if (Buffer.byteLength(saveContent, "utf8") > MAX_SAVE_BYTES) {
    return { ok: false, status: 413, error: "Content too large", code: "TOO_LARGE" };
  }

  return { ok: true, path: savePath, content: saveContent };
}

function sendValidationError(res: Response, validation: Extract<ValidatedSaveRequest, { ok: false }>): void {
  res.status(validation.status).json({
    error: validation.error,
    ...(validation.code ? { code: validation.code } : {}),
  });
}

function sendBrokeredPathError(res: Response): void {
  res.status(403).json({
    error: "Only notes and the canvas home file are writable with a brokered token",
    code: "PATH_NOT_WRITABLE",
  });
}

function savePayload(
  req: Request,
  target: FileTarget,
  request: Extract<ValidatedSaveRequest, { ok: true }>,
): SavePayload {
  const author = resolveCommitAuthor(req.user, target.slug);
  return {
    author,
    contentBase64: Buffer.from(request.content, "utf8").toString("base64"),
    message: commitMessage(request.path, author.name),
    start: Date.now(),
  };
}

async function giteaSha(target: FileTarget, apiPath: string): Promise<string | undefined> {
  try {
    const existing = (await targetGiteaApi(target, apiPath)) as { sha?: string };
    return existing.sha;
  } catch (e) {
    return rethrowUnlessNotFound(e);
  }
}

async function saveGitea(
  target: FileTarget,
  request: Extract<ValidatedSaveRequest, { ok: true }>,
  payload: SavePayload,
): Promise<{ ok: true; sha: string | null; provider: "gitea" }> {
  const apiPath = `${target.repoName}/contents/${request.path}`;
  const sha = await giteaSha(target, apiPath);
  const out = (await targetGiteaApi(target, apiPath, "PUT", {
    message: payload.message,
    content: payload.contentBase64,
    ...(sha ? { sha } : {}),
    ...(target.checkpointBranch ? { branch: target.checkpointBranch } : {}),
    author: payload.author,
  })) as { content?: { sha?: string } };
  logger.info(
    `save gitea repo=${target.org}/${target.repoName} path=${request.path} dur=${Date.now() - payload.start}ms`,
  );
  return { ok: true, sha: out.content?.sha ?? null, provider: "gitea" };
}

router.post("/save", withGiteaTarget(async (req, res, _next, target) => {
  const request = validatedSaveRequest(req.body);
  if (!request.ok) {
    sendValidationError(res, request);
    return;
  }

  if (target.checkpointBranch && GITHUB_PROJECT_METADATA_PATHS.some(path => path === request.path)) {
    res.status(403).json({ error: "This file is reserved for Octogee", code: "PATH_NOT_WRITABLE" });
    return;
  }
  if (target.brokered && !isBrokeredWritablePath(request.path, target.canvasFile)) {
    sendBrokeredPathError(res);
    return;
  }

  const result = await saveGitea(target, request, savePayload(req, target, request));
  await syncSavedGiteaCheckout(target);
  invalidateWorkspaceFileResponseCache(target);
  res.json(result);
}, { allowWorkspaceMembers: true, access: "write", useProjectCheckpoint: true }));

export default router;
