import express from "express";
import {
  createHeldNativeSourceAcquisition,
  createHeldNativeSourceHoldHandler,
} from "./held-native-source-acquisition.js";
import { createScopedHeldNativeSourceReconcileHandler } from "./fleet-http-migration.js";
import type { HeldSourceActions } from "./held-native-source-reconcile.js";

export function createHeldNativeSourceMaintenanceApp(options: {
  gatewayId: string;
  publicKey: string;
  acquisition: ReturnType<typeof createHeldNativeSourceAcquisition>;
  actions: HeldSourceActions;
}) {
  const { gatewayId, publicKey, acquisition } = options;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({
    limit: "8kb",
    verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }));
  for (const action of ["acquire", "read"] as const) {
    app.post(`/held-native-source-hold/${action}/:gatewayId`,
      createHeldNativeSourceHoldHandler({ action, publicKey, gatewayId, acquisition }));
  }
  app.post("/held-native-source-reconcile/:gatewayId", createScopedHeldNativeSourceReconcileHandler({
    publicKey, gatewayId,
    getHeldSourceKeeper: acquisition.getHeldSourceKeeper,
    actionsFor: () => options.actions,
  }));
  return app;
}
