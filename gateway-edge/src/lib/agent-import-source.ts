import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

import {
  AGENT_IMPORT_FORMAT_VERSION,
  classifyAgentImportArchivePath,
  validateAgentImportConfigArtifacts,
  type AgentImportConfigArtifacts,
} from "@octogee/shared/types/agent-import";
import {
  assertAgentImportRepositoryExpansionSafe,
  sanitizeAgentImportRepositoryHistory,
} from "./agent-import-git.js";
import {
  WORKSPACE_GIT_HARDENING_PINS,
  workspaceGitCommandArgs,
  workspaceGitEnvironment,
} from "@octogee/core/workspace/workspace-git";

const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 25_000;

export interface LocalAgentImportManifest {
  formatVersion: typeof AGENT_IMPORT_FORMAT_VERSION;
  sourceAgentId: string;
  hadGit: boolean;
  uncommittedFileCount: number;
}

export interface ExtractedAgentImportSource {
  repoDir: string;
  sourceHead: string;
  artifacts: AgentImportConfigArtifacts;
  manifest: LocalAgentImportManifest;
  cleanup(): void;
}

export interface ClonedGithubAgentImportSource {
  repoDir: string;
  sourceHead: string;
  cleanup(): void;
}

export class AgentImportSourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentImportSourceError";
  }
}

function sourceGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: source.LANG ?? "C.UTF-8",
    LC_ALL: source.LC_ALL ?? "C.UTF-8",
    HOME: "/tmp",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = sourceGitEnvironment()): Promise<string> {
  return new Promise((resolve, reject) => {
    const githubToken = env.OCTOGEE_GITHUB_TOKEN;
    let commandArgs: string[];
    if (fs.existsSync(path.join(cwd, ".git"))) {
      commandArgs = workspaceGitCommandArgs(cwd, args, Boolean(githubToken));
    } else if (githubToken) {
      commandArgs = githubAgentImportCloneCommandArgs(args);
    } else {
      commandArgs = [...WORKSPACE_GIT_HARDENING_PINS, ...args];
    }
    const child = spawn("/usr/bin/git", commandArgs, {
      cwd,
      env: workspaceGitEnvironment(env, cwd, githubToken),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: Error | null = null;
    const timer = setTimeout(() => {
      failure = new Error("source git operation timed out");
      child.kill("SIGKILL");
    }, 120_000);
    const collect = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        failure = new Error("source git output exceeded limit");
        child.kill("SIGKILL");
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => { failure = error; });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (failure || status !== 0) {
        reject(new AgentImportSourceError(
          "git_source_invalid",
          `source git ${args[0] ?? "operation"} failed (exit ${String(status)})`,
        ));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

function validBranch(branch: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,249}$/.test(branch) &&
    !branch.includes("..") && !branch.includes("@{") && !branch.endsWith("/") &&
    !branch.endsWith(".") && !branch.endsWith(".lock");
}

export function githubAgentImportCloneUrl(owner: string, repo: string): string {
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo.startsWith("-")) {
    throw new AgentImportSourceError("invalid_github_source", "GitHub owner or repository is invalid");
  }
  return `https://github.com/${owner}/${repo}.git`;
}

function githubAgentImportCloneCredentialHelper(): string {
  const secretField = ["pass", "word"].join("");
  return `credential.https://github.com.helper=!f() { test "$1" = get || exit 0; printf '%s\\n' username=x-access-token ${secretField}="$OCTOGEE_GITHUB_TOKEN"; }; f`;
}

export function githubAgentImportCloneCommandArgs(args: ReadonlyArray<string>): string[] {
  return [
    ...WORKSPACE_GIT_HARDENING_PINS,
    "-c",
    githubAgentImportCloneCredentialHelper(),
    ...args,
  ];
}

export function githubAgentImportCloneEnvironment(
  token: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!token || /[\r\n]/.test(token)) {
    throw new AgentImportSourceError("invalid_github_token", "GitHub OAuth token is invalid");
  }
  return sourceGitEnvironment(source, {
    OCTOGEE_GITHUB_TOKEN: token,
  });
}

export async function cloneGithubAgentImportSource(options: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  tmpRoot?: string;
}): Promise<ClonedGithubAgentImportSource> {
  if (!validBranch(options.branch)) {
    throw new AgentImportSourceError("invalid_github_source", "GitHub branch is invalid");
  }
  const root = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), "octogee-agent-import-github-"));
  const repoDir = path.join(root, "source");
  try {
    try {
      await runGit(root, [
      "clone", "--quiet", "--single-branch", "--no-checkout", "--no-tags", "--branch", options.branch,
        githubAgentImportCloneUrl(options.owner, options.repo), repoDir,
      ], githubAgentImportCloneEnvironment(options.token));
    } catch {
      throw new AgentImportSourceError("github_clone_failed", "GitHub repository could not be cloned");
    }
    const sourceHead = await runGit(repoDir, ["rev-parse", "HEAD"]);
    if (!SHA_RE.test(sourceHead)) throw new AgentImportSourceError("git_source_invalid", "GitHub source has no commit");
    const sanitizedHead = await sanitizeAgentImportRepositoryHistory(repoDir, sourceHead);
    await assertAgentImportRepositoryExpansionSafe(repoDir, sanitizedHead);
    await runGit(repoDir, ["reset", "--hard", sanitizedHead]);
    return {
      repoDir,
      sourceHead: sanitizedHead,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function jsonObject(buffer: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new AgentImportSourceError("invalid_archive_metadata", `${label} must contain a JSON object`);
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new AgentImportSourceError("invalid_archive_metadata", `${label} must contain a JSON object`);
}

function localManifest(value: unknown): LocalAgentImportManifest {
  const manifest = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (
    Object.keys(manifest).some((key) => ![
      "formatVersion", "sourceAgentId", "hadGit", "uncommittedFileCount",
    ].includes(key)) ||
    manifest.formatVersion !== AGENT_IMPORT_FORMAT_VERSION ||
    typeof manifest.sourceAgentId !== "string" || !manifest.sourceAgentId || manifest.sourceAgentId.length > 160 ||
    typeof manifest.hadGit !== "boolean" ||
    typeof manifest.uncommittedFileCount !== "number" ||
    !Number.isInteger(manifest.uncommittedFileCount) || manifest.uncommittedFileCount < 0
  ) {
    throw new AgentImportSourceError("invalid_archive_metadata", "manifest.json is invalid");
  }
  return manifest as unknown as LocalAgentImportManifest;
}

function zipEntryIsSymlink(entry: JSZip.JSZipObject): boolean {
  const permissions = typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
  return (permissions & 0o170000) === 0o120000;
}

function sanitizedPackedRefs(contents: Buffer): Buffer {
  const text = contents.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(contents)) {
    throw new AgentImportSourceError("unsafe_archive_entry", "packed-refs is not valid UTF-8");
  }
  let mayPeelTag = false;
  const retained: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) {
      retained.push(line);
      continue;
    }
    if (line.startsWith("^")) {
      if (!mayPeelTag || !SHA_RE.test(line.slice(1))) {
        throw new AgentImportSourceError("unsafe_archive_entry", "packed-refs contains an invalid peeled ref");
      }
      retained.push(line);
      mayPeelTag = false;
      continue;
    }
    const match = /^([0-9a-f]{40}) refs\/(heads|tags)\/(.+)$/.exec(line);
    const suffix = match?.[3] ?? "";
    if (match && validBranch(suffix)) {
      retained.push(line);
      mayPeelTag = match[2] === "tags";
      continue;
    }
    const ignored = /^[0-9a-f]{40} refs\/(remotes|notes)\/(.+)$/.exec(line);
    if (ignored && validBranch(ignored[2])) {
      mayPeelTag = false;
      continue;
    }
    throw new AgentImportSourceError("unsafe_archive_entry", "packed-refs contains a blocked ref");
  }
  return Buffer.from(retained.join("\n"), "utf8");
}

function validatedArchiveEntryMetadata(
  entry: JSZip.JSZipObject,
  limits: { maxEntryBytes: number; maxUnpackedBytes: number },
  total: number,
) {
  const classification = classifyAgentImportArchivePath(entry.name);
  if (zipEntryIsSymlink(entry)) {
    throw new AgentImportSourceError("unsafe_archive_entry", `archive entry is not allowed: ${entry.name}`);
  }
  const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  if (typeof declaredSize !== "number" || !Number.isSafeInteger(declaredSize) || declaredSize < 0) {
    throw new AgentImportSourceError("invalid_archive", "agent import archive has invalid size metadata");
  }
  if (declaredSize > limits.maxEntryBytes || total + declaredSize > limits.maxUnpackedBytes) {
    throw new AgentImportSourceError("archive_too_large", `archive entry exceeds its expansion limit: ${entry.name}`);
  }
  if (!classification && !entry.name.startsWith("workspace/")) {
    throw new AgentImportSourceError("unsafe_archive_entry", `archive entry is not allowed: ${entry.name}`);
  }
  return { classification, declaredSize };
}

async function validatedArchiveEntryContents(
  entry: JSZip.JSZipObject,
  maxEntryBytes: number,
): Promise<Buffer> {
  const contents = await entry.async("nodebuffer");
  if (contents.length > maxEntryBytes) {
    throw new AgentImportSourceError("archive_too_large", `archive entry exceeds 32 MiB: ${entry.name}`);
  }
  return contents;
}

async function validatedArchiveEntries(
  buffer: Buffer,
  limits: { maxEntryBytes: number; maxUnpackedBytes: number },
): Promise<Map<string, Buffer>> {
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new AgentImportSourceError("archive_too_large", "agent import archive exceeds 32 MiB");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    throw new AgentImportSourceError("invalid_archive", "agent import archive is not a valid ZIP");
  }
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length > MAX_ENTRIES) {
    throw new AgentImportSourceError("archive_too_large", "agent import archive has too many entries");
  }
  const result = new Map<string, Buffer>();
  let total = 0;
  for (const entry of files) {
    const { classification, declaredSize } = validatedArchiveEntryMetadata(entry, limits, total);
    if (!classification) {
      total += declaredSize;
      continue;
    }
    const contents = await validatedArchiveEntryContents(entry, limits.maxEntryBytes);
    total += contents.length;
    if (total > limits.maxUnpackedBytes) {
      throw new AgentImportSourceError("archive_too_large", "agent import archive exceeds 128 MiB unpacked");
    }
    result.set(entry.name, contents);
  }
  return result;
}

function requireMetadata(entries: Map<string, Buffer>, pathName: string): Buffer {
  const value = entries.get(pathName);
  if (!value) throw new AgentImportSourceError("invalid_archive_metadata", `${pathName} is required`);
  return value;
}

function writeEntry(root: string, relative: string, contents: Buffer, mode = 0o600): void {
  const destination = path.resolve(root, relative);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (!destination.startsWith(rootPrefix)) {
    throw new AgentImportSourceError("unsafe_archive_entry", "archive path escapes its destination");
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents, { mode });
}

async function executablePaths(repoDir: string, head: string): Promise<Set<string>> {
  const output = await runGit(repoDir, ["ls-tree", "-r", "-z", head]);
  return new Set(output.split("\0").flatMap((line) => {
    const tab = line.indexOf("\t");
    return tab >= 0 && line.startsWith("100755 ") ? [line.slice(tab + 1)] : [];
  }));
}

function clearRepoWorktree(repoDir: string): void {
  for (const entry of fs.readdirSync(repoDir)) {
    if (entry !== ".git") fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true });
  }
}

async function commitCurrentTip(repoDir: string, message: string): Promise<string> {
  await runGit(repoDir, ["add", "--all", "--force", "--", "."]);
  const status = await runGit(repoDir, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    const env = sourceGitEnvironment(process.env, {
      GIT_AUTHOR_NAME: "Octogee Agent Import",
      GIT_AUTHOR_EMAIL: "agent-import@octogee.invalid",
      GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Octogee Agent Import",
      GIT_COMMITTER_EMAIL: "agent-import@octogee.invalid",
      GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
    });
    await runGit(repoDir, ["commit", "--quiet", "-m", message], env);
  }
  const head = await runGit(repoDir, ["rev-parse", "HEAD"]);
  if (!SHA_RE.test(head)) throw new AgentImportSourceError("git_source_invalid", "local source has no commit");
  return head;
}

async function initializeLocalRepository(
  repoDir: string,
  entries: Map<string, Buffer>,
  manifest: LocalAgentImportManifest,
  maxGitBlobBytes: number | undefined,
): Promise<Set<string>> {
  const gitEntries = [...entries.entries()].filter(([entry]) => entry.startsWith("git/"));
  if (manifest.hadGit !== (gitEntries.length > 0)) {
    throw new AgentImportSourceError("invalid_archive_metadata", "manifest Git flag does not match archive contents");
  }
  if (!manifest.hadGit) {
    await runGit(repoDir, ["init", "--quiet", "--initial-branch", "main"]);
    return new Set();
  }
  for (const [entry, contents] of gitEntries) {
    const safeContents = entry === "git/packed-refs" ? sanitizedPackedRefs(contents) : contents;
    writeEntry(path.join(repoDir, ".git"), entry.slice("git/".length), safeContents);
  }
  fs.mkdirSync(path.join(repoDir, ".git", "refs", "heads"), { recursive: true, mode: 0o700 });
  const committedHead = await runGit(repoDir, ["rev-parse", "HEAD"]);
  if (!SHA_RE.test(committedHead)) throw new AgentImportSourceError("git_source_invalid", "local Git HEAD is invalid");
  const sourceHead = await sanitizeAgentImportRepositoryHistory(repoDir, committedHead);
  await assertAgentImportRepositoryExpansionSafe(repoDir, sourceHead, {
    ...(maxGitBlobBytes === undefined ? {} : { maxBlobBytes: maxGitBlobBytes }),
  });
  await runGit(repoDir, ["fsck", "--strict"]);
  const trackedExecutables = await executablePaths(repoDir, sourceHead);
  await runGit(repoDir, ["reset", "--hard", sourceHead]);
  clearRepoWorktree(repoDir);
  return trackedExecutables;
}

export async function extractLocalAgentImportArchive(
  buffer: Buffer,
  options: {
    tmpRoot?: string;
    maxEntryBytes?: number;
    maxUnpackedBytes?: number;
    maxGitBlobBytes?: number;
  } = {},
): Promise<ExtractedAgentImportSource> {
  const entries = await validatedArchiveEntries(buffer, {
    maxEntryBytes: options.maxEntryBytes ?? MAX_ENTRY_BYTES,
    maxUnpackedBytes: options.maxUnpackedBytes ?? MAX_UNPACKED_BYTES,
  });
  const manifest = localManifest(jsonObject(requireMetadata(entries, "manifest.json"), "manifest.json"));
  const artifacts = validateAgentImportConfigArtifacts({
    formatVersion: AGENT_IMPORT_FORMAT_VERSION,
    portableAgent: jsonObject(requireMetadata(entries, "portable-agent.json"), "portable-agent.json"),
    configInventory: (() => {
      try {
        return JSON.parse(requireMetadata(entries, "config-inventory.json").toString("utf8"));
      } catch {
        throw new AgentImportSourceError("invalid_archive_metadata", "config-inventory.json is invalid");
      }
    })(),
    doctorCandidate: jsonObject(requireMetadata(entries, "doctor-candidate.json"), "doctor-candidate.json"),
  });
  if (artifacts.portableAgent.sourceAgentId !== manifest.sourceAgentId) {
    throw new AgentImportSourceError("invalid_archive_metadata", "manifest source agent does not match config artifacts");
  }
  const root = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), "octogee-agent-import-local-"));
  const repoDir = path.join(root, "source");
  fs.mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  try {
    const trackedExecutables = await initializeLocalRepository(
      repoDir,
      entries,
      manifest,
      options.maxGitBlobBytes,
    );
    for (const [entry, contents] of entries) {
      if (!entry.startsWith("workspace/")) continue;
      const relative = entry.slice("workspace/".length);
      writeEntry(repoDir, relative, contents, trackedExecutables.has(relative) ? 0o700 : 0o600);
    }
    const sourceHead = await commitCurrentTip(
      repoDir,
      manifest.hadGit ? "Capture imported local workspace changes" : "Import local agent workspace",
    );
    return {
      repoDir,
      sourceHead,
      artifacts,
      manifest,
      cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
