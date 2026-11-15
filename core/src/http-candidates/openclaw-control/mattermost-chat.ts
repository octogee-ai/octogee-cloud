import {
  parseChannelScopedMattermostSessionRoute,
  parseMattermostSessionRoute,
  parseThreadedMattermostSessionRoute,
} from "@octogee/shared/types/mattermost-session-route";
import { parseAgentId, mattermostAccountIdForAgentId } from "@octogee/shared/types/identity";

import {
  type authorizeChannel,
  type listWorkspaceChannelCandidates,
  type AuthorizedChannel,
  type WorkspaceChannelCandidate,
} from "../../channels/channel-session-authorization.js";
import {
  ChannelSessionMattermostError,
  type MattermostModelPost,
} from "../../channels/channel-session-model-control.js";
import type { OpenClawControlProxyIdentity } from "./proxy-identity.js";
import type { OpenClawControlSession } from "./session.js";
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

export interface OpenClawControlRequestFrame extends Record<string, unknown> {
  type?: unknown;
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface MattermostChannelWatch {
  sessionKey: string;
  agentId: string;
  run(onChange: () => void, signal: AbortSignal): Promise<void>;
}

export type MattermostChatPreparation =
  | { kind: "response"; frame: Record<string, unknown>; watch?: MattermostChannelWatch }
  | {
      kind: "upstream";
      upstreamParams?: Record<string, unknown>;
      project(frame: Record<string, unknown>): Record<string, unknown>;
      watch?: MattermostChannelWatch;
    };

export interface MattermostControlChat {
  prepare(
    frame: OpenClawControlRequestFrame,
    session: OpenClawControlSession,
    signal?: AbortSignal,
  ): Promise<MattermostChatPreparation | null>;
}

interface ProjectedMessage {
  role: "user" | "assistant";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
  __openclaw: {
    id: string;
    seq: number;
    runId: string;
    idempotencyKey?: string;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderIdentity?: { type: "profile"; id: string };
    senderObservation?: {
      type: "observation"; pluginId: "mattermost"; accountId: string; senderKind: "unknown"; id: string;
    };
    senderProfileAvatarUrl?: string;
    turnBoundary?: true;
  };
}

interface ProjectedHistory {
  messages: ProjectedMessage[];
  offset: number;
  nextOffset?: number;
  hasMore: boolean;
  totalMessages?: number;
  completeSnapshot?: true;
}

interface SessionsListProjectionParams {
  activeMinutes?: number;
  agentId?: string;
  archived?: boolean | "all";
  limit?: number;
  offset: number;
  requireLastInteraction?: boolean;
  search?: string;
  sortBy: "updatedAt" | "lastInteractionAt";
  synthesize: boolean;
}

interface MattermostChannelMetadata {
  channelId: string;
  displayName: string;
  name: string;
  peerKind: "channel" | "group";
  createdAt: number;
  updatedAt: number;
  lastInteractionAt?: number;
}

interface ProjectedMattermostSession extends Record<string, unknown> {
  key: string;
  agentId: string;
  updatedAt: number;
  lastInteractionAt?: number;
}

interface AnswerPart {
  postId: string;
  kind: string;
  index: number;
  rootPostId?: string;
  threadId?: string;
}

interface AnswerCommit {
  post: MattermostModelPost;
  runId: string;
  turnId: string;
  sessionKey: string;
  mainRootPostId: string;
  inputPostId: string;
  terminalOutcome: "completed" | "failed" | "stopped";
  deliveryOutcome: "delivered" | "partial" | "failed" | "suppressed" | "not-attempted";
  parts: AnswerPart[];
}

interface ControlMessageProjectionInput {
  posts: readonly MattermostModelPost[];
  channelId: string;
  agentId: string;
  agentMmUserId: string;
}

type LogicalProjectedMessage = Omit<ProjectedMessage, "__openclaw"> & {
  id: string;
  runId: string;
  idempotencyKey?: string;
  senderId?: string;
  senderName?: string;
  turnBoundary?: true;
};

interface BoundAnswerCommit {
  runId: string;
  commit: AnswerCommit;
}

interface DeliveredAnswer {
  commit: AnswerCommit;
  parts: MattermostModelPost[];
}

type Authorize = typeof authorizeChannel;
type ListWorkspaceChannels = typeof listWorkspaceChannelCandidates;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function durableControlRunId(value: unknown): string | null {
  return nonBlank(value) && value === value.trim() && CONTROL_IDEMPOTENCY_KEY.test(value)
    ? value
    : null;
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function optionalNonBlank(value: unknown): boolean {
  return value === undefined || nonBlank(value);
}

function optionalSafeInteger(value: unknown, minimum: number): boolean {
  return value === undefined || safeInteger(value, minimum, Number.MAX_SAFE_INTEGER);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBoundedNonBlank(value: unknown, maximum: number): boolean {
  if (value === undefined) return true;
  return nonBlank(value) && value.length <= maximum;
}

function optionalChoice(value: unknown, choices: readonly unknown[]): boolean {
  return value === undefined || choices.includes(value);
}

function validSessionsListParams(
  params: Record<string, unknown>,
  limit: unknown,
  offset: unknown,
  activeMinutes: unknown,
): boolean {
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

function normalizedHistoryPost(post: MattermostModelPost): boolean {
  return post.type === "" &&
    safeInteger(post.update_at, 0, Number.MAX_SAFE_INTEGER) &&
    safeInteger(post.edit_at, 0, Number.MAX_SAFE_INTEGER) &&
    safeInteger(post.delete_at, 0, Number.MAX_SAFE_INTEGER) &&
    typeof post.pending_post_id === "string" &&
    Array.isArray(post.file_ids) &&
    post.file_ids.every((id) => MATTERMOST_ID.test(id)) &&
    record(post.props) !== null;
}

function sessionsListParams(
  params: Record<string, unknown>,
): SessionsListProjectionParams | null {
  if (Object.keys(params).some((key) => !SESSION_LIST_PARAM_KEYS.has(key))) return null;
  const limit = params.limit === undefined ? undefined : params.limit;
  const offset = params.offset === undefined ? 0 : params.offset;
  const activeMinutes = params.activeMinutes === undefined ? undefined : params.activeMinutes;
  if (!validSessionsListParams(params, limit, offset, activeMinutes)) return null;
  const synthesize = params.hasBoard === undefined && [...SESSION_LIST_SYNTHESIS_FILTERS].every((key) => {
    const value = params[key];
    return value === undefined || value === false;
  });
  return {
    ...(activeMinutes === undefined ? {} : { activeMinutes: activeMinutes as number }),
    ...(typeof params.agentId === "string" ? { agentId: params.agentId } : {}),
    ...(params.archived === undefined ? {} : {
      archived: params.archived as boolean | "all",
    }),
    ...(limit === undefined ? {} : { limit: limit as number }),
    offset: offset as number,
    ...(typeof params.requireLastInteraction === "boolean" ? {
      requireLastInteraction: params.requireLastInteraction,
    } : {}),
    ...(typeof params.search === "string" ? { search: params.search.trim().toLowerCase() } : {}),
    sortBy: params.sortBy === "lastInteractionAt" ? "lastInteractionAt" : "updatedAt",
    synthesize,
  };
}

function channelTimestamp(value: unknown): number | null {
  return safeInteger(value, 0, Number.MAX_SAFE_INTEGER) ? value : null;
}

function isMattermostId(value: unknown): value is string {
  return typeof value === "string" && MATTERMOST_ID.test(value);
}

function validChannelMetadataRecord(input: {
  channel: Record<string, unknown>;
  expectedChannelId: string;
  createAt: number | null;
  updateAt: number | null;
  deleteAt: number | null;
  lastPostAt: number | null;
}): boolean {
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

function mattermostChannelMetadata(
  value: unknown,
  expectedChannelId: string,
): MattermostChannelMetadata | null {
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
  if (deleteAt > 0) return null;
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

function projectedMattermostSession(
  authorization: AuthorizedChannel,
  metadata: MattermostChannelMetadata,
): ProjectedMattermostSession {
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

export async function authorizedMattermostSessions(
  session: OpenClawControlSession,
  authorize: Authorize,
  listWorkspaceChannels: ListWorkspaceChannels,
  signal?: AbortSignal,
): Promise<ProjectedMattermostSession[]> {
  const rawCandidates: unknown = signal
    ? await listWorkspaceChannels(session.workspaceSlug, signal)
    : await listWorkspaceChannels(session.workspaceSlug);
  signal?.throwIfAborted();
  if (!Array.isArray(rawCandidates)) {
    throw new ChannelSessionMattermostError("Workspace channel directory was invalid");
  }
  const candidates = rawCandidates.map((value): WorkspaceChannelCandidate => {
    const candidate = record(value);
    if (
      !candidate ||
      Object.keys(candidate).some((key) => key !== "channelId") ||
      !MATTERMOST_ID.test(typeof candidate.channelId === "string" ? candidate.channelId : "")
    ) {
      throw new ChannelSessionMattermostError("Workspace channel directory was invalid");
    }
    return { channelId: candidate.channelId as string };
  });
  if (new Set(candidates.map(({ channelId }) => channelId)).size !== candidates.length) {
    throw new ChannelSessionMattermostError("Workspace channel directory was ambiguous");
  }
  const projectCandidate = async ({ channelId }: WorkspaceChannelCandidate) => {
    const authorization = await authorize(session.uid, channelId, session.workspaceSlug, {
      requireActiveLedger: true,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    if (!authorization || authorization.forbidden) return null;
    if (
      authorization.target.workspaceSlug !== session.workspaceSlug ||
      !MATTERMOST_ID.test(authorization.callerMmUserId)
    ) {
      throw new ChannelSessionMattermostError("Mattermost channel authorization was invalid");
    }
    const metadata = mattermostChannelMetadata(
      await authorization.client.getJson(["channels", channelId]),
      channelId,
    );
    return metadata ? projectedMattermostSession(authorization, metadata) : null;
  };
  const projected: Array<ProjectedMattermostSession | null> = [];
  for (let offset = 0; offset < candidates.length; offset += SESSION_DISCOVERY_CONCURRENCY) {
    signal?.throwIfAborted();
    projected.push(...await Promise.all(
      candidates.slice(offset, offset + SESSION_DISCOVERY_CONCURRENCY).map(projectCandidate),
    ));
    signal?.throwIfAborted();
  }
  return projected.filter((row): row is ProjectedMattermostSession => row !== null);
}

function sessionMatchesRefreshedFilters(
  row: ProjectedMattermostSession,
  params: SessionsListProjectionParams,
): boolean {
  if (
    params.archived !== undefined &&
    params.archived !== "all" &&
    row.archived !== params.archived
  ) return false;
  if (params.agentId !== undefined && row.agentId !== params.agentId) return false;
  if (params.requireLastInteraction === true && row.lastInteractionAt === undefined) return false;
  if (
    params.activeMinutes !== undefined &&
    row.updatedAt < Date.now() - params.activeMinutes * 60_000
  ) return false;
  if (params.search) {
    const fields = [row.key, row.displayName, row.subject, row.groupChannel, row.channel];
    if (!fields.some((value) => typeof value === "string" && value.toLowerCase().includes(params.search!))) {
      return false;
    }
  }
  return true;
}

function sessionSortTimestamp(
  row: Record<string, unknown>,
  field: SessionsListProjectionParams["sortBy"] | "pinnedAt",
): number {
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function looksMattermostScopedSessionKey(key: string): boolean {
  const parts = key.split(":");
  return parts[0] === "agent" && parts[2] === "mattermost";
}

function isNativeMattermostSessionKey(key: string): boolean {
  const route = parseMattermostSessionRoute(key);
  if (!route) return false;
  if (route.threadRootPostId !== undefined) {
    return parseThreadedMattermostSessionRoute(key) !== null;
  }
  return route.peerKind === "direct" &&
    MATTERMOST_ID.test(route.primaryChannelId) &&
    parseAgentId(route.agentId).kind !== "unknown";
}

function compareProjectedSessions(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  sortBy: SessionsListProjectionParams["sortBy"],
): number {
  if (sortBy === "updatedAt") {
    const firstPinnedAt = sessionSortTimestamp(first, "pinnedAt");
    const secondPinnedAt = sessionSortTimestamp(second, "pinnedAt");
    if (firstPinnedAt !== secondPinnedAt) return secondPinnedAt - firstPinnedAt;
  }
  return sessionSortTimestamp(second, sortBy) - sessionSortTimestamp(first, sortBy) ||
    String(first.key).localeCompare(String(second.key));
}

function invalidSessionsListUpstream(frame: OpenClawControlRequestFrame): Record<string, unknown> {
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

interface NativeSessionRow extends Record<string, unknown> {
  key: string;
}

function completeSessionsListPayload(payload: Record<string, unknown>): boolean {
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

function nativeSessionRows(values: readonly unknown[]): NativeSessionRow[] | null {
  const seen = new Set<string>();
  const rows: NativeSessionRow[] = [];
  for (const value of values) {
    const row = record(value);
    if (!row || !nonBlank(row.key) || seen.has(row.key)) return null;
    seen.add(row.key);
    rows.push(row as NativeSessionRow);
  }
  return rows;
}

function mergeAuthorizedSessions(
  nativeRows: readonly NativeSessionRow[],
  authorizedRows: readonly ProjectedMattermostSession[],
  params: SessionsListProjectionParams,
): Array<Record<string, unknown>> | null {
  const authorizedByKey = new Map(authorizedRows.map((row) => [row.key, row]));
  if (authorizedByKey.size !== authorizedRows.length) return null;
  const sessions: Array<Record<string, unknown>> = [];
  for (const native of nativeRows) {
    const route = parseChannelScopedMattermostSessionRoute(native.key);
    if (!route) {
      if (!looksMattermostScopedSessionKey(native.key) || isNativeMattermostSessionKey(native.key)) {
        sessions.push(native);
      }
      continue;
    }
    const authorizedRow = authorizedByKey.get(native.key);
    if (!authorizedRow) continue;
    const refreshed = { ...native, ...authorizedRow };
    if (authorizedRow.lastInteractionAt === undefined) delete refreshed.lastInteractionAt;
    if (sessionMatchesRefreshedFilters(refreshed, params)) sessions.push(refreshed);
    authorizedByKey.delete(native.key);
  }
  sessions.push(...[...authorizedByKey.values()].filter((row) =>
    params.synthesize && sessionMatchesRefreshedFilters(row, params)));
  sessions.sort((first, second) => compareProjectedSessions(first, second, params.sortBy));
  return sessions;
}

function projectSessionsList(
  frame: OpenClawControlRequestFrame,
  upstream: Record<string, unknown>,
  authorizedRows: readonly ProjectedMattermostSession[],
  params: SessionsListProjectionParams,
  nativeAgentId?: string,
): Record<string, unknown> {
  if (upstream.type !== "res" || upstream.ok !== true) return upstream;
  const payload = record(upstream.payload);
  if (!payload || !completeSessionsListPayload(payload)) return invalidSessionsListUpstream(frame);
  const nativeRows = nativeSessionRows(payload.sessions as readonly unknown[]);
  if (!nativeRows) return invalidSessionsListUpstream(frame);
  const scopedNativeRows = nativeAgentId ? nativeRows.filter((row) => String(row.key).startsWith(`agent:${nativeAgentId}:`)) : nativeRows;
  const sessions = mergeAuthorizedSessions(scopedNativeRows, authorizedRows, params);
  if (!sessions) return invalidSessionsListUpstream(frame);

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

function rpcError(
  frame: OpenClawControlRequestFrame,
  code: string,
  message: string,
): MattermostChatPreparation {
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

function rpcSuccess(
  frame: OpenClawControlRequestFrame,
  payload: Record<string, unknown>,
): MattermostChatPreparation {
  return {
    kind: "response",
    frame: { type: "res", id: frame.id, ok: true, payload },
  };
}

function answerPart(value: unknown, index: number): AnswerPart | null {
  const part = record(value);
  if (
    !part ||
    !MATTERMOST_ID.test(typeof part.postId === "string" ? part.postId : "") ||
    !nonBlank(part.kind) ||
    !ANSWER_PART_KINDS.has(part.kind) ||
    part.index !== index ||
    (part.rootPostId !== undefined && !MATTERMOST_ID.test(String(part.rootPostId))) ||
    (part.threadId !== undefined && !MATTERMOST_ID.test(String(part.threadId)))
  ) return null;
  return {
    postId: part.postId as string,
    kind: part.kind,
    index,
    ...(typeof part.rootPostId === "string" ? { rootPostId: part.rootPostId } : {}),
    ...(typeof part.threadId === "string" ? { threadId: part.threadId } : {}),
  };
}

function validAnswerCommitPost(
  post: MattermostModelPost,
  channelId: string,
  agentMmUserId: string,
): boolean {
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

function validAnswerCommitMetadata(
  octogee: Record<string, unknown>,
  answer: Record<string, unknown>,
  post: MattermostModelPost,
  channelId: string,
  agentId: string,
): boolean {
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

function validAnswerPartSequence(
  parts: readonly AnswerPart[],
  postIds: readonly unknown[],
  mainRootPostId: unknown,
): boolean {
  const uniqueIds = new Set(parts.map((part) => part.postId));
  return [
    postIds.length === parts.length,
    uniqueIds.size === parts.length,
    !postIds.some((postId, index) => postId !== parts[index]?.postId),
    !parts.some((part) =>
      part.rootPostId !== undefined && part.rootPostId !== mainRootPostId ||
      part.threadId !== undefined && part.threadId !== mainRootPostId),
  ].every(Boolean);
}

function validDeliveryPartCount(
  deliveryOutcome: AnswerCommit["deliveryOutcome"],
  partCount: number,
): boolean {
  const includesParts = deliveryOutcome === "delivered" || deliveryOutcome === "partial";
  return includesParts ? partCount > 0 : partCount === 0;
}

function parseAnswerCommit(
  post: MattermostModelPost,
  channelId: string,
  agentId: string,
  agentMmUserId: string,
): AnswerCommit | null {
  const octogee = record(post.props?.octogee);
  const answer = record(octogee?.answer);
  if (!octogee || !answer) return null;
  if (!validAnswerCommitPost(post, channelId, agentMmUserId)) return null;
  if (!validAnswerCommitMetadata(octogee, answer, post, channelId, agentId)) return null;
  const sessionRoute = parseChannelScopedMattermostSessionRoute(octogee.sessionKey);
  if (
    !sessionRoute ||
    sessionRoute.agentId !== agentId ||
    sessionRoute.primaryChannelId !== channelId
  ) return null;
  const parts = (answer.parts as unknown[]).map(answerPart);
  if (parts.some((part) => part === null)) return null;
  const validParts = parts as AnswerPart[];
  const postIds = answer.postIds as unknown[];
  if (!validAnswerPartSequence(validParts, postIds, octogee.mainRootPostId)) return null;
  const deliveryOutcome = answer.deliveryOutcome as AnswerCommit["deliveryOutcome"];
  if (!validDeliveryPartCount(deliveryOutcome, validParts.length)) return null;
  return {
    post,
    runId: octogee.runId as string,
    turnId: octogee.turnId as string,
    sessionKey: octogee.sessionKey as string,
    mainRootPostId: octogee.mainRootPostId as string,
    inputPostId: octogee.inputPostId as string,
    terminalOutcome: answer.terminalOutcome as AnswerCommit["terminalOutcome"],
    deliveryOutcome,
    parts: validParts,
  };
}

function canonicalPosts(posts: readonly MattermostModelPost[]): MattermostModelPost[] {
  const byId = new Map<string, MattermostModelPost>();
  for (const post of posts) {
    const current = byId.get(post.id);
    const revision = post.update_at ?? post.create_at;
    const currentRevision = current ? current.update_at ?? current.create_at : -1;
    if (!current || revision > currentRevision) byId.set(post.id, post);
  }
  return [...byId.values()];
}

function attachmentText(count: number, kind?: string): string {
  if (count === 0) return "";
  if (count === 1) return kind ? `[${kind} attachment]` : "[attachment]";
  return kind ? `[${count} ${kind} attachments]` : `[${count} attachments]`;
}

function committedAnswerText(parts: readonly MattermostModelPost[], commit: AnswerCommit): string {
  const text = parts.map((part, index) => {
    const attachmentCount = part.file_ids?.length ?? 0;
    const renderedAttachment = attachmentText(
      attachmentCount,
      commit.parts[index]?.kind ?? "file",
    );
    return [part.message, renderedAttachment].filter(Boolean).join("\n\n");
  }).filter(Boolean).join("\n\n");
  return text || `[${commit.deliveryOutcome} answer]`;
}

function validPhysicalAnswerPart(input: {
  part: MattermostModelPost;
  inputPost: MattermostModelPost;
  commit: AnswerCommit;
  channelId: string;
  agentMmUserId: string;
  hasContent: boolean;
}): boolean {
  return [
    normalizedHistoryPost(input.part),
    input.part.user_id === input.agentMmUserId,
    input.part.channel_id === input.channelId,
    input.part.root_id === input.commit.mainRootPostId,
    input.hasContent,
    safeInteger(input.part.create_at, 0, Number.MAX_SAFE_INTEGER),
    input.part.create_at >= input.inputPost.create_at,
    input.part.create_at <= input.commit.post.create_at,
    (input.part.edit_at as number) <= input.commit.post.create_at,
    input.part.delete_at === 0,
  ].every(Boolean);
}

function validAnswerPartRunIdentity(
  octogee: Record<string, unknown>,
  commit: AnswerCommit,
  channelId: string,
  agentId: string,
): boolean {
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

function answerPartMatchesCommit(input: {
  part: MattermostModelPost;
  inputPost: MattermostModelPost;
  commit: AnswerCommit;
  channelId: string;
  agentId: string;
  agentMmUserId: string;
}): boolean {
  const hasContent = nonBlank(input.part.message) || Boolean(input.part.file_ids?.length);
  if (!validPhysicalAnswerPart({
    part: input.part,
    inputPost: input.inputPost,
    commit: input.commit,
    channelId: input.channelId,
    agentMmUserId: input.agentMmUserId,
    hasContent,
  })) return false;
  const octogeeValue = input.part.props?.octogee;
  if (octogeeValue === undefined) return true;
  const octogee = record(octogeeValue);
  if (
    !octogee ||
    octogee.itemId !== undefined ||
    octogee.kind !== undefined ||
    octogee.toolCallId !== undefined
  ) return false;
  return validAnswerPartRunIdentity(octogee, input.commit, input.channelId, input.agentId);
}

function claimsAnswerCommit(
  post: MattermostModelPost,
  octogee: Record<string, unknown> | null,
): boolean {
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

function suppressesRawAssistantMetadata(
  octogee: Record<string, unknown> | null,
  answerCommitCandidate: boolean,
): boolean {
  return [
    octogee?.projectionKind === "activity",
    octogee?.toolCallId !== undefined,
    !answerCommitCandidate && octogee?.itemId !== undefined,
    !answerCommitCandidate && octogee?.kind !== undefined,
  ].some(Boolean);
}

function rawAssistantText(post: MattermostModelPost): string | null {
  if (!normalizedHistoryPost(post)) return null;
  const octogee = record(post.props?.octogee);
  if (suppressesRawAssistantMetadata(octogee, claimsAnswerCommit(post, octogee))) return null;
  const attachmentCount = post.file_ids?.length ?? 0;
  const text = [post.message, attachmentText(attachmentCount)].filter(Boolean).join("\n\n");
  return nonBlank(text) ? text : null;
}

function humanPostText(post: MattermostModelPost): string {
  const attachmentCount = post.file_ids?.length ?? 0;
  return [post.message, attachmentText(attachmentCount)].filter(Boolean).join("\n\n");
}

function inputPostMatchesCommit(
  inputPost: MattermostModelPost | undefined,
  mainRoot: MattermostModelPost | undefined,
  commit: AnswerCommit,
  channelId: string,
  agentMmUserId: string,
): boolean {
  return Boolean(
    inputPost &&
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
      : inputPost.root_id === mainRoot.id),
  );
}

function unresolvedDeliveredCommitPostIds(input: {
  posts: readonly MattermostModelPost[];
  channelId: string;
  agentId: string;
  agentMmUserId: string;
}): string[] {
  const posts = canonicalPosts(input.posts)
    .filter((post) => post.channel_id === input.channelId && !(post.delete_at && post.delete_at > 0));
  const postIds = new Set(posts.map((post) => post.id));
  const missing = new Set<string>();
  for (const post of posts) {
    const commit = parseAnswerCommit(
      post,
      input.channelId,
      input.agentId,
      input.agentMmUserId,
    );
    if (!commit || commit.deliveryOutcome !== "delivered") continue;
    if (!postIds.has(commit.mainRootPostId)) missing.add(commit.mainRootPostId);
    if (!postIds.has(commit.inputPostId)) missing.add(commit.inputPostId);
    for (const part of commit.parts) {
      if (!postIds.has(part.postId)) missing.add(part.postId);
    }
  }
  return [...missing];
}

function channelProjectionPosts(input: ControlMessageProjectionInput): MattermostModelPost[] {
  return canonicalPosts(input.posts).filter((post) =>
    post.channel_id === input.channelId && !(post.delete_at && post.delete_at > 0));
}

function projectionRootIds(
  posts: readonly MattermostModelPost[],
  agentMmUserId: string,
): Set<string> {
  const roots = posts.filter((post) =>
    normalizedHistoryPost(post) && post.root_id === "" &&
    (post.user_id !== agentMmUserId || rawAssistantText(post) !== null));
  return new Set(roots.map((root) => root.id));
}

function humanProjectionMessages(
  posts: readonly MattermostModelPost[],
  rootIds: ReadonlySet<string>,
  agentMmUserId: string,
): LogicalProjectedMessage[] {
  const inputs = posts.filter((post) =>
    normalizedHistoryPost(post) &&
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

function commitsByRun(
  posts: readonly MattermostModelPost[],
  input: ControlMessageProjectionInput,
): Map<string, AnswerCommit[]> {
  const grouped = new Map<string, AnswerCommit[]>();
  for (const post of posts) {
    const commit = parseAnswerCommit(post, input.channelId, input.agentId, input.agentMmUserId);
    if (!commit) continue;
    const commits = grouped.get(commit.runId) ?? [];
    commits.push(commit);
    grouped.set(commit.runId, commits);
  }
  return grouped;
}

function boundAnswerCommits(
  grouped: ReadonlyMap<string, readonly AnswerCommit[]>,
  byId: ReadonlyMap<string, MattermostModelPost>,
  input: ControlMessageProjectionInput,
): BoundAnswerCommit[] {
  const bound: BoundAnswerCommit[] = [];
  for (const [runId, commits] of grouped) {
    if (commits.length !== 1) continue;
    const commit = commits[0];
    if (!commit || commit.turnId !== commit.mainRootPostId) continue;
    if (!inputPostMatchesCommit(
      byId.get(commit.inputPostId),
      byId.get(commit.mainRootPostId),
      commit,
      input.channelId,
      input.agentMmUserId,
    )) continue;
    bound.push({ runId, commit });
  }
  return bound;
}

function collidingAnswerRuns(commits: readonly BoundAnswerCommit[]): Set<string> {
  const ownersByPost = new Map<string, Set<string>>();
  for (const { runId, commit } of commits) {
    for (const part of commit.parts) {
      const owners = ownersByPost.get(part.postId) ?? new Set<string>();
      owners.add(runId);
      ownersByPost.set(part.postId, owners);
    }
  }
  const collisions = new Set<string>();
  for (const owners of ownersByPost.values()) {
    if (owners.size < 2) continue;
    for (const runId of owners) collisions.add(runId);
  }
  return collisions;
}

function deliveredAnswers(input: {
  commits: readonly BoundAnswerCommit[];
  collidingRuns: ReadonlySet<string>;
  byId: ReadonlyMap<string, MattermostModelPost>;
  projection: ControlMessageProjectionInput;
}): {
  byInput: Map<string, DeliveredAnswer[]>;
  consumedPostIds: Set<string>;
  hiddenCommitPostIds: Set<string>;
} {
  const byInput = new Map<string, DeliveredAnswer[]>();
  const consumedPostIds = new Set<string>();
  const hiddenCommitPostIds = new Set<string>();
  for (const { runId, commit } of input.commits) {
    if (input.collidingRuns.has(runId) || commit.deliveryOutcome === "partial") continue;
    if (commit.deliveryOutcome !== "delivered") {
      hiddenCommitPostIds.add(commit.post.id);
      continue;
    }
    const inputPost = input.byId.get(commit.inputPostId);
    if (!inputPost) continue;
    const parts = commit.parts.map((part) => input.byId.get(part.postId));
    const invalidPart = parts.some((part) => !part || !answerPartMatchesCommit({
      part,
      inputPost,
      commit,
      channelId: input.projection.channelId,
      agentId: input.projection.agentId,
      agentMmUserId: input.projection.agentMmUserId,
    }));
    if (invalidPart) continue;
    hiddenCommitPostIds.add(commit.post.id);
    const exactParts = parts as MattermostModelPost[];
    for (const part of exactParts) consumedPostIds.add(part.id);
    const answers = byInput.get(commit.inputPostId) ?? [];
    answers.push({ commit, parts: exactParts });
    byInput.set(commit.inputPostId, answers);
  }
  return { byInput, consumedPostIds, hiddenCommitPostIds };
}

function committedAnswerMessages(
  answersByInput: ReadonlyMap<string, DeliveredAnswer[]>,
  agentMmUserId: string,
): LogicalProjectedMessage[] {
  const messages: LogicalProjectedMessage[] = [];
  for (const answers of answersByInput.values()) {
    answers.sort((first, second) =>
      second.commit.post.create_at - first.commit.post.create_at ||
      second.commit.post.id.localeCompare(first.commit.post.id));
    const latest = answers[0];
    if (!latest) continue;
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

function rawAssistantMessages(input: {
  posts: readonly MattermostModelPost[];
  rootIds: ReadonlySet<string>;
  consumedPostIds: ReadonlySet<string>;
  hiddenCommitPostIds: ReadonlySet<string>;
  agentMmUserId: string;
}): LogicalProjectedMessage[] {
  const messages: LogicalProjectedMessage[] = [];
  for (const post of input.posts) {
    if (post.user_id !== input.agentMmUserId) continue;
    if (
      (post.root_id !== "" && !input.rootIds.has(post.root_id)) ||
      input.consumedPostIds.has(post.id) ||
      input.hiddenCommitPostIds.has(post.id)
    ) continue;
    const text = rawAssistantText(post);
    if (text === null) continue;
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

function compareLogicalMessages(
  first: LogicalProjectedMessage,
  second: LogicalProjectedMessage,
): number {
  const timestampOrder = first.timestamp - second.timestamp;
  if (timestampOrder !== 0) return timestampOrder;
  if (first.role !== second.role) return first.role === "user" ? -1 : 1;
  return first.id.localeCompare(second.id);
}

function finalizeProjectedMessages(messages: LogicalProjectedMessage[]): ProjectedMessage[] {
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

export function projectMattermostControlMessages(
  input: ControlMessageProjectionInput,
): ProjectedMessage[] {
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

function historyParams(params: Record<string, unknown>): {
  sessionKey: string;
  limit: number;
  offset: number;
} | null {
  if (!nonBlank(params.sessionKey)) return null;
  const limit = params.limit === undefined ? 800 : params.limit;
  const offset = params.offset === undefined ? 0 : params.offset;
  if (!safeInteger(limit, 1, 1_000) || !safeInteger(offset, 0, Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  if (params.cursor !== undefined || params.messageId !== undefined) return null;
  return { sessionKey: params.sessionKey, limit, offset };
}

async function authorized(
  authorize: Authorize,
  session: OpenClawControlSession,
  sessionKey: string,
  signal?: AbortSignal,
): Promise<{ route: NonNullable<ReturnType<typeof parseChannelScopedMattermostSessionRoute>>; authorization: AuthorizedChannel } | null> {
  const route = parseChannelScopedMattermostSessionRoute(sessionKey);
  if (!route) return null;
  const authorization = await authorize(
    session.uid,
    route.primaryChannelId,
    session.workspaceSlug,
    {
      requireActiveLedger: true,
      ...(signal ? { signal } : {}),
    },
  );
  signal?.throwIfAborted();
  if (
    !authorization ||
    authorization.forbidden ||
    authorization.target.workspaceSlug !== session.workspaceSlug ||
    authorization.target.agentId !== route.agentId
  ) {
    throw new ChannelSessionMattermostError("Mattermost channel access denied", 403);
  }
  const metadata = mattermostChannelMetadata(
    await authorization.client.getJson(["channels", route.primaryChannelId]),
    route.primaryChannelId,
  );
  signal?.throwIfAborted();
  if (!metadata || metadata.peerKind !== route.peerKind) {
    throw new ChannelSessionMattermostError("Mattermost channel access denied", 403);
  }
  return { route, authorization };
}

function historyNeedsMore(
  messages: readonly ProjectedMessage[],
  requiredMessages: number,
  unresolvedPostIds: readonly string[],
): boolean {
  return messages.length < requiredMessages || unresolvedPostIds.length > 0;
}

function assertHistoryRecoveryBudget(historyBytes: number, postCount: number): void {
  if (historyBytes <= MAX_HISTORY_BYTES && postCount <= MAX_HISTORY_POSTS) return;
  throw new ChannelSessionMattermostError("Mattermost channel history exceeded its recovery budget");
}

function assertHistoryProjectionBudget(projectionPostVisits: number): void {
  if (projectionPostVisits <= MAX_HISTORY_PROJECTION_POST_VISITS) return;
  throw new ChannelSessionMattermostError("Mattermost channel history exceeded its projection budget");
}

function nextHistoryCursor(nextBefore: string | undefined, cursors: Set<string>): string {
  if (!nextBefore || cursors.has(nextBefore)) {
    throw new ChannelSessionMattermostError("Mattermost channel history could not be paged safely");
  }
  cursors.add(nextBefore);
  return nextBefore;
}

async function readProjectedHistory(
  authorization: AuthorizedChannel,
  route: NonNullable<ReturnType<typeof parseChannelScopedMattermostSessionRoute>>,
  requiredMessages: number,
  signal?: AbortSignal,
): Promise<{ messages: ProjectedMessage[]; reachedEnd: boolean }> {
  let before: string | undefined;
  let reachedEnd = false;
  const posts: MattermostModelPost[] = [];
  const cursors = new Set<string>();
  let messages: ProjectedMessage[] = [];
  let unresolvedPostIds: string[] = [];
  let historyBytes = 0;
  let projectionPostVisits = 0;
  let nextProjectionPostCount = HISTORY_PAGE_SIZE;
  while (!reachedEnd && historyNeedsMore(messages, requiredMessages, unresolvedPostIds)) {
    signal?.throwIfAborted();
    const page = await authorization.client.listChannelPosts(
      route.primaryChannelId,
      before,
      HISTORY_PAGE_SIZE,
    );
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
      nextProjectionPostCount = Math.min(
        MAX_HISTORY_POSTS,
        Math.max(posts.length + HISTORY_PAGE_SIZE, posts.length * 2),
      );
    }
    if (reachedEnd || messages.length >= requiredMessages && unresolvedPostIds.length === 0) break;
    before = nextHistoryCursor(page.nextBefore, cursors);
  }
  if (unresolvedPostIds.length > 0) {
    throw new ChannelSessionMattermostError(
      "Mattermost channel history did not contain every committed answer post",
    );
  }
  return { messages, reachedEnd };
}

function pageHistory(
  messages: readonly ProjectedMessage[],
  offset: number,
  limit: number,
  reachedEnd: boolean,
): ProjectedHistory {
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

function projectUpstreamHistory(
  frame: Record<string, unknown>,
  history: ProjectedHistory,
): Record<string, unknown> {
  if (frame.type !== "res" || frame.ok !== true) return frame;
  const payload = record(frame.payload);
  if (!payload) return frame;
  const projected: Record<string, unknown> = { ...payload, ...history };
  delete projected.deltaCursor;
  return { ...frame, payload: projected };
}

function prepareSessionSubscription(frame: OpenClawControlRequestFrame): MattermostChatPreparation {
  if (!sessionsListParams(frame.params)) {
    return rpcError(frame, "INVALID_REQUEST", "Unsupported Mattermost session subscription request");
  }
  return {
    kind: "upstream",
    upstreamParams: {},
    project: (upstream) => {
      const payload = record(upstream.payload);
      if (upstream.type !== "res" || upstream.ok !== true || !payload) return upstream;
      const projected = { ...payload };
      delete projected.list;
      return { ...upstream, payload: projected };
    },
  };
}

async function prepareSessionsList(
  frame: OpenClawControlRequestFrame,
  session: OpenClawControlSession,
  authorize: Authorize,
  listWorkspaceChannels: ListWorkspaceChannels,
  { signal, perUserIdentity = false }: { signal?: AbortSignal; perUserIdentity?: boolean },
): Promise<MattermostChatPreparation | null> {
  const params = sessionsListParams(frame.params);
  if (!params) {
    if (perUserIdentity) return null;
    return rpcError(frame, "INVALID_REQUEST", "Unsupported Mattermost session list request");
  }
  if (perUserIdentity) params.synthesize = false;
  const authorizedRows = await authorizedMattermostSessions(
    session,
    authorize,
    listWorkspaceChannels,
    signal,
  );
  return {
    kind: "upstream",
    upstreamParams: {
      ...frame.params,
      offset: 0,
      limit: SESSION_LIST_SOURCE_LIMIT,
    },
    project: (upstream) => projectSessionsList(frame, upstream, authorizedRows, params,
      undefined),
  };
}

async function attributeChatProfiles(
  page: ProjectedHistory,
  session: OpenClawControlSession,
  { channelId, agentId }: { channelId: string; agentId: string },
  resolve: OpenClawControlProxyIdentity["resolveChatProfile"] | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!resolve) return;
  const accountId = mattermostAccountIdForAgentId(agentId);
  if (!accountId) throw new Error("Mattermost channel agent has no managed account");
  const authors = new Map<string, ProjectedMessage>();
  for (const message of page.messages) {
    if (message.role === "user" && message.__openclaw.senderId) authors.set(message.__openclaw.senderId, message);
  }
  const entries = [...authors.entries()];
  const profiles = new Map<string, Awaited<ReturnType<typeof resolve>>>();
  signal?.throwIfAborted();
  await Promise.all(entries.map(async ([mmId, message]) => {
    const profile = await resolve(session, { channelId, postId: message.__openclaw.id });
    if (profile && profile.mattermostUserId !== mmId) throw new Error("Chat profile author mismatch");
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
    if (profile.avatarUrl) meta.senderProfileAvatarUrl = profile.avatarUrl;
  }
}

async function prepareHistory(
  frame: OpenClawControlRequestFrame,
  session: OpenClawControlSession,
  authorize: Authorize,
  resolveChatProfile: OpenClawControlProxyIdentity["resolveChatProfile"] | undefined,
  { signal, onStage }: { signal?: AbortSignal; onStage: (stage: string) => void },
): Promise<MattermostChatPreparation | null> {
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
  const history = await readProjectedHistory(
    access.authorization,
    access.route,
    required,
    signal,
  );
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

function validSendMessage(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return Buffer.byteLength(value, "utf8") <= MAX_MESSAGE_BYTES;
}

function validSendParams(
  params: Record<string, unknown>,
  agentId: string,
  runId: string | null,
): boolean {
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

function sendAttachments(value: unknown, allowAttachments: boolean): Array<{ fileName: string; mimeType: string; bytes: Buffer }> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8 || (!allowAttachments && value.length > 0)) return null;
  const files: Array<{ fileName: string; mimeType: string; bytes: Buffer }> = [];
  let size = 0;
  for (const raw of value) {
    const file = record(raw);
    if (!validSendAttachment(file)) return null;
    const bytes = Buffer.from(file.content, 'base64');
    size += bytes.length;
    if (!bytes.length || bytes.toString('base64') !== file.content || size > 16 * 1024 * 1024) return null;
    files.push({ fileName: file.fileName, mimeType: file.mimeType, bytes });
  }
  return files;
}

function validCreatedPost(
  created: Record<string, unknown> | null,
  channelId: string,
  callerMmUserId: string,
): boolean {
  if (!created) return false;
  return [
    isMattermostId(created.id),
    created.channel_id === channelId,
    created.user_id === callerMmUserId,
    created.root_id === "",
  ].every(Boolean);
}

async function prepareSend(
  frame: OpenClawControlRequestFrame,
  session: OpenClawControlSession,
  authorize: Authorize,
  allowAttachments: boolean,
  signal?: AbortSignal,
): Promise<MattermostChatPreparation | null> {
  const { params } = frame;
  if (!nonBlank(params.sessionKey)) return null;
  const channelRoute = parseChannelScopedMattermostSessionRoute(params.sessionKey);
  const nativeRoute = isNativeMattermostSessionKey(params.sessionKey);
  if (!channelRoute) {
    if (nativeRoute || !looksMattermostScopedSessionKey(params.sessionKey)) return null;
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
  const message = params.message as string;
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
  if (!validCreatedPost(
    created,
    access.route.primaryChannelId,
    access.authorization.callerMmUserId,
  )) {
    throw new ChannelSessionMattermostError("Mattermost channel post response was invalid");
  }
  return rpcSuccess(frame, { runId, status: "ok" });
}

function unavailableResponse(
  frame: OpenClawControlRequestFrame,
  error: unknown,
): MattermostChatPreparation {
  const denied = error instanceof ChannelSessionMattermostError && error.status === 403;
  return rpcError(
    frame,
    denied ? "FORBIDDEN" : "UNAVAILABLE",
    denied ? "Mattermost channel access denied" : "Mattermost channel is temporarily unavailable",
  );
}

function initialRequestStage(method: string): string {
  if (method === "sessions.list") return "session-list";
  if (method === "chat.send") return "send";
  return "history";
}

function watchPreparedHistory(
  history: MattermostChatPreparation | null,
  frame: OpenClawControlRequestFrame,
  broker: ReturnType<typeof createBrokeredMattermostAccess>,
): void {
  const route = parseChannelScopedMattermostSessionRoute(frame.params.sessionKey);
  if (history && route && (history.kind === "upstream" || history.frame.ok === true)) {
    history.watch = {
      sessionKey: frame.params.sessionKey as string,
      agentId: route.agentId,
      run: (onChange, watchSignal) => broker.watchChannel(route.primaryChannelId, route.agentId, onChange, watchSignal),
    };
  }
}

export function createMattermostControlChat(options: {
  perUserIdentity?: boolean;
  allowAttachments?: boolean;
  resolveChatProfile?: OpenClawControlProxyIdentity["resolveChatProfile"];
  authorize?: Authorize;
  listWorkspaceChannels?: ListWorkspaceChannels;
} = {}): MattermostControlChat {
  return {
    async prepare(frame, session, signal) {
      const broker = createBrokeredMattermostAccess(session);
      const authorize = options.authorize ?? broker.authorize;
      const listWorkspaceChannels = options.listWorkspaceChannels ?? broker.listWorkspaceChannels;
      if (!["sessions.subscribe", "sessions.list", "chat.history", "chat.startup", "chat.send"].includes(frame.method)) return null;
      const startedAt = performance.now();
      let stage = initialRequestStage(frame.method);
      try {
        if (frame.method === "sessions.subscribe") return options.perUserIdentity ? null : prepareSessionSubscription(frame);
        if (frame.method === "sessions.list") {
          return await prepareSessionsList(
            frame,
            session,
            authorize,
            listWorkspaceChannels,
            { signal, perUserIdentity: options.perUserIdentity },
          );
        }
        if (frame.method === "chat.send") return await prepareSend(frame, session, authorize, options.allowAttachments === true, signal);
        const history = await prepareHistory(frame, session, authorize, options.resolveChatProfile, {
          signal, onStage: (next) => { stage = next; },
        });
        watchPreparedHistory(history, frame, broker);
        return history;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
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

function validSendAttachment(file: Record<string, unknown> | null): file is Record<string, unknown> & { fileName: string; mimeType: string; content: string } {
  return file !== null && [
    ['image', 'file', 'audio'].includes(String(file.type)),
    typeof file.fileName === 'string' && /^[^/\\\p{Cc}]{1,128}$/u.test(file.fileName) && !['.', '..'].includes(file.fileName),
    typeof file.mimeType === 'string' && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/iu.test(file.mimeType) && file.mimeType.length <= 128,
    typeof file.content === 'string' && file.content.length <= 24 * 1024 * 1024,
  ].every(Boolean);
}

async function uploadSendAttachments(access: NonNullable<Awaited<ReturnType<typeof authorized>>>, attachments: Array<{ fileName: string; mimeType: string; bytes: Buffer }>): Promise<string[]> {
  let fileIds: string[] = [];
  if (attachments.length) {
    const uploaded = record(await access.authorization.client.uploadFiles(access.route.primaryChannelId, attachments));
    const infos = uploaded?.file_infos;
    if (!Array.isArray(infos) || infos.length !== attachments.length || infos.some(info => !isMattermostId(info?.id) ||
      info.user_id !== access.authorization.callerMmUserId || info.channel_id !== access.route.primaryChannelId)) throw new ChannelSessionMattermostError('Mattermost upload response was invalid');
    fileIds = infos.map(info => info.id as string);
  }
  return fileIds;
}
