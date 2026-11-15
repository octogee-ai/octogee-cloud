import * as crypto from "crypto";
import { log } from "../config.js";
import { platformStateStore } from "../provisioner-platform-state.js";
import { workspaceGeneralChannelName, workspaceDefaultAgentChannelName, } from "@octogee/shared/types/identity";
import { computeWorkspaceDisplayName, WORKSPACE_CHANNEL_DISPLAY_NAMES, } from "@octogee/shared/types/display-names";
import { agentChannelPurpose } from "./agent-channel-purpose.js";
import { userChannelMembers } from "./channel-members.js";
import { mintAndPersistDefaultAgentToken } from "./default-agent-pat.js";
import { USER_PAT_DESCRIPTION } from "./user-pat.js";
import { mmUploadAvatar } from "./avatars.js";
import { controlUiCommandSpec, controlUiCommandUrl } from "./control-ui-command.js";
import { isPlaceholderEmail, placeholderEmail } from "../placeholder-email.js";
export const DEFAULT_TEAM_CHANNELS_TO_ARCHIVE = ["town-square", "off-topic", "general"];
export const DEFAULT_AGENT_BOT_DISPLAY_NAME = "Octo";
async function backfillDefaultAgentIdentity(host, uid, slug) {
    const defaultAgentSecret = await platformStateStore.secrets.get(uid, "coachMattermost");
    if (defaultAgentSecret !== null) {
        const persisted = defaultAgentSecret.kind === "coach-mattermost" ? defaultAgentSecret.personalToken : null;
        const token = typeof persisted === "string" && persisted.length > 0 ? persisted : null;
        return { coachUserId: null, personalToken: token };
    }
    let coachUserId = (await platformStateStore.workspaces.agentIdentities.get(uid))?.mattermostUserId ?? null;
    if (!coachUserId) {
        const defaultAgentLookup = await host.findUser(`${slug}-coach`);
        coachUserId = defaultAgentLookup?.id ?? null;
    }
    if (!coachUserId) {
        log(`[mattermost] ⚠ agent PAT backfill skipped for ${slug}: no agent MM user found`);
        return { coachUserId: null, personalToken: null };
    }
    const minted = await mintAndPersistDefaultAgentToken({ channelHost: host, secrets: platformStateStore.secrets, now: () => SERVER_NOW }, uid, coachUserId);
    if (!minted) {
        log(`[mattermost] ⚠ agent PAT backfill failed for ${slug} — agent will fall back to shared bot token`);
        return { coachUserId: null, personalToken: null };
    }
    log(`[mattermost] agent PAT backfilled for ${slug} on re-provision`);
    return { coachUserId, personalToken: minted.token };
}
const SERVER_NOW = { serverNow: true };
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
async function loadExistingMattermostTopology(slug) {
    const scope = { workspaceSlug: slug, projectSlug: null };
    const { records, channels } = platformStateStore.workspaces;
    const [workspace, defaultAgentDm, general, admin] = await Promise.all([
        records.get(slug),
        channels.get(scope, "coach-dm"),
        channels.get(scope, "general"),
        channels.get(scope, "admin"),
    ]);
    const teamId = nonEmptyString(workspace?.mattermostTeamId);
    const coachChannelId = nonEmptyString(defaultAgentDm?.mattermostChannelId);
    const generalChannelId = nonEmptyString(general?.mattermostChannelId);
    if (!teamId || !coachChannelId || !generalChannelId)
        return null;
    return {
        teamId,
        coachChannelId,
        generalChannelId,
        adminChannelId: nonEmptyString(admin?.mattermostChannelId),
    };
}
function existingProvisioningUpdate(input) {
    const { userMmUserId, username, channelName, topology, coachUserId, personalToken } = input;
    const update = {
        "mattermost.userId": userMmUserId,
        "mattermost.username": username,
        "mattermost.teamId": topology.teamId,
        "mattermost.channelId": topology.coachChannelId,
        "mattermost.channelName": channelName,
        "mattermost.dmChannelId": topology.coachChannelId,
        "mattermost.generalChannelId": topology.generalChannelId,
        "mattermost.proxyUrl": process.env.API_PUBLIC_URL || "",
        ...(topology.adminChannelId ? { "mattermost.adminChannelId": topology.adminChannelId } : {}),
    };
    if (coachUserId)
        update["mattermost.coachUserId"] = coachUserId;
    if (personalToken)
        update._coachPersonalToken = personalToken;
    return update;
}
async function backfillExistingProvisioning(host, uid, slug, readStoredNames) {
    const user = await platformStateStore.users.records.get(uid);
    const userMmUserId = nonEmptyString(user?.mattermostUserId);
    if (!userMmUserId)
        return null;
    const topology = await loadExistingMattermostTopology(slug);
    if (!topology)
        return null;
    const stored = await readStoredNames(uid, slug);
    log(`[mattermost] user already provisioned (userId=${userMmUserId}) — skipping MM creation`);
    const backfilledDefaultAgent = await backfillDefaultAgentIdentity(host, uid, slug);
    const coachUserId = backfilledDefaultAgent.coachUserId
        ?? nonEmptyString((await platformStateStore.workspaces.agentIdentities.get(uid))?.mattermostUserId);
    return existingProvisioningUpdate({
        userMmUserId,
        username: nonEmptyString(stored.username) ?? slug,
        channelName: nonEmptyString(stored.coachChannelName) ?? workspaceDefaultAgentChannelName(slug),
        topology,
        coachUserId,
        personalToken: backfilledDefaultAgent.personalToken,
    });
}
async function createOrFindMattermostUser(host, input) {
    const { uid, slug, email, firstName, lastName } = input;
    const username = slug;
    const mmUser = await host.ensureUser({
        username,
        email: email || placeholderEmail(uid),
        firstName,
        lastName: lastName || "",
        nickname: firstName || slug,
    });
    if (!mmUser) {
        log(`[mattermost] ⚠ failed to create or find user ${username}`);
        return null;
    }
    return mmUser;
}
async function createOrFindTeam(host, slug, firstName, vibe) {
    const teamName = slug;
    const teamDisplayName = computeWorkspaceDisplayName({ slug, firstName, vibe });
    const team = await host.ensureTeam({
        name: teamName,
        displayName: teamDisplayName,
        inviteOnly: true,
    });
    if (!team) {
        log(`[mattermost] ⚠ failed to create workspace team ${teamName}`);
        return null;
    }
    log(`[mattermost] workspace team created: ${teamName} (${team.id})`);
    return team;
}
async function setupWorkspaceTeam(host, opts) {
    const { teamId, slug, userMmUserId, adminUserId } = opts;
    await host.addMember({ teamId }, userMmUserId, "team_admin team_user");
    for (const defaultName of DEFAULT_TEAM_CHANNELS_TO_ARCHIVE) {
        try {
            const archivedId = await host.archiveChannel({ teamId, name: defaultName });
            if (archivedId) {
                log(`[mattermost] archived default channel #${defaultName} (${archivedId})`);
            }
        }
        catch {
            // Non-fatal — channel may not exist or already archived
        }
    }
    if (adminUserId) {
        await host.addMember({ teamId }, adminUserId);
        log(`[mattermost] admin bot added to workspace team ${slug}`);
    }
    await registerControlUiCommand(host, teamId, slug);
}
async function registerControlUiCommand(host, teamId, slug) {
    try {
        const result = await host.ensureCommand(controlUiCommandSpec(teamId, controlUiCommandUrl(process.env.K8S_NAMESPACE)));
        log(`[mattermost] /ui command ${result} in workspace team ${slug}`);
    }
    catch (e) {
        log(`⚠ [mattermost] /ui command registration failed for workspace team ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
async function uploadUserAvatar(userMmUserId, email, photoURL) {
    if (photoURL) {
        const ok = await mmUploadAvatar(userMmUserId, photoURL);
        if (ok)
            log(`[mattermost] avatar uploaded from OAuth photo`);
        return;
    }
    if (email && !isPlaceholderEmail(email)) {
        // eslint-disable-next-line sonarjs/hashing -- Gravatar API spec requires md5(email)
        const hash = crypto.createHash("md5").update(email.toLowerCase().trim()).digest("hex");
        const gravatarUrl = `https://gravatar.com/avatar/${hash}?d=identicon&s=200`;
        const ok = await mmUploadAvatar(userMmUserId, gravatarUrl);
        if (ok)
            log(`[mattermost] avatar uploaded from Gravatar`);
    }
}
async function createChannelWithMembers(host, spec, memberIds) {
    const channel = await host.ensureChannel({ ...spec, private: true });
    if (!channel)
        return null;
    for (const memberId of memberIds) {
        await host.addMember({ channelId: channel.id }, memberId);
    }
    return channel.id;
}
async function persistUserToken(uid, userMmUserId, token) {
    if (token) {
        await platformStateStore.secrets.put(uid, {
            kind: "builder-mattermost",
            secretId: "mattermost",
            projectId: null,
            personalToken: token,
            mattermostUserId: userMmUserId,
            createdAt: SERVER_NOW,
            rotatedAt: null,
        });
    }
    else {
        log(`[mattermost] ⚠ no personal token created — chat will be read-only until fixed`);
    }
}
async function createDefaultAgentBot(host, input) {
    const { uid, slug, firstName, teamId, coachChannelId, generalChannelId } = input;
    const defaultAgentUsername = `${slug}-coach`;
    const defaultAgentMmUser = await host.ensureBot({
        username: defaultAgentUsername,
        displayName: DEFAULT_AGENT_BOT_DISPLAY_NAME,
        description: `Coach for ${firstName || slug}`,
    });
    if (!defaultAgentMmUser) {
        log(`[mattermost] ⚠ failed to create agent bot ${defaultAgentUsername} — agent identity will use defaults`);
        return { coachUserId: null, personalToken: null };
    }
    await host.addMember({ teamId }, defaultAgentMmUser.id);
    await host.addMember({ channelId: coachChannelId }, defaultAgentMmUser.id);
    if (generalChannelId) {
        await host.addMember({ channelId: generalChannelId }, defaultAgentMmUser.id);
    }
    log(`[mattermost] agent bot created: ${defaultAgentUsername} (${defaultAgentMmUser.id})`);
    const coachToken = await mintAndPersistDefaultAgentToken({ channelHost: host, secrets: platformStateStore.secrets, now: () => SERVER_NOW }, uid, defaultAgentMmUser.id);
    if (!coachToken) {
        log(`[mattermost] ⚠ agent PAT creation failed — agent identity will fall back to octogee-bot until re-provisioned`);
        return { coachUserId: defaultAgentMmUser.id, personalToken: null };
    }
    log(`[mattermost] agent PAT minted and persisted for ${defaultAgentUsername}`);
    return { coachUserId: defaultAgentMmUser.id, personalToken: coachToken.token };
}
async function createWorkspaceChannels(host, input) {
    const { teamId, slug, firstName, userMmUserId, adminMmUserId } = input;
    const ownerLabel = firstName || slug;
    const defaultAgentChannelName = workspaceDefaultAgentChannelName(slug);
    const coachChannelId = await createChannelWithMembers(host, {
        teamId,
        name: defaultAgentChannelName,
        displayName: WORKSPACE_CHANNEL_DISPLAY_NAMES.coach,
        purpose: agentChannelPurpose(ownerLabel),
    }, userChannelMembers("coach", { customerMmUserId: userMmUserId, defaultAgentMmUserId: null, adminMmUserId }));
    if (!coachChannelId) {
        log(`[mattermost] ⚠ failed to create channel for ${slug}`);
        return null;
    }
    const generalChannelName = workspaceGeneralChannelName(slug);
    const generalChannelId = await createChannelWithMembers(host, {
        teamId,
        name: generalChannelName,
        displayName: WORKSPACE_CHANNEL_DISPLAY_NAMES.general,
        purpose: `${ownerLabel}'s workspace — general discussion`,
    }, userChannelMembers("general", { customerMmUserId: userMmUserId, defaultAgentMmUserId: null, adminMmUserId }));
    if (generalChannelId)
        log(`[mattermost] general channel created: #${generalChannelName} (${generalChannelId})`);
    else
        log(`[mattermost] ⚠ failed to create general channel for ${slug} — non-fatal`);
    return { coachChannelId, defaultAgentChannelName, generalChannelId };
}
function buildResultMap(args) {
    const { userMmUserId, slug, teamId, coachChannelId, defaultAgentChannelName, generalChannelId, defaultAgent } = args;
    return {
        "mattermost.userId": userMmUserId,
        "mattermost.username": slug,
        "mattermost.teamId": teamId,
        "mattermost.channelId": coachChannelId,
        "mattermost.channelName": defaultAgentChannelName,
        "mattermost.dmChannelId": coachChannelId,
        "mattermost.generalChannelId": generalChannelId || null,
        "mattermost.proxyUrl": process.env.API_PUBLIC_URL || "",
        ...(defaultAgent.coachUserId ? { "mattermost.coachUserId": defaultAgent.coachUserId } : {}),
        ...(defaultAgent.personalToken ? { _coachPersonalToken: defaultAgent.personalToken } : {}),
    };
}
export async function provisionMattermostUser(input, host, readStoredNames) {
    const { uid, slug, firstName, email, vibe, lastName, photoURL } = input;
    const MM_ADMIN_USER_ID = process.env.MM_ADMIN_USER_ID;
    try {
        const backfilled = await backfillExistingProvisioning(host, uid, slug, readStoredNames);
        if (backfilled)
            return backfilled;
        const mmUser = await createOrFindMattermostUser(host, { uid, slug, email, firstName, lastName });
        if (!mmUser)
            return {};
        const team = await createOrFindTeam(host, slug, firstName, vibe);
        if (!team)
            return {};
        const teamId = team.id;
        await setupWorkspaceTeam(host, {
            teamId,
            slug,
            userMmUserId: mmUser.id,
            adminUserId: MM_ADMIN_USER_ID,
        });
        await uploadUserAvatar(mmUser.id, email, photoURL);
        const channels = await createWorkspaceChannels(host, {
            teamId,
            slug,
            firstName,
            userMmUserId: mmUser.id,
            adminMmUserId: MM_ADMIN_USER_ID ?? null,
        });
        if (!channels)
            return {};
        const { coachChannelId, defaultAgentChannelName, generalChannelId } = channels;
        const userToken = await host.issueToken(mmUser.id, USER_PAT_DESCRIPTION);
        log(`[mattermost] ✅ provisioned: ${slug} (${mmUser.id}), channel: ${coachChannelId} (#${defaultAgentChannelName})`);
        await persistUserToken(uid, mmUser.id, userToken);
        const defaultAgent = await createDefaultAgentBot(host, {
            uid,
            slug,
            firstName,
            teamId,
            coachChannelId,
            generalChannelId,
        });
        return buildResultMap({
            userMmUserId: mmUser.id,
            slug,
            teamId,
            coachChannelId,
            defaultAgentChannelName,
            generalChannelId,
            defaultAgent,
        });
    }
    catch (e) {
        log(`[mattermost] ⚠ provisioning failed: ${e instanceof Error ? e.message : String(e)} — continuing without chat`);
        return {};
    }
}
