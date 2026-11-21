import type { PlatformStateStore, WatchEvent, WatchRecords } from "@octogee/core/platform-state";
import { GATEWAY_HEARTBEAT_INTERVAL_MS, GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { builderActivateOperationId, builderReturnOperationId } from "@octogee/shared/types/isolated-operation-ids";

type Builder = WatchRecords["builders"];
type Operation = WatchRecords["operations"];
type Runtime = WatchRecords["fleetRegistry"];

interface RetirementCandidate {
  uid: string;
  gatewayId: string;
  operationId: string;
  returning: boolean;
  fence: number | undefined;
  notifiedFence: number | undefined;
  heartbeat: Runtime["heartbeat"] | undefined;
  retryFenceRead: boolean;
  readSequence: number;
}

function retirementMove(record: Builder | null) {
  const lease = record?.activationLease;
  if (!lease?.targetGatewayId || record?.gateway?.gatewayId === lease.targetGatewayId) return;
  const returning = lease.status === "returning";
  if (!returning && lease.status !== "activating") return;
  const gatewayId = lease.targetGatewayId;
  const operationId = returning
    ? builderReturnOperationId(gatewayId, lease.generation)
    : builderActivateOperationId(gatewayId, lease.generation);
  return { gatewayId, operationId, returning };
}

export function createPlacementRetirementTelemetry(
  operations: Pick<PlatformStateStore["journal"]["operations"], "get">,
  wake: () => void,
  log: (message: string) => void,
) {
  const byUid = new Map<string, RetirementCandidate>();
  const byGateway = new Map<string, RetirementCandidate>();
  const byOperation = new Map<string, RetirementCandidate>();

  function takeWake(candidate: RetirementCandidate): boolean {
    const { heartbeat } = candidate;
    const observedAt = heartbeat?.lastHeartbeatAt;
    const now = Date.now();
    if (candidate.fence === undefined || candidate.fence === candidate.notifiedFence ||
      heartbeat?.mountedCustomers.length !== 0 || typeof observedAt !== "number" ||
      observedAt <= candidate.fence || observedAt > now + GATEWAY_HEARTBEAT_INTERVAL_MS ||
      now - observedAt > GATEWAY_UNREACHABLE_AFTER_MS) return false;
    candidate.notifiedFence = candidate.fence;
    return true;
  }

  function updateOperation(candidate: RetirementCandidate, operation: Operation | null): void {
    const terminal = candidate.returning
      ? operation?.status === "succeeded"
      : operation?.status === "failed" || operation?.status === "rolled-back";
    candidate.fence = terminal && operation?.kind === "migrate-user" &&
      (operation.inputUid ?? operation.input.uid) === candidate.uid &&
      typeof operation.completedAt === "number" ? operation.completedAt : undefined;
    candidate.retryFenceRead = false;
    if (takeWake(candidate)) wake();
  }

  function readOperation(candidate: RetirementCandidate): void {
    const sequence = ++candidate.readSequence;
    candidate.retryFenceRead = false;
    const current = () => byOperation.get(candidate.operationId) === candidate && candidate.readSequence === sequence;
    void operations.get(candidate.operationId).then(operation => {
      if (current()) updateOperation(candidate, operation);
    }, error => {
      if (current()) {
        candidate.retryFenceRead = true;
        log(`[glm-controller] retirement telemetry fence read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  function updateBuilder(uid: string, record: Builder | null): void {
    const move = retirementMove(record);
    const previous = byUid.get(uid);
    if (previous?.operationId === move?.operationId) return;
    if (previous) {
      byUid.delete(uid);
      if (byGateway.get(previous.gatewayId) === previous) byGateway.delete(previous.gatewayId);
      if (byOperation.get(previous.operationId) === previous) byOperation.delete(previous.operationId);
    }
    if (!move) return;
    const candidate: RetirementCandidate = {
      uid, ...move, fence: undefined, notifiedFence: undefined, heartbeat: undefined,
      retryFenceRead: false, readSequence: 0,
    };
    byUid.set(uid, candidate);
    byGateway.set(move.gatewayId, candidate);
    byOperation.set(move.operationId, candidate);
    readOperation(candidate);
  }

  return {
    builders(event: WatchEvent<"builders">): void {
      if (event.kind === "snapshot") {
        const present = new Set(event.records.map(record => record.uid));
        for (const uid of byUid.keys()) if (!present.has(uid)) updateBuilder(uid, null);
        for (const record of event.records) updateBuilder(record.uid, record);
      } else if (event.kind === "changes") {
        for (const change of event.changes) updateBuilder(change.key, change.record);
      }
    },
    operations(event: WatchEvent<"operations">): void {
      if (event.kind === "resync") {
        for (const candidate of byOperation.values()) readOperation(candidate);
      } else if (event.kind === "changes") {
        for (const { key, record } of event.changes) {
          const candidate = byOperation.get(key);
          if (!candidate) continue;
          if (record === null) {
            readOperation(candidate);
          } else {
            ++candidate.readSequence;
            updateOperation(candidate, record);
          }
        }
      }
    },
    runtime(event: WatchEvent<"fleetRegistry">): boolean {
      let changed = false;
      const update = (gatewayId: string, record: Runtime | null) => {
        const candidate = byGateway.get(gatewayId);
        if (!candidate) return;
        candidate.heartbeat = record?.heartbeat;
        if (candidate.retryFenceRead) readOperation(candidate);
        if (takeWake(candidate)) changed = true;
      };
      if (event.kind === "snapshot") {
        for (const candidate of byGateway.values()) candidate.heartbeat = undefined;
        for (const record of event.records) update(record.gatewayId, record);
      } else if (event.kind === "changes") {
        for (const { key, record } of event.changes) update(key, record);
      }
      return changed;
    },
    clear(): void {
      byUid.clear();
      byGateway.clear();
      byOperation.clear();
    },
  };
}
