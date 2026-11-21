import { describe, expect, it } from "vitest";
import {
  PlacementOwnerRefusedError,
  assertClientOwnsPlacementAutomation,
  assertFleetControllerOwnsPlacementAutomation,
} from "../placement-automation-owner.js";
import { dsn } from "../platform-state/postgres/__tests__/fixtures/harness.js";
import { NOW, useUserFixture } from "../platform-state/postgres/__tests__/fixtures/users.js";
import { advanceActivationLease, type PlacementOwnerFence } from "./index.js";

const TARGET = "alice-xs-12345678";

const clientCaller: PlacementOwnerFence = async (transaction) => {
  await assertClientOwnsPlacementAutomation(transaction);
};

const inProcessCaller: PlacementOwnerFence = async (transaction) => {
  await assertFleetControllerOwnsPlacementAutomation(transaction);
};

describe.skipIf(!dsn)("PostgreSQL isolated lifecycle: one owner acts at a time", () => {
  const fixture = useUserFixture();

  async function seed() {
    const { records, admitted, place, store } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await admitted("alice");
    await place("alice", "shared-blue");
    await records.setActivationLease("alice", {
      leaseId: "lease-one", generation: 1, status: "activating", targetGatewayId: TARGET,
      sourceGatewayId: "shared-blue", sourceAssignmentEpoch: 0, requestedAt: NOW, activationOperationId: `builder-activate-${TARGET}-g1`,
    }, { leaseId: null, generation: null });
    return store;
  }

  async function advance(requireOwner: PlacementOwnerFence) {
    const store = fixture().store;
    return advanceActivationLease({ store, now: () => NOW + 1_000, requireOwner }, {
      uid: "alice", leaseId: "lease-one", generation: 1, fromStatus: "activating", toStatus: "active",
    });
  }

  async function leaseStatus() {
    return (await fixture().records.get("alice"))!.activationLease!.status;
  }

  it("lets only the fleet controller act while it owns placement automation", async () => {
    await seed();
    await expect(advance(clientCaller)).rejects.toMatchObject({ code: "placement-owner" });
    expect(await leaseStatus()).toBe("activating");
    await advance(inProcessCaller);
    expect(await leaseStatus()).toBe("active");
  });

  it("commits the restored home backup release with activation in one PostgreSQL transaction", async () => {
    const store = await seed();
    const homeDisk = { projectId: "test-project", zone: "us-central1-b", name: "restored-home", id: "130",
      source: "projects/test-project/zones/us-central1-b/disks/restored-home", sizeGb: 10, diskType: "pd-balanced" } as const;
    await fixture().records.patch("alice", { home: { homeDisk, homeArchive: {
      phase: "restored", operationId: "archive-one", gatewayId: TARGET, instanceId: "120", restoredInstanceId: "125",
      targetGatewayId: TARGET, leaseId: "lease-one", generation: 1, restoredDisk: homeDisk,
      snapshot: { projectId: homeDisk.projectId, name: "archive", id: "124", sourceDiskId: "121",
        sourceDisk: "projects/test-project/zones/us-central1-b/disks/archived-home", sizeGb: 10 },
      bootDisk: { source: "projects/test-project/zones/us-central1-b/disks/archived-boot", id: "122" },
    } } });
    await advance(inProcessCaller);
    await advance(inProcessCaller);
    expect(await leaseStatus()).toBe("active");
    expect(await store.users.placementReceipts.get("alice", "lease-one", 1, "activated")).toMatchObject({ gatewayId: TARGET });
    const [release] = await store.journal.operations.listForUid("alice", { statuses: ["pending"] });
    expect(release?.id).toEqual("release-home-backup-archive-one");
    expect(release?.input).toMatchObject({ action: "release-home-backup", snapshotId: "124", activationOperationId: `builder-activate-${TARGET}-g1` });
  });

  it("still refuses the client after the switch until the fleet controller yields", async () => {
    const store = await seed();
    await store.config.orchestrator.patch({ placementAutomationOwner: "client" });
    await expect(advance(clientCaller)).rejects.toMatchObject({ code: "placement-owner" });
    expect(await leaseStatus()).toBe("activating");
    await advance(inProcessCaller);
    expect(await leaseStatus()).toBe("active");
  });

  it("refuses the in-process caller once the fleet controller has yielded, and lets the client act", async () => {
    const store = await seed();
    await store.config.orchestrator.patch({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });
    await expect(advance(inProcessCaller)).rejects.toMatchObject({ constructor: PlacementOwnerRefusedError, refused: "fleet-controller" });
    expect(await leaseStatus()).toBe("activating");
    await advance(clientCaller);
    expect(await leaseStatus()).toBe("active");
    expect(await fixture().store.users.placementReceipts.get("alice", "lease-one", 1, "activated")).toMatchObject({ kind: "activated", gatewayId: TARGET });
  });
});
