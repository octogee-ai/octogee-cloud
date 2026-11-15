import type {
  PlatformConnectConfig,
  PlatformFreeConfig,
  PlatformModelConfig,
} from "@octogee/shared/types/platform-config";
import {
  GATEWAY_VM_PROVISIONING_MODELS,
  isGatewayVmBootDiskType,
  isGatewayVmDesktop,
  type GatewayRuntime,
  type GatewayVmBootDiskType,
  type GatewayVmDesktop,
  type GatewayVmProvisioningModel,
} from "@octogee/shared/types/glm";
import type { SharedGatewayAutoscalingConfig } from "@octogee/shared/types/shared-gateway-pool";
import { isSizingTier, type SizingTier } from "@octogee/shared/types/sizing";
import type { OpaqueMap, RecordPatch, Revision, Stored, TimeInput } from "./store.js";

export type GatewayIsolation = "shared" | "isolated";

export interface GatewayVmProfile {
  readonly runtime: Extract<GatewayRuntime, "gce-vm">;
  readonly desktop: GatewayVmDesktop;
  readonly machineType: string | null;
  readonly provisioningModel: GatewayVmProvisioningModel | null;
  readonly bootDisk: { readonly sizeGb: number; readonly type: GatewayVmBootDiskType } | null;
  readonly homeSizeGiB: number;
}

export interface GatewayPodProfile {
  readonly runtime: Extract<GatewayRuntime, "cluster">;
  readonly homeSizeGiB: number;
}

export type GatewayComputerProfile = GatewayVmProfile | GatewayPodProfile;

export type GatewaySizingProfile =
  | { readonly isolation: "shared" }
  | {
      readonly isolation: "isolated";
      readonly sizingTier: SizingTier;
      readonly computer: GatewayComputerProfile;
      readonly fallbackStorageGb: number | null;
    };

function isFieldMap(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isGatewayVmProfile(value: unknown): value is GatewayVmProfile {
  if (!isFieldMap(value)) return false;
  const { runtime, desktop, machineType, provisioningModel, bootDisk, homeSizeGiB } = value;
  return (
    runtime === "gce-vm" &&
    isGatewayVmDesktop(desktop) &&
    (machineType === null || typeof machineType === "string") &&
    (provisioningModel === null || (GATEWAY_VM_PROVISIONING_MODELS as readonly unknown[]).includes(provisioningModel)) &&
    (bootDisk === null ||
      (isFieldMap(bootDisk) && typeof bootDisk.sizeGb === "number" && isGatewayVmBootDiskType(bootDisk.type))) &&
    typeof homeSizeGiB === "number"
  );
}

export function isGatewayPodProfile(value: unknown): value is GatewayPodProfile {
  return isFieldMap(value) && value.runtime === "cluster" && typeof value.homeSizeGiB === "number";
}

export function isGatewaySizingProfile(value: unknown): value is GatewaySizingProfile {
  if (!isFieldMap(value)) return false;
  if (value.isolation === "shared") return true;
  return (
    value.isolation === "isolated" &&
    isSizingTier(value.sizingTier) &&
    (isGatewayVmProfile(value.computer) || isGatewayPodProfile(value.computer)) &&
    (value.fallbackStorageGb === null || typeof value.fallbackStorageGb === "number")
  );
}

export function isolatedSizingTier(profile: GatewaySizingProfile | null): SizingTier | null {
  return profile?.isolation === "isolated" ? profile.sizingTier : null;
}

export function requireSizingProfile(
  profiles: Readonly<Record<string, GatewaySizingProfile>>,
  sizingKey: string,
): GatewaySizingProfile {
  const profile = profiles[sizingKey];
  if (!profile) throw new Error(`gateway sizing profile is not configured: ${sizingKey}`);
  return profile;
}

export const PLACEMENT_AUTOMATION_OWNERS = ["fleet-controller", "client"] as const;
export type PlacementAutomationOwner = (typeof PLACEMENT_AUTOMATION_OWNERS)[number];
export const DEFAULT_PLACEMENT_AUTOMATION_OWNER: PlacementAutomationOwner = "fleet-controller";

export function isPlacementAutomationOwner(value: unknown): value is PlacementAutomationOwner {
  return (PLACEMENT_AUTOMATION_OWNERS as readonly unknown[]).includes(value);
}

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
  patch(patch: OrchestratorConfigPatch, fence?: { readonly revision?: Revision }): Promise<void>;
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

export type MattermostAdminIdentityInput = Omit<MattermostAdminIdentity, "updatedAt"> & { readonly updatedAt: TimeInput };

export interface MattermostAdminRepository {
  get(): Promise<Stored<MattermostAdminIdentity> | null>;
  put(identity: MattermostAdminIdentityInput): Promise<void>;
}

export type ConfigRecord =
  | { readonly kind: "orchestrator"; readonly value: OrchestratorConfig }
  | { readonly kind: "platform"; readonly entry: PlatformConfigEntry<PlatformConfigKey> };

export interface ConfigRepositories {
  readonly orchestrator: OrchestratorConfigRepository;
  readonly platform: PlatformConfigRepository;
  readonly writerQuiescence: WriterQuiescenceRepository;
  readonly mattermostAdmin: MattermostAdminRepository;
}
