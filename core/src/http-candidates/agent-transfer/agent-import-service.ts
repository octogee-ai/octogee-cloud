import { createHash } from "node:crypto";

import {
  buildAgentImportApprovalInput,
  buildAgentImportConfigArtifacts,
  planAgentImportConfig,
  validateAgentImportConfigArtifacts,
  type AgentImportConfigArtifacts,
  type AgentImportConfigPlan,
  type AgentImportDoctorOutcome,
  type AgentImportWorkspacePolicy,
} from "@octogee/shared/types/agent-import";
import type {
  AgentImportRepositoryInspection,
  AgentImportWorkspaceComparison,
} from "./agent-import-git.js";
import type {
  ExtractedAgentImportSource,
} from "./agent-import-source.js";

type JsonObject = Record<string, unknown>;

export interface AgentImportDoctorResult {
  outcome: AgentImportDoctorOutcome;
  doctorVersion: string;
  changedPaths: string[];
  diagnostics: string[];
  repairedCandidate?: JsonObject;
}

export type AgentImportSource =
  | { kind: "github"; owner: string; repo: string; branch: string; head: string }
  | { kind: "local"; head: string; archiveDigest: string; hadGit: boolean; uncommittedFileCount: number };

export interface AgentImportPreview {
  id: string;
  source: AgentImportSource;
  destinationHead: string;
  workspace: {
    commitCount: number;
    fileCount: number;
    totalBytes: number;
    workspaceDigest: string;
    historyPreserved: boolean;
    conflicts: string[];
    conflictCount: number;
    conflictDigest: string;
    preservedPaths: string[];
  };
  doctor: AgentImportDoctorResult;
  config: AgentImportConfigPlan;
  workspacePolicy: AgentImportWorkspacePolicy;
  approvalHash: string;
}

export type AgentImportStatus =
  | "previewed"
  | "workspace"
  | "identity"
  | "config"
  | "verifying"
  | "complete"
  | "failed"
  | "rolling_back"
  | "rollback_failed"
  | "rolled_back"
  | "abandoned";

const APPLYABLE_STATUSES = new Set<AgentImportStatus>([
  "previewed", "workspace", "identity", "config", "verifying", "failed",
]);
const CONFIG_GET_METHOD = "config.get";
const MAX_GITHUB_REPO_KIB = 128 * 1024;

export interface AgentImportRecord {
  id: string;
  uid: string;
  slug: string;
  gatewayId: string;
  status: AgentImportStatus;
  source: AgentImportSource;
  destinationHead: string;
  approvalHash: string;
  preview: AgentImportPreview;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  importCommit?: string;
  rollbackCommit?: string;
  configOutcome?: "applied" | "safe_baseline" | "unchanged";
  warnings: string[];
  previousIdentity?: AgentImportIdentitySnapshot;
  previousRuntime?: JsonObject;
  error?: { code: string; message: string };
}

export interface StoredAgentImportPlan {
  uid: string;
  slug: string;
  gatewayId: string;
  source: AgentImportSource;
  destinationHead: string;
  approvalHash: string;
  artifacts: AgentImportConfigArtifacts;
  config: AgentImportConfigPlan;
  workspacePolicy: AgentImportWorkspacePolicy;
}

export interface AgentImportIdentity {
  name?: string;
  persona?: string;
  emoji?: string;
}

export interface AgentImportIdentitySnapshot {
  name: string | null;
  persona: string | null;
  emoji: string | null;
}

export interface AgentImportServiceDeps {
  newId(): string;
  now(): Date;
  readGithubToken(uid: string): Promise<string | null>;
  readGithubRepoSize(owner: string, repo: string): Promise<number>;
  cloneGithubSource(input: {
    owner: string;
    repo: string;
    branch: string;
    token: string;
  }): Promise<{ repoDir: string; sourceHead: string; cleanup(): void }>;
  extractLocalSource(archive: Buffer): Promise<ExtractedAgentImportSource>;
  inspectSource(repoDir: string): Promise<AgentImportRepositoryInspection>;
  compareWorkspaces(
    sourceDir: string,
    targetDir: string,
    workspacePolicy: AgentImportWorkspacePolicy,
  ): Promise<AgentImportWorkspaceComparison>;
  workspaceState(slug: string): Promise<{ targetDir: string; head: string; clean: boolean }>;
  runDoctor(candidate: JsonObject): Promise<AgentImportDoctorResult>;
  putRecord(record: AgentImportRecord): Promise<void>;
  getRecord(id: string): Promise<AgentImportRecord | null>;
  getLatestRecord(): Promise<AgentImportRecord | null>;
  putPlan(id: string, plan: StoredAgentImportPlan): Promise<void>;
  getPlan(id: string): Promise<StoredAgentImportPlan | null>;
  putArchive(id: string, archive: Buffer): Promise<void>;
  getArchive(id: string): Promise<Buffer | null>;
  deleteStaging(id: string): Promise<void>;
  deleteImportBlobs(id: string): Promise<void>;
  abandonRecord(record: AgentImportRecord): Promise<void>;
  hasRepositoryImport(input: { targetDir: string; importId: string }): Promise<boolean>;
  applyRepository(input: {
    sourceDir: string;
    sourceHead: string;
    targetDir: string;
    destinationHead: string;
    importId: string;
    slug: string;
    workspacePolicy: AgentImportWorkspacePolicy;
  }): Promise<{ importCommit: string; sourceRef: string }>;
  rollbackRepository(input: {
    targetDir: string;
    importCommit: string;
    destinationHead: string;
    importId: string;
  }): Promise<{ rollbackCommit: string }>;
  readIdentity(uid: string): Promise<AgentImportIdentitySnapshot>;
  syncIdentity(uid: string, identity: AgentImportIdentity): Promise<void>;
  replaceIdentity(uid: string, identity: AgentImportIdentitySnapshot): Promise<void>;
  withConfigLock<T>(work: () => Promise<T>): Promise<T>;
  invokeOpenClaw(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export class AgentImportServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AgentImportServiceError";
  }
}

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertGithubRepoSize(repoSizeKiB: number): void {
  if (!Number.isSafeInteger(repoSizeKiB) || repoSizeKiB < 0) {
    throw new AgentImportServiceError("invalid_github_source", "GitHub repository size is invalid");
  }
  if (repoSizeKiB > MAX_GITHUB_REPO_KIB) {
    throw new AgentImportServiceError("archive_too_large", "GitHub repository exceeds the 128 MiB import limit");
  }
}

function configDigest(artifacts: AgentImportConfigArtifacts): string {
  return sha256(buildAgentImportApprovalInput({
    source: { kind: "config" },
    destinationHead: "",
    workspaceDigest: "",
    configDigest: sha256(JSON.stringify(artifacts)),
    resolutions: {},
  }));
}

function approvalHash(input: {
  source: AgentImportSource;
  destinationHead: string;
  workspaceDigest: string;
  artifacts: AgentImportConfigArtifacts;
  comparison: AgentImportWorkspaceComparison;
  workspacePolicy: AgentImportWorkspacePolicy;
}): string {
  const source = Object.fromEntries(
    Object.entries(input.source).map(([key, value]) => [key, String(value)]),
  );
  return sha256(buildAgentImportApprovalInput({
    source,
    destinationHead: input.destinationHead,
    workspaceDigest: input.workspaceDigest,
    configDigest: configDigest(input.artifacts),
    resolutions: {
      workspaceConflictDigest: input.comparison.conflictDigest,
      preserveConvergedContextFiles:
        String(input.workspacePolicy.preserveConvergedContextFiles),
    },
  }));
}

function adaptedArtifacts(
  original: AgentImportConfigArtifacts,
  doctor: AgentImportDoctorResult,
): { artifacts: AgentImportConfigArtifacts; outcome: AgentImportDoctorOutcome } {
  if (
    (doctor.outcome !== "migrated" && doctor.outcome !== "unchanged") ||
    !doctor.repairedCandidate
  ) {
    return { artifacts: original, outcome: doctor.outcome };
  }
  try {
    const repaired = buildAgentImportConfigArtifacts(
      doctor.repairedCandidate,
      original.portableAgent.sourceAgentId,
    );
    return {
      artifacts: validateAgentImportConfigArtifacts({
        ...repaired,
        configInventory: original.configInventory,
      }),
      outcome: doctor.outcome,
    };
  } catch {
    return { artifacts: original, outcome: "failed" };
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function configGet(value: unknown): { config: JsonObject; hash: string } {
  const result = record(value);
  const config = record(result?.config);
  const hash = result?.hash;
  if (!config || typeof hash !== "string" || !hash) {
    throw new AgentImportServiceError("config_get_failed", "OpenClaw returned no config hash");
  }
  return { config, hash };
}

function defaultAgentFromConfig(config: JsonObject, userDefaultAgentId: string): JsonObject {
  const matches = agentList(config).filter((agent) => agent.id === userDefaultAgentId);
  if (matches.length !== 1) {
    throw new AgentImportServiceError("coach_config_missing", "Octogee agent config is missing or ambiguous");
  }
  return matches[0];
}

function restorationValue(previous: unknown, patch: unknown, wasPresent: boolean): unknown {
  const patchObject = record(patch);
  const previousObject = record(previous);
  if (patchObject && previousObject) {
    return Object.fromEntries(Object.entries(patchObject).map(([key, value]) => [
      key,
      restorationValue(previousObject[key], value, Object.prototype.hasOwnProperty.call(previousObject, key)),
    ]));
  }
  return wasPresent ? cloneValue(previous) : null;
}

function previousRuntime(defaultAgent: JsonObject, patch: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [
    key,
    restorationValue(defaultAgent[key], value, Object.prototype.hasOwnProperty.call(defaultAgent, key)),
  ]));
}

function mergedPreviousRuntime(
  defaultAgent: JsonObject,
  patch: JsonObject,
  checkpointedPrevious: JsonObject | undefined,
): JsonObject {
  return {
    ...previousRuntime(defaultAgent, patch),
    ...(checkpointedPrevious ?? {}),
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const DELETED = Symbol("deleted");

function mergePatchValue(previous: unknown, patch: unknown): unknown {
  if (patch === null) return DELETED;
  const patchObject = record(patch);
  if (!patchObject) return cloneValue(patch);
  const previousObject = record(previous) ?? {};
  const merged = cloneValue(previousObject);
  for (const [key, value] of Object.entries(patchObject)) {
    const next = mergePatchValue(previousObject[key], value);
    if (next === DELETED) delete merged[key];
    else merged[key] = next;
  }
  return merged;
}

function assertRuntimePatchApplied(
  beforeConfig: JsonObject,
  afterConfig: JsonObject,
  userDefaultAgentId: string,
  patch: JsonObject,
): void {
  const before = defaultAgentFromConfig(beforeConfig, userDefaultAgentId);
  const after = defaultAgentFromConfig(afterConfig, userDefaultAgentId);
  for (const [key, value] of Object.entries(patch)) {
    const expected = mergePatchValue(before[key], value);
    if (expected === DELETED) {
      if (Object.prototype.hasOwnProperty.call(after, key)) {
        throw new AgentImportServiceError("config_readback_failed", `OpenClaw did not delete ${key}`);
      }
    } else if (!deepEqual(after[key], expected)) {
      throw new AgentImportServiceError("config_readback_failed", `OpenClaw did not retain ${key}`);
    }
  }
}

function runtimePatchState(
  beforeConfig: JsonObject,
  currentConfig: JsonObject,
  userDefaultAgentId: string,
  patch: JsonObject,
): "unchanged" | "applied" | "diverged" {
  const before = defaultAgentFromConfig(beforeConfig, userDefaultAgentId);
  const current = defaultAgentFromConfig(currentConfig, userDefaultAgentId);
  let unchanged = true;
  let applied = true;
  for (const [key, value] of Object.entries(patch)) {
    const wasPresent = Object.prototype.hasOwnProperty.call(before, key);
    const isPresent = Object.prototype.hasOwnProperty.call(current, key);
    unchanged &&= wasPresent === isPresent && (!wasPresent || deepEqual(before[key], current[key]));
    const expected = mergePatchValue(before[key], value);
    applied &&= expected === DELETED
      ? !isPresent
      : isPresent && deepEqual(current[key], expected);
  }
  if (unchanged) return "unchanged";
  if (applied) return "applied";
  return "diverged";
}

function keyedAgentEntries(config: JsonObject): JsonObject | null {
  return record(record(config.agents)?.entries);
}

/**
 * The roster as id-carrying objects, whichever shape openclaw is storing.
 * 2026.7.2 migrates `agents.list` into keyed `agents.entries`, where the key is
 * the id and the entry carries none.
 */
function agentList(config: JsonObject): JsonObject[] {
  const entries = keyedAgentEntries(config);
  if (entries) {
    return Object.entries(entries).flatMap(([id, entry]) => {
      const agent = record(entry);
      return agent ? [{ ...cloneValue(agent), id }] : [];
    });
  }
  const list = record(config.agents)?.list;
  if (!Array.isArray(list)) {
    throw new AgentImportServiceError("coach_config_missing", "OpenClaw config has no agent list");
  }
  return list.map((entry) => cloneValue(entry) as JsonObject);
}

function safelyIdKeyedAgentList(config: JsonObject): boolean {
  return agentList(config).every((entry) => typeof record(entry)?.id === "string");
}

/** A keyed entry carries no `id` — the key is the id, and shipping one anyway
 *  would add a stray field to the agent. */
function defaultAgentPatch(config: JsonObject, userDefaultAgentId: string, patch: JsonObject): JsonObject {
  return keyedAgentEntries(config)
    ? { agents: { entries: { [userDefaultAgentId]: cloneValue(patch) } } }
    : { agents: { list: [{ id: userDefaultAgentId, ...cloneValue(patch) }] } };
}

function assertUnpatchedAgentConfig(before: JsonObject, after: JsonObject, userDefaultAgentId: string, patch: JsonObject): void {
  const beforeList = agentList(before);
  const afterList = agentList(after);
  if (beforeList.length !== afterList.length) {
    throw new AgentImportServiceError("config_readback_failed", "OpenClaw changed the agent list length");
  }
  for (let index = 0; index < beforeList.length; index += 1) {
    const prior = beforeList[index];
    const current = afterList[index];
    if (prior.id !== userDefaultAgentId) {
      if (!deepEqual(current, prior)) {
        throw new AgentImportServiceError("config_readback_failed", "OpenClaw changed a sibling agent");
      }
      continue;
    }
    for (const [key, value] of Object.entries(prior)) {
      if (!(key in patch) && !deepEqual(current[key], value)) {
        throw new AgentImportServiceError("config_readback_failed", `OpenClaw changed agent field ${key}`);
      }
    }
  }
}

export class AgentImportService {
  private static readonly activeMutations = new Map<string, Promise<void>>();

  constructor(private readonly deps: AgentImportServiceDeps) {}

  private serializeMutation<T>(uid: string, importId: string, work: () => Promise<T>): Promise<T> {
    const key = `${uid}\0${importId}`;
    const predecessor = AgentImportService.activeMutations.get(key) ?? Promise.resolve();
    const execution = predecessor.catch(() => undefined).then(work);
    const tail = execution.then(() => undefined, () => undefined);
    AgentImportService.activeMutations.set(key, tail);
    return execution.finally(() => {
      if (AgentImportService.activeMutations.get(key) === tail) AgentImportService.activeMutations.delete(key);
    });
  }

  async previewGithub(input: {
    uid: string;
    slug: string;
    gatewayId: string;
    workspacePolicy: AgentImportWorkspacePolicy;
    owner: string;
    repo: string;
    branch: string;
    artifacts: AgentImportConfigArtifacts;
  }): Promise<AgentImportPreview> {
    const artifacts = validateAgentImportConfigArtifacts(input.artifacts);
    const token = await this.deps.readGithubToken(input.uid);
    if (!token) throw new AgentImportServiceError("github_not_connected", "GitHub is not connected");
    assertGithubRepoSize(await this.deps.readGithubRepoSize(input.owner, input.repo));
    const source = await this.deps.cloneGithubSource({
      owner: input.owner,
      repo: input.repo,
      branch: input.branch,
      token,
    });
    try {
      const inspected = await this.deps.inspectSource(source.repoDir);
      if (inspected.head !== source.sourceHead) {
        throw new AgentImportServiceError("source_changed", "GitHub source changed during preview");
      }
      return await this.persistPreview({
        uid: input.uid,
        slug: input.slug,
        gatewayId: input.gatewayId,
        workspacePolicy: input.workspacePolicy,
        artifacts,
        inspected,
        repoDir: source.repoDir,
        historyPreserved: true,
        source: {
          kind: "github",
          owner: input.owner,
          repo: input.repo,
          branch: input.branch,
          head: source.sourceHead,
        },
      });
    } finally {
      source.cleanup();
    }
  }

  async previewLocal(input: {
    uid: string;
    slug: string;
    gatewayId: string;
    workspacePolicy: AgentImportWorkspacePolicy;
    archive: Buffer;
  }): Promise<AgentImportPreview> {
    const extracted = await this.deps.extractLocalSource(input.archive);
    try {
      const inspected = await this.deps.inspectSource(extracted.repoDir);
      if (inspected.head !== extracted.sourceHead) {
        throw new AgentImportServiceError("source_changed", "local source changed during preview");
      }
      const preview = await this.persistPreview({
        uid: input.uid,
        slug: input.slug,
        gatewayId: input.gatewayId,
        workspacePolicy: input.workspacePolicy,
        artifacts: extracted.artifacts,
        inspected,
        repoDir: extracted.repoDir,
        historyPreserved: extracted.manifest.hadGit,
        source: {
          kind: "local",
          head: extracted.sourceHead,
          archiveDigest: sha256(input.archive),
          hadGit: extracted.manifest.hadGit,
          uncommittedFileCount: extracted.manifest.uncommittedFileCount,
        },
        archive: input.archive,
      });
      return preview;
    } finally {
      extracted.cleanup();
    }
  }

  private async persistPreview(input: {
    uid: string;
    slug: string;
    gatewayId: string;
    workspacePolicy: AgentImportWorkspacePolicy;
    artifacts: AgentImportConfigArtifacts;
    inspected: AgentImportRepositoryInspection;
    repoDir: string;
    historyPreserved: boolean;
    source: AgentImportSource;
    archive?: Buffer;
  }): Promise<AgentImportPreview> {
    const destination = await this.deps.workspaceState(input.slug);
    if (!destination.clean) {
      throw new AgentImportServiceError("destination_dirty", "commit or discard Octogee workspace changes before import");
    }
    let doctor: AgentImportDoctorResult;
    try {
      doctor = await this.deps.runDoctor(input.artifacts.doctorCandidate);
    } catch {
      doctor = {
        outcome: "failed",
        doctorVersion: "unavailable",
        changedPaths: [],
        diagnostics: ["doctor_unavailable"],
      };
    }
    const adapted = adaptedArtifacts(input.artifacts, doctor);
    const config = planAgentImportConfig(adapted.artifacts, {
      doctorOutcome: adapted.outcome,
      sourceHeartbeat: input.artifacts.portableAgent.heartbeat,
      workspacePolicy: input.workspacePolicy,
    });
    const comparison = await this.deps.compareWorkspaces(
      input.repoDir,
      destination.targetDir,
      input.workspacePolicy,
    );
    const id = this.deps.newId();
    const hash = approvalHash({
      source: input.source,
      destinationHead: destination.head,
      workspaceDigest: input.inspected.workspaceDigest,
      artifacts: input.artifacts,
      comparison,
      workspacePolicy: input.workspacePolicy,
    });
    const preview: AgentImportPreview = {
      id,
      source: input.source,
      destinationHead: destination.head,
      workspace: {
        commitCount: input.inspected.commitCount,
        fileCount: input.inspected.fileCount,
        totalBytes: input.inspected.totalBytes,
        workspaceDigest: input.inspected.workspaceDigest,
        historyPreserved: input.historyPreserved,
        conflicts: comparison.conflicts,
        conflictCount: comparison.conflictCount,
        conflictDigest: comparison.conflictDigest,
        preservedPaths: comparison.preservedPaths,
      },
      doctor: { ...doctor, ...(adapted.outcome !== doctor.outcome ? { outcome: adapted.outcome } : {}) },
      config,
      workspacePolicy: input.workspacePolicy,
      approvalHash: hash,
    };
    const timestamp = this.deps.now().toISOString();
    try {
      await this.deps.putPlan(id, {
        uid: input.uid,
        slug: input.slug,
        gatewayId: input.gatewayId,
        source: input.source,
        destinationHead: destination.head,
        approvalHash: hash,
        artifacts: input.artifacts,
        config,
        workspacePolicy: input.workspacePolicy,
      });
      if (input.archive) await this.deps.putArchive(id, input.archive);
      await this.deps.putRecord({
        id,
        uid: input.uid,
        slug: input.slug,
        gatewayId: input.gatewayId,
        status: "previewed",
        source: input.source,
        destinationHead: destination.head,
        approvalHash: hash,
        preview,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        warnings: [],
      });
    } catch (error) {
      await this.deps.deleteStaging(id);
      throw error;
    }
    return preview;
  }

  async apply(input: {
    uid: string;
    importId: string;
    approvalHash: string;
    workspacePolicy: AgentImportWorkspacePolicy;
  }): Promise<AgentImportRecord> {
    return this.serializeMutation(input.uid, input.importId, () => this.applyOnce(input));
  }

  private async applyOnce(input: {
    uid: string;
    importId: string;
    approvalHash: string;
    workspacePolicy: AgentImportWorkspacePolicy;
  }): Promise<AgentImportRecord> {
    let current = await this.ownedRecord(input.importId, input.uid);
    if (current.status === "complete") return current;
    if (!APPLYABLE_STATUSES.has(current.status)) {
      throw new AgentImportServiceError("invalid_import_state", `cannot apply import in ${current.status}`);
    }
    if (current.approvalHash !== input.approvalHash) {
      throw new AgentImportServiceError("approval_mismatch", "approval hash does not match the preview");
    }
    const plan = await this.deps.getPlan(input.importId);
    if (!plan || plan.uid !== input.uid || plan.approvalHash !== input.approvalHash) {
      throw new AgentImportServiceError("import_plan_missing", "approved import plan is unavailable");
    }
    if (
      plan.workspacePolicy.preserveConvergedContextFiles !==
      input.workspacePolicy.preserveConvergedContextFiles
    ) {
      throw new AgentImportServiceError(
        "workspace_policy_changed",
        "workspace ownership changed after preview; preview the import again",
      );
    }
    try {
      current = await this.applyWorkspace(current, plan, input.importId);
      current = await this.applyIdentity(current, plan);
      current = await this.applyConfig(current, plan);
      return await this.completeApply(current, input.importId);
    } catch (error) {
      try {
        const checkpoint = await this.ownedRecord(input.importId, input.uid);
        await this.update(checkpoint, {
          status: "failed",
          error: {
            code: error instanceof AgentImportServiceError ? error.code : "agent_import_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } catch (checkpointError) {
        throw new AggregateError(
          [error, checkpointError],
          `agent import failed and failure checkpointing also failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async applyWorkspace(
    current: AgentImportRecord,
    plan: StoredAgentImportPlan,
    importId: string,
  ): Promise<AgentImportRecord> {
    if (current.importCommit) return current;
    const source = await this.sourceForPlan(plan, importId);
    try {
      const inspected = await this.deps.inspectSource(source.repoDir);
      if (inspected.head !== plan.source.head) {
        throw new AgentImportServiceError("source_changed", "source changed after preview");
      }
      const destination = await this.deps.workspaceState(plan.slug);
      if (!destination.clean) {
        throw new AgentImportServiceError("destination_changed", "Octogee workspace changed after preview");
      }
      const workspace = await this.update(current, { status: "workspace" });
      const applied = await this.deps.applyRepository({
        sourceDir: source.repoDir,
        sourceHead: plan.source.head,
        targetDir: destination.targetDir,
        destinationHead: plan.destinationHead,
        importId,
        slug: plan.slug,
        workspacePolicy: plan.workspacePolicy,
      });
      return this.update(workspace, { importCommit: applied.importCommit });
    } finally {
      source.cleanup();
    }
  }

  private async applyIdentity(
    current: AgentImportRecord,
    plan: StoredAgentImportPlan,
  ): Promise<AgentImportRecord> {
    let checkpoint = current;
    if (!checkpoint.previousIdentity) {
      checkpoint = await this.update(checkpoint, {
        status: "identity",
        previousIdentity: await this.deps.readIdentity(plan.uid),
      });
    }
    await this.deps.syncIdentity(plan.uid, plan.config.identity);
    return this.update(checkpoint, { status: "config" });
  }

  private async applyConfig(
    current: AgentImportRecord,
    plan: StoredAgentImportPlan,
  ): Promise<AgentImportRecord> {
    let checkpoint = current;
    const workspacePrevious = await this.applyRequiredRuntimeConfig(
      plan.slug,
      plan.config.workspaceRuntimePatch,
      checkpoint.previousRuntime,
      async (previous) => {
        checkpoint = await this.update(checkpoint, { status: "config", previousRuntime: previous });
      },
    );
    const configured = await this.applyRuntimeConfig(
      plan.slug,
      plan.config.runtimePatch,
      workspacePrevious,
      async (previous) => {
        checkpoint = await this.update(checkpoint, { status: "config", previousRuntime: previous });
      },
    );
    const warnings = configured.outcome === "safe_baseline"
      ? [...new Set([...checkpoint.warnings, "config_delta_rejected"])]
      : checkpoint.warnings;
    return this.update(checkpoint, {
      status: "verifying",
      configOutcome: configured.outcome === "unchanged"
        ? plan.config.effectiveOutcome
        : configured.outcome,
      previousRuntime: configured.previous,
      warnings,
    });
  }

  private async applyRequiredRuntimeConfig(
    slug: string,
    runtimePatch: JsonObject,
    checkpointedPrevious: JsonObject | undefined,
    checkpoint: (previous: JsonObject) => Promise<void>,
  ): Promise<JsonObject> {
    if (Object.keys(runtimePatch).length === 0) return checkpointedPrevious ?? {};
    const userDefaultAgentId = `octogee-${slug}-coach`;
    return this.deps.withConfigLock(async () => {
      const before = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
      const previous = mergedPreviousRuntime(
        defaultAgentFromConfig(before.config, userDefaultAgentId),
        runtimePatch,
        checkpointedPrevious,
      );
      if (!checkpointedPrevious || !deepEqual(previous, checkpointedPrevious)) {
        await checkpoint(previous);
      }
      if (!safelyIdKeyedAgentList(before.config)) {
        throw new AgentImportServiceError(
          "workspace_runtime_policy_failed",
          "OpenClaw agent list cannot safely enforce workspace ownership",
        );
      }
      try {
        await this.deps.invokeOpenClaw("config.patch", {
          raw: JSON.stringify(defaultAgentPatch(before.config, userDefaultAgentId, runtimePatch)),
          baseHash: before.hash,
        });
      } catch {
        const current = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
        const patchState = runtimePatchState(before.config, current.config, userDefaultAgentId, runtimePatch);
        if (patchState === "unchanged") {
          throw new AgentImportServiceError(
            "workspace_runtime_policy_failed",
            "OpenClaw rejected the required workspace ownership configuration",
          );
        }
        if (patchState === "diverged") {
          throw new AgentImportServiceError("config_changed", "OpenClaw configuration changed during import");
        }
      }
      const after = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
      assertRuntimePatchApplied(before.config, after.config, userDefaultAgentId, runtimePatch);
      assertUnpatchedAgentConfig(before.config, after.config, userDefaultAgentId, runtimePatch);
      await this.deps.invokeOpenClaw("health", {});
      return previous;
    });
  }

  private async completeApply(current: AgentImportRecord, importId: string): Promise<AgentImportRecord> {
    let completed = await this.update(current, {
      status: "complete",
      completedAt: this.deps.now().toISOString(),
    });
    try {
      await this.deps.deleteStaging(importId);
    } catch {
      completed = await this.update(completed, {
        warnings: [...new Set([...completed.warnings, "staging_cleanup_pending"])],
      });
    }
    return completed;
  }

  async rollback(input: { uid: string; importId: string }): Promise<AgentImportRecord> {
    return this.serializeMutation(input.uid, input.importId, () => this.rollbackOnce(input));
  }

  async abandon(input: { uid: string; importId: string }): Promise<AgentImportRecord> {
    return this.serializeMutation(input.uid, input.importId, () => this.abandonOnce(input));
  }

  private async abandonOnce(input: { uid: string; importId: string }): Promise<AgentImportRecord> {
    const current = await this.ownedRecord(input.importId, input.uid);
    if (current.status === "abandoned") return current;
    if (current.importCommit || !["previewed", "workspace", "failed"].includes(current.status)) {
      throw new AgentImportServiceError(
        "invalid_import_state",
        "only an import that has not changed the workspace can be abandoned",
      );
    }
    const workspace = await this.deps.workspaceState(current.slug);
    if (await this.deps.hasRepositoryImport({ targetDir: workspace.targetDir, importId: current.id })) {
      throw new AgentImportServiceError(
        "invalid_import_state",
        "only an import that has not changed the workspace can be abandoned",
      );
    }
    await this.deps.deleteStaging(current.id);
    await this.deps.deleteImportBlobs(current.id);
    const abandoned: AgentImportRecord = {
      ...current,
      status: "abandoned",
      updatedAt: this.deps.now().toISOString(),
    };
    delete abandoned.error;
    await this.deps.abandonRecord(abandoned);
    return abandoned;
  }

  private async rollbackOnce(input: { uid: string; importId: string }): Promise<AgentImportRecord> {
    let current = await this.ownedRecord(input.importId, input.uid);
    if (current.status === "rolled_back") return current;
    if (![
      "workspace", "identity", "config", "verifying", "complete", "failed", "rolling_back", "rollback_failed",
    ].includes(current.status) || !current.importCommit) {
      throw new AgentImportServiceError("rollback_window_closed", "only a post-workspace import with an unchanged tip can be rolled back");
    }
    const rollbackAnchor = current.completedAt ?? current.createdAt;
    const rollbackAge = this.deps.now().getTime() - Date.parse(rollbackAnchor);
    if (!Number.isFinite(rollbackAge) || rollbackAge > 7 * 24 * 60 * 60 * 1_000) {
      throw new AgentImportServiceError("rollback_window_closed", "the seven-day rollback window has closed");
    }
    try {
      if (!current.rollbackCommit) {
        const target = await this.deps.workspaceState(current.slug);
        const result = await this.deps.rollbackRepository({
          targetDir: target.targetDir,
          importCommit: current.importCommit,
          destinationHead: current.destinationHead,
          importId: current.id,
        });
        current = await this.update(current, {
          status: "rolling_back",
          rollbackCommit: result.rollbackCommit,
        });
      }
      if (current.previousIdentity) await this.deps.replaceIdentity(current.uid, current.previousIdentity);
      if (current.previousRuntime && Object.keys(current.previousRuntime).length > 0) {
        await this.patchRuntime(current.slug, current.previousRuntime);
      }
      await this.deps.deleteImportBlobs(current.id);
      current = await this.update(current, {
        status: "rolled_back",
      });
      return current;
    } catch (error) {
      await this.update(current, {
        status: "rollback_failed",
        error: {
          code: error instanceof AgentImportServiceError ? error.code : "agent_import_rollback_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  async get(input: { uid: string; importId: string }): Promise<AgentImportRecord> {
    return this.ownedRecord(input.importId, input.uid);
  }

  async latest(input: { uid: string }): Promise<AgentImportRecord | null> {
    const record = await this.deps.getLatestRecord();
    if (!record) return null;
    if (record.uid !== input.uid) throw new AgentImportServiceError("forbidden", "agent import belongs to another user");
    return record;
  }

  private async sourceForPlan(
    plan: StoredAgentImportPlan,
    importId: string,
  ): Promise<{ repoDir: string; sourceHead: string; cleanup(): void }> {
    if (plan.source.kind === "github") {
      const token = await this.deps.readGithubToken(plan.uid);
      if (!token) throw new AgentImportServiceError("github_not_connected", "GitHub was disconnected after preview");
      assertGithubRepoSize(await this.deps.readGithubRepoSize(plan.source.owner, plan.source.repo));
      return await this.deps.cloneGithubSource({
        owner: plan.source.owner,
        repo: plan.source.repo,
        branch: plan.source.branch,
        token,
      });
    }
    const archive = await this.deps.getArchive(importId);
    if (!archive || sha256(archive) !== plan.source.archiveDigest) {
      throw new AgentImportServiceError("local_archive_missing", "local import archive is missing or changed");
    }
    return this.deps.extractLocalSource(archive);
  }

  private async applyRuntimeConfig(
    slug: string,
    runtimePatch: JsonObject,
    checkpointedPrevious: JsonObject | undefined,
    checkpoint: (previous: JsonObject) => Promise<void>,
  ): Promise<{ outcome: "applied" | "safe_baseline" | "unchanged"; previous: JsonObject }> {
    if (Object.keys(runtimePatch).length === 0) {
      if (!checkpointedPrevious) await checkpoint({});
      return { outcome: "unchanged", previous: checkpointedPrevious ?? {} };
    }
    const userDefaultAgentId = `octogee-${slug}-coach`;
    return this.deps.withConfigLock(async () => {
      const before = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
      const reversePatch = previousRuntime(defaultAgentFromConfig(before.config, userDefaultAgentId), runtimePatch);
      const previous = mergedPreviousRuntime(
        defaultAgentFromConfig(before.config, userDefaultAgentId),
        runtimePatch,
        checkpointedPrevious,
      );
      if (!checkpointedPrevious || !deepEqual(previous, checkpointedPrevious)) {
        await checkpoint(previous);
      }
      if (!safelyIdKeyedAgentList(before.config)) {
        return { outcome: "safe_baseline", previous };
      }
      try {
        await this.deps.invokeOpenClaw("config.patch", {
          raw: JSON.stringify(defaultAgentPatch(before.config, userDefaultAgentId, runtimePatch)),
          baseHash: before.hash,
        });
        const after = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
        assertRuntimePatchApplied(before.config, after.config, userDefaultAgentId, runtimePatch);
        assertUnpatchedAgentConfig(before.config, after.config, userDefaultAgentId, runtimePatch);
        await this.deps.invokeOpenClaw("health", {});
        return { outcome: "applied", previous };
      } catch {
        const rollbackBase = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
        const patchState = runtimePatchState(before.config, rollbackBase.config, userDefaultAgentId, runtimePatch);
        if (patchState === "unchanged") {
          await this.deps.invokeOpenClaw("health", {});
          return { outcome: "safe_baseline", previous };
        }
        if (patchState === "diverged") {
          throw new AgentImportServiceError("config_changed", "OpenClaw configuration changed during import");
        }
        if (!safelyIdKeyedAgentList(rollbackBase.config)) {
          throw new AgentImportServiceError("config_rollback_unsafe", "OpenClaw agent list cannot be safely restored");
        }
        await this.deps.invokeOpenClaw("config.patch", {
          raw: JSON.stringify(defaultAgentPatch(rollbackBase.config, userDefaultAgentId, reversePatch)),
          baseHash: rollbackBase.hash,
        });
        const restored = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
        assertRuntimePatchApplied(rollbackBase.config, restored.config, userDefaultAgentId, reversePatch);
        assertUnpatchedAgentConfig(before.config, restored.config, userDefaultAgentId, reversePatch);
        await this.deps.invokeOpenClaw("health", {});
        return { outcome: "safe_baseline", previous };
      }
    });
  }

  private async patchRuntime(slug: string, patch: JsonObject): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    const userDefaultAgentId = `octogee-${slug}-coach`;
    await this.deps.withConfigLock(async () => {
      const before = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
      if (!safelyIdKeyedAgentList(before.config)) {
        throw new AgentImportServiceError("config_rollback_unsafe", "OpenClaw agent list cannot be safely restored");
      }
      await this.deps.invokeOpenClaw("config.patch", {
        raw: JSON.stringify(defaultAgentPatch(before.config, userDefaultAgentId, patch)),
        baseHash: before.hash,
      });
      const after = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
      assertRuntimePatchApplied(before.config, after.config, userDefaultAgentId, patch);
      assertUnpatchedAgentConfig(before.config, after.config, userDefaultAgentId, patch);
      await this.deps.invokeOpenClaw("health", {});
    });
  }

  private async ownedRecord(importId: string, uid: string): Promise<AgentImportRecord> {
    const record = await this.deps.getRecord(importId);
    if (!record) throw new AgentImportServiceError("import_not_found", "agent import was not found");
    if (record.uid !== uid) throw new AgentImportServiceError("forbidden", "agent import belongs to another user");
    return record;
  }

  private async update(
    current: AgentImportRecord,
    patch: Partial<AgentImportRecord>,
  ): Promise<AgentImportRecord> {
    const next: AgentImportRecord = {
      ...current,
      ...cloneValue(patch),
      updatedAt: this.deps.now().toISOString(),
    };
    if (patch.status && patch.status !== "failed") delete next.error;
    await this.deps.putRecord(next);
    return next;
  }
}
