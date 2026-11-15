import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("builder-toolchain-hydrator");
import { isolatedToolchainRoot } from "../lib/user-storage.js";
import { pathToFileURL } from "node:url";
import { userClaimSlug } from "@octogee/shared/server/user-claim";

import type { DeveloperToolchainStatusArtifact } from "@octogee/shared/types/developer-toolchain";
import type { FleetBrokerNpmRegistryCredentials } from "@octogee/shared/types/fleet-broker";
import {
  ISOLATED_TOOLCHAIN_RUNTIME_RETIRED,
  IsolatedToolchainHydrationError,
  DEFAULT_ISOLATED_NPM_FALLBACK_REGISTRY,
  hydrateIsolatedToolchain,
  runIsolatedToolchainHydrationLoop,
  writeToolchainStatus,
} from "../lib/isolated-toolchain-hydrator.js";
import {
  createFleetBrokerClient,
  isRetiredVmBindingDenial,
  type FleetBrokerClient,
} from "../lib/fleet-broker-client.js";

export interface IsolatedToolchainHydratorConfig {
  root: string;
  preinstalledRoot?: string;
  cachePath?: string;
  packageJsonPath: string;
  packageLockPath: string;
  packageLockSha256: string;
  groupsPath: string;
  groupsSha256: string;
  fallbackRegistryUrl: string;
  gatewayId: string;
  builderSlug: string;
  readinessUrl: string;
}

function envValue(env: NodeJS.ProcessEnv, key: string, fallback = ""): string {
  return env[key]?.trim() || fallback;
}

export function resolveIsolatedToolchainHydratorConfig(
  env: NodeJS.ProcessEnv = process.env,
): IsolatedToolchainHydratorConfig {
  const fleetControllerPort = envValue(env, "FLEET_CONTROLLER_PORT", "3003");
  return {
    root: isolatedToolchainRoot(env),
    ...(envValue(env, "OCTOGEE_BUILDER_PREINSTALLED_TOOLCHAIN") ? { preinstalledRoot: envValue(env, "OCTOGEE_BUILDER_PREINSTALLED_TOOLCHAIN") } : {}),
    ...(envValue(env, "NPM_CONFIG_CACHE") ? { cachePath: envValue(env, "NPM_CONFIG_CACHE") } : {}),
    packageJsonPath: envValue(
      env,
      "OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_JSON_PATH",
      "/octogee/toolchain/package.json",
    ),
    packageLockPath: envValue(
      env,
      "OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_LOCK_PATH",
      "/octogee/toolchain/package-lock.json",
    ),
    packageLockSha256: envValue(env, "OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256"),
    groupsPath: envValue(
      env,
      "OCTOGEE_BUILDER_TOOL_GROUPS_PATH",
      "/octogee/toolchain/groups.json",
    ),
    groupsSha256: envValue(env, "OCTOGEE_BUILDER_TOOL_GROUPS_SHA256"),
    fallbackRegistryUrl: envValue(
      env,
      "OCTOGEE_BUILDER_NPM_FALLBACK_REGISTRY",
      DEFAULT_ISOLATED_NPM_FALLBACK_REGISTRY,
    ),
    gatewayId: envValue(env, "GATEWAY_ID"),
    builderSlug: userClaimSlug(env) ?? "",
    readinessUrl: `http://127.0.0.1:${fleetControllerPort}/toolchain-ready`,
  };
}

type HydratorBrokerClient = Pick<
  FleetBrokerClient,
  "npmRegistryCredentials" | "uidForSlug" | "setToolchainStatus"
>;

export function guardRetiredRuntimeBrokerClient(
  client: HydratorBrokerClient,
  log: (message: string) => void,
): HydratorBrokerClient {
  let retirement: unknown = null;
  const retiredError = (cause: unknown): IsolatedToolchainHydrationError =>
    new IsolatedToolchainHydrationError(ISOLATED_TOOLCHAIN_RUNTIME_RETIRED, { cause });
  const guard = async <T>(call: () => Promise<T>): Promise<T> => {
    if (retirement) throw retiredError(retirement);
    try {
      return await call();
    } catch (error) {
      if (!isRetiredVmBindingDenial(error)) throw error;
      if (!retirement) {
        log(
          "[isolated-toolchain] broker reports this computer's runtime retired; " +
            "stopping npm credential and toolchain status requests",
        );
      }
      retirement = error;
      throw retiredError(error);
    }
  };
  return {
    npmRegistryCredentials: (slug) => guard(() => client.npmRegistryCredentials(slug)),
    uidForSlug: (slug) => guard(() => client.uidForSlug(slug)),
    setToolchainStatus: (uid, status) => guard(() => client.setToolchainStatus(uid, status)),
  };
}

export function createUserNpmProxyCredentialsProvider(input: {
  client: Pick<FleetBrokerClient, "npmRegistryCredentials">;
  builderSlug: string;
}): () => Promise<FleetBrokerNpmRegistryCredentials> {
  return () => input.client.npmRegistryCredentials(input.builderSlug);
}

export function createIsolatedToolchainStatusPublisher(input: {
  client: Pick<FleetBrokerClient, "uidForSlug" | "setToolchainStatus">;
  builderSlug: string;
}): (artifact: DeveloperToolchainStatusArtifact) => Promise<void> {
  let uidPromise: Promise<string> | null = null;
  const assignedUid = (): Promise<string> => {
    uidPromise ??= input.client.uidForSlug(input.builderSlug)
      .then((uid) => {
        if (!uid) throw new Error("configured user is not assigned to this gateway");
        return uid;
      })
      .catch((error) => {
        uidPromise = null;
        throw error;
      });
    return uidPromise;
  };
  return async (artifact) => {
    const uid = await assignedUid();
    await input.client.setToolchainStatus(uid, artifact.status);
  };
}

export function createRetriableIsolatedToolchainStatusPublication(input: {
  client: Pick<FleetBrokerClient, "uidForSlug" | "setToolchainStatus">;
  builderSlug: string;
}): {
  publishStatus: (artifact: DeveloperToolchainStatusArtifact) => Promise<void>;
  ensureReadyPublished: (artifact: DeveloperToolchainStatusArtifact) => Promise<void>;
} {
  const publishAssigned = createIsolatedToolchainStatusPublisher(input);
  let publishedArtifactKey: string | null = null;
  const artifactKey = (artifact: DeveloperToolchainStatusArtifact): string =>
    `${artifact.schemaVersion}\0${artifact.status}\0${artifact.updatedAt}`;
  const publishStatus = async (artifact: DeveloperToolchainStatusArtifact): Promise<void> => {
    await publishAssigned(artifact);
    publishedArtifactKey = artifactKey(artifact);
  };
  return {
    publishStatus,
    async ensureReadyPublished(artifact) {
      if (publishedArtifactKey === artifactKey(artifact)) return;
      await publishStatus(artifact);
    },
  };
}

export async function probeUserInteractiveReadiness(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function statusArtifact(status: DeveloperToolchainStatusArtifact["status"]): DeveloperToolchainStatusArtifact {
  return { schemaVersion: 1, status, updatedAt: new Date().toISOString() };
}

const abortableSleep = (signal: AbortSignal) => (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export async function runIsolatedToolchainHydrator(input: {
  config: IsolatedToolchainHydratorConfig;
  client?: HydratorBrokerClient;
  signal?: AbortSignal;
  log?: (message: string) => void;
  registryCredentialsProvider?: () => Promise<FleetBrokerNpmRegistryCredentials>;
}): Promise<void> {
  const signal = input.signal ?? new AbortController().signal;
  const log = input.log ?? runtimeLogger.info;
  const client = guardRetiredRuntimeBrokerClient(
    input.client ?? createFleetBrokerClient(input.config.gatewayId),
    log,
  );
  const publication = createRetriableIsolatedToolchainStatusPublication({
    client,
    builderSlug: input.config.builderSlug,
  });
  const publishStatus = publication.publishStatus;
  const registryCredentialsProvider = input.registryCredentialsProvider
    ?? createUserNpmProxyCredentialsProvider({
      client,
      builderSlug: input.config.builderSlug,
    });
  const writeStatus = (status: DeveloperToolchainStatusArtifact["status"]): Promise<void> =>
    writeToolchainStatus(input.config.root, statusArtifact(status), { publishStatus, log });

  await runIsolatedToolchainHydrationLoop({
    probeInteractiveReadiness: () => probeUserInteractiveReadiness(input.config.readinessUrl),
    hydrate: (attempt) => hydrateIsolatedToolchain({
      root: input.config.root,
      preinstalledRoot: input.config.preinstalledRoot,
      cachePath: input.config.cachePath,
      packageJsonPath: input.config.packageJsonPath,
      packageLockPath: input.config.packageLockPath,
      packageLockSha256: input.config.packageLockSha256,
      groupsPath: input.config.groupsPath,
      groupsSha256: input.config.groupsSha256,
      fallbackRegistryUrl: input.config.fallbackRegistryUrl,
      registryCredentialsProvider,
      attempt,
      publishStatus,
      log,
      signal,
    }),
    ensureReadyPublished: async (artifact) => {
      try {
        await publication.ensureReadyPublished(artifact);
      } catch (error) {
        const retired = error instanceof IsolatedToolchainHydrationError &&
          error.reasonCode === ISOLATED_TOOLCHAIN_RUNTIME_RETIRED;
        if (!retired) {
          log(`[isolated-toolchain] ready status publication unavailable; retrying error=${
            error instanceof Error ? error.message : String(error)
          }`);
        }
        throw error;
      }
    },
    writeStatus,
    log,
    sleep: abortableSleep(signal),
    waitForShutdown: () => waitForIsolatedToolchainShutdown(signal),
    shouldStop: () => signal.aborted,
  });
}

export function waitForIsolatedToolchainShutdown(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const keepAlive = setInterval(() => {}, 60_000);
    signal.addEventListener("abort", () => {
      clearInterval(keepAlive);
      resolve();
    }, { once: true });
  });
}

async function main(): Promise<void> {
  const config = resolveIsolatedToolchainHydratorConfig();
  if (!config.gatewayId || !config.builderSlug) {
    throw new Error("GATEWAY_ID and a user claim are required for isolated toolchain hydration");
  }
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  await runIsolatedToolchainHydrator({ config, signal: controller.signal });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    runtimeLogger.error(`[isolated-toolchain] fatal runner error (${error instanceof Error ? error.name : typeof error})`);
    process.exit(1);
  });
}
