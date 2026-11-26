import { type GatewayRuntime, type GatewayVmBootDiskType, type GatewayVmDesktop, type GatewayVmProvisioningModel } from "./glm.js";
import { type SizingTier } from "./sizing.js";
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
    readonly idleStorage?: "snapshot";
}
export interface GatewayPodProfile {
    readonly runtime: Extract<GatewayRuntime, "cluster">;
    readonly homeSizeGiB: number;
    readonly homeStorage?: "emptyDir";
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
export declare function ephemeralPodHomeGiB(profile: GatewaySizingProfile | null | undefined): number | undefined;
export declare function idleSnapshotDesktop(profile: GatewaySizingProfile | null | undefined): GatewayVmDesktop | undefined;
export declare function isGatewaySizingProfile(value: unknown): value is GatewaySizingProfile;
export declare function isolatedSizingTier(profile: GatewaySizingProfile | null): SizingTier | null;
export declare function requireSizingProfile(profiles: Readonly<Record<string, GatewaySizingProfile>>, sizingKey: string): GatewaySizingProfile;
