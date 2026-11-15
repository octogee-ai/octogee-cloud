import type { PlatformConnectConfig, PlatformFreeConfig, PlatformModelConfig } from "@octogee/shared/types/platform-config";
import type { SharedGatewayAutoscalingConfig } from "@octogee/shared/types/shared-gateway-pool";
import type { GatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import type { OpaqueMap, RecordPatch, Revision, Stored, TimeInput } from "./store.js";
export interface OrchestratorConfig {
    readonly sharedGatewayAutoscaling: SharedGatewayAutoscalingConfig | null;
    readonly sizingProfiles: Readonly<Record<string, GatewaySizingProfile>>;
    readonly defaultGatewayId: string | null;
    readonly disposableGatewayIdleMs: number | null;
    readonly placementUpdatedAt: number | null;
    readonly placementUpdatedBy: string | null;
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
