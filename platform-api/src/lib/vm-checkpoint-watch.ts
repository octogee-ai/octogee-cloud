import { createHash } from "node:crypto";
import type { FleetRegistryRecord, PlatformStateStore } from "@octogee/core/platform-state";
import { homeCheckpointOutstanding, type GatewayVmRuntimeResponse } from "@octogee/shared/types/glm";

export const CHECKPOINT_CURSOR_HEADER = "x-octogee-checkpoint-cursor";
export const CHECKPOINT_WAIT_MS = 24_000;

export function vmRuntimeCheckpointSignal(home: FleetRegistryRecord["vmHome"]): GatewayVmRuntimeResponse["homeCheckpoint"] {
  return {
    requestedAt: typeof home?.checkpointRequestedAt === "number" ? home.checkpointRequestedAt : null,
    completedAt: !homeCheckpointOutstanding(home) && typeof home?.lastCheckpoint?.completedAt === "number" ? home.lastCheckpoint.completedAt : null,
  };
}

export function vmCheckpointCursor(runtime: FleetRegistryRecord | null | undefined, instanceId: string | undefined): string | null {
  if (!instanceId || runtime?.runtime !== "gce-vm" || runtime.vm?.instanceId !== instanceId) return null;
  const { requestedAt, completedAt } = vmRuntimeCheckpointSignal(runtime.vmHome);
  const checkpoint = [runtime.vmHome?.returnOperationId, requestedAt, requestedAt === null ? null : completedAt];
  return createHash("sha256").update(JSON.stringify([runtime.gatewayId, instanceId, checkpoint])).digest("hex");
}

export async function waitForVmCheckpointChange(
  store: Pick<PlatformStateStore, "watch"> & { fleetRegistry: Pick<PlatformStateStore["fleetRegistry"], "get"> },
  input: { gatewayId: string; instanceId: string; cursor: string; signal: AbortSignal },
): Promise<"changed" | "unchanged" | "unbound"> {
  let wake!: () => void;
  let fail!: (error: unknown) => void;
  const change = new Promise<void>((resolve, reject) => { wake = resolve; fail = reject; });
  const subscription = store.watch({ aggregate: "fleetRegistry", filter: { gatewayId: input.gatewayId } }, {
    onEvent: event => {
      if (event.kind === "resync") return;
      const runtime = event.kind === "snapshot" ? event.records[0]
        : event.changes.find(record => record.key === input.gatewayId)?.record;
      if (event.kind === "changes" && runtime === undefined) return;
      if (vmCheckpointCursor(runtime, input.instanceId) !== input.cursor) wake();
    },
    onError: fail,
  });
  void subscription.closed.then(() => fail(new Error("VM checkpoint watch closed before delivery")), fail);
  input.signal.addEventListener("abort", wake, { once: true });
  const timeout = setTimeout(wake, CHECKPOINT_WAIT_MS);
  try {
    if (input.signal.aborted) wake();
    await change;
    if (input.signal.aborted) return "unchanged";
    const current = vmCheckpointCursor(await store.fleetRegistry.get(input.gatewayId), input.instanceId);
    if (current === null) return "unbound";
    return current === input.cursor ? "unchanged" : "changed";
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", wake);
    await subscription.close();
  }
}
