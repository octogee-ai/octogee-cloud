import { installBrokeredUserIdentity } from "@octogee/core/identity/brokered-user-identity-provider";
import { gatewayEdgeMode } from "./lib/gateway-edge-mode.js";

if (gatewayEdgeMode() === "sidecar") installBrokeredUserIdentity(process.env);
await import("./index.js");
