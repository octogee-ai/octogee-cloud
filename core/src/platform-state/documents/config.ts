import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { DEFAULT_HOUSE_MODEL_REF, DEFAULT_OPS_AGENT_MODEL_REF, DEFAULT_USER_AGENT_FALLBACK_MODEL_REF, DEFAULT_USER_AGENT_MODEL_REF, type PlatformModelConfig, parsePlatformConnectConfig, parsePlatformFreeConfig, parsePlatformModelConfig } from "@octogee/shared/types/platform-config";
import { parseSharedGatewayAutoscalingConfig } from "@octogee/shared/types/shared-gateway-pool";
import type { SizingTier } from "@octogee/shared/types/sizing";
import { isGatewaySizingProfile, type GatewayComputerProfile, type GatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import { type OrchestratorConfig, type PlatformConfigEntry, type PlatformConfigKey, type PlatformConfigValues } from "../config.js";
import { MalformedRecordError, type RecordKey } from "../errors.js";

export function parseStoredPlatformModelConfig(value: unknown): PlatformModelConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const {
    freeTierModelRef = DEFAULT_HOUSE_MODEL_REF,
    opsAgentModelRef = DEFAULT_OPS_AGENT_MODEL_REF,
    builderAgentModelRef = DEFAULT_USER_AGENT_MODEL_REF,
    builderAgentFallbackModelRef = DEFAULT_USER_AGENT_FALLBACK_MODEL_REF,
  } = value as Record<string, unknown>;
  if (typeof freeTierModelRef !== "string" || typeof opsAgentModelRef !== "string" || typeof builderAgentModelRef !== "string") {
    return null;
  }
  if (builderAgentFallbackModelRef !== null && typeof builderAgentFallbackModelRef !== "string") return null;
  return { freeTierModelRef, opsAgentModelRef, builderAgentModelRef, builderAgentFallbackModelRef };
}

export type PlatformConfigParsers = { readonly [K in PlatformConfigKey]: (value: unknown) => PlatformConfigValues[K] | null };
export const PLATFORM_CONFIG_READ_PARSERS: PlatformConfigParsers = {
  models: parseStoredPlatformModelConfig,
  free: parsePlatformFreeConfig,
  connect: parsePlatformConnectConfig,
};
export const PLATFORM_CONFIG_WRITE_PARSERS: PlatformConfigParsers = {
  models: parsePlatformModelConfig,
  free: parsePlatformFreeConfig,
  connect: parsePlatformConnectConfig,
};
export const ORCHESTRATOR_KEY: RecordKey = { aggregate: "orchestrator-config", key: "orchestrator" };
export const platformKey = (key: PlatformConfigKey): RecordKey => ({ aggregate: "platform-config", key });

export const logger = createServiceLogger("platform-state");

export type PlainMap = Readonly<Record<string, unknown>>;

export function isPlainMap(value: unknown): value is PlainMap {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export interface SizingTierSource {
  readonly instance: SizingTier | null;
  readonly fallbackStorageGb: number | null;
  readonly computer: GatewayComputerProfile | null;
}

export function seedSizingProfiles(
  tiers: Readonly<Record<string, SizingTierSource>>,
): Record<string, GatewaySizingProfile> {
  const profiles: Record<string, GatewaySizingProfile> = {};
  for (const [sizingKey, tier] of Object.entries(tiers)) {
    if (tier.instance === null && tier.computer === null) {
      profiles[sizingKey] = { isolation: "shared" };
    } else if (tier.instance !== null && tier.computer !== null) {
      profiles[sizingKey] = {
        isolation: "isolated",
        sizingTier: tier.instance,
        computer: tier.computer,
        fallbackStorageGb: tier.fallbackStorageGb,
      };
    } else {
      throw new Error(`sizing key ${sizingKey} names an instance or a VM without the other`);
    }
  }
  return profiles;
}

export function sizingProfilesOf(value: unknown): Record<string, GatewaySizingProfile> {
  if (value === undefined) return {};
  if (!isPlainMap(value)) throw new MalformedRecordError(ORCHESTRATOR_KEY, "sizingProfiles is not a map");
  for (const [sizingKey, profile] of Object.entries(value)) {
    if (!isGatewaySizingProfile(profile)) {
      throw new MalformedRecordError(ORCHESTRATOR_KEY, `sizingProfiles.${sizingKey} is not a gateway sizing profile`);
    }
  }
  return value as Record<string, GatewaySizingProfile>;
}

export function nullableField<T>(data: PlainMap, field: string, accepts: (value: unknown) => value is T): T | null {
  const value = data[field];
  if (value === undefined || value === null) return null;
  if (!accepts(value)) throw new MalformedRecordError(ORCHESTRATOR_KEY, `${field} is ${JSON.stringify(value)}`);
  return value;
}

export const isString = (value: unknown): value is string => typeof value === "string";
export const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function parseOrchestratorConfig(data: PlainMap): OrchestratorConfig {
  const sharedGatewayAutoscaling = parseSharedGatewayAutoscalingConfig(data.sharedGatewayAutoscaling);
  if (sharedGatewayAutoscaling === null) {
    logger.error("config/orchestrator.sharedGatewayAutoscaling is invalid; reading it as null", {
      sharedGatewayAutoscaling: data.sharedGatewayAutoscaling,
    });
  }
  return {
    sharedGatewayAutoscaling,
    sizingProfiles: sizingProfilesOf(data.sizingProfiles),
    defaultGatewayId: nullableField(data, "defaultGatewayId", isString),
    disposableGatewayIdleMs: nullableField(data, "disposableGatewayIdleMs", isNonNegativeSafeInteger),
    placementUpdatedAt: nullableField(data, "placementUpdatedAt", isNumber),
    placementUpdatedBy: nullableField(data, "placementUpdatedBy", isString),
  };
}

export function platformConfigEntryFromData<K extends PlatformConfigKey>(
  key: K,
  data: Readonly<Record<string, unknown>>,
): PlatformConfigEntry<K> {
  const { updatedAt, updatedBy, ...rest } = data;
  const value = PLATFORM_CONFIG_READ_PARSERS[key](rest);
  if (value === null) throw new MalformedRecordError(platformKey(key), "does not parse");
  if (updatedAt !== undefined && updatedAt !== null && !isNumber(updatedAt)) {
    throw new MalformedRecordError(platformKey(key), "updatedAt is not a time");
  }
  if (updatedBy !== undefined && updatedBy !== null && !isString(updatedBy)) {
    throw new MalformedRecordError(platformKey(key), "updatedBy is not a string");
  }
  return {
    key,
    value: value as PlatformConfigValues[K],
    updatedAt: updatedAt ?? null,
    updatedBy: updatedBy ?? null,
  };
}

export function parsePlatformConfigValue<K extends PlatformConfigKey>(key: K, value: unknown): PlatformConfigValues[K] {
  const parsed = PLATFORM_CONFIG_WRITE_PARSERS[key](value);
  if (parsed === null) throw new MalformedRecordError(platformKey(key), "value does not parse");
  return parsed as PlatformConfigValues[K];
}
