import { ReplyBindingDeniedError, type NativeFinalReply } from "@octogee/core/native-final-reply";
import { internalFetch } from "@octogee/core/internal-fetch";
import { sidecarBrokerHeaders } from "@octogee/core/internal-fetch";
import type { ActivityConversation } from '../../lib/activity-conversation.js';
import { isMattermostPostId, parseChannelScopedMattermostSessionRoute, parseMattermostSessionRoute } from '@octogee/shared/types/mattermost-session-route';
import { parseAgentId } from '@octogee/shared/types/identity';
import type {
  AgentIdentity,
  AuthorizedConversationTarget,
} from "./activity-runtime-types.js";
import {
  ActivityReceiptConflictError,
  ActivityReceiptLeaseError,
  ActivityReceiptUnavailableError,
  type ActivityAttachmentReceiptV1,
  type ActivityReceiptClaim,
  type ActivityReceiptClaimInput,
  type ActivityWriteReceiptStore,
  type ActivityWriteReceiptV1,
} from "./activity-write-receipts.js";
import {
  BrokeredActivityWriteReceiptStore,
  type ActivityWriteReceiptBrokerPort,
} from "./activity-write-receipt-broker.js";

function voiceSessionMatches(sessionKey: unknown, expectedAgentId: string, workspaceSlug: unknown, channelId: unknown): boolean {
  const agent = parseAgentId(expectedAgentId);
  const route = parseChannelScopedMattermostSessionRoute(sessionKey);
  return agent.kind !== 'unknown' && agent.username === workspaceSlug && route?.agentId === expectedAgentId && route.primaryChannelId === channelId;
}

function voiceRedeemScope(body: Record<string, unknown> | null, expectedAgentId: string): RedeemedOpenClawWs["voiceConversation"] {
  const scope = body?.voiceConversation as Record<string, unknown> | undefined;
  if (!scope || typeof scope.ownerUid !== "string" || !scope.ownerUid || scope.ownerUid.length > 128 || scope.ownerUid.includes("/") ||
    typeof scope.workspaceSlug !== "string" || !/^[a-z0-9-]{1,64}$/u.test(scope.workspaceSlug) ||
    !isMattermostPostId(scope.channelId) || !isMattermostPostId(scope.threadRootPostId) ||
    !voiceSessionMatches(scope.sessionKey, expectedAgentId, scope.workspaceSlug, scope.channelId)) {
    throw new OpenClawRuntimeBrokerError(502, "malformed redeem response");
  }
  return { ownerUid: scope.ownerUid, workspaceSlug: scope.workspaceSlug, channelId: scope.channelId, threadRootPostId: scope.threadRootPostId, sessionKey: scope.sessionKey as string };
}

function activitySessionMatches(sessionKey: string, agentId: string, channelId: string, threadRootPostId: string | undefined): boolean {
  const route = parseMattermostSessionRoute(sessionKey);
  if (!route || route.agentId !== agentId || !isMattermostPostId(route.primaryChannelId)) return false;
  return route.peerKind === 'direct'
    ? threadRootPostId !== undefined && route.threadRootPostId === threadRootPostId
    : route.primaryChannelId === channelId && route.threadRootPostId === undefined;
}

function isOwnerUid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('/');
}

function isOptionalThreadRootPostId(value: unknown): value is string | undefined {
  return value === undefined || isMattermostPostId(value);
}

function isActivityAgentId(value: unknown, expectedAgentId: string | undefined): value is string {
  return typeof value === 'string' && /^octogee-[a-z0-9-]+$/u.test(value) && (expectedAgentId === undefined || value === expectedAgentId);
}

function parseActivityConversation(value: unknown, gatewayId: string, expectedAgentId?: string): ActivityConversation {
  const scope = value as Partial<ActivityConversation> | null;
  if (!scope || scope.gatewayId !== gatewayId || !isOwnerUid(scope.ownerUid) || !isMattermostPostId(scope.channelId) ||
    !isOptionalThreadRootPostId(scope.threadRootPostId) || !isActivityAgentId(scope.expectedAgentId, expectedAgentId) ||
    typeof scope.sessionKey !== 'string' || !activitySessionMatches(scope.sessionKey, scope.expectedAgentId, scope.channelId, scope.threadRootPostId)) {
    throw new OpenClawRuntimeBrokerError(502, 'malformed Activity conversation');
  }
  return { gatewayId, ownerUid: scope.ownerUid, channelId: scope.channelId, ...(scope.threadRootPostId === undefined ? {} : { threadRootPostId: scope.threadRootPostId }), expectedAgentId: scope.expectedAgentId, sessionKey: scope.sessionKey };
}

export interface RedeemedOpenClawWs {
  uid: string;
  gatewayId: string;
  gatewayUrl: string;
  expectedAgentId: string;
  activityConversation?: ActivityConversation;
  voiceConversation?: { ownerUid: string; workspaceSlug: string; channelId: string; threadRootPostId: string; sessionKey: string };
  voiceGrant?: string;
  voiceGrantExpiresAt?: number;
}

function voiceRedeemCustody(body: Record<string, unknown> | null, expectedAgentId: string) {
  if (typeof body?.voiceGrant !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(body.voiceGrant) ||
    typeof body.voiceGrantExpiresAt !== "number" || !Number.isSafeInteger(body.voiceGrantExpiresAt) || body.voiceGrantExpiresAt <= Date.now()) {
    throw new OpenClawRuntimeBrokerError(502, "malformed redeem response");
  }
  return { voiceGrant: body.voiceGrant, voiceGrantExpiresAt: body.voiceGrantExpiresAt, voiceConversation: voiceRedeemScope(body, expectedAgentId) };
}

// Redeem is a three-way outcome, not a nullable success. `revision-unavailable`
// is the octogee-api 502 (gateway-url-unresolved / dead-revision): an EXPECTED,
// distinguishable, retryable signal — the serving revision is not resolvable yet
// (mid-roll or just-retired), so the client must retry after the roll settles,
// NOT see an opaque 500. `unauthorized` folds 401/403/404 (bad/expired ticket,
// wrong gateway) into the 401 the upgrade surface already returns.
export type RedeemableWsTicketPurpose = "openclaw-ws" | "voice-ws";

export type RedeemOpenClawWsOutcome =
  | { kind: "redeemed"; redeemed: RedeemedOpenClawWs }
  | { kind: "unauthorized" }
  | { kind: "revision-unavailable"; reason: string };

interface ChatActivityReportBase {
  channelId: string;
  postId: string;
  mmUserId: string;
}

export type ChatActivityReport =
  | (ChatActivityReportBase & { kind: "post" })
  | (ChatActivityReportBase & { kind: "reaction"; emojiName: string; createdAt: number });

export interface OpenClawRuntimeBroker {
  getActivityConversation?(uid: string, channelId: string, threadRootPostId?: string): Promise<ActivityConversation | null>;
  notifyFinalReply(input: NativeFinalReply): Promise<void>;
  redeemOpenClawWs(ticketId: string, purpose?: RedeemableWsTicketPurpose): Promise<RedeemOpenClawWsOutcome>;
  authorizePreviewAccess(uid: string, workspaceSlug: string, projectSlug: string | null): Promise<boolean>;
  getUserGatewayId(uid: string): Promise<string | null>;
  resolveAgentIdentity(agentId: string): Promise<AgentIdentity | null>;
  resolveConversationTarget(
    agentId: string,
    conversationId: string,
  ): Promise<AuthorizedConversationTarget | null>;
  resolveDirectConversationTarget(
    agentId: string,
    conversationId: string,
    ownerUserId: string,
  ): Promise<AuthorizedConversationTarget | null>;
  activityWriteReceiptsFor(channelDocPath: string): ActivityWriteReceiptStore;
  resolveChannelOwnerUid(channelId: string): Promise<string | null>;
  resolveOctogeeUidByMmUser(mmUserId: string): Promise<string | null>;
  requestChatActivityDemand(activity: ChatActivityReport): Promise<Record<string, unknown>>;
}

export class OpenClawRuntimeBrokerError extends Error {
  override readonly name = "OpenClawRuntimeBrokerError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function trimBaseUrl(baseUrl: string): string {
  let base = baseUrl.trim();
  while (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function runtimeBrokerBaseUrlFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = nonBlank(env.OPENCLAW_RUNTIME_BROKER_URL);
  if (explicit) return explicit;
  throw new Error("OPENCLAW_RUNTIME_BROKER_URL is required");
}

async function readJsonOrNull(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(body: Record<string, unknown> | null, name: string): string | null {
  const value = body?.[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectField(body: Record<string, unknown> | null, name: string): Record<string, unknown> | null {
  const value = body?.[name];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readReceipt(body: Record<string, unknown> | null): ActivityWriteReceiptV1 {
  const receipt = objectField(body, "receipt");
  if (!receipt) throw new OpenClawRuntimeBrokerError(502, "malformed receipt response");
  return receipt as unknown as ActivityWriteReceiptV1;
}

function readReceiptClaim(body: Record<string, unknown> | null): ActivityReceiptClaim {
  const outcome = stringField(body, "outcome");
  const receipt = readReceipt(body);
  if (outcome === "duplicate") return { outcome, receipt };
  if (outcome === "claimed" && typeof body?.recovered === "boolean") {
    return { outcome, receipt, recovered: body.recovered };
  }
  throw new OpenClawRuntimeBrokerError(502, "malformed receipt claim response");
}

function receiptBrokerError(error: string | null): Error {
  if (error === "receipt_conflict") {
    return new ActivityReceiptConflictError("event-key payload digest conflict");
  }
  if (error === "receipt_leased") {
    return new ActivityReceiptLeaseError("Activity receipt is leased by another writer");
  }
  return new ActivityReceiptUnavailableError("Activity receipt broker request failed");
}

type BrokerPost = (
  path: string,
  body: Record<string, unknown>,
  expected: ReadonlySet<number>,
) => Promise<Response>;

function createActivityWriteReceiptBrokerPort(post: BrokerPost): ActivityWriteReceiptBrokerPort {
  const receiptRequest = async (
    path: string,
    body: Record<string, unknown>,
    success: ReadonlySet<number>,
  ): Promise<Response> => {
    const res = await post(
      path,
      body,
      new Set([...success, 400, 403, 404, 409, 422]),
    );
    if (success.has(res.status)) return res;
    throw receiptBrokerError(stringField(await readJsonOrNull(res), "error"));
  };

  return {
    async claimActivityWriteReceipt(
      channelDocPath: string,
      input: ActivityReceiptClaimInput,
    ): Promise<ActivityReceiptClaim> {
      const body = await readJsonOrNull(await receiptRequest(
        "/internal/openclaw/activity/write-receipts/claim",
        { channelDocPath, input },
        new Set([200]),
      ));
      return readReceiptClaim(body);
    },
    async readActivityWriteReceipt(
      channelDocPath: string,
      eventKey: string,
    ): Promise<ActivityWriteReceiptV1 | null> {
      const res = await receiptRequest(
        "/internal/openclaw/activity/write-receipts/read",
        { channelDocPath, eventKey },
        new Set([200, 404]),
      );
      if (res.status === 404) return null;
      return readReceipt(await readJsonOrNull(res));
    },
    async markActivityWriteReceiptPosted(
      channelDocPath: string,
      eventKey: string,
      leaseToken: string,
      postId: string,
      now: number,
    ): Promise<void> {
      await receiptRequest(
        "/internal/openclaw/activity/write-receipts/mark-posted",
        { channelDocPath, eventKey, leaseToken, postId, now },
        new Set([204]),
      );
    },
    async updateActivityWriteReceiptAttachment(
      channelDocPath: string,
      eventKey: string,
      leaseToken: string,
      attachment: ActivityAttachmentReceiptV1,
      now: number,
    ): Promise<void> {
      await receiptRequest(
        "/internal/openclaw/activity/write-receipts/attachment",
        { channelDocPath, eventKey, leaseToken, attachment, now },
        new Set([204]),
      );
    },
    async commitActivityWriteReceipt(
      channelDocPath: string,
      eventKey: string,
      leaseToken: string,
      now: number,
    ): Promise<void> {
      await receiptRequest(
        "/internal/openclaw/activity/write-receipts/commit",
        { channelDocPath, eventKey, leaseToken, now },
        new Set([204]),
      );
    },
  };
}

export const CHAT_DEMAND_UNAVAILABLE = "chat-demand-unavailable";

export function createOpenClawRuntimeBroker(opts: {
  baseUrl: string;
  gatewayId: string;
  fetchImpl?: typeof fetch;
  sidecarBrokerHeaders?: () => Promise<Record<string, string>>;
}): OpenClawRuntimeBroker {
  const baseUrl = trimBaseUrl(opts.baseUrl);
  const gatewayId = opts.gatewayId;
  const credentialHeaders = opts.sidecarBrokerHeaders ?? sidecarBrokerHeaders;

  const post = async (
    path: string,
    body: Record<string, unknown>,
    expected: ReadonlySet<number>,
  ): Promise<Response> => {
    const credentialCapability = path === "/internal/openclaw/activity/agent-identity"
      ? await credentialHeaders()
      : {};
    const res = await internalFetch(
      `${baseUrl}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...credentialCapability },
        body: JSON.stringify({ gatewayId, ...body }),
      },
      { fetchImpl: opts.fetchImpl },
    );
    if (!expected.has(res.status)) {
      const details = await readJsonOrNull(res);
      const message = stringField(details, "error") ?? `broker HTTP ${res.status}`;
      throw new OpenClawRuntimeBrokerError(res.status, message);
    }
    return res;
  };

  const postJson = async (
    path: string,
    body: Record<string, unknown>,
    expected: ReadonlySet<number>,
  ): Promise<Record<string, unknown> | null> => {
    const res = await post(path, body, expected);
    if (res.status === 204 || res.status === 404) return null;
    return readJsonOrNull(res);
  };

  const receiptPort = createActivityWriteReceiptBrokerPort(post);

  return {
    async redeemOpenClawWs(
      ticketId: string,
      purpose: RedeemableWsTicketPurpose = "openclaw-ws",
    ): Promise<RedeemOpenClawWsOutcome> {
      // 502 is EXPECTED (revision unresolvable / dead), not a thrown error — the
      // upgrade surface turns it into a retryable roll-in-progress signal.
      const res = await post(
        "/internal/openclaw/ws/redeem",
        { ticketId, purpose },
        new Set([200, 401, 403, 404, 502]),
      );
      if (res.status === 502) {
        const body = await readJsonOrNull(res);
        return {
          kind: "revision-unavailable",
          reason: stringField(body, "error") ?? "gateway-url-unresolved",
        };
      }
      if (res.status !== 200) return { kind: "unauthorized" };
      const body = await readJsonOrNull(res);
      const uid = stringField(body, "uid");
      const redeemedGatewayId = stringField(body, "gatewayId");
      const gatewayUrl = stringField(body, "gatewayUrl");
      const expectedAgentId = stringField(body, "expectedAgentId");
      if (!uid || !redeemedGatewayId || !gatewayUrl || !expectedAgentId) {
        throw new OpenClawRuntimeBrokerError(502, "malformed redeem response");
      }
      return {
        kind: "redeemed",
        redeemed: { uid, gatewayId: redeemedGatewayId, gatewayUrl, expectedAgentId, ...(body?.activityConversation ? { activityConversation: parseActivityConversation(body.activityConversation, redeemedGatewayId, expectedAgentId) } : {}), ...(purpose === "voice-ws" ? voiceRedeemCustody(body, expectedAgentId) : {}) },
      };
    },
    async getActivityConversation(uid, channelId, threadRootPostId) {
      const response = await post('/internal/openclaw/activity/conversation-access', { uid, channelId, ...(threadRootPostId === undefined ? {} : { threadRootPostId }) }, new Set([200, 403, 404]));
      if (response.status !== 200) return null;
      return parseActivityConversation(await readJsonOrNull(response), gatewayId);
    },
    async authorizePreviewAccess(
      uid: string,
      workspaceSlug: string,
      projectSlug: string | null,
    ): Promise<boolean> {
      const res = await post(
        "/internal/openclaw/previews/authorize",
        { uid, workspaceSlug, projectSlug },
        new Set([200, 403]),
      );
      if (res.status === 403) return false;
      const body = await readJsonOrNull(res);
      if (typeof body?.authorized !== "boolean") {
        throw new OpenClawRuntimeBrokerError(502, "malformed preview authorization response");
      }
      return body.authorized;
    },
    async notifyFinalReply(input: NativeFinalReply): Promise<void> {
      const response = await post("/internal/openclaw/notifications/final-reply", { ...input }, new Set([202, 403]));
      if (response.status === 403) throw new ReplyBindingDeniedError();
    },
    async getUserGatewayId(uid: string): Promise<string | null> {
      const body = await postJson(
        "/internal/openclaw/users/gateway-id",
        { uid },
        new Set([200, 404]),
      );
      return stringField(body, "gatewayId");
    },
    async resolveAgentIdentity(agentId: string): Promise<AgentIdentity | null> {
      const body = await postJson(
        "/internal/openclaw/activity/agent-identity",
        { agentId },
        new Set([200, 404]),
      );
      return (body?.identity as AgentIdentity | undefined) ?? null;
    },
    async resolveConversationTarget(
      agentId: string,
      conversationId: string,
    ): Promise<AuthorizedConversationTarget | null> {
      const body = await postJson(
        "/internal/openclaw/activity/conversation-target",
        { agentId, conversationId },
        new Set([200, 404]),
      );
      return (body?.target as AuthorizedConversationTarget | undefined) ?? null;
    },
    async resolveDirectConversationTarget(
      agentId: string,
      conversationId: string,
      ownerUserId: string,
    ): Promise<AuthorizedConversationTarget | null> {
      const body = await postJson(
        "/internal/openclaw/activity/direct-conversation-target",
        { agentId, conversationId, ownerUserId },
        new Set([200, 403, 404]),
      );
      return (body?.target as AuthorizedConversationTarget | undefined) ?? null;
    },
    activityWriteReceiptsFor(channelDocPath: string): ActivityWriteReceiptStore {
      return new BrokeredActivityWriteReceiptStore(receiptPort, channelDocPath);
    },
    async resolveChannelOwnerUid(channelId: string): Promise<string | null> {
      const body = await postJson(
        "/internal/openclaw/activity/channel-owner",
        { channelId },
        new Set([200, 404]),
      );
      return stringField(body, "ownerUid");
    },
    async resolveOctogeeUidByMmUser(mmUserId: string): Promise<string | null> {
      const body = await postJson(
        "/internal/openclaw/activity/user-by-mm",
        { mmUserId },
        new Set([200, 404]),
      );
      return stringField(body, "uid");
    },
    async requestChatActivityDemand(
      activity: ChatActivityReport,
    ): Promise<Record<string, unknown>> {
      const res = await post(
        "/internal/openclaw/activity/chat-demand",
        { ...activity },
        new Set([200, 202, 404]),
      );
      const body = await readJsonOrNull(res);
      if (res.status === 404) {
        return stringField(body, "error") === "not_found"
          ? { recorded: false, reason: "channel-not-found" }
          : { recorded: false, reason: CHAT_DEMAND_UNAVAILABLE };
      }
      if (!body) throw new OpenClawRuntimeBrokerError(502, "malformed chat demand response");
      return body;
    },
  };
}

export function createOpenClawRuntimeBrokerFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenClawRuntimeBroker {
  const baseUrl = runtimeBrokerBaseUrlFromEnv(env);
  const gatewayId = nonBlank(env.GATEWAY_ID);
  if (!gatewayId) throw new Error("GATEWAY_ID is required for OpenClaw runtime broker");
  return createOpenClawRuntimeBroker({ baseUrl, gatewayId });
}
