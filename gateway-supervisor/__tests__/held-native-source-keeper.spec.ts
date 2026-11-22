import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { HeldNativeSourceBinding } from "@octogee/shared/types/fleet-controller";
import { acquireHeldNativeSourceKeeper } from "../lib/held-native-source-keeper.js";

const source = { vmId: "21", bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", bootDiskId: "22", homeDiskId: "23" };
const binding: HeldNativeSourceBinding = {
  ...source, requestId: "request-fixture", holdGeneration: "generation-fixture",
  uid: "owner", slug: "owner", gatewayId: "source", targetGatewayId: "target",
  operationId: "operation-fixture", sourceEpoch: 22, schedulerMigrationId: "migration-fixture", claimStartedAt: 1000,
};

async function harness() {
  const homeDirectory = await mkdtemp(`${tmpdir()}/held-native-source-keeper-`);
  const deps = {
    homeDirectory,
    readSourceBacking: vi.fn(async () => source),
    assertWorkerClaim: vi.fn(async () => {}),
    assertOrdinaryWritersExcluded: vi.fn(async () => {}),
    assertOwnerStoreWritesHeld: vi.fn(async () => {}),
  };
  const keeper = await acquireHeldNativeSourceKeeper(binding, deps);
  return {
    keeper, deps,
    async cleanup() {
      await keeper.close();
      await rm(homeDirectory, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform !== "linux")("held Native source keeper", () => {
  it("owns the actual mount lock throughout signed work and rejects retries", async () => {
    const { keeper, deps, cleanup } = await harness();
    const work = vi.fn(async (assertHeld: () => Promise<void>) => {
      await assertHeld();
      expect(spawnSync("/usr/bin/flock", ["-n", deps.homeDirectory, "-c", "true"]).status).toBe(1);
      await expect(keeper.close()).rejects.toThrow(/release.*during/);
      await expect(keeper.runExclusive(binding, async () => {})).rejects.toThrow(/already running/);
      return "reconciled";
    });
    try {
      await expect(keeper.runExclusive(binding, work)).resolves.toBe("reconciled");
      await expect(keeper.runExclusive(binding, work)).rejects.toThrow(/already attempted/);
      expect(work).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup();
    }
  });

  it("rejects a stale claim and an authentic claim that lost its database writer barrier", async () => {
    const { keeper, deps, cleanup } = await harness();
    const work = vi.fn(async () => {});
    try {
      await expect(keeper.runExclusive({ ...binding, claimStartedAt: 900 }, work)).rejects.toThrow(/stale/);
      deps.assertOwnerStoreWritesHeld.mockRejectedValueOnce(new Error("store writer barrier lost"));
      await expect(keeper.runExclusive(binding, work)).rejects.toThrow(/store writer barrier lost/);
      deps.assertWorkerClaim.mockRejectedValueOnce(new Error("broker claim revoked"));
      await expect(keeper.runExclusive(binding, work)).rejects.toThrow(/broker claim revoked/);
      expect(work).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});
