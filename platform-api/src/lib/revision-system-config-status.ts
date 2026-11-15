import type { PlatformStateStore } from "@octogee/core/platform-state";

export async function recordRevisionSystemConfigStatus(
  store: PlatformStateStore,
  input: {
    gatewayId: string;
    revisionId: string;
    status: Record<string, unknown>;
  },
): Promise<boolean> {
  if (input.revisionId !== input.gatewayId) return false;
  return store.transaction({ label: "fleet-broker.system-config-status" }, async (tx) => {
    const runtime = await tx.fleetRegistry.get(input.gatewayId);
    if (runtime === null) return false;
    await tx.fleetRegistry.patch(input.gatewayId, {
      heartbeat: {
        ...runtime.heartbeat,
        configStatus: { ...input.status, observedAt: { serverNow: true } },
      },
    }, { revision: runtime.revision });
    return true;
  });
}
