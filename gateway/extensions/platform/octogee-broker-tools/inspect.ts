import { readFile } from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { brokerOrigin, BrokerMetadataUnavailable, readBrokerJson, record } from "./http.js";

interface Config { brokerUrl?: string; tokenPath?: string }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null) return null;
  const input = record(value);
  return Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => {
    const value = input[key];
    if (value !== null && typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) throw new BrokerMetadataUnavailable();
    return [key, value];
  }));
}
function inspectionPayload(input: Record<string, unknown>): Record<string, unknown> {
  const result = fields(input, ["schemaVersion", "agentId", "gatewayClass", "tier", "effectiveTier", "trialDaysRemaining", "observedAt"])!;
  const groups = { credential: ["path", "provider"], credits: ["balanceUsd"], week: ["percentUsed", "resetAt"],
    window: ["percentUsed", "nextRefillAt", "degraded", "blocked", "reason"],
    signupOffer: ["currency", "spent", "unlocked", "hardCap", "remaining", "expiresAt", "nextUnlockAt"] };
  for (const [name, keys] of Object.entries(groups)) if (input[name] !== undefined) result[name] = fields(input[name], keys);
  if (input.periods !== undefined) {
    const periods = record(input.periods);
    result.periods = Object.fromEntries(["burst", "week"].map(name => [name, fields(periods[name], ["kind", "durationMs", "startsAt", "resetAt"])]));
  }
  return result;
}
const METHOD = "octogee.broker.inspect";

class BrokerUrlMissing extends Error {
  constructor() { super("no broker URL; set the brokerUrl plugin config, FLEET_BROKER_URL or OCTOGEE_API_URL"); }
}

function inspectionConfig(value: unknown, env: NodeJS.ProcessEnv): { url: URL; tokenPath: string } {
  const config = (value ?? {}) as Config;
  const broker = config.brokerUrl || env.FLEET_BROKER_URL || env.OCTOGEE_API_URL;
  if (!broker) throw new BrokerUrlMissing();
  const url = brokerOrigin(broker);
  url.pathname = "/internal/byok/broker-inspect";
  return { url, tokenPath: config.tokenPath ?? env.OCTOGEE_API_SA_TOKEN_PATH ?? "/var/run/octogee/api-token/token" };
}

export function registerBrokerInspection(api: Pick<OpenClawPluginApi, "registerGatewayMethod" | "pluginConfig" | "registrationMode" | "logger">,
  deps: { fetchImpl?: typeof fetch; readToken?: (file: string) => Promise<string>; env?: NodeJS.ProcessEnv } = {}): void {
  if (api.registrationMode && ["discovery", "tool-discovery", "setup-only", "cli-metadata"].includes(api.registrationMode)) return;
  api.registerGatewayMethod(METHOD, async request => {
    const { params, respond, client, signal, hasCurrentClientAuthority } = request;
    const uid = client?.authenticatedUserId;
    const profile = client?.authenticatedUserProfile?.profileId;
    const current = () => {
      signal?.throwIfAborted(); client?.connectionSignal?.throwIfAborted();
      if (!uid || !profile || client?.authenticatedUserId !== uid || client.authenticatedUserProfile?.profileId !== profile ||
          hasCurrentClientAuthority?.() !== true) throw new BrokerMetadataUnavailable("unauthorized");
    };
    if (Object.keys(params).length !== 1 || typeof params.agentId !== "string" || !params.agentId || params.agentId.length > 128) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "agentId required" }); return;
    }
    try {
      current();
      const { url, tokenPath } = inspectionConfig(api.pluginConfig, deps.env ?? process.env);
      const token = (await (deps.readToken ?? (file => readFile(file, "utf8")))(tokenPath)).trim();
      current();
      if (!token) throw new BrokerMetadataUnavailable();
      const payload = record(await readBrokerJson(url, { method: "POST", signal,
        headers: { "content-type": "application/json", "x-k8s-sa-token": token },
        body: JSON.stringify({ agentId: params.agentId, requesterUid: uid }) }, deps.fetchImpl));
      current();
      if (payload.schemaVersion !== 1 || payload.agentId !== params.agentId) throw new BrokerMetadataUnavailable();
      respond(true, inspectionPayload(payload));
    } catch (error) {
      if (error instanceof BrokerUrlMissing) api.logger.error(`[broker-inspect] ${error.message}`);
      respond(false, undefined, { code: "UNAVAILABLE", message: "Owner-authorized broker metadata unavailable" });
    }
  }, { scope: "operator.read" });
}
