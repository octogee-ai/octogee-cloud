import { requestBlobStore } from "./blob-store.js";
import { userAccounts } from "../identity/user-accounts.js";
import { readProject } from "./firestoreReads.js";
import { platformStateStore } from "../identity/platform-state-store.js";
import { USERNAME_RE } from "@octogee/shared/types/identity";
import { readConnectorAccessToken } from "../connectors/connector-tokens.js";
import { workspaceGiteaOrg, workspaceRepoName, projectRepoName } from "../gitea-naming.js";
import { logger } from "../http/logging.js";
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { isCanonicalWorkspaceMembership } from "../gateway-principal-access.js";
export async function resolveFileTarget(input, opts = {}) {
    const { slug, projectSlug, callerUid, callerWorkspaceSlug } = input;
    if (!slug) {
        return { ok: false, status: 400, error: "Missing slug" };
    }
    if (projectSlug) {
        return resolveProjectTarget({ ...input, projectSlug, slug }, opts);
    }
    return resolveWorkspaceTarget(slug, callerUid, callerWorkspaceSlug, opts);
}
async function resolveProjectTarget(input, opts) {
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
    const github = project.repoSource?.provider === "github" ? project.repoSource : null;
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
async function projectMutationIsBlocked(project) {
    if (project.commercialLifecycle?.status === "archived")
        return true;
    const owner = await userAccounts().get(project.ownerUid);
    return userEntitlements().projectMode(owner?.planInputs ?? {}) !== "active";
}
function giteaProjectTarget(slug, projectSlug, callerWorkspaceSlug, canvasFile) {
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
async function resolveGithubProjectTarget(args) {
    const { callerUid, github, project, projectSlug, resolveGithubToken, slug } = args;
    const githubTarget = {
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
    const githubToken = await readConnectorAccessToken(callerUid, "github", {
        kind: "project",
        requestingUid: callerUid,
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
    logger.info(`[fileTarget] caller-bound github token repo=${github.owner}/${github.repo} caller=${callerUid}`);
    return { ok: true, target: { ...githubTarget, githubToken, brokered: true } };
}
async function resolveWorkspaceTarget(slug, callerUid, callerWorkspaceSlug, opts) {
    const workspaceTarget = {
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
async function resolveWorkspaceMemberTarget(workspaceTarget, slug, callerUid) {
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
function readTargetInput(req) {
    const slug = (req.query.slug || req.body?.slug || null);
    const projectSlug = (req.query.project || req.body?.project || null);
    return { slug, projectSlug };
}
export function withFileTarget(handler, opts) {
    return async (req, res, next) => {
        try {
            const { slug, projectSlug } = readTargetInput(req);
            const result = await resolveFileTarget({
                slug,
                projectSlug,
                callerUid: req.uid,
                callerWorkspaceSlug: req.workspaceSlug,
            }, opts);
            if (!result.ok) {
                res
                    .status(result.status)
                    .json({ error: result.error, ...(result.reason ? { reason: result.reason } : {}) });
                return;
            }
            if (result.target.provider === "gitea") {
                const blobStore = requestBlobStore(req);
                if (blobStore)
                    result.target.blobStore = blobStore;
            }
            await handler(req, res, next, result.target);
        }
        catch (e) {
            next(e);
        }
    };
}
export function withGiteaTarget(handler, opts = {}) {
    return withFileTarget(async (req, res, next, target) => {
        if (target.provider !== "gitea") {
            res.status(409).json({
                error: "Not available for GitHub-backed projects",
                code: "GITHUB_READ_ONLY",
            });
            return;
        }
        await handler(req, res, next, target);
    }, { ...opts, resolveGithubToken: false });
}
