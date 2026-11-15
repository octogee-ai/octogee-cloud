import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";

const METHOD = "octogee.brokerProfiles.materialize";
const CANONICAL_AGENT = /^octogee-[a-z0-9]+(?:-[a-z0-9]+)*-coach$/u;
const SKIPPED_MODES = new Set(["discovery", "tool-discovery", "setup-only", "cli-metadata"]);

class BrokerProfileRefusal extends Error {}

type UpdateStore = typeof updateAuthProfileStoreWithLock;
type Credential = Parameters<Parameters<UpdateStore>[0]["updater"]>[0]["profiles"][string];

function brokerProfiles(agentId: string, env: NodeJS.ProcessEnv): Record<string, Credential> {
  const profile = (provider: string, suffix: string): Credential => ({
    type: "api_key", provider,
    keyRef: { source: "exec", provider: "gcp-secret-manager", id: `agent-model-token-${suffix}${agentId}` },
  });
  return {
    "anthropic:default": profile("anthropic", ""),
    ...(env.OPENROUTER_BASE_URL?.trim()
      ? { "platform-openrouter:default": profile("platform-openrouter", "openrouter-") } : {}),
    ...(env.PLATFORM_OPENAI_BASE_URL?.trim()
      ? { "platform-openai:default": profile("platform-openai", "openai-") } : {}),
    ...(env.PLATFORM_META_BASE_URL?.trim()
      ? { "platform-meta:default": profile("platform-meta", "meta-") } : {}),
    ...(env.PLATFORM_VERTEX_BASE_URL?.trim()
      ? { "platform-vertex:default": profile("platform-vertex", "vertex-") } : {}),
  };
}

function sameBrokerProfile(current: Credential, desired: Credential): boolean {
  if (current.type !== "api_key" || desired.type !== "api_key") return false;
  return current.provider === desired.provider && current.key === undefined &&
    current.keyRef?.source === desired.keyRef?.source &&
    current.keyRef?.provider === desired.keyRef?.provider && current.keyRef?.id === desired.keyRef?.id;
}

export function registerBrokerProfiles(
  api: Pick<OpenClawPluginApi, "registerGatewayMethod" | "registrationMode" | "logger">,
  deps: { updateStore?: UpdateStore; env?: NodeJS.ProcessEnv } = {},
): void {
  if (api.registrationMode && SKIPPED_MODES.has(api.registrationMode)) return;
  api.registerGatewayMethod(METHOD, async ({ params, context, respond, signal, hasCurrentClientAuthority }) => {
    const ids = params.agentIds;
    if (Object.keys(params).length !== 1 || !Array.isArray(ids) || ids.length === 0 || ids.length > 128 ||
      ids.some((id) => typeof id !== "string" || id.length > 128 || !CANONICAL_AGENT.test(id))) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "agentIds must name canonical Octogee agents" });
      return;
    }
    try {
      const { resolveAgentDir, listAgentIds } = await import("openclaw/plugin-sdk/agent-runtime");
      const updateStore = deps.updateStore ?? (await import("openclaw/plugin-sdk/provider-auth")).updateAuthProfileStoreWithLock;
      for (const agentId of new Set(ids as string[])) {
        const config = context.getRuntimeConfig();
        if (!listAgentIds(config).includes(agentId)) {
          throw new BrokerProfileRefusal("broker profile agent is not rostered");
        }
        const agentDir = resolveAgentDir(config, agentId);
        const desired = brokerProfiles(agentId, deps.env ?? process.env);
        let refused: Error | undefined;
        const updated = await updateStore({
          agentDir,
          updater(store) {
            try {
              signal?.throwIfAborted();
              if (hasCurrentClientAuthority?.() === false ||
                !listAgentIds(context.getRuntimeConfig()).includes(agentId) ||
                resolveAgentDir(context.getRuntimeConfig(), agentId) !== agentDir) {
                throw new BrokerProfileRefusal("broker profile agent authority changed");
              }
              for (const [profileId, credential] of Object.entries(desired)) {
                const current = store.profiles[profileId];
                if (current !== undefined && !sameBrokerProfile(current, credential)) {
                  throw new BrokerProfileRefusal(`broker profile ownership conflicts for ${agentId}/${profileId}`);
                }
              }
              const missing = Object.entries(desired).filter(([id]) => store.profiles[id] === undefined);
              for (const [id, credential] of missing) store.profiles[id] = credential;
              return missing.length > 0;
            } catch (error) {
              refused = error instanceof Error ? error : new Error("broker profile update refused");
              throw refused;
            }
          },
        });
        if (updated === null) throw refused ?? new BrokerProfileRefusal("broker profile update unavailable");
      }
      respond(true, { ok: true });
    } catch (error) {
      const message = error instanceof BrokerProfileRefusal ? error.message : "broker profile update unavailable";
      api.logger.error(`[broker-profiles] ${message}`);
      respond(false, undefined, { code: "UNAVAILABLE", message });
    }
  }, { scope: "operator.admin" });
}
