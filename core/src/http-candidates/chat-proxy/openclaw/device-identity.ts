import {
  generateIdentity,
  type DeviceIdentity,
} from "@octogee/shared/types/device-identity";

let identity: DeviceIdentity | null = null;

export function getOpenClawDeviceIdentity(): DeviceIdentity {
  identity ??= generateIdentity();
  return identity;
}

export function __resetOpenClawDeviceIdentityForTest(): void {
  identity = null;
}
