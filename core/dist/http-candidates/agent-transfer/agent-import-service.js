import { createHash } from "node:crypto";
import { buildAgentImportApprovalInput, buildAgentImportConfigArtifacts, planAgentImportConfig, validateAgentImportConfigArtifacts, } from "@octogee/shared/types/agent-import";
const APPLYABLE_STATUSES = new Set([
    "previewed", "workspace", "identity", "config", "verifying", "failed",
]);
const CONFIG_GET_METHOD = "config.get";
const MAX_GITHUB_REPO_KIB = 128 * 1024;
export class AgentImportServiceError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "AgentImportServiceError";
    }
}
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function sha256(value) {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function assertGithubRepoSize(repoSizeKiB) {
    if (!Number.isSafeInteger(repoSizeKiB) || repoSizeKiB < 0) {
        throw new AgentImportServiceError("invalid_github_source", "GitHub repository size is invalid");
    }
    if (repoSizeKiB > MAX_GITHUB_REPO_KIB) {
        throw new AgentImportServiceError("archive_too_large", "GitHub repository exceeds the 128 MiB import limit");
    }
}
function configDigest(artifacts) {
    return sha256(buildAgentImportApprovalInput({
        source: { kind: "config" },
        destinationHead: "",
        workspaceDigest: "",
        configDigest: sha256(JSON.stringify(artifacts)),
        resolutions: {},
    }));
}
function approvalHash(input) {
    const source = Object.fromEntries(Object.entries(input.source).map(([key, value]) => [key, String(value)]));
    return sha256(buildAgentImportApprovalInput({
        source,
        destinationHead: input.destinationHead,
        workspaceDigest: input.workspaceDigest,
        configDigest: configDigest(input.artifacts),
        resolutions: {
            workspaceConflictDigest: input.comparison.conflictDigest,
            preserveConvergedContextFiles: String(input.workspacePolicy.preserveConvergedContextFiles),
        },
    }));
}
function adaptedArtifacts(original, doctor) {
    if ((doctor.outcome !== "migrated" && doctor.outcome !== "unchanged") ||
        !doctor.repairedCandidate) {
        return { artifacts: original, outcome: doctor.outcome };
    }
    try {
        const repaired = buildAgentImportConfigArtifacts(doctor.repairedCandidate, original.portableAgent.sourceAgentId);
        return {
            artifacts: validateAgentImportConfigArtifacts({
                ...repaired,
                configInventory: original.configInventory,
            }),
            outcome: doctor.outcome,
        };
    }
    catch {
        return { artifacts: original, outcome: "failed" };
    }
}
function cloneValue(value) {
    return structuredClone(value);
}
function configGet(value) {
    const result = record(value);
    const config = record(result?.config);
    const hash = result?.hash;
    if (!config || typeof hash !== "string" || !hash) {
        throw new AgentImportServiceError("config_get_failed", "OpenClaw returned no config hash");
    }
    return { config, hash };
}
function defaultAgentFromConfig(config, userDefaultAgentId) {
    const matches = agentList(config).filter((agent) => agent.id === userDefaultAgentId);
    if (matches.length !== 1) {
        throw new AgentImportServiceError("coach_config_missing", "Octogee agent config is missing or ambiguous");
    }
    return matches[0];
}
function restorationValue(previous, patch, wasPresent) {
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
function previousRuntime(defaultAgent, patch) {
    return Object.fromEntries(Object.entries(patch).map(([key, value]) => [
        key,
        restorationValue(defaultAgent[key], value, Object.prototype.hasOwnProperty.call(defaultAgent, key)),
    ]));
}
function mergedPreviousRuntime(defaultAgent, patch, checkpointedPrevious) {
    return {
        ...previousRuntime(defaultAgent, patch),
        ...(checkpointedPrevious ?? {}),
    };
}
function deepEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
const DELETED = Symbol("deleted");
function mergePatchValue(previous, patch) {
    if (patch === null)
        return DELETED;
    const patchObject = record(patch);
    if (!patchObject)
        return cloneValue(patch);
    const previousObject = record(previous) ?? {};
    const merged = cloneValue(previousObject);
    for (const [key, value] of Object.entries(patchObject)) {
        const next = mergePatchValue(previousObject[key], value);
        if (next === DELETED)
            delete merged[key];
        else
            merged[key] = next;
    }
    return merged;
}
function assertRuntimePatchApplied(beforeConfig, afterConfig, userDefaultAgentId, patch) {
    const before = defaultAgentFromConfig(beforeConfig, userDefaultAgentId);
    const after = defaultAgentFromConfig(afterConfig, userDefaultAgentId);
    for (const [key, value] of Object.entries(patch)) {
        const expected = mergePatchValue(before[key], value);
        if (expected === DELETED) {
            if (Object.prototype.hasOwnProperty.call(after, key)) {
                throw new AgentImportServiceError("config_readback_failed", `OpenClaw did not delete ${key}`);
            }
        }
        else if (!deepEqual(after[key], expected)) {
            throw new AgentImportServiceError("config_readback_failed", `OpenClaw did not retain ${key}`);
        }
    }
}
function runtimePatchState(beforeConfig, currentConfig, userDefaultAgentId, patch) {
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
    if (unchanged)
        return "unchanged";
    if (applied)
        return "applied";
    return "diverged";
}
function keyedAgentEntries(config) {
    return record(record(config.agents)?.entries);
}
/**
 * The roster as id-carrying objects, whichever shape openclaw is storing.
 * 2026.7.2 migrates `agents.list` into keyed `agents.entries`, where the key is
 * the id and the entry carries none.
 */
function agentList(config) {
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
    return list.map((entry) => cloneValue(entry));
}
function safelyIdKeyedAgentList(config) {
    return agentList(config).every((entry) => typeof record(entry)?.id === "string");
}
/** A keyed entry carries no `id` — the key is the id, and shipping one anyway
 *  would add a stray field to the agent. */
function defaultAgentPatch(config, userDefaultAgentId, patch) {
    return keyedAgentEntries(config)
        ? { agents: { entries: { [userDefaultAgentId]: cloneValue(patch) } } }
        : { agents: { list: [{ id: userDefaultAgentId, ...cloneValue(patch) }] } };
}
function assertUnpatchedAgentConfig(before, after, userDefaultAgentId, patch) {
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
    deps;
    static activeMutations = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    serializeMutation(uid, importId, work) {
        const key = `${uid}\0${importId}`;
        const predecessor = AgentImportService.activeMutations.get(key) ?? Promise.resolve();
        const execution = predecessor.catch(() => undefined).then(work);
        const tail = execution.then(() => undefined, () => undefined);
        AgentImportService.activeMutations.set(key, tail);
        return execution.finally(() => {
            if (AgentImportService.activeMutations.get(key) === tail)
                AgentImportService.activeMutations.delete(key);
        });
    }
    async previewGithub(input) {
        const artifacts = validateAgentImportConfigArtifacts(input.artifacts);
        const token = await this.deps.readGithubToken(input.uid);
        if (!token)
            throw new AgentImportServiceError("github_not_connected", "GitHub is not connected");
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
        }
        finally {
            source.cleanup();
        }
    }
    async previewLocal(input) {
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
        }
        finally {
            extracted.cleanup();
        }
    }
    async persistPreview(input) {
        const destination = await this.deps.workspaceState(input.slug);
        if (!destination.clean) {
            throw new AgentImportServiceError("destination_dirty", "commit or discard Octogee workspace changes before import");
        }
        let doctor;
        try {
            doctor = await this.deps.runDoctor(input.artifacts.doctorCandidate);
        }
        catch {
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
        const comparison = await this.deps.compareWorkspaces(input.repoDir, destination.targetDir, input.workspacePolicy);
        const id = this.deps.newId();
        const hash = approvalHash({
            source: input.source,
            destinationHead: destination.head,
            workspaceDigest: input.inspected.workspaceDigest,
            artifacts: input.artifacts,
            comparison,
            workspacePolicy: input.workspacePolicy,
        });
        const preview = {
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
            if (input.archive)
                await this.deps.putArchive(id, input.archive);
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
        }
        catch (error) {
            await this.deps.deleteStaging(id);
            throw error;
        }
        return preview;
    }
    async apply(input) {
        return this.serializeMutation(input.uid, input.importId, () => this.applyOnce(input));
    }
    async applyOnce(input) {
        let current = await this.ownedRecord(input.importId, input.uid);
        if (current.status === "complete")
            return current;
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
        if (plan.workspacePolicy.preserveConvergedContextFiles !==
            input.workspacePolicy.preserveConvergedContextFiles) {
            throw new AgentImportServiceError("workspace_policy_changed", "workspace ownership changed after preview; preview the import again");
        }
        try {
            current = await this.applyWorkspace(current, plan, input.importId);
            current = await this.applyIdentity(current, plan);
            current = await this.applyConfig(current, plan);
            return await this.completeApply(current, input.importId);
        }
        catch (error) {
            try {
                const checkpoint = await this.ownedRecord(input.importId, input.uid);
                await this.update(checkpoint, {
                    status: "failed",
                    error: {
                        code: error instanceof AgentImportServiceError ? error.code : "agent_import_failed",
                        message: error instanceof Error ? error.message : String(error),
                    },
                });
            }
            catch (checkpointError) {
                throw new AggregateError([error, checkpointError], `agent import failed and failure checkpointing also failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
            throw error;
        }
    }
    async applyWorkspace(current, plan, importId) {
        if (current.importCommit)
            return current;
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
        }
        finally {
            source.cleanup();
        }
    }
    async applyIdentity(current, plan) {
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
    async applyConfig(current, plan) {
        let checkpoint = current;
        const workspacePrevious = await this.applyRequiredRuntimeConfig(plan.slug, plan.config.workspaceRuntimePatch, checkpoint.previousRuntime, async (previous) => {
            checkpoint = await this.update(checkpoint, { status: "config", previousRuntime: previous });
        });
        const configured = await this.applyRuntimeConfig(plan.slug, plan.config.runtimePatch, workspacePrevious, async (previous) => {
            checkpoint = await this.update(checkpoint, { status: "config", previousRuntime: previous });
        });
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
    async applyRequiredRuntimeConfig(slug, runtimePatch, checkpointedPrevious, checkpoint) {
        if (Object.keys(runtimePatch).length === 0)
            return checkpointedPrevious ?? {};
        const userDefaultAgentId = `octogee-${slug}-coach`;
        return this.deps.withConfigLock(async () => {
            const before = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
            const previous = mergedPreviousRuntime(defaultAgentFromConfig(before.config, userDefaultAgentId), runtimePatch, checkpointedPrevious);
            if (!checkpointedPrevious || !deepEqual(previous, checkpointedPrevious)) {
                await checkpoint(previous);
            }
            if (!safelyIdKeyedAgentList(before.config)) {
                throw new AgentImportServiceError("workspace_runtime_policy_failed", "OpenClaw agent list cannot safely enforce workspace ownership");
            }
            try {
                await this.deps.invokeOpenClaw("config.patch", {
                    raw: JSON.stringify(defaultAgentPatch(before.config, userDefaultAgentId, runtimePatch)),
                    baseHash: before.hash,
                });
            }
            catch {
                const current = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
                const patchState = runtimePatchState(before.config, current.config, userDefaultAgentId, runtimePatch);
                if (patchState === "unchanged") {
                    throw new AgentImportServiceError("workspace_runtime_policy_failed", "OpenClaw rejected the required workspace ownership configuration");
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
    async completeApply(current, importId) {
        let completed = await this.update(current, {
            status: "complete",
            completedAt: this.deps.now().toISOString(),
        });
        try {
            await this.deps.deleteStaging(importId);
        }
        catch {
            completed = await this.update(completed, {
                warnings: [...new Set([...completed.warnings, "staging_cleanup_pending"])],
            });
        }
        return completed;
    }
    async rollback(input) {
        return this.serializeMutation(input.uid, input.importId, () => this.rollbackOnce(input));
    }
    async abandon(input) {
        return this.serializeMutation(input.uid, input.importId, () => this.abandonOnce(input));
    }
    async abandonOnce(input) {
        const current = await this.ownedRecord(input.importId, input.uid);
        if (current.status === "abandoned")
            return current;
        if (current.importCommit || !["previewed", "workspace", "failed"].includes(current.status)) {
            throw new AgentImportServiceError("invalid_import_state", "only an import that has not changed the workspace can be abandoned");
        }
        const workspace = await this.deps.workspaceState(current.slug);
        if (await this.deps.hasRepositoryImport({ targetDir: workspace.targetDir, importId: current.id })) {
            throw new AgentImportServiceError("invalid_import_state", "only an import that has not changed the workspace can be abandoned");
        }
        await this.deps.deleteStaging(current.id);
        await this.deps.deleteImportBlobs(current.id);
        const abandoned = {
            ...current,
            status: "abandoned",
            updatedAt: this.deps.now().toISOString(),
        };
        delete abandoned.error;
        await this.deps.abandonRecord(abandoned);
        return abandoned;
    }
    async rollbackOnce(input) {
        let current = await this.ownedRecord(input.importId, input.uid);
        if (current.status === "rolled_back")
            return current;
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
            if (current.previousIdentity)
                await this.deps.replaceIdentity(current.uid, current.previousIdentity);
            if (current.previousRuntime && Object.keys(current.previousRuntime).length > 0) {
                await this.patchRuntime(current.slug, current.previousRuntime);
            }
            await this.deps.deleteImportBlobs(current.id);
            current = await this.update(current, {
                status: "rolled_back",
            });
            return current;
        }
        catch (error) {
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
    async get(input) {
        return this.ownedRecord(input.importId, input.uid);
    }
    async latest(input) {
        const record = await this.deps.getLatestRecord();
        if (!record)
            return null;
        if (record.uid !== input.uid)
            throw new AgentImportServiceError("forbidden", "agent import belongs to another user");
        return record;
    }
    async sourceForPlan(plan, importId) {
        if (plan.source.kind === "github") {
            const token = await this.deps.readGithubToken(plan.uid);
            if (!token)
                throw new AgentImportServiceError("github_not_connected", "GitHub was disconnected after preview");
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
    async applyRuntimeConfig(slug, runtimePatch, checkpointedPrevious, checkpoint) {
        if (Object.keys(runtimePatch).length === 0) {
            if (!checkpointedPrevious)
                await checkpoint({});
            return { outcome: "unchanged", previous: checkpointedPrevious ?? {} };
        }
        const userDefaultAgentId = `octogee-${slug}-coach`;
        return this.deps.withConfigLock(async () => {
            const before = configGet(await this.deps.invokeOpenClaw(CONFIG_GET_METHOD, {}));
            const reversePatch = previousRuntime(defaultAgentFromConfig(before.config, userDefaultAgentId), runtimePatch);
            const previous = mergedPreviousRuntime(defaultAgentFromConfig(before.config, userDefaultAgentId), runtimePatch, checkpointedPrevious);
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
            }
            catch {
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
    async patchRuntime(slug, patch) {
        if (Object.keys(patch).length === 0)
            return;
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
    async ownedRecord(importId, uid) {
        const record = await this.deps.getRecord(importId);
        if (!record)
            throw new AgentImportServiceError("import_not_found", "agent import was not found");
        if (record.uid !== uid)
            throw new AgentImportServiceError("forbidden", "agent import belongs to another user");
        return record;
    }
    async update(current, patch) {
        const next = {
            ...current,
            ...cloneValue(patch),
            updatedAt: this.deps.now().toISOString(),
        };
        if (patch.status && patch.status !== "failed")
            delete next.error;
        await this.deps.putRecord(next);
        return next;
    }
}
