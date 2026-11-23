import { pathToFileURL } from "node:url";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import { createServiceLogger } from "@octogee/shared/server/service-logger";

const logger = createServiceLogger("claim-ephemeral-writer");

async function main(): Promise<void> {
  const gatewayId = process.env.GATEWAY_ID?.trim();
  if (!gatewayId) throw new Error("Ephemeral writer claim requires a gateway ID");
  await createFleetBrokerClient(gatewayId).claimEphemeralWriter();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    logger.error("Ephemeral writer claim failed", { error });
    process.exitCode = 1;
  });
}
