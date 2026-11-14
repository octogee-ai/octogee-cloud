import { brokerRequestLimit } from "../middleware/broker-request-limit.js";
import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";
import { notifyNativeFinalReply, parseFinalReply, ReplyBindingDeniedError, type FinalReplyIdentity, type FinalReplyTarget } from "@octogee/core/native-final-reply";
import { readFinalReplyPost, verifyFinalReplyChannel } from "../lib/native-final-reply-mattermost.js";
import type { FinalReplyNotifier } from "../lib/user-notifications.js";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { createVoicePostingGrant } from "../lib/voice-posting-grant.js";
import {
  resolveVoiceConversationContext,
  resolveWorkspaceConversationScope,
} from "../lib/workspace-conversation.js";
import { projectMemberExists } from "../lib/project-members.js";
import { isMattermostPostId, parseChannelScopedMattermostSessionRoute } from '@octogee/shared/types/mattermost-session-route';
import { resolveActivityConversation, type ActivityConversation } from '../../../gateway-edge/src/lib/activity-conversation.js';
import { Router, type Request, type Response } from "express";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";

import {
  isValidCustomChannelName,
  isValidProjectId,
  isValidUsername,
  parseAgentId,
  projectChannelName,
  projectGeneralChannelName,
  workspaceDefaultAgentChannelName,
  workspaceCustomChannelName,
  workspaceGeneralChannelName,
  type ParsedAgentId,
  workspaceDefaultAgentId,
} from "@octogee/shared/types/identity";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import { projectAgentSecretDocId } from "@octogee/core/mattermost/project-agent";
import type { SizingKeyReader } from "@octogee/core/sizing-key";
import {
  DuplicateRecordError,
  type PlatformUserRecord,
  type UserSecret,
  type GatewayRoot,
  MalformedRecordError,
  type GatewayTicket,
  type PlatformStateRepositories,
  type PlatformStateStore,
  type PlatformStateTransaction,
  type Stored,
  type WorkspaceChannel,
} from "@octogee/core/platform-state";
import {
  ActivityReceiptConflictError,
  ActivityReceiptLeaseError,
  ActivityReceiptUnavailableError,
  isValidActivityAttachmentReceipt,
  PlatformStateActivityWriteReceiptStore,
  type ActivityReceiptClaimInput,
  type ActivityWriteReceiptStore,
} from "../../../gateway-edge/src/chat-proxy/openclaw/activity-write-receipts.js";
type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

export type SessionChannelPurposeReader = (channel: WorkspaceChannel) => Promise<string>;
export const NO_SESSION_CHANNEL_PURPOSE: SessionChannelPurposeReader = async () => "";

interface RuntimeBrokerDeps {
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
  readSessionChannelPurpose: SessionChannelPurposeReader;
  notifyFinalReply?: FinalReplyNotifier;
}

interface AgentIdentity {
  agentId: string;
  uid: string;
  coachMmUserId: string;
  coachToken: string;
  workspaceSlug: string;
  projectSlug: string;
}

interface ChannelProjectionTarget {
  primaryChannelId: string;
  channelDocPath: string;
}

interface AuthorizedConversationTarget extends ChannelProjectionTarget {
  expectedChannelTeamId: string | null;
  expectedChannelName: string | null;
  expectedChannelType: "P" | "D";
  expectedMemberIds?: string[];
}

const REDEEMABLE_WS_TICKET_PURPOSES: ReadonlySet<string> = new Set(["openclaw-ws", "voice-ws"]);
const FORBIDDEN = { error: "forbidden" } as const;
const RECEIPT_MAX_LEASE_MS = 60_000;
export const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;

export function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const claimed = (req.body as { gatewayId?: unknown } | undefined)?.gatewayId;
  if (typeof claimed === "string" && claimed.length > 0 && claimed !== bound.gatewayId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

export function stringBody(req: Request, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

export function safeDocId(value: string): boolean {
  return value.length > 0 && !value.includes("/");
}

export function interactiveUser(user: PlatformUserRecord | null | undefined): user is PlatformUserRecord {
  return user !== null && user !== undefined &&
    accountAllowsInteractiveAccess({ accountLifecycle: user.accountLifecycle ?? undefined });
}

export function workspaceChannelPath(channel: WorkspaceChannel): string {
  const { workspaceSlug, projectSlug } = channel.scope;
  return projectSlug === null
    ? `workspaces/${workspaceSlug}/channels/${channel.channelId}`
    : `workspaces/${workspaceSlug}/projects/${projectSlug}/channels/${channel.channelId}`;
}

interface BoundChannelPath {
  workspaceSlug: string;
  ownerPath: string;
  channelName: string;
  lane: "workspace" | "project";
  projectSlug?: string;
}

type ChannelOwnerLookupResult = string | null | "forbidden";

function boundChannelPath(path: string | null): BoundChannelPath | null {
  if (!path) return null;
  const parts = path.split("/");
  if (!isWorkspacePath(parts)) return null;
  return workspaceChannelBinding(parts) ?? projectChannelBinding(parts);
}

function isWorkspacePath(parts: string[]): boolean {
  return !parts.some((part) => !part) &&
    parts[0] === "workspaces" &&
    isValidUsername(parts[1]);
}

function workspaceChannelBinding(parts: string[]): BoundChannelPath | null {
  if (parts.length !== 4 || parts[2] !== "channels") return null;
  const channelName = parts[3];
  const allowed = channelName === "general" ||
    channelName === "coach-dm" ||
    channelName === "admin" ||
    isValidCustomChannelName(channelName);
  return allowed
    ? {
        workspaceSlug: parts[1],
        ownerPath: `workspaces/${parts[1]}`,
        channelName,
        lane: "workspace",
      }
    : null;
}

function projectChannelBinding(parts: string[]): BoundChannelPath | null {
  if (
    parts.length !== 6 ||
    parts[2] !== "projects" ||
    !isValidProjectId(parts[3]) ||
    parts[4] !== "channels"
  ) return null;
  const channelName = parts[5];
  if (channelName !== "general" && !isValidCustomChannelName(channelName)) return null;
  return {
    workspaceSlug: parts[1],
    ownerPath: `workspaces/${parts[1]}/projects/${parts[3]}`,
    channelName,
    lane: "project",
    projectSlug: parts[3],
  };
}

function ordinaryChannelKind(binding: BoundChannelPath): string | null {
  if (binding.lane === "project") return binding.channelName === "general" ? "general" : null;
  if (binding.channelName === "general") return "general";
  if (binding.channelName === "coach-dm") return "coach-dm";
  if (binding.channelName === "admin") return "admin";
  return null;
}

export async function assignedHere(store: PlatformStateStore, gatewayId: string, slug: string): Promise<boolean> {
  const assigned = await store.users.records.listByGateway(gatewayId);
  return assigned.some((user) => user.slug === slug);
}

async function userGatewayId(store: PlatformStateStore, uid: string): Promise<string | null> {
  const gatewayId = (await store.users.records.get(uid))?.gateway?.gatewayId;
  return gatewayId ? gatewayId : null;
}

export function forbidden(res: Response): void {
  res.status(403).json(FORBIDDEN);
}

export async function uniqueUser(lookup: Promise<Stored<PlatformUserRecord> | null>): Promise<Stored<PlatformUserRecord> | null | "duplicate"> {
  try {
    return await lookup;
  } catch (error) {
    if (error instanceof DuplicateRecordError) return "duplicate";
    throw error;
  }
}

async function resolveUidBySlug(store: PlatformStateStore, slug: string): Promise<string | null> {
  const user = await uniqueUser(store.users.records.findBySlug(slug));
  return user === null || user === "duplicate" ? null : user.uid;
}

interface DefaultAgentSecret {
  coachToken: string;
  coachMmUserId: string;
}

type AgentScope = Omit<AgentIdentity, "coachMmUserId" | "coachToken">;

function agentSecret(secret: UserSecret | null): DefaultAgentSecret | null {
  if (!secret || secret.kind === "connector") return null;
  return secret.personalToken && secret.mattermostUserId
    ? { coachToken: secret.personalToken, coachMmUserId: secret.mattermostUserId }
    : null;
}

async function resolveAgentScope(
  store: PlatformStateStore,
  gatewayId: string,
  agentId: string,
): Promise<AgentScope | null | "forbidden"> {
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "unknown") return null;
  const slug = parsed.username;
  if (!(await assignedHere(store, gatewayId, slug))) return "forbidden";

  const uid = await resolveUidBySlug(store, slug);
  if (!uid) return null;

  return {
    agentId,
    uid,
    workspaceSlug: slug,
    projectSlug: parsed.kind === "project" ? parsed.project : "workspace",
  };
}

async function resolveAgentIdentity(
  store: PlatformStateStore,
  gatewayId: string,
  agentId: string,
): Promise<AgentIdentity | null | "forbidden"> {
  const scope = await resolveAgentScope(store, gatewayId, agentId);
  if (!scope || scope === "forbidden") return scope;
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "unknown") return null;
  const secretId = parsed.kind === "project" ? projectAgentSecretDocId(parsed.project) : "coachMattermost";
  const secret = agentSecret(await store.secrets.get(scope.uid, secretId));
  return secret
    ? {
        ...scope,
        coachMmUserId: secret.coachMmUserId,
        coachToken: secret.coachToken,
      }
    : null;
}

async function findMattermostChannel(
  store: PlatformStateStore,
  mattermostChannelId: string,
): Promise<Stored<WorkspaceChannel> | null | "forbidden"> {
  try {
    return await store.workspaces.channels.findByMattermostChannelId(mattermostChannelId);
  } catch (error) {
    if (error instanceof DuplicateRecordError) return "forbidden";
    throw error;
  }
}

async function resolveChannelProjectionTarget(
  store: PlatformStateStore,
  gatewayId: string,
  primaryChannelId: string,
): Promise<ChannelProjectionTarget | null | "forbidden"> {
  if (!primaryChannelId) return null;
  const channel = await findMattermostChannel(store, primaryChannelId);
  if (channel === "forbidden" || !channel) return channel;
  const channelDocPath = workspaceChannelPath(channel);
  const binding = boundChannelPath(channelDocPath);
  if (!binding) return null;
  if (!(await assignedHere(store, gatewayId, binding.workspaceSlug))) return "forbidden";
  return { primaryChannelId, channelDocPath };
}

type SessionContextLookup = {
  authorized: true;
  purpose?: string;
} | null | "forbidden";

type SessionChannelLookup =
  | {
      binding: BoundChannelPath;
      channel: Stored<WorkspaceChannel>;
    }
  | null
  | "forbidden";

async function resolveSessionChannel(
  store: PlatformStateStore,
  channelId: string,
): Promise<SessionChannelLookup> {
  const channel = await findMattermostChannel(store, channelId);
  if (channel === "forbidden" || !channel) return channel;
  const binding = boundChannelPath(workspaceChannelPath(channel));
  if (!binding) return "forbidden";
  return { binding, channel };
}

function agentCanReadSession(
  agentId: string,
  workspaceSlug: string,
  binding: BoundChannelPath,
): boolean {
  if (binding.workspaceSlug !== workspaceSlug) return false;
  const parsed = parseAgentId(agentId);
  return (
    parsed.kind !== "project" ||
    (binding.lane === "project" && binding.projectSlug === parsed.project)
  );
}

function agentCanRunInConversation(
  agentId: string,
  workspaceSlug: string,
  binding: BoundChannelPath,
): boolean {
  const parsed = parseAgentId(agentId);
  if (!agentCanReadSession(agentId, workspaceSlug, binding)) return false;
  return parsed.kind === "project" || (
    binding.lane === "workspace" &&
    binding.channelName !== "admin"
  );
}

function mattermostChannelName(binding: BoundChannelPath): string | null {
  if (binding.lane === "project") {
    return binding.channelName === "general"
      ? projectGeneralChannelName(binding.workspaceSlug, binding.projectSlug!)
      : projectChannelName(binding.workspaceSlug, binding.projectSlug!, binding.channelName);
  }
  if (binding.channelName === "general") return workspaceGeneralChannelName(binding.workspaceSlug);
  if (binding.channelName === "coach-dm") return workspaceDefaultAgentChannelName(binding.workspaceSlug);
  if (binding.channelName === "admin") return null;
  return workspaceCustomChannelName(binding.workspaceSlug, binding.channelName);
}

async function sessionOwnerIsActive(
  store: PlatformStateStore,
  binding: BoundChannelPath,
): Promise<boolean> {
  if (binding.lane !== "project") return true;
  const project = await store.workspaces.projects.get(binding.workspaceSlug, binding.projectSlug!);
  return project !== null && project.commercialLifecycleStatus !== "archived";
}

function channelAuthorized(channel: WorkspaceChannel, binding: BoundChannelPath): boolean {
  if (channel.archivedAt) return false;
  const ordinaryKind = ordinaryChannelKind(binding);
  return channel.kind === (ordinaryKind ?? "session");
}

async function authorizedChannelContext(
  readSessionChannelPurpose: SessionChannelPurposeReader,
  channel: WorkspaceChannel,
  binding: BoundChannelPath,
): Promise<Exclude<SessionContextLookup, "forbidden">> {
  if (!channelAuthorized(channel, binding)) return null;
  if (ordinaryChannelKind(binding) !== null) return { authorized: true };
  const purpose = await readSessionChannelPurpose(channel);
  return purpose.length > 0 ? { authorized: true, purpose } : { authorized: true };
}

async function resolveAuthorizedConversationTarget(
  store: PlatformStateStore,
  gatewayId: string,
  agentId: string,
  conversationId: string,
): Promise<AuthorizedConversationTarget | null | "forbidden"> {
  const identity = await resolveAgentScope(store, gatewayId, agentId);
  if (identity === "forbidden") return identity;
  if (!identity) return null;
  const channel = await resolveSessionChannel(store, conversationId);
  if (channel === "forbidden") return channel;
  if (!channel) return null;
  if (!agentCanRunInConversation(agentId, identity.workspaceSlug, channel.binding)) {
    return "forbidden";
  }
  if (!(await sessionOwnerIsActive(store, channel.binding))) return null;
  if (!channelAuthorized(channel.channel, channel.binding)) return null;
  const expectedChannelName = mattermostChannelName(channel.binding);
  if (!expectedChannelName) return "forbidden";
  const expectedChannelTeamId = (await store.workspaces.records.get(identity.workspaceSlug))?.mattermostTeamId;
  if (!expectedChannelTeamId) return null;
  return {
    primaryChannelId: conversationId,
    channelDocPath: channel.binding.lane === "project"
      ? `workspaces/${channel.binding.workspaceSlug}/projects/${channel.binding.projectSlug}/channels/${channel.binding.channelName}`
      : `workspaces/${channel.binding.workspaceSlug}/channels/${channel.binding.channelName}`,
    expectedChannelTeamId,
    expectedChannelName,
    expectedChannelType: "P",
  };
}

interface ResolveSessionContextInput {
  gatewayId: string;
  agentId: string;
  accountId: string;
  channelId: string;
  senderId: string;
  sessionKey: string;
}

function rawDirectSessionContext(input: ResolveSessionContextInput): SessionContextLookup | undefined {
  if (!input.senderId && !input.sessionKey) return undefined;
  return "forbidden";
}

async function resolveSessionContext(
  deps: RuntimeBrokerDeps,
  input: ResolveSessionContextInput,
): Promise<SessionContextLookup> {
  const { gatewayId, agentId, accountId, channelId } = input;
  if (!agentId || !channelId) return null;
  const directContext = rawDirectSessionContext(input);
  if (directContext !== undefined) return directContext;
  const parsed = parseAgentId(agentId);
  const expectedAccountId = mattermostAccountId(parsed);
  if (!expectedAccountId || accountId !== expectedAccountId) return "forbidden";
  const identity = await resolveAgentScope(deps.store, gatewayId, agentId);
  if (identity === "forbidden") return identity;
  if (!identity) return null;

  const channel = await resolveSessionChannel(deps.store, channelId);
  if (channel === "forbidden") return channel;
  if (!channel) return null;
  if (!agentCanRunInConversation(agentId, identity.workspaceSlug, channel.binding)) return "forbidden";
  if (!(await sessionOwnerIsActive(deps.store, channel.binding))) return null;
  return authorizedChannelContext(deps.readSessionChannelPurpose, channel.channel, channel.binding);
}

type DispatchSessionRoute = {
  kind: "direct" | "group" | "channel";
  peerId: string;
};

type KnownAgentId = Exclude<ParsedAgentId, { kind: "unknown" }>;
type DispatchContextLookup = { authorized: true } | null | "forbidden";

interface DispatchContextInput {
  store: PlatformStateStore;
  gatewayId: string;
  agentId: string;
  accountId: string;
  conversationId: string;
  senderId: string;
  sessionKey: string;
}

function mattermostAccountId(parsed: ParsedAgentId): string | null {
  if (parsed.kind === "project") return `${parsed.username}-proj-${parsed.project}`;
  if (parsed.kind === "coach") return `${parsed.username}-coach`;
  return null;
}

function dispatchSessionRoute(
  sessionKey: string,
  agentId: string,
): DispatchSessionRoute | null {
  const match = /^agent:([^:]+):mattermost:(direct|group|channel):([a-z0-9]{26})(?::thread:[a-z0-9]{26})?$/u.exec(
    sessionKey,
  );
  if (match?.[1] !== agentId) return null;
  return {
    kind: match[2] as DispatchSessionRoute["kind"],
    peerId: match[3],
  };
}

function dispatchEnvelope(
  input: DispatchContextInput,
  parsed: KnownAgentId,
): DispatchSessionRoute | null {
  if (
    !MATTERMOST_ID_RE.test(input.conversationId)
    || !MATTERMOST_ID_RE.test(input.senderId)
    || input.accountId !== mattermostAccountId(parsed)
  ) return null;
  const route = dispatchSessionRoute(input.sessionKey, input.agentId);
  if (!route || route.peerId !== input.conversationId) return null;
  if (route.kind === "direct" && input.senderId !== route.peerId) return null;
  return route;
}

async function resolveDefaultAgentOwnerDispatchContext(
  input: DispatchContextInput,
  identity: AgentScope,
  parsed: KnownAgentId,
): Promise<DispatchContextLookup> {
  if (parsed.kind !== "coach") return "forbidden";
  const [workspace, owner] = await Promise.all([
    input.store.workspaces.records.get(parsed.username),
    input.store.users.records.get(identity.uid),
  ]);
  if (
    workspace?.ownerUid === identity.uid
    && owner?.mattermostUserId === input.senderId
  ) return { authorized: true };
  return "forbidden";
}

function isExactDispatchLane(
  binding: BoundChannelPath,
  parsed: KnownAgentId,
): boolean {
  if (parsed.kind === "project") {
    return binding.lane === "project"
      && binding.workspaceSlug === parsed.username
      && binding.projectSlug === parsed.project;
  }
  return binding.lane === "workspace"
    && binding.workspaceSlug === parsed.username
    && binding.channelName !== "admin"
    && binding.channelName !== "coach-dm";
}

async function resolveGroupDispatchContext(
  input: DispatchContextInput,
  identity: AgentScope,
  parsed: KnownAgentId,
): Promise<DispatchContextLookup> {
  const channel = await resolveSessionChannel(input.store, input.conversationId);
  if (channel === "forbidden") return channel;
  if (!channel) return null;
  if (channel.binding.channelName === "coach-dm") {
    if (
      channel.binding.lane !== "workspace"
      || channel.binding.workspaceSlug !== parsed.username
    ) return "forbidden";
    return resolveDefaultAgentOwnerDispatchContext(input, identity, parsed);
  }
  if (!isExactDispatchLane(channel.binding, parsed)) return "forbidden";
  if (!(await sessionOwnerIsActive(input.store, channel.binding))) return null;
  return channelAuthorized(channel.channel, channel.binding)
    ? { authorized: true }
    : null;
}

async function resolveDispatchContext(
  input: DispatchContextInput,
): Promise<DispatchContextLookup> {
  if (
    !MATTERMOST_ID_RE.test(input.conversationId)
    || !MATTERMOST_ID_RE.test(input.senderId)
  ) return "forbidden";
  const parsed = parseAgentId(input.agentId);
  if (parsed.kind === "unknown") return "forbidden";
  const route = dispatchEnvelope(input, parsed);
  if (!route) return "forbidden";

  const identity = await resolveAgentScope(input.store, input.gatewayId, input.agentId);
  if (identity === "forbidden") return identity;
  if (!identity) return null;

  if (route.kind === "direct") return "forbidden";
  return resolveGroupDispatchContext(input, identity, parsed);
}

function receiptBody(req: Request): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function receiptString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function receiptTimestamp(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function receiptEventKey(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function receiptClaimInput(body: Record<string, unknown>): ActivityReceiptClaimInput | null {
  const raw = body.input;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const eventKey = receiptEventKey(input.eventKey);
  const payloadDigest = receiptEventKey(input.payloadDigest);
  const historyAnchorPostId = receiptString(input, "historyAnchorPostId");
  const leaseOwner = receiptString(input, "leaseOwner");
  const now = receiptTimestamp(input.now);
  const leaseMs = receiptTimestamp(input.leaseMs);
  if (
    !eventKey ||
    !payloadDigest ||
    !historyAnchorPostId ||
    !leaseOwner ||
    now === null ||
    leaseMs === null ||
    leaseMs === 0 ||
    leaseMs > RECEIPT_MAX_LEASE_MS ||
    !Number.isSafeInteger(now + leaseMs)
  ) {
    return null;
  }
  return { eventKey, payloadDigest, historyAnchorPostId, leaseOwner, now, leaseMs };
}

function receiptMutation(
  body: Record<string, unknown>,
): { eventKey: string; leaseToken: string; now: number } | null {
  const eventKey = receiptEventKey(body.eventKey);
  const leaseToken = receiptString(body, "leaseToken");
  const now = receiptTimestamp(body.now);
  return eventKey && leaseToken && now !== null ? { eventKey, leaseToken, now } : null;
}

async function receiptStoreFor(
  req: Request,
  res: Response,
  deps: RuntimeBrokerDeps,
  bound: GatewayBinding,
): Promise<ActivityWriteReceiptStore | null> {
  const channelDocPath = receiptString(receiptBody(req), "channelDocPath");
  const binding = boundChannelPath(channelDocPath);
  if (!binding) {
    res.status(400).json({ error: "invalid_receipt_channel_path" });
    return null;
  }
  if (!(await assignedHere(deps.store, bound.gatewayId, binding.workspaceSlug))) {
    forbidden(res);
    return null;
  }
  const channel = await deps.store.workspaces.channels.get(
    { workspaceSlug: binding.workspaceSlug, projectSlug: binding.projectSlug ?? null },
    binding.channelName,
  );
  if (!channel) {
    res.status(404).json({ error: "receipt_channel_not_found" });
    return null;
  }
  return new PlatformStateActivityWriteReceiptStore(deps.store, { scope: channel.scope, channelId: channel.channelId });
}

function respondReceiptStoreError(res: Response, error: unknown): void {
  if (error instanceof ActivityReceiptConflictError) {
    res.status(409).json({ error: "receipt_conflict" });
    return;
  }
  if (error instanceof ActivityReceiptLeaseError) {
    res.status(409).json({ error: "receipt_leased" });
    return;
  }
  if (error instanceof ActivityReceiptUnavailableError) {
    res.status(422).json({ error: "receipt_unavailable" });
    return;
  }
  throw error;
}

async function bindingOwnerUid(store: PlatformStateStore, binding: BoundChannelPath): Promise<string | null> {
  const owner = binding.lane === "project"
    ? await store.workspaces.projects.get(binding.workspaceSlug, binding.projectSlug!)
    : await store.workspaces.records.get(binding.workspaceSlug);
  return owner?.ownerUid ? owner.ownerUid : null;
}

export async function resolveChannelOwnerUid(
  store: PlatformStateStore,
  gatewayId: string,
  channelId: string,
): Promise<ChannelOwnerLookupResult> {
  const channel = await findMattermostChannel(store, channelId);
  if (channel === "forbidden" || !channel) return channel;
  const binding = boundChannelPath(workspaceChannelPath(channel));
  if (!binding || !(await assignedHere(store, gatewayId, binding.workspaceSlug))) return "forbidden";
  if (channel.kind === "session") return sessionChannelOwner(channel, binding);
  if (channel.kind !== ordinaryChannelKind(binding)) return "forbidden";
  return bindingOwnerUid(store, binding);
}

function sessionChannelOwner(
  channel: WorkspaceChannel,
  binding: BoundChannelPath,
): ChannelOwnerLookupResult {
  if (ordinaryChannelKind(binding) !== null) return "forbidden";
  return channel.createdBy ? channel.createdBy : null;
}

async function resolveUidByMmUser(
  store: PlatformStateStore,
  gatewayId: string,
  mmUserId: string,
): Promise<string | null | "forbidden"> {
  if (!mmUserId) return null;
  const user = await uniqueUser(store.users.records.findByMattermostUserId(mmUserId));
  if (user === "duplicate") return "forbidden";
  if (!user) return null;
  if (!user.slug || !(await assignedHere(store, gatewayId, user.slug))) return "forbidden";
  return user.uid;
}

export async function resolveRedeemGatewayUrl(input: {
  tx: PlatformStateRepositories;
  gatewayId: string;
  gateway: Stored<GatewayRoot> | null;
}): Promise<{ url: string } | { error: string }> {
  const gateway = projectGatewayDesiredRootForGateway(input.gateway ?? undefined, input.gatewayId);
  if (!gateway) return { error: "gateway-root-invalid" };
  if (gateway.liveRelease === null) return { error: "gateway-url-unresolved" };

  const runtime = await input.tx.fleetRegistry.get(input.gatewayId);
  if (!runtime) return { error: `runtime ${input.gatewayId} not found` };
  const lifecycle: string = runtime.lifecycle;
  if (lifecycle === "retired" || lifecycle === "failed" || runtime.retiredAt != null) {
    return { error: `runtime ${input.gatewayId} is not serving` };
  }
  const url = runtime.heartbeat?.internalUrl;
  if (typeof url !== "string" || url.length === 0) {
    return { error: `runtime ${input.gatewayId} has no serving internalUrl` };
  }
  return { url };
}

function matchesActivityTicket(scope: ActivityConversation, gatewayId: string, payload: Record<string, unknown>): boolean {
  return scope.gatewayId === gatewayId && scope.channelId === payload.channelId && scope.threadRootPostId === payload.threadRootPostId && scope.ownerUid === payload.ownerUid && scope.expectedAgentId === payload.expectedAgentId && scope.sessionKey === payload.sessionKey;
}

interface VoiceClaim {
  uid: string;
  gatewayId: string;
  workspaceSlug: string;
  ownerUid: string;
  projectId?: string;
  channelId: string;
  threadRootPostId: string;
  sessionKey: string;
}

type VoiceContext = NonNullable<Awaited<ReturnType<typeof resolveVoiceConversationContext>>>;

type Deferred<T> = { value: T } | { error: unknown };

async function deferred<T>(work: () => Promise<T>): Promise<Deferred<T>> {
  try {
    return { value: await work() };
  } catch (error) {
    return { error };
  }
}

function settled<T>(result: Deferred<T>): T {
  if ("error" in result) throw result.error;
  return result.value;
}

type RedeemPrelude =
  | { kind: "denied" }
  | { kind: "activity"; scope: ActivityConversation }
  | { kind: "voice"; claim: VoiceClaim; live: Deferred<VoiceContext | null> }
  | { kind: "builder" };

type RedeemIdentity =
  | { expectedAgentId: string; activityConversation: ActivityConversation }
  | { expectedAgentId: string; voiceConversation: Omit<VoiceClaim, "uid" | "gatewayId" | "projectId"> }
  | { expectedAgentId: string };

const DENIED: RedeemPrelude = { kind: "denied" };

async function prepareActivityRedeem(deps: RuntimeBrokerDeps, payload: Record<string, unknown>, uid: string, gatewayId: string): Promise<RedeemPrelude> {
  if (Object.keys(payload).some(key => !['channelId', 'threadRootPostId', 'ownerUid', 'expectedAgentId', 'sessionKey'].includes(key)) || !isMattermostPostId(payload.channelId)
    || (payload.threadRootPostId !== undefined && !isMattermostPostId(payload.threadRootPostId))) return DENIED;
  const scope = await resolveActivityConversation({ users: deps.store.users.records, uid, channelId: payload.channelId, ...(payload.threadRootPostId === undefined ? {} : { threadRootPostId: payload.threadRootPostId }) });
  return scope && matchesActivityTicket(scope, gatewayId, payload) ? { kind: "activity", scope } : DENIED;
}

function validVoiceTicketPayload(payload: Record<string, unknown> | undefined): payload is Record<string, unknown> & { channelId: string; threadRootPostId: string; workspaceSlug: string; ownerUid: string } {
  return Boolean(payload && Object.keys(payload).every(key => ['workspaceSlug', 'ownerUid', 'channelId', 'threadRootPostId', 'sessionKey'].includes(key)) &&
    isMattermostPostId(payload.channelId) && isMattermostPostId(payload.threadRootPostId) && typeof payload.workspaceSlug === 'string' && typeof payload.ownerUid === 'string');
}

function validConversationScopeClaim(claim: VoiceClaim): boolean {
  return [claim.uid, claim.ownerUid].every(id => id.length > 0 && id.length <= 128 && !id.includes("/")) &&
    /^[a-z0-9-]{1,64}$/u.test(claim.workspaceSlug) &&
    (claim.projectId === undefined || isValidProjectId(claim.projectId));
}

async function prepareVoiceRedeem(deps: RuntimeBrokerDeps, payload: Record<string, unknown> | undefined, uid: string, gatewayId: string): Promise<RedeemPrelude> {
  if (!validVoiceTicketPayload(payload)) return DENIED;
  const { workspaceSlug, ownerUid, channelId, threadRootPostId } = payload;
  const sessionKey = payload.sessionKey as string;
  const route = parseChannelScopedMattermostSessionRoute(sessionKey);
  const agent = parseAgentId(route?.agentId ?? '');
  if (!route || route.primaryChannelId !== channelId || agent.kind === 'unknown' || agent.username !== workspaceSlug) return DENIED;
  const claim: VoiceClaim = { uid, gatewayId, workspaceSlug, ownerUid, channelId, threadRootPostId, sessionKey, ...(agent.kind === 'project' ? { projectId: agent.project } : {}) };
  if (!validConversationScopeClaim(claim)) return DENIED;
  const live = await deferred(() => resolveVoiceConversationContext(deps, { uid, gatewayId, channelId, threadRootPostId }));
  return { kind: "voice", claim, live };
}

async function prepareWsRedeem(deps: RuntimeBrokerDeps, ticket: GatewayTicket, gatewayId: string): Promise<RedeemPrelude> {
  if (ticket.gatewayId !== gatewayId) return DENIED;
  const payload = ticket.grant.payload as Record<string, unknown> | undefined;
  if (ticket.grant.purpose === 'openclaw-ws' && payload?.channelId !== undefined) {
    return prepareActivityRedeem(deps, payload, ticket.uid, gatewayId);
  }
  if (ticket.grant.purpose === "voice-ws") return prepareVoiceRedeem(deps, payload, ticket.uid, gatewayId);
  return { kind: "builder" };
}

async function redeemVoiceIdentity(
  tx: PlatformStateTransaction,
  prelude: Extract<RedeemPrelude, { kind: "voice" }>,
): Promise<RedeemIdentity | null> {
  const { claim } = prelude;
  const projectMember = claim.projectId !== undefined && claim.uid !== claim.ownerUid &&
    (await tx.workspaces.projectMembers.get(claim.workspaceSlug, claim.projectId, claim.uid)) !== null;
  if (!(await resolveWorkspaceConversationScope(tx, claim, projectMember))) return null;
  const live = settled(prelude.live);
  if (!live || live.scope.ownerUid !== claim.ownerUid || live.context.workspaceSlug !== claim.workspaceSlug || live.context.sessionKey !== claim.sessionKey) return null;
  const { workspaceSlug, ownerUid, channelId, threadRootPostId, sessionKey } = claim;
  return { expectedAgentId: live.context.agentId, voiceConversation: { workspaceSlug, ownerUid, channelId, threadRootPostId, sessionKey } };
}

async function redeemWsIdentity(
  tx: PlatformStateTransaction,
  prelude: RedeemPrelude,
  uid: string,
  gatewayId: string,
): Promise<RedeemIdentity | null> {
  if (prelude.kind === "denied") return null;
  if (prelude.kind === "voice") return redeemVoiceIdentity(tx, prelude);
  const mirrorUid = prelude.kind === "activity" ? prelude.scope.ownerUid : uid;
  const mirror = await tx.users.records.get(mirrorUid);
  if (mirror?.gateway?.gatewayId !== gatewayId) return null;
  if (prelude.kind === "activity") {
    return { expectedAgentId: prelude.scope.expectedAgentId, activityConversation: prelude.scope };
  }
  if (mirror.slug === null) throw new Error(`User ${uid} has no slug`);
  return { expectedAgentId: workspaceDefaultAgentId(mirror.slug) };
}

function redeemableTicket(ticket: Stored<GatewayTicket> | null, purpose: string, now: number): ticket is Stored<GatewayTicket> {
  return ticket !== null && ticket.uid.length > 0 && ticket.grant.purpose === purpose && ticket.expiresAt > now;
}

function voicePostingTicket(grant: ReturnType<typeof createVoicePostingGrant>): GatewayTicket {
  const { uid, gatewayId, expiresAt, ...rest } = grant.document;
  return { ticketId: grant.path.slice("gatewayTickets/".length), uid, gatewayId, expiresAt, grant: rest };
}

type RedeemResult = { status: number; body: Record<string, unknown> };

const UNAUTHORIZED: RedeemResult = { status: 401, body: { error: "unauthorized" } };
const EXPECTED_AGENT_UNRESOLVED: RedeemResult = { status: 502, body: { error: "expected-agent-unresolved" } };

async function redeemWsTicket(
  deps: RuntimeBrokerDeps,
  ticketId: string,
  requestedPurpose: string,
  gatewayId: string,
): Promise<RedeemResult> {
  const ticket = await deps.store.access.gatewayTickets.get(ticketId);
  if (!redeemableTicket(ticket, requestedPurpose, Date.now())) return UNAUTHORIZED;
  let prelude: RedeemPrelude;
  try { prelude = await prepareWsRedeem(deps, ticket, gatewayId); }
  catch { return EXPECTED_AGENT_UNRESOLVED; }

  return deps.store.transaction({ label: "openclaw-runtime-broker.ws-redeem" }, async (tx): Promise<RedeemResult> => {
    const current = await tx.access.gatewayTickets.get(ticketId);
    if (!redeemableTicket(current, requestedPurpose, Date.now()) || current.revision !== ticket.revision) return UNAUTHORIZED;
    const { uid } = current;
    let identity: RedeemIdentity | null;
    try { identity = await redeemWsIdentity(tx, prelude, uid, gatewayId); }
    catch { return EXPECTED_AGENT_UNRESOLVED; }
    if (!identity) return { status: 403, body: FORBIDDEN };
    const root = await tx.gateways.roots.get(gatewayId);
    const urlResult = await resolveRedeemGatewayUrl({ tx, gatewayId, gateway: root });
    if ("error" in urlResult) {
      return {
        status: 502,
        body: {
          error:
            urlResult.error === "gateway-root-invalid"
              ? "gateway-root-invalid"
              : "gateway-url-unresolved",
        },
      };
    }
    const gatewayUrl = urlResult.url;
    const grant = 'voiceConversation' in identity ? createVoicePostingGrant({ uid, gatewayId, agentId: identity.expectedAgentId, ...identity.voiceConversation }) : null;
    if (grant) await tx.access.gatewayTickets.create(voicePostingTicket(grant));
    await tx.access.gatewayTickets.delete(ticketId, { revision: current.revision });
    return {
      status: 200,
      body: { uid, gatewayId, gatewayUrl, ...identity, ...(grant ? { voiceGrant: grant.voiceGrant, voiceGrantExpiresAt: grant.voiceGrantExpiresAt } : {}) },
    };
  });
}

function mountUserAndWsRoutes(router: Router, deps: RuntimeBrokerDeps): void {
  router.post('/activity/conversation-access', async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = stringBody(req, 'uid');
    const channelId = stringBody(req, 'channelId');
    const rawThreadRootPostId = (req.body as Record<string, unknown> | undefined)?.threadRootPostId;
    const threadRootPostId = rawThreadRootPostId === undefined ? undefined : stringBody(req, 'threadRootPostId');
    if (!safeDocId(uid) || !MATTERMOST_ID_RE.test(channelId) || (threadRootPostId !== undefined && !isMattermostPostId(threadRootPostId))) { res.status(400).json({ error: 'invalid_activity_channel' }); return; }
    const scope = await resolveActivityConversation({ users: deps.store.users.records, uid, channelId, ...(threadRootPostId === undefined ? {} : { threadRootPostId }) });
    if (!scope || scope.gatewayId !== bound.gatewayId) { forbidden(res); return; }
    res.set('Cache-Control', 'no-store').json(scope);
  });
  router.post("/users/gateway-id", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = stringBody(req, "uid");
    const gatewayId = uid ? await userGatewayId(deps.store, uid) : null;
    if (!gatewayId) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (gatewayId !== bound.gatewayId) {
      forbidden(res);
      return;
    }
    res.json({ gatewayId });
  });

  router.post("/ws/redeem", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const ticketId = stringBody(req, "ticketId");
    if (!ticketId) {
      res.status(400).json({ error: "ticketId required" });
      return;
    }
    const requestedPurpose = stringBody(req, "purpose") || "openclaw-ws";
    if (!REDEEMABLE_WS_TICKET_PURPOSES.has(requestedPurpose)) {
      res.status(400).json({ error: "unsupported ticket purpose" });
      return;
    }
    const result = await redeemWsTicket(deps, ticketId, requestedPurpose, bound.gatewayId);
    res.set("Cache-Control", "no-store").status(result.status).json(result.body);
  });
}

function mountSessionContextRoute(
  router: Router,
  deps: RuntimeBrokerDeps,
): void {
  router.post("/activity/dispatch-context", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const context = await resolveDispatchContext({
      store: deps.store,
      gatewayId: bound.gatewayId,
      agentId: stringBody(req, "agentId"),
      accountId: stringBody(req, "accountId"),
      conversationId: stringBody(req, "conversationId"),
      senderId: stringBody(req, "senderId"),
      sessionKey: stringBody(req, "sessionKey"),
    });
    if (context === "forbidden") {
      forbidden(res);
      return;
    }
    if (!context) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(context);
  });

  router.post("/activity/session-context", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const context = await resolveSessionContext(deps, {
      gatewayId: bound.gatewayId,
      agentId: stringBody(req, "agentId"),
      accountId: stringBody(req, "accountId"),
      channelId: stringBody(req, "channelId"),
      senderId: stringBody(req, "senderId"),
      sessionKey: stringBody(req, "sessionKey"),
    });
    if (context === "forbidden") {
      forbidden(res);
      return;
    }
    if (!context) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(context);
  });
}

function mountActivityRoutes(
  router: Router,
  deps: RuntimeBrokerDeps,
): void {
  const { store } = deps;
  router.post("/activity/agent-identity", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const identity = await resolveAgentIdentity(store, bound.gatewayId, stringBody(req, "agentId"));
    if (identity === "forbidden") {
      forbidden(res);
      return;
    }
    if (!identity) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ identity });
  });

  const resolveChannelTarget = async (req: Request, res: Response): Promise<void> => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const target = await resolveChannelProjectionTarget(
      store,
      bound.gatewayId,
      stringBody(req, "primaryChannelId"),
    );
    if (target === "forbidden") {
      forbidden(res);
      return;
    }
    if (!target) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ target });
  };

  router.post("/activity/channel-target", resolveChannelTarget);

  router.post("/activity/conversation-target", brokerRequestLimit(1800), async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const target = await resolveAuthorizedConversationTarget(
      store,
      bound.gatewayId,
      stringBody(req, "agentId"),
      stringBody(req, "conversationId"),
    );
    if (target === "forbidden") {
      forbidden(res);
      return;
    }
    if (!target) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ target });
  });

  router.post("/activity/direct-conversation-target", (req, res) => {
    if (!boundGateway(req, res)) return;
    forbidden(res);
  });

  mountSessionContextRoute(router, deps);

  mountActivityReceiptRoutes(router, deps);

  router.post("/activity/channel-owner", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const ownerUid = await resolveChannelOwnerUid(store, bound.gatewayId, stringBody(req, "channelId"));
    if (ownerUid === "forbidden") {
      forbidden(res);
      return;
    }
    if (!ownerUid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ownerUid });
  });

  router.post("/activity/user-by-mm", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const uid = await resolveUidByMmUser(store, bound.gatewayId, stringBody(req, "mmUserId"));
    if (uid === "forbidden") {
      forbidden(res);
      return;
    }
    if (!uid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ uid });
  });
}

function mountActivityReceiptRoutes(router: Router, deps: RuntimeBrokerDeps): void {
  router.post("/activity/write-receipts/claim", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const input = receiptClaimInput(receiptBody(req));
    if (!input) {
      res.status(400).json({ error: "invalid_receipt_claim" });
      return;
    }
    const receipts = await receiptStoreFor(req, res, deps, bound);
    if (!receipts) return;
    try {
      const claim = await receipts.claim(input);
      res.json(claim);
    } catch (error) {
      respondReceiptStoreError(res, error);
    }
  });

  router.post("/activity/write-receipts/read", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const eventKey = receiptEventKey(receiptBody(req).eventKey);
    if (!eventKey) {
      res.status(400).json({ error: "invalid_receipt_event_key" });
      return;
    }
    const receipts = await receiptStoreFor(req, res, deps, bound);
    if (!receipts) return;
    try {
      const receipt = await receipts.read(eventKey);
      if (!receipt) {
        res.status(404).json({ error: "receipt_not_found" });
        return;
      }
      res.json({ receipt });
    } catch (error) {
      respondReceiptStoreError(res, error);
    }
  });

  router.post("/activity/write-receipts/mark-posted", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const body = receiptBody(req);
    const mutation = receiptMutation(body);
    const postId = receiptString(body, "postId");
    if (!mutation || !postId) {
      res.status(400).json({ error: "invalid_receipt_mark_posted" });
      return;
    }
    const receipts = await receiptStoreFor(req, res, deps, bound);
    if (!receipts) return;
    try {
      await receipts.markPosted(mutation.eventKey, mutation.leaseToken, postId, mutation.now);
      res.status(204).end();
    } catch (error) {
      respondReceiptStoreError(res, error);
    }
  });

  router.post("/activity/write-receipts/attachment", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const body = receiptBody(req);
    const mutation = receiptMutation(body);
    if (!mutation || !isValidActivityAttachmentReceipt(body.attachment)) {
      res.status(400).json({ error: "invalid_receipt_attachment" });
      return;
    }
    const receipts = await receiptStoreFor(req, res, deps, bound);
    if (!receipts) return;
    try {
      await receipts.updateAttachment(
        mutation.eventKey,
        mutation.leaseToken,
        body.attachment,
        mutation.now,
      );
      res.status(204).end();
    } catch (error) {
      respondReceiptStoreError(res, error);
    }
  });

  router.post("/activity/write-receipts/commit", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const mutation = receiptMutation(receiptBody(req));
    if (!mutation) {
      res.status(400).json({ error: "invalid_receipt_commit" });
      return;
    }
    const receipts = await receiptStoreFor(req, res, deps, bound);
    if (!receipts) return;
    try {
      await receipts.commit(mutation.eventKey, mutation.leaseToken, mutation.now);
      res.status(204).end();
    } catch (error) {
      respondReceiptStoreError(res, error);
    }
  });
}

async function activeReplyRecipient(store: PlatformStateStore, uid: string) {
  if (!safeDocId(uid)) return null;
  const recipient = await store.users.records.get(uid);
  const mmUserId = recipient?.mattermostUserId;
  if (!interactiveUser(recipient) || typeof mmUserId !== "string" || !MATTERMOST_ID_RE.test(mmUserId)) return null;
  return { uid, mmUserId };
}

async function projectMembershipAuthorized(store: PlatformStateStore, binding: BoundChannelPath, uid: string): Promise<boolean> {
  try {
    return await projectMemberExists(store, binding.workspaceSlug, binding.projectSlug!, uid);
  } catch (error) {
    if (!(error instanceof MalformedRecordError)) throw error;
    logger.warn("[openclaw-runtime-broker] refused a malformed project membership", { workspaceSlug: binding.workspaceSlug, projectSlug: binding.projectSlug, uid, detail: error.detail });
    return false;
  }
}

async function finalReplyMembershipAuthorized(deps: RuntimeBrokerDeps, target: AuthorizedConversationTarget, identity: FinalReplyIdentity, recipient: { uid: string; mmUserId: string }): Promise<boolean> {
  const binding = boundChannelPath(target.channelDocPath);
  if (!binding) return false;
  if (binding.lane === "project") {
    const [project, member] = await Promise.all([
      deps.store.workspaces.projects.get(binding.workspaceSlug, binding.projectSlug!),
      projectMembershipAuthorized(deps.store, binding, recipient.uid),
    ]);
    return project?.ownerUid === recipient.uid || member;
  }
  if (recipient.uid === identity.uid) return true;
  const membership = await deps.store.workspaces.members.get(binding.workspaceSlug, recipient.uid);
  return isCanonicalWorkspaceMembership(membership) && membership?.mattermostUserId === recipient.mmUserId;
}

async function resolveFinalReplyTarget(
  deps: RuntimeBrokerDeps,
  gatewayId: string,
  identity: FinalReplyIdentity,
  channelId: string,
  directPeerId?: string,
): Promise<FinalReplyTarget | null> {
  const owner = await activeReplyRecipient(deps.store, identity.uid);
  if (!owner) return null;
  if (directPeerId !== undefined) {
    if (parseAgentId(identity.agentId).kind !== "coach" || owner.mmUserId !== directPeerId || directPeerId === identity.defaultAgentMmUserId) return null;
    return { primaryChannelId: channelId, expectedChannelType: "D", expectedChannelName: null, expectedChannelTeamId: null,
      expectedMemberIds: [identity.defaultAgentMmUserId, directPeerId], recipientUid: identity.uid, recipientMmUserId: directPeerId };
  }
  const target = await resolveAuthorizedConversationTarget(deps.store, gatewayId, identity.agentId, channelId);
  if (!target || target === "forbidden") return null;
  const recipientUid = await resolveChannelOwnerUid(deps.store, gatewayId, channelId);
  if (!recipientUid || recipientUid === "forbidden") return null;
  const recipient = await activeReplyRecipient(deps.store, recipientUid);
  if (!recipient || recipient.mmUserId === identity.defaultAgentMmUserId || !await finalReplyMembershipAuthorized(deps, target, identity, recipient)) return null;
  return { ...target, recipientUid, recipientMmUserId: recipient.mmUserId };
}

function mountFinalReplyRoutes(router: Router, deps: RuntimeBrokerDeps): void {
  router.post("/notifications/final-reply", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;
    const body = { ...req.body };
    delete body.gatewayId;
    const input = parseFinalReply(body);
    if (!input) { res.status(422).json({ error: "invalid_final_reply" }); return; }
    try {
      await notifyNativeFinalReply(input, {
        resolveAgentIdentity: async agentId => {
          const identity = await resolveAgentIdentity(deps.store, bound.gatewayId, agentId);
          if (!identity || identity === "forbidden") return null;
          return { agentId: identity.agentId, uid: identity.uid, defaultAgentMmUserId: identity.coachMmUserId, coachToken: identity.coachToken };
        },
        resolveReplyTarget: (identity, channelId, peerId) => resolveFinalReplyTarget(deps, bound.gatewayId, identity, channelId, peerId),
        getPost: readFinalReplyPost,
        verifyChannel: verifyFinalReplyChannel,
        notify: (signal, uid) => deps.notifyFinalReply?.(signal, uid) ?? Promise.resolve(),
      });
      res.status(202).json({ accepted: true });
    } catch (error) {
      if (error instanceof ReplyBindingDeniedError) { res.status(403).json({ error: "reply_binding_denied" }); return; }
      logger.warn("Final reply notification failed", { messageId: input.messageId, error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: "reply_notification_unavailable", retryable: true });
    }
  });
}

export function createOpenClawRuntimeBrokerRoutes(opts: {
  store: PlatformStateStore;
  readSizingKey: SizingKeyReader;
  readSessionChannelPurpose?: SessionChannelPurposeReader;
  notifyFinalReply?: FinalReplyNotifier;
}): Router {
  const router = Router();
  const deps: RuntimeBrokerDeps = {
    store: opts.store,
    readSizingKey: opts.readSizingKey,
    readSessionChannelPurpose: opts.readSessionChannelPurpose ?? NO_SESSION_CHANNEL_PURPOSE,
    notifyFinalReply: opts.notifyFinalReply,
  };
  mountUserAndWsRoutes(router, deps);
  mountActivityRoutes(router, deps);
  mountFinalReplyRoutes(router, deps);
  return router;
}
