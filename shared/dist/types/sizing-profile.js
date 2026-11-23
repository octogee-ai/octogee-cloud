import { GATEWAY_VM_PROVISIONING_MODELS, isGatewayVmBootDiskType, isGatewayVmDesktop, } from "./glm.js";
import { isSizingTier } from "./sizing.js";
function isFieldMap(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isGatewayVmProfile(value) {
    if (!isFieldMap(value))
        return false;
    const { runtime, desktop, machineType, provisioningModel, bootDisk, homeSizeGiB } = value;
    return (runtime === "gce-vm" &&
        isGatewayVmDesktop(desktop) &&
        (machineType === null || typeof machineType === "string") &&
        (provisioningModel === null || GATEWAY_VM_PROVISIONING_MODELS.includes(provisioningModel)) &&
        (bootDisk === null ||
            (isFieldMap(bootDisk) && typeof bootDisk.sizeGb === "number" && isGatewayVmBootDiskType(bootDisk.type))) &&
        typeof homeSizeGiB === "number");
}
export function isGatewayPodProfile(value) {
    return isFieldMap(value) && value.runtime === "cluster" && typeof value.homeSizeGiB === "number" &&
        (value.homeStorage === undefined ||
            (value.homeStorage === "emptyDir" && Number.isSafeInteger(value.homeSizeGiB) && value.homeSizeGiB > 0));
}
export function ephemeralPodHomeGiB(profile) {
    return profile?.isolation === "isolated" && profile.computer.runtime === "cluster" && profile.computer.homeStorage === "emptyDir"
        ? profile.computer.homeSizeGiB : undefined;
}
export function isGatewaySizingProfile(value) {
    if (!isFieldMap(value))
        return false;
    if (value.isolation === "shared")
        return true;
    return (value.isolation === "isolated" &&
        isSizingTier(value.sizingTier) &&
        (isGatewayVmProfile(value.computer) || isGatewayPodProfile(value.computer)) &&
        (value.fallbackStorageGb === null || typeof value.fallbackStorageGb === "number"));
}
export function isolatedSizingTier(profile) {
    return profile?.isolation === "isolated" ? profile.sizingTier : null;
}
export function requireSizingProfile(profiles, sizingKey) {
    const profile = profiles[sizingKey];
    if (!profile)
        throw new Error(`gateway sizing profile is not configured: ${sizingKey}`);
    return profile;
}
