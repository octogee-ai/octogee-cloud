import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireWorkspaceMutationLeaseSync } from "../../workspace-mutation-lease.js";
import {
  classifyAgentImportArchivePath,
  type AgentImportWorkspacePolicy,
} from "@octogee/shared/types/agent-import";
import { getExtension, getMimeType, isTextFile } from "../../workspace/route-helpers.js";
import {
  WORKSPACE_GIT_HARDENING_PINS,
  workspaceMutationLeaseGitDir,
  workspaceGitCommandArgs,
  workspaceGitEnvironment,
} from "../../workspace/workspace-git.js";

const SHA_RE = /^[0-9a-f]{40}$/;
const IMPORT_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const MAX_TREE_METADATA_OUTPUT = 64 * 1024 * 1024;
const MAX_BINARY_BYTES = 100 * 1024 * 1024;
const MAX_REPOSITORY_TIP_BYTES = 128 * 1024 * 1024;
const MAX_REACHABLE_BLOB_BYTES = 256 * 1024 * 1024;
const MAX_REACHABLE_OBJECTS = 250_000;
const MAX_SECRET_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_IMPORT_COMMITS = 10_000;
const MAIN_REF = "refs/heads/main";
const EMPTY_REF = "0".repeat(40);
const PLATFORM_MANAGED_WORKSPACE_DIRECTORIES = [".files", "projects"] as const;
const OPENCLAW_RUNTIME_WORKSPACE_FILES = ["openclaw-workspace-state.json"] as const;
const CONVERGED_CONTEXT_FILES = ["AGENTS.md", "TOOLS.md"] as const;
const GIT_TREE_OUTPUT_MALFORMED = "git tree output is malformed";
const SOURCE_HEAD_LABEL = "source head";
const GIT_SOURCE_REF_CLEANUP = "git source ref cleanup";
const DELETE_REF_ARGUMENT = "-d";
const UPDATE_REF_COMMAND = "update-ref";

export interface AgentImportSecretFinding {
  ruleId: string;
  path: string;
  commit: string | null;
}

export interface AgentImportRepositoryInspection {
  head: string;
  commitCount: number;
  fileCount: number;
  totalBytes: number;
  workspaceDigest: string;
  secretFindings: AgentImportSecretFinding[];
}

export interface AgentImportManifestEntry {
  type: "blob";
  gcsPath: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  thumbnailUrl?: string;
}

function treeEntries(serialized: string): Map<string, string> {
  return new Map(serialized.split("\0").filter(Boolean).map((raw) => {
    const tab = raw.indexOf("\t");
    if (tab < 0) throw new AgentImportGitError("invalid_git_tree", GIT_TREE_OUTPUT_MALFORMED);
    return [raw.slice(tab + 1), raw.slice(0, tab)];
  }));
}

function platformPreservedFiles(policy: AgentImportWorkspacePolicy): string[] {
  return [
    ...OPENCLAW_RUNTIME_WORKSPACE_FILES,
    ...(policy.preserveConvergedContextFiles ? CONVERGED_CONTEXT_FILES : []),
  ];
}

function platformPreservedPath(
  relative: string,
  policy: AgentImportWorkspacePolicy,
): boolean {
  return PLATFORM_MANAGED_WORKSPACE_DIRECTORIES.some((platformPath) =>
    relative === platformPath || relative.startsWith(`${platformPath}/`)
  ) || platformPreservedFiles(policy).some((platformPath) => platformPath === relative);
}

export interface AgentImportWorkspaceComparison {
  conflicts: string[];
  conflictCount: number;
  conflictDigest: string;
  preservedPaths: string[];
}

export async function compareAgentImportWorkspaces(
  sourceDir: string,
  targetDir: string,
  workspacePolicy: AgentImportWorkspacePolicy,
): Promise<AgentImportWorkspaceComparison> {
  const source = treeEntries(await git(sourceDir, ["ls-tree", "-r", "-l", "-z", "HEAD"]));
  const target = treeEntries(await git(targetDir, ["ls-tree", "-r", "-l", "-z", "HEAD"]));
  const conflicts: string[] = [];
  for (const [relative, metadata] of target) {
    if (platformPreservedPath(relative, workspacePolicy)) continue;
    const sourceMetadata = source.get(relative);
    if (relative === ".gitignore") {
      if (sourceMetadata !== metadata) conflicts.push("merge:.gitignore");
    } else if (sourceMetadata === undefined) {
      conflicts.push(`delete:${relative}`);
    } else if (sourceMetadata !== metadata) {
      conflicts.push(`overwrite:${relative}`);
    }
  }
  const sorted = conflicts.sort();
  return {
    conflicts: sorted.slice(0, 100),
    conflictCount: sorted.length,
    conflictDigest: `sha256:${createHash("sha256").update(sorted.join("\0")).digest("hex")}`,
    preservedPaths: [
      ...PLATFORM_MANAGED_WORKSPACE_DIRECTORIES,
      ...platformPreservedFiles(workspacePolicy),
    ].sort(),
  };
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; maxOutput?: number },
) => CommandResult | Promise<CommandResult>;

export function buildAgentImportGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: source.LANG ?? "C.UTF-8",
    LC_ALL: source.LC_ALL ?? "C.UTF-8",
    HOME: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

export class AgentImportGitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly findings?: AgentImportSecretFinding[],
  ) {
    super(message);
    this.name = "AgentImportGitError";
  }
}

async function runChild(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer;
    maxOutput?: number;
  },
): Promise<{ status: number | null; stdout: Buffer; stderr: Buffer; error?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? buildAgentImportGitEnvironment(),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let error: Error | undefined;
    const maxOutput = options.maxOutput ?? MAX_COMMAND_OUTPUT;
    const timer = setTimeout(() => {
      error = Object.assign(new Error("command timed out"), { code: "ETIMEDOUT" });
      child.kill("SIGKILL");
    }, 120_000);
    const collect = (chunks: Buffer[], chunk: Buffer, total: number): void => {
      if (total > maxOutput) {
        error = Object.assign(new Error("command output exceeded limit"), { code: "ENOBUFS" });
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      collect(stdout, chunk, stdoutBytes);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      collect(stderr, chunk, stderrBytes);
    });
    child.on("error", (spawnError) => { error = spawnError; });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        ...(error ? { error } : {}),
      });
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

async function defaultRun(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; maxOutput?: number },
): Promise<CommandResult> {
  const result = await runChild(command, args, options);
  return {
    status: result.status,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    ...(result.error ? { error: result.error } : {}),
  };
}

function safeCommandError(label: string, result: CommandResult): AgentImportGitError {
  const diagnostic = (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ? "command unavailable"
    : `exit ${String(result.status)}`;
  return new AgentImportGitError("git_command_failed", `${label} failed (${diagnostic})`);
}

async function command(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; label?: string; input?: string | Buffer } = {},
): Promise<string> {
  const result = await defaultRun(executable, args, options);
  if (result.error || result.status !== 0) throw safeCommandError(options.label ?? executable, result);
  return result.stdout.trim();
}

const GIT_COMMAND = "/usr/bin/git";

function agentImportGitArgs(cwd: string, args: string[]): string[] {
  const localTransport = ["fetch", "ls-remote", "push"].includes(args[0] ?? "")
    ? ["-c", "protocol.file.allow=always"]
    : [];
  return workspaceGitCommandArgs(cwd, [...localTransport, ...args]);
}

function agentImportGitEnvironment(env?: NodeJS.ProcessEnv, cwd?: string): NodeJS.ProcessEnv {
  return workspaceGitEnvironment(env ?? buildAgentImportGitEnvironment(), cwd);
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, label = "git"): Promise<string> {
  return command(GIT_COMMAND, agentImportGitArgs(cwd, args), {
    cwd,
    env: agentImportGitEnvironment(env, cwd),
    label,
  });
}

function gitChild(
  cwd: string,
  args: string[],
  options: { input?: string | Buffer; maxOutput?: number; env?: NodeJS.ProcessEnv } = {},
) {
  return runChild(GIT_COMMAND, agentImportGitArgs(cwd, args), {
    cwd,
    env: agentImportGitEnvironment(options.env, cwd),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.maxOutput === undefined ? {} : { maxOutput: options.maxOutput }),
  });
}

function gitDefault(
  cwd: string,
  args: string[],
  options: { input?: string | Buffer; maxOutput?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return defaultRun(GIT_COMMAND, agentImportGitArgs(cwd, args), {
    cwd,
    env: agentImportGitEnvironment(options.env, cwd),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.maxOutput === undefined ? {} : { maxOutput: options.maxOutput }),
  });
}

function gitCommand(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; label?: string; input?: string | Buffer } = {},
): Promise<string> {
  return command(GIT_COMMAND, agentImportGitArgs(cwd, args), {
    cwd,
    env: agentImportGitEnvironment(options.env, cwd),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.input === undefined ? {} : { input: options.input }),
  });
}

async function readRef(cwd: string, ref: string): Promise<string | null> {
  const result = await gitDefault(cwd, ["rev-parse", "--verify", ref]);
  if (!result.error && (result.status === 1 || result.status === 128)) return null;
  if (result.error || result.status !== 0) throw safeCommandError("git ref lookup", result);
  return requireSha(result.stdout.trim(), "git ref");
}

export async function agentImportRepositoryApplied(targetDir: string, importId: string): Promise<boolean> {
  const checkedId = checkedImportId(importId);
  return await readRef(targetDir, `refs/octogee/imports/${checkedId}/commit`) !== null;
}

function requireSha(value: string, label: string): string {
  if (!SHA_RE.test(value)) throw new AgentImportGitError("invalid_git_head", `${label} is not a commit SHA`);
  return value;
}

async function trackedTree(repoDir: string, head: string, commit = head): Promise<{
  serialized: string;
  fileCount: number;
  totalBytes: number;
}> {
  const serialized = await git(repoDir, ["ls-tree", "-r", "-l", "-z", head], undefined, "git tree inspection");
  let fileCount = 0;
  let totalBytes = 0;
  for (const raw of serialized.split("\0").filter(Boolean)) {
    const tab = raw.indexOf("\t");
    if (tab < 0) throw new AgentImportGitError("invalid_git_tree", GIT_TREE_OUTPUT_MALFORMED);
    const relative = raw.slice(tab + 1);
    if (classifyAgentImportArchivePath(`workspace/${relative}`) !== "workspace") {
      throw new AgentImportGitError("unsafe_git_entry", `source history contains blocked path ${relative} at ${commit}`);
    }
    const metadata = raw.slice(0, tab).trim().split(/\s+/);
    const mode = metadata[0];
    if (mode === "120000" || mode === "160000") {
      throw new AgentImportGitError("unsafe_git_entry", `source history contains unsafe path ${relative} at ${commit}`);
    }
    if (mode !== "100644" && mode !== "100755") {
      throw new AgentImportGitError("unsafe_git_entry", `source history contains mode ${mode} at ${relative} in ${commit}`);
    }
    fileCount += 1;
    const size = Number.parseInt(metadata[3] ?? "0", 10);
    if (Number.isFinite(size)) totalBytes += size;
  }
  return { serialized, fileCount, totalBytes };
}

interface RepositoryExpansionLimits {
  maxBlobBytes?: number;
  maxReachableBlobBytes?: number;
  maxTipBytes?: number;
  maxObjects?: number;
}

async function storedObjectMetadata(repoDir: string): Promise<string[]> {
  const objectMetadata = await gitChild(repoDir, [
    "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
  ], { maxOutput: 32 * 1024 * 1024 });
  if (objectMetadata.error || objectMetadata.status !== 0) {
    if ((objectMetadata.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
      throw new AgentImportGitError("archive_too_large", "source repository has too many stored objects");
    }
    throw safeCommandError("git object size inspection", {
      status: objectMetadata.status,
      stdout: objectMetadata.stdout.toString("utf8"),
      stderr: objectMetadata.stderr.toString("utf8"),
      ...(objectMetadata.error ? { error: objectMetadata.error } : {}),
    });
  }
  return objectMetadata.stdout.toString("utf8").trim().split(/\r?\n/).filter(Boolean);
}

function lfsCandidatesFromMetadata(
  metadataLines: string[],
  limits: RepositoryExpansionLimits,
): string[] {
  assertObjectMetadataWithinLimits(metadataLines, limits);
  return metadataLines.flatMap((line) => {
    const [objectId, type, rawSize] = line.split(" ", 3);
    const size = Number.parseInt(rawSize ?? "", 10);
    return type === "blob" && size <= 1_024 ? [objectId!] : [];
  });
}

function assertObjectMetadataWithinLimits(
  metadataLines: string[],
  limits: RepositoryExpansionLimits,
): void {
  if (metadataLines.length > (limits.maxObjects ?? MAX_REACHABLE_OBJECTS)) {
    throw new AgentImportGitError("archive_too_large", "source repository has too many stored objects");
  }
  let storedObjectBytes = 0;
  const maxBlobBytes = limits.maxBlobBytes ?? MAX_BINARY_BYTES;
  const maxReachableBlobBytes = limits.maxReachableBlobBytes ?? MAX_REACHABLE_BLOB_BYTES;
  for (const line of metadataLines) {
    const [objectId, , rawSize] = line.split(" ", 3);
    const size = Number.parseInt(rawSize ?? "", 10);
    if (!SHA_RE.test(objectId ?? "") || !Number.isSafeInteger(size) || size < 0) {
      throw new AgentImportGitError("invalid_git_history", "source repository object metadata is invalid");
    }
    if (size > maxBlobBytes) {
      throw new AgentImportGitError("archive_too_large", "source repository contains an oversized Git object");
    }
    storedObjectBytes += size;
    if (storedObjectBytes > maxReachableBlobBytes) {
      throw new AgentImportGitError("archive_too_large", "source repository object database expands beyond the import limit");
    }
  }
}

async function reachableObjectMetadata(repoDir: string, head: string): Promise<string[]> {
  const objects = await git(repoDir, ["rev-list", "--objects", head], undefined, "git reachable object listing");
  const ids = [...new Set(objects.split(/\r?\n/).flatMap((line) => {
    const id = line.split(" ", 1)[0];
    return id && SHA_RE.test(id) ? [id] : [];
  }))];
  if (ids.length === 0) throw new AgentImportGitError("invalid_git_history", "source history has no objects");
  const checked = await gitChild(repoDir, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    input: `${ids.join("\n")}\n`,
    maxOutput: 32 * 1024 * 1024,
  });
  if (checked.error || checked.status !== 0) {
    throw safeCommandError("git reachable object inspection", {
      status: checked.status,
      stdout: checked.stdout.toString("utf8"),
      stderr: checked.stderr.toString("utf8"),
      ...(checked.error ? { error: checked.error } : {}),
    });
  }
  return checked.stdout.toString("utf8").trim().split(/\r?\n/).filter(Boolean);
}

async function assertNoLfsPointers(repoDir: string, lfsCandidates: string[]): Promise<void> {
  for (let offset = 0; offset < lfsCandidates.length; offset += 1_000) {
    const ids = lfsCandidates.slice(offset, offset + 1_000);
    const batch = await gitChild(repoDir, ["cat-file", "--batch"], {
      input: `${ids.join("\n")}\n`,
      maxOutput: 2 * 1024 * 1024,
    });
    if (batch.error || batch.status !== 0) {
      throw safeCommandError("git LFS inspection", {
        status: batch.status, stdout: "", stderr: batch.stderr.toString("utf8"),
        ...(batch.error ? { error: batch.error } : {}),
      });
    }
    let cursor = 0;
    while (cursor < batch.stdout.length) {
      const newline = batch.stdout.indexOf(0x0a, cursor);
      if (newline < 0) {
        throw new AgentImportGitError("invalid_git_history", "Git LFS inspection returned invalid metadata");
      }
      const header = batch.stdout.subarray(cursor, newline).toString("ascii").split(" ");
      const size = Number.parseInt(header[2] ?? "", 10);
      if (header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) {
        throw new AgentImportGitError("invalid_git_history", "Git LFS inspection returned invalid metadata");
      }
      const start = newline + 1;
      const end = start + size;
      const contents = batch.stdout.subarray(start, end);
      if (contents.toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1\n")) {
        throw new AgentImportGitError("git_lfs_unsupported", "Git LFS repositories must be materialized before import");
      }
      cursor = end + 1;
    }
  }
}

export async function assertAgentImportRepositoryExpansionSafe(
  repoDir: string,
  head: string,
  limits: RepositoryExpansionLimits = {},
): Promise<void> {
  const sourceHead = requireSha(head, SOURCE_HEAD_LABEL);
  assertObjectMetadataWithinLimits(await storedObjectMetadata(repoDir), limits);
  const lfsCandidates = lfsCandidatesFromMetadata(await reachableObjectMetadata(repoDir, sourceHead), limits);
  const tip = await trackedTree(repoDir, sourceHead);
  if (tip.totalBytes > (limits.maxTipBytes ?? MAX_REPOSITORY_TIP_BYTES)) {
    throw new AgentImportGitError("archive_too_large", "source repository tip exceeds the import limit");
  }
  await assertNoLfsPointers(repoDir, lfsCandidates);
}

interface RawTreeEntry {
  mode: string;
  name: string;
  objectId: string;
}

function parseRawTree(contents: Buffer): RawTreeEntry[] {
  const entries: RawTreeEntry[] = [];
  let offset = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (offset < contents.length) {
    const space = contents.indexOf(0x20, offset);
    const nul = contents.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > contents.length) {
      throw new AgentImportGitError("invalid_git_tree", "git tree object is malformed");
    }
    let name: string;
    try {
      name = decoder.decode(contents.subarray(space + 1, nul));
    } catch {
      throw new AgentImportGitError("invalid_git_tree", "git tree path is not valid UTF-8");
    }
    entries.push({
      mode: contents.subarray(offset, space).toString("ascii").padStart(6, "0"),
      name,
      objectId: contents.subarray(nul + 1, nul + 21).toString("hex"),
    });
    offset = nul + 21;
  }
  return entries;
}

function parseBatchObjects(buffer: Buffer): Map<string, Buffer> {
  const objects = new Map<string, Buffer>();
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) throw new AgentImportGitError("invalid_git_tree", "git object batch header is malformed");
    const header = buffer.subarray(offset, newline).toString("ascii").split(" ");
    const size = Number.parseInt(header[2] ?? "", 10);
    if (!SHA_RE.test(header[0] ?? "") || header[1] !== "tree" || !Number.isSafeInteger(size) || size < 0) {
      throw new AgentImportGitError("invalid_git_tree", "git object batch response is malformed");
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= buffer.length || buffer[end] !== 0x0a) {
      throw new AgentImportGitError("invalid_git_tree", "git object batch payload is truncated");
    }
    objects.set(header[0]!, buffer.subarray(start, end));
    offset = end + 1;
  }
  return objects;
}

async function historyTrees(repoDir: string, head: string): Promise<Map<string, RawTreeEntry[]>> {
  const reachable = await git(repoDir, ["rev-list", "--objects", "--filter=object:type=tree", head]);
  const objectIds = [...new Set(reachable.split(/\r?\n/).flatMap((line) => {
    const id = line.split(" ", 1)[0];
    return SHA_RE.test(id) ? [id] : [];
  }))];
  const check = await gitCommand(repoDir, ["cat-file", "--batch-check"], {
    input: `${objectIds.join("\n")}\n`,
    label: "git tree batch check",
  });
  const treeIds = check.split(/\r?\n/).flatMap((line) => {
    const [id, type] = line.split(" ", 3);
    return SHA_RE.test(id) && type === "tree" ? [id] : [];
  });
  const batch = await gitChild(repoDir, ["cat-file", "--batch"], {
    input: `${treeIds.join("\n")}\n`,
    maxOutput: MAX_TREE_METADATA_OUTPUT,
  });
  if (batch.error || batch.status !== 0) {
    throw safeCommandError("git tree batch", {
      status: batch.status,
      stdout: "",
      stderr: batch.stderr.toString("utf8"),
      ...(batch.error ? { error: batch.error } : {}),
    });
  }
  return new Map([...parseBatchObjects(batch.stdout)].map(([id, contents]) => [id, parseRawTree(contents)]));
}

function assertSafeHistoryEntry(entry: RawTreeEntry, relative: string, commit: string): void {
  if (classifyAgentImportArchivePath(`workspace/${relative}`) !== "workspace") {
    throw new AgentImportGitError("unsafe_git_entry", `source history contains blocked path ${relative} at ${commit}`);
  }
  if (entry.mode === "120000" || entry.mode === "160000") {
    throw new AgentImportGitError("unsafe_git_entry", `source history contains unsafe path ${relative} at ${commit}`);
  }
  if (entry.mode !== "100644" && entry.mode !== "100755") {
    throw new AgentImportGitError("unsafe_git_entry", `source history contains mode ${entry.mode} at ${relative} in ${commit}`);
  }
}

function assertSafeCommitTree(
  rootTree: string,
  commit: string,
  trees: Map<string, RawTreeEntry[]>,
  checked: Set<string>,
): void {
  const stack = [{ objectId: rootTree, prefix: "" }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const cacheKey = `${current.objectId}\0${current.prefix}`;
    if (checked.has(cacheKey)) continue;
    checked.add(cacheKey);
    const entries = trees.get(current.objectId);
    if (!entries) throw new AgentImportGitError("invalid_git_tree", "reachable git tree object is missing");
    for (const entry of entries) {
      const relative = current.prefix ? `${current.prefix}/${entry.name}` : entry.name;
      if (entry.mode === "040000") {
        stack.push({ objectId: entry.objectId, prefix: relative });
      } else {
        assertSafeHistoryEntry(entry, relative, commit);
      }
    }
  }
}

async function assertSafeHistoryTrees(repoDir: string, head: string): Promise<void> {
  const commits = (await git(repoDir, ["log", "--format=%H%x09%T", head])).split(/\r?\n/).map((line) => {
    const [commit, tree] = line.split("\t", 2);
    return { commit: requireSha(commit, "history commit"), tree: requireSha(tree, "history tree") };
  });
  const trees = await historyTrees(repoDir, head);
  const checked = new Set<string>();
  for (const { commit, tree } of commits) assertSafeCommitTree(tree, commit, trees, checked);
}

export async function inspectAgentImportRepository(
  repoDir: string,
  options: {
    head?: string;
    scanSecrets?: (repoDir: string) => Promise<AgentImportSecretFinding[]>;
  } = {},
): Promise<AgentImportRepositoryInspection> {
  const head = requireSha(options.head ?? await git(repoDir, ["rev-parse", "HEAD"]), SOURCE_HEAD_LABEL);
  await git(repoDir, ["cat-file", "-e", `${head}^{commit}`], undefined, "source commit lookup");
  await assertAgentImportRepositoryExpansionSafe(repoDir, head);
  await git(repoDir, ["fsck", "--strict", "--no-dangling"], undefined, "git fsck");
  const tree = await trackedTree(repoDir, head);
  const commitCount = Number.parseInt(await git(repoDir, ["rev-list", "--count", head]), 10);
  if (!Number.isFinite(commitCount) || commitCount < 1) {
    throw new AgentImportGitError("invalid_git_history", "source history has no reachable commit");
  }
  if (commitCount > MAX_IMPORT_COMMITS) {
    throw new AgentImportGitError("invalid_git_history", `source history exceeds ${MAX_IMPORT_COMMITS} commits`);
  }
  await assertSafeHistoryTrees(repoDir, head);
  const scanSecrets = options.scanSecrets ?? ((dir: string) => scanAgentImportSecrets(dir));
  const secretFindings = await scanSecrets(repoDir);
  if (secretFindings.length > 0) {
    throw new AgentImportGitError(
      "secret_findings",
      "source repository contains credential-like material",
      secretFindings,
    );
  }
  return {
    head,
    commitCount,
    fileCount: tree.fileCount,
    totalBytes: tree.totalBytes,
    workspaceDigest: `sha256:${createHash("sha256").update(head).update("\0").update(tree.serialized).digest("hex")}`,
    secretFindings,
  };
}

interface SanitizedHistoryEntry {
  mode: "100644" | "100755";
  objectId: string;
  relative: string;
}

interface SanitizedHistoryCommit {
  commit: string;
  parents: string[];
  entries: SanitizedHistoryEntry[];
}

function rawHistoryEntries(contents: Buffer, commit: string): {
  entries: SanitizedHistoryEntry[];
  removedBlockedPath: boolean;
} {
  const entries: SanitizedHistoryEntry[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let removedBlockedPath = false;
  let offset = 0;
  while (offset < contents.length) {
    const end = contents.indexOf(0, offset);
    if (end < 0) throw new AgentImportGitError("invalid_git_tree", GIT_TREE_OUTPUT_MALFORMED);
    const tab = contents.indexOf(0x09, offset);
    if (tab < 0 || tab >= end) throw new AgentImportGitError("invalid_git_tree", GIT_TREE_OUTPUT_MALFORMED);
    const header = contents.subarray(offset, tab).toString("ascii");
    const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})$/.exec(header);
    if (!match) throw new AgentImportGitError("invalid_git_tree", GIT_TREE_OUTPUT_MALFORMED);
    let relative: string;
    try {
      relative = decoder.decode(contents.subarray(tab + 1, end));
    } catch {
      throw new AgentImportGitError("unsafe_git_entry", `source history contains an invalid path at ${commit}`);
    }
    const mode = match[1]!;
    if ((mode !== "100644" && mode !== "100755") || match[2] !== "blob") {
      throw new AgentImportGitError("unsafe_git_entry", `source history contains an unsafe path ${relative} at ${commit}`);
    }
    if (classifyAgentImportArchivePath(`workspace/${relative}`) !== "workspace") {
      removedBlockedPath = true;
    } else {
      entries.push({ mode, objectId: match[3]!, relative });
    }
    offset = end + 1;
  }
  return { entries, removedBlockedPath };
}

async function historyEntriesForCommit(repoDir: string, commit: string): Promise<{
  entries: SanitizedHistoryEntry[];
  removedBlockedPath: boolean;
}> {
  const result = await gitChild(repoDir, ["ls-tree", "-r", "-z", commit], {
    maxOutput: MAX_TREE_METADATA_OUTPUT,
  });
  if (result.error || result.status !== 0) {
    throw safeCommandError("git history tree inspection", {
      status: result.status,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
      ...(result.error ? { error: result.error } : {}),
    });
  }
  return rawHistoryEntries(result.stdout, commit);
}

async function writeSanitizedHistoryTree(repoDir: string, entries: SanitizedHistoryEntry[]): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-agent-import-index-"));
  const indexPath = path.join(root, "index");
  const env = buildAgentImportGitEnvironment(process.env, { GIT_INDEX_FILE: indexPath });
  try {
    await git(repoDir, ["read-tree", "--empty"], env, "git empty index");
    if (entries.length > 0) {
      const indexInfo = Buffer.from(entries.map(({ mode, objectId, relative }) =>
        `${mode} ${objectId}\t${relative}\0`
      ).join(""), "utf8");
      await gitCommand(repoDir, ["update-index", "-z", "--index-info"], {
        env,
        input: indexInfo,
        label: "git sanitized index",
      });
    }
    return requireSha(await git(repoDir, ["write-tree"], env, "git sanitized tree"), "sanitized tree");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function commitSanitizedHistory(
  repoDir: string,
  tree: string,
  parents: string[],
): Promise<string> {
  const env = buildAgentImportGitEnvironment(process.env, {
    GIT_AUTHOR_NAME: "Octogee Agent Import",
    GIT_AUTHOR_EMAIL: "agent-import@octogee.invalid",
    GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Octogee Agent Import",
    GIT_COMMITTER_EMAIL: "agent-import@octogee.invalid",
    GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
  });
  return requireSha(await gitCommand(
    repoDir,
    ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])],
    {
      env,
      input: "Sanitized agent import history\n",
      label: "git sanitized history commit",
    },
  ), "sanitized history commit");
}

async function deleteSourceRef(repoDir: string, ref: string): Promise<void> {
  const symbolic = await gitDefault(repoDir, ["symbolic-ref", "-q", ref]);
  if (!symbolic.error && symbolic.status === 0) {
    await git(repoDir, ["symbolic-ref", DELETE_REF_ARGUMENT, ref], undefined, GIT_SOURCE_REF_CLEANUP);
    return;
  }
  if (symbolic.error || (symbolic.status !== 1 && symbolic.status !== 128)) {
    throw safeCommandError("git symbolic source ref inspection", symbolic);
  }
  await git(repoDir, [UPDATE_REF_COMMAND, DELETE_REF_ARGUMENT, ref], undefined, GIT_SOURCE_REF_CLEANUP);
}

export async function sanitizeAgentImportRepositoryHistory(repoDir: string, head: string): Promise<string> {
  const sourceHead = requireSha(head, SOURCE_HEAD_LABEL);
  const lines = (await git(repoDir, ["rev-list", "--parents", "--topo-order", "--reverse", sourceHead]))
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_IMPORT_COMMITS) {
    throw new AgentImportGitError("invalid_git_history", "source history has an unsupported commit count");
  }
  const history: SanitizedHistoryCommit[] = [];
  let removedBlockedPath = false;
  for (const line of lines) {
    const [commit, ...parents] = line.split(" ");
    const checkedCommit = requireSha(commit ?? "", "history commit");
    const checkedParents = parents.map((parent) => requireSha(parent, "history parent"));
    const tree = await historyEntriesForCommit(repoDir, checkedCommit);
    history.push({ commit: checkedCommit, parents: checkedParents, entries: tree.entries });
    removedBlockedPath ||= tree.removedBlockedPath;
  }
  if (!removedBlockedPath) return sourceHead;

  const rewritten = new Map<string, string>();
  for (const { commit, parents, entries } of history) {
    const rewrittenParents = parents.map((parent) => {
      const rewrittenParent = rewritten.get(parent);
      if (!rewrittenParent) throw new AgentImportGitError("invalid_git_history", "source history parent is missing");
      return rewrittenParent;
    });
    const tree = await writeSanitizedHistoryTree(repoDir, entries);
    rewritten.set(commit, await commitSanitizedHistory(repoDir, tree, rewrittenParents));
  }
  const sanitizedHead = rewritten.get(sourceHead);
  if (!sanitizedHead) throw new AgentImportGitError("invalid_git_history", "sanitized source head is missing");

  const sanitizedRef = "refs/heads/octogee-import";
  await git(repoDir, [UPDATE_REF_COMMAND, sanitizedRef, sanitizedHead], undefined, "git sanitized source ref");
  await git(repoDir, ["symbolic-ref", "HEAD", sanitizedRef], undefined, "git sanitized source head");
  const refs = (await git(repoDir, ["for-each-ref", "--format=%(refname)", "refs"]))
    .split(/\r?\n/)
    .filter(Boolean);
  for (const ref of refs) {
    if (ref !== sanitizedRef) await deleteSourceRef(repoDir, ref);
  }
  await git(repoDir, ["reset", "--hard", sanitizedHead], undefined, "git sanitized source checkout");
  return sanitizedHead;
}

function readDirectory(sourceDir: string, destinationDir: string): void {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new AgentImportGitError("unsafe_git_entry", "workspace symlinks are not importable");
    }
    if (stat.isDirectory()) readDirectory(sourcePath, destinationPath);
    else if (stat.isFile()) fs.copyFileSync(sourcePath, destinationPath);
    else throw new AgentImportGitError("unsafe_git_entry", "workspace contains an unsupported filesystem entry");
  }
}

function clearWorkingTree(repoDir: string): void {
  for (const entry of fs.readdirSync(repoDir)) {
    if (entry !== ".git") fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true });
  }
}

function preserveTargetDirectory(targetDir: string, stageDir: string, relativePath: string): void {
  const source = path.join(targetDir, relativePath);
  const destination = path.join(stageDir, relativePath);
  fs.rmSync(destination, { recursive: true, force: true });
  if (!fs.existsSync(source)) return;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new AgentImportGitError("unsafe_platform_path", `${relativePath} is a symlink`);
  if (!stat.isDirectory()) {
    throw new AgentImportGitError("unsafe_platform_path", `${relativePath} is not a directory`);
  }
  readDirectory(source, destination);
}

function preserveTargetFile(targetDir: string, stageDir: string, relativePath: string): void {
  const source = path.join(targetDir, relativePath);
  const destination = path.join(stageDir, relativePath);
  if (!fs.existsSync(source)) {
    fs.rmSync(destination, { recursive: true, force: true });
    return;
  }
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new AgentImportGitError("unsafe_platform_path", `${relativePath} is a symlink`);
  if (!stat.isFile()) return;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function mergeGitignore(targetDir: string, stageDir: string): void {
  const sourcePath = path.join(stageDir, ".gitignore");
  const targetPath = path.join(targetDir, ".gitignore");
  const lines = [sourcePath, targetPath].flatMap((filePath) =>
    fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split(/\r?\n/) : []
  );
  const merged = [...new Set(lines.map((line) => line.trimEnd()).filter(Boolean))];
  if (merged.length > 0) fs.writeFileSync(sourcePath, `${merged.join("\n")}\n`);
}

function walkFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (current === root && entry.name === ".git") continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new AgentImportGitError("unsafe_git_entry", `workspace path ${relative} is a symlink`);
    if (stat.isDirectory()) files.push(...walkFiles(root, absolute));
    else if (stat.isFile()) files.push(relative);
    else throw new AgentImportGitError("unsafe_git_entry", `workspace path ${relative} has an unsupported type`);
  }
  return files.sort();
}

function probablyText(filePath: string, contents: Buffer): boolean {
  if (isTextFile(filePath) || path.basename(filePath) === ".gitignore") return true;
  if (contents.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return true;
  } catch {
    return false;
  }
}

function readManifest(targetDir: string): Record<string, AgentImportManifestEntry> {
  const manifestPath = path.join(targetDir, ".files", "manifest.json");
  if (!fs.existsSync(manifestPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, AgentImportManifestEntry>;
  } catch {
    throw new AgentImportGitError("invalid_platform_manifest", "destination blob manifest is invalid");
  }
}

function readBoundedImportFile(file: string, maxBytes: number, tooLarge: () => AgentImportGitError): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("import file is not a regular file");
    if (stat.size > maxBytes) throw tooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - size));
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      size += read;
      if (size > maxBytes) throw tooLarge();
      chunks.push(chunk.subarray(0, read));
    }
    return Buffer.concat(chunks, size);
  } finally { fs.closeSync(fd); }
}

async function normalizeBinaryTip(options: {
  stageDir: string;
  targetDir: string;
  storeBlob: (filePath: string, contents: Buffer, mimeType: string) => Promise<AgentImportManifestEntry>;
}): Promise<void> {
  const manifest = readManifest(options.targetDir);
  for (const relative of walkFiles(options.stageDir)) {
    if (relative === ".files/manifest.json" || relative.startsWith(".files/") || relative.startsWith("projects/")) continue;
    const absolute = path.join(options.stageDir, relative);
    const contents = readBoundedImportFile(absolute, MAX_BINARY_BYTES,
      () => new AgentImportGitError("binary_too_large", `${relative} exceeds the import blob limit`));
    delete manifest[relative];
    if (probablyText(relative, contents)) continue;
    const mimeType = getMimeType(getExtension(relative));
    manifest[relative] = await options.storeBlob(relative, contents, mimeType);
    fs.rmSync(absolute);
  }
  const manifestPath = path.join(options.stageDir, ".files", "manifest.json");
  if (Object.keys(manifest).length === 0) {
    fs.rmSync(manifestPath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function commitTree(
  repoDir: string,
  tree: string,
  parents: string[],
  message: string,
): Promise<string> {
  const env = buildAgentImportGitEnvironment(process.env, {
    GIT_AUTHOR_NAME: "Octogee Agent Import",
    GIT_AUTHOR_EMAIL: "agent-import@octogee.invalid",
    GIT_COMMITTER_NAME: "Octogee Agent Import",
    GIT_COMMITTER_EMAIL: "agent-import@octogee.invalid",
  });
  return requireSha(await gitCommand(
    repoDir,
    ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])],
    { env, input: `${message}\n`, label: "git commit-tree" },
  ), "created commit");
}

function checkedImportId(importId: string): string {
  if (!IMPORT_ID_RE.test(importId)) throw new AgentImportGitError("invalid_import_id", "import id is invalid");
  return importId;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

async function currentMainHead(targetDir: string): Promise<string> {
  const branch = await git(targetDir, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== "main") throw new AgentImportGitError("destination_branch", "destination workspace must be on main");
  return requireSha(await git(targetDir, ["rev-parse", "HEAD"]), "destination head");
}

async function ensureCleanDestination(targetDir: string): Promise<void> {
  if (await git(targetDir, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new AgentImportGitError("destination_dirty", "destination workspace has uncommitted changes");
  }
}

interface PublishedRef {
  ref: string;
  expected: string;
}

interface TargetUpdate {
  targetDir: string;
  destinationHead: string;
  nextHead: string;
  sourceHead?: string;
  sourceRef?: string;
  importRef?: string;
  rollbackRef?: string;
  push: boolean;
}

interface WorkspaceMutationLease {
  release(): void;
}

type WorkspaceMutationLeaseFactory = (workspaceDir: string) => WorkspaceMutationLease | null;

async function withWorkspaceMutationLease<T>(
  workspaceDir: string,
  acquire: WorkspaceMutationLeaseFactory,
  work: () => Promise<T>,
): Promise<T> {
  const lease = acquire(workspaceDir);
  if (!lease) throw new AgentImportGitError("workspace_busy", "workspace is busy; retry the import shortly");
  let result: T;
  try {
    result = await work();
  } catch (error) {
    try {
      lease.release();
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "workspace mutation and lease release both failed", {
        cause: error,
      });
    }
    throw error;
  }
  lease.release();
  return result;
}

async function remoteRefsMatch(targetDir: string, refs: PublishedRef[]): Promise<boolean> {
  const output = await git(
    targetDir,
    ["ls-remote", "--refs", "origin", ...refs.map(({ ref }) => ref)],
    undefined,
    "Gitea ref verification",
  );
  const remote = new Map(output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [head, ref] = line.split("\t", 2);
    return [ref, head];
  }));
  return refs.every(({ ref, expected }) => remote.get(ref) === expected);
}

async function publishRefs(targetDir: string, refs: PublishedRef[]): Promise<void> {
  try {
    await git(
      targetDir,
      ["push", "--atomic", "origin", ...refs.map(({ ref }) => `${ref}:${ref}`)],
      undefined,
      "Gitea push",
    );
  } catch (error) {
    try {
      if (await remoteRefsMatch(targetDir, refs)) return;
    } catch {
      throw new AgentImportGitError(
        "push_outcome_unknown",
        "Gitea push outcome could not be verified; retry the same import",
      );
    }
    throw error;
  }
}

function targetRefs(options: TargetUpdate): PublishedRef[] {
  const refs: PublishedRef[] = [{ ref: MAIN_REF, expected: options.nextHead }];
  if (options.sourceHead && options.sourceRef) refs.push({ ref: options.sourceRef, expected: options.sourceHead });
  if (options.importRef) refs.push({ ref: options.importRef, expected: options.nextHead });
  if (options.rollbackRef) refs.push({ ref: options.rollbackRef, expected: options.nextHead });
  return refs;
}

async function restoreTarget(options: TargetUpdate, refs: PublishedRef[]): Promise<void> {
  await git(options.targetDir, [UPDATE_REF_COMMAND, MAIN_REF, options.destinationHead, options.nextHead]);
  await git(options.targetDir, ["read-tree", "-u", "-m", options.nextHead, options.destinationHead]);
  for (const { ref, expected } of refs.slice(1)) {
    await git(options.targetDir, [UPDATE_REF_COMMAND, DELETE_REF_ARGUMENT, ref, expected]);
  }
}

async function updateTarget(options: TargetUpdate): Promise<void> {
  const refs = targetRefs(options);
  await git(options.targetDir, [UPDATE_REF_COMMAND, MAIN_REF, options.nextHead, options.destinationHead]);
  try {
    for (const { ref, expected } of refs.slice(1)) {
      await git(options.targetDir, [UPDATE_REF_COMMAND, ref, expected, EMPTY_REF]);
    }
    await git(options.targetDir, ["read-tree", "-u", "-m", options.destinationHead, options.nextHead]);
    if (options.push) await publishRefs(options.targetDir, refs);
  } catch (error) {
    if (error instanceof AgentImportGitError && error.code === "push_outcome_unknown") throw error;
    try {
      await restoreTarget(options, refs);
    } catch {
      throw new AgentImportGitError("destination_restore_failed", "workspace import failed and local restore also failed");
    }
    throw error;
  }
}

interface ApplyAgentImportRepositoryOptions {
  sourceDir: string;
  sourceHead: string;
  targetDir: string;
  destinationHead: string;
  importId: string;
  slug: string;
  workspacePolicy: AgentImportWorkspacePolicy;
  storeBlob: (filePath: string, contents: Buffer, mimeType: string) => Promise<AgentImportManifestEntry>;
  cleanupBlobs: () => Promise<void>;
  push?: boolean;
  acquireMutationLease?: WorkspaceMutationLeaseFactory;
  beforeTargetUpdate?: () => void;
}

async function resumeAgentImportRepository(
  options: ApplyAgentImportRepositoryOptions,
  refs: {
    sourceHead: string;
    destinationHead: string;
    importId: string;
    sourceRef: string;
    importRef: string;
    currentHead: string;
  },
): Promise<{ importCommit: string; sourceRef: string } | null> {
  if (refs.currentHead === refs.destinationHead) return null;
  const parents = (await git(options.targetDir, ["rev-list", "--parents", "-n", "1", refs.currentHead])).split(" ");
  const subject = await git(options.targetDir, ["show", "-s", "--format=%s", refs.currentHead]);
  const matches =
    await readRef(options.targetDir, refs.sourceRef) === refs.sourceHead &&
    await readRef(options.targetDir, refs.importRef) === refs.currentHead &&
    parents.length === 3 &&
    parents[1] === refs.destinationHead &&
    parents[2] === refs.sourceHead &&
    subject === `Import agent workspace (${refs.importId})`;
  if (!matches) {
    throw new AgentImportGitError("destination_changed", "destination workspace changed after preview");
  }
  if (options.push !== false) {
    await withWorkspaceMutationLease(
      options.targetDir,
      options.acquireMutationLease ?? ((workspaceDir) => acquireWorkspaceMutationLeaseSync({
        workspaceDir,
        gitDir: workspaceMutationLeaseGitDir(workspaceDir),
      })),
      async () => {
        if (await currentMainHead(options.targetDir) !== refs.currentHead) {
          throw new AgentImportGitError("destination_changed", "destination workspace changed after preview");
        }
        await publishRefs(options.targetDir, [
          { ref: MAIN_REF, expected: refs.currentHead },
          { ref: refs.sourceRef, expected: refs.sourceHead },
          { ref: refs.importRef, expected: refs.currentHead },
        ]);
      },
    );
  }
  return { importCommit: refs.currentHead, sourceRef: refs.sourceRef };
}

export async function applyAgentImportRepository(
  options: ApplyAgentImportRepositoryOptions,
): Promise<{ importCommit: string; sourceRef: string }> {
  const sourceHead = requireSha(options.sourceHead, SOURCE_HEAD_LABEL);
  const destinationHead = requireSha(options.destinationHead, "destination head");
  const importId = checkedImportId(options.importId);
  const sourceRef = `refs/octogee/imports/${importId}/source`;
  const importRef = `refs/octogee/imports/${importId}/commit`;
  await ensureCleanDestination(options.targetDir);
  if (requireSha(await git(options.sourceDir, ["rev-parse", "HEAD"]), SOURCE_HEAD_LABEL) !== sourceHead) {
    throw new AgentImportGitError("source_changed", "source workspace changed after preview");
  }
  await trackedTree(options.sourceDir, sourceHead);
  await assertSafeHistoryTrees(options.sourceDir, sourceHead);
  const currentHead = await currentMainHead(options.targetDir);
  const resumed = await resumeAgentImportRepository(options, {
    sourceHead, destinationHead, importId, sourceRef, importRef, currentHead,
  });
  if (resumed) return resumed;
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-agent-import-apply-"));
  const stageDir = path.join(stageRoot, "source");
  let retainBlobs = false;
  try {
    await command(
      GIT_COMMAND,
      [
        ...WORKSPACE_GIT_HARDENING_PINS,
        "-c", "protocol.file.allow=always",
        "clone", "--quiet", "--no-hardlinks", options.sourceDir, stageDir,
      ],
      {
        env: agentImportGitEnvironment(),
        label: "source staging clone",
      },
    );
    clearWorkingTree(stageDir);
    readDirectory(options.sourceDir, stageDir);
    for (const platformPath of PLATFORM_MANAGED_WORKSPACE_DIRECTORIES) {
      preserveTargetDirectory(options.targetDir, stageDir, platformPath);
    }
    for (const platformPath of platformPreservedFiles(options.workspacePolicy)) {
      preserveTargetFile(options.targetDir, stageDir, platformPath);
    }
    mergeGitignore(options.targetDir, stageDir);
    await normalizeBinaryTip({ stageDir, targetDir: options.targetDir, storeBlob: options.storeBlob });
    await git(stageDir, ["add", "-A", "--", "."]);
    const tree = requireSha(await git(stageDir, ["write-tree"]), "import tree");
    await git(stageDir, ["fetch", "--quiet", "--no-tags", options.targetDir, destinationHead]);
    const importCommit = await commitTree(
      stageDir,
      tree,
      [destinationHead, sourceHead],
      `Import agent workspace (${importId})`,
    );
    await git(options.targetDir, ["fetch", "--quiet", "--no-tags", stageDir, importCommit]);
    await withWorkspaceMutationLease(
      options.targetDir,
      options.acquireMutationLease ?? ((workspaceDir) => acquireWorkspaceMutationLeaseSync({
        workspaceDir,
        gitDir: workspaceMutationLeaseGitDir(workspaceDir),
      })),
      async () => {
        await ensureCleanDestination(options.targetDir);
        if (await currentMainHead(options.targetDir) !== destinationHead) {
          throw new AgentImportGitError("destination_changed", "destination workspace changed after preview");
        }
        options.beforeTargetUpdate?.();
        await updateTarget({
          targetDir: options.targetDir,
          destinationHead,
          nextHead: importCommit,
          sourceHead,
          sourceRef,
          importRef,
          push: options.push !== false,
        });
      },
    );
    retainBlobs = true;
    return { importCommit, sourceRef };
  } catch (error) {
    if (error instanceof AgentImportGitError && error.code === "push_outcome_unknown") retainBlobs = true;
    if (!retainBlobs) {
      try {
        await options.cleanupBlobs();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "agent import failed and blob cleanup also failed", {
          cause: error,
        });
      }
    }
    throw error;
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

export async function rollbackAgentImportRepository(options: {
  targetDir: string;
  importCommit: string;
  destinationHead: string;
  importId: string;
  push?: boolean;
  acquireMutationLease?: WorkspaceMutationLeaseFactory;
  beforeTargetUpdate?: () => void;
}): Promise<{ rollbackCommit: string }> {
  const importCommit = requireSha(options.importCommit, "import commit");
  const destinationHead = requireSha(options.destinationHead, "destination head");
  const importId = checkedImportId(options.importId);
  const rollbackRef = `refs/octogee/imports/${importId}/rollback`;
  await ensureCleanDestination(options.targetDir);
  const current = await currentMainHead(options.targetDir);
  if (current !== importCommit) {
    const parents = (await git(options.targetDir, ["rev-list", "--parents", "-n", "1", current])).split(" ");
    const subject = await git(options.targetDir, ["show", "-s", "--format=%s", current]);
    const currentTree = requireSha(await git(options.targetDir, ["rev-parse", `${current}^{tree}`]), "rollback tree");
    const destinationTree = requireSha(await git(options.targetDir, ["rev-parse", `${destinationHead}^{tree}`]), "destination tree");
    if (
      await readRef(options.targetDir, rollbackRef) === current &&
      parents.length === 2 &&
      parents[1] === importCommit &&
      subject === `Rollback agent import (${importId})` &&
      currentTree === destinationTree
    ) {
      if (options.push !== false) {
        await withWorkspaceMutationLease(
          options.targetDir,
          options.acquireMutationLease ?? ((workspaceDir) => acquireWorkspaceMutationLeaseSync({
            workspaceDir,
            gitDir: workspaceMutationLeaseGitDir(workspaceDir),
          })),
          async () => {
            if (await currentMainHead(options.targetDir) !== current) {
              throw new AgentImportGitError("rollback_window_closed", "workspace changed after import");
            }
            await publishRefs(options.targetDir, [
              { ref: MAIN_REF, expected: current },
              { ref: rollbackRef, expected: current },
            ]);
          },
        );
      }
      return { rollbackCommit: current };
    }
    throw new AgentImportGitError("rollback_window_closed", "workspace changed after import");
  }
  await git(options.targetDir, ["cat-file", "-e", `${destinationHead}^{commit}`]);
  const destinationTree = requireSha(await git(options.targetDir, ["rev-parse", `${destinationHead}^{tree}`]), "rollback tree");
  const rollbackCommit = await commitTree(
    options.targetDir,
    destinationTree,
    [importCommit],
    `Rollback agent import (${importId})`,
  );
  await withWorkspaceMutationLease(
    options.targetDir,
    options.acquireMutationLease ?? ((workspaceDir) => acquireWorkspaceMutationLeaseSync({
      workspaceDir,
      gitDir: workspaceMutationLeaseGitDir(workspaceDir),
    })),
    async () => {
      await ensureCleanDestination(options.targetDir);
      if (await currentMainHead(options.targetDir) !== importCommit) {
        throw new AgentImportGitError("rollback_window_closed", "workspace changed after import");
      }
      options.beforeTargetUpdate?.();
      await updateTarget({
        targetDir: options.targetDir,
        destinationHead: importCommit,
        nextHead: rollbackCommit,
        rollbackRef,
        push: options.push !== false,
      });
    },
  );
  return { rollbackCommit };
}

function readAgentImportSecretReport(reportPath: string): unknown {
  let report: string;
  try {
    report = readBoundedImportFile(reportPath, MAX_SECRET_REPORT_BYTES,
      () => new AgentImportGitError("secret_findings", "source repository contains too many credential-like findings")).toString("utf8");
  } catch (error) {
    if (error instanceof AgentImportGitError) throw error;
    throw new AgentImportGitError("secret_scan_failed", "secret scanner returned no valid report");
  }
  try {
    return JSON.parse(report);
  } catch {
    throw new AgentImportGitError("secret_scan_failed", "secret scanner returned no valid report");
  }
}

export async function scanAgentImportSecrets(
  repoDir: string,
  options: { currentOnly?: boolean; run?: CommandRunner; configPath?: string } = {},
): Promise<AgentImportSecretFinding[]> {
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-agent-import-scan-"));
  const ignorePath = path.join(reportDir, "trusted-empty-ignore");
  const reportPath = path.join(reportDir, "report.json");
  try {
    fs.writeFileSync(ignorePath, "", { mode: 0o600 });
    const args = [
      "detect",
      "--source", repoDir,
      "--config", options.configPath ?? "/gateway-edge/agent-import-gitleaks.toml",
      "--gitleaks-ignore-path", ignorePath,
      "--ignore-gitleaks-allow",
      "--redact",
      "--report-format", "json",
      "--report-path", reportPath,
      "--exit-code", "1",
      ...(options.currentOnly ? ["--no-git"] : []),
    ];
    const result = await (options.run ?? defaultRun)("/usr/local/bin/gitleaks", args, {
      cwd: repoDir,
      env: buildAgentImportGitEnvironment(process.env, {
        HOME: reportDir,
      }),
      maxOutput: MAX_SECRET_REPORT_BYTES,
    });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") {
      throw new AgentImportGitError("secret_findings", "source repository contains too many credential-like findings");
    }
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw new AgentImportGitError("secret_scan_failed", "secret scanner failed closed");
    }
    if (result.status === 0) return [];
    const raw = readAgentImportSecretReport(reportPath);
    if (!Array.isArray(raw)) {
      throw new AgentImportGitError("secret_scan_failed", "secret scanner report is invalid");
    }
    if (raw.length === 0) {
      throw new AgentImportGitError("secret_scan_failed", "secret scanner reported findings without a valid report");
    }
    return raw.slice(0, 100).map((finding) => {
      const item = finding && typeof finding === "object" && !Array.isArray(finding)
        ? finding as Record<string, unknown>
        : {};
      if (
        typeof item.RuleID !== "string" || !/^[A-Za-z0-9._-]{1,160}$/u.test(item.RuleID) ||
        typeof item.File !== "string" || item.File.length > 2_048 || hasControlCharacter(item.File) ||
        (item.Commit !== undefined && item.Commit !== "" && (typeof item.Commit !== "string" || !SHA_RE.test(item.Commit)))
      ) {
        throw new AgentImportGitError("secret_scan_failed", "secret scanner finding is invalid");
      }
      return {
        ruleId: item.RuleID,
        path: item.File,
        commit: typeof item.Commit === "string" && item.Commit ? item.Commit : null,
      };
    });
  } finally {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }
}
