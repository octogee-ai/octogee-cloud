import { parseChannelScopedMattermostSessionRoute, parseMattermostSessionRoute, parseThreadedMattermostSessionRoute, } from "@octogee/shared/types/mattermost-session-route";
import { parseAgentId, mattermostAccountIdForAgentId } from "@octogee/shared/types/identity";
import { ChannelSessionMattermostError, } from "../../channels/channel-session-model-control.js";
import { createBrokeredMattermostAccess } from "./mattermost-broker.js";
import { logger } from "../../http/logging.js";
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_HISTORY_POSTS = 20_000;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_PROJECTION_POST_VISITS = MAX_HISTORY_POSTS * 3;
const HISTORY_PAGE_SIZE = 50;
const SESSION_DISCOVERY_CONCURRENCY = 8;
const SESSION_LIST_DEFAULT_LIMIT = 100;
const SESSION_LIST_SOURCE_LIMIT = 2_048;
const MATTERMOST_ID = /^[a-z0-9]{26}$/u;
const MATTERMOST_CHANNEL_TYPE = new Set(["O", "P"]);
const ANSWER_PART_KINDS = new Set([
    "text",
    "media",
    "voice",
    "poll",
    "card",
    "preview",
    "unknown",
]);
const ANSWER_TERMINAL_OUTCOMES = new Set(["completed", "failed", "stopped"]);
const ANSWER_DELIVERY_OUTCOMES = new Set([
    "delivered",
    "partial",
    "failed",
    "suppressed",
    "not-attempted",
]);
const CONTROL_IDEMPOTENCY_KEY = /^[^\p{Cc}]{1,256}$/u;
const SESSION_LIST_PARAM_KEYS = new Set([
    "activeMinutes",
    "agentId",
    "archived",
    "boardFace",
    "configuredAgentsOnly",
    "creatorId",
    "hasBoard",
    "includeDerivedTitles",
    "includeGlobal",
    "includeLastMessage",
    "includePeople",
    "includeUnknown",
    "involvingMe",
    "involvingProfileId",
    "label",
    "limit",
    "offset",
    "ownerFirst",
    "ownerId",
    "requireLastInteraction",
    "search",
    "sortBy",
    "spawnedBy",
]);
const SESSION_LIST_SYNTHESIS_FILTERS = new Set([
    "boardFace",
    "creatorId",
    "includePeople",
    "involvingMe",
    "involvingProfileId",
    "label",
    "ownerId",
    "spawnedBy",
]);
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
}
function nonBlank(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function durableControlRunId(value) {
    return nonBlank(value) && value === value.trim() && CONTROL_IDEMPOTENCY_KEY.test(value)
        ? value
        : null;
}
function safeInteger(value, minimum, maximum) {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function optionalBoolean(value) {
    return value === undefined || typeof value === "boolean";
}
function optionalNonBlank(value) {
    return value === undefined || nonBlank(value);
}
function optionalSafeInteger(value, minimum) {
    return value === undefined || safeInteger(value, minimum, Number.MAX_SAFE_INTEGER);
}
function optionalString(value) {
    return value === undefined || typeof value === "string";
}
function optionalBoundedNonBlank(value, maximum) {
    if (value === undefined)
        return true;
    return nonBlank(value) && value.length <= maximum;
}
function optionalChoice(value, choices) {
    return value === undefined || choices.includes(value);
}
function validSessionsListParams(params, limit, offset, activeMinutes) {
    return [
        optionalSafeInteger(limit, 1),
        safeInteger(offset, 0, Number.MAX_SAFE_INTEGER),
        optionalSafeInteger(activeMinutes, 1),
        ...[
            params.requireLastInteraction,
            params.includeGlobal,
            params.includeUnknown,
            params.configuredAgentsOnly,
            params.includeDerivedTitles,
            params.includeLastMessage,
            params.includePeople,
            params.ownerFirst,
            params.involvingMe,
            params.hasBoard,
        ].map(optionalBoolean),
        optionalBoundedNonBlank(params.label, 512),
        ...[
            params.creatorId,
            params.ownerId,
            params.involvingProfileId,
            params.spawnedBy,
            params.agentId,
        ].map(optionalNonBlank),
        optionalString(params.search),
        optionalChoice(params.boardFace, ["chat", "dashboard"]),
        optionalChoice(params.sortBy, ["updatedAt", "lastInteractionAt"]),
        optionalChoice(params.archived, [true, false, "all"]),
    ].every(Boolean);
}
function normalizedHistoryPost(post) {
    return post.type === "" &&
        safeInteger(post.update_at, 0, Number.MAX_SAFE_INTEGER) &&
        safeInteger(post.edit_at, 0, Number.MAX_SAFE_INTEGER) &&
        safeInteger(post.delete_at, 0, Number.MAX_SAFE_INTEGER) &&
        typeof post.pending_post_id === "string" &&
        Array.isArray(post.file_ids) &&
        post.file_ids.every((id) => MATTERMOST_ID.test(id)) &&
        record(post.props) !== null;
}
function sessionsListParams(params) {
    if (Object.keys(params).some((key) => !SESSION_LIST_PARAM_KEYS.has(key)))
        return null;
    const limit = params.limit === undefined ? undefined : params.limit;
    const offset = params.offset === undefined ? 0 : params.offset;
    const activeMinutes = params.activeMinutes === undefined ? undefined : params.activeMinutes;
    if (!validSessionsListParams(params, limit, offset, activeMinutes))
        return null;
    const synthesize = params.hasBoard === undefined && [...SESSION_LIST_SYNTHESIS_FILTERS].every((key) => {
        const value = params[key];
        return value === undefined || value === false;
    });
    return {
        ...(activeMinutes === undefined ? {} : { activeMinutes: activeMinutes }),
        ...(typeof params.agentId === "string" ? { agentId: params.agentId } : {}),
        ...(params.archived === undefined ? {} : {
            archived: params.archived,
        }),
        ...(limit === undefined ? {} : { limit: limit }),
        offset: offset,
        ...(typeof params.requireLastInteraction === "boolean" ? {
            requireLastInteraction: params.requireLastInteraction,
        } : {}),
        ...(typeof params.search === "string" ? { search: params.search.trim().toLowerCase() } : {}),
        sortBy: params.sortBy === "lastInteractionAt" ? "lastInteractionAt" : "updatedAt",
        synthesize,
    };
}
function channelTimestamp(value) {
    return safeInteger(value, 0, Number.MAX_SAFE_INTEGER) ? value : null;
}
function isMattermostId(value) {
    return typeof value === "string" && MATTERMOST_ID.test(value);
}
function validChannelMetadataRecord(input) {
    return [
        input.channel.id === input.expectedChannelId,
        isMattermostId(input.channel.team_id),
        MATTERMOST_CHANNEL_TYPE.has(String(input.channel.type)),
        nonBlank(input.channel.name),
        typeof input.channel.display_name === "string",
        input.createAt !== null,
        input.updateAt !== null,
        input.deleteAt !== null,
        input.lastPostAt !== null,
    ].every(Boolean);
}
function mattermostChannelMetadata(value, expectedChannelId) {
    const channel = record(value);
    const createAt = channelTimestamp(channel?.create_at);
    const updateAt = channelTimestamp(channel?.update_at);
    const deleteAt = channelTimestamp(channel?.delete_at);
    const lastPostAt = channelTimestamp(channel?.last_post_at);
    if (!channel || !validChannelMetadataRecord({
        channel,
        expectedChannelId,
        createAt,
        updateAt,
        deleteAt,
        lastPostAt,
    })) {
        throw new ChannelSessionMattermostError("Mattermost channel response was invalid");
    }
    if (createAt === null || updateAt === null || deleteAt === null || lastPostAt === null) {
        throw new ChannelSessionMattermostError("Mattermost channel response was invalid");
    }
    if (deleteAt > 0)
        return null;
    const peerKind = channel.type === "P" ? "group" : "channel";
    return {
        channelId: expectedChannelId,
        displayName: String(channel.display_name).trim() || String(channel.name),
        name: String(channel.name),
        peerKind,
        createdAt: createAt,
        updatedAt: Math.max(createAt, updateAt, lastPostAt),
        ...(lastPostAt > 0 ? { lastInteractionAt: lastPostAt } : {}),
    };
}
function projectedMattermostSession(authorization, metadata) {
    const key = `agent:${authorization.target.agentId}:mattermost:${metadata.peerKind}:${metadata.channelId}`;
    if (!parseChannelScopedMattermostSessionRoute(key)) {
        throw new ChannelSessionMattermostError("Mattermost channel session identity was invalid");
    }
    return {
        key,
        classification: metadata.peerKind,
        agentId: authorization.target.agentId,
        peerKind: metadata.peerKind,
        isMain: false,
        isBackground: false,
        kind: "group",
        displayName: metadata.displayName,
        channel: "mattermost",
        subject: metadata.displayName,
        groupChannel: metadata.name,
        chatType: metadata.peerKind,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        archived: false,
        ...(metadata.lastInteractionAt === undefined ? {} : {
            lastInteractionAt: metadata.lastInteractionAt,
        }),
    };
}
export async function authorizedMattermostSessions(session, authorize, listWorkspaceChannels, signal) {
    const rawCandidates = signal
        ? await listWorkspaceChannels(session.workspaceSlug, signal)
        : await listWorkspaceChannels(session.workspaceSlug);
    signal?.throwIfAborted();
    if (!Array.isArray(rawCandidates)) {
        throw new ChannelSessionMattermostError("Workspace channel directory was invalid");
    }
    const candidates = rawCandidates.map((value) => {
        const candidate = record(value);
        if (!candidate ||
            Object.keys(candidate).some((key) => key !== "channelId") ||
            !MATTERMOST_ID.test(typeof candidate.channelId === "string" ? candidate.channelId : "")) {
            throw new ChannelSessionMattermostError("Workspace channel directory was invalid");
        }
        return { channelId: candidate.channelId };
    });
    if (new Set(candidates.map(({ channelId }) => channelId)).size !== candidates.length) {
        throw new ChannelSessionMattermostError("Workspace channel directory was ambiguous");
    }
    const projectCandidate = async ({ channelId }) => {
        const authorization = await authorize(session.uid, channelId, session.workspaceSlug, {
            requireActiveLedger: true,
            ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        if (!authorization || authorization.forbidden)
            return null;
        if (authorization.target.workspaceSlug !== session.workspaceSlug ||
            !MATTERMOST_ID.test(authorization.callerMmUserId)) {
            throw new ChannelSessionMattermostError("Mattermost channel authorization was invalid");
        }
        const metadata = mattermostChannelMetadata(await authorization.client.getJson(["channels", channelId]), channelId);
        return metadata ? projectedMattermostSession(authorization, metadata) : null;
    };
    const projected = [];
    for (let offset = 0; offset < candidates.length; offset += SESSION_DISCOVERY_CONCURRENCY) {
        signal?.throwIfAborted();
        projected.push(...await Promise.all(candidates.slice(offset, offset + SESSION_DISCOVERY_CONCURRENCY).map(projectCandidate)));
        signal?.throwIfAborted();
    }
    return projected.filter((row) => row !== null);
}
function sessionMatchesRefreshedFilters(row, params) {
    if (params.archived !== undefined &&
        params.archived !== "all" &&
        row.archived !== params.archived)
        return false;
    if (params.agentId !== undefined && row.agentId !== params.agentId)
        return false;
    if (params.requireLastInteraction === true && row.lastInteractionAt === undefined)
        return false;
    if (params.activeMinutes !== undefined &&
        row.updatedAt < Date.now() - params.activeMinutes * 60_000)
        return false;
    if (params.search) {
        const fields = [row.key, row.displayName, row.subject, row.groupChannel, row.channel];
        if (!fields.some((value) => typeof value === "string" && value.toLowerCase().includes(params.search))) {
            return false;
        }
    }
    return true;
}
function sessionSortTimestamp(row, field) {
    const value = row[field];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function looksMattermostScopedSessionKey(key) {
    const parts = key.split(":");
    return parts[0] === "agent" && parts[2] === "mattermost";
}
function isNativeMattermostSessionKey(key) {
    const route = parseMattermostSessionRoute(key);
    if (!route)
        return false;
    if (route.threadRootPostId !== undefined) {
        return parseThreadedMattermostSessionRoute(key) !== null;
    }
    return route.peerKind === "direct" &&
        MATTERMOST_ID.test(route.primaryChannelId) &&
        parseAgentId(route.agentId).kind !== "unknown";
}
function compareProjectedSessions(first, second, sortBy) {
    if (sortBy === "updatedAt") {
        const firstPinnedAt = sessionSortTimestamp(first, "pinnedAt");
        const secondPinnedAt = sessionSortTimestamp(second, "pinnedAt");
        if (firstPinnedAt !== secondPinnedAt)
            return secondPinnedAt - firstPinnedAt;
    }
    return sessionSortTimestamp(second, sortBy) - sessionSortTimestamp(first, sortBy) ||
        String(first.key).localeCompare(String(second.key));
}
function invalidSessionsListUpstream(frame) {
    return {
        type: "res",
        id: frame.id,
        ok: false,
        error: {
            code: "UNAVAILABLE",
            message: "Mattermost channel is temporarily unavailable",
        },
    };
}
function completeSessionsListPayload(payload) {
    const nativeOffset = payload.offset === undefined ? 0 : payload.offset;
    return [
        safeInteger(payload.count, 0, SESSION_LIST_SOURCE_LIMIT),
        Array.isArray(payload.sessions),
        Array.isArray(payload.sessions) && payload.count === payload.sessions.length,
        safeInteger(nativeOffset, 0, Number.MAX_SAFE_INTEGER),
        nativeOffset === 0,
        payload.hasMore === false,
        payload.nextOffset === null,
        payload.totalCount === undefined || payload.totalCount === payload.count,
    ].every(Boolean);
}
function nativeSessionRows(values) {
    const seen = new Set();
    const rows = [];
    for (const value of values) {
        const row = record(value);
        if (!row || !nonBlank(row.key) || seen.has(row.key))
            return null;
        seen.add(row.key);
        rows.push(row);
    }
    return rows;
}
function mergeAuthorizedSessions(nativeRows, authorizedRows, params) {
    const authorizedByKey = new Map(authorizedRows.map((row) => [row.key, row]));
    if (authorizedByKey.size !== authorizedRows.length)
        return null;
    const sessions = [];
    for (const native of nativeRows) {
        const route = parseChannelScopedMattermostSessionRoute(native.key);
        if (!route) {
            if (!looksMattermostScopedSessionKey(native.key) || isNativeMattermostSessionKey(native.key)) {
                sessions.push(native);
            }
            continue;
        }
        const authorizedRow = authorizedByKey.get(native.key);
        if (!authorizedRow)
            continue;
        const refreshed = { ...native, ...authorizedRow };
        if (authorizedRow.lastInteractionAt === undefined)
            delete refreshed.lastInteractionAt;
        if (sessionMatchesRefreshedFilters(refreshed, params))
            sessions.push(refreshed);
        authorizedByKey.delete(native.key);
    }
    sessions.push(...[...authorizedByKey.values()].filter((row) => params.synthesize && sessionMatchesRefreshedFilters(row, params)));
    sessions.sort((first, second) => compareProjectedSessions(first, second, params.sortBy));
    return sessions;
}
function projectSessionsList(frame, upstream, authorizedRows, params, nativeAgentId) {
    if (upstream.type !== "res" || upstream.ok !== true)
        return upstream;
    const payload = record(upstream.payload);
    if (!payload || !completeSessionsListPayload(payload))
        return invalidSessionsListUpstream(frame);
    const nativeRows = nativeSessionRows(payload.sessions);
    if (!nativeRows)
        return invalidSessionsListUpstream(frame);
    const scopedNativeRows = nativeAgentId ? nativeRows.filter((row) => String(row.key).startsWith(`agent:${nativeAgentId}:`)) : nativeRows;
    const sessions = mergeAuthorizedSessions(scopedNativeRows, authorizedRows, params);
    if (!sessions)
        return invalidSessionsListUpstream(frame);
    const limit = params.limit ?? SESSION_LIST_DEFAULT_LIMIT;
    const page = sessions.slice(params.offset, params.offset + limit);
    const nextOffset = params.offset + page.length;
    const hasMore = nextOffset < sessions.length;
    const projectedPayload = { ...payload };
    delete projectedPayload.totalCount;
    delete projectedPayload.offset;
    return {
        ...upstream,
        payload: {
            ...projectedPayload,
            count: page.length,
            totalCount: sessions.length,
            limitApplied: limit,
            ...(params.offset > 0 ? { offset: params.offset } : {}),
            nextOffset: hasMore ? nextOffset : null,
            hasMore,
            sessions: page,
        },
    };
}
function rpcError(frame, code, message) {
    return {
        kind: "response",
        frame: {
            type: "res",
            id: frame.id,
            ok: false,
            error: { code, message },
        },
    };
}
function rpcSuccess(frame, payload) {
    return {
        kind: "response",
        frame: { type: "res", id: frame.id, ok: true, payload },
    };
}
function answerPart(value, index) {
    const part = record(value);
    if (!part ||
        !MATTERMOST_ID.test(typeof part.postId === "string" ? part.postId : "") ||
        !nonBlank(part.kind) ||
        !ANSWER_PART_KINDS.has(part.kind) ||
        part.index !== index ||
        (part.rootPostId !== undefined && !MATTERMOST_ID.test(String(part.rootPostId))) ||
        (part.threadId !== undefined && !MATTERMOST_ID.test(String(part.threadId))))
        return null;
    return {
        postId: part.postId,
        kind: part.kind,
        index,
        ...(typeof part.rootPostId === "string" ? { rootPostId: part.rootPostId } : {}),
        ...(typeof part.threadId === "string" ? { threadId: part.threadId } : {}),
    };
}
function validAnswerCommitPost(post, channelId, agentMmUserId) {
    return [
        normalizedHistoryPost(post),
        MATTERMOST_ID.test(post.id),
        post.channel_id === channelId,
        post.user_id === agentMmUserId,
        safeInteger(post.create_at, 0, Number.MAX_SAFE_INTEGER),
        post.message === "Answer committed",
        post.edit_at === 0,
        post.delete_at === 0,
        post.file_ids?.length === 0,
    ].every(Boolean);
}
function validAnswerCommitMetadata(octogee, answer, post, channelId, agentId) {
    return [
        octogee.schemaVersion === 3,
        octogee.projectionKind === "run",
        octogee.itemId === "octogee:answer-commit",
        octogee.semanticVersion === 1,
        octogee.kind === "agent.answer-commit",
        octogee.agentId === agentId,
        octogee.conversationId === channelId,
        octogee.mainChannelId === channelId,
        nonBlank(octogee.sessionKey),
        safeInteger(octogee.ordinal, 1, Number.MAX_SAFE_INTEGER),
        nonBlank(octogee.runId),
        nonBlank(octogee.turnId),
        isMattermostId(octogee.mainRootPostId),
        isMattermostId(octogee.inputPostId),
        post.root_id === octogee.mainRootPostId,
        ANSWER_TERMINAL_OUTCOMES.has(String(octogee.status)),
        ANSWER_TERMINAL_OUTCOMES.has(String(answer.terminalOutcome)),
        answer.terminalOutcome === octogee.status,
        ANSWER_DELIVERY_OUTCOMES.has(String(answer.deliveryOutcome)),
        Array.isArray(answer.postIds),
        Array.isArray(answer.parts),
    ].every(Boolean);
}
function validAnswerPartSequence(parts, postIds, mainRootPostId) {
    const uniqueIds = new Set(parts.map((part) => part.postId));
    return [
        postIds.length === parts.length,
        uniqueIds.size === parts.length,
        !postIds.some((postId, index) => postId !== parts[index]?.postId),
        !parts.some((part) => part.rootPostId !== undefined && part.rootPostId !== mainRootPostId ||
            part.threadId !== undefined && part.threadId !== mainRootPostId),
    ].every(Boolean);
}
function validDeliveryPartCount(deliveryOutcome, partCount) {
    const includesParts = deliveryOutcome === "delivered" || deliveryOutcome === "partial";
    return includesParts ? partCount > 0 : partCount === 0;
}
function parseAnswerCommit(post, channelId, agentId, agentMmUserId) {
    const octogee = record(post.props?.octogee);
    const answer = record(octogee?.answer);
    if (!octogee || !answer)
        return null;
    if (!validAnswerCommitPost(post, channelId, agentMmUserId))
        return null;
    if (!validAnswerCommitMetadata(octogee, answer, post, channelId, agentId))
        return null;
    const sessionRoute = parseChannelScopedMattermostSessionRoute(octogee.sessionKey);
    if (!sessionRoute ||
        sessionRoute.agentId !== agentId ||
        sessionRoute.primaryChannelId !== channelId)
        return null;
    const parts = answer.parts.map(answerPart);
    if (parts.some((part) => part === null))
        return null;
    const validParts = parts;
    const postIds = answer.postIds;
    if (!validAnswerPartSequence(validParts, postIds, octogee.mainRootPostId))
        return null;
    const deliveryOutcome = answer.deliveryOutcome;
    if (!validDeliveryPartCount(deliveryOutcome, validParts.length))
        return null;
    return {
        post,
        runId: octogee.runId,
        turnId: octogee.turnId,
        sessionKey: octogee.sessionKey,
        mainRootPostId: octogee.mainRootPostId,
        inputPostId: octogee.inputPostId,
        terminalOutcome: answer.terminalOutcome,
        deliveryOutcome,
        parts: validParts,
    };
}
function canonicalPosts(posts) {
    const byId = new Map();
    for (const post of posts) {
        const current = byId.get(post.id);
        const revision = post.update_at ?? post.create_at;
        const currentRevision = current ? current.update_at ?? current.create_at : -1;
        if (!current || revision > currentRevision)
            byId.set(post.id, post);
    }
    return [...byId.values()];
}
function attachmentText(count, kind) {
    if (count === 0)
        return "";
    if (count === 1)
        return kind ? `[${kind} attachment]` : "[attachment]";
    return kind ? `[${count} ${kind} attachments]` : `[${count} attachments]`;
}
function committedAnswerText(parts, commit) {
    const text = parts.map((part, index) => {
        const attachmentCount = part.file_ids?.length ?? 0;
        const renderedAttachment = attachmentText(attachmentCount, commit.parts[index]?.kind ?? "file");
        return [part.message, renderedAttachment].filter(Boolean).join("\n\n");
    }).filter(Boolean).join("\n\n");
    return text || `[${commit.deliveryOutcome} answer]`;
}
function validPhysicalAnswerPart(input) {
    return [
        normalizedHistoryPost(input.part),
        input.part.user_id === input.agentMmUserId,
        input.part.channel_id === input.channelId,
        input.part.root_id === input.commit.mainRootPostId,
        input.hasContent,
        safeInteger(input.part.create_at, 0, Number.MAX_SAFE_INTEGER),
        input.part.create_at >= input.inputPost.create_at,
        input.part.create_at <= input.commit.post.create_at,
        input.part.edit_at <= input.commit.post.create_at,
        input.part.delete_at === 0,
    ].every(Boolean);
}
function validAnswerPartRunIdentity(octogee, commit, channelId, agentId) {
    return [
        octogee.schemaVersion === 3,
        octogee.projectionKind === "run",
        octogee.conversationId === channelId,
        octogee.turnId === commit.turnId,
        octogee.runId === commit.runId,
        octogee.agentId === agentId,
        octogee.sessionKey === commit.sessionKey,
        octogee.mainChannelId === channelId,
        octogee.mainRootPostId === commit.mainRootPostId,
        octogee.inputPostId === commit.inputPostId,
    ].every(Boolean);
}
function answerPartMatchesCommit(input) {
    const hasContent = nonBlank(input.part.message) || Boolean(input.part.file_ids?.length);
    if (!validPhysicalAnswerPart({
        part: input.part,
        inputPost: input.inputPost,
        commit: input.commit,
        channelId: input.channelId,
        agentMmUserId: input.agentMmUserId,
        hasContent,
    }))
        return false;
    const octogeeValue = input.part.props?.octogee;
    if (octogeeValue === undefined)
        return true;
    const octogee = record(octogeeValue);
    if (!octogee ||
        octogee.itemId !== undefined ||
        octogee.kind !== undefined ||
        octogee.toolCallId !== undefined)
        return false;
    return validAnswerPartRunIdentity(octogee, input.commit, input.channelId, input.agentId);
}
function claimsAnswerCommit(post, octogee) {
    const structured = [
        octogee?.itemId === "octogee:answer-commit",
        octogee?.kind === "agent.answer-commit",
    ].some(Boolean);
    const unstructuredLiteral = [
        post.message === "Answer committed",
        octogee?.itemId === undefined,
        octogee?.kind === undefined,
    ].every(Boolean);
    return [structured, unstructuredLiteral].some(Boolean);
}
function suppressesRawAssistantMetadata(octogee, answerCommitCandidate) {
    return [
        octogee?.projectionKind === "activity",
        octogee?.toolCallId !== undefined,
        !answerCommitCandidate && octogee?.itemId !== undefined,
        !answerCommitCandidate && octogee?.kind !== undefined,
    ].some(Boolean);
}
function rawAssistantText(post) {
    if (!normalizedHistoryPost(post))
        return null;
    const octogee = record(post.props?.octogee);
    if (suppressesRawAssistantMetadata(octogee, claimsAnswerCommit(post, octogee)))
        return null;
    const attachmentCount = post.file_ids?.length ?? 0;
    const text = [post.message, attachmentText(attachmentCount)].filter(Boolean).join("\n\n");
    return nonBlank(text) ? text : null;
}
function humanPostText(post) {
    const attachmentCount = post.file_ids?.length ?? 0;
    return [post.message, attachmentText(attachmentCount)].filter(Boolean).join("\n\n");
}
function inputPostMatchesCommit(inputPost, mainRoot, commit, channelId, agentMmUserId) {
    return Boolean(inputPost &&
        mainRoot &&
        normalizedHistoryPost(inputPost) &&
        normalizedHistoryPost(mainRoot) &&
        inputPost.id === commit.inputPostId &&
        inputPost.channel_id === channelId &&
        inputPost.user_id !== agentMmUserId &&
        mainRoot.id === commit.mainRootPostId &&
        mainRoot.channel_id === channelId &&
        mainRoot.root_id === "" &&
        mainRoot.user_id !== agentMmUserId &&
        safeInteger(inputPost.create_at, 0, Number.MAX_SAFE_INTEGER) &&
        inputPost.create_at <= commit.post.create_at &&
        (inputPost.id === mainRoot.id
            ? inputPost.root_id === ""
            : inputPost.root_id === mainRoot.id));
}
function unresolvedDeliveredCommitPostIds(input) {
    const posts = canonicalPosts(input.posts)
        .filter((post) => post.channel_id === input.channelId && !(post.delete_at && post.delete_at > 0));
    const postIds = new Set(posts.map((post) => post.id));
    const missing = new Set();
    for (const post of posts) {
        const commit = parseAnswerCommit(post, input.channelId, input.agentId, input.agentMmUserId);
        if (!commit || commit.deliveryOutcome !== "delivered")
            continue;
        if (!postIds.has(commit.mainRootPostId))
            missing.add(commit.mainRootPostId);
        if (!postIds.has(commit.inputPostId))
            missing.add(commit.inputPostId);
        for (const part of commit.parts) {
            if (!postIds.has(part.postId))
                missing.add(part.postId);
        }
    }
    return [...missing];
}
function channelProjectionPosts(input) {
    return canonicalPosts(input.posts).filter((post) => post.channel_id === input.channelId && !(post.delete_at && post.delete_at > 0));
}
function projectionRootIds(posts, agentMmUserId) {
    const roots = posts.filter((post) => normalizedHistoryPost(post) && post.root_id === "" &&
        (post.user_id !== agentMmUserId || rawAssistantText(post) !== null));
    return new Set(roots.map((root) => root.id));
}
function humanProjectionMessages(posts, rootIds, agentMmUserId) {
    const inputs = posts.filter((post) => normalizedHistoryPost(post) &&
        post.user_id !== agentMmUserId &&
        (post.root_id === "" || rootIds.has(post.root_id)));
    return inputs.map((inputPost) => {
        const submission = record(inputPost.props?.octogeeControlSubmission);
        const controlRunId = (submission?.userId === inputPost.user_id
            ? durableControlRunId(submission.id)
            : null) ?? durableControlRunId(inputPost.pending_post_id);
        return {
            id: inputPost.id,
            runId: controlRunId ?? inputPost.id,
            idempotencyKey: controlRunId ?? `${inputPost.id}:user`,
            role: "user",
            content: [{ type: "text", text: humanPostText(inputPost) }],
            timestamp: inputPost.create_at,
            senderId: inputPost.user_id,
            ...(inputPost.props && typeof inputPost.props.username === "string"
                ? { senderName: inputPost.props.username }
                : {}),
            turnBoundary: true,
        };
    });
}
function commitsByRun(posts, input) {
    const grouped = new Map();
    for (const post of posts) {
        const commit = parseAnswerCommit(post, input.channelId, input.agentId, input.agentMmUserId);
        if (!commit)
            continue;
        const commits = grouped.get(commit.runId) ?? [];
        commits.push(commit);
        grouped.set(commit.runId, commits);
    }
    return grouped;
}
function boundAnswerCommits(grouped, byId, input) {
    const bound = [];
    for (const [runId, commits] of grouped) {
        if (commits.length !== 1)
            continue;
        const commit = commits[0];
        if (!commit || commit.turnId !== commit.mainRootPostId)
            continue;
        if (!inputPostMatchesCommit(byId.get(commit.inputPostId), byId.get(commit.mainRootPostId), commit, input.channelId, input.agentMmUserId))
            continue;
        bound.push({ runId, commit });
    }
    return bound;
}
function collidingAnswerRuns(commits) {
    const ownersByPost = new Map();
    for (const { runId, commit } of commits) {
        for (const part of commit.parts) {
            const owners = ownersByPost.get(part.postId) ?? new Set();
            owners.add(runId);
            ownersByPost.set(part.postId, owners);
        }
    }
    const collisions = new Set();
    for (const owners of ownersByPost.values()) {
        if (owners.size < 2)
            continue;
        for (const runId of owners)
            collisions.add(runId);
    }
    return collisions;
}
function deliveredAnswers(input) {
    const byInput = new Map();
    const consumedPostIds = new Set();
    const hiddenCommitPostIds = new Set();
    for (const { runId, commit } of input.commits) {
        if (input.collidingRuns.has(runId) || commit.deliveryOutcome === "partial")
            continue;
        if (commit.deliveryOutcome !== "delivered") {
            hiddenCommitPostIds.add(commit.post.id);
            continue;
        }
        const inputPost = input.byId.get(commit.inputPostId);
        if (!inputPost)
            continue;
        const parts = commit.parts.map((part) => input.byId.get(part.postId));
        const invalidPart = parts.some((part) => !part || !answerPartMatchesCommit({
            part,
            inputPost,
            commit,
            channelId: input.projection.channelId,
            agentId: input.projection.agentId,
            agentMmUserId: input.projection.agentMmUserId,
        }));
        if (invalidPart)
            continue;
        hiddenCommitPostIds.add(commit.post.id);
        const exactParts = parts;
        for (const part of exactParts)
            consumedPostIds.add(part.id);
        const answers = byInput.get(commit.inputPostId) ?? [];
        answers.push({ commit, parts: exactParts });
        byInput.set(commit.inputPostId, answers);
    }
    return { byInput, consumedPostIds, hiddenCommitPostIds };
}
function committedAnswerMessages(answersByInput, agentMmUserId) {
    const messages = [];
    for (const answers of answersByInput.values()) {
        answers.sort((first, second) => second.commit.post.create_at - first.commit.post.create_at ||
            second.commit.post.id.localeCompare(first.commit.post.id));
        const latest = answers[0];
        if (!latest)
            continue;
        messages.push({
            id: latest.commit.post.id,
            runId: latest.commit.runId,
            role: "assistant",
            content: [{ type: "text", text: committedAnswerText(latest.parts, latest.commit) }],
            timestamp: Math.max(...latest.parts.map((part) => part.create_at)),
            senderId: agentMmUserId,
        });
    }
    return messages;
}
function rawAssistantMessages(input) {
    const messages = [];
    for (const post of input.posts) {
        if (post.user_id !== input.agentMmUserId)
            continue;
        if ((post.root_id !== "" && !input.rootIds.has(post.root_id)) ||
            input.consumedPostIds.has(post.id) ||
            input.hiddenCommitPostIds.has(post.id))
            continue;
        const text = rawAssistantText(post);
        if (text === null)
            continue;
        const octogee = record(post.props?.octogee);
        messages.push({
            id: post.id,
            runId: nonBlank(octogee?.runId) ? octogee.runId : post.id,
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: post.create_at,
            senderId: input.agentMmUserId,
        });
    }
    return messages;
}
function compareLogicalMessages(first, second) {
    const timestampOrder = first.timestamp - second.timestamp;
    if (timestampOrder !== 0)
        return timestampOrder;
    if (first.role !== second.role)
        return first.role === "user" ? -1 : 1;
    return first.id.localeCompare(second.id);
}
function finalizeProjectedMessages(messages) {
    messages.sort(compareLogicalMessages);
    return messages.map((message, index) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        __openclaw: {
            id: message.id,
            seq: index + 1,
            runId: message.runId,
            ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
            ...(message.senderId ? { senderId: message.senderId } : {}),
            ...(message.senderName ? { senderName: message.senderName } : {}),
            ...(message.turnBoundary ? { turnBoundary: true } : {}),
        },
    }));
}
export function projectMattermostControlMessages(input) {
    const posts = channelProjectionPosts(input);
    const byId = new Map(posts.map((post) => [post.id, post]));
    const rootIds = projectionRootIds(posts, input.agentMmUserId);
    const bound = boundAnswerCommits(commitsByRun(posts, input), byId, input);
    const delivered = deliveredAnswers({
        commits: bound,
        collidingRuns: collidingAnswerRuns(bound),
        byId,
        projection: input,
    });
    return finalizeProjectedMessages([
        ...humanProjectionMessages(posts, rootIds, input.agentMmUserId),
        ...committedAnswerMessages(delivered.byInput, input.agentMmUserId),
        ...rawAssistantMessages({
            posts,
            rootIds,
            consumedPostIds: delivered.consumedPostIds,
            hiddenCommitPostIds: delivered.hiddenCommitPostIds,
            agentMmUserId: input.agentMmUserId,
        }),
    ]);
}
function historyParams(params) {
    if (!nonBlank(params.sessionKey))
        return null;
    const limit = params.limit === undefined ? 800 : params.limit;
    const offset = params.offset === undefined ? 0 : params.offset;
    if (!safeInteger(limit, 1, 1_000) || !safeInteger(offset, 0, Number.MAX_SAFE_INTEGER)) {
        return null;
    }
    if (params.cursor !== undefined || params.messageId !== undefined)
        return null;
    return { sessionKey: params.sessionKey, limit, offset };
}
async function authorized(authorize, session, sessionKey, signal) {
    const route = parseChannelScopedMattermostSessionRoute(sessionKey);
    if (!route)
        return null;
    const authorization = await authorize(session.uid, route.primaryChannelId, session.workspaceSlug, {
        requireActiveLedger: true,
        ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    if (!authorization ||
        authorization.forbidden ||
        authorization.target.workspaceSlug !== session.workspaceSlug ||
        authorization.target.agentId !== route.agentId) {
        throw new ChannelSessionMattermostError("Mattermost channel access denied", 403);
    }
    const metadata = mattermostChannelMetadata(await authorization.client.getJson(["channels", route.primaryChannelId]), route.primaryChannelId);
    signal?.throwIfAborted();
    if (!metadata || metadata.peerKind !== route.peerKind) {
        throw new ChannelSessionMattermostError("Mattermost channel access denied", 403);
    }
    return { route, authorization };
}
function historyNeedsMore(messages, requiredMessages, unresolvedPostIds) {
    return messages.length < requiredMessages || unresolvedPostIds.length > 0;
}
function assertHistoryRecoveryBudget(historyBytes, postCount) {
    if (historyBytes <= MAX_HISTORY_BYTES && postCount <= MAX_HISTORY_POSTS)
        return;
    throw new ChannelSessionMattermostError("Mattermost channel history exceeded its recovery budget");
}
function assertHistoryProjectionBudget(projectionPostVisits) {
    if (projectionPostVisits <= MAX_HISTORY_PROJECTION_POST_VISITS)
        return;
    throw new ChannelSessionMattermostError("Mattermost channel history exceeded its projection budget");
}
function nextHistoryCursor(nextBefore, cursors) {
    if (!nextBefore || cursors.has(nextBefore)) {
        throw new ChannelSessionMattermostError("Mattermost channel history could not be paged safely");
    }
    cursors.add(nextBefore);
    return nextBefore;
}
async function readProjectedHistory(authorization, route, requiredMessages, signal) {
    let before;
    let reachedEnd = false;
    const posts = [];
    const cursors = new Set();
    let messages = [];
    let unresolvedPostIds = [];
    let historyBytes = 0;
    let projectionPostVisits = 0;
    let nextProjectionPostCount = HISTORY_PAGE_SIZE;
    while (!reachedEnd && historyNeedsMore(messages, requiredMessages, unresolvedPostIds)) {
        signal?.throwIfAborted();
        const page = await authorization.client.listChannelPosts(route.primaryChannelId, before, HISTORY_PAGE_SIZE);
        signal?.throwIfAborted();
        const pageBytes = Buffer.byteLength(JSON.stringify(page.posts), "utf8");
        historyBytes += pageBytes;
        assertHistoryRecoveryBudget(historyBytes, posts.length + page.posts.length);
        posts.push(...page.posts);
        reachedEnd = page.reachedEnd;
        if (reachedEnd || posts.length >= nextProjectionPostCount) {
            projectionPostVisits += posts.length;
            assertHistoryProjectionBudget(projectionPostVisits);
            messages = projectMattermostControlMessages({
                posts,
                channelId: route.primaryChannelId,
                agentId: route.agentId,
                agentMmUserId: authorization.target.agentMmUserId,
            });
            unresolvedPostIds = unresolvedDeliveredCommitPostIds({
                posts,
                channelId: route.primaryChannelId,
                agentId: route.agentId,
                agentMmUserId: authorization.target.agentMmUserId,
            });
            nextProjectionPostCount = Math.min(MAX_HISTORY_POSTS, Math.max(posts.length + HISTORY_PAGE_SIZE, posts.length * 2));
        }
        if (reachedEnd || messages.length >= requiredMessages && unresolvedPostIds.length === 0)
            break;
        before = nextHistoryCursor(page.nextBefore, cursors);
    }
    if (unresolvedPostIds.length > 0) {
        throw new ChannelSessionMattermostError("Mattermost channel history did not contain every committed answer post");
    }
    return { messages, reachedEnd };
}
function pageHistory(messages, offset, limit, reachedEnd) {
    const end = Math.max(0, messages.length - offset);
    const start = Math.max(0, end - limit);
    const page = messages.slice(start, end);
    const hasMore = start > 0 || !reachedEnd;
    return {
        messages: page,
        offset,
        ...(hasMore ? { nextOffset: offset + page.length } : {}),
        hasMore,
        ...(reachedEnd ? { totalMessages: messages.length } : {}),
        ...(!hasMore ? { completeSnapshot: true } : {}),
    };
}
function projectUpstreamHistory(frame, history) {
    if (frame.type !== "res" || frame.ok !== true)
        return frame;
    const payload = record(frame.payload);
    if (!payload)
        return frame;
    const projected = { ...payload, ...history };
    delete projected.deltaCursor;
    return { ...frame, payload: projected };
}
function prepareSessionSubscription(frame) {
    if (!sessionsListParams(frame.params)) {
        return rpcError(frame, "INVALID_REQUEST", "Unsupported Mattermost session subscription request");
    }
    return {
        kind: "upstream",
        upstreamParams: {},
        project: (upstream) => {
            const payload = record(upstream.payload);
            if (upstream.type !== "res" || upstream.ok !== true || !payload)
                return upstream;
            const projected = { ...payload };
            delete projected.list;
            return { ...upstream, payload: projected };
        },
    };
}
async function prepareSessionsList(frame, session, authorize, listWorkspaceChannels, { signal, perUserIdentity = false }) {
    const params = sessionsListParams(frame.params);
    if (!params) {
        if (perUserIdentity)
            return null;
        return rpcError(frame, "INVALID_REQUEST", "Unsupported Mattermost session list request");
    }
    if (perUserIdentity)
        params.synthesize = false;
    const authorizedRows = await authorizedMattermostSessions(session, authorize, listWorkspaceChannels, signal);
    return {
        kind: "upstream",
        upstreamParams: {
            ...frame.params,
            offset: 0,
            limit: SESSION_LIST_SOURCE_LIMIT,
        },
        project: (upstream) => projectSessionsList(frame, upstream, authorizedRows, params, undefined),
    };
}
async function attributeChatProfiles(page, session, { channelId, agentId }, resolve, signal) {
    if (!resolve)
        return;
    const accountId = mattermostAccountIdForAgentId(agentId);
    if (!accountId)
        throw new Error("Mattermost channel agent has no managed account");
    const authors = new Map();
    for (const message of page.messages) {
        if (message.role === "user" && message.__openclaw.senderId)
            authors.set(message.__openclaw.senderId, message);
    }
    const entries = [...authors.entries()];
    const profiles = new Map();
    signal?.throwIfAborted();
    await Promise.all(entries.map(async ([mmId, message]) => {
        const profile = await resolve(session, { channelId, postId: message.__openclaw.id });
        if (profile && profile.mattermostUserId !== mmId)
            throw new Error("Chat profile author mismatch");
        profiles.set(mmId, profile);
    }));
    signal?.throwIfAborted();
    for (const message of page.messages) {
        const meta = message.__openclaw;
        if (message.role === "assistant") {
            delete meta.senderId;
            delete meta.senderName;
            continue;
        }
        const profile = profiles.get(meta.senderId ?? "");
        if (!profile) {
            meta.senderName = "Mattermost user";
            continue;
        }
        meta.senderObservation = {
            type: "observation", pluginId: "mattermost", accountId, senderKind: "unknown", id: profile.mattermostUserId,
        };
        meta.senderId = profile.profileId;
        meta.senderIdentity = { type: "profile", id: profile.profileId };
        meta.senderName = profile.username;
        meta.senderUsername = profile.username;
        if (profile.avatarUrl)
            meta.senderProfileAvatarUrl = profile.avatarUrl;
    }
}
async function prepareHistory(frame, session, authorize, resolveChatProfile, { signal, onStage }) {
    const params = historyParams(frame.params);
    const sessionKey = typeof frame.params.sessionKey === "string"
        ? frame.params.sessionKey
        : "";
    const channelRoute = parseChannelScopedMattermostSessionRoute(sessionKey);
    const nativeRoute = isNativeMattermostSessionKey(sessionKey);
    if (!params) {
        return looksMattermostScopedSessionKey(sessionKey) && !nativeRoute
            ? rpcError(frame, "INVALID_REQUEST", "Unsupported Mattermost channel history request")
            : null;
    }
    if (!channelRoute) {
        return nativeRoute || !looksMattermostScopedSessionKey(sessionKey)
            ? null
            : rpcError(frame, "INVALID_REQUEST", "Unsupported Mattermost channel history request");
    }
    onStage("authorization");
    const access = await authorized(authorize, session, params.sessionKey, signal);
    if (!access) {
        return rpcError(frame, "INVALID_REQUEST", "Unsupported Mattermost channel history request");
    }
    if (frame.params.agentId !== undefined && frame.params.agentId !== access.route.agentId) {
        return rpcError(frame, "INVALID_REQUEST", "Mattermost channel Agent does not match the session");
    }
    const required = Math.min(MAX_HISTORY_POSTS, params.offset + params.limit);
    onStage("history");
    const history = await readProjectedHistory(access.authorization, access.route, required, signal);
    if (params.offset >= history.messages.length && !history.reachedEnd) {
        return rpcError(frame, "UNAVAILABLE", "Mattermost channel history exceeds the recovery window");
    }
    const page = pageHistory(history.messages, params.offset, params.limit, history.reachedEnd);
    onStage("profiles");
    await attributeChatProfiles(page, session, {
        channelId: access.route.primaryChannelId,
        agentId: access.authorization.target.agentId,
    }, resolveChatProfile, signal);
    return {
        kind: "upstream",
        project: (upstream) => projectUpstreamHistory(upstream, page),
    };
}
function validSendMessage(value) {
    if (typeof value !== "string")
        return false;
    return Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES;
}
function validSendParams(params, agentId, runId) {
    return [
        validSendMessage(params.message),
        runId !== null,
        params.deliver === undefined || params.deliver === false,
        params.agentId === undefined || params.agentId === agentId,
        params.intent === undefined,
        params.queueMode === undefined,
        params.replyToId === undefined,
    ].every(Boolean);
}
function sendAttachments(value, allowAttachments) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 8 || (!allowAttachments && value.length > 0))
        return null;
    const files = [];
    let size = 0;
    for (const raw of value) {
        const file = record(raw);
        if (!validSendAttachment(file))
            return null;
        const bytes = Buffer.from(file.content, 'base64');
        size += bytes.length;
        if (!bytes.length || bytes.toString('base64') !== file.content || size > 16 * 1024 * 1024)
            return null;
        files.push({ fileName: file.fileName, mimeType: file.mimeType, bytes });
    }
    return files;
}
function validCreatedPost(created, channelId, callerMmUserId) {
    if (!created)
        return false;
    return [
        isMattermostId(created.id),
        created.channel_id === channelId,
        created.user_id === callerMmUserId,
        created.root_id === "",
    ].every(Boolean);
}
async function prepareSend(frame, session, authorize, allowAttachments, signal) {
    const { params } = frame;
    if (!nonBlank(params.sessionKey))
        return null;
    const channelRoute = parseChannelScopedMattermostSessionRoute(params.sessionKey);
    const nativeRoute = isNativeMattermostSessionKey(params.sessionKey);
    if (!channelRoute) {
        if (nativeRoute || !looksMattermostScopedSessionKey(params.sessionKey))
            return null;
        return rpcError(frame, "INVALID_REQUEST", "Unsupported Mattermost channel send request");
    }
    const access = await authorized(authorize, session, params.sessionKey, signal);
    if (!access) {
        return rpcError(frame, "INVALID_REQUEST", "Unsupported Mattermost channel send request");
    }
    const runId = durableControlRunId(params.idempotencyKey);
    if (!validSendParams(params, access.route.agentId, runId)) {
        return rpcError(frame, "INVALID_REQUEST", "Unsupported Mattermost channel send request");
    }
    const attachments = sendAttachments(params.attachments, allowAttachments);
    if (!attachments) {
        return rpcError(frame, "INVALID_REQUEST", "Invalid Mattermost channel attachments");
    }
    const message = params.message;
    if (!message.trim() && attachments.length === 0) {
        return rpcError(frame, "INVALID_REQUEST", "Mattermost channel messages cannot be empty");
    }
    const fileIds = await uploadSendAttachments(access, attachments);
    const createdValue = await access.authorization.client.postJson(["posts"], {
        channel_id: access.route.primaryChannelId,
        message,
        pending_post_id: runId,
        ...(fileIds.length ? { file_ids: fileIds } : {}),
        props: { octogeeControlSubmission: { id: runId, userId: access.authorization.callerMmUserId } },
    });
    const created = record(createdValue);
    if (!validCreatedPost(created, access.route.primaryChannelId, access.authorization.callerMmUserId)) {
        throw new ChannelSessionMattermostError("Mattermost channel post response was invalid");
    }
    return rpcSuccess(frame, { runId, status: "ok" });
}
function unavailableResponse(frame, error) {
    const denied = error instanceof ChannelSessionMattermostError && error.status === 403;
    return rpcError(frame, denied ? "FORBIDDEN" : "UNAVAILABLE", denied ? "Mattermost channel access denied" : "Mattermost channel is temporarily unavailable");
}
function initialRequestStage(method) {
    if (method === "sessions.list")
        return "session-list";
    if (method === "chat.send")
        return "send";
    return "history";
}
function watchPreparedHistory(history, frame, broker) {
    const route = parseChannelScopedMattermostSessionRoute(frame.params.sessionKey);
    if (history && route && (history.kind === "upstream" || history.frame.ok === true)) {
        history.watch = {
            sessionKey: frame.params.sessionKey,
            agentId: route.agentId,
            run: (onChange, watchSignal) => broker.watchChannel(route.primaryChannelId, route.agentId, onChange, watchSignal),
        };
    }
}
export function createMattermostControlChat(options = {}) {
    return {
        async prepare(frame, session, signal) {
            const broker = createBrokeredMattermostAccess(session);
            const authorize = options.authorize ?? broker.authorize;
            const listWorkspaceChannels = options.listWorkspaceChannels ?? broker.listWorkspaceChannels;
            if (!["sessions.subscribe", "sessions.list", "chat.history", "chat.startup", "chat.send"].includes(frame.method))
                return null;
            const startedAt = performance.now();
            let stage = initialRequestStage(frame.method);
            try {
                if (frame.method === "sessions.subscribe")
                    return options.perUserIdentity ? null : prepareSessionSubscription(frame);
                if (frame.method === "sessions.list") {
                    return await prepareSessionsList(frame, session, authorize, listWorkspaceChannels, { signal, perUserIdentity: options.perUserIdentity });
                }
                if (frame.method === "chat.send")
                    return await prepareSend(frame, session, authorize, options.allowAttachments === true, signal);
                const history = await prepareHistory(frame, session, authorize, options.resolveChatProfile, {
                    signal, onStage: (next) => { stage = next; },
                });
                watchPreparedHistory(history, frame, broker);
                return history;
            }
            catch (error) {
                if (signal?.aborted)
                    throw signal.reason;
                logger.warn("Mattermost Dashboard request failed", {
                    gatewayId: session.gatewayId, method: frame.method, stage,
                    failure: error instanceof Error ? error.name : "unknown",
                    ...(error instanceof ChannelSessionMattermostError && error.status !== undefined ? { status: error.status } : {}),
                    durationMs: Math.round(performance.now() - startedAt),
                });
                return unavailableResponse(frame, error);
            }
        },
    };
}
function validSendAttachment(file) {
    return file !== null && [
        ['image', 'file', 'audio'].includes(String(file.type)),
        typeof file.fileName === 'string' && /^[^/\\\p{Cc}]{1,128}$/u.test(file.fileName) && !['.', '..'].includes(file.fileName),
        typeof file.mimeType === 'string' && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/iu.test(file.mimeType) && file.mimeType.length <= 128,
        typeof file.content === 'string' && file.content.length <= 24 * 1024 * 1024,
    ].every(Boolean);
}
async function uploadSendAttachments(access, attachments) {
    let fileIds = [];
    if (attachments.length) {
        const uploaded = record(await access.authorization.client.uploadFiles(access.route.primaryChannelId, attachments));
        const infos = uploaded?.file_infos;
        if (!Array.isArray(infos) || infos.length !== attachments.length || infos.some(info => !isMattermostId(info?.id) ||
            info.user_id !== access.authorization.callerMmUserId || info.channel_id !== access.route.primaryChannelId))
            throw new ChannelSessionMattermostError('Mattermost upload response was invalid');
        fileIds = infos.map(info => info.id);
    }
    return fileIds;
}
