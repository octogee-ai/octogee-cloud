import { isDeepStrictEqual } from "node:util";
import type { GatewayRuntimeRestartFenceValue, PlatformStateStore, PlatformStateTransaction } from "@octogee/core/platform-state";
import { assertSharedSourceRecoveryUnchanged, readSharedSourceRecoveryAuthority } from "@octogee/core/shared-source-recovery";
import { agentIdBelongsToSlug } from "@octogee/shared/types/agent-models";
import type { FleetBrokerOpenClawBootClaim } from "@octogee/shared/types/fleet-broker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fence, operation and recovery fields are checked one by one before use
type StoredFields = { [field: string]: any };

interface OpenClawBootInput {
  gatewayId: string;
  podUid: string;
  podName: string;
  releaseKey: string;
  openclawBuild?: string;
}

export interface OpenClawBootSentinelStore {
  claim(input: OpenClawBootInput): Promise<FleetBrokerOpenClawBootClaim | null>;
  assertDoctor(input: OpenClawBootInput & { requestId: string }): Promise<boolean>;
  complete(input: OpenClawBootInput): Promise<boolean>;
  completeDoctor(input: OpenClawBootInput & { requestId: string; verifiedAgentIds: string[] }): Promise<boolean>;
}

export const OPENCLAW_BUILD_PATTERN = /^[0-9a-f]{40}$/;

function record(value: unknown): StoredFields {
  return value && typeof value === "object" && !Array.isArray(value) ? value as StoredFields : {};
}

function assertSourceRoot(root: StoredFields, captured: unknown): void {
  if (root.gatewayClass !== "shared" || !["running", "draining"].includes(root.desiredStatus) ||
      root.retirementClaim != null || !Number.isSafeInteger(root.liveRelease) || root.liveRelease < 1 || root.desiredRelease !== root.liveRelease) {
    throw new Error("source Doctor lifecycle custody mismatch");
  }
  const identity = Object.fromEntries(["gatewayId", "gatewayClass", "ownerUid", "builderSlug", "desiredStatus", "desiredRelease", "liveRelease", "latestRelease"].map((key) => [key, root[key]]));
  if (!isDeepStrictEqual(captured, identity)) throw new Error("source Doctor release custody changed");
}

function assertSourceFence(fence: StoredFields, input: OpenClawBootInput): void {
  const target = record(fence.target), doctor = record(fence.doctor);
  if (fence.gatewayId !== input.gatewayId || fence.phase !== "dispatched" || fence.attemptId !== doctor.requestId || fence.auditId !== doctor.requestId ||
      typeof doctor.requestId !== "string" || !doctor.requestId || doctor.requestId.includes("/") || doctor.error !== undefined ||
      target.podUid !== input.podUid || target.podName !== input.podName || !Number.isSafeInteger(fence.startedAt) || fence.startedAt <= 0) {
    throw new Error("source Doctor fence custody mismatch");
  }
}

function assertSourceOperation(op: StoredFields, recovery: StoredFields, target: StoredFields, gatewayId: string): void {
  if (op.kind !== "restart-gateway" || !["pending", "running"].includes(op.status) || op.completedAt !== null ||
      op.cancellationRequestedAt !== undefined || op.input?.gatewayId !== gatewayId ||
      typeof recovery.sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(recovery.sourceSha) || target.sourceSha !== recovery.sourceSha ||
      !isDeepStrictEqual(target.images, recovery.images)) throw new Error("source Doctor operation mismatch");
}

function sourceAgentIds(assignments: unknown, captured: unknown): string[] {
  if (!Array.isArray(assignments) || assignments.length === 0) throw new Error("source Doctor requires owned agents");
  const agents = assignments.map((value) => {
    const agent = { ...record(value) }; delete agent.assignment;
    if (typeof agent.uid !== "string" || !agent.uid || agent.uid.includes("/") || typeof agent.slug !== "string" ||
        !/^[a-z0-9][a-z0-9_-]*$/.test(agent.slug) || agent.agentId !== `octogee-${agent.slug}-coach` ||
        !Number.isSafeInteger(agent.assignmentEpoch) || agent.assignmentEpoch < 0) throw new Error("source Doctor agent ownership mismatch");
    return agent;
  });
  const agentIds = agents.map((agent) => agent.agentId as string);
  if (!isDeepStrictEqual(captured, agents) || new Set(agentIds).size !== agentIds.length) throw new Error("source Doctor roster mismatch");
  return agentIds;
}

function sourceImageVerified(fence: StoredFields, podUid: string): boolean {
  if (fence.installedImage === undefined) return false;
  const image = record(fence.installedImage), target = record(fence.target);
  const wanted = typeof target.images?.gateway === "string" ? /@(sha256:[a-f0-9]{64})$/.exec(target.images.gateway)?.[1] : undefined;
  if (!wanted || image.podUid !== podUid || typeof image.gatewayImageId !== "string" || !image.gatewayImageId.endsWith(wanted) ||
      !Number.isSafeInteger(image.verifiedAt) || image.verifiedAt < fence.startedAt) throw new Error("source Doctor installed image mismatch");
  return true;
}

async function sourceDoctorContext(transaction: PlatformStateTransaction, input: OpenClawBootInput) {
  const root = await transaction.gateways.roots.get(input.gatewayId), fence = root?.runtimeRestartFence;
  if (root === null || fence?.kind !== "source-recovery") return null;
  assertSourceFence(fence, input);
  const target = record(fence.target), doctor = record(fence.doctor);
  const op = record(await transaction.journal.operations.get(doctor.requestId)), recovery = record(op.input?.sourceRecovery);
  assertSourceRoot(record(root), recovery.root);
  assertSourceOperation(op, recovery, target, input.gatewayId);
  const defaultAgents = sourceAgentIds(recovery.assignments, target.agents);
  const stores = sourcePostgresStores(recovery, target, defaultAgents);
  if (recovery.schedulerStateRecovery !== true || target.schedulerStateRecovery !== true) throw new Error("source Doctor scheduler custody mismatch");
  const current = await readSharedSourceRecoveryAuthority(transaction, input.gatewayId, doctor.requestId);
  assertSharedSourceRecoveryUnchanged(current, recovery as Parameters<typeof assertSharedSourceRecoveryUnchanged>[1]);
  return { fence, doctor, agentIds: stores.map(s => s.agentId), postgresAgentStores: stores,
    schedulerStateRecovery: true as const, imageVerified: sourceImageVerified(fence, input.podUid) };
}

function sourcePostgresStores(recovery: StoredFields, target: StoredFields, defaultAgents: string[]) {
  const stores = recovery.postgresAgentStores;
  if (!Array.isArray(stores) || !stores.length || !isDeepStrictEqual(stores, target.postgresAgentStores) ||
      defaultAgents.some(id => !stores.some(s => s.agentId === id)) ||
      new Set(stores.map(s => s.agentId)).size !== stores.length || new Set(stores.map(s => s.storeId)).size !== stores.length ||
      new Set(stores.map(s => s.schema)).size !== stores.length || stores.some(s => {
        const owner = recovery.assignments.find((a: StoredFields) => a.uid === s.uid);
        return !owner || owner.slug !== s.slug || owner.assignmentEpoch !== s.assignmentEpoch || !agentIdBelongsToSlug(s.agentId, s.slug) ||
          typeof s.storeId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s.storeId) ||
          typeof s.schema !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/.test(s.schema);
      })) throw new Error("source Doctor PostgreSQL roster mismatch");
  return stores.map(s => ({ agentId: s.agentId as string, storeId: s.storeId as string, schema: s.schema as string }));
}

function sourceDoctorCompleted(context: NonNullable<Awaited<ReturnType<typeof sourceDoctorContext>>>, input: OpenClawBootInput): boolean {
  const { doctor, agentIds } = context;
  return context.imageVerified && Number.isSafeInteger(doctor.startedAt) && doctor.startedAt > 0 && Number.isSafeInteger(doctor.completedAt) &&
    doctor.completedAt >= doctor.startedAt && doctor.releaseKey === input.releaseKey && isDeepStrictEqual(doctor.verifiedAgentIds, agentIds);
}
function sourceDoctorRequest(context: NonNullable<Awaited<ReturnType<typeof sourceDoctorContext>>>) {
  return { requestId: context.doctor.requestId as string, agentIds: context.agentIds,
    schedulerStateRecovery: context.schedulerStateRecovery, postgresAgentStores: context.postgresAgentStores };
}

function withDoctor(fence: GatewayRuntimeRestartFenceValue, doctor: StoredFields): GatewayRuntimeRestartFenceValue {
  return { ...fence, doctor: { ...record(fence.doctor), ...doctor } };
}

export function createOpenClawBootSentinelStore(
  store: PlatformStateStore,
  now: () => number,
): OpenClawBootSentinelStore {
  return {
    async claim(input) {
      return store.transaction({ label: "openclaw-boot.claim" }, async (transaction) => {
        if (await transaction.fleetRegistry.get(input.gatewayId) === null) return null;
        const context = await sourceDoctorContext(transaction, input);
        if (context) {
          if (sourceDoctorCompleted(context, input)) return { action: "start" as const };
          if (context.doctor.startedAt !== undefined || context.doctor.completedAt !== undefined) throw new Error("source Doctor attempted without matching success acknowledgement");
          const sourceDoctor = sourceDoctorRequest(context);
          if (!context.imageVerified) return { action: "wait" as const, sourceDoctor };
          await transaction.gateways.roots.compareAndSetRuntimeRestartFence(input.gatewayId, context.fence,
            withDoctor(context.fence, { startedAt: now(), releaseKey: input.releaseKey }));
          return { action: "doctor" as const, sourceDoctor };
        }
        return { action: "start" as const };
      });
    },
    async assertDoctor(input) {
      return store.transaction({ label: "openclaw-boot.assertDoctor", readOnly: true }, async (transaction) => {
        const context = await sourceDoctorContext(transaction, input);
        if (!context?.imageVerified || context.doctor.requestId !== input.requestId || context.doctor.releaseKey !== input.releaseKey ||
            !Number.isSafeInteger(context.doctor.startedAt) || context.doctor.startedAt <= 0) throw new Error("source Doctor authority changed");
        return true;
      });
    },
    async completeDoctor(input) {
      return store.transaction({ label: "openclaw-boot.completeDoctor" }, async (transaction) => {
        const context = await sourceDoctorContext(transaction, input);
        if (!context || !context.imageVerified || context.doctor.requestId !== input.requestId ||
            context.doctor.releaseKey !== input.releaseKey || !Number.isSafeInteger(context.doctor.startedAt) || context.doctor.startedAt <= 0 ||
            !isDeepStrictEqual(context.agentIds, input.verifiedAgentIds)) throw new Error("source Doctor acknowledgement mismatch");
        if (context.doctor.completedAt !== undefined) {
          if (!sourceDoctorCompleted(context, input)) throw new Error("source Doctor stored acknowledgement mismatch");
          return true;
        }
        const completedAt = now();
        if (completedAt < context.doctor.startedAt) throw new Error("source Doctor completion predates its claim");
        await transaction.gateways.roots.compareAndSetRuntimeRestartFence(input.gatewayId, context.fence,
          withDoctor(context.fence, { completedAt, verifiedAgentIds: input.verifiedAgentIds }));
        return true;
      });
    },
    async complete(input) {
      return store.transaction({ label: "openclaw-boot.complete" }, async (transaction) => {
        if (await transaction.fleetRegistry.get(input.gatewayId) === null) return false;
        const context = await sourceDoctorContext(transaction, input);
        if (context && !sourceDoctorCompleted(context, input)) throw new Error("source Doctor success acknowledgement is required before health");
        if (input.openclawBuild) await transaction.fleetRegistry.patch(input.gatewayId, { openclawHealthyBuild: input.openclawBuild });
        return true;
      });
    },
  };
}
