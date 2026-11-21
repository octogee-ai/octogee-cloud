import { retainedBootPreservesScheduler } from "@octogee/core/admin-fleet-router";
import type { OpaqueMap, PlatformStateStore, PlatformUserRecord } from "@octogee/core/platform-state";
import type { GatewayVmSpec, RetainedUserHome } from "@octogee/shared/types/glm";
import type { ComputeImageRef, GatewayVmClient } from "./compute-vm.js";
import { readNativeSchedulerRetirement } from "./native-scheduler-retirement.js";

export interface RetainedBootImage extends ComputeImageRef {
  project: string;
  homeId: string;
  previous: { name: string; id: string } | null;
  operationId: string | null;
  sourceComputer: { name: string; zone: string; instanceId: string; gatewayId: string } | null;
  nativeSchedulerRetirement?: OpaqueMap;
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

function previousBootPreservesScheduler(pinned: RetainedBootImage | undefined, previous: ComputeImageRef,
  pending: OpaqueMap, gatewayId: string): boolean {
  return pinned !== undefined && !!pinned.operationId && pinned.id === previous.id && pinned.name === previous.name &&
    retainedBootPreservesScheduler({ ...pinned }, pending, [gatewayId]);
}

function schedulerRetirementForReplacement(owner: PlatformUserRecord, home: RetainedUserHome,
  source: NonNullable<RetainedBootImage["sourceComputer"]>, previous: ComputeImageRef, pinned: RetainedBootImage | undefined): OpaqueMap | undefined {
  const pending = readNativeSchedulerRetirement(owner.fences.pendingNativeSchedulerRetirement);
  if (!pending) return undefined;
  if (pending.uid !== owner.uid || pending.slug !== owner.slug || pending.homeDiskId !== home.id ||
      pending.homeDiskSource !== home.source || pending.zone !== source.zone || pending.instanceName !== source.name) {
    throw new Error("Retained boot replacement scheduler home or owner identity changed");
  }
  if (pending.instanceId === source.instanceId) {
    if (pending.sourceGatewayId !== source.gatewayId && owner.activationLease?.targetGatewayId !== source.gatewayId) {
      throw new Error("Retained boot replacement scheduler source gateway changed");
    }
    return undefined;
  }
  if (pending.completedAt === undefined || !previousBootPreservesScheduler(pinned, previous, pending, source.gatewayId)) {
    throw new Error("Retained boot replacement cannot prove scheduler lineage from the previous image");
  }
  return pending;
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
      const nativeSchedulerRetirement = previous && input.sourceComputer
        ? schedulerRetirementForReplacement(fresh, home, input.sourceComputer, previous, currentImage) : undefined;
      const selected = nativeSchedulerRetirement ? { ...candidate, nativeSchedulerRetirement } : candidate;
      await tx.users.records.patch(ownerUid, { home: { homeDisk: { ...current, bootImage: selected } } }, { revision: fresh.revision });
      return selected;
    });
  }
  return selected;
}
