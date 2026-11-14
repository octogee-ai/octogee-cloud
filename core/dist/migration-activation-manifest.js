import { withPinnedDirectory } from "./pinned-directory.js";
import { PROJECT_AGENT_WORKSPACE_PARTS } from "@octogee/shared/types/project";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IMPORT_ACTIVATION_PATCH_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";
import { parseAgentId } from "@octogee/shared/types/identity";
import { mattermostAccountEndpointsForTarget } from "@octogee/shared/types/openclaw-mattermost-accounts";
import { applyConfigPatch, userAgentRosterPatch, userConfigAgentRosterReplacePaths, filterOutUserBindings, orderIsolatedGatewayRoster, replaceUserAgentsInFullAgentList, staleProjectAgentAccountNulls, upsertAgentInFullAgentList, } from "./apply-config-patch.js";
import { rebindPlatformEmbeddingRefs } from "./platform-embedding-refs.js";
import { reconcileIsolatedGatewayAgentEntry, reconcileSharedGatewayAgentEntry, } from "./system-config-invariants.js";
export const MIGRATION_ACTIVATION_DIR = ".octogee-migration-activation";
export const MIGRATION_ACTIVATION_FILE = "activation.json";
export const MIGRATION_ACTIVATION_MAX_BYTES = 256 * 1024 ** 2;
const IDENTITY_MAX_BYTES = 4 * 1024 ** 2;
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function activationAgentForTarget(manifestAgent, currentAgent, targetUsesKeyedEntries) {
    const selected = currentAgent && hasOwn(currentAgent, "model")
        ? { ...manifestAgent, model: currentAgent.model }
        : { ...manifestAgent };
    delete selected.default;
    if (currentAgent?.default === true)
        selected.default = true;
    const agent = selected;
    if (targetUsesKeyedEntries || !hasOwn(agent, "memory"))
        return agent;
    const memory = agent.memory;
    if (!isRecord(memory) || !isRecord(memory.search)) {
        throw new Error("stable target cannot represent beta agent memory without memory.search");
    }
    const unsupportedMemoryFields = Object.keys(memory).filter((key) => key !== "search");
    if (unsupportedMemoryFields.length > 0) {
        throw new Error(`stable target cannot represent beta agent memory fields: ${unsupportedMemoryFields.join(", ")}`);
    }
    const stableAgent = { ...agent };
    delete stableAgent.memory;
    return { ...stableAgent, memorySearch: memory.search };
}
function currentActivationAgent(current, agentId) {
    const agents = current?.agents;
    const entries = agents?.entries;
    if (isRecord(entries)) {
        const entry = entries[agentId];
        return isRecord(entry) ? { ...entry, id: agentId } : undefined;
    }
    const list = agents?.list;
    return Array.isArray(list)
        ? list.find((entry) => isRecord(entry) && entry.id === agentId)
        : undefined;
}
function rosterAgentId(agent) {
    if (typeof agent.id !== "string" || agent.id.length === 0) {
        throw new Error("activation roster agent requires a non-empty id");
    }
    return agent.id;
}
export function activationManifestTarPath(slug) {
    return path.join(MIGRATION_ACTIVATION_DIR, slug, MIGRATION_ACTIVATION_FILE);
}
function activationManifestDiskPath(openclawDir, slug) {
    return path.join(openclawDir, activationManifestTarPath(slug));
}
function expectedAgentId(slug) {
    return `octogee-${slug}-coach`;
}
function expectedAccountId(slug) {
    return `${slug}-coach`;
}
function expectedProjectAccountId(slug, agentId) {
    const parsed = parseAgentId(agentId);
    if (parsed.kind !== "project" || parsed.username !== slug)
        return null;
    return `${slug}-proj-${parsed.project}`;
}
function validateManifestAgent(value, slug, expectedId, expectedAccount) {
    const agent = value.agent;
    const mattermostAccount = value.mattermostAccount;
    const bindings = value.bindings;
    if (value.agentId !== expectedId || value.accountId !== expectedAccount) {
        throw new Error(`[migration-activation:${slug}] activation manifest id mismatch`);
    }
    if (!isRecord(agent) || agent.id !== expectedId) {
        throw new Error(`[migration-activation:${slug}] activation manifest agent missing or mismatched`);
    }
    if (!isRecord(mattermostAccount)
        || typeof mattermostAccount.botToken !== "string"
        || mattermostAccount.botToken.length === 0) {
        throw new Error(`[migration-activation:${slug}] activation manifest mattermost account is missing botToken`);
    }
    if (!Array.isArray(bindings) || bindings.length === 0) {
        throw new Error(`[migration-activation:${slug}] activation manifest has no channel bindings`);
    }
    if (!bindings.every((binding) => {
        if (!isRecord(binding) || binding.agentId !== expectedId || !isRecord(binding.match)) {
            return false;
        }
        return binding.match.channel === "mattermost" &&
            binding.match.accountId === expectedAccount;
    })) {
        throw new Error(`[migration-activation:${slug}] activation manifest contains foreign binding scope`);
    }
    const stableBinding = {
        agentId: expectedId,
        match: { channel: "mattermost", accountId: expectedAccount },
    };
    const normalizedBindings = bindings.some((binding) => isAccountBinding(binding))
        ? bindings
        : [stableBinding, ...bindings];
    return {
        agentId: expectedId,
        accountId: expectedAccount,
        agent,
        mattermostAccount,
        bindings: normalizedBindings,
    };
}
function validateManifestShape(value, slug) {
    if (!isRecord(value)) {
        throw new Error(`[migration-activation:${slug}] activation manifest is not an object`);
    }
    const agentId = expectedAgentId(slug);
    const accountId = expectedAccountId(slug);
    if (value.slug !== slug || value.version !== 2) {
        throw new Error(`[migration-activation:${slug}] activation manifest version/slug mismatch`);
    }
    const appliedFingerprint = value.appliedFingerprint;
    if (typeof appliedFingerprint !== "string" || appliedFingerprint.length === 0) {
        throw new Error(`[migration-activation:${slug}] activation manifest version/slug mismatch`);
    }
    const workspace = validateManifestAgent(value, slug, agentId, accountId);
    const rawProjects = value.projectAgents;
    if (rawProjects !== undefined && !Array.isArray(rawProjects)) {
        throw new Error(`[migration-activation:${slug}] activation manifest project agents are invalid`);
    }
    const projectAgents = (rawProjects ?? []).map((project) => {
        if (!isRecord(project) || typeof project.agentId !== "string") {
            throw new Error(`[migration-activation:${slug}] activation manifest project agent is invalid`);
        }
        const projectAccountId = expectedProjectAccountId(slug, project.agentId);
        if (!projectAccountId) {
            throw new Error(`[migration-activation:${slug}] activation manifest project agent id mismatch`);
        }
        return validateManifestAgent(project, slug, project.agentId, projectAccountId);
    });
    const ids = new Set();
    const accounts = new Set();
    for (const entry of [workspace, ...projectAgents]) {
        if (ids.has(entry.agentId) || accounts.has(entry.accountId)) {
            throw new Error(`[migration-activation:${slug}] activation manifest contains duplicate agent/account`);
        }
        ids.add(entry.agentId);
        accounts.add(entry.accountId);
    }
    return {
        version: 2,
        slug,
        appliedFingerprint,
        ...workspace,
        projectAgents,
        ...(value.targetWorkspaceIdentities === undefined ? {} : {
            targetWorkspaceIdentities: validateTargetWorkspaceIdentities(value.targetWorkspaceIdentities, slug, [workspace, ...projectAgents].map(agent => agent.agentId)),
        }),
        ...(value.sourceWorkspaceIdentities === undefined ? {} : {
            sourceWorkspaceIdentities: validateSourceWorkspaceIdentities(value.sourceWorkspaceIdentities, [workspace, ...projectAgents]),
        }),
    };
}
function validateSourceIdentityCustody(value) {
    if (!isRecord(value) || !["migrationId", "uid", "gatewayId", "podUid"].every(key => typeof value[key] === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value[key])) ||
        !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 0) {
        throw new Error("Source workspace identity custody is invalid");
    }
}
function identityBytes(file) {
    if (file.content === null && file.sha256 === null)
        return null;
    if (typeof file.content !== "string" || file.content.length > Math.ceil(IDENTITY_MAX_BYTES / 3) * 4 ||
        typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
        throw new Error("Source workspace identity capture is invalid");
    }
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length > IDENTITY_MAX_BYTES || bytes.toString("base64") !== file.content ||
        createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new Error("Source workspace identity capture changed");
    }
    return bytes;
}
function validateSourceWorkspaceIdentities(value, agents) {
    validateSourceIdentityCustody(value);
    const raw = value;
    const files = validateWorkspaceIdentityFiles(raw.files, agents);
    return { migrationId: value.migrationId, uid: value.uid, gatewayId: value.gatewayId,
        podUid: value.podUid, epoch: value.epoch, files };
}
function validateWorkspaceIdentityFiles(rawFiles, agents) {
    if (!Array.isArray(rawFiles) || rawFiles.length !== agents.length || rawFiles.length > 16_384) {
        throw new Error("Source workspace identity coverage is invalid");
    }
    const expected = new Set(agents.map(agent => agent.agentId));
    return rawFiles.map(file => {
        if (!isRecord(file) || typeof file.agentId !== "string" || !expected.delete(file.agentId)) {
            throw new Error("Source workspace identity agent is invalid");
        }
        const captured = { agentId: file.agentId, content: file.content, sha256: file.sha256 };
        identityBytes(captured);
        return captured;
    });
}
function identityWorkspaceParts(slug, agentId, privateWorkspace = false) {
    const parsed = parseAgentId(agentId);
    if (parsed.kind === "unknown" || parsed.username !== slug)
        throw new Error("Source workspace identity agent is foreign");
    return ["customers", slug, ...(parsed.kind === "project" ? [...(privateWorkspace ? PROJECT_AGENT_WORKSPACE_PARTS : ["projects"]), parsed.project] : [])];
}
export function privateProjectWorkspaceAgentIds(manifest) {
    const root = manifest.agent.workspace;
    if (typeof root !== "string" || !path.isAbsolute(root))
        return new Set();
    return new Set(manifest.projectAgents.filter(entry => entry.agent.workspace === path.join(root, ...identityWorkspaceParts(manifest.slug, entry.agentId, true).slice(2))).map(entry => entry.agentId));
}
function targetIdentityAgents(slug, agentIds, stateDir, privateWorkspaces) {
    if (agentIds.length === 0 || agentIds.length > 16_384 || new Set(agentIds).size !== agentIds.length)
        throw new Error("Target workspace identity coverage is invalid");
    return agentIds.map(agentId => ({ agentId, agent: { workspace: path.join(stateDir, ...identityWorkspaceParts(slug, agentId, privateWorkspaces?.has(agentId))) } }));
}
export function assertTargetIdentityCustody(expected, actual) {
    for (const value of [expected, actual]) {
        if (!isRecord(value) || !["uid", "gatewayId", "podUid"].every(key => typeof value[key] === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value[key])) ||
            value.migrationId !== undefined && (typeof value.migrationId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(value.migrationId)) ||
            value.assignmentEpoch !== undefined && (!Number.isSafeInteger(value.assignmentEpoch) || Number(value.assignmentEpoch) < 0) ||
            value.migrationId === undefined && value.assignmentEpoch === undefined)
            throw new Error("Target workspace identity custody is invalid");
    }
    if (["migrationId", "assignmentEpoch", "uid", "gatewayId", "podUid"].some(key => expected[key] !== actual[key]))
        throw new Error("Target workspace identity custody changed");
}
export function validateTargetWorkspaceIdentities(value, slug, agentIds) {
    if (!isRecord(value))
        throw new Error("Target workspace identity capture is missing");
    const custody = value;
    assertTargetIdentityCustody(custody, custody);
    const agents = targetIdentityAgents(slug, agentIds, "/");
    if (!Array.isArray(value.files) || value.files.length > 16_384)
        throw new Error("Target workspace identity coverage is invalid");
    const selectedIds = custody.assignmentEpoch !== undefined && custody.migrationId === undefined && Array.isArray(value.files)
        ? new Set(value.files.map(file => isRecord(file) ? file.agentId : undefined)) : undefined;
    const selected = selectedIds ? agents.filter(agent => selectedIds.has(agent.agentId)) : agents;
    if (selected.length === 0)
        throw new Error("Target workspace identity coverage is invalid");
    const files = validateWorkspaceIdentityFiles(value.files, selected);
    if (Buffer.byteLength(JSON.stringify(value)) > MIGRATION_ACTIVATION_MAX_BYTES)
        throw new Error("Target workspace identity capture exceeds transfer limit");
    return { ...(custody.migrationId === undefined ? {} : { migrationId: custody.migrationId }), ...(custody.assignmentEpoch === undefined ? {} : { assignmentEpoch: custody.assignmentEpoch }), uid: custody.uid, gatewayId: custody.gatewayId, podUid: custody.podUid, files };
}
export async function captureTargetWorkspaceIdentities(slug, agentIds, stateDir, custody, privateWorkspaces) {
    assertTargetIdentityCustody(custody, custody);
    if (await fs.realpath(stateDir) !== stateDir)
        throw new Error("Target workspace identity root is not canonical");
    const files = [];
    let bytesCaptured = 0;
    for (const agent of targetIdentityAgents(slug, agentIds, stateDir, privateWorkspaces)) {
        let bytes = null;
        try {
            await withIdentityWorkspace(stateDir, slug, agent, async (location) => { bytes = await readSourceIdentity(location); });
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const content = bytes;
        const file = { agentId: agent.agentId, content: content?.toString("base64") ?? null, sha256: content === null ? null : createHash("sha256").update(content).digest("hex") };
        bytesCaptured += Buffer.byteLength(JSON.stringify(file));
        if (bytesCaptured > MIGRATION_ACTIVATION_MAX_BYTES)
            throw new Error("Target workspace identity capture exceeds transfer limit");
        files.push(file);
    }
    return validateTargetWorkspaceIdentities({ ...custody, files }, slug, agentIds);
}
export async function restoreTargetWorkspaceIdentities(value, slug, agentIds, stateDir, options) {
    const { custody, assertCurrent } = options;
    const capture = validateTargetWorkspaceIdentities(value, slug, agentIds);
    assertTargetIdentityCustody(capture, custody);
    await assertCurrent();
    await restoreIdentityFiles(targetIdentityAgents(slug, capture.files.map(file => file.agentId), stateDir, options.privateWorkspaces), slug, stateDir, capture.files, { assertCurrent, allowAbsentWorkspace: true });
    await assertCurrent();
}
export function assertSourceIdentityCustody(expected, actual) {
    validateSourceIdentityCustody(expected);
    validateSourceIdentityCustody(actual);
    if (["migrationId", "uid", "gatewayId", "podUid", "epoch"].some(key => expected[key] !== actual[key])) {
        throw new Error("Source workspace identity custody changed");
    }
}
async function withIdentityWorkspace(stateDir, slug, agent, use) {
    const privateParts = identityWorkspaceParts(slug, agent.agentId, true);
    const parts = agent.agent.workspace === path.join(stateDir, ...privateParts) ? privateParts : identityWorkspaceParts(slug, agent.agentId);
    const workspace = path.join(stateDir, ...parts);
    if (agent.agent.workspace !== workspace || await fs.realpath(stateDir) !== stateDir)
        throw new Error("Source workspace identity path is not canonical");
    return withPinnedDirectory(stateDir, parts, (location, assertCurrent) => use(`${location}/IDENTITY.md`, assertCurrent));
}
async function readSourceIdentity(location) {
    let file;
    try {
        file = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > IDENTITY_MAX_BYTES)
            throw new Error("Source workspace identity file is unsafe or exceeds Native's limit");
        const bytes = Buffer.alloc(before.size + 1);
        let size = 0;
        while (size < bytes.length) {
            const read = await file.read(bytes, size, bytes.length - size, size);
            if (read.bytesRead === 0)
                break;
            size += read.bytesRead;
        }
        const after = await file.stat();
        if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
            throw new Error("Source workspace identity changed while captured");
        return bytes.subarray(0, size);
    }
    finally {
        await file.close();
    }
}
export async function captureSourceWorkspaceIdentities(manifest, stateDir, custody) {
    validateSourceIdentityCustody(custody);
    const agents = manifestAgents(manifest);
    if (agents.length > 16_384)
        throw new Error("Source workspace identity coverage exceeds transfer limit");
    if (manifest.sourceWorkspaceIdentities) {
        const captured = validateSourceWorkspaceIdentities(manifest.sourceWorkspaceIdentities, manifestAgents(manifest));
        assertSourceIdentityCustody(captured, custody);
        for (const agent of manifestAgents(manifest))
            await withIdentityWorkspace(stateDir, manifest.slug, agent, async (location) => { await readSourceIdentity(location); });
        return manifest;
    }
    const files = [];
    let bytesCaptured = Buffer.byteLength(JSON.stringify(manifest));
    for (const agent of agents)
        await withIdentityWorkspace(stateDir, manifest.slug, agent, async (location) => {
            const bytes = await readSourceIdentity(location);
            const file = { agentId: agent.agentId, content: bytes?.toString("base64") ?? null,
                sha256: bytes === null ? null : createHash("sha256").update(bytes).digest("hex") };
            bytesCaptured += Buffer.byteLength(JSON.stringify(file));
            if (bytesCaptured > MIGRATION_ACTIVATION_MAX_BYTES)
                throw new Error("Source activation manifest exceeds transfer limit");
            files.push(file);
        });
    const captured = { ...manifest, sourceWorkspaceIdentities: { ...custody, files } };
    if (Buffer.byteLength(JSON.stringify(captured)) > MIGRATION_ACTIVATION_MAX_BYTES)
        throw new Error("Source activation manifest exceeds transfer limit");
    return captured;
}
export async function restoreSourceWorkspaceIdentities(manifest, stateDir, custody, assertCurrent) {
    const captured = validateSourceWorkspaceIdentities(manifest.sourceWorkspaceIdentities, manifestAgents(manifest));
    assertSourceIdentityCustody(captured, custody);
    await restoreIdentityFiles(manifestAgents(manifest), manifest.slug, stateDir, captured.files, { assertCurrent });
}
async function restoreIdentityFiles(agents, slug, stateDir, captured, options) {
    const { assertCurrent } = options;
    const files = new Map(captured.map(file => [file.agentId, file]));
    for (const agent of agents) {
        try {
            await withIdentityWorkspace(stateDir, slug, agent, async (location, assertDirectory) => {
                const bytes = identityBytes(files.get(agent.agentId));
                const current = await readSourceIdentity(location);
                if (current === null && bytes === null || current !== null && bytes !== null && current.equals(bytes))
                    return;
                const temporary = `${location}.${randomUUID()}.tmp`;
                try {
                    if (bytes !== null) {
                        const file = await fs.open(temporary, "wx", 0o600);
                        try {
                            await file.writeFile(bytes);
                            await file.sync();
                        }
                        finally {
                            await file.close();
                        }
                    }
                    await assertCurrent();
                    await assertDirectory();
                    if (bytes === null)
                        await fs.unlink(location);
                    else
                        await fs.rename(temporary, location);
                    const directory = await fs.open(path.dirname(location), "r");
                    try {
                        await directory.sync();
                    }
                    finally {
                        await directory.close();
                    }
                }
                finally {
                    await fs.rm(temporary, { force: true });
                }
            });
        }
        catch (error) {
            if (!options.allowAbsentWorkspace || identityBytes(files.get(agent.agentId)) !== null || error.code !== "ENOENT")
                throw error;
            await assertCurrent();
        }
    }
}
function sourceAgents(parsed) {
    const entries = parsed.agents?.entries;
    if (isRecord(entries)) {
        return Object.entries(entries)
            .filter((entry) => isRecord(entry[1]))
            .map(([id, agent]) => ({ ...agent, id }));
    }
    const list = parsed.agents?.list;
    return Array.isArray(list) ? list.filter(isRecord) : [];
}
async function sourceManifestAgent(input) {
    let token;
    if (input.opts.resolveBotToken) {
        token = await input.opts.resolveBotToken(input.accountId);
    }
    else if (input.isWorkspace && input.opts.botToken !== undefined) {
        token = input.opts.botToken;
    }
    else if (isRecord(input.sourceAccount)) {
        token = input.sourceAccount.botToken;
    }
    return {
        agentId: input.agent?.id,
        accountId: input.accountId,
        agent: input.agent,
        mattermostAccount: isRecord(input.sourceAccount)
            ? { ...input.sourceAccount, botToken: token }
            : input.sourceAccount,
        bindings: input.bindings,
    };
}
export async function extractOpenClawActivationManifest(configPath, slug, opts) {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const agentId = expectedAgentId(slug);
    const accountId = expectedAccountId(slug);
    const agents = sourceAgents(parsed);
    const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : [];
    const workspace = await sourceManifestAgent({
        agent: agents.find((agent) => agent.id === agentId),
        accountId,
        bindings: bindings.filter((binding) => isRecord(binding) && binding.agentId === agentId),
        opts,
        sourceAccount: parsed.channels?.mattermost?.accounts?.[accountId],
        isWorkspace: true,
    });
    const projectAgents = await Promise.all(agents
        .filter((agent) => typeof agent.id === "string" && expectedProjectAccountId(slug, agent.id))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        .map(async (agent) => {
        const projectAccountId = expectedProjectAccountId(slug, agent.id);
        return sourceManifestAgent({
            agent,
            accountId: projectAccountId,
            bindings: bindings.filter((binding) => isRecord(binding) && binding.agentId === agent.id),
            opts,
            sourceAccount: parsed.channels?.mattermost?.accounts?.[projectAccountId],
            isWorkspace: false,
        });
    }));
    return validateManifestShape({
        version: 2,
        slug,
        appliedFingerprint: opts.appliedFingerprint,
        ...workspace,
        projectAgents,
    }, slug);
}
function manifestAgents(manifest) {
    const { projectAgents, ...workspace } = manifest;
    return [workspace, ...projectAgents];
}
function mattermostBindingKey(value) {
    if (!isRecord(value) || typeof value.agentId !== "string")
        return null;
    const match = value.match;
    if (!isRecord(match) ||
        match.channel !== "mattermost" ||
        typeof match.accountId !== "string") {
        return null;
    }
    if (match.peer === undefined) {
        return `${match.accountId}\u0000${value.agentId}\u0000account`;
    }
    if (!isRecord(match.peer) ||
        typeof match.peer.kind !== "string" ||
        typeof match.peer.id !== "string") {
        return `${match.accountId}\u0000${value.agentId}\u0000malformed`;
    }
    return `${match.accountId}\u0000${value.agentId}\u0000${match.peer.kind}\u0000${match.peer.id}`;
}
function isAccountBinding(value) {
    if (!isRecord(value) || !isRecord(value.match))
        return false;
    return value.match.channel === "mattermost" &&
        typeof value.match.accountId === "string" &&
        value.match.peer === undefined;
}
function accountBindingsNeedingActivation(current, desired) {
    const desiredAccountIds = new Set(desired.flatMap((binding) => {
        if (!isAccountBinding(binding))
            return [];
        return [binding.match.accountId];
    }));
    const existing = new Set(current.flatMap((binding) => {
        const key = mattermostBindingKey(binding);
        return key ? [key] : [];
    }));
    const desiredKeys = new Set(desired.flatMap((binding) => {
        const key = mattermostBindingKey(binding);
        return key ? [key] : [];
    }));
    const affected = new Set();
    for (const binding of desired) {
        if (!isAccountBinding(binding))
            continue;
        const key = mattermostBindingKey(binding);
        const accountId = binding.match.accountId;
        if (!existing.has(key))
            affected.add(accountId);
    }
    for (const binding of current) {
        const key = mattermostBindingKey(binding);
        if (!key)
            continue;
        const accountId = key.slice(0, key.indexOf("\u0000"));
        if (desiredAccountIds.has(accountId) && !desiredKeys.has(key)) {
            affected.add(accountId);
        }
    }
    return [...affected].sort();
}
/**
 * Every agent id the activation installs. The caller compares it against the
 * target's live roster: residue the manifest does not carry has to leave by
 * `agents.delete` before the patch, because 2026.7.2 refuses a config write
 * that drops roster entries.
 */
export function activationManifestAgentIds(manifest) {
    return manifestAgents(manifest).map((entry) => entry.agentId);
}
export async function writeActivationManifest(rootDir, manifest) {
    const contents = `${JSON.stringify(manifest)}\n`;
    if (Buffer.byteLength(contents) > MIGRATION_ACTIVATION_MAX_BYTES)
        throw new Error("Source activation manifest exceeds transfer limit");
    const relPath = activationManifestTarPath(manifest.slug);
    const fullPath = path.join(rootDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 });
    const staging = await fs.mkdtemp(path.join(path.dirname(fullPath), ".activation-"));
    const temporary = path.join(staging, "manifest");
    try {
        const file = await fs.open(temporary, "wx", 0o600);
        try {
            await file.writeFile(contents, "utf-8");
            await file.sync();
        }
        finally {
            await file.close();
        }
        await fs.rename(temporary, fullPath);
        const directory = await fs.open(path.dirname(fullPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, 0o700);
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
    return { cwd: rootDir, path: relPath };
}
export async function readActivationManifest(openclawDir, slug) {
    const manifestPath = activationManifestDiskPath(openclawDir, slug);
    const file = await fs.open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
        const before = await file.stat();
        if (!before.isFile())
            throw new Error("Source activation manifest must be a regular file");
        if (before.size > MIGRATION_ACTIVATION_MAX_BYTES)
            throw new Error("Source activation manifest exceeds transfer limit");
        const bytes = Buffer.alloc(before.size + 1);
        let size = 0;
        while (size < bytes.length) {
            const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
            if (bytesRead === 0)
                break;
            size += bytesRead;
        }
        const after = await file.stat();
        if (size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw new Error("Source activation manifest changed during read");
        }
        return validateManifestShape(JSON.parse(bytes.toString("utf-8", 0, size)), slug);
    }
    finally {
        await file.close();
    }
}
export async function removeActivationManifest(openclawDir, slug) {
    const manifestDir = path.join(openclawDir, MIGRATION_ACTIVATION_DIR, slug);
    await fs.rm(manifestDir, { recursive: true, force: true });
}
function ownerCommandsSection(ownerCommandsPatch, current) {
    const commands = ownerCommandsPatch?.(current);
    return commands ? { commands } : {};
}
function privateProjectAgentForImport(agent, keyed, cwd) {
    if (cwd !== undefined)
        return { ...agent, cwd };
    const entry = { ...agent };
    if (keyed)
        entry.cwd = null;
    else
        delete entry.cwd;
    return entry;
}
export async function applyOpenClawActivationManifest(manifest, opts) {
    const privateProjects = privateProjectWorkspaceAgentIds(manifest);
    const authInheritanceAnchor = opts.authInheritanceAnchor;
    const reconcileAgent = opts.gatewayClass === "isolated"
        ? reconcileIsolatedGatewayAgentEntry
        : reconcileSharedGatewayAgentEntry;
    if (authInheritanceAnchor &&
        rosterAgentId(authInheritanceAnchor.agent) !== authInheritanceAnchor.agentId) {
        throw new Error("activation auth inheritance anchor id mismatch");
    }
    const normalizedAuthInheritanceAnchor = authInheritanceAnchor && {
        ...authInheritanceAnchor,
        agent: reconcileAgent(authInheritanceAnchor.agentId, authInheritanceAnchor.agent),
    };
    const activationDefaults = {
        ...(normalizedAuthInheritanceAnchor
            ? { authInheritance: { agentId: normalizedAuthInheritanceAnchor.agentId } }
            : {}),
        ...(opts.gatewayClass === "isolated" ? { systemAgent: { agentId: manifest.agentId } } : {}),
    };
    const startedAt = Date.now();
    let routingActivationRequired = false;
    let restartExistingAccountIds = [];
    const configPatch = await applyConfigPatch({
        buildPatch: (current) => {
            const cfg = current;
            const currentBindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
            const agents = current?.agents;
            const targetUsesKeyedEntries = isRecord(agents?.entries);
            const activationAgents = manifestAgents(manifest).map(entry => {
                const existing = currentActivationAgent(current, entry.agentId);
                let agent = entry.agent;
                if (privateProjects.has(entry.agentId)) {
                    if (opts.gatewayClass === "isolated" && existing?.sandbox !== undefined)
                        agent = { ...agent, sandbox: existing.sandbox };
                    const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
                    const cwd = opts.projectCheckoutCwd?.(agent, current) ?? (defaults?.cwd && typeof agent.workspace === "string" ? agent.workspace : undefined);
                    agent = privateProjectAgentForImport(agent, targetUsesKeyedEntries, cwd);
                }
                return { ...entry, agent: reconcileAgent(entry.agentId, activationAgentForTarget(agent, existing, targetUsesKeyedEntries)) };
            });
            const currentAccounts = current?.channels?.mattermost?.accounts ?? {};
            const missingAccountIds = accountBindingsNeedingActivation(currentBindings, activationAgents.flatMap((entry) => entry.bindings));
            restartExistingAccountIds = missingAccountIds
                .filter((accountId) => isRecord(currentAccounts[accountId]))
                .sort();
            if (missingAccountIds.length > 0 && !routingActivationRequired) {
                opts.onRoutingActivationRequired?.(missingAccountIds);
                routingActivationRequired = true;
            }
            const rosterAgents = normalizedAuthInheritanceAnchor
                ? [normalizedAuthInheritanceAnchor.agent, ...activationAgents.map((entry) => entry.agent)]
                : activationAgents.map((entry) => entry.agent);
            const nextAgents = targetUsesKeyedEntries
                ? rosterAgents
                : rosterAgents.reduce((agentList, agent) => upsertAgentInFullAgentList({ agents: { list: agentList } }, rosterAgentId(agent), agent), replaceUserAgentsInFullAgentList(current, manifest.slug, []));
            const orderedAgents = normalizedAuthInheritanceAnchor
                ? orderIsolatedGatewayRoster(nextAgents, manifest.agentId, normalizedAuthInheritanceAnchor.agentId)
                : nextAgents;
            const rosterPatch = userAgentRosterPatch(current, manifest.slug, rebindPlatformEmbeddingRefs(orderedAgents));
            return {
                ...ownerCommandsSection(opts.ownerCommandsPatch, current),
                // openclaw rejects a multi-agent roster that declares no ownership.
                agents: {
                    ...rosterPatch,
                    ownership: "explicit",
                    ...(Object.keys(activationDefaults).length > 0 ? { defaults: activationDefaults } : {}),
                },
                bindings: [
                    ...filterOutUserBindings(currentBindings, manifest.slug),
                    ...activationAgents.flatMap((entry) => entry.bindings),
                ],
                channels: {
                    mattermost: {
                        accounts: {
                            ...staleProjectAgentAccountNulls(current, manifest.slug, activationAgents.map((entry) => entry.accountId)),
                            ...mattermostAccountEndpointsForTarget(current, Object.fromEntries(activationAgents.map((entry) => [entry.accountId, entry.mattermostAccount])), opts.gatewayClass !== "isolated"),
                        },
                    },
                },
            };
        },
        buildReplacePaths: (current) => userConfigAgentRosterReplacePaths(current, manifest.slug, normalizedAuthInheritanceAnchor ? [normalizedAuthInheritanceAnchor.agentId] : []),
        logPrefix: `[import:${manifest.slug}]`,
    }, {
        rpc: opts.rpc,
        cache: opts.cache,
        signal: opts.signal,
        log: opts.log,
        totalDeadlineMs: IMPORT_ACTIVATION_PATCH_DEADLINE_MS,
    });
    return {
        elapsedMs: Date.now() - startedAt,
        routingActivationRequired,
        restartExistingAccountIds,
        configNoop: configPatch.noop === true,
    };
}
