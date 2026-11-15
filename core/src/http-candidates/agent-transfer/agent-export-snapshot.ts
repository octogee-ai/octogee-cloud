import { constants } from "node:fs";
import { mkdtemp, mkdir, open, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyAgentImportArchivePath } from "@octogee/shared/types/agent-import";
import type { Manifest, ManifestEntry } from "../../workspace-manifest.js";
import { acquireWorkspaceMutationLeaseSync } from "../../workspace-mutation-lease.js";

export interface AgentExportFile { path: string; content: string; sha256: string; size: number; mode: "100644" | "100755" }
export interface AgentExportSnapshot { files: AgentExportFile[]; digest: string; assetIdentity: string }
export interface AgentExportCaptureDeps {
  defaultAgentWorkspace: boolean;
  assertCurrent(): Promise<void>;
  readAssets(directory?: { root: string; parent: string; name: string }): Promise<{ manifest: Manifest; deleted: string[] }>;
  readBlob(entry: ManifestEntry): Promise<Buffer>;
  scan(directory: string): Promise<unknown[]>;
  gitDir?: string;
}
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_AGENT_EXPORT_FILES = 100;
const EXCLUDED = new Set([".files", ".thumbs", ".objects", ".octogee-state", "node_modules", "runtime-state"]);
export function authoredAgentPath(name: string, defaultAgentWorkspace: boolean): boolean {
  return !(defaultAgentWorkspace && name.split("/")[0].toLowerCase() === "projects") &&
    classifyAgentImportArchivePath(`workspace/${name}`) === "workspace" &&
    !name.split("/").some(part => EXCLUDED.has(part.toLowerCase())) &&
    !/\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm|journal))?$/iu.test(name);
}
function digestObjectKeys(value: object, array: boolean): string[] {
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("invalid authored export digest object");
  const invalidProperty = Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) =>
    !("value" in descriptor) || !descriptor.enumerable && !(array && key === "length"));
  if (Object.getOwnPropertySymbols(value).length || invalidProperty) throw new Error("invalid authored export digest properties");
  const keys = Object.keys(value);
  if (array && keys.length !== (value as unknown[]).length) throw new Error("invalid authored export digest array");
  return keys.sort();
}
function canonicalExportJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === null || ancestors.has(value)) throw new Error("invalid authored export digest value");
  const array = Array.isArray(value), keys = digestObjectKeys(value, array);
  ancestors.add(value);
  try {
    if (array) return `[${Array.from(value, entry => canonicalExportJson(entry, ancestors)).join(",")}]`;
    const fields = keys.map(key => `${JSON.stringify(key)}:${canonicalExportJson((value as Record<string, unknown>)[key], ancestors)}`);
    return `{${fields.join(",")}}`;
  } finally { ancestors.delete(value); }
}
export function exportDigest(value: unknown): string { return createHash("sha256").update(canonicalExportJson(value)).digest("hex"); }
function descriptor(directory: FileHandle): string { return `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${directory.fd}`; }
function fileRecord(name: string, bytes: Buffer, mode: AgentExportFile["mode"] = "100644"): AgentExportFile {
  if (bytes.length > MAX_FILE_BYTES) throw new Error("authored file exceeds export size limit");
  return { path: name, mode, content: bytes.toString("base64"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
async function pinDirectory(root: string) {
  const parts = path.resolve(root).split(path.sep).filter(Boolean);
  const handles = [await open(path.parse(path.resolve(root)).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)];
  try {
    for (const part of parts) handles.push(await open(`${descriptor(handles.at(-1)!)}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const identities = await Promise.all(handles.map(handle => handle.stat({ bigint: true })));
    return {
      root: `${descriptor(handles.at(-1)!)}/.`, parent: `${descriptor(handles.at(-2) ?? handles[0])}/.`, name: parts.at(-1) ?? "",
      async assertCurrent() {
        const current = await pinDirectory(root);
        try {
          if (current.identities.length !== identities.length || identities.some((entry, index) => entry.dev !== current.identities[index].dev || entry.ino !== current.identities[index].ino)) throw new Error("authored workspace directory identity changed");
        } finally { await current.close(); }
      },
      identities,
      async close() { for (const handle of [...handles].reverse()) await handle.close(); },
    };
  } catch (error) { for (const handle of handles.reverse()) { await handle.close(); } throw error; }
}
async function stableFile(file: FileHandle): Promise<{ contents: Buffer; mode: AgentExportFile["mode"] }> {
  const before = await file.stat({ bigint: true });
  if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES)) throw new Error("invalid authored file size or type");
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(chunk);
    if (!bytesRead) break;
    total += bytesRead;
    if (total > MAX_FILE_BYTES) throw new Error("authored file exceeds export size limit");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  const contents = Buffer.concat(chunks, total);
  const after = await file.stat({ bigint: true });
  if (before.mode !== after.mode || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(contents.length) !== before.size) throw new Error("authored file changed during capture");
  return { contents, mode: before.mode & 0o111n ? "100755" : "100644" };
}
async function localFiles(root: string, defaultAgentWorkspace: boolean): Promise<Map<string, AgentExportFile>> {
  const result = new Map<string, AgentExportFile>();
  let bytes = 0;
  const visit = async (directory: FileHandle, prefix: string): Promise<void> => {
    for (const entry of await readdir(descriptor(directory), { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!authoredAgentPath(name, defaultAgentWorkspace)) continue;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("authored export requires regular files, never symlinks");
      const file = await open(`${descriptor(directory)}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (entry.isDirectory() ? constants.O_DIRECTORY : 0));
      try {
        if (entry.isDirectory()) { await visit(file, name); continue; }
        const { contents, mode } = await stableFile(file);
        bytes += contents.length;
        if (bytes > MAX_TOTAL_BYTES || result.size >= MAX_AGENT_EXPORT_FILES) throw new Error("authored export exceeds capture limit");
        result.set(name, fileRecord(name, contents, mode));
      } finally { await file.close(); }
    }
  };
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await visit(directory, ""); } finally { await directory.close(); }
  return result;
}
function sortedFiles(files: Map<string, AgentExportFile>): AgentExportFile[] { return [...files.values()].sort((a, b) => a.path < b.path ? -1 : Number(a.path > b.path)); }
async function captureAssets(files: Map<string, AgentExportFile>, assets: Awaited<ReturnType<AgentExportCaptureDeps["readAssets"]>>, deps: AgentExportCaptureDeps): Promise<void> {
    let total = [...files.values()].reduce((bytes, file) => bytes + file.size, 0);
    for (const name of Object.keys(assets.manifest).sort()) {
      if (!authoredAgentPath(name, deps.defaultAgentWorkspace) || files.has(name) || assets.deleted.includes(name)) continue;
      const entry = assets.manifest[name];
      total += entry.size;
      if (entry.size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || files.size >= MAX_AGENT_EXPORT_FILES) throw new Error("authored asset exceeds export size limit");
      const record = fileRecord(name, await deps.readBlob(entry));
      if (record.size !== entry.size || (entry.sha256 && record.sha256 !== entry.sha256)) throw new Error("authored asset content identity mismatch");
      files.set(name, record);
    }
 }
export async function captureAgentExport(root: string, deps: AgentExportCaptureDeps): Promise<AgentExportSnapshot> {
  await deps.assertCurrent();
  const pinned = await pinDirectory(root);
  let git: Awaited<ReturnType<typeof pinDirectory>> | FileHandle | undefined;
  let lease: ReturnType<typeof acquireWorkspaceMutationLeaseSync> = null;
  let staging: string | undefined;
  try {
    git = deps.gitDir ? await pinDirectory(deps.gitDir) : await open(`${pinned.root}/.git`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const gitDir = "root" in git ? git.root : `${descriptor(git)}/.`;
    lease = acquireWorkspaceMutationLeaseSync({ workspaceDir: pinned.root, gitDir });
    if (!lease) throw new Error("workspace mutation is in progress");
    const assets = await deps.readAssets(pinned);
    const assetIdentity = exportDigest(assets);
    const local = await localFiles(pinned.root, deps.defaultAgentWorkspace);
    const localDigest = exportDigest(sortedFiles(local));
    const files = new Map(local);
    await captureAssets(files, assets, deps);
    const ordered = sortedFiles(files);
    if (ordered.length > MAX_AGENT_EXPORT_FILES || ordered.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) throw new Error("authored export exceeds capture limit");
    staging = await mkdtemp(path.join(tmpdir(), "octogee-agent-export-"));
    for (const file of ordered) {
      await mkdir(path.dirname(path.join(staging, file.path)), { recursive: true });
      await writeFile(path.join(staging, file.path), Buffer.from(file.content, "base64"), { mode: 0o600, flag: "wx" });
    }
    if ((await deps.scan(staging)).length) throw new Error("authored export contains secret findings");
    if (exportDigest(await deps.readAssets(pinned)) !== assetIdentity || exportDigest(sortedFiles(await localFiles(pinned.root, deps.defaultAgentWorkspace))) !== localDigest) throw new Error("authored workspace changed during capture");
    await pinned.assertCurrent();
    await deps.assertCurrent();
    return { files: ordered, digest: exportDigest(ordered), assetIdentity };
  } finally {
    if (staging) { await rm(staging, { recursive: true, force: true }); }
    lease?.release();
    await git?.close();
    await pinned.close();
  }
}
