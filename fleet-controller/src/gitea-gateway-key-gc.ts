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

export interface LiveGatewayOwnerSources {
  gateways: readonly Pick<GatewayRoot, "gatewayId">[];
  fleetRegistry: readonly Pick<FleetRegistryRecord, "gatewayId" | "vm">[];
  readGatewayPodDiagnosticsBatch: (
    gatewayIds: readonly string[],
  ) => Promise<Record<string, GatewayPodDiagnostics>>;
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
  });
}

export type GitKeyHolderService = Pick<ProvisioningServiceClient, "listGitKeyHolders" | "releaseGitKeyHolder">;

export interface DeadGitKeyHolderReleaseDeps {
  keys: GitKeyHolderService;
  mode: GitKeySweepMode;
  minAbsenceMs: number;
  now: () => number;
  log: (message: string) => void;
}

interface Absence {
  passes: number;
  since: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function releaseDeadHolders(live: ReadonlySet<string>, absences: Map<string, Absence>, deps: DeadGitKeyHolderReleaseDeps): Promise<void> {
  let listed: string[];
  try {
    listed = (await deps.keys.listGitKeyHolders()).map((summary) => summary.holder);
  } catch (error) {
    deps.log(`[git-key-holders] ⚠ listing git key holders failed — ${errorText(error)}; releasing none this pass`);
    return;
  }
  const now = deps.now();
  for (const holder of absences.keys()) if (live.has(holder) || !listed.includes(holder)) absences.delete(holder);
  for (const holder of listed.filter((candidate) => !live.has(candidate))) {
    const seen = absences.get(holder);
    const absence = { passes: (seen?.passes ?? 0) + 1, since: seen?.since ?? now };
    absences.set(holder, absence);
    if (absence.passes < 2 || now - absence.since < deps.minAbsenceMs) {
      deps.log(`[git-key-holders] holder ${holder} is absent from the live set since ${new Date(absence.since).toISOString()}; kept until two complete passes have found it absent for ${deps.minAbsenceMs / 60_000} minutes`);
      continue;
    }
    if (deps.mode === "dry-run") {
      deps.log(`[git-key-holders] dry-run: would release git key holder ${holder}, absent since ${new Date(absence.since).toISOString()}`);
      continue;
    }
    try {
      const { remaining } = await deps.keys.releaseGitKeyHolder(holder);
      deps.log(`[git-key-holders] released git key holder ${holder}, absent since ${new Date(absence.since).toISOString()}; ${remaining} rows not yet released from the git host`);
    } catch (error) {
      deps.log(`[git-key-holders] ⚠ releasing git key holder ${holder} failed — ${errorText(error)}; tried again next pass`);
    }
  }
}

export function readLiveKeyHoldersReleasingDead(
  read: () => Promise<GitKeyHolders>,
  deps: DeadGitKeyHolderReleaseDeps,
): () => Promise<GitKeyHolders> {
  const absences = new Map<string, Absence>();
  return async () => {
    let holders: GitKeyHolders;
    try {
      holders = await read();
    } catch (error) {
      deps.log(`[git-key-holders] ⚠ the live set is incomplete, so this pass releases no git key holder — ${errorText(error)}`);
      throw error;
    }
    await releaseDeadHolders(holders.owners, absences, deps);
    return holders;
  };
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
