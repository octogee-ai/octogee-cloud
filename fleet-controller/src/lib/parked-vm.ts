import type { UserHomeState, PlatformStateRepositories, PlatformStateStore, RecordPatch } from "@octogee/core/platform-state";
import { isUserParkedVm, isDisposableHomeCheckpoint, type GatewayVmHomeCheckpoint, type UserParkedVm, type RetainedUserHome } from "@octogee/shared/types/glm";

export async function readParkedVm(state: Pick<PlatformStateRepositories, "users">, ownerUid: string): Promise<UserParkedVm | null> {
  const parked = (await state.users.records.get(ownerUid))?.home.computer;
  if (parked === undefined) return null;
  if (!isUserParkedVm(parked)) throw new Error(`User ${ownerUid}: parked computer record is malformed`);
  return parked;
}

export async function readHomeRecovery(state: Pick<PlatformStateRepositories, "users">, ownerUid: string): Promise<GatewayVmHomeCheckpoint | null> {
  const value = (await state.users.records.get(ownerUid))?.home.homeCheckpoint;
  if (value === undefined) return null;
  if (!isDisposableHomeCheckpoint(value)) throw new Error(`User ${ownerUid}: home recovery checkpoint is malformed`);
  return value;
}

async function updateParkedVm(store: PlatformStateStore, ownerUid: string, home: RecordPatch<UserHomeState>): Promise<void> {
  await store.transaction({ label: "parked-computer.update" }, async tx => {
    const current = await tx.users.records.get(ownerUid);
    if (!current) throw new Error(`User ${ownerUid}: VM owner disappeared`);
    if (current.fences.computerRecovery !== undefined) throw new Error(`User ${ownerUid}: VM recovery is in progress`);
    await tx.users.records.patch(ownerUid, { home }, { revision: current.revision });
  });
}

export async function writeParkedVm(store: PlatformStateStore, ownerUid: string, record: UserParkedVm): Promise<void> {
  await updateParkedVm(store, ownerUid, { computer: record, ...(record.disposable ? { homeCheckpoint: record.homeCheckpoint } : {}) });
}

export async function clearParkedVm(store: PlatformStateStore, ownerUid: string): Promise<void> {
  await updateParkedVm(store, ownerUid, { computer: { clear: true } });
}

export async function releaseParkedVm(store: PlatformStateStore, ownerUid: string): Promise<void> {
  if (await readParkedVm(store, ownerUid)) await clearParkedVm(store, ownerUid);
}

function validHomeIdentity(value: Partial<RetainedUserHome> | null | undefined): boolean {
  if (!value) return false;
  const names = [value.projectId, value.zone, value.name];
  return names.every(name => typeof name === "string" && /^[a-z][a-z0-9-]{0,62}$/u.test(name))
    && /^\d+$/u.test(value.id ?? "")
    && value.source === `projects/${value.projectId}/zones/${value.zone}/disks/${value.name}`;
}
function validHomeCapacity(value: Partial<RetainedUserHome> | null | undefined): boolean {
  return Boolean(value && Number.isSafeInteger(value.sizeGb) && value.sizeGb! >= 10 && ["pd-balanced", "pd-ssd"].includes(value.diskType ?? ""));
}

export async function readRetainedUserHome(state: Pick<PlatformStateRepositories, "users">, ownerUid: string): Promise<RetainedUserHome | null> {
  const value = (await state.users.records.get(ownerUid))?.home.homeDisk as Partial<RetainedUserHome> | undefined;
  if (value === undefined) return null;
  if (!validHomeIdentity(value) || !validHomeCapacity(value)) {
    throw new Error(`User ${ownerUid}: retained home disk record is malformed`);
  }
  return value as RetainedUserHome;
}

export async function recordRetainedUserHome(store: PlatformStateStore, ownerUid: string, home: RetainedUserHome): Promise<void> {
  await store.transaction({ label: "parked-computer.retain-home" }, async tx => {
    const current = await tx.users.records.get(ownerUid);
    if (!current) throw new Error(`User ${ownerUid}: home owner disappeared`);
    const prior = current.home.homeDisk;
    if (prior !== undefined && (prior.id !== home.id || prior.source !== home.source)) {
      throw new Error(`User ${ownerUid}: retaining the original home; migration is required for another disk`);
    }
    await tx.users.records.patch(ownerUid, { home: { homeDisk: { ...prior, ...home } } }, { revision: current.revision });
  });
}
