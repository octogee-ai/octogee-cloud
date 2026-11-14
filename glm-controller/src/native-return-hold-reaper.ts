import { isDeepStrictEqual } from "node:util";
import type {
  PlatformUserRecord,
  FleetRegistryRecord,
  FleetRegistryVmHome,
  GatewayRoot,
  OperationRecord,
  PlatformStateStore,
  Stored,
} from "@octogee/core/platform-state";
import type { OperationStatus } from "@octogee/shared/types/glm";
import type { GatewayVmClient } from "./lib/compute-vm.js";
import { nativeReturnSourceIdentity, nativeReturnSourceStopped } from "./lib/native-return-source-fence.js";
import type { FleetInformer } from "./fleet-informer.js";
import { OPERATION_JOURNAL_RETENTION_MS } from "./operation-retry.js";

export const NATIVE_RETURN_HOLD_REAPER_CREATOR = "glm-controller-native-return-hold-reaper";

export interface NativeReturnHoldReaperDeps {
  store: PlatformStateStore;
  informer: Pick<FleetInformer, "fleetRegistry">;
  vm: Pick<GatewayVmClient, "describe">;
  log: (msg: string) => void;
  now: () => number;
}

export interface NativeReturnHoldReaperResult {
  scanned: number;
  released: number;
}

type ReturnOperationStatus = OperationStatus | "missing";

interface HoldCandidate {
  gatewayId: string;
  returnOperationId: string | null;
}

interface HoldAuthority {
  runtime: Stored<FleetRegistryRecord> | null;
  operation: Stored<OperationRecord> | null;
  desired: Stored<GatewayRoot> | null;
  owner: Stored<PlatformUserRecord> | null;
}

const TERMINAL: ReadonlySet<ReturnOperationStatus> = new Set(["succeeded", "failed", "rolled-back", "missing"]);

function heldReturnOperationId(home: unknown): string | null {
  if (!home || typeof home !== "object") return null;
  const id = (home as Record<string, unknown>).returnOperationId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function returnOperationStatus(operationId: string, operation: Stored<OperationRecord> | null): ReturnOperationStatus {
  if (operation === null) return "missing";
  const status: unknown = operation.status;
  if (typeof status !== "string") {
    throw new Error(`return operation ${operationId} has a malformed status (${String(status)}); hold retained`);
  }
  return status as OperationStatus;
}

function releaseJournalId(gatewayId: string, returnOperationId: string): string {
  return `native-return-hold-release-${gatewayId}-${returnOperationId}`;
}

function releasedHome(home: FleetRegistryVmHome | undefined): FleetRegistryVmHome {
  const { returnOperationId: _returnOperationId, checkpointRequestedAt: _checkpointRequestedAt, parkRequestedAt: _parkRequestedAt, ...rest } = home ?? {};
  return rest;
}

function rollbackStillOwnsSource(authority: HoldAuthority, desired: Stored<GatewayRoot>, gatewayId: string): boolean {
  const { runtime, operation: op, owner } = authority;
  return [runtime?.runtime === "gce-vm", ["failed", "rolled-back"].includes(op?.status ?? ""), op?.kind === "migrate-user",
    op?.cutoverCommittedAt === undefined, op?.input?.uid === desired.ownerUid, op?.input?.fromGatewayId === gatewayId,
    owner?.gateway?.gatewayId === gatewayId, desired.desiredStatus === "running"].every(Boolean);
}

async function releaseTerminalHold(
  deps: NativeReturnHoldReaperDeps,
  gatewayId: string,
  returnOperationId: string,
): Promise<ReturnOperationStatus | null> {
  const journalId = releaseJournalId(gatewayId, returnOperationId);
  const [runtime, operation, desired] = await Promise.all([
    deps.store.fleetRegistry.get(gatewayId),
    deps.store.journal.operations.get(returnOperationId),
    deps.store.gateways.roots.get(gatewayId),
  ]);
  if (heldReturnOperationId(runtime?.vmHome) !== returnOperationId || !TERMINAL.has(returnOperationStatus(returnOperationId, operation))) return null;
  if (desired?.gatewayClass !== "isolated" || typeof desired.ownerUid !== "string") throw new Error("source ownership unavailable; hold retained");
  const ownerUid = desired.ownerUid;
  const authority: HoldAuthority = { runtime, operation, desired, owner: await deps.store.users.records.get(ownerUid) };
  if (!rollbackStillOwnsSource(authority, desired, gatewayId)) {
    const identity = nativeReturnSourceIdentity(runtime ?? undefined, desired);
    if (!identity || !await nativeReturnSourceStopped(deps.vm, identity)) throw new Error("exact source is not stopped or absent; hold retained");
  }
  return deps.store.transaction({ label: "native-return-hold-reaper.release" }, async (tx) => {
    const [current, journal] = await Promise.all([
      Promise.all([
        tx.fleetRegistry.get(gatewayId),
        tx.journal.operations.get(returnOperationId),
        tx.gateways.roots.get(gatewayId),
        tx.users.records.get(ownerUid),
      ]).then(([runtime, operation, desired, owner]): HoldAuthority => ({ runtime, operation, desired, owner })),
      tx.journal.operations.get(journalId),
    ]);
    if (!isDeepStrictEqual(current, authority) || current.runtime === null) return null;
    const status = returnOperationStatus(returnOperationId, current.operation);
    if (!TERMINAL.has(status)) return null;
    const now = deps.now();
    await tx.fleetRegistry.patch(gatewayId, { vmHome: releasedHome(current.runtime.vmHome) }, { revision: current.runtime.revision });
    if (journal === null) {
      await tx.journal.operations.create({
        id: journalId,
        kind: "migrate-user",
        status: "succeeded",
        origin: "automatic",
        createdBy: NATIVE_RETURN_HOLD_REAPER_CREATOR,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        lastProgressAt: now,
        expireAt: now + OPERATION_JOURNAL_RETENTION_MS,
        gatewayId,
        input: { gatewayId, returnOperationId, returnOperationStatus: status },
        output: { released: true },
        steps: [],
      });
    }
    return status;
  });
}

async function holdCandidates(deps: NativeReturnHoldReaperDeps): Promise<HoldCandidate[]> {
  const records = deps.informer.fleetRegistry() ?? await deps.store.fleetRegistry.list();
  return records.map((record) => ({
    gatewayId: record.gatewayId,
    returnOperationId: heldReturnOperationId(record.vmHome),
  }));
}

export async function runNativeReturnHoldReaperTick(
  deps: NativeReturnHoldReaperDeps,
): Promise<NativeReturnHoldReaperResult> {
  const candidates = await holdCandidates(deps);
  let released = 0;
  for (const { gatewayId, returnOperationId } of candidates) {
    if (returnOperationId === null) continue;
    try {
      const status = await releaseTerminalHold(deps, gatewayId, returnOperationId);
      if (status === null) continue;
      released += 1;
      deps.log(
        `[native-return-hold-reaper] ⚠ released the native return hold on ${gatewayId}: ` +
        `return operation ${returnOperationId} is ${status} and never released it`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[native-return-hold-reaper] ⚠ ${gatewayId}: hold for ${returnOperationId} not released — ${message}`);
    }
  }
  return { scanned: candidates.length, released };
}

export interface StartNativeReturnHoldReaperDeps extends NativeReturnHoldReaperDeps {
  intervalMs: number;
  runTick?: (deps: NativeReturnHoldReaperDeps) => Promise<NativeReturnHoldReaperResult>;
}

export function startNativeReturnHoldReaper(deps: StartNativeReturnHoldReaperDeps): () => void {
  const tick = deps.runTick ?? runNativeReturnHoldReaperTick;
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    (async () => {
      try {
        await tick(deps);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log(`[native-return-hold-reaper] ⚠ tick failed — ${message}`);
      } finally {
        running = false;
      }
    })();
  }, deps.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
