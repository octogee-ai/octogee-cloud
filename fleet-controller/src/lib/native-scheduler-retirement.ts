import { isDeepStrictEqual } from "node:util";
import { builderReturnOperationId } from "@octogee/shared/types/isolated-operation-ids";
import type { PlatformUserRecord, FleetRegistryRecord, GatewayRoot, OperationRecord, PlatformStateRepositories, PlatformStateStore, UntypedRecord, UserHomeArchive } from "@octogee/core/platform-state";
import { archiveSchedulerCustodyMatches, retainedBootPreservesScheduler } from "@octogee/core/admin-fleet-router";
import { migrationCancellationDeferred } from "@octogee/core/fleet-state";
import type { MigrationClient } from "@octogee/core/fleet-migration-client";
import type { BootReplacementWindow, GatewayVmClient } from "./compute-vm.js";

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
  vm: Pick<GatewayVmClient, "describe" | "retainHome" | "readBootImage" | "readImage" | "verifyBootReplacement">;
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

type ArchiveAuthority = Extract<UserHomeArchive, { phase: "restored" }>;

function restoredDemandMatches(lease: PlatformUserRecord["activationLease"], archive: ArchiveAuthority, gatewayId: string): boolean {
  return archive.targetGatewayId === gatewayId && lease?.targetGatewayId === gatewayId &&
    lease.leaseId === archive.leaseId && lease.generation === archive.generation;
}

function restoredSchedulerHome(user: PlatformUserRecord, input: NativeSchedulerRetirementInput, pending: Retirement): ArchiveAuthority | null {
  const { home, activationLease: lease } = user;
  const archive = home.homeArchive;
  if (archive?.phase !== "restored" || !archive.nativeSchedulerRetirement || !archiveSchedulerCustodyMatches(user, archive) ||
      archive.gatewayId !== pending.sourceGatewayId || archive.snapshot.sourceDiskId !== pending.homeDiskId ||
      archive.snapshot.sourceDisk !== pending.homeDiskSource || !restoredDemandMatches(lease, archive, input.gatewayId) ||
      home.homeDisk?.id !== archive.restoredDisk.id || home.homeDisk.source !== archive.restoredDisk.source) return null;
  return archive;
}

function ownerMatches(user: PlatformUserRecord, input: NativeSchedulerRetirementInput, pending: Retirement, archive: ArchiveAuthority | null): boolean {
  const home = user.home.homeDisk;
  return sameRetirement(readNativeSchedulerRetirement(user.fences.pendingNativeSchedulerRetirement), pending) &&
    pending.uid === input.uid && pending.slug === input.slug && user.gateway?.gatewayId === input.gatewayId &&
    (archive !== null || home?.id === pending.homeDiskId && home.source === pending.homeDiskSource);
}

type VmAuthority = { instanceId: string; instanceName: string; zone: string;
  image?: { name: string; id: string; project: string; operationId: string; replacement?: BootReplacementWindow };
  restoredHome?: { id: string; source: string };
};

const NUMERIC_INSTANCE_ID = /^[1-9]\d{0,19}$/u;
const RELEASE_SHA = /^[0-9a-f]{40}$/u;

function historicalReturnGeneration(op: OperationRecord | null, pending: Retirement): number | null {
  if (!op || op.id !== pending.returnOperationId || op.inputUid !== pending.uid || !isCompletedNativeReturn(op, pending)) return null;
  const generation = Number(op.id.split("-g").at(-1));
  const park = op.output?.nativeSourcePark as UntypedRecord | undefined;
  if (!Number.isSafeInteger(generation) || generation < 1 || op.id !== builderReturnOperationId(pending.sourceGatewayId, generation) ||
      !["stopped", "suspended"].includes(park?.parked) || typeof op.completedAt !== "number" ||
      !Number.isFinite(op.completedAt) || op.completedAt < pending.completedAt!) return null;
  return generation;
}

type ParkedEdge = { previous: string; current: string; imageId: string; startedAt: number; completedAt: number };
function provenParkStep(operation: OperationRecord, edge: ParkedEdge): boolean {
  const steps = operation.steps?.filter(step => step.name === "verify-prewarmed-computer") ?? [];
  const step = steps.length === 1 ? steps[0] : undefined;
  return step?.status === "done" && step.detail === `instance=${edge.current} bootImage=${edge.imageId}` &&
    typeof step.completedAt === "number" && step.completedAt >= edge.startedAt && step.completedAt <= edge.completedAt;
}

function samePrewarmRequest(operation: OperationRecord, pending: Retirement, generation: number): boolean {
  const { input } = operation;
  return operation.kind === "prewarm-gateway" && operation.status === "succeeded" &&
    operation.inputUid === pending.uid && input.uid === pending.uid && input.gatewayId === pending.sourceGatewayId &&
    operation.gatewayId === pending.sourceGatewayId && input.generation === generation &&
    typeof input.sourceSha === "string" && RELEASE_SHA.test(input.sourceSha);
}

function numericIdentifier(value: unknown): value is string {
  return typeof value === "string" && NUMERIC_INSTANCE_ID.test(value);
}

function orderedParkedTimes(operation: OperationRecord, startedAt: number, completedAt: number): boolean {
  const activeAttemptAt = operation.startedAt ?? startedAt;
  return operation.createdAt <= startedAt && startedAt <= activeAttemptAt && activeAttemptAt <= completedAt && completedAt <= Date.now();
}

function parseParkedEdge(operation: OperationRecord): ParkedEdge | null {
  const { previousInstanceId: previous, instanceId: current, bootImageId: imageId } = operation.output ?? {};
  const startedAt = operation.firstStartedAt ?? operation.startedAt;
  const { completedAt } = operation;
  if (!numericIdentifier(previous) || !numericIdentifier(current) || !numericIdentifier(imageId) ||
      previous === current || imageId !== operation.input.bootImageId ||
      typeof startedAt !== "number" || typeof completedAt !== "number") return null;
  if (!orderedParkedTimes(operation, startedAt, completedAt)) return null;
  const edge = { previous, current, imageId, startedAt, completedAt };
  return provenParkStep(operation, edge) ? edge : null;
}

function uniqueParkedPath(edges: readonly ParkedEdge[], original: string, current: string, notBefore: number): ParkedEdge[] {
  const byPrevious = new Map<string, ParkedEdge | null>();
  for (const edge of edges) byPrevious.set(edge.previous, byPrevious.has(edge.previous) ? null : edge);
  const path: ParkedEdge[] = [];
  const seen = new Set([original]);
  let source = original;
  let earliest = notBefore;
  while (source !== current) {
    const edge = byPrevious.get(source);
    if (!edge || edge.startedAt < earliest || seen.has(edge.current)) return [];
    path.push(edge);
    seen.add(edge.current);
    source = edge.current;
    earliest = edge.completedAt;
  }
  return path;
}

export function preservesLegacySchedulerRetirement(image: UntypedRecord, pending: Retirement, gateways: readonly string[]): boolean {
  return isDeepStrictEqual(image.legacySchedulerRetirement, pending) &&
    retainedBootPreservesScheduler({ ...image, nativeSchedulerRetirement: image.legacySchedulerRetirement }, pending, gateways);
}

function historicalEndpointMatches(path: readonly ParkedEdge[], image: UntypedRecord, sourceGatewayId: string): boolean {
  const prior = path.at(-2);
  const last = path.at(-1);
  return !!prior && !!last && prior.imageId === image.previous?.id && last.imageId === image.id &&
    last.previous === image.sourceComputer?.instanceId &&
    image.operationId === `boot-${sourceGatewayId}-${last.previous}-${last.imageId}`;
}

type HistoricalBootTarget = { image: UntypedRecord; instanceId: string };

async function historicalBootReplacement(
  state: PlatformStateRepositories, owner: PlatformUserRecord, pending: Retirement, target: HistoricalBootTarget,
  allowInterrupted: boolean,
): Promise<true | BootReplacementWindow | null> {
  const { image, instanceId } = target;
  if (owner.uid !== pending.uid || owner.home.homeDisk?.id !== pending.homeDiskId || owner.home.homeDisk.source !== pending.homeDiskSource ||
      image.nativeSchedulerRetirement !== undefined || image.legacySchedulerRetirement !== undefined ||
      !retainedBootPreservesScheduler({ ...image, nativeSchedulerRetirement: pending }, pending, [pending.sourceGatewayId])) return null;
  const returned = await state.journal.operations.get(pending.returnOperationId);
  const generation = historicalReturnGeneration(returned, pending);
  if (generation === null || !returned?.completedAt) return null;
  const prewarms = (await state.journal.operations.listForUid(pending.uid, { kind: "prewarm-gateway", statuses: ["succeeded"] }))
    .filter(op => samePrewarmRequest(op, pending, generation));
  const edges = prewarms.flatMap(op => {
    const edge = op.output?.prewarmState === "parked" ? parseParkedEdge(op) : null;
    return edge ? [edge] : [];
  });
  const path = uniqueParkedPath(edges, pending.instanceId, instanceId, returned.completedAt);
  if (historicalEndpointMatches(path, image, pending.sourceGatewayId)) return true;
  if (!allowInterrupted) return null;
  return interruptedBootReplacement(prewarms, edges, pending, target, returned.completedAt);
}

function interruptedBootReplacement(
  prewarms: readonly OperationRecord[], edges: readonly ParkedEdge[], pending: Retirement, target: HistoricalBootTarget,
  returnedAt: number,
): BootReplacementWindow | null {
  const { image, instanceId } = target;
  const previousInstanceId = image.sourceComputer?.instanceId;
  if (!numericIdentifier(previousInstanceId) || !numericIdentifier(instanceId) || previousInstanceId === instanceId ||
      !numericIdentifier(image.id) || image.operationId !== `boot-${pending.sourceGatewayId}-${previousInstanceId}-${image.id}`) return null;
  const predecessor = uniqueParkedPath(edges, pending.instanceId, previousInstanceId, returnedAt).at(-1);
  if (!predecessor || predecessor.imageId !== image.previous?.id || edges.some(edge => edge.previous === previousInstanceId)) return null;
  const candidates = prewarms.filter(op => op.output?.prewarmState === "ineligible" && op.input.bootImageId === image.id &&
    typeof op.firstStartedAt === "number" && op.firstStartedAt >= predecessor.completedAt);
  if (candidates.length !== 1) return null;
  const window = interruptedAttemptWindow(candidates[0]);
  return window ? { instanceName: pending.instanceName, zone: pending.zone, previousInstanceId, instanceId, ...window } : null;
}

function interruptedAttemptWindow(operation: OperationRecord): Pick<BootReplacementWindow, "startedAt" | "endedAt"> | null {
  const { firstStartedAt, startedAt, completedAt } = operation;
  if (typeof firstStartedAt !== "number" || typeof startedAt !== "number" ||
      typeof completedAt !== "number" || firstStartedAt >= startedAt ||
      !orderedParkedTimes(operation, firstStartedAt, completedAt)) return null;
  return { startedAt: firstStartedAt, endedAt: startedAt };
}

export async function hasHistoricalSchedulerBootLineage(
  state: PlatformStateRepositories, owner: PlatformUserRecord, pending: Retirement, image: UntypedRecord, instanceId: string,
): Promise<boolean> {
  return await historicalBootReplacement(state, owner, pending, { image, instanceId }, false) === true;
}

async function admittedReplacementImage(state: PlatformStateRepositories, user: PlatformUserRecord, pending: Retirement,
  targetGatewayId: string, instanceId: string): Promise<VmAuthority["image"] | null> {
  const image = user.home.homeDisk?.bootImage as UntypedRecord | undefined;
  if (!image) return null;
  if (["name", "id", "project", "operationId"].some(key => typeof image[key] !== "string" || !image[key])) return null;
  const gateways = [pending.sourceGatewayId, targetGatewayId];
  const authority = { name: image.name, id: image.id, project: image.project, operationId: image.operationId };
  if (retainedBootPreservesScheduler(image, pending, gateways) || preservesLegacySchedulerRetirement(image, pending, gateways)) return authority;
  const historical = await historicalBootReplacement(state, user, pending, { image, instanceId }, true);
  if (historical === null) return null;
  return historical === true ? authority : { ...authority, replacement: historical };
}

async function vmAuthority(state: PlatformStateRepositories, observed: {
  runtime: FleetRegistryRecord | null; user: PlatformUserRecord | null; pending: Retirement; targetGatewayId: string; archive: ArchiveAuthority | null;
}): Promise<VmAuthority | null> {
  const { runtime, user, pending, targetGatewayId, archive } = observed;
  const vm = runtime?.vm;
  if (archive) {
    if (!vm || vm.instanceId !== archive.restoredInstanceId || vm.zone !== archive.restoredDisk.zone) return null;
    return { instanceId: vm.instanceId, instanceName: vm.instanceName, zone: vm.zone,
      restoredHome: { id: archive.restoredDisk.id, source: archive.restoredDisk.source } };
  }
  if (vm?.instanceName !== pending.instanceName || vm.zone !== pending.zone || typeof vm.instanceId !== "string") return null;
  if (vm.instanceId === pending.instanceId) return { instanceId: vm.instanceId, instanceName: vm.instanceName, zone: vm.zone };
  const image = user ? await admittedReplacementImage(state, user, pending, targetGatewayId, vm.instanceId) : null;
  return image ? { instanceId: vm.instanceId, instanceName: vm.instanceName, zone: vm.zone, image } : null;
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
    const archive = user ? restoredSchedulerHome(user, input, pending) : null;
    const authority = await vmAuthority(tx, { runtime, user, pending, targetGatewayId: input.gatewayId, archive });
    const exact = user !== null && ownerMatches(user, input, pending, archive) &&
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

async function verifyAdmittedReplacement(deps: Deps, input: NativeSchedulerRetirementInput, pending: Retirement,
  image: NonNullable<VmAuthority["image"]>): Promise<void> {
  if (image.replacement && !await deps.vm.verifyBootReplacement(image.replacement)) {
    throw new Error("native scheduler retirement authority changed: missing verified Compute boot replacement");
  }
  const home = await deps.vm.retainHome(pending.instanceName, pending.zone, input.uid);
  const boot = await deps.vm.readBootImage(pending.instanceName, pending.zone);
  const observed = await deps.vm.readImage(image.name, image.project);
  if (boot.id !== image.id || boot.name !== image.name || home.id !== pending.homeDiskId || home.source !== pending.homeDiskSource ||
      observed.id !== image.id || observed.name !== image.name || !observed.homeAdmission) {
    throw new Error("native scheduler retirement retained home/image identity changed");
  }
}

async function verifyVm(deps: Deps, input: NativeSchedulerRetirementInput, pending: Retirement, authority: VmAuthority): Promise<void> {
  const vm = await deps.vm.describe(authority.instanceName, authority.zone);
  if (vm?.instanceId !== authority.instanceId || vm.gatewayId !== input.gatewayId || vm.status !== "RUNNING" ||
      (authority.image?.replacement && vm.metadata["octogee-owner-uid"] !== input.uid)) {
    throw new Error("native scheduler retirement VM identity changed");
  }
  if (authority.restoredHome) {
    const home = await deps.vm.retainHome(authority.instanceName, authority.zone, input.uid);
    if (home.id !== authority.restoredHome.id || home.source !== authority.restoredHome.source) {
      throw new Error("Native scheduler retirement restored disk identity changed");
    }
  }
  if (authority.image) await verifyAdmittedReplacement(deps, input, pending, authority.image);
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
  if (authority.image || authority.restoredHome) await verifyVm(deps, input, pending, authority);
  await authorize(deps, input, pending, true, authority);
  deps.log(`[migrate-customer] ${input.slug}: retired exported native schedules ${pending.migrationId} on retained VM ${authority.instanceId}`);
}
