import { gatewayKeyOwnerId } from "@octogee/core/gitea-naming";
import { podBelongsToGateway } from "@octogee/core/gateway-live-release";
import {
  createGitKeySweepState,
  type GitKeyHolders,
  type GitKeySweepInput,
  type GitKeySweepMode,
  type ManagedGitHost,
} from "@octogee/core/git-host";
import type { FleetRegistryRecord, GatewayRoot, PlatformStateStore } from "@octogee/core/platform-state";
import type { ProvisioningServiceClient } from "@octogee/core/provisioning-service-client";
import type { FleetInformer } from "./fleet-informer.js";
import { gatewayVmPodName } from "@octogee/shared/types/glm";

import type { GatewayPodDiagnostics } from "./lib/kube-ops.js";

export function parseGiteaGatewayKeyGcMode(
  raw: string | undefined,
  envName = "GITEA_GATEWAY_KEY_GC_MODE",
): GitKeySweepMode {
  if (raw === "dry-run" || raw === "enforce") return raw;
  throw new Error(`${envName} must be dry-run or enforce (got ${raw ?? "<unset>"})`);
}

export type RetiredGatewayKeyRelease = Pick<ProvisioningServiceClient, "releaseGatewayGitKeys">;

export interface LiveGatewayOwnerSources {
  gateways: readonly Pick<GatewayRoot, "gatewayId" | "desiredStatus">[];
  fleetRegistry: readonly Pick<FleetRegistryRecord, "gatewayId" | "vm">[];
  readGatewayPodDiagnosticsBatch: (
    gatewayIds: readonly string[],
  ) => Promise<Record<string, GatewayPodDiagnostics>>;
  retiredGatewayKeys: RetiredGatewayKeyRelease | null;
  log: (message: string) => void;
}

async function retiredGatewaysWithoutKeys(sources: LiveGatewayOwnerSources): Promise<Set<string>> {
  const released = new Set<string>();
  const { retiredGatewayKeys, log } = sources;
  if (retiredGatewayKeys === null) return released;
  for (const { gatewayId } of sources.gateways.filter((gateway) => gateway.desiredStatus === "retired")) {
    try {
      const { remaining } = await retiredGatewayKeys.releaseGatewayGitKeys(gatewayId);
      if (remaining === 0) released.add(gatewayId);
      else log(`[gitea-key-gc] retired gateway ${gatewayId}: the provisioning service still holds ${remaining} git key rows, so its own id stays a live holder`);
    } catch (err) {
      log(`[gitea-key-gc] ⚠ retired gateway ${gatewayId}: releasing its git keys failed — ${err instanceof Error ? err.message : String(err)}; its own id stays a live holder`);
    }
  }
  return released;
}

function vmOwner(record: Pick<FleetRegistryRecord, "gatewayId" | "vm">): { gatewayId: string; owner: string } | null {
  const instanceId = record.vm?.instanceId;
  if (typeof instanceId !== "string" || !/^\d+$/u.test(instanceId)) return null;
  return { gatewayId: record.gatewayId, owner: gatewayKeyOwnerId(record.gatewayId, gatewayVmPodName(record.gatewayId, instanceId)) };
}

async function readOwnersByGateway(sources: LiveGatewayOwnerSources): Promise<Map<string, Set<string>>> {
  const ids = [...new Set([...sources.gateways, ...sources.fleetRegistry].map((record) => record.gatewayId))].sort();
  const diagnostics = await sources.readGatewayPodDiagnosticsBatch(ids);
  const ownersByGateway = new Map<string, Set<string>>();
  const addOwner = (gatewayId: string, owner: string) => {
    const owners = ownersByGateway.get(gatewayId) ?? new Set<string>();
    owners.add(owner);
    ownersByGateway.set(gatewayId, owners);
  };
  for (const instanceId of ids) {
    const observed = diagnostics[instanceId];
    if (!observed || observed.status === "unknown") {
      throw new Error(
        `gateway pod liveness is unknown for ${instanceId}: ${observed?.error ?? "not observed"}`,
      );
    }
    for (const pod of observed.pods) {
      for (const gatewayId of ids) {
        if (podBelongsToGateway(gatewayId, pod.name)) addOwner(gatewayId, gatewayKeyOwnerId(gatewayId, pod.name));
      }
    }
  }
  for (const record of sources.fleetRegistry) {
    const vm = vmOwner(record);
    if (vm) addOwner(vm.gatewayId, vm.owner);
  }
  const released = await retiredGatewaysWithoutKeys(sources);
  for (const gatewayId of ids) if (!released.has(gatewayId)) addOwner(gatewayId, gatewayId);
  return ownersByGateway;
}

export async function readLiveGatewayKeyHolders(sources: LiveGatewayOwnerSources): Promise<GitKeyHolders> {
  const ownersByGateway = await readOwnersByGateway(sources);
  return { owners: new Set([...ownersByGateway.values()].flatMap((held) => [...held])) };
}

export interface FleetKeyHolderSources {
  informer: Pick<FleetInformer, "gateways" | "fleetRegistry">;
  store: Pick<PlatformStateStore, "gateways" | "fleetRegistry">;
  readGatewayPodDiagnosticsBatch: LiveGatewayOwnerSources["readGatewayPodDiagnosticsBatch"];
  retiredGatewayKeys: LiveGatewayOwnerSources["retiredGatewayKeys"];
  log: LiveGatewayOwnerSources["log"];
}

export async function readFleetLiveKeyHolders(sources: FleetKeyHolderSources): Promise<GitKeyHolders> {
  const [gateways, fleetRegistry] = await Promise.all([
    sources.informer.gateways() ?? sources.store.gateways.roots.list(),
    sources.informer.fleetRegistry() ?? sources.store.fleetRegistry.list(),
  ]);
  return readLiveGatewayKeyHolders({
    gateways,
    fleetRegistry,
    readGatewayPodDiagnosticsBatch: sources.readGatewayPodDiagnosticsBatch,
    retiredGatewayKeys: sources.retiredGatewayKeys,
    log: sources.log,
  });
}

export interface StartGiteaGatewayKeyGcDeps extends GitKeySweepInput {
  git: Pick<ManagedGitHost, "sweepKeys">;
  intervalMs: number;
}

export function startGiteaGatewayKeyGc(deps: StartGiteaGatewayKeyGcDeps): () => void {
  const { git, intervalMs, ...input } = deps;
  const state = createGitKeySweepState();
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    (async () => {
      try {
        await git.sweepKeys(input, state);
      } catch (err) {
        deps.log(`[gitea-key-gc] ⚠ tick failed — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        running = false;
      }
    })();
  }, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
