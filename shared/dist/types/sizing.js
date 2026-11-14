export const SIZING_TIERS = ['xs', 's', 'm', 'l'];
// Runtime guard for tiers sourced from outside the type system (Firestore
// desired state, persisted helm values). A stale pre-rename tier must read as
// "not a tier" so callers fall back to the profile default rather than
// forwarding an unknown value to the chart — which rejects it and loops the
// reconciler.
export function isSizingTier(value) {
    return typeof value === 'string' && SIZING_TIERS.includes(value);
}
export const TIER_PRESETS = {
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
export const PROFILE_DEFAULT_TIER = {
    standard: 'l',
    isolated: 's',
};
export const GATEWAY_CLASS_DEFAULT_TIER = {
    shared: 'm',
    isolated: 's',
};
export const FALLBACK_DEFAULT_TIER = 'l';
export function resolveSizingTier(input) {
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
