/**
 * Octogee Status Tools — `octogee_status`
 *
 * One read-only tool: the agent reports which gateway class it runs on, which
 * credential path bills its model calls (platform broker token vs BYOSUB vs
 * BYOK — including the shared-gateway byosub suppression), any account fields
 * the broker reports for the owner, and the owner's live token-budget window.
 *
 * Imports `openclaw/plugin-sdk/core` and `typebox` resolve at runtime via the
 * gateway base image; tests target the pure status-client module.
 */

// @ts-expect-error — resolved at runtime via the gateway base image's openclaw install (no local types)
import { definePluginEntry, jsonResult } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

import { fetchAgentUsageStatus, formatStatusText, gatewayClassMismatchNote, StatusToolError } from "./status-client.js";

interface PluginConfig {
  brokerUrl?: string;
  tokenPath?: string;
  gatewayClass?: string;
}

interface ToolCtx {
  agentId?: unknown;
}

interface PluginRegisterApi {
  pluginConfig?: unknown;
  logger?: { debug?: (msg: string) => void };
  registerTool: (factory: (ctx: ToolCtx) => unknown, meta: { name: string }) => void;
}

const STATUS_DESCRIPTION = [
  "Report this agent's platform status: gateway class, which credential bills model calls",
  "(platform tokens vs the owner's own subscription/API key), the owner's account fields,",
  "the owner's token-budget window (percent used + refill time), and throttle state.",
  "Use when the user asks about their account, budget, tokens, throttling, model access,",
  "or whether their connected subscription is active on this gateway.",
].join(" ");

export default definePluginEntry({
  id: "octogee-status-tools",
  name: "Octogee Status Tools",
  description: "Gateway class, credential path, and live token-budget window.",
  register(api: PluginRegisterApi) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;

    api.registerTool(
      (ctx: ToolCtx) => ({
        name: "octogee_status",
        description: STATUS_DESCRIPTION,
        parameters: Type.Object({}),
        async execute(): Promise<unknown> {
          const agentId = ctx?.agentId;
          if (typeof agentId !== "string" || agentId.length === 0) {
            return jsonResult({ error: "octogee_status: no agentId in tool context" });
          }
          try {
            const status = await fetchAgentUsageStatus({
              agentId,
              brokerUrl: config.brokerUrl,
              tokenPath: config.tokenPath,
            });
            const podClass = config.gatewayClass || process.env.GATEWAY_CLASS || "";
            const classNote = gatewayClassMismatchNote(podClass, status.gatewayClass);
            return jsonResult({ status, text: formatStatusText(status) + classNote });
          } catch (err) {
            const message =
              err instanceof StatusToolError
                ? `octogee_status ${err.code}: ${err.message}`
                : `octogee_status failed: ${(err as Error).message}`;
            return jsonResult({ error: message });
          }
        },
      }),
      { name: "octogee_status" },
    );

    api.logger?.debug?.("[status-tools] registered octogee_status");
  },
});
