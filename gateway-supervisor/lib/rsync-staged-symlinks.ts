import fs from "node:fs/promises";
import path from "node:path";

export const STAGED_RSYNC_COPY_OPTIONS = ["-a", "--munge-links"];
export const RSYNC_DAEMON_SYMLINK_POLICY = "munge symlinks = yes";
const MUNGED_PREFIX = "/rsyncd-munged/";

async function statIfPresent(filename: string) {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function decodedTarget(value: string, staged: boolean): string {
  if (staged) {
    if (!value.startsWith(MUNGED_PREFIX)) throw new Error("missing daemon encoding");
    value = value.slice(MUNGED_PREFIX.length);
  }
  if (!value || path.posix.isAbsolute(value)) throw new Error("absolute or previously encoded target");
  return value;
}

async function assertRealBoundary(root: string, boundary: string): Promise<void> {
  let current = root;
  for (const part of boundary.split("/")) {
    current = path.join(current, part);
    const stat = await statIfPresent(current);
    if (stat && !stat.isDirectory()) throw new Error("workspace boundary is not a real directory");
    if (!stat) return;
  }
}

async function assertTargetWithinBoundary(stageDir: string, importDir: string, boundary: string, relative: string, value: string): Promise<void> {
  await assertRealBoundary(importDir, boundary);
  const pending = [...path.posix.dirname(relative).slice(boundary.length).split("/"), ...value.split("/")];
  const resolved: string[] = [];
  let followed = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!resolved.length) throw new Error("target leaves its workspace");
      resolved.pop();
      continue;
    }
    const candidate = path.posix.join(boundary, ...resolved, part);
    const staged = await statIfPresent(path.join(stageDir, candidate));
    const stat = staged ?? await statIfPresent(path.join(importDir, candidate));
    if (stat?.isSymbolicLink()) {
      if (++followed > 40) throw new Error("symlink cycle or excessive chain");
      const target = decodedTarget(await fs.readlink(path.join(staged ? stageDir : importDir, candidate)), !!staged);
      pending.unshift(...target.split("/"));
    } else {
      resolved.push(part);
    }
  }
}

export async function assertSafeStagedSymlinks(stageDir: string, importDir: string, slug: string): Promise<void> {
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(stageDir, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) await walk(relative);
      if (!entry.isSymbolicLink()) continue;
      try {
        const parts = relative.split("/");
        if (parts[0] !== "customers" || parts[1] !== slug || parts.length < 3) {
          throw new Error("link is outside user workspace files");
        }
        const boundary = parts[2] === "projects" ? parts.slice(0, 4).join("/") : parts.slice(0, 2).join("/");
        if (relative === boundary) throw new Error("workspace boundary is a symlink");
        const value = decodedTarget(await fs.readlink(path.join(stageDir, relative)), true);
        await assertTargetWithinBoundary(stageDir, importDir, boundary, relative, value);
      } catch (error) {
        throw new Error(`unsafe staged symlink ${relative}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  await walk("");
}
