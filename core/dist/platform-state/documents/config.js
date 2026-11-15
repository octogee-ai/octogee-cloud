import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { DEFAULT_HOUSE_MODEL_REF, DEFAULT_OPS_AGENT_MODEL_REF, DEFAULT_USER_AGENT_FALLBACK_MODEL_REF, DEFAULT_USER_AGENT_MODEL_REF, parsePlatformConnectConfig, parsePlatformFreeConfig, parsePlatformModelConfig } from "@octogee/shared/types/platform-config";
import { parseSharedGatewayAutoscalingConfig } from "@octogee/shared/types/shared-gateway-pool";
import { isGatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import { MalformedRecordError } from "../errors.js";
export function parseStoredPlatformModelConfig(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
    const { freeTierModelRef = DEFAULT_HOUSE_MODEL_REF, opsAgentModelRef = DEFAULT_OPS_AGENT_MODEL_REF, builderAgentModelRef = DEFAULT_USER_AGENT_MODEL_REF, builderAgentFallbackModelRef = DEFAULT_USER_AGENT_FALLBACK_MODEL_REF, } = value;
    if (typeof freeTierModelRef !== "string" || typeof opsAgentModelRef !== "string" || typeof builderAgentModelRef !== "string") {
        return null;
    }
    if (builderAgentFallbackModelRef !== null && typeof builderAgentFallbackModelRef !== "string")
        return null;
    return { freeTierModelRef, opsAgentModelRef, builderAgentModelRef, builderAgentFallbackModelRef };
}
export const PLATFORM_CONFIG_READ_PARSERS = {
    models: parseStoredPlatformModelConfig,
    free: parsePlatformFreeConfig,
    connect: parsePlatformConnectConfig,
};
export const PLATFORM_CONFIG_WRITE_PARSERS = {
    models: parsePlatformModelConfig,
    free: parsePlatformFreeConfig,
    connect: parsePlatformConnectConfig,
};
export const ORCHESTRATOR_KEY = { aggregate: "orchestrator-config", key: "orchestrator" };
export const platformKey = (key) => ({ aggregate: "platform-config", key });
export const logger = createServiceLogger("platform-state");
export function isPlainMap(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isNonNegativeSafeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function seedSizingProfiles(tiers) {
    const profiles = {};
    for (const [sizingKey, tier] of Object.entries(tiers)) {
        if (tier.instance === null && tier.computer === null) {
            profiles[sizingKey] = { isolation: "shared" };
        }
        else if (tier.instance !== null && tier.computer !== null) {
            profiles[sizingKey] = {
                isolation: "isolated",
                sizingTier: tier.instance,
                computer: tier.computer,
                fallbackStorageGb: tier.fallbackStorageGb,
            };
        }
        else {
            throw new Error(`sizing key ${sizingKey} names an instance or a VM without the other`);
        }
    }
    return profiles;
}
export function sizingProfilesOf(value) {
    if (value === undefined)
        return {};
    if (!isPlainMap(value))
        throw new MalformedRecordError(ORCHESTRATOR_KEY, "sizingProfiles is not a map");
    for (const [sizingKey, profile] of Object.entries(value)) {
        if (!isGatewaySizingProfile(profile)) {
            throw new MalformedRecordError(ORCHESTRATOR_KEY, `sizingProfiles.${sizingKey} is not a gateway sizing profile`);
        }
    }
    return value;
}
export function nullableField(data, field, accepts) {
    const value = data[field];
    if (value === undefined || value === null)
        return null;
    if (!accepts(value))
        throw new MalformedRecordError(ORCHESTRATOR_KEY, `${field} is ${JSON.stringify(value)}`);
    return value;
}
export const isString = (value) => typeof value === "string";
export const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
export function parseOrchestratorConfig(data) {
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
export function platformConfigEntryFromData(key, data) {
    const { updatedAt, updatedBy, ...rest } = data;
    const value = PLATFORM_CONFIG_READ_PARSERS[key](rest);
    if (value === null)
        throw new MalformedRecordError(platformKey(key), "does not parse");
    if (updatedAt !== undefined && updatedAt !== null && !isNumber(updatedAt)) {
        throw new MalformedRecordError(platformKey(key), "updatedAt is not a time");
    }
    if (updatedBy !== undefined && updatedBy !== null && !isString(updatedBy)) {
        throw new MalformedRecordError(platformKey(key), "updatedBy is not a string");
    }
    return {
        key,
        value: value,
        updatedAt: updatedAt ?? null,
        updatedBy: updatedBy ?? null,
    };
}
export function parsePlatformConfigValue(key, value) {
    const parsed = PLATFORM_CONFIG_WRITE_PARSERS[key](value);
    if (parsed === null)
        throw new MalformedRecordError(platformKey(key), "value does not parse");
    return parsed;
}
