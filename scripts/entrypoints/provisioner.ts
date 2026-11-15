import "../src/main.js";
import { createBrokeredProjectBlobHydrator } from "../lib/project-blob-materialization.js";
import { persistUserProjects, persistSharedUserFiles, persistAssignedSharedUsers, startProjectAutosave } from "../lib/project-persistence.js";
import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("provisioner");
import { CONFIG_RELOAD_DEADLINE_MS } from "../../shared/types/fleet-controller.js";
import {
  AGENT_PREFIX,
  AGENTS_DIR,
  bootBanner,
  GATEWAY_CLASS,
  GATEWAY_ID,
  GATEWAY_PROFILE,
  BLOB_SYNC_INTERVAL_MS,
  isIsolatedGateway,
  log,
  OPENCLAW_DIR,
} from "../lib/config.js";
import { createGatewayRpc } from "../lib/gateway-rpc.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import { flushUserFiles } from "../lib/user-file-state.js";
import {
  buildBrokeredLifecycleAdapter,
  projectCheckoutScopeForRuntime,
} from "../lib/user-lifecycle-broker-adapter.js";
import { blobSyncAllWithOptions, blobSyncForSlug } from "../lib/blob-sync.js";
import { createBrokeredBlobStore } from "../lib/blob-sync-broker.js";
import {
  createFleetBrokerClient,
} from "../lib/fleet-broker-client.js";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import { startFleetController } from "../lib/fleet-provisioner.js";
import { desiredUsers, type DesiredUser } from "../lib/snapshot-fingerprint.js";
import { probeOpenClawVersion } from "../lib/probe-openclaw-version.js";
import { startUsageEventTailer } from "../lib/usage-log-tailer.js";
import { startBlobSyncLoop } from "../lib/blob-sync-runner.js";
import {
  runGatewayPreStopFlush,
  runGatewaySystemConfigConvergenceCheckpoint,
} from "../lib/gateway-prestop-flush.js";
import {
  checkpointDurableSystemConfigForSlug,
  readDurableSystemConfigHeadForSlug,
  syncSystemConfigForSlug,
} from "../lib/system-config.js";
import {
  createSystemConfigStatusPublisher,
  probeOpenClawHealth,
  refreshSystemConfigRuntimeHealth,
} from "../lib/system-config-runtime-health.js";
import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { userClaimSlug } from "@octogee/shared/server/user-claim";
import { configuredUserReport } from "../lib/user-claim.js";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";


export interface FleetControllerEntrypointConfig {
  builderSlug: string;
  gatewayId: string;
  port: number;
  publicKey: string;
  version: string;
}

export const SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS = [
  250,
  750,
  1_500,
  2_500,
  3_000,
] as const;
export const FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS = 120_000;

export function resolveFleetControllerEntrypointConfig(
  env: NodeJS.ProcessEnv = process.env,
  runtime: { gatewayId?: string } = { gatewayId: GATEWAY_ID },
): FleetControllerEntrypointConfig {
  const rawGatewayId = runtime.gatewayId ?? "local";
  return {
    gatewayId: rawGatewayId === "local" ? "default" : rawGatewayId,
    builderSlug: userClaimSlug(env) ?? "",
    port: parseInt(env.FLEET_CONTROLLER_PORT ?? "3003", 10),
    publicKey: env.FLEET_CONTROLLER_PUBLIC_KEY || "",
    version: env.GATEWAY_IMAGE_TAG?.trim() || env.BUILD_SHA || "unknown",
  };
}

export function createFleetSystemConfigFlush(
  builderSlug: string,
  logFn: (message: string) => void = log,
  sync: typeof syncSystemConfigForSlug = syncSystemConfigForSlug,
  expectedRemoteCommit?: string,
): (() => Promise<{ acceptedCommit: string }>) | undefined {
  if (!builderSlug) return undefined;
  return async () => {
    const result = checkpointDurableSystemConfigForSlug(builderSlug, {
      log: logFn,
      ...(expectedRemoteCommit ? { expectedRemoteCommit } : {}),
    }, sync);
    return { acceptedCommit: result.acceptedCommit! };
  };
}

export function createFleetSystemConfigVerifyFlush(
  builderSlug: string,
  expectedRemoteCommit?: string,
  readAcceptedCommit: typeof readDurableSystemConfigHeadForSlug =
    readDurableSystemConfigHeadForSlug,
): () => Promise<{ acceptedCommit: string }> {
  return async () => {
    const acceptedCommit = readAcceptedCommit(builderSlug);
    if (expectedRemoteCommit && acceptedCommit !== expectedRemoteCommit) {
      throw new Error(
        `durable system config head changed: expected ${expectedRemoteCommit}, observed ${acceptedCommit}`,
      );
    }
    return { acceptedCommit };
  };
}

// Shared pods hold no per-user durable config: their users have no
// {slug}/system_config repo, so a migration flush has no durable step to run
// and a converge fence commit aimed at one is a caller contract violation.
export function createFleetFlushSystemConfigSync(input: {
  slug: string;
  builderSlug: string;
  isolated: boolean;
  expectedSystemConfigCommit?: string;
  log?: (message: string) => void;
  sync?: typeof syncSystemConfigForSlug;
  readAcceptedCommit?: typeof readDurableSystemConfigHeadForSlug;
}): (() => Promise<{ acceptedCommit: string }>) | undefined {
  if (!input.builderSlug) {
    if (input.expectedSystemConfigCommit) {
      throw new Error(
        `converge fence rejected: this gateway holds no durable system config for ${input.slug}`,
      );
    }
    return undefined;
  }
  return input.isolated
    ? createFleetSystemConfigFlush(
        input.slug,
        input.log ?? log,
        input.sync ?? syncSystemConfigForSlug,
        input.expectedSystemConfigCommit,
      )
    : createFleetSystemConfigVerifyFlush(
        input.slug,
        input.expectedSystemConfigCommit,
        input.readAcceptedCommit ?? readDurableSystemConfigHeadForSlug,
      );
}

export interface FleetControllerRequestedFlushDeps {
  gatewayId: string;
  gatewayClass: string;
  builderSlug: string;
  isolated: boolean;
  flushFiles: (slug: string) => Promise<unknown>;
  syncBlobs?: (slug: string) => Promise<void>;
  log: (message: string) => void;
  syncSystemConfig?: typeof syncSystemConfigForSlug;
  readAcceptedCommit?: typeof readDurableSystemConfigHeadForSlug;
}

export function createFleetControllerRequestedFlush(input: FleetControllerRequestedFlushDeps) {
  return async ({
    slug,
    reason,
    expectedSystemConfigCommit,
  }: {
    slug: string;
    reason: string;
    expectedSystemConfigCommit?: string;
  }) => {
    input.log(`[fleet] controller-requested flush slug=${slug} reason=${reason}`);
    if (reason === "migration-converge" && !expectedSystemConfigCommit) {
      throw new Error(`migration converge is missing expected system config commit for ${slug}`);
    }
    const nativeReturn = reason === "native-return";
    if (nativeReturn && (!input.isolated || !isIsolatedGatewayClassValue(input.gatewayClass) || input.builderSlug !== slug || expectedSystemConfigCommit)) {
      throw new Error("native return requires the configured user and a full-home checkpoint, not a config transfer");
    }
    const syncSystemConfig = nativeReturn ? undefined : createFleetFlushSystemConfigSync({
      slug,
      builderSlug: input.builderSlug,
      isolated: input.isolated,
      expectedSystemConfigCommit,
      log: input.log,
      sync: input.syncSystemConfig,
      readAcceptedCommit: input.readAcceptedCommit,
    });
    if (reason === "migration-converge") {
      if (!syncSystemConfig) {
        throw new Error(`migration converge has no durable system config for ${slug}`);
      }
      return runGatewaySystemConfigConvergenceCheckpoint({
        gatewayId: input.gatewayId,
        gatewayClass: input.gatewayClass,
        syncSystemConfig,
        log: input.log,
      });
    }
    return runGatewayPreStopFlush({
      gatewayId: input.gatewayId,
      gatewayClass: input.gatewayClass,
      flushFiles: () => input.flushFiles(slug),
      syncBlobs: input.syncBlobs ? () => input.syncBlobs!(slug) : undefined,
      syncSystemConfig,
      log: input.log,
    });
  };
}

export function createAssignedUserReader(
  brokerClient: Pick<FleetBrokerClient, "assignedUsers" | "assignmentRoster">,
  seedSnapshot: Parameters<typeof desiredUsers>[2],
): () => Promise<Map<string, DesiredUser>> {
  return async () => {
    const [users, assignments] = await Promise.all([
      brokerClient.assignedUsers({ completeOnly: false }),
      brokerClient.assignmentRoster(),
    ]);
    return desiredUsers(users, assignments, seedSnapshot);
  };
}

export function createSharedAutosave(
  brokerClient: Pick<FleetBrokerClient, "provisionedUserSlugs">,
  persist: (slug: string) => Promise<void>,
  logFn: (message: string) => void,
): () => Promise<void> {
  return () => persistAssignedSharedUsers({
    readUsers: async () => (await brokerClient.provisionedUserSlugs()).map((slug) => ({ slug })),
    persist,
    log: logFn,
  });
}

export async function readUserEnsureAdmission(
  brokerClient: Pick<FleetBrokerClient, "assignmentRoster">,
  uid: string,
): Promise<boolean> {
  const assignment = (await brokerClient.assignmentRoster()).find((row) => row.uid === uid);
  if (!assignment) throw new Error(`missing canonical assignment for ${uid}`);
  return assignment.state !== "quiescing";
}

export function createSystemConfigMutationGatedRpc(
  rpc: GatewayRpcClient,
  openclawDir: string,
  deps: {
    acquireLease?: typeof acquireSystemConfigMutationLease;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): GatewayRpcClient {
  const acquireLease = deps.acquireLease ?? acquireSystemConfigMutationLease;
  const wait = deps.wait ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  return new Proxy(rpc, {
    get(target, property, receiver) {
      if (property !== "configApply" && property !== "configPatch") {
        return Reflect.get(target, property, receiver) as unknown;
      }
      const mutation = Reflect.get(target, property, target) as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        let acquired = await acquireLease({ openclawDir });
        for (const delayMs of SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS) {
          if (acquired.ok || acquired.code !== "writer-lock-busy") break;
          await wait(delayMs);
          acquired = await acquireLease({ openclawDir });
        }
        if (!acquired.ok) {
          throw new Error(`system config mutation unavailable: ${acquired.code}`);
        }
        try {
          return await Reflect.apply(mutation, target, args);
        } finally {
          await acquired.lease.release();
        }
      };
    },
  });
}

export function createFleetControllerMutationGatedRpc(
  openclawDir: string = OPENCLAW_DIR,
  createRpc?: typeof createGatewayRpc,
): GatewayRpcClient {
  // Every RPC opens its own socket, and the runtime this one talks to reloads
  // whenever a config patch lands — re-registering its whole plugin surface before
  // it answers a handshake again. The connect budget is therefore a reload budget;
  // a request-sized one turns any post-patch call into a hard failure.
  const runtimeRpc = createRpc
    ? createRpc({
        allowLegacyGatewayTokenFallback: true,
        callTimeoutMs: FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS,
        connectTimeoutMs: CONFIG_RELOAD_DEADLINE_MS,
      })
    : createGatewayRpc({
        allowLegacyGatewayTokenFallback: true,
        callTimeoutMs: FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS,
        connectTimeoutMs: CONFIG_RELOAD_DEADLINE_MS,
      });
  return createSystemConfigMutationGatedRpc(runtimeRpc, openclawDir);
}

async function main(): Promise<void> {
  const entrypointConfig = resolveFleetControllerEntrypointConfig();
  log(bootBanner("fleet-controller"));
  const rpc = createFleetControllerMutationGatedRpc();
  const openclawVersion = probeOpenClawVersion({
    execFile: execFileSync,
    binaryPath: "/usr/local/bin/openclaw",
  });
  if (!entrypointConfig.publicKey) {
    throw new Error("fleet controller public key unavailable: expected FLEET_CONTROLLER_PUBLIC_KEY");
  }
  const isolated = isIsolatedGateway();
  let persistProjects: ((slug: string) => Promise<void>) | undefined;
  if (isolated) persistProjects = persistUserProjects;
  else if (GATEWAY_CLASS === "shared") persistProjects = persistSharedUserFiles;
  const brokerClient = createFleetBrokerClient(entrypointConfig.gatewayId);
  const builderSlug = entrypointConfig.builderSlug;
  let stopUserServices: (() => void) | undefined;
  const startUserServices = (slug: string): void => {
    const runtimeHealthPublisher = createSystemConfigStatusPublisher({
      openclawDir: OPENCLAW_DIR,
      refreshRuntimeHealth: () => refreshSystemConfigRuntimeHealth({
        openclawDir: OPENCLAW_DIR,
        env: process.env,
        probeOpenClaw: () => probeOpenClawHealth(process.env.OPENCLAW_HEALTH_URL),
      }),
      publish: (status) => brokerClient.recordSystemConfigStatus(status),
      log,
    });
    void runtimeHealthPublisher.publishNow();
    const stopProjectAutosave = isolated
      ? startProjectAutosave({ save: () => persistUserProjects(slug), log })
      : undefined;
    stopUserServices = () => {
      stopProjectAutosave?.();
      runtimeHealthPublisher.close();
    };
  };
  const adapter = buildBrokeredLifecycleAdapter({
    client: brokerClient,
    rpc,
    log,
    isIsolatedGateway,
    projectCheckoutScope: (slug) => projectCheckoutScopeForRuntime(slug),
  });
  const fleetHandle = await startFleetController({
    rpc,
    adapter,
    gatewayId: entrypointConfig.gatewayId,
    log,
    port: entrypointConfig.port,
    publicKey: entrypointConfig.publicKey,
    version: entrypointConfig.version,
    openclawVersion,
    openclawDir: OPENCLAW_DIR,
    projectBlobHydrator: isolated ? createBrokeredProjectBlobHydrator(brokerClient) : undefined,
    localReconcile: true,
    subscribeDesiredChanges: (wake) => brokerClient.watchAssignments(wake, log),
    configuredUserReport: () => configuredUserReport(process.env),
    readDesiredUsers: createAssignedUserReader(
      brokerClient,
      adapter.seedUserSnapshotForMigration,
    ),
    readEnsureAdmission: (uid) => readUserEnsureAdmission(brokerClient, uid),
    stampMounted: (uid, mounted) => brokerClient.setMounted(uid, mounted),
    readUserSnapshotForRuntimeReset: (uid) => brokerClient.userSnapshot(uid),
    acknowledgeRuntimeReset: (uid, operationId, generation) =>
      brokerClient.acknowledgeRuntimeReset(uid, operationId, generation),
    recordReconcileError: (slug, message) => brokerClient.recordReconcileError(slug, message),
    clearReconcileError: (slug) => brokerClient.clearReconcileError(slug),
    flushLocalState: createFleetControllerRequestedFlush({
      gatewayId: entrypointConfig.gatewayId,
      gatewayClass: GATEWAY_CLASS,
      builderSlug,
      isolated,
      flushFiles: (slug) => flushUserFiles(slug, { persistProjects }),
      syncBlobs: isolated
        ? undefined
        : (slug) => blobSyncForSlug(slug, {
          strict: true,
          store: createBrokeredBlobStore(brokerClient),
        }),
      log,
    }),
    internalServiceKey: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
  });
  // Durable-config runtime health: refresh + broker publish, replacing the
  // retired status server (the probes moved to :3003/health and OpenClaw's own
  // :18789; GATEWAY-SIMPLE-ROLL-SPEC).
  if (builderSlug) startUserServices(builderSlug);
  const stopSharedAutosave = GATEWAY_CLASS === "shared" ? startProjectAutosave({
    save: createSharedAutosave(brokerClient, persistSharedUserFiles, log), log,
  }) : undefined;

  const blobSyncTimer = startBlobSyncLoop({
    syncBlobs: () => blobSyncAllWithOptions({
      storeForSlug: () => createBrokeredBlobStore(brokerClient),
    }),
    log,
  }, BLOB_SYNC_INTERVAL_MS);
  const usageTimer = isolated
    ? null
    : startUsageEventTailer({
        agentPrefix: AGENT_PREFIX,
        agentsDir: AGENTS_DIR,
        submit: async (event) => {
          await brokerClient!.recordUsageEvent({
            agentId: event.agentId,
            usage: event.usage,
          });
        },
        log,
        gatewayId: entrypointConfig.gatewayId,
      });
  log(`Local fleet controller running (profile=${GATEWAY_PROFILE}). Press Ctrl+C to stop.`);
  const cleanup = async () => {
    stopUserServices?.();
    stopSharedAutosave?.();
    clearInterval(blobSyncTimer);
    if (usageTimer) clearInterval(usageTimer);
    try { await fleetHandle.stop(); } catch {}
    try { await rpc.close(); } catch {}
  };
  process.on("SIGINT", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
  process.on("SIGTERM", () => { cleanup().finally(() => process.exit(0)).catch(() => process.exit(0)); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { runtimeLogger.error("Fatal:", { error: err }); process.exit(1); });
}
