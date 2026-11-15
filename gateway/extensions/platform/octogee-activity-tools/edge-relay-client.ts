import { ActivityDeliveryError } from "./durable-outbox.js";
import type { AgentActivityAppend, SourceAgentEvent } from "./activity-types.js";
import type {
  DirectMattermostSessionCandidate,
  DirectMattermostSessionTarget,
} from "./activity-target.js";

export const ACTIVITY_INGEST_PATH = "/internal/openclaw/activity/v1/events";
export const DIRECT_ACTIVITY_TARGET_PATH = "/internal/openclaw/activity/v1/direct-target";
export const FINAL_REPLY_RELAY_PATH = "/internal/openclaw/notifications/v1/final-reply";

export interface NativeFinalReply {
  schemaVersion: 1;
  accountId: string;
  sessionKey: string;
  to: string;
  messageId: string;
}

export const VOICE_EVENT_RELAY_PATH = "/internal/openclaw/voice/v1/events";

export interface VoiceInboundEvent {
  kind: "inbound";
  messageId: string;
  sessionKey: string;
  ts: number;
}

export interface VoiceAgentEvent {
  kind: "agent";
  runId: string;
  stream: string;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
}

export type VoiceEvent = VoiceInboundEvent | VoiceAgentEvent;

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function directTarget(
  value: unknown,
  candidate: DirectMattermostSessionCandidate,
): DirectMattermostSessionTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = (value as { target?: unknown }).target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const record = target as Record<string, unknown>;
  if (
    record.sessionKey !== candidate.sessionKey
    || record.agentId !== candidate.agentId
    || record.rootPostId !== candidate.rootPostId
    || typeof record.conversationId !== "string"
    || !/^[a-z0-9]{26}$/u.test(record.conversationId)
    || (candidate.nativeChannelId && record.conversationId !== candidate.nativeChannelId)
  ) return null;
  return {
    sessionKey: candidate.sessionKey,
    agentId: candidate.agentId,
    conversationId: record.conversationId,
    rootPostId: candidate.rootPostId,
  };
}

function validActivityRootPostId(value: unknown, mainRootPostId: string): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value !== mainRootPostId;
}

async function assertActivityAcknowledgement(response: Response, item: AgentActivityAppend): Promise<void> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ActivityDeliveryError("activity intake returned malformed acknowledgement", true);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ActivityDeliveryError("activity intake returned malformed acknowledgement", true);
  }
  const body = value as Record<string, unknown>;
  const outcome = body.outcome;
  const postIds = body.postIds;
  const activityRootPostId = body.activityRootPostId;
  const validPostIds = Array.isArray(postIds)
    && postIds.every((postId) => typeof postId === "string" && postId.trim().length > 0);
  const validRootPostId = validActivityRootPostId(
    activityRootPostId,
    item.envelope.ref.mainRootPostId,
  );
  const validRootCreation = item.envelope.type !== "turn.started"
    || (Array.isArray(postIds) && postIds.length === 1 && postIds[0] === activityRootPostId);
  if (
    (outcome !== "persisted" && outcome !== "duplicate") ||
    !validPostIds ||
    !validRootPostId ||
    !validRootCreation
  ) {
    throw new ActivityDeliveryError("activity intake acknowledgement binding mismatch", true);
  }
}

export function configuredEdgeUrl(value: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const platformUrl = env.GATEWAY_EDGE_INTERNAL_URL?.trim();
  if (!platformUrl) throw new Error("platform gateway-edge URL is required");
  const platformOrigin = gatewayEdgeOrigin(platformUrl);
  if (typeof value !== "string" || value.trim().length === 0) return platformOrigin;
  const configuredOrigin = gatewayEdgeOrigin(value.trim());
  if (configuredOrigin !== platformOrigin) {
    throw new Error("gateway-edge URL must match the platform-owned internal origin");
  }
  return platformOrigin;
}

function gatewayEdgeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("platform gateway-edge URL is invalid");
  }
  const loopback = parsed.hostname === "127.0.0.1"
    || parsed.hostname === "localhost"
    || parsed.hostname === "[::1]";
  if (
    parsed.protocol !== "http:"
    || !loopback
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error("platform gateway-edge URL must be an HTTP loopback origin");
  }
  return parsed.origin;
}

export function podRelayToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCTOGEE_POD_RELAY_TOKEN?.trim() || env.OPENCLAW_GATEWAY_TOKEN?.trim() || "";
}

export function configuredGatewayToken(value: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const configured = typeof value === "string" && value.trim() ? value.trim() : podRelayToken(env);
  if (!configured) throw new Error("OpenClaw gateway token is required");
  return configured;
}

export function createEdgeRelayClient(params: {
  edgeUrl?: unknown;
  gatewayToken: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}) {
  const env = params.env ?? process.env;
  const edgeUrl = configuredEdgeUrl(params.edgeUrl, env);
  const gatewayToken = configuredGatewayToken(params.gatewayToken, env);
  const fetchImpl = params.fetchImpl ?? fetch;

  const post = async (path: string, body: unknown): Promise<Response> => fetchImpl(`${edgeUrl}${path}`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${gatewayToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    async resolveDirectActivityTarget(
      candidate: DirectMattermostSessionCandidate,
    ): Promise<DirectMattermostSessionTarget | null> {
      const response = await post(DIRECT_ACTIVITY_TARGET_PATH, candidate);
      if (response.status === 403 || response.status === 404 || response.status === 422) return null;
      if (!response.ok) throw new Error(`direct Activity target relay returned ${response.status}`);
      const value = await response.json().catch(() => null) as unknown;
      const resolved = directTarget(value, candidate);
      if (!resolved) throw new Error("direct Activity target relay returned malformed binding");
      return resolved;
    },
    async deliverActivity(item: AgentActivityAppend): Promise<void> {
      let response: Response;
      try {
        if (item.attachmentBody === undefined) {
          response = await post(ACTIVITY_INGEST_PATH, item.envelope);
        } else {
          const attachment = item.envelope.type === "item.completed" ? item.envelope.item.attachment : undefined;
          if (!attachment) throw new ActivityDeliveryError("activity attachment body requires attachment metadata", false);
          const form = new FormData();
          form.set("envelope", JSON.stringify(item.envelope));
          form.set("detail", new Blob([item.attachmentBody], { type: attachment.mediaType }), attachment.filename);
          response = await fetchImpl(`${edgeUrl}${ACTIVITY_INGEST_PATH}`, {
            method: "POST",
            redirect: "error",
            headers: { authorization: `Bearer ${gatewayToken}` },
            body: form,
          });
        }
      } catch (error) {
        if (error instanceof ActivityDeliveryError) throw error;
        throw new ActivityDeliveryError(
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
      if (response.ok) {
        await assertActivityAcknowledgement(response, item);
        return;
      }
      throw new ActivityDeliveryError(`activity intake returned ${response.status}`, retryableStatus(response.status));
    },
    async publishFinalReply(input: NativeFinalReply): Promise<void> {
      const response = await post(FINAL_REPLY_RELAY_PATH, input);
      if (!response.ok) throw new Error(`reply relay returned ${response.status}`);
    },
    async publishVoice(agentId: string, event: VoiceEvent): Promise<void> {
      const response = await post(VOICE_EVENT_RELAY_PATH, { schemaVersion: 1, agentId, event });
      if (!response.ok) throw new Error(`voice relay returned ${response.status}`);
    },
    async heartbeat(agentId: string, ts: number): Promise<void> {
      const response = await post(VOICE_EVENT_RELAY_PATH, { schemaVersion: 1, agentId, kind: "ready", ts });
      if (!response.ok) throw new Error(`voice relay returned ${response.status}`);
    },
    voiceAgentEvent(event: SourceAgentEvent): VoiceAgentEvent {
      return {
        kind: "agent",
        runId: event.runId,
        stream: event.stream,
        ts: event.ts ?? Date.now(),
        ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
        data: event.data,
      };
    },
  };
}
