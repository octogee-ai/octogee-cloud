import { landAuxiliaryAnchors, type AuxiliaryAnchorVerifier } from "../lib/user-auxiliary-anchors.js";
import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("agent-anchor-restore");
import { pathToFileURL } from "node:url";
import { userClaimSlug } from "@octogee/shared/server/user-claim";
import { agentIdsFromConfig } from "@octogee/core/byosub-restore";
import { readOpenClawConfig } from "@octogee/core/config";
import {
  landAgentAnchors,
  landGatewayStateAnchor,
  verifyAgentAnchorInPostgres,
  type AgentAnchorVerifier,
  type GatewayStateAnchorVerifier,
} from "../lib/agent-anchor-record.js";
import { clusterIsolatedGateway, openclawStateRoot } from "../lib/openclaw-state-store.js";
import { createFleetBrokerClient, type FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { initializeIsolatedNativeState } from "../lib/isolated-native-bootstrap.js";

export interface AgentAnchorRestoreResult {
  landed: string[];
  preserved: string[];
  state?: "landed" | "preserved";
  skipped: boolean;
}

function nonBlank(value: string | undefined): string {
  return value?.trim() ?? "";
}

export async function runAgentAnchorRestore(input: {
  env?: NodeJS.ProcessEnv;
  broker: Pick<FleetBrokerClient, "readAgentAnchors">;
  readConfig?: () => unknown;
  verify?: AgentAnchorVerifier;
  initializeHost?: (stateDir: string) => Promise<void>;
  verifyState?: GatewayStateAnchorVerifier;
  verifyAuxiliary?: AuxiliaryAnchorVerifier;
  log: (message: string) => void;
}): Promise<AgentAnchorRestoreResult> {
  const env = input.env ?? process.env;
  const slug = nonBlank(env.GATEWAY_CLASS) === "shared" ? null : userClaimSlug(env);
  if (!slug) return { landed: [], preserved: [], skipped: true };
  const configured = new Set(agentIdsFromConfig((input.readConfig ?? readOpenClawConfig)()));
  const { anchors, state, auxiliary = [] } = await input.broker.readAgentAnchors({ slug });
  const stateRoot = openclawStateRoot(env);
  const landedState = state && clusterIsolatedGateway(env)
    ? await landGatewayStateAnchor(stateRoot, state, input.verifyState)
    : undefined;
  await landAuxiliaryAnchors(stateRoot, auxiliary, input.verifyAuxiliary);
  if (auxiliary.length) input.log(`[agent-anchors] restored and verified ${auxiliary.length} auxiliary anchor(s) for ${slug}`);
  await (input.initializeHost ?? ((root) => initializeIsolatedNativeState(root, undefined, env)))(stateRoot);
  const result = await landAgentAnchors(
    stateRoot,
    anchors.filter((anchor) => configured.has(anchor.agentId)),
    input.verify ?? verifyAgentAnchorInPostgres,
  );
  input.log(`[agent-anchors] landed ${result.landed.length} agent anchor(s) for ${slug}; ${result.preserved.length} already present; ${anchors.length} recorded`);
  if (!landedState) return { ...result, skipped: false };
  input.log(`[agent-anchors] gateway state anchor for ${slug} ${landedState === "landed" ? "landed" : "already present"}`);
  return { ...result, state: landedState, skipped: false };
}

async function main(): Promise<void> {
  try {
    await runAgentAnchorRestore({
      broker: createFleetBrokerClient(nonBlank(process.env.GATEWAY_ID)),
      log: runtimeLogger.info,
    });
  } catch (error) {
    runtimeLogger.error(`[agent-anchors] restore failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
