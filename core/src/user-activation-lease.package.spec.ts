import { describe, expect, it, vi } from "vitest";

import { requestUserActivationLease } from "../dist/user-activation-lease.js";
import type { PlatformStateStore } from "./platform-state/store.js";

function parkedUserStore(): PlatformStateStore {
  const user = {
    uid: "uid-alice",
    slug: "alice",
    gateway: { gatewayId: "shared-blue" },
    accountLifecycle: null,
    fences: {},
    activationLease: {
      leaseId: "lease-old",
      generation: 7,
      status: "parked",
      eventKey: "run-start:run-1",
      sizingTier: "s",
    },
  };
  const assignment = {
    uid: "uid-alice",
    slug: "alice",
    gatewayId: "shared-blue",
    source: "onboarding",
    state: "serving",
    epoch: 4,
  };
  const transaction = {
    users: { records: { get: async () => user } },
    gateways: { assignments: { get: async () => assignment } },
  };
  return {
    users: transaction.users,
    config: { orchestrator: { getSizingProfile: async () => ({
      isolation: "isolated", sizingTier: "s", fallbackStorageGb: null,
      computer: { runtime: "gce-vm", desktop: "x11", machineType: "e2-medium", provisioningModel: "STANDARD", bootDisk: { sizeGb: 80, type: "pd-balanced" }, homeSizeGiB: 10 },
    }) } },
    transaction: async (_options: unknown, body: (tx: unknown) => Promise<unknown>) => body(transaction),
  } as unknown as PlatformStateStore;
}

describe("@octogee/core/user-activation-lease runtime artifact", () => {
  it("acknowledges a late parked duplicate without allocating another generation", async () => {
    const leaseIdFactory = vi.fn(() => "lease-new");

    await expect(requestUserActivationLease({
      store: parkedUserStore(),
      readSizingKey: async () => "hobby",
      uid: "uid-alice",
      reportingGatewayId: "shared-blue",
      assignmentEpoch: 4,
      eventKey: "run-start:run-1",
      cause: "run-start",
      observedAt: 5_000,
      createdBy: "gateway-edge:shared-blue",
      leaseIdFactory,
      now: 5_000,
    })).resolves.toMatchObject({
      statusCode: 200,
      body: {
        status: "parked",
        leaseId: "lease-old",
        generation: 7,
        duplicate: true,
      },
    });

    expect(leaseIdFactory).not.toHaveBeenCalled();
  });
});
