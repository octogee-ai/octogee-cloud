import { type GatewayClass, type GatewayImageProfile, type GatewayModelBrokerLimits, type GatewayProfile, type GatewayServiceAccountSpec, type IsolatedGatewayAccessSpec } from "./glm.js";
import { type SizingTier } from "./sizing.js";
export declare const GATEWAY_CONFIG_SCHEMA_VERSION: 1;
export interface GatewayMutableConfig {
    configSchemaVersion: typeof GATEWAY_CONFIG_SCHEMA_VERSION;
    profile: GatewayProfile | null;
    gatewayClass: GatewayClass;
    imageProfile: GatewayImageProfile;
    sizingTier: SizingTier | null;
    sizingProfile?: string | null;
    gcpProject: string | null;
    gatewayContainerSecurityContext: Record<string, unknown> | null;
    serviceAccountName: string | null;
    serviceAccount: GatewayServiceAccountSpec | null;
    builderAccess: IsolatedGatewayAccessSpec | null;
    ownerUid: string | null;
    builderSlug: string | null;
    modelBrokerLimits: GatewayModelBrokerLimits | null;
    preemption?: null;
    allocation?: IsolatedGatewayAllocation | null;
}
export interface IsolatedGatewayAllocation {
    kind: "disposable-builder";
    schemaVersion: 1;
    leaseId: string;
    generation: number;
    claimedByUid: string;
}
export declare function isIsolatedGatewayAllocation(value: unknown): value is IsolatedGatewayAllocation;
export declare function isBareGatewayId(value: unknown): value is string;
export declare function isGatewayMutableConfig(value: unknown): value is GatewayMutableConfig;
export declare function isGatewayMutableConfigForGateway(value: unknown, gatewayId: string): value is GatewayMutableConfig;
export declare function projectGatewayMutableConfigForGateway(value: unknown, gatewayId: string): GatewayMutableConfig | null;
export declare function effectiveGatewayServiceAccountNameForGateway(config: GatewayMutableConfig, gatewayId: string): string;
