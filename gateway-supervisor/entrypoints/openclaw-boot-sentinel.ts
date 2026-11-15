import { pathToFileURL } from "node:url";
import { createFleetBrokerClient, type FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { createOpenClawBootWatcher } from "../lib/openclaw-boot-watcher.js";
import { PLATFORM_OPENCLAW_BINARY } from "../lib/openclaw-installed-build.js";

type BootInput = {
  env?: NodeJS.ProcessEnv;
  client?: Pick<FleetBrokerClient, "claimOpenClawBoot" | "completeOpenClawBoot" | "completeOpenClawDoctor">;
  log?: (message: string) => void;
  openclawBinary?: string;
  installedOpenClawBuild?: () => Promise<string>;
};

function bootIdentity(env: NodeJS.ProcessEnv) {
  const gatewayId = env.GATEWAY_ID?.trim();
  if (!gatewayId) throw new Error("GATEWAY_ID is required for the OpenClaw boot claim");
  const releaseKey = env.BUILD_SHA?.trim() || env.GATEWAY_IMAGE_TAG?.trim();
  if (!releaseKey) throw new Error("BUILD_SHA or GATEWAY_IMAGE_TAG is required for the OpenClaw boot claim");
  return { gatewayId, revisionId: env.GATEWAY_REVISION_ID?.trim() || gatewayId, releaseKey };
}

export async function runOpenClawBootPhase(phase: string | undefined, input: BootInput = {}): Promise<void> {
  if (phase !== "before-start" && phase !== "healthy") {
    throw new Error(`invalid OpenClaw boot phase: ${String(phase)}`);
  }
  const env = input.env ?? process.env;
  const { gatewayId, revisionId, releaseKey } = bootIdentity(env);
  const watcher = createOpenClawBootWatcher({
    client: input.client ?? createFleetBrokerClient(gatewayId, revisionId),
    releaseKey,
    log: input.log ?? ((message) => process.stderr.write(`${message}\n`)),
    openclaw: { binary: input.openclawBinary ?? PLATFORM_OPENCLAW_BINARY, installedBuild: input.installedOpenClawBuild },
  });
  if (phase === "before-start") await watcher.beforeStart();
  else await watcher.healthy();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOpenClawBootPhase(process.argv[2]).catch((error: unknown) => {
    process.stderr.write(`[openclaw-boot] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
