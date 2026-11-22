import { isDeepStrictEqual } from "node:util";

export interface NativeReturnBackupScope {
  operationId: string;
  uid: string;
  slug: string;
  sourceGatewayId: string;
  targetGatewayId: string;
  schedulerMigrationId: string;
  sourceEpoch: number;
  requestId: string;
}

interface SourceBacking {
  vmId: string;
  bootId: string;
  bootDiskId: string;
  homeDiskId: string;
}

interface StoreBacking {
  storeId: string;
  databaseIdentity: string;
}

export interface NativeReturnOwnerHold {
  scope: NativeReturnBackupScope;
  generation: string;
  heldSince: number;
  source: SourceBacking;
  stores: StoreBacking[];
}

interface RestoredBackupArtifact {
  scope: NativeReturnBackupScope;
  holdGeneration: string;
  artifactId: string;
  immutableGeneration: string;
  captureStartedAt: number;
  capturedAt: number;
  restoredAt: number;
  artifactSha256: string;
  sourceContentSha256: string;
  restoredContentSha256: string;
}

export interface RestoredNativeHome extends RestoredBackupArtifact {
  source: SourceBacking;
}

export interface RestoredNativeStore extends RestoredBackupArtifact {
  store: StoreBacking;
}

type ImmutableBackup = Pick<RestoredBackupArtifact, "artifactId" | "immutableGeneration" | "artifactSha256">;

export interface NativeReturnVerifiedBackup {
  scope: NativeReturnBackupScope;
  holdGeneration: string;
  heldSince: number;
  source: SourceBacking;
  homeBackup: ImmutableBackup;
  storeBackups: (ImmutableBackup & { store: StoreBacking })[];
}

export interface NativeReturnBackupReaders {
  acquireAuthenticatedOwnerHold?(authority: NativeReturnBackupScope & { claimStartedAt: number }): Promise<NativeReturnOwnerHold>;
  readAuthenticatedOwnerHold(scope: NativeReturnBackupScope): Promise<NativeReturnOwnerHold | null>;
  verifyRestoredSource(hold: NativeReturnOwnerHold, assertCurrent: () => Promise<void>): Promise<RestoredNativeHome>;
  verifyRestoredStores(hold: NativeReturnOwnerHold, assertCurrent: () => Promise<void>): Promise<RestoredNativeStore[]>;
  now(): number;
}

const digest = /^[a-f0-9]{64}$/;
const providerId = /^[1-9]\d*$/;
const bootId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function normalizedStores(stores: StoreBacking[]): StoreBacking[] {
  return [...stores].sort((left, right) => left.storeId.localeCompare(right.storeId));
}

function assertExactHold(hold: NativeReturnOwnerHold | null, scope: NativeReturnBackupScope, now: number): asserts hold is NativeReturnOwnerHold {
  if (!hold || !isDeepStrictEqual(hold.scope, scope) || !digest.test(hold.generation) ||
      !Number.isSafeInteger(hold.heldSince) || hold.heldSince <= 0 || hold.heldSince > now) {
    throw new Error("Native return backup requires the exact authenticated source owner hold");
  }
  if (![providerId.test(hold.source.vmId), bootId.test(hold.source.bootId), providerId.test(hold.source.bootDiskId),
    providerId.test(hold.source.homeDiskId), hold.source.bootDiskId !== hold.source.homeDiskId].every(Boolean)) {
    throw new Error("Native return backup source VM, boot and home disk identity are incomplete");
  }
  const distinctStoreIds = new Set(hold.stores.map(store => store.storeId));
  if (!distinctStoreIds.size || distinctStoreIds.size !== hold.stores.length ||
      hold.stores.some(store => !store.storeId || !store.databaseIdentity)) {
    throw new Error("Native return backup owner store roster is incomplete");
  }
}

function assertArtifactHeader(artifact: RestoredBackupArtifact, hold: NativeReturnOwnerHold, now: number) {
  const timestamps = [hold.heldSince, artifact.captureStartedAt, artifact.capturedAt, artifact.restoredAt, now];
  if (!isDeepStrictEqual(artifact.scope, hold.scope) || artifact.holdGeneration !== hold.generation ||
      !artifact.artifactId || !artifact.immutableGeneration ||
      !timestamps.every((timestamp, index) => Number.isSafeInteger(timestamp) && (index === 0 || timestamp >= timestamps[index - 1]!))) {
    throw new Error("Native return backup was not captured and restored under the same current owner hold");
  }
  if (!digest.test(artifact.artifactSha256) || !digest.test(artifact.sourceContentSha256) ||
      artifact.sourceContentSha256 !== artifact.restoredContentSha256) {
    throw new Error("Native return backup failed independent restored content verification");
  }
}

function immutableBackup({ artifactId, immutableGeneration, artifactSha256 }: RestoredBackupArtifact): ImmutableBackup {
  return { artifactId, immutableGeneration, artifactSha256 };
}

export function createHeldNativeReturnBackupVerifier(readers: NativeReturnBackupReaders) {
  const requireCurrentHold = async (scope: NativeReturnBackupScope, assertCurrent: () => Promise<void>) => {
    await assertCurrent();
    const hold = await readers.readAuthenticatedOwnerHold(scope);
    assertExactHold(hold, scope, readers.now());
    return { ...hold, stores: normalizedStores(hold.stores) };
  };
  const assertBackupCurrent = async (
    binding: NativeReturnVerifiedBackup, scope: NativeReturnBackupScope, assertCurrent: () => Promise<void>,
  ): Promise<void> => {
    const hold = await requireCurrentHold(scope, assertCurrent);
    const expected = {
      scope: binding.scope, generation: binding.holdGeneration, heldSince: binding.heldSince,
      source: binding.source, stores: normalizedStores(binding.storeBackups.map(({ store }) => store)),
    };
    if (!isDeepStrictEqual(hold, expected)) throw new Error("Native return backup owner hold or backing changed");
    await assertCurrent();
  };
  const verifyBackup = async (
    authority: NativeReturnBackupScope & { claimStartedAt: number }, assertCurrent: () => Promise<void>,
  ): Promise<NativeReturnVerifiedBackup> => {
    const { claimStartedAt, ...scope } = authority;
    if (!Number.isSafeInteger(claimStartedAt) || claimStartedAt <= 0 || claimStartedAt > readers.now()) {
      throw new Error("Native return backup has no current repair claim");
    }
    const acquire = readers.acquireAuthenticatedOwnerHold;
    let acquired: NativeReturnOwnerHold | undefined;
    if (acquire) {
      await assertCurrent();
      acquired = await acquire(authority);
      assertExactHold(acquired, scope, readers.now());
      if (acquired.heldSince < claimStartedAt) throw new Error("Native return owner hold predates its current claim");
    }
    const pinnedHold = structuredClone(await requireCurrentHold(scope, assertCurrent));
    if (acquired) {
      if (!isDeepStrictEqual({ ...acquired, stores: normalizedStores(acquired.stores) }, pinnedHold)) {
        throw new Error("Native return owner hold changed after acquisition");
      }
    }
    const assertPinned = async () => {
      const latest = await requireCurrentHold(scope, assertCurrent);
      if (!isDeepStrictEqual(pinnedHold, latest)) {
        throw new Error("Native return backup owner hold or backing changed");
      }
    };

    const home = await readers.verifyRestoredSource(pinnedHold, assertPinned);
    await assertPinned();
    const stores = await readers.verifyRestoredStores(pinnedHold, assertPinned);
    if (!isDeepStrictEqual(home.source, pinnedHold.source) ||
        !isDeepStrictEqual(normalizedStores(stores.map(({ store }) => store)), pinnedHold.stores)) {
      throw new Error("Native return backup does not cover the pinned source and every registered owner store");
    }
    const now = readers.now();
    for (const artifact of [home, ...stores]) assertArtifactHeader(artifact, pinnedHold, now);
    await assertPinned();
    return {
      scope: pinnedHold.scope, holdGeneration: pinnedHold.generation, heldSince: pinnedHold.heldSince,
      source: pinnedHold.source, homeBackup: immutableBackup(home),
      storeBackups: stores.map(artifact => ({ ...immutableBackup(artifact), store: structuredClone(artifact.store) })),
    };
  };

  return { verifyBackup, assertBackupCurrent };
}
