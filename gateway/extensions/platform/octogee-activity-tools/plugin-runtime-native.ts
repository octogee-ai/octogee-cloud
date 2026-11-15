import { agentIdFromSessionKey, type InboundMessageContext, type InboundMessageEvent } from "./activity-target.js";
import { createEdgeRelayClient, podRelayToken, type VoiceEvent } from "./edge-relay-client.js";
import type { SourceAgentEvent } from "./activity-types.js";

export type ActivityPluginApi = {
  config?: unknown;
  registrationMode?: string;
  pluginConfig?: Record<string, unknown>;
  logger?: { info?: (message: string) => void; error?: (message: string) => void };
  runtime: {
    events: {
      onAgentEvent(listener: (event: SourceAgentEvent) => void): () => void;
    };
  };
  registerService(service: {
    id: string;
    start(): void | Promise<void>;
    stop?(): void | Promise<void>;
  }): void;
  on(
    name: "message_received",
    handler: (event: InboundMessageEvent, context: InboundMessageContext) => void | Promise<void>,
  ): void;
};

type RelayClient = ReturnType<typeof createEdgeRelayClient>;
type PluginLog = (message: string, fields?: Record<string, unknown>) => void;

type RegisterActivityPluginDeps = {
  relay?: RelayClient;
  createRelay?: typeof createEdgeRelayClient;
  env?: NodeJS.ProcessEnv;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  now?: () => number;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0 ? value : null;
}

function configRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function configuredPositiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 1 ? value as number : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function configuredAgentIds(config: unknown): string[] {
  const agents = configRecord(configRecord(config).agents);
  const listed = Array.isArray(agents.list)
    ? agents.list
      .map((entry) => nonEmpty(configRecord(entry).id))
      .filter((id): id is string => Boolean(id))
    : [];
  const keyed = Object.keys(configRecord(agents.entries))
    .map(nonEmpty)
    .filter((id): id is string => Boolean(id));
  return [...new Set([...listed, ...keyed])];
}

function createPluginRelay(deps: RegisterActivityPluginDeps): RelayClient {
  if (deps.relay) return deps.relay;
  const createRelay = deps.createRelay ?? createEdgeRelayClient;
  const env = deps.env ?? process.env;
  return createRelay({
    gatewayToken: podRelayToken(env),
    env,
  });
}

const DISCOVERY_REGISTRATION_MODES = new Set([
  "discovery",
  "tool-discovery",
  "setup-only",
  "cli-metadata",
]);

export function registerActivityPlugin(
  api: ActivityPluginApi,
  deps: RegisterActivityPluginDeps = {},
): void {
  if (api.registrationMode && DISCOVERY_REGISTRATION_MODES.has(api.registrationMode)) return;
  const pluginConfig = api.pluginConfig ?? {};
  const log: PluginLog = (message, fields = {}) => {
    const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    api.logger?.error?.(`[activity-tools] ${message}${suffix}`);
  };
  const note: PluginLog = (message, fields = {}) => {
    const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    api.logger?.info?.(`[activity-tools] ${message}${suffix}`);
  };
  const relay = createPluginRelay(deps);
  const now = deps.now ?? Date.now;
  const heartbeatMs = configuredPositiveInteger(pluginConfig.heartbeatMs, 5_000);
  const discoveredAgentIds = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const publishHeartbeat = (agentId: string) => {
    void relay.heartbeat(agentId, now()).catch((error) => {
      log("voice readiness heartbeat failed", { agentId, message: errorMessage(error) });
    });
  };
  const heartbeatRoster = () => new Set([...configuredAgentIds(api.config), ...discoveredAgentIds]);
  const publishHeartbeats = () => {
    for (const agentId of heartbeatRoster()) publishHeartbeat(agentId);
  };
  const handleAgentEvent = (event: SourceAgentEvent) => {
    const agentId = nonEmpty(event.agentId) ?? agentIdFromSessionKey(event.sessionKey);
    if (agentId) {
      discoveredAgentIds.add(agentId);
      publishHeartbeat(agentId);
      void relay.publishVoice(agentId, relay.voiceAgentEvent(event)).catch((error) => {
        log("voice agent event relay failed", { agentId, message: errorMessage(error) });
      });
    }
  };

  api.on("message_received", async (event, context) => {
    const agentId = agentIdFromSessionKey(context.sessionKey ?? event.sessionKey);
    const messageId = nonEmpty(event.messageId ?? context.messageId);
    const sessionKey = nonEmpty(event.sessionKey ?? context.sessionKey);
    if (!agentId || !messageId || !sessionKey) return;
    discoveredAgentIds.add(agentId);
    publishHeartbeat(agentId);
    const voiceEvent: VoiceEvent = { kind: "inbound", messageId, sessionKey, ts: now() };
    void relay.publishVoice(agentId, voiceEvent).catch((error) => {
      log("voice inbound event relay failed", { agentId, message: errorMessage(error) });
    });
  });

  api.registerService({
    id: "octogee-activity-source",
    async start() {
      unsubscribe = api.runtime.events.onAgentEvent(handleAgentEvent);
      note("service started", {
        mode: api.registrationMode ?? "unspecified",
        agents: heartbeatRoster().size,
        heartbeatMs,
      });
      publishHeartbeats();
      const setIntervalImpl = deps.setIntervalImpl ?? setInterval;
      heartbeatTimer = setIntervalImpl(publishHeartbeats, heartbeatMs);
      heartbeatTimer.unref?.();
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (heartbeatTimer) (deps.clearIntervalImpl ?? clearInterval)(heartbeatTimer);
      heartbeatTimer = undefined;
    },
  });
}
