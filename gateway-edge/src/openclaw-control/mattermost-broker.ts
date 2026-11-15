import type {
  authorizeChannel,
  AuthorizedChannelCredentials,
  listWorkspaceChannelCandidates,
} from "../lib/channel-session-authorization.js";
import {
  ChannelSessionMattermostError,
  createChannelSessionMattermostClient,
} from "../lib/channel-session-model-control.js";
import { containsAsciiControlCharacter } from "@octogee/shared/types/text-validation";
import { postOpenClawControlBroker } from "./broker.js";
import type { OpenClawControlSession } from "./session.js";
import { watchMattermostChannelEvents } from "./mattermost-events.js";

const MATTERMOST_ID = /^[a-z0-9]{26}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !containsAsciiControlCharacter(value);
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 16 && value.length <= 4096 &&
    !containsAsciiControlCharacter(value) && !value.includes(" ");
}

function validCredentials(value: unknown, workspaceSlug: string): value is AuthorizedChannelCredentials {
  const body = record(value);
  const target = record(body?.target);
  return body?.forbidden === false && validToken(body.token) &&
    typeof body.callerMmUserId === "string" && MATTERMOST_ID.test(body.callerMmUserId) &&
    target?.workspaceSlug === workspaceSlug && identifier(target.ownerUid) && identifier(target.agentId) &&
    (target.projectId === undefined || identifier(target.projectId)) &&
    typeof target.agentMmUserId === "string" && MATTERMOST_ID.test(target.agentMmUserId);
}

export function createBrokeredMattermostAccess(
  session: OpenClawControlSession,
  options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): {
  authorize: typeof authorizeChannel;
  listWorkspaceChannels: typeof listWorkspaceChannelCandidates;
  watchChannel: (channelId: string, agentId: string, onChange: () => void, signal: AbortSignal) => Promise<void>;
} {
  const env = options.env ?? process.env;
  const binding = { gatewayId: session.gatewayId, revisionId: session.revisionId, sessionId: session.sessionId };
  function checkScope(uid: string, workspaceSlug: string | undefined): void {
    if (uid !== session.uid || workspaceSlug !== session.workspaceSlug) {
      throw new ChannelSessionMattermostError("Mattermost control session scope mismatch", 403);
    }
  }
  async function request(operation: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return postOpenClawControlBroker(`/internal/openclaw-control/mattermost/${operation}`,
      { ...binding, ...body }, env, options.fetchImpl, signal);
  }
  return {
    async watchChannel(channelId, agentId, onChange, signal) {
      const response = await request("authorize", { channelId, requireActiveLedger: true }, signal);
      if (!response.ok) throw new ChannelSessionMattermostError(`Mattermost event broker returned ${response.status}`);
      const access: unknown = await response.json();
      if (!validCredentials(access, session.workspaceSlug) || access.target.agentId !== agentId) {
        throw new ChannelSessionMattermostError("Mattermost event broker returned invalid credentials");
      }
      await watchMattermostChannelEvents({
        baseUrl: env.MM_INTERNAL_URL ?? "", token: access.token, channelId, onChange, signal,
      });
    },
    async authorize(uid, channelId, workspaceSlug, authorization = {}) {
      checkScope(uid, workspaceSlug);
      const response = await request("authorize", {
        channelId, requireActiveLedger: authorization.requireActiveLedger === true,
      }, authorization.signal);
      if (response.status === 403) return { forbidden: true };
      if (response.status === 404) return null;
      if (!response.ok) throw new ChannelSessionMattermostError(`Mattermost broker returned ${response.status}`);
      const access: unknown = await response.json();
      if (!validCredentials(access, session.workspaceSlug)) {
        throw new ChannelSessionMattermostError("Mattermost broker returned invalid credentials");
      }
      return {
        forbidden: false,
        target: access.target,
        callerMmUserId: access.callerMmUserId,
        client: createChannelSessionMattermostClient({
          baseUrl: env.MM_INTERNAL_URL ?? "", token: access.token, signal: authorization.signal,
        }),
      };
    },
    async listWorkspaceChannels(workspaceSlug, signal) {
      checkScope(session.uid, workspaceSlug);
      const response = await request("channels", {}, signal);
      if (!response.ok) throw new ChannelSessionMattermostError(`Mattermost broker returned ${response.status}`, response.status);
      const body: unknown = await response.json();
      if (!Array.isArray(body) || body.length > 512 || body.some((item) =>
        typeof record(item)?.channelId !== "string" || !MATTERMOST_ID.test(item.channelId)) ||
        new Set(body.map((item) => item.channelId)).size !== body.length) {
        throw new ChannelSessionMattermostError("Mattermost broker returned an invalid directory");
      }
      return body.map((item) => ({ channelId: item.channelId as string }));
    },
  };
}
