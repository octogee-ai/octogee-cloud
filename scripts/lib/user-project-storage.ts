import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isValidProjectId, isValidUsername } from "@octogee/shared/types/identity";
import { loadAppliedFingerprints, saveAppliedFingerprints } from "./applied-fingerprint-store.js";

async function clearProjectReadiness(projects: string): Promise<void> {
  const state = path.join(projects, ".octogee-state");
  let entries;
  try {
    if (!(await lstat(state)).isDirectory()) throw new Error("project restore state is not a directory");
    entries = await readdir(state);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { return; }
          throw error; }
  for (const name of entries) {
    if (name.endsWith(".json") && isValidProjectId(name.slice(0, -5))) await rm(path.join(state, name));
  }
}

function anchoredDirectory(fd: number, location: string): string {
  return process.platform === "linux" ? `/proc/self/fd/${fd}` : location;
}

async function hasProjectState(root: string, name: string): Promise<boolean> {
  let marked = false;
  for (const suffix of [".json", ".assets.json"]) {
    try { await lstat(`${root}/.octogee-state/${name}${suffix}`); marked = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return marked;
}

async function removeEmptyGitPlaceholder(gitPath: string): Promise<boolean> {
  let git;
  try { git = await open(gitPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    const stat = await lstat(gitPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) throw error;
    return false;
  }
  try {
    if ((await readdir(anchoredDirectory(git.fd, gitPath))).length) return false;
    await rmdir(gitPath);
    return true;
  } finally { await git.close(); }
}

async function removeEmptyProjectPlaceholder(root: string, name: string): Promise<void> {
  const location = `${root}/${name}`;
  const project = await open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (await hasProjectState(root, name)) return;
    const projectRoot = anchoredDirectory(project.fd, location);
    const contents = await readdir(projectRoot);
    if (contents.length === 1 && contents[0] === ".git") {
      if (!await removeEmptyGitPlaceholder(`${projectRoot}/.git`)) return;
    } else if (contents.length) return;
    await rmdir(location);
  } finally { await project.close(); }
}

async function removeEmptyProjectPlaceholders(projects: string): Promise<void> {
  const parent = await open(projects, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const root = anchoredDirectory(parent.fd, projects);
  try {
    for (const name of await readdir(root)) {
      if (isValidProjectId(name)) await removeEmptyProjectPlaceholder(root, name);
    }
  } finally { await parent.close(); }
}

export async function cleanUserProjectPlaceholders(input: { openclawDir: string; slug: string }): Promise<void> {
  if (!isValidUsername(input.slug) || !path.isAbsolute(input.openclawDir)) throw new Error("invalid project storage owner/root");
  const handles: Awaited<ReturnType<typeof open>>[] = [];
  let location = input.openclawDir;
  try {
    for (const segment of ["", "customers", input.slug, "projects"]) {
      if (segment) location = path.join(location, segment);
      const handle = await open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!handle) return;
      handles.push(handle);
      location = anchoredDirectory(handle.fd, location);
    }
    await removeEmptyProjectPlaceholders(`${location}/.`);
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}

async function assertProjectMount(home: string, projects: string): Promise<void> {
  const [homeStat, projectStat] = await Promise.all([lstat(home), lstat(projects)]);
  if (!homeStat.isDirectory() || !projectStat.isDirectory() || homeStat.dev === projectStat.dev) throw new Error("projects require a separate filesystem from home");
}

async function assertUninitializedMount(projects: string): Promise<void> {
  const entries = await readdir(projects, { withFileTypes: true });
  if (entries.some((entry) => entry.name !== "lost+found" || !entry.isDirectory())) {
    throw new Error("uninitialized project mount contains existing work");
  }
}

export async function prepareUserProjectStorage(input: { home: string; projects: string; slug: string }, deps = { assertMount: assertProjectMount }): Promise<void> {
  if (!isValidUsername(input.slug)) throw new Error("invalid project storage owner");
  await deps.assertMount(input.home, input.projects);
  const source = path.join(input.home, ".openclaw/customers", input.slug, "projects");
  const destination = path.join(input.projects, "projects");
  const marker = path.join(input.projects, ".octogee-storage.json");
  const homeMarker = path.join(input.home, ".openclaw/project-storage", `${input.slug}.json`);
  const preserved = path.join(input.home, ".openclaw/project-imports", input.slug);
  let state: StorageState | null = null;
  try { state = JSON.parse(await readFile(marker, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  assertStorageState(state, input.slug);
  await mkdir(source, { recursive: true });
  if (!(await lstat(source)).isDirectory()) throw new Error("home projects are not a directory");
  const fingerprintFile = path.join(input.home, ".openclaw/applied-fingerprints.json");
  const fingerprints = loadAppliedFingerprints(fingerprintFile);
  if (fingerprints.delete(input.slug)) saveAppliedFingerprints(fingerprintFile, fingerprints);
  if (state?.status === "ready") {
    if (!(await lstat(destination)).isDirectory()) throw new Error("project mount is not a directory");
    if (await readHomeGeneration(homeMarker) === state.generation) {
      await removeEmptyProjectPlaceholders(destination);
      await clearProjectReadiness(destination);
      return;
    }
    state = { version: 2, slug: input.slug, status: "preparing", generation: randomUUID(), previousGeneration: state.generation, refreshMetadata: true };
    await writeStorageState(marker, state);
  }
  if (!state) {
    await assertUninitializedMount(input.projects);
    state = { version: 2, slug: input.slug, status: "preparing", generation: randomUUID(), refreshMetadata: await readHomeGeneration(homeMarker) !== undefined };
    await writeFile(marker, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  }
  if (state.previousGeneration) {
    await retainPreviousWorkingSet(input.projects, destination, state.previousGeneration);
  } else {
    await importProjectTree(source, destination, input.projects);
    await preserveHomeProjects(source, preserved);
  }
  await removeEmptyProjectPlaceholders(destination);
  if (state.refreshMetadata) await retainProjectMetadata(input.home, input.slug, state.generation);
  await mkdir(path.dirname(homeMarker), { recursive: true });
  await writeFile(`${homeMarker}.next`, JSON.stringify(state.generation), { mode: 0o600 });
  await rename(`${homeMarker}.next`, homeMarker);
  await writeStorageState(marker, { version: 2, slug: input.slug, status: "ready", generation: state.generation });
  await clearProjectReadiness(destination);
}

async function retainProjectMetadata(home: string, slug: string, generation: string): Promise<void> {
  const source = path.join(home, ".openclaw/git-metadata", slug, "projects");
  try {
    if (!(await lstat(source)).isDirectory()) throw new Error("project Git metadata is not a directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const retained = path.join(home, ".openclaw/project-storage-history", slug, generation);
  await mkdir(path.dirname(retained), { recursive: true });
  await rename(source, retained);
}

async function readHomeGeneration(marker: string): Promise<unknown> {
  try { return JSON.parse(await readFile(marker, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function retainPreviousWorkingSet(projects: string, destination: string, generation: string): Promise<void> {
  const retained = path.join(projects, ".octogee-retained", generation);
  await mkdir(path.dirname(retained), { recursive: true });
  try {
    if (!(await lstat(retained)).isDirectory()) throw new Error("retained project working set is not a directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await rename(destination, retained);
  }
  await mkdir(destination, { recursive: true });
}

interface StorageState {
  version: number;
  slug: string;
  status: string;
  generation: string;
  previousGeneration?: string;
  refreshMetadata?: boolean;
}

async function writeStorageState(marker: string, state: StorageState): Promise<void> {
  await writeFile(`${marker}.next`, JSON.stringify(state), { mode: 0o600 });
  await rename(`${marker}.next`, marker);
}

async function importProjectTree(source: string, destination: string, projects: string): Promise<void> {
  let installed = false;
  try { installed = (await lstat(destination)).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!installed) {
    const staging = path.join(projects, ".octogee-import");
    await rm(staging, { recursive: true, force: true });
    await cp(source, staging, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true });
    await rename(staging, destination);
  }
}

async function preserveHomeProjects(source: string, preserved: string): Promise<void> {
  if ((await readdir(source)).length) {
    await mkdir(path.dirname(preserved), { recursive: true });
    try { await lstat(preserved); throw new Error("project home import already exists; both copies retained"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(source, preserved);
    await mkdir(source);
  }
}

function assertStorageState(state: StorageState | null, slug: string): void {
  const generation = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
  if (state && (state.version !== 2 || state.slug !== slug || !["preparing", "ready"].includes(state.status)
    || !generation.test(state.generation) || (state.previousGeneration !== undefined && !generation.test(state.previousGeneration))
    || (state.refreshMetadata !== undefined && typeof state.refreshMetadata !== "boolean"))) throw new Error("project mount owner/state differs");
}
