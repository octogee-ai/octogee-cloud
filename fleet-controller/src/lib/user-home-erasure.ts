import { isDeepStrictEqual } from "node:util";
import type { RetainedUserHome, RetainedUserHomeSnapshot } from "@octogee/shared/types/glm";
import type { UserHomeState, OpaqueMap, PlatformStateStore, PlatformUserRecord, UserHomeArchive } from "@octogee/core/platform-state";
import type { HomeCopyInput, UserHomeLocation, UserHomeMigration, UserHomeStorage } from "@octogee/core/isolated-gateway-lifecycle";

import type { GatewayVmClient } from "./compute-vm.js";

interface UserHomeErasureDeps {
  store: PlatformStateStore;
  removeStoppedHome(uid: string, home: UserHomeLocation): Promise<boolean>;
  copy: { abort(input: HomeCopyInput): Promise<boolean>; sweep(input: HomeCopyInput): Promise<boolean> };
  remainingOwnerHomes(uid: string): Promise<string[]>;
  log(message: string): void;
}

export async function eraseUserComputerStorage(deps: UserHomeErasureDeps & {
  compute: Pick<GatewayVmClient, "archiveDisksAbsent" | "eraseHomeSnapshot">;
  deleteVm(uid: string): Promise<boolean>;
}, uid: string): Promise<boolean> {
  const erasedArchive = await eraseArchivedHome(deps, uid);
  const deleted = await deps.deleteVm(uid);
  if (!await eraseUserHomeMigrationStorage(deps, uid)) {
    throw new Error("User home cleanup is still converging; erasure tracking retained for retry");
  }
  return erasedArchive || deleted;
}

function archiveHasNoWriters(owner: PlatformUserRecord): boolean {
  return Object.values(owner.fences).every(fence => fence === undefined);
}

function archiveHasNoSecondaryHome(home: UserHomeState): boolean {
  return home.homeStorage === undefined && home.homeMigration === undefined && home.homeErasure === undefined;
}

function validateArchivedSource(owner: PlatformUserRecord, home: RetainedUserHome, snapshot: RetainedUserHomeSnapshot): void {
  if (owner.home.computer !== undefined || !archiveHasNoSecondaryHome(owner.home)) {
    throw new Error("User home archive must settle before erasure; storage retained for retry");
  }
  if (home.id !== snapshot.sourceDiskId || home.source !== snapshot.sourceDisk ||
      home.projectId !== snapshot.projectId || home.sizeGb !== snapshot.sizeGb) {
    throw new Error("User home archive source disk receipt does not match the snapshot");
  }
}

function validateRestoredHome(home: RetainedUserHome, archive: Extract<UserHomeArchive, { phase: "restored" }>): void {
  if (home.id !== archive.restoredDisk?.id || home.source !== archive.restoredDisk.source ||
      home.id === archive.snapshot.sourceDiskId || home.source === archive.snapshot.sourceDisk) {
    throw new Error("User home archive restored disk receipt does not match the active home");
  }
}

function archiveErasureCustody(owner: PlatformUserRecord) {
  if (owner.accountLifecycle?.status !== "erasing") throw new Error("User home archive requires account erasure authority");
  const archive = owner.home.homeArchive;
  if (!archiveHasNoWriters(owner) || (archive?.phase !== "archived" && archive?.phase !== "restored")) {
    throw new Error("User home archive must settle before erasure; storage retained for retry");
  }
  const home = owner.home.homeDisk as unknown as RetainedUserHome | undefined;
  if (!archive.snapshot || !archive.bootDisk || !home) throw new Error("User home archive is missing the source disk receipt");
  if (archive.phase === "archived") {
    validateArchivedSource(owner, home, archive.snapshot);
  } else {
    validateRestoredHome(home, archive);
  }
  return { archive, home, deletionId: owner.accountLifecycle.deletionId };
}

async function eraseArchivedHome(deps: {
  store: PlatformStateStore;
  compute: Pick<GatewayVmClient, "archiveDisksAbsent" | "eraseHomeSnapshot">;
}, uid: string): Promise<boolean> {
  const owner = await deps.store.users.records.get(uid);
  if (!owner?.home.homeArchive) return false;
  const proof = archiveErasureCustody(owner);
  if (proof.archive.phase === "archived" && !await deps.compute.archiveDisksAbsent(proof.home, proof.archive.bootDisk)) {
    throw new Error("User home archive disk absence is not verified; storage retained for retry");
  }
  if (!await deps.compute.eraseHomeSnapshot(proof.archive.snapshot, uid)) {
    throw new Error("User home archive snapshot erasure is still converging; storage retained for retry");
  }
  await deps.store.transaction({ label: "builder-home-erasure.clear-archive" }, async tx => {
    const current = await tx.users.records.get(uid);
    if (!current || !isDeepStrictEqual(archiveErasureCustody(current), proof)) {
      throw new Error("User home archive custody changed during erasure");
    }
    await tx.users.records.patch(uid, {
      home: { homeArchive: { clear: true }, ...(proof.archive.phase === "archived" ? { homeDisk: { clear: true } } : {}) },
    }, { revision: current.revision });
  });
  return true;
}

export async function eraseUserHomeMigrationStorage(deps: UserHomeErasureDeps, uid: string): Promise<boolean> {
  const owner = await deps.store.users.records.get(uid);
  if (!owner) {
    const remaining = await deps.remainingOwnerHomes(uid);
    if (remaining.length) throw new Error(`home erasure owner record is missing while home storage remains: ${remaining.join(", ")}`);
    deps.log(`[home-erasure] ${uid}: owner record already erased and no owner-labelled home storage remains`);
    return true;
  }
  if (owner.home.homeArchive !== undefined) throw new Error("User home archive requires explicit snapshot erasure");
  const migration = owner.home.homeMigration as UserHomeMigration | undefined;
  if (migration?.copy) {
    const adopted = ["adopting", "complete"].includes(migration.phase);
    if (!await (adopted ? deps.copy.sweep(migration.copy) : deps.copy.abort(migration.copy))) return false;
  }
  let queue = owner.home.homeErasure as readonly UserHomeLocation[] | undefined;
  if (!queue) {
    queue = homeErasureQueue(owner.home, migration);
    if (!queue.length) return true;
    await deps.store.users.records.patch(uid, { home: { homeErasure: storedQueue(queue) } });
  }
  if (queue.length) {
    if (!await deps.removeStoppedHome(uid, queue[0])) return false;
    const removed = queue[0].disk.id;
    await deps.store.transaction({ label: "builder-home-erasure.dequeue" }, async tx => {
      const current = await tx.users.records.get(uid);
      const erasure = current?.home.homeErasure as readonly UserHomeLocation[] | undefined;
      if (!current || !erasure || erasure[0]?.disk?.id !== removed) throw new Error("home erasure queue changed");
      await tx.users.records.patch(uid, { home: { homeErasure: storedQueue(erasure.slice(1)) } }, { revision: current.revision });
    });
    return false;
  }
  await deps.store.users.records.patch(uid, { home: {
    homeStorage: { clear: true }, homeMigration: { clear: true }, homeErasure: { clear: true }, homeCapacity: { clear: true },
  } });
  return true;
}

function storedQueue(homes: readonly UserHomeLocation[]): readonly OpaqueMap[] {
  return homes as unknown as readonly OpaqueMap[];
}

function homeErasureQueue(home: UserHomeState, migration?: UserHomeMigration): UserHomeLocation[] {
    const storage = home.homeStorage as UserHomeStorage | undefined;
    const homes: UserHomeLocation[] = [...(storage?.retained ?? [])];
    if (storage?.disk) homes.push(storage);
    if (migration?.source) homes.push(migration.source);
    if (migration?.target && ["adopting", "complete"].includes(migration.phase)) homes.push({ runtime: "gce-vm", layout: "portable", disk: migration.target });
    const unique = new Map<string, UserHomeLocation>();
    for (const home of homes) if (!unique.has(home.disk.id)) unique.set(home.disk.id, home);
    return [...unique.values()];
}
