import { describe, expect, it, vi } from "vitest";

import type { ClaimedUserIdentity, UserIdentity } from "../../shared/types/user-identity.js";
import { userBootMode } from "../entrypoints/surge-openclaw-supervisor.js";

const COMPUTER = { GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "gce-vm" };
const POD = { GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "cluster" };

function claimed(overrides: Partial<ClaimedUserIdentity> = {}): UserIdentity {
  return { gatewayId: "b-x", state: "claimed", ownerUid: "uid-bob", builderSlug: "bob", leaseId: "operator-bob-1", generation: 1, ...overrides };
}

const authority = JSON.stringify(["b-x", "uid-bob", "bob", "operator-bob-1", 1]);

describe("an isolated gateway's user boot mode", () => {
  it("prelaunches an isolated computer when the broker says its user is still served elsewhere", async () => {
    const readIdentity = vi.fn(async () => claimed({ bootMode: "prelaunch" }));

    await expect(userBootMode({ env: COMPUTER, readIdentity })).resolves.toEqual({ prelaunchBoot: true, userAuthorityKey: authority });
    expect(readIdentity).toHaveBeenCalledOnce();
  });

  it("prelaunches a pod-hosted isolated gateway the same way", async () => {
    const readIdentity = vi.fn(async () => claimed({ bootMode: "prelaunch" }));

    await expect(userBootMode({ env: POD, readIdentity })).resolves.toEqual({ prelaunchBoot: true, userAuthorityKey: authority });
  });

  it("holds a pod-hosted isolated gateway for the activation the broker names", async () => {
    const readIdentity = vi.fn(async () => claimed({ bootMode: "activating", activationMigrationId: "mig-activate-b-x-1" }));

    await expect(userBootMode({ env: POD, readIdentity })).resolves.toEqual({
      prelaunchBoot: false, activationMigrationId: "mig-activate-b-x-1", userAuthorityKey: authority,
    });
  });

  it("refuses to boot a pod-hosted isolated gateway the broker gives no boot mode", async () => {
    const readIdentity = vi.fn(async () => claimed());

    await expect(userBootMode({ env: POD, readIdentity })).rejects.toThrow("Native user boot mode is unavailable");
  });

  it("boots without asking the broker when the gateway names no isolated runtime", async () => {
    const readIdentity = vi.fn(async () => claimed({ bootMode: "prelaunch" }));

    await expect(userBootMode({ env: { GATEWAY_CLASS: "isolated" }, readIdentity })).resolves.toEqual({ prelaunchBoot: false });
    expect(readIdentity).not.toHaveBeenCalled();
  });
});
