import { checkpointGatewayCredentials, waitForCheckpointClaim } from "@octogee/shared/server/hobby-checkpoint-gate";
import { installBrokeredUserIdentity } from "@octogee/core/identity/brokered-user-identity-provider";
import { gatewayEdgeMode } from "./lib/gateway-edge-mode.js";

if (process.env.OCTOGEE_CHECKPOINT_SLOT_ID) {
  if (gatewayEdgeMode() !== "sidecar") throw new Error("A gateway checkpoint requires a private edge sidecar");
  const claim = await waitForCheckpointClaim("edge");
  const credentials = await checkpointGatewayCredentials();
  process.stderr.write("[hobby-checkpoint] edge claim and credentials ready\n");
  process.env.POD_UID = claim.podUid;
  process.env.OPENCLAW_GATEWAY_TOKEN = credentials.token;
  process.env.OPENCLAW_AGENT_STORE_DSN = credentials.agentStoreDsn;
}

if (gatewayEdgeMode() === "sidecar") installBrokeredUserIdentity(process.env);
await import("./index.js");
