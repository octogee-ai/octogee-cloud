import type { GatewayClass, GatewayProfile } from './glm.js';

export const SIZING_TIERS = ['xs', 's', 'm', 'l'] as const;

export type SizingTier = (typeof SIZING_TIERS)[number];

// Runtime guard for tiers sourced from outside the type system (Firestore
// desired state, persisted helm values). A stale pre-rename tier must read as
// "not a tier" so callers fall back to the profile default rather than
// forwarding an unknown value to the chart — which rejects it and loops the
// reconciler.
export function isSizingTier(value: unknown): value is SizingTier {
  return typeof value === 'string' && (SIZING_TIERS as readonly string[]).includes(value);
}

export interface TierResources {
  requests: { cpu: string; memory: string; 'ephemeral-storage'?: string };
  limits: { cpu: string; memory: string; 'ephemeral-storage'?: string };
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

export const TIER_PRESETS: Record<SizingTier, SizingTierPreset> = {
  xs: {
    description: 'One-user floor — Spot/emptyDir active session',
    resources: {
      requests: { cpu: '500m', memory: '2Gi', 'ephemeral-storage': '4Gi' },
      limits: { cpu: '1000m', memory: '2Gi', 'ephemeral-storage': '4Gi' },
    },
    nodejs: { uvThreadpoolSize: '4', maxOldSpaceSizeMb: '1536' },
    capacity: { targetActiveUsers: 1, typicalUsers: 1 },
  },
  s: {
    description: 'One active user with browser and desktop headroom',
    resources: {
      requests: { cpu: '2000m', memory: '8Gi', 'ephemeral-storage': '4Gi' },
      limits: { cpu: '2000m', memory: '8Gi', 'ephemeral-storage': '4Gi' },
    },
    nodejs: { uvThreadpoolSize: '4', maxOldSpaceSizeMb: '3072' },
    capacity: { targetActiveUsers: 1, typicalUsers: 2 },
  },
  m: {
    description: 'Shared default — light shared use',
    resources: {
      requests: { cpu: '2000m', memory: '8Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '2000m', memory: '8Gi', 'ephemeral-storage': '5Gi' },
    },
    nodejs: { uvThreadpoolSize: '4', maxOldSpaceSizeMb: '5632' },
    capacity: { targetActiveUsers: 2, typicalUsers: 3 },
  },
  l: {
    description: 'Ceiling — small teams and heavier shared use',
    resources: {
      requests: { cpu: '4000m', memory: '16Gi', 'ephemeral-storage': '5Gi' },
      limits: { cpu: '4000m', memory: '16Gi', 'ephemeral-storage': '5Gi' },
    },
    nodejs: { uvThreadpoolSize: '6', maxOldSpaceSizeMb: '10240' },
    capacity: { targetActiveUsers: 4, typicalUsers: 6 },
  },
};

export const PROFILE_DEFAULT_TIER: Record<GatewayProfile, SizingTier> = {
  standard: 'l',
  isolated: 's',
};

export const GATEWAY_CLASS_DEFAULT_TIER: Record<GatewayClass, SizingTier> = {
  shared: 'm',
  isolated: 's',
};

export const FALLBACK_DEFAULT_TIER: SizingTier = 'l';

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

export function resolveSizingTier(input: ResolveSizingTierInput): ResolvedSizingTier {
  if (input.sizingTier) {
    return {
      tier: input.sizingTier,
      resolvedFrom: 'explicit',
      preset: TIER_PRESETS[input.sizingTier],
    };
  }
  if (input.gatewayClass) {
    const tier = GATEWAY_CLASS_DEFAULT_TIER[input.gatewayClass];
    return { tier, resolvedFrom: 'class-default', preset: TIER_PRESETS[tier] };
  }
  const tier = input.profile ? PROFILE_DEFAULT_TIER[input.profile] : FALLBACK_DEFAULT_TIER;
  return { tier, resolvedFrom: 'profile-default', preset: TIER_PRESETS[tier] };
}
