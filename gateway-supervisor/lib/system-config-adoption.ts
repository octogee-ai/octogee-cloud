import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { userSshKeyPath, gitExec } from "./git.js";
import {
  mattermostAccountSecretRef,
  mattermostAccountSecretsPath,
  updateMattermostAccountSecrets,
} from "./mattermost-account-secrets.js";
import {
  acquireSystemConfigSyncLock,
  checkpointDurableSystemConfigForSlug,
  extractLegacyMattermostAccountSecrets,
  removeLegacyMacConfig,
  SystemConfigCheckpointError,
  type SystemConfigSyncResult,
  systemConfigPath,
} from "./system-config.js";
import { reconcilePlatformInvariants } from "./system-config-invariants.js";
import { readSystemConfigStatus } from "./system-config-status.js";

type JsonObject = Record<string, unknown>;
const GIT_SHA_RE = /^[0-9a-f]{7,64}$/;

export interface SystemConfigAdoptionResult {
  applied: boolean;
  approvalHash: string;
  changedPaths: string[];
  acceptedCommit?: string;
}

interface SystemConfigAdoptionOptions {
  slug: string;
  sourcePath: string;
  openclawDir: string;
  env?: NodeJS.ProcessEnv;
  approveHash?: string;
  validateConfig?: (configPath: string) => void;
  writeSecrets?: typeof updateMattermostAccountSecrets;
  checkpoint?: typeof checkpointDurableSystemConfigForSlug;
}

export class SystemConfigAdoptionApprovalError extends Error {
  readonly code = "adoption-approval-mismatch";

  constructor() {
    super("adoption approval hash does not match the validated candidate");
    this.name = "SystemConfigAdoptionApprovalError";
  }
}

export class SystemConfigAdoptionCheckpointError extends Error {
  readonly code = "adoption-checkpoint-failed";

  constructor(
    readonly localState: "restored" | "committed-pending" | "rollback-failed",
    readonly checkpointError: unknown,
    readonly rollbackError?: unknown,
  ) {
    super(`config adoption checkpoint failed; local state is ${localState}`);
    this.name = "SystemConfigAdoptionCheckpointError";
  }
}

export class SystemConfigAdoptionLockError extends Error {
  readonly code = "adoption-sync-locked";

  constructor() {
    super("config adoption cannot acquire the durable config writer lock");
    this.name = "SystemConfigAdoptionLockError";
  }
}

function parseObject(contents: string): JsonObject {
  const parsed = JSON.parse(contents) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("adoption source must contain a JSON object");
  }
  return parsed as JsonObject;
}

function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

function readMattermostSecrets(openclawDir: string): Record<string, string> {
  const filePath = mattermostAccountSecretsPath(openclawDir);
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed = parseObject(contents);
  if (!Object.values(parsed).every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("Mattermost account secret store contains an invalid value");
  }
  return parsed as Record<string, string>;
}

function setMattermostProviderPath(config: JsonObject, providerPath: string): void {
  const secrets = config.secrets as JsonObject;
  const providers = secrets.providers as JsonObject;
  const provider = providers["octogee-mattermost"] as JsonObject;
  provider.path = providerPath;
}

function validateAdoptionCandidate(
  candidate: JsonObject,
  secrets: Record<string, string>,
  openclawDir: string,
  validate: (configPath: string) => void,
): void {
  const validationDir = fs.mkdtempSync(path.join(openclawDir, ".system-config-adoption-"));
  fs.chmodSync(validationDir, 0o700);
  try {
    const validationSecretsPath = path.join(validationDir, "mattermost-accounts.json");
    const validationConfigPath = path.join(validationDir, "openclaw.json");
    atomicWrite(validationSecretsPath, `${JSON.stringify(secrets, null, 2)}\n`);
    const validationCandidate = structuredClone(candidate);
    setMattermostProviderPath(validationCandidate, validationSecretsPath);
    atomicWrite(validationConfigPath, `${JSON.stringify(validationCandidate, null, 2)}\n`);
    validate(validationConfigPath);
  } finally {
    fs.rmSync(validationDir, { recursive: true, force: true });
  }
}

const PRECOMMIT_CHECKPOINT_FAILURES = new Set([
  "invalid-builder-slug",
  "checkout-unavailable",
  "openclaw-json-missing",
  "remote-head-unavailable",
  "non-fast-forward-conflict",
  "status-check-failed",
  "validation-failed",
  "validation-restore-failed",
  "platform-invariant-violation",
  "stage-failed",
  "sync-locked",
]);

function canRestoreAfterCheckpointFailure(result: SystemConfigSyncResult): boolean {
  if (result.committed || result.pushed) return false;
  if (result.rejected) return true;
  return PRECOMMIT_CHECKPOINT_FAILURES.has(result.errorCode ?? result.skipped ?? "");
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function changedJsonPaths(
  before: unknown,
  after: unknown,
  prefix = "",
): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (!isObject(before) || !isObject(after)) return prefix ? [prefix] : ["root"];
  const paths: string[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      paths.push(...changedJsonPaths({}, after[key], childPath));
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(after, key)) {
      paths.push(...changedJsonPaths(before[key], {}, childPath));
      continue;
    }
    paths.push(...changedJsonPaths(before[key], after[key], childPath));
  }
  return paths;
}

// A user overlay owns its account ids and may point any account at any key in
// the tenant-scoped Mattermost secrets file, so the retained secrets are the keys
// the adopted config references, not the account ids it happens to use.
function referencedMattermostSecretKey(value: unknown): string | null {
  if (!isObject(value) || !isObject(value.botToken)) return null;
  const { source, provider, id } = value.botToken;
  const canonical = mattermostAccountSecretRef("probe");
  if (source !== canonical.source || provider !== canonical.provider) return null;
  if (typeof id !== "string" || !id.startsWith("/") || id.length < 2) return null;
  return id.slice(1).replace(/~1/g, "/").replace(/~0/g, "~");
}

function desiredMattermostSecrets(
  candidate: JsonObject,
  extracted: Record<string, string>,
  current: Record<string, string>,
): Record<string, string> {
  const channels = isObject(candidate.channels) ? candidate.channels : {};
  const mattermost = isObject(channels.mattermost) ? channels.mattermost : {};
  const accounts = isObject(mattermost.accounts) ? mattermost.accounts : {};
  const next: Record<string, string> = {};
  for (const account of Object.values(accounts)) {
    const key = referencedMattermostSecretKey(account);
    if (key === null) continue;
    if (Object.prototype.hasOwnProperty.call(extracted, key)) {
      next[key] = extracted[key];
    } else if (Object.prototype.hasOwnProperty.call(current, key)) {
      next[key] = current[key];
    }
  }
  return next;
}

function secretChange(
  before: Record<string, string>,
  after: Record<string, string>,
): { set: Record<string, string>; remove?: string[] } {
  const set = Object.fromEntries(Object.entries(after).filter(([key, value]) => before[key] !== value));
  const remove = Object.keys(before).filter((key) => after[key] === undefined);
  return { set, ...(remove.length > 0 ? { remove } : {}) };
}

function adoptionApprovalHash(
  contents: string,
  secrets: Record<string, string>,
  baseline: AdoptionBaseline,
  currentContents: string,
): string {
  const secretDigests = Object.fromEntries(
    Object.keys(secrets).sort().map((accountId) => [
      accountId,
      createHash("sha256").update(secrets[accountId]).digest("hex"),
    ]),
  );
  const common = {
    currentConfigHash: createHash("sha256").update(currentContents).digest("hex"),
    candidate: contents,
    secretDigests,
  };
  const payload = JSON.stringify(baseline.mode === "accepted" ? {
    acceptedCommit: baseline.acceptedCommit,
    ...common,
  } : {
    unavailableHead: baseline.localHead,
    repositoryStatusHash: createHash("sha256").update(baseline.repositoryStatus).digest("hex"),
    ...common,
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

type AdoptionBaseline =
  | { mode: "accepted"; acceptedCommit: string }
  | { mode: "unavailable"; localHead: string; repositoryStatus: string };

function adoptionBaseline(
  options: SystemConfigAdoptionOptions,
  targetPath: string,
): AdoptionBaseline {
  const repoDir = path.dirname(targetPath);
  const keyPath = userSshKeyPath(options.slug);
  const localHead = gitExec(repoDir, ["rev-parse", "HEAD"], keyPath);
  const status = readSystemConfigStatus(options.openclawDir);
  if (
    localHead !== null &&
    GIT_SHA_RE.test(localHead) &&
    status.acceptedCommit !== undefined &&
    GIT_SHA_RE.test(status.acceptedCommit) &&
    localHead === status.acceptedCommit
  ) {
    return { mode: "accepted", acceptedCommit: status.acceptedCommit };
  }
  if (
    localHead !== null &&
    GIT_SHA_RE.test(localHead) &&
    status.acceptedCommit === undefined &&
    status.state === "unavailable" &&
    status.bootRecovery === "unavailable"
  ) {
    const repositoryStatus = gitExec(
      repoDir,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      keyPath,
    );
    if (repositoryStatus !== null) {
      return { mode: "unavailable", localHead, repositoryStatus };
    }
  }
  throw new SystemConfigAdoptionApprovalError();
}

interface PreparedAdoption {
  currentContents: string;
  currentSecrets: Record<string, string>;
  nextSecrets: Record<string, string>;
  contents: string;
  approvalHash: string;
  changedPaths: string[];
}

function prepareAdoption(options: SystemConfigAdoptionOptions, env: NodeJS.ProcessEnv): PreparedAdoption {
  const targetPath = systemConfigPath(options.openclawDir);
  const currentContents = fs.readFileSync(targetPath, "utf8");
  const baseline = adoptionBaseline(options, targetPath);
  let current: JsonObject | null;
  try {
    current = parseObject(currentContents);
  } catch (error) {
    if (baseline.mode !== "unavailable") throw error;
    current = null;
  }
  const currentSecrets = readMattermostSecrets(options.openclawDir);
  const candidate = parseObject(fs.readFileSync(options.sourcePath, "utf8"));
  removeLegacyMacConfig(candidate, env);
  const extracted = extractLegacyMattermostAccountSecrets(candidate);
  reconcilePlatformInvariants(candidate, env);
  const nextSecrets = desiredMattermostSecrets(candidate, extracted, currentSecrets);
  const contents = `${JSON.stringify(candidate, null, 2)}\n`;
  validateAdoptionCandidate(
    candidate,
    nextSecrets,
    options.openclawDir,
    options.validateConfig ?? (() => {}),
  );
  return {
    currentContents,
    currentSecrets,
    nextSecrets,
    contents,
    approvalHash: adoptionApprovalHash(contents, nextSecrets, baseline, currentContents),
    changedPaths: current === null ? ["root"] : changedJsonPaths(current, candidate),
  };
}

function hasSecretChanges(change: ReturnType<typeof secretChange>): boolean {
  return Object.keys(change.set).length > 0 || (change.remove?.length ?? 0) > 0;
}

async function applyPreparedAdoption(
  options: SystemConfigAdoptionOptions,
  env: NodeJS.ProcessEnv,
  targetPath: string,
  adoption: PreparedAdoption,
): Promise<SystemConfigAdoptionResult> {
  const writeSecrets = options.writeSecrets ?? updateMattermostAccountSecrets;
  const applySecrets = secretChange(adoption.currentSecrets, adoption.nextSecrets);
  try {
    if (hasSecretChanges(applySecrets)) {
      await writeSecrets(options.openclawDir, applySecrets);
    }
    atomicWrite(targetPath, adoption.contents);
    const result: SystemConfigSyncResult =
      (options.checkpoint ?? checkpointDurableSystemConfigForSlug)(options.slug, {
        openclawDir: options.openclawDir,
        env,
        source: "boot-migration",
        validateConfig: options.validateConfig,
        lockHeld: true,
      });
    return {
      applied: true,
      approvalHash: adoption.approvalHash,
      changedPaths: adoption.changedPaths,
      acceptedCommit: result.acceptedCommit,
    };
  } catch (error) {
    if (error instanceof SystemConfigCheckpointError &&
        !canRestoreAfterCheckpointFailure(error.result)) {
      throw new SystemConfigAdoptionCheckpointError("committed-pending", error);
    }
    try {
      atomicWrite(targetPath, adoption.currentContents);
      const rollbackSecrets = secretChange(adoption.nextSecrets, adoption.currentSecrets);
      if (hasSecretChanges(rollbackSecrets)) {
        await writeSecrets(options.openclawDir, rollbackSecrets);
      }
    } catch (rollbackError) {
      throw new SystemConfigAdoptionCheckpointError("rollback-failed", error, rollbackError);
    }
    if (error instanceof SystemConfigCheckpointError) {
      throw new SystemConfigAdoptionCheckpointError("restored", error);
    }
    throw error;
  }
}

export async function adoptSystemConfig(
  options: SystemConfigAdoptionOptions,
): Promise<SystemConfigAdoptionResult> {
  const env = options.env ?? process.env;
  const targetPath = systemConfigPath(options.openclawDir);
  const preview = prepareAdoption(options, env);
  if (options.approveHash === undefined) {
    return {
      applied: false,
      approvalHash: preview.approvalHash,
      changedPaths: preview.changedPaths,
    };
  }
  const releaseLock = acquireSystemConfigSyncLock(options.openclawDir);
  if (!releaseLock) throw new SystemConfigAdoptionLockError();
  try {
    const adoption = prepareAdoption(options, env);
    if (options.approveHash !== adoption.approvalHash) {
      throw new SystemConfigAdoptionApprovalError();
    }
    return await applyPreparedAdoption(options, env, targetPath, adoption);
  } finally {
    releaseLock();
  }
}
