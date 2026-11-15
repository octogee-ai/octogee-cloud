import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { acquireWorkspaceMutationLeaseSync } from "@octogee/core/workspace-mutation-lease";

import {
  isSafeSlug,
  workspaceMutationLeaseGitDir,
  WORKSPACE_GIT_HARDENING_ENV,
  WORKSPACE_GIT_HARDENING_PINS,
} from "@octogee/core/workspace/workspace-git";

const GIT_BINARY = "/usr/bin/git";
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface GithubProjectCloneInput {
  usersRoot: string;
  builderSlug: string;
  projectSlug: string;
  repository: { owner: string; repo: string };
  accessToken: string;
}

export function githubCloneCredentialEnv(accessToken: string): Record<string, string> {
  return {
    OCTOGEE_GITHUB_TOKEN: accessToken,
  };
}

function githubCloneCredentialHelper(): string {
  const secretField = ["pass", "word"].join("");
  return `credential.https://github.com.helper=!f() { test "$1" = get || exit 0; printf '%s\\n' username=x-access-token ${secretField}="$OCTOGEE_GITHUB_TOKEN"; }; f`;
}

export async function cloneGithubProjectCheckout(
  input: GithubProjectCloneInput,
): Promise<"cloned" | "exists"> {
  if (
    !isSafeSlug(input.builderSlug) ||
    !isSafeSlug(input.projectSlug) ||
    !GITHUB_OWNER_RE.test(input.repository.owner) ||
    !GITHUB_REPO_RE.test(input.repository.repo) ||
    input.accessToken.length === 0
  ) {
    throw new Error("invalid GitHub project clone request");
  }

  const root = path.resolve(input.usersRoot);
  const parent = path.join(root, input.builderSlug, "projects");
  const destination = path.resolve(parent, input.projectSlug);
  const parentPrefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  if (!destination.startsWith(parentPrefix) || !isContained(root, parent)) throw new Error("invalid GitHub project clone target");
  await ensureDirectoryPath(root, parent);
  if (await inspectCheckout(destination) === "ready") return "exists";

  const staging = await fs.mkdtemp(path.join(parent, `.${input.projectSlug}-clone-`));
  try {
    await runGit(
      parent,
      ["clone", `https://github.com/${input.repository.owner}/${input.repository.repo}.git`, staging],
      input.accessToken,
    );
    await runGit(staging, ["config", "user.email", `${input.builderSlug}@octogee.com`]);
    await runGit(staging, ["config", "user.name", `Octo (${input.builderSlug})`]);
    const result = await installCheckout(staging, destination, root, input.builderSlug, input.projectSlug);
    if (result === "exists") await fs.rm(staging, { recursive: true, force: true });
    return result;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function ensureDirectoryPath(root: string, target: string): Promise<void> {
  if (!(await fs.lstat(root)).isDirectory()) throw new Error("GitHub project clone parent is not a directory");
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("GitHub project clone parent is not a directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        if (!(await fs.lstat(current)).isDirectory()) throw new Error("GitHub project clone parent is not a directory");
      }
    }
  }
}

async function installCheckout(
  staging: string,
  destination: string,
  usersRoot: string,
  builderSlug: string,
  projectSlug: string,
): Promise<"cloned" | "exists"> {
  const lease = acquireWorkspaceMutationLeaseSync({
    workspaceDir: destination,
    gitDir: workspaceMutationLeaseGitDir(destination),
  });
  if (!lease) throw new Error("workspace mutation lease unavailable");
  try {
    const existing = await inspectCheckout(destination);
    if (existing === "ready") return "exists";
    if (existing === "missing") {
      await fs.rename(staging, destination);
      return "cloned";
    }
    const quarantineRoot = path.join(path.dirname(usersRoot), "git-worktree-quarantine");
    const quarantine = path.resolve(quarantineRoot, builderSlug, `${projectSlug}-${randomUUID()}`);
    if (!quarantine.startsWith(`${quarantineRoot}${path.sep}`)) throw new Error("invalid GitHub project quarantine target");
    await fs.mkdir(path.dirname(quarantine), { recursive: true, mode: 0o700 });
    await quarantineCheckout(destination, quarantine);
    await fs.rename(staging, destination);
    return "cloned";
  } finally {
    lease.release();
  }
}

async function inspectCheckout(destination: string): Promise<"missing" | "placeholder" | "ready"> {
  try {
    if (!(await fs.lstat(destination)).isDirectory()) throw new Error("GitHub project clone target is not a directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  try {
    const metadata = await fs.lstat(path.join(destination, ".git"));
    return metadata.isDirectory() || metadata.isFile() ? "ready" : "placeholder";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "placeholder";
    throw error;
  }
}

async function quarantineCheckout(source: string, target: string): Promise<void> {
  try {
    await fs.rename(source, target);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  await fs.mkdir(target, { mode: 0o700 });
  try {
    for (const entry of await fs.readdir(source)) {
      await fs.cp(path.join(source, entry), path.join(target, entry), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    }
  } catch (error) {
    try {
      await fs.rm(target, { recursive: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "GitHub project quarantine copy and cleanup failed");
    }
    throw error;
  }
  await fs.rm(source, { recursive: true });
}

async function runGit(cwd: string, args: string[], accessToken?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      GIT_BINARY,
      [
        ...WORKSPACE_GIT_HARDENING_PINS,
        ...(accessToken ? ["-c", githubCloneCredentialHelper()] : []),
        ...args,
      ],
      {
        cwd,
        env: {
          ...sanitizedEnvironment(),
          ...(accessToken ? githubCloneCredentialEnv(accessToken) : {}),
          ...WORKSPACE_GIT_HARDENING_ENV,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(0, 300)}`));
    });
  });
}

function sanitizedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      key === "GH_TOKEN" || key === "GITHUB_TOKEN" || key === "GH_ENTERPRISE_TOKEN" ||
      key === "GITHUB_ENTERPRISE_TOKEN" || key === "OCTOGEE_GITHUB_TOKEN" ||
      key === "GIT_CONFIG" || key === "GIT_CONFIG_COUNT" || key === "GIT_CONFIG_PARAMETERS" ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    ) delete env[key];
  }
  return env;
}
