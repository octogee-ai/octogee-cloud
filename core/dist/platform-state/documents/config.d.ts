import { type PlatformModelConfig } from "@octogee/shared/types/platform-config";
import type { SizingTier } from "@octogee/shared/types/sizing";
import { type GatewayComputerProfile, type GatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import { type OrchestratorConfig, type PlatformConfigEntry, type PlatformConfigKey, type PlatformConfigValues } from "../config.js";
import { type RecordKey } from "../errors.js";
export declare function parseStoredPlatformModelConfig(value: unknown): PlatformModelConfig | null;
export type PlatformConfigParsers = {
    readonly [K in PlatformConfigKey]: (value: unknown) => PlatformConfigValues[K] | null;
};
export declare const PLATFORM_CONFIG_READ_PARSERS: PlatformConfigParsers;
export declare const PLATFORM_CONFIG_WRITE_PARSERS: PlatformConfigParsers;
export declare const ORCHESTRATOR_KEY: RecordKey;
export declare const platformKey: (key: PlatformConfigKey) => RecordKey;
export declare const logger: import("@octogee/shared/server/service-logger").ServiceLogger;
export type PlainMap = Readonly<Record<string, unknown>>;
export declare function isPlainMap(value: unknown): value is PlainMap;
export declare function isNonNegativeSafeInteger(value: unknown): value is number;
export interface SizingTierSource {
    readonly instance: SizingTier | null;
    readonly fallbackStorageGb: number | null;
    readonly computer: GatewayComputerProfile | null;
}
export declare function seedSizingProfiles(tiers: Readonly<Record<string, SizingTierSource>>): Record<string, GatewaySizingProfile>;
export declare function sizingProfilesOf(value: unknown): Record<string, GatewaySizingProfile>;
export declare function nullableField<T>(data: PlainMap, field: string, accepts: (value: unknown) => value is T): T | null;
export declare const isString: (value: unknown) => value is string;
export declare const isNumber: (value: unknown) => value is number;
export declare function parseOrchestratorConfig(data: PlainMap): OrchestratorConfig;
export declare function platformConfigEntryFromData<K extends PlatformConfigKey>(key: K, data: Readonly<Record<string, unknown>>): PlatformConfigEntry<K>;
export declare function parsePlatformConfigValue<K extends PlatformConfigKey>(key: K, value: unknown): PlatformConfigValues[K];
