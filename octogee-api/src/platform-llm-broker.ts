import type express from "express";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { UserAccountReader } from "@octogee/core/user-account";
import { installUserEntitlements, staticUserEntitlements } from "@octogee/shared/types/user-entitlements";

import { createLlmBrokerApp } from "./llm-broker-app.js";
import {
  createCachedOwnerModelBrokerGrantResolver,
  envDefaultModelBrokerLimits,
  parseOptionalLimitNumber,
} from "./lib/model-broker-limits.js";
import { createModelBrokerOwnerAccessResolver } from "./lib/model-broker-owner-access.js";
import { createModelBrokerProviderKeyResolver } from "./lib/model-broker-provider-keys.js";
import { operatorRailRegistry } from "./lib/model-broker-rails.js";
import { createModelBrokerTokenStore } from "./lib/model-broker-tokens.js";
import type { ModelBrokerUsageStore } from "./lib/model-broker-usage.js";
import { createCachedHouseModelResolver } from "./lib/platform-model-config.js";
import { createVertexAccessTokenResolver, vertexProviderConfigFromEnv } from "./lib/vertex-provider.js";

type Environment = Readonly<Record<string, string | undefined>>;

export interface PlatformLlmBrokerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface PlatformLlmBrokerSources {
  readonly env: Environment;
  readonly state: PlatformStateStore;
  readonly accounts: UserAccountReader;
  readonly usageStore: ModelBrokerUsageStore;
  readonly readSecret: (name: string) => Promise<string>;
  readonly logger: PlatformLlmBrokerLogger;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export function createPlatformLlmBrokerApp(sources: PlatformLlmBrokerSources): express.Express {
  const { env, state, logger } = sources;
  installUserEntitlements(staticUserEntitlements);
  const rails = operatorRailRegistry();
  const providerKeys = {
    anthropic: env.ANTHROPIC_API_KEY,
    openrouter: env.OPENROUTER_API_KEY,
    openai: env.OPENAI_API_KEY,
    meta: env.META_MODEL_API_KEY,
  };
  const vertexConfig = vertexProviderConfigFromEnv({ ...env });
  const log = (message: string, fields?: Record<string, unknown>) => logger.info(message, fields);

  return createLlmBrokerApp({
    store: createModelBrokerTokenStore(state),
    usageStore: sources.usageStore,
    providerKeys,
    providerKeyResolver: createModelBrokerProviderKeyResolver({
      store: state,
      platformKeys: providerKeys,
      readSecret: sources.readSecret,
    }),
    ...(vertexConfig ? { vertex: { ...vertexConfig, accessToken: createVertexAccessTokenResolver() } } : {}),
    providerUpstreamBaseUrls: {
      anthropic: env.ANTHROPIC_UPSTREAM_BASE_URL,
      openrouter: env.OPENROUTER_UPSTREAM_BASE_URL,
      openai: env.OPENAI_UPSTREAM_BASE_URL,
    },
    houseModel: env.LLM_BROKER_HOUSE_MODEL,
    providerHouseModels: {
      anthropic: env.LLM_BROKER_HOUSE_MODEL,
      openrouter: env.LLM_BROKER_OPENROUTER_HOUSE_MODEL,
      openai: env.LLM_BROKER_OPENAI_HOUSE_MODEL,
      vertex: env.LLM_BROKER_VERTEX_HOUSE_MODEL,
    },
    resolveHouseModel: createCachedHouseModelResolver({
      platformConfig: state.config.platform,
      onError: (err) => logger.error("llm-broker house model dial resolution failed", { err }),
    }),
    rails,
    resolveGrant: createCachedOwnerModelBrokerGrantResolver({
      rails,
      state,
      accounts: sources.accounts,
      defaults: envDefaultModelBrokerLimits({ ...env }),
      ttlMs: parseOptionalLimitNumber(env.LLM_BROKER_GRANT_CACHE_TTL_MS) ?? undefined,
      log,
    }),
    resolveOwnerAccess: createModelBrokerOwnerAccessResolver(state),
    log,
    onMeteringError: (err) => logger.error("llm-broker usage metering failed", { err }),
    ...(sources.fetchImpl ? { fetchImpl: sources.fetchImpl } : {}),
    ...(sources.now ? { now: sources.now } : {}),
  });
}
