import { createServiceLogger } from "@octogee/shared/server/service-logger";
const logger = createServiceLogger("provisioner");
import { userEntitlements } from "@octogee/shared/types/user-entitlements";
import { projectAgentConfigured, projectRepoSourceFromDoc } from "@octogee/shared/types/project";
export function mapWorkspaceChannelDoc(data) {
    const channelId = data.mattermost?.channelId;
    if (!channelId)
        return null;
    return {
        scope: "workspace",
        kind: data.kind ?? "general",
        channelId,
    };
}
export function mapProjectChannelDoc(projectId, data) {
    const channelId = data.mattermost?.channelId;
    if (!channelId)
        return null;
    return {
        scope: "project",
        projectId,
        kind: data.kind ?? "default",
        channelId,
    };
}
class ProjectAgentIdentityError extends Error {
}
function projectIdentity(value) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object")
        throw new ProjectAgentIdentityError("Invalid project agent identity");
    const { name, emoji, persona } = value;
    if (typeof name !== "string" || !name.trim() || typeof emoji !== "string" || typeof persona !== "string") {
        throw new ProjectAgentIdentityError("Invalid project agent identity");
    }
    return { name, emoji, persona };
}
function projectAgentRuntimeState(value) {
    const agent = value && typeof value === "object" ? value : {};
    return {
        ...(agent.identity === undefined ? {} : { identity: projectIdentity(agent.identity) }),
        ...(agent.kickoff?.status === "pending" ||
            agent.handoff?.status === "pending" ? { deliveryPending: true } : {}),
        activationId: typeof agent.activationId === "string" ? agent.activationId : null,
        status: typeof agent.status === "string" ? agent.status : null,
    };
}
function projectAgentArchived(projectData) {
    const commercialLifecycle = projectData.commercialLifecycle;
    return projectData.status === "archived" || (!!commercialLifecycle &&
        typeof commercialLifecycle === "object" &&
        commercialLifecycle.status === "archived");
}
export function mapProjectAgentState(projectId, projectData, credential) {
    const agent = projectData.agent;
    const requestedEnabled = projectAgentConfigured(agent);
    const enabled = requestedEnabled && !projectAgentArchived(projectData);
    const mmUserId = credential?.mattermostUserId || null;
    const token = credential?.personalToken || null;
    if (!enabled && mmUserId === null && token === null)
        return null;
    try {
        return {
            projectId, enabled, mmUserId, token, ...projectAgentRuntimeState(agent),
            ...(projectRepoSourceFromDoc(projectData.repoSource)?.provider === "github" ? { githubBacked: true } : {}),
        };
    }
    catch (error) {
        if (!(error instanceof ProjectAgentIdentityError))
            throw error;
        logger.error("Project agent identity rejected", { projectId, error: error.message });
        return { projectId, enabled, mmUserId, token, status: "error", activationId: null };
    }
}
function storedProjectAgentSource(project) {
    return {
        id: project.projectSlug,
        data: {
            status: project.status,
            ...(project.agent === null ? {} : { agent: project.agent }),
            ...(project.commercialLifecycleStatus === null ? {} : { commercialLifecycle: { status: project.commercialLifecycleStatus } }),
            ...(project.repoSource === null ? {} : { repoSource: project.repoSource }),
        },
    };
}
export async function collectStoredProjectAgentStates(state, uid, slug) {
    const [projects, projectSecrets] = await Promise.all([
        state.workspaces.projects.list(slug),
        state.secrets.list(uid, "project-agent-mattermost"),
    ]);
    return projectAgentStatesFrom(projects.map(storedProjectAgentSource), projectSecrets);
}
function projectAgentStatesFrom(projects, projectSecrets) {
    const credentials = new Map(projectSecrets.flatMap((secret) => secret.kind === "connector" || !secret.projectId ? [] : [[secret.projectId, secret]]));
    const out = [];
    const seenProjects = new Set();
    for (const { id, data } of projects) {
        if (data.agent === undefined)
            continue;
        seenProjects.add(id);
        const state = mapProjectAgentState(id, data, credentials.get(id) ?? null);
        if (state)
            out.push(state);
    }
    for (const [projectId, credential] of credentials) {
        if (seenProjects.has(projectId))
            continue;
        const state = mapProjectAgentState(projectId, {}, credential);
        if (state)
            out.push(state);
    }
    return out;
}
export function deriveSlug(uid, data) {
    const oc = data.provisioning?.openclaw;
    const slug = oc?.slug ?? data.username;
    if (!slug) {
        throw new Error(`[load:${uid}] cannot derive slug — neither provisioning.openclaw.slug nor users/{uid}.username is set`);
    }
    return slug;
}
function snapshotProvisioning(data) {
    const oc = data.provisioning?.openclaw;
    const git = data.provisioning?.git;
    return {
        gatewayId: oc?.gatewayId ?? "",
        status: (oc?.status ?? ""),
        agentIds: oc?.agentIds ?? [],
        repoUrl: git?.repoUrl ?? "",
    };
}
function snapshotIdentity(data, slug) {
    return {
        mattermostUserId: data.mattermost?.userId ?? null,
        ownerName: data.displayName ??
            data.username ??
            slug,
    };
}
function byotSystemConfig(credential) {
    return {
        byot: {
            provider: credential.provider,
            ...(credential.baseUrl === null ? {} : { baseUrl: credential.baseUrl }),
            ...(credential.model === null ? {} : { model: credential.model }),
        },
    };
}
export async function readAgentModelSelections(users, uid) {
    const selections = await users.agentModels.list(uid);
    return Object.fromEntries(selections.map(({ agentId, primary, fallbacks }) => [agentId, { primary, fallbacks: [...fallbacks] }]));
}
export function byotSnapshotProjection(credential, agentModels) {
    const byotConfig = credential?.active === true ? byotSystemConfig(credential) : undefined;
    const systemConfig = Object.keys(agentModels).length === 0
        ? byotConfig
        : { ...(byotConfig ?? {}), agentModels };
    return {
        byotActive: byotConfig !== undefined,
        ...(systemConfig ? { systemConfig } : {}),
    };
}
export async function readByotSnapshotProjection(users, uid) {
    const [credential, agentModels] = await Promise.all([
        users.modelCredentials.get(uid),
        readAgentModelSelections(users, uid),
    ]);
    return byotSnapshotProjection(credential, agentModels);
}
export function mapUserDocToSnapshot(uid, data, channels) {
    const slug = deriveSlug(uid, data);
    const planInputs = userEntitlements().pickInputs(data);
    return {
        uid,
        slug,
        channels,
        byotActive: false,
        ...snapshotIdentity(data, slug),
        ...snapshotProvisioning(data),
        planInputs,
        contextTemplateKey: userEntitlements().seedContextTemplateKey(planInputs),
        persona: null,
    };
}
export { snapshotConfigFingerprint } from "./broker-snapshot-fingerprint.js";
