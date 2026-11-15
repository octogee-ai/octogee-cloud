import "../src/main.js";
import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("prestop-flush");
import { flushUserFiles, flushAllUserFiles } from "../lib/user-file-state.js";
import { persistUserProjects, persistSharedUserFiles } from "../lib/project-persistence.js";
import { blobSyncAllWithOptions, blobSyncForSlug } from "../lib/blob-sync.js";
import {
  GATEWAY_CLASS,
  GATEWAY_ID,
  log,
} from "../lib/config.js";
import { createBrokeredBlobStore } from "../lib/blob-sync-broker.js";
import {
  createFleetBrokerClient,
  type FleetBrokerClient,
} from "../lib/fleet-broker-client.js";
import { runGatewayPreStopFlush } from "../lib/gateway-prestop-flush.js";
import {
  listLocalUserPubKeys,
  listOnDiskUserSlugs,
  readLocalUserPubKey,
  type LocalUserPubKey,
} from "../lib/git.js";
import { quiesceUserSessions } from "../lib/user-session-quiesce.js";
import { brokeredGitHost, type BrokeredGitHost } from "../lib/gitea-admin-broker-client.js";
import {
  checkpointDurableSystemConfigForSlug,
  syncSystemConfigForSlug,
} from "../lib/system-config.js";
import { pathToFileURL } from "node:url";
import { userClaimSlug } from "@octogee/shared/server/user-claim";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export interface PreStopFlushConfig {
  builderSlug: string;
  gatewayClass: string;
  gatewayId: string;
}

export const PRESTOP_SESSION_QUIESCE_TIMEOUT_MS = 5_000;

export function createPreStopSessionQuiesce(
  builderSlug: string,
  deps: {
    listUserSlugs: () => string[];
    quiesce: typeof quiesceUserSessions;
  } = {
    listUserSlugs: listOnDiskUserSlugs,
    quiesce: quiesceUserSessions,
  },
): () => Promise<void> {
  return async () => {
    const slugs = builderSlug ? [builderSlug] : deps.listUserSlugs();
    const failures = (await Promise.all(slugs.map(async (slug) => {
      try {
        const result = await deps.quiesce(slug, {
          timeoutMs: PRESTOP_SESSION_QUIESCE_TIMEOUT_MS,
          log,
        });
        return result.drained ? null : `${slug}: ${result.runningCount} session(s) still running`;
      } catch (err) {
        return `${slug}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }))).filter((failure): failure is string => failure !== null);
    if (failures.length > 0) {
      throw new Error(`[prestop-flush] session quiesce incomplete: ${failures.join("; ")}`);
    }
  };
}

export function resolvePreStopFlushConfig(
  env: NodeJS.ProcessEnv = process.env,
  runtime: { gatewayClass?: string; gatewayId?: string } = {
    gatewayClass: GATEWAY_CLASS,
    gatewayId: GATEWAY_ID,
  },
): PreStopFlushConfig {
  const rawGatewayId = runtime.gatewayId ?? "local";
  return {
    gatewayId: rawGatewayId === "local" ? "default" : rawGatewayId,
    gatewayClass: runtime.gatewayClass ?? "",
    builderSlug: userClaimSlug(env) ?? "",
  };
}

export function createPreStopSystemConfigFlush(
  builderSlug: string,
  logFn: (message: string) => void = log,
  sync: typeof syncSystemConfigForSlug = syncSystemConfigForSlug,
): (() => Promise<{ acceptedCommit: string }>) | undefined {
  if (!builderSlug) return undefined;
  return async () => {
    const result = checkpointDurableSystemConfigForSlug(builderSlug, { log: logFn }, sync);
    return { acceptedCommit: result.acceptedCommit! };
  };
}

export function createPreStopAllUsersFileFlush(
  gatewayClass: string,
  brokerClient: Pick<FleetBrokerClient, "provisionedUserSlugs">,
  deps: {
    flushAllUserFiles: typeof flushAllUserFiles;
    persistSharedUserFiles: (slug: string) => Promise<void>;
  } = { flushAllUserFiles, persistSharedUserFiles },
): () => Promise<void> {
  return async () => deps.flushAllUserFiles(
    gatewayClass === "shared"
      ? { slugs: await brokerClient.provisionedUserSlugs(), persistProjects: deps.persistSharedUserFiles }
      : {},
  );
}

export function createPreStopGiteaKeyRelease(
  builderSlug: string,
  deps: {
    readLocalUserPubKey: typeof readLocalUserPubKey;
    listLocalUserPubKeys?: () => LocalUserPubKey[];
    releaseKey: BrokeredGitHost["releaseKey"];
  } = { readLocalUserPubKey, listLocalUserPubKeys, releaseKey: brokeredGitHost.releaseKey },
): () => Promise<void> {
  return async () => {
    let keys: LocalUserPubKey[];
    if (builderSlug) {
      const pubKey = deps.readLocalUserPubKey(builderSlug);
      if (pubKey === null) {
        throw new Error(`[prestop-flush] local SSH public key is missing for ${builderSlug}`);
      }
      keys = [{ slug: builderSlug, pubKey }];
    } else {
      keys = (deps.listLocalUserPubKeys ?? listLocalUserPubKeys)();
    }
    const failures: string[] = [];
    for (const key of keys) {
      try {
        await deps.releaseKey(key.slug, key.pubKey);
      } catch (err) {
        failures.push(`${key.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`[prestop-flush] Gitea key release failed: ${failures.join("; ")}`);
    }
  };
}

async function main(): Promise<void> {
  const { builderSlug, gatewayClass, gatewayId } = resolvePreStopFlushConfig();
  const brokerClient = createFleetBrokerClient(gatewayId);
  await brokerClient
    .recordPreStopFlush({
      gatewayClass,
      phase: "started",
      reason: "prestop",
    })
    .catch((err) => {
      log(
        `[prestop-flush] broker start report failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  const result = await runGatewayPreStopFlush({
    gatewayId,
    gatewayClass,
    quiesceSessions: createPreStopSessionQuiesce(builderSlug),
    flushFiles: builderSlug
      ? () => flushUserFiles(builderSlug, { persistProjects: isIsolatedGatewayClassValue(gatewayClass) ? persistUserProjects : undefined })
      : createPreStopAllUsersFileFlush(gatewayClass, brokerClient),
    syncBlobs: builderSlug
      ? () => blobSyncForSlug(builderSlug, {
          strict: true,
          store: createBrokeredBlobStore(brokerClient),
        })
      : () => blobSyncAllWithOptions({
          strict: true,
          storeForSlug: () => createBrokeredBlobStore(brokerClient),
        }),
    syncSystemConfig: createPreStopSystemConfigFlush(builderSlug),
    releaseGiteaKey: createPreStopGiteaKeyRelease(builderSlug),
    log,
  });
  await brokerClient
    .recordPreStopFlush({
      gatewayClass,
      phase: "completed",
      reason: "prestop",
      result,
    })
    .catch((err) => {
      log(
        `[prestop-flush] broker completion report failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    runtimeLogger.error("prestop-flush fatal:", { error: err });
    process.exit(1);
  });
}
