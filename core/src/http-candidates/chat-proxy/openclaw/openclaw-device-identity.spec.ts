import { afterEach, describe, expect, it } from "vitest";

import {
  getOpenClawDeviceIdentity,
  __resetOpenClawDeviceIdentityForTest,
} from "./device-identity.js";

afterEach(() => {
  __resetOpenClawDeviceIdentityForTest();
});

describe("gateway-edge OpenClaw device identity", () => {
  it("returns one device identity for every OpenClaw caller in the process", () => {
    const first = getOpenClawDeviceIdentity();
    const second = getOpenClawDeviceIdentity();

    expect(second).toBe(first);
    expect(second.deviceId).toBe(first.deviceId);
  });
});
