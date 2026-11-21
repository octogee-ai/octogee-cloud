import { randomUUID } from "node:crypto";
import { isUserParkedVm } from "@octogee/shared/types/glm";
import type { OperationRecord } from "./platform-state/operations.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import type { PlatformUserRecord, UserHomeArchive } from "./platform-state/users.js";

interface ParkedHomeArchiveGrant {
  ownerUid: string;
  sizingProfile: string;
}

export function resolveParkedHomeArchiveGrant(environment: string | null | undefined, value: string | undefined): ParkedHomeArchiveGrant | undefined {
  if (environment !== "test" || !value) return undefined;
  const match = /^([A-Za-z0-9_-]{1,63}):([a-z][a-z0-9-]{0,62})$/u.exec(value);
  if (!match) throw new Error("Invalid TEST home archive grant; expected owner UID and sizing profile");
  return { ownerUid: match[1], sizingProfile: match[2] };
}

function hasVerifiedReturn(operation: OperationRecord | null, ownerUid: string, isolated: string, shared: string): boolean {
  const park = operation?.output?.nativeSourcePark as { parked?: unknown } | undefined;
  return operation?.status === "succeeded" && operation.kind === "migrate-user" &&
    operation.inputUid === ownerUid && operation.input.fromGatewayId === isolated &&
    operation.input.toGatewayId === shared && (park?.parked === "stopped" || park?.parked === "suspended");
}

function simpleHomePreparation(value: PlatformUserRecord["home"]["homeMigration"]): boolean {
  return value === undefined || (value.phase === "complete" &&
    value.id === undefined && value.source === undefined && value.target === undefined && value.copy === undefined);
}

function pilotHomeEligible(owner: PlatformUserRecord): boolean {
  const { home, fences } = owner;
  return home.projectStorageNativeBoot !== true && home.homeStorage === undefined && simpleHomePreparation(home.homeMigration) && home.homeErasure === undefined &&
    fences.sourceTransferFence === undefined && fences.restoreFence === undefined && fences.migration === undefined &&
    fences.pendingNativeSchedulerRetirement === undefined &&
    (owner.accountLifecycle === null || owner.accountLifecycle.status === "active");
}

export async function enqueueParkedHomeArchive(store: PlatformStateStore, input: {
  ownerUid: string; grant: ParkedHomeArchiveGrant | undefined; createdBy: string; dryRun?: boolean;
}): Promise<{ operationId: string }> {
  const { ownerUid, grant, createdBy } = input;
  if (!grant || grant.ownerUid !== ownerUid || !grant.sizingProfile) throw new Error("No exact parked home archive grant");
  return store.transaction({ label: "parked-home.archive", readOnly: input.dryRun === true }, async tx => {
    const owner = await tx.users.records.get(ownerUid);
    if (!owner || !pilotHomeEligible(owner)) throw new Error("User home is outside the archive pilot");
    const existing = owner.home.homeArchive;
    if (existing) {
      const operation = await tx.journal.operations.get(existing.operationId);
      if (operation?.origin !== "operator" || operation.inputUid !== ownerUid || operation.input.action !== "archive" ||
          operation.input.expectedGatewayId !== existing.gatewayId || operation.input.expectedInstanceId !== existing.instanceId) {
        throw new Error("Home archive journal identity changed");
      }
      if (operation.status === "failed" && (existing.phase === "preparing" || existing.phase === "snapshot-ready")) {
        const fence = owner.fences.computerRecovery;
        if (fence?.operationId !== operation.id || fence.gatewayId !== existing.gatewayId ||
            fence.instanceId !== existing.instanceId || owner.activationLease?.status !== "parked") {
          throw new Error("Failed home archive no longer holds its original fence");
        }
        if (!input.dryRun) await tx.journal.operations.patch(operation.id, {
          status: "pending", startedAt: null, completedAt: null, error: { clear: true }, nextAttemptAt: { clear: true }, expireAt: { clear: true },
        });
      }
      return { operationId: existing.operationId };
    }
    const lease = owner.activationLease;
    const parked = owner.home.computer;
    const sharedId = owner.gateway?.gatewayId;
    const returnOperationId = lease?.returnOperationId;
    if (lease?.status !== "parked" || !sharedId || !isUserParkedVm(parked) || parked.disposable || !parked.instanceId ||
        lease.targetGatewayId !== parked.gatewayId || !/^[1-9]\d{0,19}$/u.test(parked.instanceId) ||
        typeof returnOperationId !== "string" || !returnOperationId || returnOperationId.includes("/") ||
        typeof owner.home.homeDisk?.id !== "string" || !/^[1-9]\d{0,19}$/u.test(owner.home.homeDisk.id) ||
        parked.vmSpec?.desktop !== "x11" || owner.fences.computerRecovery !== undefined) {
      throw new Error("Home archive requires an idle owner and a verified parked VM");
    }
    const { gatewayId, instanceId } = parked;
    const [root, shared, assignment, returned, pending] = await Promise.all([
      tx.gateways.roots.get(gatewayId), tx.gateways.roots.get(sharedId), tx.gateways.assignments.get(sharedId, ownerUid),
      tx.journal.operations.get(returnOperationId), tx.journal.operations.listForUid(ownerUid, { statuses: ["pending", "running"] }),
    ]);
    if (root?.gatewayClass !== "isolated" || root.ownerUid !== ownerUid || root.desiredStatus !== "paused" ||
        root.liveRelease == null || root.desiredRelease !== root.liveRelease || root.retirementClaim != null ||
        root.sizingProfile !== grant.sizingProfile || shared?.gatewayClass !== "shared" ||
        assignment?.uid !== ownerUid || assignment.gatewayId !== sharedId || assignment.state !== "serving" ||
        !Number.isSafeInteger(assignment.epoch) || assignment.epoch < 0 ||
        !hasVerifiedReturn(returned, ownerUid, gatewayId, sharedId) || pending.length > 0) {
      throw new Error("Home archive requires a settled native return to the serving Shared assignment");
    }
    const operationId = randomUUID();
    if (input.dryRun) return { operationId };
    const homeArchive: UserHomeArchive = { phase: "preparing", operationId, gatewayId, instanceId };
    await tx.users.records.patch(ownerUid, { home: { homeArchive } }, { revision: owner.revision });
    await tx.users.records.setFence(ownerUid, "computerRecovery", {
      operationId, gatewayId, instanceId, sharedGatewayId: sharedId, assignmentEpoch: assignment.epoch,
    }, "absent");
    await tx.journal.operations.create({
      id: operationId, kind: "gateway-vm", status: "pending", origin: "operator", createdBy, createdAt: Date.now(),
      startedAt: null, completedAt: null, steps: [], gatewayId, inputUid: ownerUid,
      input: { action: "archive", uid: ownerUid, ownerUid, expectedGatewayId: gatewayId, expectedInstanceId: instanceId },
    });
    return { operationId };
  });
}
