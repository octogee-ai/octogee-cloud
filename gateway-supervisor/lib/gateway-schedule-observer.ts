import { createHash } from "node:crypto";
import { parseScheduleCheckpoint } from "@octogee/core/fleet-state";
import { setTimeout as wait } from "node:timers/promises";
import type { FleetBrokerClient } from "./fleet-broker-client.js";
import type { GatewayInventoryEvent, GatewayRpcClient } from "./gateway-rpc.js";
import { schedulerHandoffAgentIds } from "./agent-roster-deletion.js";

type CheckpointInput = {
  rpc: Pick<GatewayRpcClient, "configGet" | "schedulerMigration" | "watchScheduleInventory">;
  broker: Pick<FleetBrokerClient, "assignmentRoster" | "assignedUsers" | "recordScheduleCheckpoint">;
  log(message: string): void;
  onConfigChange?(): void;
};

type ScheduleOwner = { uid: string; slug: string; assignmentEpoch: number; agentIds: string[] };

async function scheduleOwners(input: CheckpointInput): Promise<ScheduleOwner[]> {
  const [roster, users, { config }] = await Promise.all([
    input.broker.assignmentRoster(), input.broker.assignedUsers({ completeOnly: true }), input.rpc.configGet(),
  ]);
  const epochs = new Map(roster.filter(row => row.state === "serving").map(row => [row.uid, row.epoch]));
  return users.flatMap(({ uid, slug }) => {
    const assignmentEpoch = epochs.get(uid);
    if (assignmentEpoch === undefined) return [];
    const agentIds = schedulerHandoffAgentIds(config, slug, [], false);
    return agentIds.length ? [{ uid, slug, assignmentEpoch, agentIds }] : [];
  });
}

async function captureScheduleOwner(input: CheckpointInput, owner: ScheduleOwner, signal?: AbortSignal): Promise<boolean> {
  const { uid, assignmentEpoch, agentIds } = owner;
  const observedAt = Date.now();
  const operationId = `checkpoint-${createHash("sha256").update(uid).digest("hex").slice(0, 32)}`;
  const result = await input.rpc.schedulerMigration({ operationId, phase: "checkpoint", agentIds, retainNonportable: true });
  if (!result.drained || signal?.aborted) return false;
  const snapshot = parseScheduleCheckpoint(result.snapshot);
  if (!snapshot || snapshot.operationId !== operationId || JSON.stringify(snapshot.agentIds) !== JSON.stringify(agentIds)) {
    throw new Error("scheduler returned a mismatched checkpoint");
  }
  await input.broker.recordScheduleCheckpoint({ uid, assignmentEpoch, observedAt, snapshot });
  return true;
}

export async function checkpointGatewaySchedules(
  input: CheckpointInput,
  options: { signal?: AbortSignal; requireSlug?: string } = {},
): Promise<void> {
  const { signal, requireSlug } = options;
  const owners = await scheduleOwners(input);
  if (requireSlug) {
    const owner = owners.find(user => user.slug === requireSlug);
    if (!owner) throw new Error("Schedule checkpoint owner or assignment is unavailable");
    if (!await captureScheduleOwner(input, owner, signal)) throw new Error("Schedule checkpoint is waiting for running jobs to settle");
    return;
  }
  for (const owner of owners) {
    if (signal?.aborted) return;
    try {
      await captureScheduleOwner(input, owner, signal);
    } catch (error) {
      input.log(`[gateway-schedules] checkpoint failed for ${owner.slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function startGatewayScheduleObserver(input: CheckpointInput, auditMs = 30_000): () => void {
  const subscribeInventory = input.rpc.watchScheduleInventory;
  if (!subscribeInventory) throw new Error("Schedule inventory notifications are unavailable");
  const watch = subscribeInventory.bind(input.rpc);
  const control = new AbortController();
  const { signal } = control;
  let pending = false;
  let running = false;

  async function refresh(): Promise<void> {
    running = true;
    try {
      while (pending && !signal.aborted) {
        pending = false;
        await checkpointGatewaySchedules(input, { signal });
      }
    } catch (error) {
      input.log(`[gateway-schedules] checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  }

  function notify(event?: GatewayInventoryEvent) {
    if (signal.aborted) return;
    if (event === "config.changed" || event === "connected") input.onConfigChange?.();
    pending = true;
    if (!running) void refresh();
  }

  async function subscribe() {
    while (!signal.aborted) {
      await watch(notify, signal).catch(error => {
        input.log(`[gateway-schedules] notification connection failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (!signal.aborted) await wait(2_000, undefined, { signal, ref: false });
    }
  }

  const audit = setInterval(notify, auditMs);
  audit.unref();
  void subscribe().catch(error => {
    if (!signal.aborted) input.log(`[gateway-schedules] observer stopped: ${error instanceof Error ? error.message : String(error)}`);
  });
  return () => { clearInterval(audit); control.abort(); };
}
