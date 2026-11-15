import os from "node:os";
import { pathToFileURL } from "node:url";

import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { runOpenClaw } from "../lib/openclaw-cli.js";
import { currentGatewayContainerPidNamespace, recoverRestartedGatewayContainerLocks } from "../lib/stopped-gateway-locks.js";

const runtimeLogger = createServiceLogger("recover-restarted-gateway-container-locks");

async function main(): Promise<void> {
  try {
    await recoverRestartedGatewayContainerLocks({
      env: process.env,
      hostname: os.hostname(),
      pidNamespace: await currentGatewayContainerPidNamespace(),
      run: runOpenClaw,
      log: runtimeLogger.info,
    });
  } catch (error) {
    runtimeLogger.error(`[gateway-locks] Gateway lock recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
