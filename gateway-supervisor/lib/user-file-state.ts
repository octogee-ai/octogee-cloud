import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isValidUsername } from "@octogee/shared/types/identity";
import { brokerTokenExpiryDirectory, removeBrokerTokenExpiriesForSlug } from "./broker-token-refresh.js";
import { OPENCLAW_DIR } from "./config.js";
import { clearMigratingInPin } from "./local-default-agent-wired.js";

const run = promisify(execFile);
const DEPARTED_USER_GIT_STATE_ROOTS = [
  "git-metadata",
  "git-metadata-quarantine",
  "git-source-switch-locks",
  "git-worktree-quarantine",
  "git-metadata-source-switch-backups",
];
function userPath(root: string, slug: string): string {
  if (!isValidUsername(slug)) throw new Error("Invalid user slug");
  return path.join(root, "customers", slug);
}

async function userFileStateDirectories(root: string, slug: string): Promise<Array<{ path: string; device: bigint }>> {
  userPath(root, slug);
  const sources: Array<{ path: string; device: bigint }> = [];
  for (const directory of ["customers", "git-metadata", "customer-keys"]) {
    const relative = path.join(directory, slug);
    try {
      const stat = await fs.lstat(path.join(root, relative), { bigint: true });
      if (!stat.isDirectory()) throw new Error(`User state is not a directory: ${relative}`);
      sources.push({ path: relative, device: stat.dev });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return sources;
}

export async function userFileStatePaths(root: string, slug: string): Promise<Array<{ cwd: string; path: string }>> {
  return (await userFileStateDirectories(root, slug)).map(source => ({ cwd: root, path: source.path }));
}

export async function flushUserFiles(slug: string, { root = OPENCLAW_DIR, persistProjects }: { root?: string; persistProjects?: (slug: string) => Promise<void> } = {}): Promise<void> {
  const workspace = userPath(root, slug);
  if (!(await fs.lstat(workspace)).isDirectory()) throw new Error(`User workspace is not a directory: ${slug}`);
  await persistProjects?.(slug);
  const synced = new Set<bigint>();
  for (const source of await userFileStateDirectories(root, slug)) {
    if (synced.has(source.device)) continue;
    await run("/usr/bin/sync", ["-f", path.join(root, source.path)]);
    synced.add(source.device);
  }
}

export async function flushAllUserFiles({ root = OPENCLAW_DIR, persistProjects, slugs }: { root?: string; persistProjects?: (slug: string) => Promise<void>; slugs?: readonly string[] } = {}): Promise<void> {
  const usersRoot = path.join(root, "customers");
  let targets = slugs;
  try { targets ??= (await fs.readdir(usersRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && isValidUsername(entry.name)).map(entry => entry.name); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const failures: Error[] = [];
  for (const slug of targets) {
    try { await flushUserFiles(slug, { root, persistProjects }); }
    catch (error) { failures.push(new Error(`${slug}: ${String(error)}`, { cause: error })); }
  }
  if (failures.length) throw new AggregateError(failures, `User file flush failed: ${failures.map(error => error.message).join("; ")}`);
}

export async function removeDepartedUserFileState(
  slug: string,
  { root = OPENCLAW_DIR, log }: { root?: string; log: (message: string) => void },
): Promise<void> {
  const workspace = userPath(root, slug);
  for (const directory of DEPARTED_USER_GIT_STATE_ROOTS) {
    await fs.rm(path.join(root, directory, slug), { recursive: true, force: true });
  }
  removeBrokerTokenExpiriesForSlug(brokerTokenExpiryDirectory(root), slug, log);
  await fs.rm(workspace, { recursive: true, force: true });
  clearMigratingInPin(path.join(root, "customers"), slug);
}
