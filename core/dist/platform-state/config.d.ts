import type { PlatformConnectConfig, PlatformFreeConfig, PlatformModelConfig } from "@octogee/shared/types/platform-config";
import { type GatewayRuntime, type GatewayVmBootDiskType, type GatewayVmDesktop, type GatewayVmProvisioningModel } from "@octogee/shared/types/glm";
import type { SharedGatewayAutoscalingConfig } from "@octogee/shared/types/shared-gateway-pool";
import { type SizingTier } from "@octogee/shared/types/sizing";
import type { OpaqueMap, RecordPatch, Revision, Stored, TimeInput } from "./store.js";
export type GatewayIsolation = "shared" | "isolated";
export interface GatewayVmProfile {
    readonly runtime: Extract<GatewayRuntime, "gce-vm">;
    readonly desktop: GatewayVmDesktop;
    readonly machineType: string | null;
    readonly provisioningModel: GatewayVmProvisioningModel | null;
    readonly bootDisk: {
        readonly sizeGb: number;
        readonly type: GatewayVmBootDiskType;
    } | null;
    readonly homeSizeGiB: number;
}
export interface GatewayPodProfile {
    readonly runtime: Extract<GatewayRuntime, "cluster">;
    readonly homeSizeGiB: number;
}
export type GatewayComputerProfile = GatewayVmProfile | GatewayPodProfile;
export type GatewaySizingProfile = {
    readonly isolation: "shared";
} | {
    readonly isolation: "isolated";
    readonly sizingTier: SizingTier;
    readonly computer: GatewayComputerProfile;
    readonly fallbackStorageGb: number | null;
};
export declare function isGatewayVmProfile(value: unknown): value is GatewayVmProfile;
export declare function isGatewayPodProfile(value: unknown): value is GatewayPodProfile;
export declare function isGatewaySizingProfile(value: unknown): value is GatewaySizingProfile;
export declare function isolatedSizingTier(profile: GatewaySizingProfile | null): SizingTier | null;
export declare function requireSizingProfile(profiles: Readonly<Record<string, GatewaySizingProfile>>, sizingKey: string): GatewaySizingProfile;
export declare const PLACEMENT_AUTOMATION_OWNERS: readonly ["fleet-controller", "client"];
export type PlacementAutomationOwner = (typeof PLACEMENT_AUTOMATION_OWNERS)[number];
export declare const DEFAULT_PLACEMENT_AUTOMATION_OWNER: PlacementAutomationOwner;
export declare function isPlacementAutomationOwner(value: unknown): value is PlacementAutomationOwner;
export interface OrchestratorConfig {
    readonly sharedGatewayAutoscaling: SharedGatewayAutoscalingConfig | null;
    readonly sizingProfiles: Readonly<Record<string, GatewaySizingProfile>>;
    readonly defaultGatewayId: string | null;
    readonly disposableGatewayIdleMs: number | null;
    readonly placementUpdatedAt: number | null;
    readonly placementUpdatedBy: string | null;
    readonly placementAutomationOwner: PlacementAutomationOwner;
    readonly placementAutomationYieldedAt: number | null;
}
export type OrchestratorConfigPatch = RecordPatch<Omit<OrchestratorConfig, "sharedGatewayAutoscaling">> & {
    readonly sharedGatewayAutoscaling?: SharedGatewayAutoscalingConfig;
};
export interface OrchestratorConfigRepository {
    get(): Promise<Stored<OrchestratorConfig> | null>;
    getSizingProfile(sizingKey: string): Promise<GatewaySizingProfile>;
    patch(patch: OrchestratorConfigPatch, fence?: {
        readonly revision?: Revision;
    }): Promise<void>;
}
export interface PlatformConfigValues {
    readonly models: PlatformModelConfig;
    readonly free: PlatformFreeConfig;
    readonly connect: PlatformConnectConfig;
}
export type PlatformConfigKey = keyof PlatformConfigValues;
export interface PlatformConfigEntry<K extends PlatformConfigKey> {
    readonly key: K;
    readonly value: PlatformConfigValues[K];
    readonly updatedAt: number | null;
    readonly updatedBy: string | null;
}
export interface PlatformConfigRepository {
    get<K extends PlatformConfigKey>(key: K): Promise<Stored<PlatformConfigEntry<K>> | null>;
    put<K extends PlatformConfigKey>(key: K, value: PlatformConfigValues[K], updatedBy: string, updatedAt: TimeInput): Promise<void>;
    delete(key: PlatformConfigKey): Promise<void>;
}
export interface WriterQuiescenceRepository {
    get(): Promise<Stored<OpaqueMap> | null>;
    put(record: OpaqueMap): Promise<void>;
    delete(): Promise<void>;
}
export interface MattermostAdminIdentity {
    readonly userId: string;
    readonly proxyUrl: string | null;
    readonly updatedAt: number;
}
export type MattermostAdminIdentityInput = Omit<MattermostAdminIdentity, "updatedAt"> & {
    readonly updatedAt: TimeInput;
};
export interface MattermostAdminRepository {
    get(): Promise<Stored<MattermostAdminIdentity> | null>;
    put(identity: MattermostAdminIdentityInput): Promise<void>;
}
export type ConfigRecord = {
    readonly kind: "orchestrator";
    readonly value: OrchestratorConfig;
} | {
    readonly kind: "platform";
    readonly entry: PlatformConfigEntry<PlatformConfigKey>;
};
export interface ConfigRepositories {
    readonly orchestrator: OrchestratorConfigRepository;
    readonly platform: PlatformConfigRepository;
    readonly writerQuiescence: WriterQuiescenceRepository;
    readonly mattermostAdmin: MattermostAdminRepository;
}
