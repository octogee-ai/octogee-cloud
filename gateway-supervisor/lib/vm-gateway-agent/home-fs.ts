import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob, type Stats } from "node:fs";
import { chmod, chown, lstat, mkdir, mkdtemp, readdir, rename, rm, stat, statfs, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { HOME_REPLACE_STAGING_PREFIX, type HomeFs, type HomeShell } from "./home-checkpoint.js";

const exec = promisify(execFile);

export const homeShell: HomeShell = {
  run: async (command, args) => {
    try {
      const { stdout, stderr } = await exec(command, args, { maxBuffer: 16 * 1024 * 1024 });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      return { code: typeof failure.code === "number" ? failure.code : 127, stdout: failure.stdout ?? "", stderr: `${failure.message}\n${failure.stderr ?? ""}` };
    }
  },
};

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function restoreBackup(backup: string, target: string): Promise<void> {
  try {
    await lstat(target);
    throw new Error(`home restore target was recreated: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(backup, target);
}

async function restorationDirectory(path: string): Promise<Stats | null> {
  let metadata: Stats;
  try { metadata = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isDirectory()) throw new Error(`home restore path is not a directory: ${path}`);
  return metadata;
}

interface PreservedHomePaths {
  entries: readonly string[];
  metadata: readonly string[];
}

async function restoreDirectoryMetadata(target: string, metadata: Stats | null, existing: Stats | null, owner: Pick<Stats, "uid" | "gid"> | null, preserved: PreservedHomePaths): Promise<void> {
  if (metadata && preserved.metadata.every((path) => path.includes("/"))) {
    await chown(target, metadata.uid, metadata.gid);
    await chmod(target, metadata.mode & 0o7777);
    await utimes(target, metadata.atime, metadata.mtime);
  } else if (!existing && preserved.entries.some((path) => !path.includes("/"))) {
    if (!owner) throw new Error(`protected home directory has no user ownership: ${target}`);
    await chown(target, owner.uid, owner.gid);
    await chmod(target, 0o700);
  }
}

async function replaceContents(filesystem: HomeFs, source: string, target: string, paths: PreservedHomePaths, homeOwner?: Pick<Stats, "uid" | "gid">): Promise<void> {
  const preserved = paths.entries;
  const metadata = await restorationDirectory(source);
  const existing = await restorationDirectory(target);
  const owner = homeOwner ?? existing ?? metadata;
  const entries = metadata ? await readdir(source) : [];
  const protectedEntries = preserved.map((path) => path.split("/")[0]);
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(target)) {
    if (!entries.includes(entry) && !protectedEntries.includes(entry)) await rm(`${target}/${entry}`, { recursive: true, force: true });
  }
  for (const entry of new Set([...entries, ...protectedEntries])) {
    if (preserved.includes(entry)) continue;
    const nested = preserved.filter((path) => path.startsWith(`${entry}/`)).map((path) => path.slice(entry.length + 1));
    if (nested.length) await replaceContents(filesystem, `${source}/${entry}`, `${target}/${entry}`, {
      entries: nested,
      metadata: paths.metadata.filter((path) => path.startsWith(`${entry}/`)).map((path) => path.slice(entry.length + 1)),
    }, owner ?? undefined);
    else await filesystem.replaceDirectory(`${source}/${entry}`, `${target}/${entry}`);
  }
  await restoreDirectoryMetadata(target, metadata, existing, owner, paths);
}

async function toolRetentionParents(home: string): Promise<void> {
  const owner = await lstat(home);
  if (!owner.isDirectory()) throw new Error("archived native home is not a real directory");
  for (const parent of [`${home}/.config`, `${home}/.config/octogee`]) {
    try { if (!(await lstat(parent)).isDirectory()) throw new Error("archived native tool parent is not a real directory"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(parent, { mode: 0o700 });
      await chown(parent, owner.uid, owner.gid);
    }
  }
}

async function retainToolStorage(source: string, target: string): Promise<void> {
  const suffix = "/.local/share/mise";
  const home = source.slice(0, -suffix.length);
  if (!source.endsWith(suffix) || target !== `${home}/.config/octogee/mise-retained`) throw new Error("native tool retention path is invalid");
  for (const parent of [home, `${home}/.local`, `${home}/.local/share`]) {
    if (!await restorationDirectory(parent)) return;
  }
  let metadata: Stats;
  try { metadata = await lstat(source); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) return;
  if (!metadata.isDirectory()) throw new Error("archived native tools are not a directory");
  await toolRetentionParents(home);
  try {
    if (!(await lstat(target)).isDirectory()) throw new Error("retained native tools are not a real directory");
    await rename(target, `${target}-before-restore-${randomUUID()}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await rename(source, target);
}

export function createHomeFs(stateRoot: string): HomeFs {
  const filesystem: HomeFs = {
    retainToolStorage,
    listDir: async (path) => (await exists(path)) ? readdir(path) : [],
    freeBytes: async (path) => {
      const { bavail, bsize } = await statfs(path);
      return bavail * bsize;
    },
    exists,
    fileSize: async (path) => (await stat(path)).size,
    sha256: (path) => new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
    }),
    mkdtemp: async (prefix) => {
      const root = `${stateRoot}/tmp`;
      await mkdir(root, { recursive: true, mode: 0o700 });
      return mkdtemp(`${root}/${prefix}`);
    },
    rm: (path) => rm(path, { recursive: true, force: true }),
    touch: async (path, at) => {
      if (!(await exists(path))) await writeFile(path, "", { mode: 0o600 });
      await utimes(path, at / 1000, at / 1000);
    },
    uploadBody: (path) => openAsBlob(path),
    saveResponse: async (response, path) => {
      if (!response.body) throw new Error("home checkpoint download has no body");
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(path, { mode: 0o600 }));
    },
    mkdir: (path, mode) => mkdir(path, { recursive: true, mode }).then(() => undefined),
    replaceDirectory: async (source, target) => {
      await mkdir(dirname(target), { recursive: true });
      const temporary = await mkdtemp(`${dirname(target)}/${HOME_REPLACE_STAGING_PREFIX}`);
      const stage = `${temporary}/stage`;
      const backup = `${temporary}/backup`;
      let backedUp = false;
      let installed = false;
      try {
        await exec("cp", ["-a", "--", source, stage]);
        if (await exists(target)) {
          await rename(target, backup);
          backedUp = true;
        }
        await rename(stage, target);
        installed = true;
      } catch (error) {
        if (backedUp) {
          try {
            await restoreBackup(backup, target);
            backedUp = false;
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], `home restore failed; backup retained at ${backup}`);
          }
        }
        throw error;
      } finally {
        if (!backedUp || installed) await rm(temporary, { recursive: true, force: true });
      }
    },
    replaceDirectoryContents: (source, target, preserved = [], metadataPreserved = []) => replaceContents(filesystem, source, target, { entries: preserved, metadata: metadataPreserved }),
  };
  return filesystem;
}
