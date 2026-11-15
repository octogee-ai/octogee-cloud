import { claudeCliRuntimeConfig, codexRuntimeConfig } from "@octogee/core/model-credential-materializer";
import { modelRefForCatalogEntry } from "@octogee/shared/types/agent-models";
import { MODEL_CATALOG } from "@octogee/shared/types/model-catalog";
import type { ModelCredentialSubscriptionProviderId } from "@octogee/shared/types/model-credentials";

export function agentModelCatalog(providers: readonly ModelCredentialSubscriptionProviderId[]) {
  const subscriptions = providers.flatMap((provider) => {
    const runtime = provider === "anthropic" ? claudeCliRuntimeConfig() : codexRuntimeConfig();
    return Object.keys(runtime.modelsDef).map((ref) => {
      const id = ref.slice(ref.indexOf("/") + 1);
      const entry = MODEL_CATALOG.find((model) =>
        model.id === `${provider}/${id}` || (model.provider === provider && model.id === id),
      );
      return { ref, provider, id, label: entry?.label ?? id, billing: "subscription" as const };
    });
  });
  return [
    ...subscriptions,
    ...MODEL_CATALOG.map((entry) => ({
      ref: modelRefForCatalogEntry(entry),
      provider: entry.provider,
      id: entry.id,
      label: entry.label,
      billing: "platform" as const,
      ...(typeof entry.contextTokens === "number" ? { contextTokens: entry.contextTokens } : {}),
      reasoningEfforts: entry.reasoningEfforts,
      ...(entry.defaultReasoningEffort ? { defaultReasoningEffort: entry.defaultReasoningEffort } : {}),
    })),
  ];
}
