import { storeUploadedWorkspaceBlob as storeWorkspaceBlob } from "../../lib/project-blob-edit.js";
import { requestBlobStore, type BlobStore } from "../../lib/blob-store.js";
import { Router, Request, Response, NextFunction } from "express";
import { logger } from "../../middleware/logging.js";
import { giteaApiAsUser } from "../../lib/gitea.js";
import { workspaceGiteaOrg, workspaceRepoName } from "@octogee/core/gitea-naming";
import {
  WorkspaceStorageQuotaError,
} from "../../lib/workspace-blob.js";
import type { FileTarget } from "../../lib/fileTarget.js";
import {
  ensureSlug,
  getExtension,
  getMimeType,
  isTextFile,
  validateWorkspacePath,
} from "./helpers.js";

const router: Router = Router();
const MAX_IMPORT_BLOB_BYTES = 10 * 1024 * 1024;
const SKIP_IMPORT_PATHS = [/^\.git\//, /node_modules\//, /^\.DS_Store$/, /^__MACOSX\//];

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface GitHubTreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

export type ValidatedImportTargetDir =
  | { ok: true; targetDir: string }
  | { ok: false; error: string };

interface ImportRepoRequest {
  repoRef: GitHubRepoRef;
  targetDir: string;
}

interface ImportRepoContext extends ImportRepoRequest {
  slug: string;
  org: string;
  sudoUser: string;
  workspaceRepo: string;
  headers: Record<string, string>;
  target: FileTarget;
}

interface ImportedRepoResult {
  fileCount: number;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function parseGitHubRepoUrl(repoUrl: string): GitHubRepoRef | null {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) return null;

  const [, owner, repo] = match;
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    return null;
  }

  return { owner, repo };
}

export function validatedImportTargetDir(
  repo: string,
  targetDir?: string,
): ValidatedImportTargetDir {
  const resolvedTargetDir = targetDir || `builds/${repo}/src`;
  const destDirError = validateWorkspacePath(resolvedTargetDir);
  if (destDirError) {
    return { ok: false, error: `Invalid targetDir: ${destDirError}` };
  }

  return { ok: true, targetDir: resolvedTargetDir };
}

export function importableGitHubBlob(entry: GitHubTreeEntry): boolean {
  if (entry.type !== "blob") return false;
  if (SKIP_IMPORT_PATHS.some((pattern) => pattern.test(entry.path))) return false;
  if (entry.size && entry.size > MAX_IMPORT_BLOB_BYTES) return false;
  return typeof entry.sha === "string" && /^[0-9a-f]{40}$/.test(entry.sha);
}

function githubHeaders(): Record<string, string> {
  const ghToken = process.env.GITHUB_TOKEN;
  return {
    ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}),
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "octogee-workspace",
  };
}

function githubTreeUrl({ owner, repo }: GitHubRepoRef): string {
  return `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
}

function githubBlobUrl({ owner, repo }: GitHubRepoRef, sha: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`;
}

async function fetchGitHubTree(context: ImportRepoContext, res: Response): Promise<GitHubTreeEntry[] | null> {
  const treeResp = await fetch(githubTreeUrl(context.repoRef), { headers: context.headers });
  if (!treeResp.ok) {
    if (treeResp.status === 404) {
      res.status(404).json({ error: "Repository not found or not accessible." });
      return null;
    }
    throw new Error(`Source repo API ${treeResp.status}`);
  }

  const treeData = (await treeResp.json()) as { tree?: GitHubTreeEntry[] };
  return treeData.tree ?? [];
}

async function fetchGitHubBlobContent(context: ImportRepoContext, sha: string): Promise<string | null> {
  const blobResp = await fetch(githubBlobUrl(context.repoRef, sha), { headers: context.headers });
  if (!blobResp.ok) return null;

  const blobData = (await blobResp.json()) as { content: string };
  return blobData.content;
}

function importTargetPath(targetDir: string, blobPath: string): string | null {
  const targetPath = `${targetDir}/${blobPath}`;
  return validateWorkspacePath(targetPath) ? null : targetPath;
}

async function existingTextSha(context: ImportRepoContext, targetPath: string): Promise<string | undefined> {
  try {
    const existing = (await giteaApiAsUser(
      context.sudoUser,
      context.org,
      `${context.workspaceRepo}/contents/${targetPath}`,
    )) as { sha?: string };
    return existing.sha;
  } catch (e) {
    if (errorMessage(e).includes("404")) return undefined;
    logger.warn(`Failed to read existing imported repo entry SHA for ${targetPath}: ${errorMessage(e)}`);
    return undefined;
  }
}

async function writeTextImport(
  context: ImportRepoContext,
  blob: GitHubTreeEntry,
  targetPath: string,
  content: string,
): Promise<void> {
  const sha = await existingTextSha(context, targetPath);
  await giteaApiAsUser(context.sudoUser, context.org, `${context.workspaceRepo}/contents/${targetPath}`, "PUT", {
    message: `import: ${blob.path} from ${context.repoRef.owner}/${context.repoRef.repo}`,
    content,
    ...(sha ? { sha } : {}),
  });
}

async function writeBlobImport(
  context: ImportRepoContext,
  blob: GitHubTreeEntry,
  targetPath: string,
  content: string,
): Promise<void> {
  const fileBuffer = Buffer.from(content, "base64");
  const ext = getExtension(blob.path);
  const mimeType = getMimeType(ext);
  await storeWorkspaceBlob(context.target, targetPath, fileBuffer, mimeType);
}

async function importGitHubBlob(
  context: ImportRepoContext,
  blob: GitHubTreeEntry,
): Promise<boolean> {
  const targetPath = importTargetPath(context.targetDir, blob.path);
  if (!targetPath) return false;

  const content = await fetchGitHubBlobContent(context, blob.sha);
  if (content === null) return false;

  if (isTextFile(blob.path)) {
    await writeTextImport(context, blob, targetPath, content);
  } else {
    await writeBlobImport(context, blob, targetPath, content);
  }

  return true;
}

async function importGitHubRepo(context: ImportRepoContext, res: Response): Promise<ImportedRepoResult | null> {
  const tree = await fetchGitHubTree(context, res);
  if (!tree) return null;

  let fileCount = 0;
  for (const blob of tree.filter(importableGitHubBlob)) {
    if (await importGitHubBlob(context, blob)) {
      fileCount += 1;
    }
  }

  return { fileCount };
}

function importRepoContext(slug: string, request: ImportRepoRequest, blobStore?: BlobStore): ImportRepoContext {
  return {
    ...request,
    slug,
    org: workspaceGiteaOrg(slug),
    sudoUser: `ws-${slug}`,
    workspaceRepo: workspaceRepoName(),
    headers: githubHeaders(),
    target: {
      slug,
      projectSlug: null,
      provider: "gitea",
      org: workspaceGiteaOrg(slug),
      repoName: workspaceRepoName(),
      gcsPrefix: `customers/${slug}`,
      blobStore,
      sudoUser: `ws-${slug}`,
      brokered: false,
      canvasFile: "README.md",
    },
  };
}

function importRepoRequest(body: unknown, res: Response): ImportRepoRequest | null {
  const { repoUrl, targetDir } = body as { repoUrl: string; targetDir?: string };
  if (!repoUrl) {
    res.status(400).json({ error: "Missing repoUrl" });
    return null;
  }

  const repoRef = parseGitHubRepoUrl(repoUrl);
  if (!repoRef) {
    res.status(400).json({ error: "Invalid repo URL. Use https://github.com/owner/repo format." });
    return null;
  }

  const target = validatedImportTargetDir(repoRef.repo, targetDir);
  if (!target.ok) {
    res.status(400).json({ error: target.error });
    return null;
  }

  return { repoRef, targetDir: target.targetDir };
}

async function handleImportRepo(req: Request, res: Response): Promise<void> {
  const slug = ensureSlug(req, res);
  if (!slug) return;

  const request = importRepoRequest(req.body, res);
  if (!request) return;

  const context = importRepoContext(slug, request, requestBlobStore(req));
  const result = await importGitHubRepo(context, res);
  if (!result) return;

  res.json({ success: true, targetDir: context.targetDir, fileCount: result.fileCount });
}

router.post("/import-repo", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await handleImportRepo(req, res);
  } catch (e) {
    if (e instanceof WorkspaceStorageQuotaError) {
      res.status(413).json({
        error: "Free workspace storage allowance exceeded",
        code: e.code,
        limitBytes: e.limitBytes,
        projectedBytes: e.projectedBytes,
      });
      return;
    }
    next(e);
  }
});

export default router;
