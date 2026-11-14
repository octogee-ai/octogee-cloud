import { describe, expect, it } from "vitest";

import {
  GatewayMigrationInFlightError,
  findActiveGatewayMigration,
  serialFleetOperationsConflict,
} from "./fleet-operation-lock.js";

describe("findActiveGatewayMigration", () => {
  it.each([
    ["pending input source", { status: "pending", input: { fromGatewayId: "source" } }],
    ["running input target", { status: "running", input: { toGatewayId: "source" } }],
    [
      "running durable assigned source",
      {
        status: "running",
        input: { toGatewayId: "target" },
        userMigrationV2: {
          sourceGatewayId: "source",
          sourceAssignmentMode: "assigned",
        },
      },
    ],
    [
      "running durable unassigned-live source",
      {
        status: "running",
        input: { toGatewayId: "target" },
        userMigrationV2: {
          sourceGatewayId: "source",
          sourceAssignmentMode: "unassigned-live",
        },
      },
    ],
    [
      "running durable target",
      {
        status: "running",
        input: { fromGatewayId: "other" },
        userMigrationV2: { targetGatewayId: "source" },
      },
    ],
  ])("finds an active migration bound through its %s", (_name, operation) => {
    const match = findActiveGatewayMigration("source", [
      { id: "migration", kind: "migrate-user", ...operation },
    ]);

    expect(match?.id).toBe("migration");
  });

  it.each(["succeeded", "failed", "rolled-back"])(
    "ignores a %s migration",
    (status) => {
      expect(findActiveGatewayMigration("source", [{
        id: "migration",
        kind: "migrate-user",
        status,
        userMigrationV2: { sourceGatewayId: "source" },
      }])).toBeNull();
    },
  );

  it("returns a typed conflict with the gateway and operation identities", () => {
    const error = new GatewayMigrationInFlightError("source", "migration");

    expect(error).toMatchObject({ gatewayId: "source", operationId: "migration" });
    expect(error.message).toContain("source");
  });
});

describe("serialFleetOperationsConflict", () => {
  it("serializes a migration against a rollout that shares its gateway — release-roll lineage is retired", () => {
    const rollout = { id: "rollout-document-1", kind: "rollout", input: { gatewayId: "default" } };
    const child = {
      id: "migration-1",
      kind: "migrate-user",
      input: {
        fromGatewayId: "default",
        toGatewayId: "other",
        parentOperationId: "rollout-document-1",
      },
    };

    expect(serialFleetOperationsConflict(rollout, child)).toBe(true);
    expect(serialFleetOperationsConflict(child, rollout)).toBe(true);
  });

  it("uses durable V2 source bindings across migration and rollout kinds", () => {
    expect(serialFleetOperationsConflict(
      { id: "roll", kind: "rollout", input: { gatewayId: "source" } },
      {
        id: "migration",
        kind: "migrate-user",
        userMigrationV2: { sourceGatewayId: "source" },
      },
    )).toBe(true);
  });

  it("keeps unrelated migrations and rollouts independent", () => {
    expect(serialFleetOperationsConflict(
      { id: "roll", kind: "rollout", input: { gatewayId: "green" } },
      {
        id: "migration",
        kind: "migrate-user",
        input: { fromGatewayId: "blue", toGatewayId: "purple" },
      },
    )).toBe(false);
  });

  it("keeps unclassified rollout operations globally serial", () => {
    expect(serialFleetOperationsConflict(
      { id: "a", kind: "rollout", input: { gatewayId: "blue" } },
      { id: "b", kind: "rollout", input: { gatewayId: "green" } },
    )).toBe(true);
  });

  it("allows independent cluster and gateway VM rollouts together", () => {
    const cluster = { id: "shared-roll", kind: "rollout", rolloutLane: "cluster" as const, input: { gatewayId: "shared-0" } };
    const vm = { id: "user-roll", kind: "rollout", rolloutLane: "builder-vm" as const, input: { gatewayId: "sep092" } };
    expect(serialFleetOperationsConflict(cluster, vm)).toBe(false);
    expect(serialFleetOperationsConflict(vm, cluster)).toBe(false);
  });

  it.each(["cluster", "builder-vm"] as const)("allows only one rollout in the %s lane", (rolloutLane) => {
    expect(serialFleetOperationsConflict(
      { id: "first", kind: "rollout", rolloutLane, input: { gatewayId: "first" } },
      { id: "second", kind: "rollout", rolloutLane, input: { gatewayId: "second" } },
    )).toBe(true);
  });

  it("keeps overlapping resources locked even if rollout lanes differ", () => {
    expect(serialFleetOperationsConflict(
      { id: "first", kind: "rollout", rolloutLane: "cluster", input: { gatewayId: "same" } },
      { id: "second", kind: "rollout", rolloutLane: "builder-vm", input: { gatewayId: "same" } },
    )).toBe(true);
  });

  describe("a migration whose cutover has committed holds no serial lock", () => {
    const committed = {
      id: "committed",
      kind: "migrate-user",
      cutoverCommittedAt: 1_700_000_000_000,
      input: { fromGatewayId: "shared-0", toGatewayId: "shared-1" },
    };

    it("releases both its source and target for the next migration", () => {
      expect(serialFleetOperationsConflict(
        { id: "next", kind: "migrate-user", input: { fromGatewayId: "shared-0", toGatewayId: "shared-1" } },
        committed,
      )).toBe(false);
      expect(serialFleetOperationsConflict(
        committed,
        { id: "next", kind: "migrate-user", input: { fromGatewayId: "shared-0", toGatewayId: "shared-2" } },
      )).toBe(false);
    });

    it("keeps the lock until the cutover is recorded", () => {
      const { cutoverCommittedAt: _released, ...inFlight } = committed;
      expect(serialFleetOperationsConflict(
        { id: "next", kind: "migrate-user", input: { fromGatewayId: "shared-0", toGatewayId: "shared-1" } },
        inFlight,
      )).toBe(true);
    });

    it("still counts as an active migration for gateway retirement claims", () => {
      expect(findActiveGatewayMigration("shared-0", [{ ...committed, status: "running" }])?.id).toBe("committed");
    });
  });

  it("holds a Native return source rollout after cutover until the return completes", () => {
    const returning = { id: "builder-return-builder-0-g1", kind: "migrate-user", status: "running", cutoverCommittedAt: 100,
      input: { source: "builder-activation-lease", fromGatewayId: "builder-0", toGatewayId: "shared-0" } };
    const sourceRoll = { id: "roll", kind: "rollout", rolloutLane: "builder-vm" as const, input: { gatewayId: "builder-0" } };
    expect(serialFleetOperationsConflict(sourceRoll, returning)).toBe(true);
    expect(serialFleetOperationsConflict(returning, sourceRoll)).toBe(true);
    expect(serialFleetOperationsConflict({ ...sourceRoll, input: { gatewayId: "elsewhere" } }, returning)).toBe(false);
    expect(serialFleetOperationsConflict({ ...sourceRoll, rolloutLane: "cluster" }, returning)).toBe(false);
    expect(serialFleetOperationsConflict(sourceRoll, { ...returning, status: "succeeded" })).toBe(false);
  });

  it("holds the source rollout for a return an operator started, whatever its source tag or id", () => {
    const returning = { id: "5d0a3c1e-9f6b-4a53-8a0e-2b7c1d4e6f90", kind: "migrate-user", status: "running", cutoverCommittedAt: 100,
      input: { uid: "uid-lin", fromGatewayId: "lin-s-0a1b2c3d", toGatewayId: "shared-0" } };
    const sourceRoll = { id: "roll", kind: "rollout", rolloutLane: "builder-vm" as const, input: { gatewayId: "lin-s-0a1b2c3d" } };

    expect(serialFleetOperationsConflict(sourceRoll, returning)).toBe(true);
    expect(serialFleetOperationsConflict(returning, sourceRoll)).toBe(true);
    expect(serialFleetOperationsConflict(sourceRoll, { ...returning, status: "failed" })).toBe(false);
  });

  it("frees a shared source for rollout at cutover, as before", () => {
    const moved = { id: "move", kind: "migrate-user", status: "running", cutoverCommittedAt: 100,
      input: { uid: "uid-lin", fromGatewayId: "shared-1", toGatewayId: "shared-0" } };
    const sourceRoll = { id: "roll", kind: "rollout", rolloutLane: "builder-vm" as const, input: { gatewayId: "shared-1" } };

    expect(serialFleetOperationsConflict(sourceRoll, moved)).toBe(false);
  });

  it("does not let an unclassified rollout bypass a classified rollout", () => {
    expect(serialFleetOperationsConflict(
      { id: "first", kind: "rollout", input: { gatewayId: "first" } },
      { id: "second", kind: "rollout", rolloutLane: "builder-vm", input: { gatewayId: "second" } },
    )).toBe(true);
  });

});
