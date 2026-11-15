import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export const PROC_ROOT = "/proc";
const DELETED_LINK_SUFFIX = " (deleted)";
const SQLITE_FAMILY_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

export class HeldAgentStoreError extends Error {
  readonly heldPaths: readonly string[];

  constructor(heldPaths: readonly string[]) {
    super(`agent database files are still held open: ${heldPaths.join(", ")}`);
    this.name = "HeldAgentStoreError";
    this.heldPaths = heldPaths;
  }
}

export function sqliteFamily(databasePath: string): string[] {
  return SQLITE_FAMILY_SUFFIXES.map((suffix) => `${databasePath}${suffix}`);
}

export type HeldPathMatcher = (linkedPath: string) => boolean;

export function matchFiles(files: readonly string[]): HeldPathMatcher {
  const candidates = new Set(files);
  return (linked) => candidates.has(linked);
}

export function matchUnder(root: string): HeldPathMatcher {
  const prefix = `${path.resolve(root)}${path.sep}`;
  return (linked) => linked.startsWith(prefix);
}

function isVanishedOrForeignProcess(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM";
}

function linkedPath(target: string): string {
  return target.endsWith(DELETED_LINK_SUFFIX) ? target.slice(0, -DELETED_LINK_SUFFIX.length) : target;
}

export interface HeldPathOptions {
  ignoreReadOnlyConnections?: boolean;
}

interface HeldDescriptor {
  path: string;
  writable: boolean | undefined;
}

const O_ACCMODE = 0o3;
const SQLITE_DATABASE_SUFFIX = ".sqlite";
const READ_ONLY_CONNECTION_SIDECARS = ["-wal", "-shm"] as const;

async function descriptorWritable(fdinfoPath: string): Promise<boolean | undefined> {
  let fdinfo: string;
  try {
    fdinfo = await fsp.readFile(fdinfoPath, "utf8");
  } catch (error) {
    if (isVanishedOrForeignProcess(error)) return undefined;
    throw error;
  }
  const flags = /^flags:\s+([0-7]+)$/mu.exec(fdinfo)?.[1];
  return flags === undefined ? undefined : (Number.parseInt(flags, 8) & O_ACCMODE) !== 0;
}

async function isDetachedRegularFile(fdPath: string, logicalPath: string): Promise<boolean> {
  try {
    const descriptor = await fsp.stat(fdPath);
    if (!descriptor.isFile() || descriptor.nlink !== 0) return false;
    try {
      const current = await fsp.stat(logicalPath);
      return current.dev !== descriptor.dev || current.ino !== descriptor.ino;
    } catch (error) {
      return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
    }
  } catch {
    return false;
  }
}

function connectionDatabasePath(heldPath: string): string {
  const sidecar = READ_ONLY_CONNECTION_SIDECARS.find((suffix) => heldPath.endsWith(suffix));
  return sidecar ? heldPath.slice(0, -sidecar.length) : heldPath;
}

function withoutReadOnlyConnections(descriptors: readonly HeldDescriptor[]): HeldDescriptor[] {
  const databaseModes = new Map<string, boolean[]>();
  for (const descriptor of descriptors) {
    if (!descriptor.path.endsWith(SQLITE_DATABASE_SUFFIX)) continue;
    databaseModes.set(descriptor.path, [...(databaseModes.get(descriptor.path) ?? []), descriptor.writable === false]);
  }
  const readOnlyDatabases = new Set(
    [...databaseModes].filter(([, readOnly]) => readOnly.every(Boolean)).map(([database]) => database),
  );
  return descriptors.filter((descriptor) => !readOnlyDatabases.has(connectionDatabasePath(descriptor.path)));
}

async function heldByProcess(
  processDir: string,
  match: HeldPathMatcher,
  options: HeldPathOptions,
): Promise<string[]> {
  const fdDir = path.join(processDir, "fd");
  let descriptors: string[];
  try {
    descriptors = await fsp.readdir(fdDir);
  } catch (error) {
    if (isVanishedOrForeignProcess(error)) return [];
    throw error;
  }
  const held: HeldDescriptor[] = [];
  for (const descriptor of descriptors) {
    let target: string;
    try {
      target = await fsp.readlink(path.join(fdDir, descriptor));
    } catch (error) {
      if (isVanishedOrForeignProcess(error)) continue;
      throw error;
    }
    const linked = linkedPath(target);
    if (!match(linked)) continue;
    const deleted = target.endsWith(DELETED_LINK_SUFFIX);
    const writable = options.ignoreReadOnlyConnections || deleted
      ? await descriptorWritable(path.join(processDir, "fdinfo", descriptor))
      : undefined;
    if (!options.ignoreReadOnlyConnections && deleted && writable === false &&
        await isDetachedRegularFile(path.join(fdDir, descriptor), linked)) continue;
    held.push({ path: linked, writable });
  }
  return (options.ignoreReadOnlyConnections ? withoutReadOnlyConnections(held) : held).map((descriptor) => descriptor.path);
}

function heldByProcessSync(fdDir: string, match: HeldPathMatcher): string[] {
  let descriptors: string[];
  try {
    descriptors = fs.readdirSync(fdDir);
  } catch (error) {
    if (isVanishedOrForeignProcess(error)) return [];
    throw error;
  }
  const held: string[] = [];
  for (const descriptor of descriptors) {
    let target: string;
    try {
      target = fs.readlinkSync(path.join(fdDir, descriptor));
    } catch (error) {
      if (isVanishedOrForeignProcess(error)) continue;
      throw error;
    }
    const linked = linkedPath(target);
    if (match(linked)) held.push(linked);
  }
  return held;
}

function processIds(entries: readonly string[]): string[] {
  return entries.filter((entry) => /^\d+$/u.test(entry));
}

export async function findHeldPaths(
  match: HeldPathMatcher,
  procRoot: string,
  options: HeldPathOptions = {},
): Promise<string[]> {
  const held = new Set<string>();
  for (const pid of processIds(await fsp.readdir(procRoot))) {
    for (const file of await heldByProcess(path.join(procRoot, pid), match, options)) held.add(file);
  }
  return [...held].sort();
}

export function findHeldPathsSync(match: HeldPathMatcher, procRoot: string): string[] {
  const held = new Set<string>();
  for (const pid of processIds(fs.readdirSync(procRoot))) {
    for (const file of heldByProcessSync(path.join(procRoot, pid, "fd"), match)) held.add(file);
  }
  return [...held].sort();
}

export async function assertNotHeld(
  match: HeldPathMatcher,
  procRoot: string,
  options: HeldPathOptions = {},
): Promise<void> {
  const held = await findHeldPaths(match, procRoot, options);
  if (held.length > 0) throw new HeldAgentStoreError(held);
}

export function assertNotHeldSync(match: HeldPathMatcher, procRoot: string): void {
  const held = findHeldPathsSync(match, procRoot);
  if (held.length > 0) throw new HeldAgentStoreError(held);
}
