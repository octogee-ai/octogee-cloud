import type { WebSocket } from "ws";
import type { UpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";

export interface ChannelAgentScope {
  workspaceId: string;
  project: string | null;
  channelId: string;
  peerKind: "group" | "channel";
  agentId: string;
}

interface ReadinessSnapshot {
  config: unknown;
  channels: unknown;
  models: unknown;
  session: unknown;
}

function selectedProviders(scope: ChannelAgentScope, snapshot: ReadinessSnapshot, model: unknown, fallbacks: unknown): string[] {
  const session = record(snapshot.session).session;
  if (session !== null) {
    const live = record(session);
    if (live.key !== `agent:${scope.agentId}:mattermost:${scope.peerKind}:${scope.channelId}` ||
        typeof live.modelProvider !== "string" || !live.modelProvider ||
        typeof live.model !== "string" || !live.model) return [];
    return [live.modelProvider];
  }
  const primary = typeof model === "string" ? model : record(model).primary;
  if (typeof primary !== "string" || !primary.includes("/")) return [];
  return [primary, ...(Array.isArray(fallbacks) ? fallbacks : [])]
    .filter((ref): ref is string => typeof ref === "string" && ref.includes("/"))
    .map(ref => ref.split("/")[0]);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function channelAgentReady(scope: ChannelAgentScope, snapshot: ReadinessSnapshot): boolean {
  const state = record(snapshot.config);
  if (typeof state.configRevisionHash !== "string" || !state.configRevisionHash ||
      state.appliedConfigHash !== state.configRevisionHash) return false;
  const config = record(state.config);
  const accountId = scope.project ? `${scope.workspaceId}-proj-${scope.project}` : `${scope.workspaceId}-coach`;
  const entries = record(record(config.agents).entries);
  const agent = record(entries[scope.agentId]);
  const defaultModel = record(record(config.agents).defaults).model;
  const model = agent.model ?? defaultModel;
  const selected = selectedProviders(scope, snapshot, model, record(agent.model).fallbacks ?? record(defaultModel).fallbacks);
  const providers = record(snapshot.models).providers;
  if (!Array.isArray(providers) || !providers.some((value) => {
    const health = record(value);
    return selected.includes(String(health.provider)) && ["static", "ok", "expiring"].includes(String(health.status));
  })) return false;
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];
  const routed = bindings.some((value) => {
    const binding = record(value);
    const match = record(binding.match);
    const peer = record(match.peer);
    return binding.agentId === scope.agentId && entries[scope.agentId] !== undefined &&
      match.channel === "mattermost" && match.accountId === accountId &&
      peer.kind === "group" && peer.id === scope.channelId;
  });
  const accounts = record(record(snapshot.channels).channelAccounts).mattermost;
  return routed && Array.isArray(accounts) && accounts.some((value) => {
    const account = record(value);
    return account.accountId === accountId && account.running === true && account.connected === true;
  });
}

async function readNativeReadiness(scope: ChannelAgentScope, timeoutMs: number): Promise<ReadinessSnapshot> {
  const { openAuthenticatedUpstream } = await import("../chat-proxy/openclaw/authenticated-upstream.js");
  const { attachUpstreamRpcClient } = await import("../chat-proxy/openclaw/bridge-upstream-rpc.js");
  let ws: WebSocket | undefined;
  let rpc: UpstreamRpcClient | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const snapshot = async (): Promise<ReadinessSnapshot> => {
    const opened = await openAuthenticatedUpstream({
      gatewayId: process.env.GATEWAY_ID ?? "",
      url: process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789",
      timeoutMs,
    });
    if (expired) {
      opened.close();
      throw new Error("Channel readiness timed out");
    }
    ws = opened;
    rpc = attachUpstreamRpcClient(ws, { timeoutMs });
    const config = await rpc.call("config.get", {});
    if (!config.ok) throw new Error(`Channel routing config read failed: ${config.reason}`);
    const channels = await rpc.call("channels.status", {});
    if (!channels.ok) throw new Error(`Channel routing status read failed: ${channels.reason}`);
    const session = await rpc.call("sessions.describe", {
      key: `agent:${scope.agentId}:mattermost:${scope.peerKind}:${scope.channelId}`, agentId: scope.agentId,
    });
    if (!session.ok) throw new Error(`Channel session model read failed: ${session.reason}`);
    const models = await rpc.call("models.authStatus", { agentId: scope.agentId });
    if (!models.ok) throw new Error(`Channel model readiness read failed: ${models.reason}`);
    return { config: config.result, channels: channels.result, models: models.result, session: session.result };
  };
  try {
    return await Promise.race([
      snapshot(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error("Channel readiness timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    rpc?.dispose();
    ws?.close();
  }
}

export type ReadinessFailureReason = "agent-repair-required" | "agent-starting" | "platform-unavailable" | "unavailable";

export function readinessFailureReason(error: unknown): ReadinessFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/doctor --fix|publication was superseded|Sessions remain unavailable|agent database/i.test(message)) return "agent-repair-required";
  if (/ECONNREFUSED|ECONNRESET|timed out|timeout|not initialized|starting/i.test(message)) return "agent-starting";
  return "unavailable";
}

export async function readChannelAgentReadiness(scope: ChannelAgentScope): Promise<boolean> {
  return channelAgentReady(scope, await readNativeReadiness(scope, 25_000));
}
