import { spawn } from "node:child_process";
import { lstatSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { acquireWorkspaceMutationLeaseSync, projectMutationLeaseGitDir } from "../workspace-mutation-lease.js";
import { GITHUB_PROJECT_METADATA_PATHS, PROJECT_AGENT_WORKSPACE_PARTS, githubCheckpointBranch } from "@octogee/shared/types/project";
import { findUnsafeGitMetadataEntry, readGitMetadataText } from "../git-metadata.js";
import { isDuplicateAssetUpload } from "./workspace-manifest-conflict.js";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const GIT_PUSH_TIMEOUT_MS = 60_000;
const GIT_COMMIT_TIMEOUT_MS = 30_000;
const END_OF_OPTIONS = "--end-of-options";
const RECORD_SEPARATOR = String.fromCharCode(0x1e);
const UNIT_SEPARATOR = String.fromCharCode(0x1f);
const NUL = String.fromCharCode(0x00);
export const OPENCLAW_WORKSPACE_SCRATCH_PATH = ".openclaw/tmp";
const SAFE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export function isSafeSlug(slug) {
    return SAFE_SLUG_RE.test(slug);
}
export async function resolveUserDir(usersRoot, slug) {
    if (!isSafeSlug(slug))
        return null;
    return verifyGitDir(usersRoot, [slug]);
}
export async function resolveProjectDir(usersRoot, slug, projectSlug) {
    if (!isSafeSlug(slug) || !isSafeSlug(projectSlug))
        return null;
    return verifyGitDir(usersRoot, [slug, "projects", projectSlug]);
}
async function verifyGitDir(usersRoot, parts) {
    try {
        const root = path.resolve(usersRoot);
        const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
        let dir = root;
        if (!(await fs.lstat(root)).isDirectory())
            return null;
        for (const part of parts) {
            dir = path.resolve(dir, part);
            if (!dir.startsWith(prefix))
                return null;
            if (!(await fs.lstat(dir)).isDirectory())
                return null;
        }
        const metadataPath = path.resolve(dir, ".git");
        if (!metadataPath.startsWith(prefix))
            return null;
        const metadata = await fs.lstat(metadataPath);
        return metadata.isDirectory() || metadata.isFile() ? dir : null;
    }
    catch {
        return null;
    }
}
export async function gitStatus(customerDir, options = {}) {
    const args = ["status", "--porcelain=v1", "-z"];
    if (options.untracked === "all")
        args.push("-uall");
    const r = await runGit(customerDir, args);
    if (!r.ok)
        return r;
    return { ok: true, entries: parsePorcelain(r.stdout) };
}
export async function gitDiff(customerDir, options = {}) {
    const args = ["diff", "--no-color", "--no-ext-diff", END_OF_OPTIONS, options.ref ?? "HEAD"];
    if (options.path) {
        args.push("--", options.path);
    }
    const r = await runGit(customerDir, args);
    if (!r.ok)
        return r;
    return { ok: true, diff: r.stdout };
}
export async function gitCommitDiff(customerDir, sha) {
    const args = [
        "diff-tree",
        "--no-commit-id",
        "--no-color",
        "--no-ext-diff",
        "-p",
        "-r",
        "--root",
        END_OF_OPTIONS,
        sha,
    ];
    const r = await runGit(customerDir, args);
    if (!r.ok)
        return r;
    return { ok: true, diff: r.stdout };
}
export async function gitLog(customerDir, options = {}) {
    const limit = clampLimit(options.limit ?? 20);
    const FMT = `%H${UNIT_SEPARATOR}%aN${UNIT_SEPARATOR}%ct${UNIT_SEPARATOR}%s${RECORD_SEPARATOR}`;
    const args = ["log", "--no-ext-diff", `-n${limit}`, `--pretty=format:${FMT}`, END_OF_OPTIONS];
    if (options.branch)
        args.push(options.branch);
    const r = await runGit(customerDir, args);
    if (!r.ok)
        return r;
    return { ok: true, entries: parseLog(r.stdout) };
}
async function stageWorkspaceChanges(customerDir, excluded, reserved) {
    if (!excluded.length && !reserved.length)
        return runGit(customerDir, ["add", "-A"]);
    const changes = await runGit(customerDir, ["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z", "--", ".", ...[...excluded, ...reserved].map(file => `:(exclude,literal)${file}`)]);
    if (!changes.ok)
        return changes;
    const paths = [...new Set(changes.stdout.split(NUL).filter(Boolean))];
    if (paths.length) {
        const added = await runGit(customerDir, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
            input: paths.map(file => `:(literal)${file}${NUL}`).join(""),
        });
        if (!added.ok)
            return added;
    }
    if (reserved.length) {
        const reset = await runGit(customerDir, ["reset", "-q", "HEAD", "--", ...reserved]);
        if (!reset.ok)
            return reset;
    }
    if (excluded.length) {
        return runGit(customerDir, ["rm", "-r", "--cached", "--ignore-unmatch", "--", ...excluded.map(file => `:(literal)${file}`)]);
    }
    return changes;
}
async function stageWorkspaceCommit(customerDir, excludePaths) {
    const checkpoint = checkpointBranch(customerDir);
    if (checkpoint) {
        const checked = await assertCheckpointBranch(customerDir, checkpoint);
        if (!checked.ok)
            return checked;
    }
    const identity = userGitIdentity(customerDir);
    const workspace = identity && path.resolve(customerDir) === path.join(identity.usersRoot, identity.slug);
    const excluded = [...new Set([...excludePaths, OPENCLAW_WORKSPACE_SCRATCH_PATH, ...(workspace ? [PROJECT_AGENT_WORKSPACE_PARTS.join("/")] : [])])];
    const reserved = checkpoint || isTrustedGithubUserCheckout(customerDir) ? GITHUB_PROJECT_METADATA_PATHS : [];
    const staged = await stageWorkspaceChanges(customerDir, excluded, reserved);
    if (!staged.ok)
        return staged;
    const statusRes = await runGit(customerDir, excluded.length || reserved.length ? ["diff", "--cached", "--name-only", "-z"] : ["status", "--porcelain=v1", "-z"]);
    if (!statusRes.ok)
        return statusRes;
    return { ok: true, empty: !statusRes.stdout };
}
export async function gitCommit(customerDir, options) {
    const message = options.message.trim();
    if (!message || message.length > 5_000) {
        return { ok: false, error: { code: "INTERNAL", message: "commit message empty or too long" } };
    }
    const staged = await stageWorkspaceCommit(customerDir, options.excludePaths ?? []);
    if (!staged.ok)
        return staged;
    if (staged.empty)
        return { ok: true, result: { sha: "", empty: true } };
    const commitRes = await runGit(customerDir, [
        "-c", `user.name=${options.author.name}`,
        "-c", `user.email=${options.author.email}`,
        "commit",
        "--no-verify",
        "-m", message,
    ], { timeoutMs: GIT_COMMIT_TIMEOUT_MS });
    if (!commitRes.ok)
        return commitRes;
    const shaRes = await runGit(customerDir, ["rev-parse", "HEAD"]);
    if (!shaRes.ok)
        return shaRes;
    return { ok: true, result: { sha: shaRes.stdout.trim(), empty: false } };
}
const FULL_COMMIT_HASH = /^[0-9a-f]{40}$/u;
export async function gitHeadCommit(customerDir) {
    const head = await runGit(customerDir, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!head.ok)
        return head;
    const commit = head.stdout.trim();
    if (!FULL_COMMIT_HASH.test(commit)) {
        return { ok: false, error: { code: "INTERNAL", message: "HEAD is not a full 40-character commit hash" } };
    }
    return { ok: true, commit };
}
const COMMIT_AND_PUSH_DEPS = {
    gitCommit,
    gitPreparePush,
    gitPush,
    gitHeadCommit,
    acquireMutationLease: acquireWorkspaceMutationLeaseSync,
};
export async function syncCleanWorkspaceToRemote(customerDir) {
    const lease = acquireWorkspaceMutationLeaseSync({
        workspaceDir: customerDir,
        gitDir: workspaceMutationLeaseGitDir(customerDir),
    });
    if (!lease)
        return { ok: false, error: { code: "WORKSPACE_BUSY", cwd: customerDir } };
    try {
        const statusResult = await gitStatus(customerDir);
        if (!statusResult.ok)
            return statusResult;
        if (statusResult.entries.length > 0) {
            return { ok: true, result: { state: "dirty" } };
        }
        const branchResult = await runGit(customerDir, ["branch", "--show-current"]);
        if (!branchResult.ok)
            return branchResult;
        const branch = branchResult.stdout.trim();
        if (!branch) {
            return {
                ok: false,
                error: { code: "INTERNAL", message: "cannot sync a detached workspace HEAD" },
            };
        }
        const upstreamResult = await readOriginUpstream(customerDir, branch);
        if (!upstreamResult.ok)
            return upstreamResult;
        if (!upstreamResult.branch) {
            return { ok: true, result: { state: "no-upstream" } };
        }
        const headBefore = await runGit(customerDir, ["rev-parse", "HEAD"]);
        if (!headBefore.ok)
            return headBefore;
        const fetchResult = await runGit(customerDir, [
            "fetch",
            "--no-tags",
            END_OF_OPTIONS,
            "origin",
            `+refs/heads/${upstreamResult.branch}:refs/remotes/origin/${upstreamResult.branch}`,
        ], { timeoutMs: GIT_PUSH_TIMEOUT_MS });
        if (!fetchResult.ok)
            return fetchResult;
        const mergeResult = await runGit(customerDir, ["merge", "--ff-only", END_OF_OPTIONS, `origin/${upstreamResult.branch}`], { timeoutMs: GIT_COMMIT_TIMEOUT_MS });
        if (!mergeResult.ok)
            return mergeResult;
        const headAfter = await runGit(customerDir, ["rev-parse", "HEAD"]);
        if (!headAfter.ok)
            return headAfter;
        return {
            ok: true,
            result: {
                state: headAfter.stdout.trim() === headBefore.stdout.trim()
                    ? "up-to-date"
                    : "fast-forwarded",
            },
        };
    }
    finally {
        lease.release();
    }
}
/**
 * Commit local workspace changes and push them — the explicit "save now" an
 * exec-off agent triggers via `workspace_commit`. `gitCommit` reports `empty`
 * when there was nothing to stage (a clean no-op). A push that fails AFTER a
 * successful commit is not fatal: the commit is durable on the PVC and the
 * autosave / pre-stop flush retries the push — we surface `pushed:false` +
 * `pushError` so the caller can tell the user rather than silently swallow it.
 */
export async function commitAndPushWorkspace(customerDir, options, deps = COMMIT_AND_PUSH_DEPS) {
    const lease = deps.acquireMutationLease({
        workspaceDir: customerDir,
        gitDir: workspaceMutationLeaseGitDir(customerDir),
    });
    if (!lease)
        return { ok: false, error: { code: "WORKSPACE_BUSY", cwd: customerDir } };
    try {
        let commitOptions = options;
        if (options.beforeCommit) {
            const prepared = await options.beforeCommit();
            if (!prepared.ok)
                return prepared;
            if (prepared.excludePaths?.length)
                commitOptions = { ...options, excludePaths: prepared.excludePaths };
        }
        await options.assertCurrent?.();
        const checkpoint = checkpointBranch(customerDir);
        const commitRes = await deps.gitCommit(customerDir, commitOptions);
        if (!commitRes.ok)
            return commitRes;
        const committed = !commitRes.result.empty;
        if (isTrustedGithubUserCheckout(customerDir)) {
            return {
                ok: true,
                result: { committed, pushed: false, nothingToCommit: !committed, pushError: GITHUB_PUBLISH_REQUIRED },
            };
        }
        const prepareRes = checkpoint
            ? await prepareCheckpointPush(customerDir, checkpoint)
            : await deps.gitPreparePush(customerDir, { author: options.author });
        if (!prepareRes.ok) {
            return {
                ok: true,
                result: {
                    committed,
                    pushed: false,
                    nothingToCommit: !committed,
                    pushError: describeGitError(prepareRes.error),
                },
            };
        }
        await options.assertCurrent?.();
        const head = await deps.gitHeadCommit(customerDir);
        if (!head.ok)
            return head;
        const pushRes = await deps.gitPush(customerDir, { ...prepareRes.target, commit: head.commit });
        if (!pushRes.ok) {
            return {
                ok: true,
                result: {
                    committed,
                    pushed: false,
                    nothingToCommit: !committed,
                    pushError: describeGitError(pushRes.error),
                },
            };
        }
        return {
            ok: true,
            result: { committed, pushed: true, nothingToCommit: !committed, commit: head.commit },
        };
    }
    finally {
        lease.release();
    }
}
function describeGitError(err) {
    switch (err.code) {
        case "GIT_FAILED":
            return `git failed (status ${err.status})`;
        case "TIMEOUT":
            return "git push timed out";
        case "NOT_A_REPO":
            return "not a git repository";
        case "WORKSPACE_BUSY":
            return "workspace is busy";
        default:
            return err.code;
    }
}
export async function gitBranches(customerDir) {
    const r = await runGit(customerDir, [
        "branch",
        "--list",
        "--format=%(refname:short)\t%(HEAD)",
    ]);
    if (!r.ok)
        return r;
    return { ok: true, entries: parseBranchList(r.stdout) };
}
export async function gitCheckout(customerDir, options) {
    const branch = options.branch;
    const checkpoint = checkpointBranch(customerDir);
    if (checkpoint && (options.create || branch !== checkpoint)) {
        return { ok: false, error: { code: "INTERNAL", message: `Project checkpoint requires branch ${checkpoint}` } };
    }
    if (!branch || branch.length > 250 || branch.startsWith("-")) {
        return {
            ok: false,
            error: { code: "INTERNAL", message: "branch name empty, too long, or leading-dash" },
        };
    }
    const args = options.create
        ? ["switch", "-c", branch]
        : ["switch", "--", branch];
    const r = await runGit(customerDir, args);
    if (!r.ok)
        return r;
    return { ok: true };
}
const GITHUB_PUBLISH_REQUIRED = "GitHub project changes must be published through a pull request";
async function assertCheckpointBranch(cwd, branch) {
    const current = await runGit(cwd, ["branch", "--show-current"]);
    if (!current.ok)
        return current;
    return current.stdout.trim() === branch
        ? { ok: true }
        : { ok: false, error: { code: "INTERNAL", message: `Project checkpoint requires branch ${branch}` } };
}
export async function gitPush(customerDir, options = {}) {
    if (isTrustedGithubUserCheckout(customerDir)) {
        return { ok: false, error: { code: "INTERNAL", message: GITHUB_PUBLISH_REQUIRED } };
    }
    const checkpoint = checkpointBranch(customerDir);
    if (checkpoint) {
        if (options.branch && options.branch !== checkpoint) {
            return { ok: false, error: { code: "INTERNAL", message: `Project checkpoint requires branch ${checkpoint}` } };
        }
        const checked = await assertCheckpointBranch(customerDir, checkpoint);
        if (!checked.ok)
            return checked;
        return pushWorkspaceBranch(customerDir, { branch: checkpoint, ...(options.commit ? { commit: options.commit } : {}) });
    }
    return pushWorkspaceBranch(customerDir, options);
}
async function pushWorkspaceBranch(customerDir, options) {
    const { branch, commit, setUpstream } = options;
    if (commit !== undefined && (!branch || !FULL_COMMIT_HASH.test(commit))) {
        return { ok: false, error: { code: "INTERNAL", message: "pinned push requires a branch and a full commit hash" } };
    }
    if (branch && !setUpstream)
        return pushTrackedWorkspaceBranch(customerDir, branch, commit);
    const args = branch
        ? ["push", "--set-upstream", END_OF_OPTIONS, "origin", `HEAD:refs/heads/${branch}`]
        : ["push", END_OF_OPTIONS];
    const pushed = await runGit(customerDir, args, {
        timeoutMs: GIT_PUSH_TIMEOUT_MS,
    });
    if (!pushed.ok)
        return pushed;
    if (branch && commit) {
        const remote = await readRemoteWorkspaceBranch(customerDir, branch);
        if (!remote.ok)
            return remote;
        if (remote.stdout.trim() !== `${commit}\trefs/heads/${branch}`) {
            return { ok: false, error: { code: "INTERNAL", message: "initial push did not publish the pinned commit" } };
        }
    }
    return { ok: true };
}
function readRemoteWorkspaceBranch(customerDir, branch) {
    return runGit(customerDir, ["ls-remote", END_OF_OPTIONS, "origin", `refs/heads/${branch}`], {
        timeoutMs: GIT_PUSH_TIMEOUT_MS,
    });
}
async function pushTrackedWorkspaceBranch(customerDir, branch, commit) {
    const head = commit === undefined ? await runGit(customerDir, ["rev-parse", "HEAD"]) : { ok: true, stdout: commit };
    if (!head.ok)
        return head;
    const remote = await readRemoteWorkspaceBranch(customerDir, branch);
    if (!remote.ok)
        return remote;
    const sha = head.stdout.trim();
    if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha) && remote.stdout.trim() === `${sha}\trefs/heads/${branch}`)
        return { ok: true };
    const pushed = await runGit(customerDir, ["push", END_OF_OPTIONS, "origin", `${commit ?? "HEAD"}:refs/heads/${branch}`], {
        timeoutMs: GIT_PUSH_TIMEOUT_MS,
    });
    return pushed.ok ? { ok: true } : pushed;
}
async function prepareCheckpointPush(cwd, branch) {
    const remote = `refs/remotes/origin/${branch}`;
    const fetched = await runGit(cwd, ["fetch", "--no-tags", "--no-recurse-submodules", "origin", `+refs/heads/${branch}:${remote}`], {
        timeoutMs: GIT_PUSH_TIMEOUT_MS,
    });
    if (!fetched.ok)
        return fetched;
    const behind = await runGit(cwd, ["merge-base", "--is-ancestor", "HEAD", remote]);
    if (behind.ok) {
        const merged = await runGit(cwd, ["merge", "--ff-only", remote]);
        if (!merged.ok)
            return merged;
    }
    else if (behind.error.code !== "GIT_FAILED" || behind.error.status !== 1) {
        return behind;
    }
    return { ok: true, target: { branch, setUpstream: false } };
}
export async function gitPreparePush(customerDir, options) {
    const branchResult = await runGit(customerDir, ["branch", "--show-current"]);
    if (!branchResult.ok)
        return branchResult;
    const branch = branchResult.stdout.trim();
    if (!branch) {
        return {
            ok: false,
            error: { code: "INTERNAL", message: "cannot push a detached workspace HEAD" },
        };
    }
    const upstreamResult = await readOriginUpstream(customerDir, branch);
    if (!upstreamResult.ok)
        return upstreamResult;
    if (!upstreamResult.branch) {
        return prepareUntrackedBranchPush(customerDir, {
            author: options.author,
            branch,
        });
    }
    const syncResult = await gitRebaseOntoRemoteBranch(customerDir, {
        author: options.author,
        branch: upstreamResult.branch,
    });
    if (!syncResult.ok)
        return syncResult;
    return {
        ok: true,
        target: { branch: upstreamResult.branch, setUpstream: false },
    };
}
async function readOriginUpstream(customerDir, branch) {
    const remoteConfig = await runGit(customerDir, [
        "config",
        "--get",
        `branch.${branch}.remote`,
    ]);
    const mergeConfig = await runGit(customerDir, [
        "config",
        "--get",
        `branch.${branch}.merge`,
    ]);
    const remoteMissing = gitConfigIsMissing(remoteConfig);
    const mergeMissing = gitConfigIsMissing(mergeConfig);
    if (remoteMissing && mergeMissing)
        return { ok: true, branch: null };
    if (remoteMissing || mergeMissing) {
        return {
            ok: false,
            error: { code: "INTERNAL", message: `incomplete upstream configuration for ${branch}` },
        };
    }
    if (!remoteConfig.ok)
        return remoteConfig;
    if (!mergeConfig.ok)
        return mergeConfig;
    const remote = remoteConfig.stdout.trim();
    const mergeRef = mergeConfig.stdout.trim();
    if (remote !== "origin" || !mergeRef.startsWith("refs/heads/")) {
        return {
            ok: false,
            error: { code: "INTERNAL", message: `unsupported upstream for ${branch}` },
        };
    }
    return { ok: true, branch: mergeRef.slice("refs/heads/".length) };
}
async function prepareUntrackedBranchPush(customerDir, options) {
    const remoteBranchResult = await runGit(customerDir, [
        "ls-remote",
        "--exit-code",
        "--heads",
        END_OF_OPTIONS,
        "origin",
        `refs/heads/${options.branch}`,
    ], { timeoutMs: GIT_PUSH_TIMEOUT_MS });
    if (remoteBranchResult.ok) {
        const syncResult = await gitRebaseOntoRemoteBranch(customerDir, {
            author: options.author,
            branch: options.branch,
        });
        if (!syncResult.ok)
            return syncResult;
    }
    else if (!remoteBranchIsMissing(remoteBranchResult)) {
        return remoteBranchResult;
    }
    return {
        ok: true,
        target: { branch: options.branch, setUpstream: false },
    };
}
function remoteBranchIsMissing(result) {
    return result.error.code === "GIT_FAILED" && result.error.status === 2;
}
function gitConfigIsMissing(result) {
    return !result.ok && result.error.code === "GIT_FAILED" && result.error.status === 1;
}
async function gitRebaseOntoRemoteBranch(customerDir, options) {
    const fetchResult = await runGit(customerDir, [
        "fetch",
        "--no-tags",
        END_OF_OPTIONS,
        "origin",
        `+refs/heads/${options.branch}:refs/remotes/origin/${options.branch}`,
    ], { timeoutMs: GIT_PUSH_TIMEOUT_MS });
    if (!fetchResult.ok)
        return fetchResult;
    const rebaseResult = await runGit(customerDir, [
        "-c", `user.name=${options.author.name}`,
        "-c", `user.email=${options.author.email}`,
        "rebase", END_OF_OPTIONS, `origin/${options.branch}`,
    ], { timeoutMs: GIT_COMMIT_TIMEOUT_MS });
    if (rebaseResult.ok)
        return { ok: true };
    const resolution = await resolveDuplicateAssetUpload(customerDir, options.author);
    if (resolution?.ok)
        return { ok: true };
    const abortResult = await runGit(customerDir, ["rebase", "--abort"], { timeoutMs: GIT_COMMIT_TIMEOUT_MS });
    if (!abortResult.ok) {
        return {
            ok: false,
            error: {
                code: "INTERNAL",
                message: `git rebase failed and abort failed: ${describeGitError(abortResult.error)}`,
            },
        };
    }
    return rebaseResult;
}
const ASSET_MANIFEST = ".files/manifest.json";
async function hasRegularManifestConflict(cwd) {
    const conflicts = await runGit(cwd, ["ls-files", "--unmerged", "-z"]);
    if (!conflicts.ok)
        return false;
    const rows = conflicts.stdout.split(NUL).filter(Boolean);
    if (rows.length < 2 || rows.length > 3)
        return false;
    const stages = rows.map((row) => /^100644 [a-f0-9]{40,64} ([123])\t\.files\/manifest\.json$/u.exec(row)?.[1]);
    if (stages.some((stage) => !stage) || !stages.includes("2") || !stages.includes("3"))
        return false;
    try {
        const directory = await fs.lstat(path.join(cwd, ".files"));
        const file = await fs.lstat(path.join(cwd, ASSET_MANIFEST));
        return directory.isDirectory() && !directory.isSymbolicLink() && file.isFile() && !file.isSymbolicLink();
    }
    catch {
        return false;
    }
}
async function resolveDuplicateAssetUpload(cwd, author) {
    const identity = userGitIdentity(cwd);
    if (!identity || path.relative(identity.usersRoot, cwd).split(path.sep).length !== 3)
        return null;
    if (!await hasRegularManifestConflict(cwd))
        return null;
    const remote = await runGit(cwd, ["show", `:2:${ASSET_MANIFEST}`]);
    const local = await runGit(cwd, ["show", `:3:${ASSET_MANIFEST}`]);
    const prefix = `customers/${identity.slug}/projects/${identity.repoName}`;
    if (!remote.ok || !local.ok || !isDuplicateAssetUpload(remote.stdout, local.stdout, prefix))
        return null;
    const checkout = await runGit(cwd, ["checkout", "--ours", "--", ASSET_MANIFEST]);
    if (!checkout.ok)
        return null;
    const add = await runGit(cwd, ["add", "--", ASSET_MANIFEST]);
    if (!add.ok)
        return null;
    const staged = await runGit(cwd, ["diff", "--cached", "--quiet"]);
    const command = staged.ok ? "--skip" : "--continue";
    if (!staged.ok && (staged.error.code !== "GIT_FAILED" || staged.error.status !== 1))
        return null;
    const continued = await runGit(cwd, [
        "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`,
        "rebase", command,
    ], { timeoutMs: GIT_COMMIT_TIMEOUT_MS, noEdit: true });
    return continued.ok ? continued : null;
}
function clampLimit(n) {
    if (!Number.isFinite(n) || n < 1)
        return 1;
    if (n > 200)
        return 200;
    return Math.floor(n);
}
export const WORKSPACE_GIT_HARDENING_PINS = [
    "-c", "core.fsmonitor=",
    "-c", "core.pager=cat",
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false",
    "-c", "gpg.program=/bin/false",
    "-c", "protocol.allow=never",
    "-c", "protocol.ssh.allow=always",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.file.allow=never",
    "-c", "protocol.ext.allow=never",
];
export const WORKSPACE_GIT_HARDENING_ENV = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_EDITOR: "/bin/false",
    GIT_SEQUENCE_EDITOR: "/bin/false",
    GIT_PAGER: "cat",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_OPTIONAL_LOCKS: "0",
};
const UNSAFE_LOCAL_CONFIG_PREFIXES = [
    "alias.", "credential.", "diff.", "filter.", "http.", "https.",
    "include.", "includeif.", "merge.", "protocol.", "url.",
];
const UNSAFE_LOCAL_CONFIG_KEYS = new Set([
    "core.askpass", "core.editor", "core.fsmonitor", "core.gitproxy",
    "core.hookspath", "core.pager", "core.sshcommand", "core.worktree",
    "extensions.worktreeconfig", "gpg.program", "sequence.editor", "ssh.variant",
]);
function isUnsafeLocalConfigKey(key) {
    const normalized = key.toLowerCase();
    return UNSAFE_LOCAL_CONFIG_KEYS.has(normalized)
        || UNSAFE_LOCAL_CONFIG_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
function userGitIdentity(cwd) {
    const usersRoot = path.resolve(process.env.CUSTOMERS_DIR ?? "/home/node/.openclaw/customers");
    const relative = path.relative(usersRoot, path.resolve(cwd));
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return null;
    const parts = relative.split(path.sep);
    const metadataRoot = path.join(path.dirname(usersRoot), "git-metadata");
    const slug = parts[0] ?? "";
    if (!isSafeSlug(slug))
        return null;
    if (parts.length === 1) {
        return {
            usersRoot,
            slug,
            repoName: "workspace",
            metadataDir: path.join(metadataRoot, slug, "workspace.git"),
        };
    }
    const projectSlug = parts[2] ?? "";
    if (parts.length === 3 && parts[1] === "projects" && isSafeSlug(projectSlug)) {
        return {
            usersRoot,
            slug,
            repoName: projectSlug,
            metadataDir: path.join(metadataRoot, slug, "projects", `${projectSlug}.git`),
        };
    }
    return null;
}
export function userGitMetadataDir(cwd) {
    return userGitIdentity(cwd)?.metadataDir ?? null;
}
export function trustedWorkspaceGitDir(cwd) {
    return userGitMetadataDir(cwd) ?? path.join(cwd, ".git");
}
export function workspaceMutationLeaseGitDir(cwd) {
    const identity = userGitIdentity(cwd);
    if (!identity || identity.repoName === "workspace")
        return trustedWorkspaceGitDir(cwd);
    return projectMutationLeaseGitDir(cwd, identity.usersRoot);
}
export async function runWorkspaceGitMutation(cwd, work) {
    const lease = acquireWorkspaceMutationLeaseSync({
        workspaceDir: cwd,
        gitDir: workspaceMutationLeaseGitDir(cwd),
    });
    if (!lease)
        return { ok: false, error: { code: "WORKSPACE_BUSY", cwd } };
    try {
        return { ok: true, result: await work() };
    }
    finally {
        lease.release();
    }
}
export function workspaceGitCommandArgs(cwd, args, callerGithubCredential = false) {
    return [
        ...WORKSPACE_GIT_HARDENING_PINS,
        ...(callerGithubCredential
            ? [
                "-c",
                githubCredentialHelper(),
            ]
            : []),
        "--git-dir",
        trustedWorkspaceGitDir(cwd),
        "--work-tree",
        cwd,
        ...args,
    ];
}
function githubCredentialHelper() {
    const secretField = ["pass", "word"].join("");
    return `credential.https://github.com.helper=!f() { test "$1" = get || exit 0; printf '%s\\n' username=x-access-token ${secretField}="$OCTOGEE_GITHUB_TOKEN"; }; f`;
}
export function workspaceGitEnvironment(source = process.env, cwd, githubToken) {
    const environment = { ...source, ...WORKSPACE_GIT_HARDENING_ENV };
    for (const key of Object.keys(environment)) {
        if (key === "GH_TOKEN"
            || key === "GITHUB_TOKEN"
            || key === "GH_ENTERPRISE_TOKEN"
            || key === "GITHUB_ENTERPRISE_TOKEN"
            || key === "OCTOGEE_GITHUB_TOKEN"
            || key === "GIT_CONFIG"
            || key === "GIT_CONFIG_COUNT"
            || key === "GIT_CONFIG_PARAMETERS"
            || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) {
            delete environment[key];
        }
    }
    if (githubToken) {
        environment.OCTOGEE_GITHUB_TOKEN = githubToken;
    }
    const identity = cwd ? userGitIdentity(cwd) : null;
    if (identity) {
        const keyPath = path.join(path.dirname(identity.usersRoot), "customer-keys", identity.slug, "id_ed25519");
        environment.GIT_SSH_COMMAND = [
            "/usr/bin/ssh",
            "-i", JSON.stringify(keyPath),
            "-F", "/home/node/.ssh/config",
            "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR",
        ].join(" ");
    }
    return environment;
}
export function isTrustedGithubUserCheckout(cwd) {
    const identity = userGitIdentity(cwd);
    if (!identity)
        return false;
    const receipt = `${identity.metadataDir}.octogee-trusted-v3`;
    try {
        const metadataStat = lstatSync(identity.metadataDir);
        if (!metadataStat.isDirectory())
            return false;
        const receiptContents = readGitMetadataText(receipt, 1024);
        if (receiptContents === null)
            return false;
        return expectedUserRemoteUrl(cwd, receiptContents)
            ?.startsWith("https://github.com/") === true;
    }
    catch {
        return false;
    }
}
export function isTrustedGiteaUserCheckout(cwd, repoName) {
    const identity = userGitIdentity(cwd);
    if (!identity || !isSafeSlug(repoName))
        return false;
    try {
        return readGitMetadataText(`${identity.metadataDir}.octogee-trusted-v3`, 1024) ===
            `octogee-customer-git-v3\ngitea:${repoName}\n`;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
// eslint-disable-next-line complexity -- validates both canonical receipt grammars and their exact remote projections
function expectedUserRemoteUrl(cwd, receiptContents) {
    const identity = userGitIdentity(cwd);
    if (!identity)
        return null;
    const lines = receiptContents.split("\n");
    if (lines.length !== 3 || lines[0] !== "octogee-customer-git-v3" || lines[2] !== "") {
        return null;
    }
    const source = lines[1] ?? "";
    if (source.startsWith("gitea:")) {
        const repoName = source.slice("gitea:".length);
        if (!isSafeSlug(repoName))
            return null;
        const host = process.env.GIT_SSH_HOST?.trim() || "gitea";
        return `git@${host}:${identity.slug}/${repoName}.git`;
    }
    if (source.startsWith("github:")) {
        const [owner, repo, extra] = source.slice("github:".length).split("/");
        if (!owner || !repo || extra || !isSafeSlug(owner) || !isSafeSlug(repo))
            return null;
        return `https://github.com/${owner}/${repo}.git`;
    }
    return null;
}
const ORIGIN_URL = "remote.origin.url";
const ORIGIN_FETCH = "remote.origin.fetch";
export function isGithubProjectCheckpoint(cwd) {
    return checkpointBranch(cwd) !== null;
}
function checkpointBranch(cwd, contents) {
    const identity = userGitIdentity(cwd);
    if (!identity)
        return null;
    const receipt = contents ?? readGitMetadataText(`${identity.metadataDir}.octogee-trusted-v3`, 1024);
    const repo = /^octogee-customer-git-v3\ngitea:([^\n]+)\n$/u.exec(receipt ?? "")?.[1];
    return repo ? githubCheckpointBranch(repo) : null;
}
const MALFORMED_REPOSITORY = "<malformed>";
async function validateTrustedMetadata(gitDir, metadataDir, metadataRoot) {
    const receipt = `${metadataDir}.octogee-trusted-v3`;
    try {
        const unsafeEntry = findUnsafeGitMetadataEntry(gitDir, metadataRoot);
        if (unsafeEntry)
            return { error: `<unsafe-metadata:${unsafeEntry}>`, receiptContents: "" };
        const receiptContents = readGitMetadataText(receipt, 1024);
        if (receiptContents === null)
            return { error: "<untrusted-metadata>", receiptContents: "" };
        const objects = await fs.lstat(path.join(gitDir, "objects"));
        return {
            error: objects.isDirectory() && !objects.isSymbolicLink()
                ? null
                : "<unsafe-metadata:objects>",
            receiptContents,
        };
    }
    catch {
        return { error: "<untrusted-metadata>", receiptContents: "" };
    }
}
function configEntryParts(entry) {
    const separator = entry.indexOf("\n");
    return separator < 1
        ? null
        : { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
}
function validRemoteConfigEntry(key, value, expectedRemote) {
    if (key === ORIGIN_URL)
        return value === expectedRemote;
    return key === ORIGIN_FETCH && value === "+refs/heads/*:refs/remotes/origin/*";
}
function unsafeBranchConfigEntry(entries, branch) {
    let mainRemoteCount = 0;
    let mainMergeCount = 0;
    for (const { key, value } of entries) {
        if (key === `branch.${branch}.remote` && value === "origin")
            mainRemoteCount++;
        else if (key === `branch.${branch}.merge` && value === `refs/heads/${branch}`)
            mainMergeCount++;
        else
            return key;
    }
    const hasNoMainUpstream = mainRemoteCount === 0 && mainMergeCount === 0;
    const hasCanonicalMainUpstream = mainRemoteCount === 1 && mainMergeCount === 1;
    return hasNoMainUpstream || hasCanonicalMainUpstream ? null : `branch.${branch}`;
}
function unsafeConfigEntry(entries, expectedRemote, branch) {
    let originUrlCount = 0;
    let originFetchCount = 0;
    const mainBranchEntries = [];
    for (const entry of entries) {
        const parsed = configEntryParts(entry);
        if (!parsed)
            return MALFORMED_REPOSITORY;
        const { key, value } = parsed;
        if (isUnsafeLocalConfigKey(key))
            return key;
        if (expectedRemote && key.startsWith("branch.")) {
            mainBranchEntries.push(parsed);
            continue;
        }
        if (!expectedRemote)
            continue;
        if (!key.startsWith("remote."))
            continue;
        if (!validRemoteConfigEntry(key, value, expectedRemote))
            return key;
        if (key === ORIGIN_URL)
            originUrlCount++;
        else
            originFetchCount++;
    }
    if (!expectedRemote)
        return null;
    if (originUrlCount !== 1 || originFetchCount !== 1)
        return "remote.origin";
    return unsafeBranchConfigEntry(mainBranchEntries, branch);
}
async function unsafeLocalRepositoryConfigKey(cwd) {
    const gitDir = trustedWorkspaceGitDir(cwd);
    const identity = userGitIdentity(cwd);
    let receiptContents = "";
    if (identity) {
        const validation = await validateTrustedMetadata(gitDir, identity.metadataDir, path.join(path.dirname(identity.usersRoot), "git-metadata"));
        if (validation.error)
            return validation.error;
        receiptContents = validation.receiptContents;
        if (expectedUserRemoteUrl(cwd, receiptContents) === null)
            return "<untrusted-metadata>";
    }
    const configPath = path.join(gitDir, "config");
    try {
        const stat = await fs.lstat(configPath);
        if (!stat.isFile() || stat.isSymbolicLink())
            return MALFORMED_REPOSITORY;
    }
    catch (error) {
        const code = error.code;
        return code === "ENOENT" ? null : MALFORMED_REPOSITORY;
    }
    return new Promise((resolve) => {
        const chunks = [];
        let child;
        try {
            child = spawn("/usr/bin/git", ["config", "--file", configPath, "--null", "--list"], {
                cwd,
                stdio: ["ignore", "pipe", "ignore"],
                env: workspaceGitEnvironment(process.env, cwd),
            });
        }
        catch {
            resolve(MALFORMED_REPOSITORY);
            return;
        }
        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.once("error", () => resolve(MALFORMED_REPOSITORY));
        child.once("close", (status) => {
            if (status !== 0) {
                resolve(MALFORMED_REPOSITORY);
                return;
            }
            const entries = Buffer.concat(chunks).toString("utf8").split(NUL).filter(Boolean);
            const expectedRemote = expectedUserRemoteUrl(cwd, receiptContents);
            resolve(unsafeConfigEntry(entries, expectedRemote, checkpointBranch(cwd, receiptContents) ?? "main"));
        });
    });
}
async function runGit(cwd, args, options = {}) {
    const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
    const unsafeConfigKey = await unsafeLocalRepositoryConfigKey(cwd);
    if (unsafeConfigKey) {
        return {
            ok: false,
            error: {
                code: "INTERNAL",
                message: `repository local config contains an unsafe key: ${unsafeConfigKey}`,
            },
        };
    }
    const fullArgs = workspaceGitCommandArgs(cwd, args, Boolean(options.githubToken));
    return new Promise((resolve) => {
        const start = Date.now();
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdoutChunks = [];
        const stderrChunks = [];
        let timedOut = false;
        let outputCapped = false;
        let inputError;
        let proc;
        try {
            proc = spawn("/usr/bin/git", fullArgs, {
                cwd,
                stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
                env: { ...workspaceGitEnvironment(process.env, cwd, options.githubToken),
                    ...(options.noEdit ? { GIT_EDITOR: "/usr/bin/true" } : {}),
                },
            });
        }
        catch (err) {
            resolve({
                ok: false,
                error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
            });
            return;
        }
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill("SIGTERM");
        }, timeoutMs);
        proc.stdout?.on("data", (chunk) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_OUTPUT_BYTES) {
                outputCapped = true;
                proc.kill("SIGTERM");
                return;
            }
            stdoutChunks.push(chunk);
        });
        proc.stderr?.on("data", (chunk) => {
            stderrBytes += chunk.length;
            if (stderrBytes < 64 * 1024)
                stderrChunks.push(chunk);
        });
        proc.on("error", (err) => {
            clearTimeout(timer);
            resolve({
                ok: false,
                error: { code: "INTERNAL", message: err.message },
            });
        });
        proc.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) {
                resolve({
                    ok: false,
                    error: { code: "TIMEOUT", cwd, durationMs: Date.now() - start },
                });
                return;
            }
            if (outputCapped) {
                resolve({
                    ok: false,
                    error: { code: "OUTPUT_TOO_LARGE", cwd, cap: MAX_OUTPUT_BYTES },
                });
                return;
            }
            const stdout = Buffer.concat(stdoutChunks).toString("utf8");
            const stderr = Buffer.concat(stderrChunks).toString("utf8");
            if (code !== 0) {
                if (/not a git repository/i.test(stderr)) {
                    resolve({ ok: false, error: { code: "NOT_A_REPO", cwd } });
                    return;
                }
                resolve({
                    ok: false,
                    error: { code: "GIT_FAILED", cwd, status: code ?? -1, stderr: stderr.slice(0, 500) },
                });
                return;
            }
            if (inputError) {
                resolve({ ok: false, error: { code: "INTERNAL", message: inputError.message } });
                return;
            }
            resolve({ ok: true, stdout, stderr });
        });
        if (options.input !== undefined) {
            proc.stdin.on("error", error => { inputError = error; });
            proc.stdin.end(options.input);
        }
    });
}
export function parsePorcelain(stdout) {
    if (!stdout)
        return [];
    const records = stdout.split(NUL).filter((r) => r.length > 0);
    const out = [];
    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (rec.length < 3)
            continue;
        const xy = rec.slice(0, 2);
        const filePath = rec.slice(3);
        const change = porcelainXyToChange(xy);
        if (change === "renamed") {
            i++;
        }
        out.push({ path: filePath, change });
    }
    return out;
}
function porcelainXyToChange(xy) {
    if (xy.includes("R") || xy.includes("C"))
        return "renamed";
    if (xy === "??")
        return "untracked";
    if (xy.includes("D"))
        return "deleted";
    if (xy.includes("A"))
        return "added";
    return "modified";
}
export function parseLog(stdout) {
    if (!stdout)
        return [];
    const records = stdout.split(RECORD_SEPARATOR).filter((r) => r.trim().length > 0);
    const out = [];
    for (const rec of records) {
        const parts = rec.split(UNIT_SEPARATOR);
        if (parts.length < 4)
            continue;
        const ts = Number.parseInt(parts[2], 10);
        if (!Number.isFinite(ts))
            continue;
        out.push({
            sha: parts[0],
            author: parts[1],
            ts,
            subject: parts[3],
        });
    }
    return out;
}
export function parseBranchList(stdout) {
    if (!stdout)
        return [];
    const out = [];
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const tabIdx = trimmed.indexOf("\t");
        const name = tabIdx >= 0 ? trimmed.slice(0, tabIdx) : trimmed;
        const headFlag = tabIdx >= 0 ? trimmed.slice(tabIdx + 1) : "";
        if (!name)
            continue;
        out.push({ name, current: headFlag === "*" });
    }
    return out;
}
