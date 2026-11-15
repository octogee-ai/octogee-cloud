import { generateIdentity, } from "@octogee/shared/types/device-identity";
let identity = null;
export function getOpenClawDeviceIdentity() {
    identity ??= generateIdentity();
    return identity;
}
export function __resetOpenClawDeviceIdentityForTest() {
    identity = null;
}
