import fs from "node:fs";
import path from "node:path";

import { userSshKeyPath, gitExec as defaultGitExec } from "./git.js";
import {
  assertPlatformInvariants,
  reconcilePlatformInvariants,
} from "./system-config-invariants.js";
import {
  assertSystemConfigGitignore,
  assertSystemConfigMetadata,
  readSystemConfigCommitBlob,
  type ReadSystemConfigCommitBlob,
  SYSTEM_CONFIG_GITIGNORE_FILENAME,
  SYSTEM_CONFIG_METADATA_FILENAME,
} from "./system-config-durable-files.js";

type GitExec = typeof defaultGitExec;
const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;

export type SystemConfigCommitSource =
  | "auto-watch"
  | "boot-migration"
  | "recovery"
  | "migration-checkpoint"
  | "migration-restore";

export type SystemConfigRecoveryResult =
  | { outcome: "accepted"; acceptedCommit: string }
  | {
      outcome: "recovered";
      rejectedCommit: string;
      recoveredFromCommit: string;
      acceptedCommit: string;
    }
  | { outcome: "unavailable"; rejectedCommit: string; errorCode?: string };

interface SystemConfigRecoveryOptions {
  slug: string;
  openclawDir: string;
  repoDir: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  gitExec?: GitExec;
  validateConfig: (configPath: string) => void;
  now?: () => Date;
  keyPath?: string;
  acceptCurrent?: boolean;
  readCommitBlob?: ReadSystemConfigCommitBlob;
}

export type SystemConfigRemoteConvergenceResult =
  | { outcome: "adopted"; adoptedCommit: string }
  | { outcome: "unavailable"; errorCode: string };

export interface SystemConfigRemoteConvergenceOptions {
  slug: string;
  openclawDir: string;
  repoDir: string;
  configPath: string;
  expectedCommit: string;
  env?: NodeJS.ProcessEnv;
  gitExec?: GitExec;
  validateConfig: (configPath: string) => void;
  keyPath?: string;
  readCommitBlob?: ReadSystemConfigCommitBlob;
}

interface DurableCandidate {
  config: Buffer;
  metadata: Buffer;
  gitignore: Buffer;
}

function parseConfig(contents: string): Record<string, unknown> {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("openclaw.json must contain an object");
  }
  return parsed as Record<string, unknown>;
}

function atomicWrite(filePath: string, contents: string | Buffer): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function safeTrailerValue(value: string | undefined): string {
  const normalized = value?.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return normalized || "unknown";
}

export function attributedCommitArgs(
  subject: string,
  source: SystemConfigCommitSource,
  env: NodeJS.ProcessEnv = process.env,
  migrationSourceCommit?: string,
): string[] {
  if (migrationSourceCommit !== undefined && !GIT_SHA_RE.test(migrationSourceCommit)) {
    throw new Error("migration source commit must be a valid git SHA");
  }
  const migrationTrailer = migrationSourceCommit
    ? `\nOctogee-Migration-Source: ${migrationSourceCommit}`
    : "";
  return [
    "commit",
    "-m",
    subject,
    "-m",
    `Octogee-Config-Source: ${source}\nOctogee-Gateway: ${safeTrailerValue(env.GATEWAY_ID)}\nOpenClaw-Version: ${safeTrailerValue(env.OPENCLAW_VERSION)}${migrationTrailer}`,
  ];
}

function normalizedCandidate(
  candidate: DurableCandidate,
  candidatePath: string,
  env: NodeJS.ProcessEnv,
  validateConfig: (configPath: string) => void,
  reconcile: boolean,
): string | null {
  try {
    const metadata = candidate.metadata.toString("utf8");
    const gitignore = candidate.gitignore.toString("utf8");
    const configContents = candidate.config.toString("utf8");
    assertSystemConfigMetadata(metadata);
    assertSystemConfigGitignore(gitignore);
    const config = parseConfig(configContents);
    if (reconcile) reconcilePlatformInvariants(config, env);
    assertPlatformInvariants(config, env);
    let normalized = configContents;
    if (reconcile) {
      normalized = `${JSON.stringify(config, null, 2)}\n`;
    } else if (!configContents.endsWith("\n")) {
      normalized = `${configContents}\n`;
    }
    atomicWrite(candidatePath, normalized);
    validateConfig(candidatePath);
    return normalized;
  } catch {
    return null;
  } finally {
    fs.rmSync(candidatePath, { force: true });
  }
}

interface RecoveryHistoryContext {
  options: SystemConfigRecoveryOptions;
  env: NodeJS.ProcessEnv;
  execGit: GitExec;
  keyPath: string;
  rejectedCommit: string;
  candidatePath: string;
  history: string;
}

function historyCandidate(
  options: SystemConfigRecoveryOptions,
  execGit: GitExec,
  keyPath: string,
  commit: string,
): DurableCandidate | null {
  const readBlob = options.readCommitBlob ?? (options.gitExec
    ? ((_repoDir, ref, filename) => {
        const contents = execGit(options.repoDir, ["show", `${ref}:${filename}`], keyPath);
        return contents === null ? null : Buffer.from(contents);
      })
    : readSystemConfigCommitBlob);
  const config = readBlob(options.repoDir, commit, "openclaw.json");
  const metadata = readBlob(options.repoDir, commit, SYSTEM_CONFIG_METADATA_FILENAME);
  const gitignore = readBlob(options.repoDir, commit, SYSTEM_CONFIG_GITIGNORE_FILENAME);
  if (config === null || metadata === null || gitignore === null) return null;
  return { config, metadata, gitignore };
}

function recoverFromHistory(context: RecoveryHistoryContext): SystemConfigRecoveryResult {
  const { options, env, execGit, keyPath, rejectedCommit, candidatePath, history } = context;
  for (const commit of history.split("\n").map((value) => value.trim()).filter(Boolean)) {
    if (!GIT_SHA_RE.test(commit)) continue;
    const candidate = historyCandidate(options, execGit, keyPath, commit);
    if (!candidate) continue;
    const normalized = normalizedCandidate(candidate, candidatePath, env, options.validateConfig, true);
    if (normalized === null) continue;
    atomicWrite(options.configPath, normalized);
    atomicWrite(path.join(options.repoDir, SYSTEM_CONFIG_METADATA_FILENAME), candidate.metadata);
    atomicWrite(path.join(options.repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), candidate.gitignore);
    if (execGit(
      options.repoDir,
      ["add", "openclaw.json", SYSTEM_CONFIG_METADATA_FILENAME, SYSTEM_CONFIG_GITIGNORE_FILENAME],
      keyPath,
    ) === null) {
      return { outcome: "unavailable", rejectedCommit, errorCode: "recovery-stage-failed" };
    }
    const stamp = (options.now ?? (() => new Date()))().toISOString();
    const commitArgs = attributedCommitArgs(
      `recovery: restore accepted openclaw config ${stamp}`,
      "recovery",
      env,
    );
    if (execGit(options.repoDir, commitArgs, keyPath) === null) {
      return { outcome: "unavailable", rejectedCommit, errorCode: "recovery-commit-failed" };
    }
    if (execGit(options.repoDir, ["push", "origin", "main"], keyPath) === null) {
      return { outcome: "unavailable", rejectedCommit, errorCode: "recovery-push-failed" };
    }
    const acceptedCommit = execGit(options.repoDir, ["rev-parse", "HEAD"], keyPath);
    if (!acceptedCommit) {
      return { outcome: "unavailable", rejectedCommit, errorCode: "recovery-head-unavailable" };
    }
    return {
      outcome: "recovered",
      rejectedCommit,
      recoveredFromCommit: commit,
      acceptedCommit,
    };
  }
  return { outcome: "unavailable", rejectedCommit };
}

function restoreValidCommittedHead(
  context: Omit<RecoveryHistoryContext, "history">,
  commit: string,
): boolean {
  const { options, env, execGit, keyPath, candidatePath } = context;
  if (!GIT_SHA_RE.test(commit)) return false;
  const candidate = historyCandidate(options, execGit, keyPath, commit);
  if (!candidate) return false;
  if (normalizedCandidate(candidate, candidatePath, env, options.validateConfig, false) === null) {
    return false;
  }
  atomicWrite(path.join(options.repoDir, SYSTEM_CONFIG_METADATA_FILENAME), candidate.metadata);
  atomicWrite(path.join(options.repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME), candidate.gitignore);
  atomicWrite(options.configPath, candidate.config);
  return true;
}

function isAttributedMigrationReplay(
  options: SystemConfigRemoteConvergenceOptions,
  execGit: GitExec,
  keyPath: string,
  commit: string,
): boolean {
  if (!GIT_SHA_RE.test(commit) || !options.env?.GATEWAY_ID?.trim()) return false;
  if (execGit(options.repoDir, ["rev-parse", `${commit}^`], keyPath) !== options.expectedCommit) {
    return false;
  }
  const message = execGit(options.repoDir, ["show", "-s", "--format=%B", commit], keyPath);
  if (message === null) return false;
  const lines = new Set(message.split("\n").map((line) => line.trim()));
  const targetGateway = lines.has(
    `Octogee-Gateway: ${safeTrailerValue(options.env.GATEWAY_ID)}`,
  );
  const migrationCheckpoint =
    lines.has("Octogee-Config-Source: migration-checkpoint") &&
    lines.has(`Octogee-Migration-Source: ${options.expectedCommit}`);
  const bootCheckpoint = lines.has("Octogee-Config-Source: boot-migration");
  return targetGateway && (migrationCheckpoint || bootCheckpoint);
}

type FetchedRemoteCommit =
  | { outcome: "fetched"; adoptedCommit: string; replayedTargetCommit: boolean }
  | { outcome: "unavailable"; errorCode: string };

function fetchAdoptableRemoteCommit(
  options: SystemConfigRemoteConvergenceOptions,
  execGit: GitExec,
  keyPath: string,
): FetchedRemoteCommit {
  if (execGit(options.repoDir, ["fetch", "origin", "main"], keyPath) === null) {
    return { outcome: "unavailable", errorCode: "remote-fetch-failed" };
  }
  const fetchedCommit = execGit(options.repoDir, ["rev-parse", "FETCH_HEAD"], keyPath);
  if (fetchedCommit === options.expectedCommit) {
    return { outcome: "fetched", adoptedCommit: fetchedCommit, replayedTargetCommit: false };
  }
  if (fetchedCommit !== null && isAttributedMigrationReplay(options, execGit, keyPath, fetchedCommit)) {
    return { outcome: "fetched", adoptedCommit: fetchedCommit, replayedTargetCommit: true };
  }
  return { outcome: "unavailable", errorCode: "remote-commit-mismatch" };
}

export function convergeSystemConfigToRemoteCommit(
  options: SystemConfigRemoteConvergenceOptions,
): SystemConfigRemoteConvergenceResult {
  if (!GIT_SHA_RE.test(options.expectedCommit)) {
    return { outcome: "unavailable", errorCode: "invalid-expected-commit" };
  }
  const execGit = options.gitExec ?? defaultGitExec;
  const keyPath = options.keyPath ?? userSshKeyPath(options.slug);
  const fetched = fetchAdoptableRemoteCommit(options, execGit, keyPath);
  if (fetched.outcome === "unavailable") return fetched;
  const { adoptedCommit, replayedTargetCommit } = fetched;
  if (execGit(options.repoDir, ["rev-parse", "HEAD"], keyPath) === adoptedCommit) {
    return { outcome: "adopted", adoptedCommit };
  }
  const candidate = historyCandidate(
    {
      ...options,
      now: undefined,
      acceptCurrent: false,
    },
    execGit,
    keyPath,
    adoptedCommit,
  );
  if (!candidate) {
    return { outcome: "unavailable", errorCode: "remote-durable-set-unavailable" };
  }
  const candidatePath = path.join(
    options.openclawDir,
    "system_config.migration-converge-candidate.json",
  );
  const normalizedConfig = normalizedCandidate(
    candidate,
    candidatePath,
    options.env ?? process.env,
    options.validateConfig,
    !replayedTargetCommit,
  );
  if (normalizedConfig === null) {
    return { outcome: "unavailable", errorCode: "remote-config-invalid" };
  }
  if (execGit(
    options.repoDir,
    ["reset", "--hard", adoptedCommit],
    keyPath,
  ) === null) {
    return { outcome: "unavailable", errorCode: "remote-adoption-failed" };
  }
  atomicWrite(options.configPath, normalizedConfig);
  atomicWrite(
    path.join(options.repoDir, SYSTEM_CONFIG_METADATA_FILENAME),
    candidate.metadata,
  );
  atomicWrite(
    path.join(options.repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME),
    candidate.gitignore,
  );
  if (execGit(options.repoDir, ["rev-parse", "HEAD"], keyPath) !== adoptedCommit) {
    return { outcome: "unavailable", errorCode: "remote-adoption-unverified" };
  }
  return { outcome: "adopted", adoptedCommit };
}

export function recoverSystemConfigHead(
  options: SystemConfigRecoveryOptions,
): SystemConfigRecoveryResult {
  const env = options.env ?? process.env;
  const execGit = options.gitExec ?? defaultGitExec;
  const keyPath = options.keyPath ?? userSshKeyPath(options.slug);
  const rejectedCommit = execGit(options.repoDir, ["rev-parse", "HEAD"], keyPath);
  if (!rejectedCommit) {
    return { outcome: "unavailable", rejectedCommit: "unknown", errorCode: "head-unavailable" };
  }
  const candidatePath = path.join(options.openclawDir, "system_config.recovery-candidate.json");
  const recoveryContext = {
    options,
    env,
    execGit,
    keyPath,
    rejectedCommit,
    candidatePath,
  };
  if (options.acceptCurrent !== false) {
    try {
      const current = {
        config: fs.readFileSync(options.configPath),
        metadata: fs.readFileSync(
          path.join(options.repoDir, SYSTEM_CONFIG_METADATA_FILENAME),
        ),
        gitignore: fs.readFileSync(
          path.join(options.repoDir, SYSTEM_CONFIG_GITIGNORE_FILENAME),
        ),
      };
      if (normalizedCandidate(current, candidatePath, env, options.validateConfig, false)) {
        return { outcome: "accepted", acceptedCommit: rejectedCommit };
      }
    } catch {
      fs.rmSync(candidatePath, { force: true });
    }
  }
  if (restoreValidCommittedHead(recoveryContext, rejectedCommit)) {
    return { outcome: "accepted", acceptedCommit: rejectedCommit };
  }

  const history = execGit(options.repoDir, ["rev-list", "HEAD"], keyPath);
  if (history === null) {
    return { outcome: "unavailable", rejectedCommit, errorCode: "history-unavailable" };
  }
  return recoverFromHistory({
    ...recoveryContext,
    history,
  });
}
