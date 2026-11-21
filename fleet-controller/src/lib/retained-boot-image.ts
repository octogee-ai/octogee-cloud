import { retainedBootPreservesScheduler } from "@octogee/core/admin-fleet-router";
import type { OpaqueMap, PlatformStateRepositories, PlatformStateStore, PlatformUserRecord } from "@octogee/core/platform-state";
import type { GatewayVmSpec, RetainedUserHome } from "@octogee/shared/types/glm";
import type { ComputeImageRef, GatewayVmClient } from "./compute-vm.js";
import { hasHistoricalSchedulerBootLineage, preservesLegacySchedulerRetirement, readNativeSchedulerRetirement } from "./native-scheduler-retirement.js";

export interface RetainedBootImage extends ComputeImageRef {
  project: string;
  homeId: string;
  previous: { name: string; id: string } | null;
  operationId: string | null;
  sourceComputer: { name: string; zone: string; instanceId: string; gatewayId: string } | null;
  nativeSchedulerRetirement?: OpaqueMap;
  legacySchedulerRetirement?: OpaqueMap;
}
type BootImages = Pick<GatewayVmClient, "readImage" | "readFamilyImage">;

const imageName = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;

async function verifyPinnedBootImage(vm: BootImages, home: RetainedUserHome, prior: RetainedBootImage): Promise<void> {
  if (!prior || prior.homeId !== home.id || !imageName.test(prior.name) || !/^[1-9]\d{0,19}$/u.test(prior.id)
    || !imageName.test(prior.project)) throw new Error("retained boot image anchor is malformed");
  const observed = await vm.readImage(prior.name, prior.project);
  if (observed.id !== prior.id || observed.name !== prior.name || !observed.homeAdmission) throw new Error("pinned retained boot image identity or admission contract changed");
}

function assertPinnedSource(prior: RetainedBootImage, previous: ComputeImageRef, source: RetainedBootImage["sourceComputer"] | undefined): void {
  if (!prior.sourceComputer || !source || ["instanceId", "name", "zone", "gatewayId"].some(key => prior.sourceComputer![key as keyof typeof source] !== source[key as keyof typeof source])
    || prior.previous?.id !== previous.id || prior.previous?.name !== previous.name) throw new Error("retained boot operation source changed");
}

function hasExactPredecessor(pinned: RetainedBootImage | undefined, previous: ComputeImageRef): pinned is RetainedBootImage {
  return pinned !== undefined && !!pinned.operationId && pinned.id === previous.id && pinned.name === previous.name;
}

function provisionedSuccessor(owner: PlatformUserRecord, sourceGatewayId: string, previousGatewayId: string): boolean {
  const lease = owner.activationLease;
  return lease?.status === "provisioning" && (sourceGatewayId === previousGatewayId || lease.targetGatewayId === sourceGatewayId);
}

type SchedulerRetirement = NonNullable<ReturnType<typeof readNativeSchedulerRetirement>>;
type BootSource = NonNullable<RetainedBootImage["sourceComputer"]>;
function assertSchedulerSource(owner: PlatformUserRecord, home: RetainedUserHome, source: BootSource, pending: SchedulerRetirement): void {
  if (pending.uid !== owner.uid || pending.slug !== owner.slug || pending.homeDiskId !== home.id ||
      pending.homeDiskSource !== home.source || pending.zone !== source.zone || pending.instanceName !== source.name) {
    throw new Error("Retained boot replacement scheduler home or owner identity changed");
  }
}

async function schedulerRetirementForReplacement(state: PlatformStateRepositories, owner: PlatformUserRecord, input: {
  home: RetainedUserHome; source: BootSource; previous: ComputeImageRef; pinned: RetainedBootImage | undefined;
}): Promise<Pick<RetainedBootImage, "nativeSchedulerRetirement" | "legacySchedulerRetirement">> {
  const { home, source, previous, pinned } = input;
  const pending = readNativeSchedulerRetirement(owner.fences.pendingNativeSchedulerRetirement);
  if (!pending) return {};
  assertSchedulerSource(owner, home, source, pending);
  if (pending.instanceId === source.instanceId) {
    if (pending.sourceGatewayId !== source.gatewayId && owner.activationLease?.targetGatewayId !== source.gatewayId) {
      throw new Error("Retained boot replacement scheduler source gateway changed");
    }
    return {};
  }
  if (pending.completedAt === undefined || !hasExactPredecessor(pinned, previous)) {
    throw new Error("Retained boot replacement cannot prove scheduler lineage from the previous image");
  }
  if (retainedBootPreservesScheduler({ ...pinned }, pending, [source.gatewayId])) return { nativeSchedulerRetirement: pending };
  if (await preservesHistoricalBoot(state, owner, source, pinned, pending)) return { legacySchedulerRetirement: pending };
  throw new Error("Retained boot replacement cannot prove scheduler lineage from the previous image");
}

async function preservesHistoricalBoot(state: PlatformStateRepositories, owner: PlatformUserRecord,
  source: NonNullable<RetainedBootImage["sourceComputer"]>, pinned: RetainedBootImage,
  pending: SchedulerRetirement): Promise<boolean> {
  if (!provisionedSuccessor(owner, source.gatewayId, pending.sourceGatewayId)) return false;
  return preservesLegacySchedulerRetirement({ ...pinned }, pending, [pending.sourceGatewayId, source.gatewayId]) ||
    await hasHistoricalSchedulerBootLineage(state, owner, pending, { ...pinned }, source.instanceId);
}

export async function selectRetainedBootImage(input: { store: PlatformStateStore; vm: BootImages; ownerUid: string;
  home: RetainedUserHome; spec: GatewayVmSpec; previous?: ComputeImageRef; operationId?: string; sourceComputer?: RetainedBootImage["sourceComputer"] }): Promise<RetainedBootImage> {
  const { store, vm, ownerUid, home, spec, previous } = input;
  const prior = (await store.users.records.get(ownerUid))?.home.homeDisk?.bootImage as RetainedBootImage | undefined;
  let selected: RetainedBootImage;
  if (prior !== undefined && (!previous || prior?.operationId === input.operationId)) {
    await verifyPinnedBootImage(vm, home, prior);
    if (previous) assertPinnedSource(prior, previous, input.sourceComputer);
    selected = prior;
  } else {
    const project = spec.imageProject ?? home.projectId;
    const image = await vm.readFamilyImage(spec.imageFamily, project);
    if (!image.homeAdmission) throw new Error("replacement boot requires qualified current-SSH authority and native home migration admission");
    const candidate = { ...image, project, homeId: home.id, previous: previous ? { name: previous.name, id: previous.id } : null,
      operationId: input.operationId ?? null, sourceComputer: input.sourceComputer ?? null };
    selected = await store.transaction({ label: "retained-boot-image.select" }, async tx => {
      const fresh = await tx.users.records.get(ownerUid);
      const current = fresh?.home.homeDisk;
      if (!fresh || current?.id !== home.id || current.source !== home.source) throw new Error("retained home owner/anchor changed before image selection");
      const currentImage = current.bootImage as RetainedBootImage | undefined;
      if (currentImage?.id !== prior?.id || currentImage?.operationId !== prior?.operationId) throw new Error("retained boot selection changed concurrently");
      const retirement = previous && input.sourceComputer
        ? await schedulerRetirementForReplacement(tx, fresh, { home, source: input.sourceComputer, previous, pinned: currentImage }) : {};
      const selected = { ...candidate, ...retirement };
      await tx.users.records.patch(ownerUid, { home: { homeDisk: { ...current, bootImage: selected } } }, { revision: fresh.revision });
      return selected;
    });
  }
  return selected;
}
