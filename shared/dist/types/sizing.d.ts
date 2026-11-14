import type { GatewayClass, GatewayProfile } from './glm.js';
export declare const SIZING_TIERS: readonly ['s', 'm', 'l'];
export type SizingTier = (typeof SIZING_TIERS)[number];
export declare function isSizingTier(value: unknown): value is SizingTier;
export interface TierResources {
    requests: {
        cpu: string;
        memory: string;
        'ephemeral-storage'?: string;
    };
    limits: {
        cpu: string;
        memory: string;
        'ephemeral-storage'?: string;
    };
}
export interface TierNodeRuntime {
    uvThreadpoolSize: string;
    maxOldSpaceSizeMb: string;
}
export interface TierCapacity {
    targetActiveUsers: number;
    typicalUsers: number;
}
export interface SizingTierPreset {
    description: string;
    resources: TierResources;
    nodejs: TierNodeRuntime;
    capacity: TierCapacity;
}
export declare const TIER_PRESETS: Record<SizingTier, SizingTierPreset>;
export declare const PROFILE_DEFAULT_TIER: Record<GatewayProfile, SizingTier>;
export declare const GATEWAY_CLASS_DEFAULT_TIER: Record<GatewayClass, SizingTier>;
export declare const FALLBACK_DEFAULT_TIER: SizingTier;
export type TierResolvedFrom = 'explicit' | 'class-default' | 'profile-default';
export interface ResolveSizingTierInput {
    sizingTier?: SizingTier;
    gatewayClass?: GatewayClass;
    profile?: GatewayProfile;
}
export interface ResolvedSizingTier {
    tier: SizingTier;
    resolvedFrom: TierResolvedFrom;
    preset: SizingTierPreset;
}
export declare function resolveSizingTier(input: ResolveSizingTierInput): ResolvedSizingTier;
