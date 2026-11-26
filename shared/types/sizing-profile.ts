import {
  GATEWAY_VM_PROVISIONING_MODELS,
  isGatewayVmBootDiskType,
  isGatewayVmDesktop,
  type GatewayRuntime,
  type GatewayVmBootDiskType,
  type GatewayVmDesktop,
  type GatewayVmProvisioningModel,
} from "./glm.js";
import { isSizingTier, type SizingTier } from "./sizing.js";

export type GatewayIsolation = "shared" | "isolated";

export interface GatewayVmProfile {
  readonly runtime: Extract<GatewayRuntime, "gce-vm">;
  readonly desktop: GatewayVmDesktop;
  readonly machineType: string | null;
  readonly provisioningModel: GatewayVmProvisioningModel | null;
  readonly bootDisk: { readonly sizeGb: number; readonly type: GatewayVmBootDiskType } | null;
  readonly homeSizeGiB: number;
  readonly idleStorage?: "snapshot";
}

export interface GatewayPodProfile {
  readonly runtime: Extract<GatewayRuntime, "cluster">;
  readonly homeSizeGiB: number;
  readonly homeStorage?: "emptyDir";
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
  const { runtime, desktop, machineType, provisioningModel, bootDisk, homeSizeGiB, idleStorage } = value;
  return (
    runtime === "gce-vm" &&
    isGatewayVmDesktop(desktop) &&
    (idleStorage === undefined || idleStorage === "snapshot") &&
    (machineType === null || typeof machineType === "string") &&
    (provisioningModel === null || (GATEWAY_VM_PROVISIONING_MODELS as readonly unknown[]).includes(provisioningModel)) &&
    (bootDisk === null ||
      (isFieldMap(bootDisk) && typeof bootDisk.sizeGb === "number" && isGatewayVmBootDiskType(bootDisk.type))) &&
    typeof homeSizeGiB === "number"
  );
}

export function isGatewayPodProfile(value: unknown): value is GatewayPodProfile {
  return isFieldMap(value) && value.runtime === "cluster" && typeof value.homeSizeGiB === "number" &&
    (value.homeStorage === undefined ||
      (value.homeStorage === "emptyDir" && Number.isSafeInteger(value.homeSizeGiB) && value.homeSizeGiB > 0));
}

export function ephemeralPodHomeGiB(profile: GatewaySizingProfile | null | undefined): number | undefined {
  return profile?.isolation === "isolated" && profile.computer.runtime === "cluster" && profile.computer.homeStorage === "emptyDir"
    ? profile.computer.homeSizeGiB : undefined;
}

export function idleSnapshotDesktop(profile: GatewaySizingProfile | null | undefined): GatewayVmDesktop | undefined {
  return profile?.isolation === "isolated" && profile.computer.runtime === "gce-vm" && profile.computer.idleStorage === "snapshot"
    ? profile.computer.desktop : undefined;
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
