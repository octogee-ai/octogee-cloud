import { assertWorkspaceIdentityReady } from "@octogee/core/openclaw-workspace-bootstrap";
import { deriveDeviceIdentity } from "@octogee/shared/types/device-identity";
import { OPENCLAW_EDGE_SERVICE_IDENTITY, openClawDeviceSubject, openClawProxyIdentityHeaders, openClawProxyOrigin } from "@octogee/shared/types/openclaw-proxy-identity";
import { WebSocket } from "ws";
import { isMattermostPostId, parseChannelScopedMattermostSessionRoute } from "@octogee/shared/types/mattermost-session-route";
import { resolveToolConversationForUid, resolveToolChannelForUid } from '../lib/tool-conversation.js';
import { attachUpstreamRpcClient } from "@octogee/core/http-candidates/chat-proxy/openclaw/bridge-upstream-rpc";
import { openProxyIdentitySocket, podClientAddress, signedInProfile } from "@octogee/core/http-candidates/openclaw-control/proxy-identity";
import { openClawControlUpstreamBase } from "./surface.js";
import { synchronizeChannelMembership } from "@octogee/core/http-candidates/openclaw-control/channel-membership-sync";
import { resolveVoiceConversation } from '@octogee/core/voice-conversation';
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export interface NativeUserSocket { ws: WebSocket; scopes: Set<string> }
interface NativeUserSocketOptions { caps?: readonly string[]; channelSessionKey?: string; threadRootPostId?: string; purpose?: 'voice' }

async function authorizedChannel(options: NativeUserSocketOptions, claim: { uid: string; gatewayId: string; channelId: string; expectedAgentId: string; env: NodeJS.ProcessEnv }) {
  if (options.purpose === 'voice') return resolveVoiceConversation({ ...claim, threadRootPostId: options.threadRootPostId! });
  if (options.threadRootPostId === undefined) return resolveToolChannelForUid(claim);
  return resolveToolConversationForUid({ ...claim, threadRootPostId: options.threadRootPostId });
}

function nativeChannelIdentity(options: NativeUserSocketOptions) {
  const channel = options.channelSessionKey === undefined ? null : parseChannelScopedMattermostSessionRoute(options.channelSessionKey);
  if ((options.channelSessionKey !== undefined && !channel) || (options.threadRootPostId !== undefined && (!channel || !isMattermostPostId(options.threadRootPostId)))) throw new Error("Invalid native channel identity");
  return channel;
}

async function synchronizeConnectedChannelMembership(input: {
  ws: WebSocket;
  channel: NonNullable<ReturnType<typeof parseChannelScopedMattermostSessionRoute>>;
  url: URL;
  headers: Record<string, string>;
  reauthorize(): Promise<void>;
}): Promise<void> {
  const user = attachUpstreamRpcClient(input.ws, { timeoutMs: 30_000 });
  const member = await signedInProfile(user).finally(() => user.dispose());
  const service = await openProxyIdentitySocket({ url: input.url, headers: input.headers, timeoutMs: 5000 });
  const rpc = attachUpstreamRpcClient(service, { timeoutMs: 30_000 });
  try {
    if (input.ws.readyState !== WebSocket.OPEN) throw new Error("Native user connection closed during channel synchronization");
    await input.reauthorize();
    await synchronizeChannelMembership(rpc, input.channel, member.id, true);
    if (input.ws.readyState !== WebSocket.OPEN) throw new Error("Native user connection closed during channel synchronization");
  } finally {
    rpc.dispose();
    service.close();
  }
}

export async function openNativeUserSocket(uid: string, gatewayId: string, env: NodeJS.ProcessEnv = process.env, options: NativeUserSocketOptions = {}): Promise<NativeUserSocket> {
  if (env.OPENCLAW_CONTROL_IDENTITY !== "per-user" || !isIsolatedGatewayClassValue(env.GATEWAY_CLASS) || env.GATEWAY_ID !== gatewayId) {
    throw new Error("Native workspace permissions require the local per-user isolated gateway");
  }
  const channel = nativeChannelIdentity(options);
  if (options.purpose === 'voice' && (!channel || !options.threadRootPostId)) throw new Error('Voice requires a bound conversation');
  const reauthorize = async () => { if (channel) {
    const claim = { uid, gatewayId, channelId: channel.primaryChannelId, expectedAgentId: channel.agentId, env };
    const current = await authorizedChannel(options, claim);
    if (current.sessionKey !== options.channelSessionKey) throw new Error('Native conversation authority changed');
  } };
  await reauthorize();
  const secret = env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!secret) throw new Error("OPENCLAW_GATEWAY_TOKEN is required");
  const url = new URL("/", openClawControlUpstreamBase(env)); url.protocol = "ws:";
  const headers = (user: string) => ({ ...openClawProxyIdentityHeaders({ user, clientAddress: podClientAddress() }), origin: openClawProxyOrigin(env) });
  assertWorkspaceIdentityReady(env);
  let scopes: string[] = [];
  const ws = await openProxyIdentitySocket({ url, headers: headers(uid), timeoutMs: 30_000,
    identity: deriveDeviceIdentity({ secret, subject: openClawDeviceSubject(gatewayId, uid) }),
    onScopes: value => { scopes = value; },
    caps: options.caps,
  });
  try {
    if (channel) {
      await synchronizeConnectedChannelMembership({ ws, channel, url, headers: headers(OPENCLAW_EDGE_SERVICE_IDENTITY), reauthorize });
    }
    return { ws, scopes: new Set(scopes) };
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

export async function openNativeUserClient(uid: string, gatewayId: string, env: NodeJS.ProcessEnv = process.env) {
  const { ws, scopes } = await openNativeUserSocket(uid, gatewayId, env);
  const rpc = attachUpstreamRpcClient(ws, { timeoutMs: 5000 });
  return { scopes, call: rpc.call, close: () => { rpc.dispose(); ws.close(); } };
}
