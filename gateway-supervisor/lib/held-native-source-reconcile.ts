import type { RequestHandler } from "express";
import { reconcileHeldNativeSource } from "@octogee/core/fleet-migration-client";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { FlushGatewayResponse, HeldNativeSourceBinding, HeldNativeSourceReconcileRequest, RestoreMigrationResponse } from "@octogee/shared/types/fleet-controller";

export interface HeldNativeSourceKeeper {
  runExclusive<T>(binding: HeldNativeSourceBinding, work: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T>;
}

export interface HeldSourceActions {
  readSnapshot(uid: string): Promise<FleetBrokerUserSnapshot | null>;
  restore(snapshot: FleetBrokerUserSnapshot, assertHeld: () => Promise<void>): Promise<RestoreMigrationResponse>;
  drain(): Promise<{ drained: boolean; runningCount: number }>;
  flush(): Promise<Omit<FlushGatewayResponse, "migrationId" | "slug">>;
  exportManifest(): Promise<unknown>;
}

export async function runHeldSourceReconcile(
  body: HeldNativeSourceReconcileRequest, keeper: HeldNativeSourceKeeper, actions: HeldSourceActions,
) {
  return keeper.runExclusive(body.binding, async assertHeld => {
    const { migrationId, slug, binding: { uid, gatewayId } } = body;
    return reconcileHeldNativeSource({ uid, gatewayId, slug, migrationId }, {
      now: Date.now, assertCurrent: assertHeld,
      readSnapshot: async () => {
        const snapshot = await actions.readSnapshot(uid);
        if (!snapshot) throw new Error("The held source broker has no owner snapshot");
        return snapshot;
      },
      client: {
        restore: snapshot => actions.restore(snapshot, assertHeld),
        quiesce: async () => ({ migrationId, slug, ...await actions.drain() }),
        flush: async () => ({ migrationId, slug, ...await actions.flush() }),
        exportManifest: async () => ({ migrationId, slug, manifest: await actions.exportManifest() }),
      },
    });
  });
}

export function requireHeldSourceMaintenance(gatewayId: string, active: () => boolean): RequestHandler {
  return (req, res, next) => {
    if (!active() || (req.method === "GET" && req.path === "/health") ||
        (req.method === "POST" && req.path === `/held-native-source-reconcile/${gatewayId}`)) {
      next();
      return;
    }
    res.status(409).json({ error: "source_maintenance_in_progress" });
  };
}
