import { waitForInstalledSharedMaintenanceGate } from "@octogee/core/shared-maintenance-startup";
import { initializeCheckpointEdge } from "@octogee/shared/server/hobby-checkpoint-gate";
import { installBrokeredUserIdentity } from "@octogee/core/identity/brokered-user-identity-provider";
import { gatewayEdgeMode } from "./lib/gateway-edge-mode.js";

if (gatewayEdgeMode() === "sidecar") await waitForInstalledSharedMaintenanceGate("gateway-edge", process.env);
await initializeCheckpointEdge(gatewayEdgeMode() === "sidecar");

if (gatewayEdgeMode() === "sidecar") installBrokeredUserIdentity(process.env);
await import("./index.js");
