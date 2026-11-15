import { placeholderEmail } from "../placeholder-email.js";
import { giteaApiAsUser } from "../git-host/gitea-client.js";
import { githubBranchesApi, githubCommitsApi, githubContentsApi, githubRepoApi, githubTreeApi, } from "../git-host/github.js";
import { validateFilePath } from "@octogee/shared/types/path-validation";
const FLAT_NOTE_RE = /^notes\/[^/]+\.md$/;
export const CANVAS_DASHBOARD_DOCUMENT_PATH = ".octogee/canvas.json";
export function isCanvasDashboardDocumentPath(path) {
    return path === CANVAS_DASHBOARD_DOCUMENT_PATH;
}
export function isBrokeredWritablePath(path, canvasFile) {
    return FLAT_NOTE_RE.test(path)
        || isCanvasDashboardDocumentPath(path)
        || path === (canvasFile || "README.md");
}
export function isTargetPathWritable(target, path) {
    if (target.brokered) {
        return isBrokeredWritablePath(path, target.canvasFile);
    }
    return true;
}
export function isTargetPathReadable(target, path) {
    return !target.workspaceMemberBrokered
        || isBrokeredWritablePath(path, target.canvasFile);
}
export function isTargetDirectoryReadable(target, path) {
    if (!target.workspaceMemberBrokered)
        return true;
    if (!path || path === "notes")
        return true;
    const canvasFile = target.canvasFile || "README.md";
    return canvasFile.startsWith(`${path}/`);
}
export function isTargetDirectoryEntryReadable(target, path, type) {
    return type === "dir"
        ? isTargetDirectoryReadable(target, path)
        : isTargetPathReadable(target, path);
}
export function resolveCommitAuthor(user, slug) {
    const data = user;
    const fallback = (data?.username || "").trim() || slug;
    const name = (data?.displayName || "").trim() || fallback;
    const email = (data?.email || "").trim() || placeholderEmail(fallback);
    return { name, email };
}
export function giteaSudoUser(target) {
    if (!target.sudoUser)
        throw new Error("gitea target missing sudoUser");
    return target.sudoUser;
}
// Act on the gitea workspace/project repo AS the impersonated user (admin Sudo —
// Gitea enforces their ACL). Replaces the per-user PAT path.
export async function targetGiteaApi(target, path, method = "GET", body) {
    return giteaApiAsUser(giteaSudoUser(target), target.org, path, method, body);
}
export async function repoContentsApi(target, filePath, ref) {
    if (target.provider === "github") {
        return githubContentsApi(target.org, target.repoName, filePath, target.githubToken, ref);
    }
    const base = filePath
        ? `${target.repoName}/contents/${filePath}`
        : `${target.repoName}/contents`;
    const apiPath = ref ? `${base}?ref=${encodeURIComponent(ref)}` : base;
    return targetGiteaApi(target, apiPath);
}
export async function repoDefaultBranch(target) {
    const raw = (target.provider === "github"
        ? await githubRepoApi(target.org, target.repoName, target.githubToken)
        : await targetGiteaApi(target, target.repoName));
    return raw?.default_branch || "main";
}
export async function repoBranchesApi(target) {
    const def = await repoDefaultBranch(target);
    const raw = (target.provider === "github"
        ? await githubBranchesApi(target.org, target.repoName, target.githubToken)
        : await targetGiteaApi(target, `${target.repoName}/branches`));
    const branches = (Array.isArray(raw) ? raw : [])
        .map((b) => b.name || "")
        .filter(Boolean)
        .map((name) => ({ name, isDefault: name === def }));
    return { branches, default: def };
}
export async function repoTreeApi(target, ref) {
    const raw = (target.provider === "github"
        ? await githubTreeApi(target.org, target.repoName, ref, target.githubToken)
        : await targetGiteaApi(target, `${target.repoName}/git/trees/${encodeURIComponent(ref)}?recursive=true`));
    const entries = Array.isArray(raw?.tree) ? raw.tree : [];
    const paths = entries
        .filter((e) => e.type === "blob" && typeof e.path === "string")
        .map((e) => e.path)
        .filter((p) => !pathHasReservedOrHiddenSegment(p));
    return { paths, truncated: raw?.truncated === true };
}
function firstLine(text) {
    return (text ?? "").split(/\r?\n/)[0];
}
function normalizeCommit(raw) {
    if (!raw)
        return null;
    const commit = raw.commit;
    const author = commit?.author;
    return {
        message: firstLine(commit?.message),
        date: author?.date ?? commit?.committer?.date ?? "",
        authorName: author?.name ?? raw.author?.login ?? "",
        sha: raw.sha ?? "",
    };
}
export async function repoCommitsApi(target, filePath, ref) {
    const giteaSha = ref ? `&sha=${encodeURIComponent(ref)}` : "";
    const raw = target.provider === "github"
        ? await githubCommitsApi(target.org, target.repoName, filePath, target.githubToken, ref)
        : await targetGiteaApi(target, `${target.repoName}/commits?path=${encodeURIComponent(filePath)}&limit=1&stat=false${giteaSha}`);
    const list = Array.isArray(raw) ? raw : [];
    return normalizeCommit(list[0]);
}
export const HIDDEN = new Set([
    "BUILDS.md", "HEARTBEAT.md", "IDENTITY.md",
    ".gitignore",
    ".git", ".system", "preview", "node_modules",
    "crew-webhooks.json",
]);
export function pathHasReservedOrHiddenSegment(filePath) {
    const parts = filePath.split("/");
    for (const p of parts) {
        if (p.length === 0)
            return "Path contains empty segment (trailing or leading slash)";
        if (HIDDEN.has(p))
            return `Path contains reserved name: ${p}`;
        if (p.startsWith("."))
            return `Path contains hidden segment: ${p}`;
    }
    return null;
}
export function validateWorkspacePath(filePath) {
    const pathError = validateFilePath(filePath);
    if (pathError)
        return pathError;
    return pathHasReservedOrHiddenSegment(filePath);
}
export function validateEditableWorkspacePath(filePath) {
    if (isCanvasDashboardDocumentPath(filePath))
        return validateFilePath(filePath);
    return validateWorkspacePath(filePath);
}
export const EDITABLE_EXTENSIONS = new Set([
    ".md", ".mdx", ".txt", ".json", ".ts", ".tsx", ".js", ".jsx",
    ".html", ".css", ".yml", ".yaml", ".toml", ".env", ".sh", ".py", ".astro",
    ".xml", ".csv", ".sql", ".graphql", ".svelte", ".vue",
]);
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
export function getExtension(filename) {
    const dot = filename.lastIndexOf(".");
    return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}
export function getMimeType(ext) {
    const map = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
        ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
        ".zip": "application/zip", ".csv": "text/csv",
    };
    return map[ext] ?? "application/octet-stream";
}
export function isTextFile(filename) {
    return EDITABLE_EXTENSIONS.has(getExtension(filename));
}
export function ensureSlug(req, res) {
    const slug = req.query.slug || req.body?.slug;
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
