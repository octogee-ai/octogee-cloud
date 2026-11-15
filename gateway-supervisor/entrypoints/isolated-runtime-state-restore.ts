import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { userClaimSlug } from "@octogee/shared/server/user-claim";
import { pathToFileURL } from "node:url";
import { createFleetBrokerClient, type FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { landGatewayStateAnchor, type GatewayStateAnchorVerifier } from "../lib/agent-anchor-record.js";
import { localStateStoreKind, localStateStorePath, openclawStateRoot } from "../lib/openclaw-state-store.js";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

const runtimeLogger = createServiceLogger("builder-runtime-state-restore");
class UserStatePolicyError extends Error {}

export async function runIsolatedRuntimeStateRestore(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: {
    broker?: Pick<FleetBrokerClient, "readAgentAnchors">;
    verifyState?: GatewayStateAnchorVerifier;
    deferMigration?: boolean;
  } = {},
): Promise<void> {
  if (!isIsolatedGatewayClassValue(env.GATEWAY_CLASS)) return;
  const gatewayId = env.GATEWAY_ID?.trim();
  const slug = userClaimSlug(env);
  if (!gatewayId || !slug) throw new UserStatePolicyError("User PostgreSQL state recovery requires a Gateway ID and verified claim");
  const stateDir = openclawStateRoot(env);
  const stateFile = localStateStorePath(stateDir);
  let kind: ReturnType<typeof localStateStoreKind>;
  try {
    kind = localStateStoreKind(stateFile);
  } catch (error) {
    throw new UserStatePolicyError(
      `Cannot inspect retained user state at ${stateFile}; repair the local state before restarting: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (kind === "sqlite") {
    if (dependencies.deferMigration) {
      runtimeLogger.info("restore preserved SQLite state for held native migration; gateway startup remains blocked");
      return;
    }
    throw new UserStatePolicyError("Retained SQLite user state requires an offline native database port --family state --to postgres; refusing checkpoint restore or engine-selector changes");
  }
  if (kind === "anchor") {
    runtimeLogger.info("restore preserved PostgreSQL state anchor");
    return;
  }
  const broker = dependencies.broker ?? createFleetBrokerClient(gatewayId);
  const { state } = await broker.readAgentAnchors({ slug });
  if (state) {
    await landGatewayStateAnchor(stateDir, state, dependencies.verifyState);
    runtimeLogger.info("restore recovered recorded PostgreSQL state anchor");
  } else {
    runtimeLogger.info("restore no recorded PostgreSQL state anchor");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIsolatedRuntimeStateRestore(process.env, { deferMigration: process.argv.includes("--defer-builder-store-migration") }).catch((error: unknown) => {
    runtimeLogger.error(`[runtime-state] restore failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof UserStatePolicyError ? 2 : 1;
  });
}
