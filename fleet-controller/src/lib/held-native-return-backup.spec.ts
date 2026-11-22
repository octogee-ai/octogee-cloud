import { describe, expect, it, vi } from "vitest";
import {
  createHeldNativeReturnBackupVerifier,
  type NativeReturnOwnerHold, type RestoredNativeHome, type RestoredNativeStore,
} from "./held-native-return-backup.js";

const scope = {
  operationId: "held-native-fixture", uid: "owner-fixture", slug: "owner-fixture",
  sourceGatewayId: "source-fixture", targetGatewayId: "target-fixture", schedulerMigrationId: "migration-fixture",
  requestId: "request-fixture", sourceEpoch: 2,
};

function harness() {
  const hold: NativeReturnOwnerHold = {
    scope, generation: "a".repeat(64), heldSince: 1000,
    source: { vmId: "501", bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", bootDiskId: "502", homeDiskId: "503" },
    stores: [{ storeId: "workspace", databaseIdentity: "primary/workspace" }, { storeId: "agent", databaseIdentity: "primary/agent" }],
  };
  const artifact = {
    scope, holdGeneration: hold.generation, immutableGeneration: "11", captureStartedAt: 1110, capturedAt: 1200, restoredAt: 1400,
    artifactSha256: "c".repeat(64), sourceContentSha256: "d".repeat(64), restoredContentSha256: "d".repeat(64),
  };
  const home: RestoredNativeHome = { ...artifact, source: hold.source, artifactId: "fixture-home" };
  const stores: RestoredNativeStore[] = hold.stores.map(store => ({ ...artifact, store, artifactId: store.storeId, capturedAt: 1250 }));
  const assertCurrent = vi.fn(async () => {});
  const readers = {
    readAuthenticatedOwnerHold: vi.fn(async (): Promise<NativeReturnOwnerHold | null> => structuredClone(hold)),
    verifyRestoredSource: vi.fn(async () => home),
    verifyRestoredStores: vi.fn(async () => stores),
    now: () => 1500,
  };
  const adapter = createHeldNativeReturnBackupVerifier(readers);
  return { hold, home, stores, readers, assertCurrent, adapter, authority: { ...scope, claimStartedAt: 1300 } };
}

describe("held Native source and store backup custody", () => {
  it("requires matching home and all store restoration evidence under one continuous pinned hold", async () => {
    const { adapter, readers, assertCurrent, authority } = harness();
    const binding = await adapter.verifyBackup(authority, assertCurrent);
    expect(binding).toMatchObject({
      source: { vmId: "501", bootDiskId: "502", homeDiskId: "503" }, holdGeneration: "a".repeat(64),
      homeBackup: { artifactId: "fixture-home", immutableGeneration: "11" },
    });
    expect(binding.storeBackups).toHaveLength(2);
    await adapter.assertBackupCurrent(binding, scope, assertCurrent);
    expect(readers.verifyRestoredStores).toHaveBeenCalledTimes(1);
    expect(readers.verifyRestoredSource).toHaveBeenCalledTimes(1);
  });

  it("does not count separately timed, individually restored backups that predate the owner hold", async () => {
    const { adapter, home, assertCurrent, authority } = harness();
    home.captureStartedAt = 900;
    await expect(adapter.verifyBackup(authority, assertCurrent)).rejects.toThrow(/same current owner hold/);
  });

  it("rejects a rotated hold within the captures, or a different home disk on the same VM", async () => {
    const { adapter, hold, readers, assertCurrent, authority } = harness();
    readers.readAuthenticatedOwnerHold.mockResolvedValueOnce(structuredClone(hold));
    readers.readAuthenticatedOwnerHold.mockResolvedValueOnce({ ...hold, generation: "b".repeat(64) });
    await expect(adapter.verifyBackup(authority, assertCurrent)).rejects.toThrow(/hold or backing changed/);
    const binding = await adapter.verifyBackup(authority, assertCurrent);
    hold.source.homeDiskId = "504";
    await expect(adapter.assertBackupCurrent(binding, scope, assertCurrent)).rejects.toThrow(/hold or backing changed/);
  });

  it("refuses a missing store and a different restored database manifest", async () => {
    const { adapter, stores, assertCurrent, authority } = harness();
    const first = stores.shift()!;
    await expect(adapter.verifyBackup(authority, assertCurrent)).rejects.toThrow(/every registered owner store/);
    stores.push({ ...first, restoredContentSha256: "e".repeat(64) });
    await expect(adapter.verifyBackup(authority, assertCurrent)).rejects.toThrow(/restored content verification/);
  });

  it("rejects old operation authority, another owner, and wrong-epoch proof", async () => {
    const { adapter, home, assertCurrent, authority } = harness();
    await expect(adapter.verifyBackup({ ...authority, requestId: "stale" }, assertCurrent)).rejects.toThrow(/exact authenticated source owner hold/);
    await expect(adapter.verifyBackup({ ...authority, uid: "another-owner" }, assertCurrent)).rejects.toThrow(/exact authenticated source owner hold/);
    home.scope = { ...scope, sourceEpoch: scope.sourceEpoch + 1 };
    await expect(adapter.verifyBackup(authority, assertCurrent)).rejects.toThrow(/same current owner hold/);
  });
});
