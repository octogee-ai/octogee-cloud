import type { Request, Response } from "express";
import { placeholderEmail } from "../placeholder-email.js";
import { giteaApiAsUser } from "../git-host/gitea-client.js";
import {
  githubBranchesApi,
  githubCommitsApi,
  githubContentsApi,
  githubRepoApi,
  githubTreeApi,
} from "../git-host/github.js";
import type { FileTarget } from "./fileTarget.js";
import type { CommitAuthor } from "./workspace-git.js";
import { validateFilePath } from "@octogee/shared/types/path-validation";

const FLAT_NOTE_RE = /^notes\/[^/]+\.md$/;
export const CANVAS_DASHBOARD_DOCUMENT_PATH = ".octogee/canvas.json";

export function isCanvasDashboardDocumentPath(path: string): boolean {
  return path === CANVAS_DASHBOARD_DOCUMENT_PATH;
}

export function isBrokeredWritablePath(path: string, canvasFile: string | undefined): boolean {
  return FLAT_NOTE_RE.test(path)
    || isCanvasDashboardDocumentPath(path)
    || path === (canvasFile || "README.md");
}

export function isTargetPathWritable(target: FileTarget, path: string): boolean {
  if (target.brokered) {
    return isBrokeredWritablePath(path, target.canvasFile);
  }
  return true;
}

export function isTargetPathReadable(target: FileTarget, path: string): boolean {
  return !target.workspaceMemberBrokered
    || isBrokeredWritablePath(path, target.canvasFile);
}

export function isTargetDirectoryReadable(target: FileTarget, path: string): boolean {
  if (!target.workspaceMemberBrokered) return true;
  if (!path || path === "notes") return true;
  const canvasFile = target.canvasFile || "README.md";
  return canvasFile.startsWith(`${path}/`);
}

export function isTargetDirectoryEntryReadable(
  target: FileTarget,
  path: string,
  type: "dir" | "file",
): boolean {
  return type === "dir"
    ? isTargetDirectoryReadable(target, path)
    : isTargetPathReadable(target, path);
}

export function resolveCommitAuthor(
  user: Record<string, unknown> | undefined,
  slug: string,
): CommitAuthor {
  const data = user as { displayName?: string; email?: string; username?: string } | undefined;
  const fallback = (data?.username || "").trim() || slug;
  const name = (data?.displayName || "").trim() || fallback;
  const email = (data?.email || "").trim() || placeholderEmail(fallback);
  return { name, email };
}

export function giteaSudoUser(target: FileTarget): string {
  if (!target.sudoUser) throw new Error("gitea target missing sudoUser");
  return target.sudoUser;
}

// Act on the gitea workspace/project repo AS the impersonated user (admin Sudo —
// Gitea enforces their ACL). Replaces the per-user PAT path.
export async function targetGiteaApi(
  target: FileTarget,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  return giteaApiAsUser(giteaSudoUser(target), target.org, path, method, body);
}

export async function repoContentsApi(
  target: FileTarget,
  filePath: string,
  ref?: string,
): Promise<unknown> {
  if (target.provider === "github") {
    return githubContentsApi(target.org, target.repoName, filePath, target.githubToken, ref);
  }
  const base = filePath
    ? `${target.repoName}/contents/${filePath}`
    : `${target.repoName}/contents`;
  const apiPath = ref ? `${base}?ref=${encodeURIComponent(ref)}` : base;
  return targetGiteaApi(target, apiPath);
}

export interface BranchInfo {
  name: string;
  isDefault: boolean;
}

interface RawTreeEntry {
  path?: string;
  type?: string;
}

export async function repoDefaultBranch(target: FileTarget): Promise<string> {
  const raw = (target.provider === "github"
    ? await githubRepoApi(target.org, target.repoName, target.githubToken)
    : await targetGiteaApi(target, target.repoName)) as { default_branch?: string } | null;
  return raw?.default_branch || "main";
}

export async function repoBranchesApi(
  target: FileTarget,
): Promise<{ branches: BranchInfo[]; default: string }> {
  const def = await repoDefaultBranch(target);
  const raw = (target.provider === "github"
    ? await githubBranchesApi(target.org, target.repoName, target.githubToken)
    : await targetGiteaApi(target, `${target.repoName}/branches`)) as Array<{ name?: string }>;
  const branches = (Array.isArray(raw) ? raw : [])
    .map((b) => b.name || "")
    .filter(Boolean)
    .map((name) => ({ name, isDefault: name === def }));
  return { branches, default: def };
}

export async function repoTreeApi(
  target: FileTarget,
  ref: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const raw = (target.provider === "github"
    ? await githubTreeApi(target.org, target.repoName, ref, target.githubToken)
    : await targetGiteaApi(target, `${target.repoName}/git/trees/${encodeURIComponent(ref)}?recursive=true`)) as {
    tree?: RawTreeEntry[];
    truncated?: boolean;
  } | null;
  const entries = Array.isArray(raw?.tree) ? raw.tree : [];
  const paths = entries
    .filter((e) => e.type === "blob" && typeof e.path === "string")
    .map((e) => e.path as string)
    .filter((p) => !pathHasReservedOrHiddenSegment(p));
  return { paths, truncated: raw?.truncated === true };
}

// Provider-neutral "last commit touching this path". Both Gitea and GitHub return
// a commit-list whose element shares this shape; only the request URL differs. This
// is the same provider seam as repoContentsApi — future first-class integrations
// (CI/CD, builds) grow it the same way.
export interface LastCommit {
  message: string;
  date: string;
  authorName: string;
  sha: string;
}

interface RawCommit {
  sha?: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
    committer?: { date?: string };
  };
  author?: { login?: string } | null;
}

function firstLine(text: string | undefined): string {
  return (text ?? "").split(/\r?\n/)[0];
}

function normalizeCommit(raw: RawCommit | undefined): LastCommit | null {
  if (!raw) return null;
  const commit = raw.commit;
  const author = commit?.author;
  return {
    message: firstLine(commit?.message),
    date: author?.date ?? commit?.committer?.date ?? "",
    authorName: author?.name ?? raw.author?.login ?? "",
    sha: raw.sha ?? "",
  };
}

export async function repoCommitsApi(
  target: FileTarget,
  filePath: string,
  ref?: string,
): Promise<LastCommit | null> {
  const giteaSha = ref ? `&sha=${encodeURIComponent(ref)}` : "";
  const raw =
    target.provider === "github"
      ? await githubCommitsApi(target.org, target.repoName, filePath, target.githubToken, ref)
      : await targetGiteaApi(
          target,
          `${target.repoName}/commits?path=${encodeURIComponent(filePath)}&limit=1&stat=false${giteaSha}`,
        );
  const list = Array.isArray(raw) ? (raw as RawCommit[]) : [];
  return normalizeCommit(list[0]);
}

export const HIDDEN = new Set([
  "BUILDS.md", "HEARTBEAT.md", "IDENTITY.md",
  ".gitignore",
  ".git", ".system", "preview", "node_modules",
  "crew-webhooks.json",
]);

export function pathHasReservedOrHiddenSegment(filePath: string): string | null {
  const parts = filePath.split("/");
  for (const p of parts) {
    if (p.length === 0) return "Path contains empty segment (trailing or leading slash)";
    if (HIDDEN.has(p)) return `Path contains reserved name: ${p}`;
    if (p.startsWith(".")) return `Path contains hidden segment: ${p}`;
  }
  return null;
}

export function validateWorkspacePath(filePath: string): string | null {
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  return pathHasReservedOrHiddenSegment(filePath);
}

export function validateEditableWorkspacePath(filePath: string): string | null {
  if (isCanvasDashboardDocumentPath(filePath)) return validateFilePath(filePath);
  return validateWorkspacePath(filePath);
}

export const EDITABLE_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".json", ".ts", ".tsx", ".js", ".jsx",
  ".html", ".css", ".yml", ".yaml", ".toml", ".env", ".sh", ".py", ".astro",
  ".xml", ".csv", ".sql", ".graphql", ".svelte", ".vue",
]);

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

export function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
    ".zip": "application/zip", ".csv": "text/csv",
  };
  return map[ext] ?? "application/octet-stream";
}

export function isTextFile(filename: string): boolean {
  return EDITABLE_EXTENSIONS.has(getExtension(filename));
}

export function ensureSlug(req: Request, res: Response): string | null {
  const slug = (req.query.slug as string) || req.body?.slug;
  if (!slug) {
    res.status(400).json({ error: "Missing slug" });
    return null;
  }
  if (req.workspaceSlug !== slug) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return slug;
}
