import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  signOfflineNativeRequest, verifyOfflineNativeResult, type OfflineNativeRecoveryIdentity,
} from "@octogee/core/held-native-offline-protocol";
import type { NativeReturnVerifiedBackup } from "./held-native-return-backup.js";
import type { OfflineNativeReturnCustody, ReadHeldNativeOfflineSourceHold } from "./held-native-offline-custody.js";

interface AuthorizedOfflineNativeInvocation {
  custody: OfflineNativeReturnCustody;
  identity: OfflineNativeRecoveryIdentity;
  maintenancePublicKey: string;
  verifiedHomeBackup: NativeReturnVerifiedBackup["homeBackup"];
}

type SignedOfflineEnvelope = { raw: string; signature: string };

export function digestHeldOfflineStoreBackups(backup: NativeReturnVerifiedBackup): string {
  const sorted = [...backup.storeBackups].sort((left, right) => left.store.storeId.localeCompare(right.store.storeId));
  const evidence = sorted.map(({ store, artifactId, immutableGeneration, artifactSha256 }) =>
    [store.storeId, store.databaseIdentity, artifactId, immutableGeneration, artifactSha256]);
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

function assertInvocationBindings(authorized: AuthorizedOfflineNativeInvocation, backup: NativeReturnVerifiedBackup, claimStartedAt: number) {
  const { holdGeneration, original, maintenance, immutableSnapshotId, cleanFileSha256, ownerAnchorSha256,
    claimStartedAt: boundClaimStartedAt, ownerStoreSha256, desiredSnapshotSha256, ...scope } = authorized.identity;
  const custody = authorized.custody;
  if (!isDeepStrictEqual(scope, backup.scope) || !isDeepStrictEqual(custody.scope, scope) ||
      holdGeneration !== backup.holdGeneration || boundClaimStartedAt !== claimStartedAt ||
      !isDeepStrictEqual(authorized.verifiedHomeBackup, backup.homeBackup) ||
      ownerStoreSha256 !== digestHeldOfflineStoreBackups(backup) || immutableSnapshotId !== custody.immutableHomeSnapshotId ||
      !/^[a-f0-9]{64}$/.test(cleanFileSha256) || !/^[a-f0-9]{64}$/.test(ownerAnchorSha256) || !/^[a-f0-9]{64}$/.test(desiredSnapshotSha256)) {
    throw new Error("Held Native offline invocation changed its owner claim or backup evidence");
  }
  const source = { instanceId: backup.source.vmId, bootDiskId: backup.source.bootDiskId, homeDiskId: backup.source.homeDiskId };
  const enrolled = {
    instanceId: custody.maintenance.instanceId, bootDiskId: custody.maintenance.bootDiskId, bootId: custody.maintenance.bootId,
    acceptedImageId: custody.maintenance.imageId, cloneDiskId: custody.maintenance.readOnlyCloneDiskId,
  };
  if (!isDeepStrictEqual(original, source) || !isDeepStrictEqual(maintenance, enrolled) || original.instanceId === maintenance.instanceId) {
    throw new Error("Held Native offline invocation changed its original or maintenance compute");
  }
}

export function createHeldNativeOfflineSourceClient(deps: {
  privateKey: string;
  readHold: ReadHeldNativeOfflineSourceHold;
  loadInvocation(backup: NativeReturnVerifiedBackup, claimStartedAt: number): Promise<AuthorizedOfflineNativeInvocation>;
  dispatch(maintenance: OfflineNativeReturnCustody["maintenance"], input: SignedOfflineEnvelope): Promise<SignedOfflineEnvelope>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  return async (input: {
    backup: NativeReturnVerifiedBackup;
    claimStartedAt: number;
    action: "reconcile" | "rollback";
    assertJournalCurrent(): Promise<void>;
  }) => {
    const { backup, claimStartedAt, action, assertJournalCurrent } = input;
    const assertBindingCurrent = async () => {
      await assertJournalCurrent();
      const hold = await deps.readHold(backup.scope);
      const expectedStores = backup.storeBackups.map(({ store }) => store).sort((a, b) => a.storeId.localeCompare(b.storeId));
      if (!hold || hold.generation !== backup.holdGeneration || hold.heldSince !== backup.heldSince ||
          !isDeepStrictEqual(hold.scope, backup.scope) || !isDeepStrictEqual(hold.source, backup.source) ||
          !isDeepStrictEqual([...hold.stores].sort((a, b) => a.storeId.localeCompare(b.storeId)), expectedStores)) {
        throw new Error("Held Native offline hold changed before or during maintenance");
      }
    };
    await assertBindingCurrent();
    const enrolled = await deps.loadInvocation(backup, claimStartedAt);
    assertInvocationBindings(enrolled, backup, claimStartedAt);
    const request = { identity: enrolled.identity, action, nonce: randomBytes(32).toString("hex"), expiresAt: now() + 115_000 };
    const signed = signOfflineNativeRequest(request, deps.privateKey);
    const result = await deps.dispatch(enrolled.custody.maintenance, signed);
    await assertBindingCurrent();
    if (!isDeepStrictEqual(await deps.loadInvocation(backup, claimStartedAt), enrolled)) {
      throw new Error("Held Native offline maintenance enrollment changed while processing the request");
    }
    const proof = verifyOfflineNativeResult({ ...result, request, maintenancePublicKey: enrolled.maintenancePublicKey, now: now() });
    await assertJournalCurrent();
    return proof;
  };
}
