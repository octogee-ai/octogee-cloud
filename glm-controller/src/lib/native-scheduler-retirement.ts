import type { PlatformUserRecord, FleetRegistryRecord, GatewayRoot, OperationRecord, PlatformStateStore, UntypedRecord } from "@octogee/core/platform-state";
import { migrationCancellationDeferred } from "@octogee/core/fleet-state";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { GatewayVmClient } from "./compute-vm.js";

export interface NativeSchedulerRetirementInput {
  uid: string;
  slug: string;
  gatewayId: string;
  operationId: string;
  claimedStartedAt: number | null;
}

type ReturnInput = { uid: string; slug: string; fromGatewayId: string; toGatewayId: string; operationId: string };
type Retirement = Record<"uid" | "slug" | "returnOperationId" | "migrationId" | "sourceGatewayId" | "sharedGatewayId" |
  "instanceName" | "instanceId" | "zone" | "homeDiskId" | "homeDiskSource", string> & { completedAt?: number; cutoverCommittedAt?: number };
const KEYS: Array<keyof Omit<Retirement, "completedAt" | "cutoverCommittedAt">> = ["uid", "slug", "returnOperationId", "migrationId", "sourceGatewayId", "sharedGatewayId",
  "instanceName", "instanceId", "zone", "homeDiskId", "homeDiskSource"];

export function readNativeSchedulerRetirement(data: UntypedRecord | undefined): Retirement | null {
  if (data === undefined) return null;
  if (!data || KEYS.some(key => typeof data[key] !== "string" || !data[key])) throw new Error("native scheduler retirement authority is malformed");
  if ((data.completedAt !== undefined || data.cutoverCommittedAt !== undefined) &&
      !(typeof data.completedAt === "number" && Number.isFinite(data.completedAt) &&
        typeof data.cutoverCommittedAt === "number" && data.cutoverCommittedAt > 0 && data.completedAt >= data.cutoverCommittedAt)) {
    throw new Error("native scheduler retirement completion authority is malformed");
  }
  return data as Retirement;
}

function sameRetirement(a: Retirement | null, b: Retirement): boolean {
  return a !== null && KEYS.every(key => a[key] === b[key]) && a.completedAt === b.completedAt && a.cutoverCommittedAt === b.cutoverCommittedAt;
}

function handoffMatches(handoff: UntypedRecord, input: ReturnInput): boolean {
  return handoff.uid === input.uid && handoff.slug === input.slug &&
    handoff.fromGatewayId === input.fromGatewayId && handoff.toGatewayId === input.toGatewayId;
}

function retainedIdentity(user: PlatformUserRecord | null, runtime: FleetRegistryRecord | null) {
  const home = user?.home.homeDisk, vm = runtime?.vm;
  return { instanceName: vm?.instanceName, instanceId: vm?.instanceId, zone: vm?.zone, homeDiskId: home?.id, homeDiskSource: home?.source };
}

export function nativeSchedulerRetirementForReturn(
  input: ReturnInput, user: PlatformUserRecord | null, runtime: FleetRegistryRecord | null, operation: OperationRecord | null,
): Retirement | null {
  const handoff = operation?.schedulerHandoff;
  if (!handoff) return null;
  if (!handoffMatches(handoff, input)) throw new Error("native scheduler retirement handoff authority changed");
  const record = readNativeSchedulerRetirement({ uid: input.uid, slug: input.slug, returnOperationId: input.operationId, migrationId: handoff.migrationId,
    sourceGatewayId: input.fromGatewayId, sharedGatewayId: input.toGatewayId,
    ...retainedIdentity(user, runtime) })!;
  const existing = readNativeSchedulerRetirement(user?.fences.pendingNativeSchedulerRetirement);
  if (existing && !KEYS.every(key => existing[key] === record[key])) throw new Error("another native scheduler retirement remains pending");
  return existing ?? record;
}

type Deps = {
  store: PlatformStateStore;
  vm: Pick<GatewayVmClient, "describe" | "retainHome" | "readBootImage" | "readImage">;
  log: (message: string) => void;
};

function activeAttempt(op: OperationRecord | undefined, input: NativeSchedulerRetirementInput): boolean {
  return op?.kind === "migrate-user" && op.status === "running" && typeof input.claimedStartedAt === "number" &&
    op.startedAt === input.claimedStartedAt &&
    (op.cancellationRequestedAt === undefined || migrationCancellationDeferred({ ...op }, input.operationId)) &&
    op.input?.uid === input.uid && op.input.toGatewayId === input.gatewayId && typeof op.cutoverCommittedAt === "number";
}

export function isCompletedNativeReturn(op: OperationRecord | undefined, pending: Retirement): boolean {
  if (pending.completedAt === undefined || pending.cutoverCommittedAt === undefined) return false;
  if (op === undefined) return true;
  const h = op.schedulerHandoff;
  return op.kind === "migrate-user" && op.status === "succeeded" && op.cutoverCommittedAt === pending.cutoverCommittedAt &&
    op.input?.uid === pending.uid && op.input.fromGatewayId === pending.sourceGatewayId && op.input.toGatewayId === pending.sharedGatewayId &&
    h?.migrationId === pending.migrationId && handoffMatches(h, {
      uid: pending.uid, slug: pending.slug, fromGatewayId: pending.sourceGatewayId,
      toGatewayId: pending.sharedGatewayId, operationId: pending.returnOperationId,
    });
}

function ownerMatches(user: PlatformUserRecord, input: NativeSchedulerRetirementInput, pending: Retirement): boolean {
  const home = user.home.homeDisk;
  return sameRetirement(readNativeSchedulerRetirement(user.fences.pendingNativeSchedulerRetirement), pending) &&
    pending.uid === input.uid && pending.slug === input.slug && user.gateway?.gatewayId === input.gatewayId &&
    home?.id === pending.homeDiskId && home.source === pending.homeDiskSource;
}

type VmAuthority = { instanceId: string; image?: { name: string; id: string; project: string; operationId: string } };

function admittedReplacementImage(image: UntypedRecord | undefined, pending: Retirement, targetGatewayId: string): VmAuthority["image"] | null {
  if (image?.homeAdmission !== true || image.homeId !== pending.homeDiskId) return null;
  if (["name", "id", "project", "operationId"].some(key => typeof image[key] !== "string" || !image[key])) return null;
  const source = image.sourceComputer;
  if (source?.instanceId !== pending.instanceId || source.name !== pending.instanceName || source.zone !== pending.zone ||
      ![pending.sourceGatewayId, targetGatewayId].includes(source.gatewayId)) return null;
  return { name: image.name, id: image.id, project: image.project, operationId: image.operationId };
}

function vmAuthority(runtime: FleetRegistryRecord | null, user: PlatformUserRecord | null, pending: Retirement, targetGatewayId: string): VmAuthority | null {
  const vm = runtime?.vm;
  if (vm?.instanceName !== pending.instanceName || vm.zone !== pending.zone || typeof vm.instanceId !== "string") return null;
  if (vm.instanceId === pending.instanceId) return { instanceId: vm.instanceId };
  const image = admittedReplacementImage(user?.home.homeDisk?.bootImage as UntypedRecord | undefined, pending, targetGatewayId);
  return image ? { instanceId: vm.instanceId, image } : null;
}

function targetMatches(root: GatewayRoot | null, runtime: FleetRegistryRecord | null, input: NativeSchedulerRetirementInput, authority: VmAuthority | null): boolean {
  return root?.gatewayClass === "isolated" && root.ownerUid === input.uid && root.builderSlug === input.slug && root.desiredStatus === "running" &&
    runtime?.runtime === "gce-vm" && authority !== null;
}

async function authorize(deps: Deps, input: NativeSchedulerRetirementInput, pending: Retirement, acknowledge = false, expected?: VmAuthority): Promise<VmAuthority> {
  return deps.store.transaction({ label: "native-scheduler-retirement.authorize" }, async tx => {
    const [user, root, runtime, operations] = await Promise.all([
      tx.users.records.get(input.uid), tx.gateways.roots.get(input.gatewayId), tx.fleetRegistry.get(input.gatewayId),
      tx.journal.operations.getMany([...new Set([input.operationId, pending.returnOperationId])]),
    ]);
    const authority = vmAuthority(runtime, user, pending, input.gatewayId);
    const exact = user !== null && ownerMatches(user, input, pending) &&
      targetMatches(root, runtime, input, authority) &&
      (!expected || JSON.stringify(authority) === JSON.stringify(expected)) &&
      activeAttempt(operations.get(input.operationId), input) && isCompletedNativeReturn(operations.get(pending.returnOperationId), pending);
    if (!exact || !authority) throw new Error("native scheduler retirement authority changed");
    if (acknowledge) {
      await tx.users.records.setFence(input.uid, "pendingNativeSchedulerRetirement", { clear: true }, user.fences.pendingNativeSchedulerRetirement);
    }
    return authority;
  });
}

async function verifyVm(deps: Deps, input: NativeSchedulerRetirementInput, pending: Retirement, authority: VmAuthority): Promise<void> {
  const vm = await deps.vm.describe(pending.instanceName, pending.zone);
  if (vm?.instanceId !== authority.instanceId || vm.gatewayId !== input.gatewayId || vm.status !== "RUNNING") {
    throw new Error("native scheduler retirement VM identity changed");
  }
  if (authority.image) {
    const home = await deps.vm.retainHome(pending.instanceName, pending.zone, input.uid);
    const boot = await deps.vm.readBootImage(pending.instanceName, pending.zone);
    const image = await deps.vm.readImage(authority.image.name, authority.image.project);
    if (boot.id !== authority.image.id || boot.name !== authority.image.name || home.id !== pending.homeDiskId || home.source !== pending.homeDiskSource || image.id !== authority.image.id ||
      image.name !== authority.image.name || !image.homeAdmission) throw new Error("native scheduler retirement retained home/image identity changed");
  }
}

export async function retireNativeSchedulerBeforeStage(
  deps: Deps, input: NativeSchedulerRetirementInput, scheduler: MigrationClient["scheduler"],
): Promise<void> {
  const user = await deps.store.users.records.get(input.uid);
  const pending = readNativeSchedulerRetirement(user?.fences.pendingNativeSchedulerRetirement);
  if (!pending) return;
  const target = await deps.store.fleetRegistry.get(input.gatewayId);
  if (target?.runtime !== "gce-vm") return;
  const authority = await authorize(deps, input, pending);
  await verifyVm(deps, input, pending, authority);
  await authorize(deps, input, pending, false, authority);
  const result = await scheduler({ migrationId: pending.migrationId, gatewayId: input.gatewayId, slug: input.slug, phase: "retire" });
  if (result.operationId !== pending.migrationId || result.phase !== "retire" || result.drained !== true) {
    throw new Error("native scheduler retirement acknowledgement changed");
  }
  if (authority.image) await verifyVm(deps, input, pending, authority);
  await authorize(deps, input, pending, true, authority);
  deps.log(`[migrate-customer] ${input.slug}: retired exported native schedules ${pending.migrationId} on retained VM ${authority.instanceId}`);
}
