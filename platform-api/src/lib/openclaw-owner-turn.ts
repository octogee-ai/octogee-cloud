import type { Request } from "express";

import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";
import type { PlatformUserRecord, PlatformStateRepositories, WorkspaceChannel } from "@octogee/core/platform-state";
import {
  isValidCustomChannelName,
  parseAgentId,
  workspaceDefaultAgentMmUsername,
} from "@octogee/shared/types/identity";

import { isRunnableWorkspaceProject } from "./active-workspace-project.js";

const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/u;
const REQUEST_CONTEXT_FIELDS = new Set([
  "channel",
  "accountId",
  "requesterSenderId",
  "nativeChannelId",
  "to",
]);
const SCHEDULED_REQUEST_CONTEXT_FIELDS = new Set([
  "origin",
  "channel",
  "accountId",
  "requesterSenderId",
  "to",
]);

export type OwnerTurnUser = Pick<PlatformUserRecord, "workspaceId" | "mattermostUserId">;

export type OwnerTurnStore = Pick<PlatformStateRepositories, "workspaces">;

export interface OwnerWorkspaceTurnInput {
  req: Request;
  gatewayId: string;
  agentId: string;
  ownerUid: string;
  owner: OwnerTurnUser;
}

export type OwnerWorkspaceTurnVerifier = (
  input: OwnerWorkspaceTurnInput,
) => Promise<boolean>;

type OwnerWorkspaceRequestContext =
  | {
    origin: "turn";
    channel: "mattermost";
    accountId: string;
    requesterSenderId: string;
    nativeChannelId: string;
    routeKind: "user" | "channel";
    routeId: string;
  }
  | {
    origin: "scheduled";
    channel: "mattermost";
    accountId: string;
    requesterSenderId: string;
    routeKind: "user" | "channel";
    routeId: string;
  };

interface RequestContextRecord extends Record<string, unknown> {
  channel: "mattermost";
  accountId: string;
  requesterSenderId: string;
  nativeChannelId: string;
  to: string;
}

interface ScheduledRequestContextRecord extends Record<string, unknown> {
  origin: "scheduled";
  channel: "mattermost";
  accountId: string;
  requesterSenderId: string;
  to: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseQueryContext(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length > 2048) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function hasExactFields(context: Record<string, unknown>, fields: Set<string>): boolean {
  return Object.keys(context).length === fields.size
    && Object.keys(context).every((key) => fields.has(key));
}

function hasMattermostSender(context: Record<string, unknown>): boolean {
  return context.channel === "mattermost"
    && typeof context.accountId === "string"
    && typeof context.requesterSenderId === "string"
    && MATTERMOST_ID_RE.test(context.requesterSenderId)
    && typeof context.to === "string";
}

function isRequestContextRecord(
  context: Record<string, unknown> | null,
): context is RequestContextRecord {
  return Boolean(
    context
    && hasExactFields(context, REQUEST_CONTEXT_FIELDS)
    && hasMattermostSender(context)
    && typeof context.nativeChannelId === "string"
    && MATTERMOST_ID_RE.test(context.nativeChannelId),
  );
}

function isScheduledRequestContextRecord(
  context: Record<string, unknown> | null,
): context is ScheduledRequestContextRecord {
  return Boolean(
    context
    && hasExactFields(context, SCHEDULED_REQUEST_CONTEXT_FIELDS)
    && context.origin === "scheduled"
    && hasMattermostSender(context),
  );
}

function parseRoute(to: string): { routeKind: "user" | "channel"; routeId: string } | null {
  const separator = to.indexOf(":");
  if (separator < 0) return null;
  const routeKind = to.slice(0, separator);
  const routeId = to.slice(separator + 1);
  if (
    (routeKind !== "user" && routeKind !== "channel")
    || !MATTERMOST_ID_RE.test(routeId)
  ) return null;
  return { routeKind, routeId };
}

export function ownerWorkspaceRequestContext(req: Request): OwnerWorkspaceRequestContext | null {
  const body = record(req.body);
  const queryValue = req.query?.requestContext;
  const bodyHasContext = body && Object.hasOwn(body, "requestContext");
  if (bodyHasContext && queryValue !== undefined) return null;
  return parseOwnerWorkspaceRequestContext(body?.requestContext ?? parseQueryContext(queryValue));
}

export function parseOwnerWorkspaceRequestContext(value: unknown): OwnerWorkspaceRequestContext | null {
  const context = record(value);
  if (isScheduledRequestContextRecord(context)) {
    const route = parseRoute(context.to);
    return route
      ? {
        origin: "scheduled",
        channel: "mattermost",
        accountId: context.accountId,
        requesterSenderId: context.requesterSenderId,
        ...route,
      }
      : null;
  }
  if (!isRequestContextRecord(context)) return null;
  const route = parseRoute(context.to);
  if (!route) return null;

  return {
    origin: "turn",
    channel: "mattermost",
    accountId: context.accountId,
    requesterSenderId: context.requesterSenderId,
    nativeChannelId: context.nativeChannelId,
    ...route,
  };
}

function ownerMattermostUserIdOf(owner: OwnerTurnUser): string | null {
  const userId = owner.mattermostUserId;
  return userId !== null && MATTERMOST_ID_RE.test(userId) ? userId : null;
}

function directWorkspaceChannelName(channel: WorkspaceChannel, slug: string): string | null {
  if (channel.scope.workspaceSlug !== slug || channel.scope.projectSlug !== null) return null;
  const channelName = channel.channelId;
  if (
    channelName === "admin"
    || (
      channelName !== "general"
      && channelName !== "coach-dm"
      && !isValidCustomChannelName(channelName)
    )
  ) return null;
  return channelName;
}

async function workspaceChannelName(
  store: OwnerTurnStore,
  channelId: string,
  slug: string,
): Promise<string | null> {
  const channel = await store.workspaces.channels.findByMattermostChannelId(channelId);
  if (!channel || channel.archivedAt !== null) return null;
  return directWorkspaceChannelName(channel, slug);
}

async function isActiveWorkspaceMember(
  store: OwnerTurnStore,
  slug: string,
  senderId: string,
): Promise<boolean> {
  const senders = (await store.workspaces.members.list(slug))
    .filter((member) => member.mattermostUserId === senderId);
  return senders.length === 1 && isCanonicalWorkspaceMembership(senders[0]);
}

async function trustedWorkspaceSender(
  store: OwnerTurnStore,
  slug: string,
  owner: OwnerTurnUser,
  senderId: string,
): Promise<boolean> {
  if (ownerMattermostUserIdOf(owner) === senderId) return true;
  return isActiveWorkspaceMember(store, slug, senderId);
}

export function isOwnerDirectRoute(
  context: Pick<OwnerWorkspaceRequestContext, "routeKind" | "routeId" | "requesterSenderId">,
  owner: OwnerTurnUser,
): boolean {
  return context.routeKind === "user"
    && context.routeId === context.requesterSenderId
    && ownerMattermostUserIdOf(owner) === context.requesterSenderId;
}

export async function activeDefaultAgentChannelId(store: OwnerTurnStore, slug: string): Promise<string | null> {
  const channel = await store.workspaces.channels.get({ workspaceSlug: slug, projectSlug: null }, "coach-dm");
  const channelId = channel?.mattermostChannelId ?? null;
  return channel?.archivedAt === null && channelId !== null && MATTERMOST_ID_RE.test(channelId)
    ? channelId
    : null;
}

export async function isOwnerScheduledRoute(
  store: OwnerTurnStore,
  agentId: string,
  context: Pick<OwnerWorkspaceRequestContext, "routeKind" | "routeId" | "requesterSenderId">,
  owner: OwnerTurnUser,
): Promise<boolean> {
  if (isOwnerDirectRoute(context, owner)) return true;
  const parsed = parseAgentId(agentId);
  return parsed.kind === "coach"
    && context.routeKind === "channel"
    && ownerMattermostUserIdOf(owner) === context.requesterSenderId
    && context.routeId === await activeDefaultAgentChannelId(store, parsed.username);
}

export interface OwnerAutomationTurn {
  ownerMattermostUserId: string;
  coachChannelId: string;
}

export async function verifyOwnerAutomationTurn(
  store: OwnerTurnStore,
  input: {
    agentId: string;
    ownerUid: string;
    owner: OwnerTurnUser;
    requestContext: unknown;
  },
): Promise<OwnerAutomationTurn | null> {
  const parsed = parseAgentId(input.agentId);
  const context = parseOwnerWorkspaceRequestContext(input.requestContext);
  const ownerMattermostUserId = ownerMattermostUserIdOf(input.owner);
  if (
    parsed.kind !== "coach"
    || context?.origin !== "turn"
    || context.accountId !== workspaceDefaultAgentMmUsername(parsed.username)
    || input.owner.workspaceId !== parsed.username
    || !ownerMattermostUserId
    || context.requesterSenderId !== ownerMattermostUserId
  ) return null;
  const directRoute = context.routeKind === "user" && context.routeId === ownerMattermostUserId;
  const channelRoute = context.routeKind === "channel" && context.routeId === context.nativeChannelId;
  if (!directRoute && !channelRoute) return null;
  if (!await activeOwnedWorkspace(store, parsed.username, input.ownerUid)) return null;
  const coachChannelId = await activeDefaultAgentChannelId(store, parsed.username);
  return coachChannelId === context.nativeChannelId
    ? { ownerMattermostUserId, coachChannelId }
    : null;
}

export function createGoogleTurnVerifier(
  store: OwnerTurnStore,
): OwnerWorkspaceTurnVerifier {
  return async ({ req, agentId, ownerUid, owner }) => {
    const parsed = parseAgentId(agentId);
    const context = ownerWorkspaceRequestContext(req);
    if (
      parsed.kind !== "coach"
      || !context
      || context.accountId !== workspaceDefaultAgentMmUsername(parsed.username)
      || owner.workspaceId !== parsed.username
    ) return false;

    if (!await activeOwnedWorkspace(store, parsed.username, ownerUid)) return false;

    if (context.origin === "scheduled") return isOwnerScheduledRoute(store, agentId, context, owner);

    const channelName = await workspaceChannelName(
      store,
      context.nativeChannelId,
      parsed.username,
    );
    if (!channelName) return false;
    if (context.routeKind === "user") {
      return channelName === "coach-dm" && isOwnerDirectRoute(context, owner);
    }
    if (context.routeId !== context.nativeChannelId) return false;
    return trustedWorkspaceSender(store, parsed.username, owner, context.requesterSenderId);
  };
}

async function activeOwnedWorkspace(store: OwnerTurnStore, slug: string, ownerUid: string): Promise<boolean> {
  const workspace = await store.workspaces.records.get(slug);
  return workspace !== null && workspace.ownerUid === ownerUid && workspace.ownerActive === true;
}

export function createOwnerWorkspaceTurnVerifier(
  store: OwnerTurnStore,
): OwnerWorkspaceTurnVerifier {
  return async ({ agentId, ownerUid, owner }) => {
    const parsed = parseAgentId(agentId);
    if (parsed.kind !== "coach" || owner.workspaceId !== parsed.username) return false;
    return activeOwnedWorkspace(store, parsed.username, ownerUid);
  };
}

export function createProjectWorkspaceTurnVerifier(
  store: OwnerTurnStore,
): OwnerWorkspaceTurnVerifier {
  return async ({ agentId, ownerUid, owner }) => {
    const parsed = parseAgentId(agentId);
    if (parsed.kind !== "project" || owner.workspaceId !== parsed.username) return false;
    if (!await activeOwnedWorkspace(store, parsed.username, ownerUid)) return false;
    const project = await store.workspaces.projects.get(parsed.username, parsed.project);
    return project !== null && isRunnableWorkspaceProject(project, ownerUid);
  };
}

export function createAgentSupportTurnVerifier(
  store: OwnerTurnStore,
): OwnerWorkspaceTurnVerifier {
  const verifyDefaultAgent = createOwnerWorkspaceTurnVerifier(store);
  const verifyProject = createProjectWorkspaceTurnVerifier(store);
  return async (turn) => {
    const kind = parseAgentId(turn.agentId).kind;
    if (kind === "project") return verifyProject(turn);
    if (kind === "coach") return verifyDefaultAgent(turn);
    return false;
  };
}
