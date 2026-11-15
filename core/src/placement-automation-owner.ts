import {
  DEFAULT_PLACEMENT_AUTOMATION_OWNER,
  type OrchestratorConfig,
  type PlacementAutomationOwner,
} from "./platform-state/config.js";
import type { PlatformStateTransaction } from "./platform-state/store.js";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";

export {
  DEFAULT_PLACEMENT_AUTOMATION_OWNER,
  PLACEMENT_AUTOMATION_OWNERS,
  isPlacementAutomationOwner,
  type PlacementAutomationOwner,
} from "./platform-state/config.js";

export const PLACEMENT_OWNER_REFUSAL_CODE = "placement-owner";

export interface PlacementAutomationOwnership {
  readonly owner: PlacementAutomationOwner;
  readonly yieldedAt: number | null;
}

export type PlacementAutomationActor = "client" | "fleet-controller";

function refusalMessage(ownership: PlacementAutomationOwnership, refused: PlacementAutomationActor): string {
  if (refused === "fleet-controller") return "the fleet controller has yielded placement automation to the client";
  return ownership.owner !== "client"
    ? `placement automation is owned by ${ownership.owner}`
    : "the fleet controller has not yielded placement automation";
}

export class PlacementOwnerRefusedError extends Error {
  readonly code = PLACEMENT_OWNER_REFUSAL_CODE;

  constructor(readonly ownership: PlacementAutomationOwnership, readonly refused: PlacementAutomationActor) {
    super(refusalMessage(ownership, refused));
    this.name = "PlacementOwnerRefusedError";
  }
}

export function placementAutomationOwnership(
  config: Pick<OrchestratorConfig, "placementAutomationOwner" | "placementAutomationYieldedAt"> | null,
): PlacementAutomationOwnership {
  return {
    owner: config?.placementAutomationOwner ?? DEFAULT_PLACEMENT_AUTOMATION_OWNER,
    yieldedAt: config?.placementAutomationYieldedAt ?? null,
  };
}

export function clientOwnsPlacementAutomation(ownership: PlacementAutomationOwnership): boolean {
  return ownership.owner === "client" && ownership.yieldedAt !== null;
}

export function fleetControllerOwnsPlacementAutomation(ownership: PlacementAutomationOwnership): boolean {
  return !clientOwnsPlacementAutomation(ownership);
}

export async function readPlacementAutomationOwnership(
  transaction: Pick<PlatformStateTransaction, "config">,
): Promise<PlacementAutomationOwnership> {
  return placementAutomationOwnership(await transaction.config.orchestrator.get());
}

export async function assertClientOwnsPlacementAutomation(
  transaction: Pick<PlatformStateTransaction, "config">,
): Promise<PlacementAutomationOwnership> {
  const ownership = await readPlacementAutomationOwnership(transaction);
  if (!clientOwnsPlacementAutomation(ownership)) throw new PlacementOwnerRefusedError(ownership, "client");
  return ownership;
}

export async function assertFleetControllerOwnsPlacementAutomation(
  transaction: Pick<PlatformStateTransaction, "config">,
): Promise<PlacementAutomationOwnership> {
  const ownership = await readPlacementAutomationOwnership(transaction);
  if (!fleetControllerOwnsPlacementAutomation(ownership)) throw new PlacementOwnerRefusedError(ownership, "fleet-controller");
  return ownership;
}

export function placementOwnerRefusalBody(error: unknown): { code: typeof PLACEMENT_OWNER_REFUSAL_CODE; error: string } | null {
  if (error instanceof PlacementOwnerRefusedError) return { code: PLACEMENT_OWNER_REFUSAL_CODE, error: error.message };
  if (error instanceof FleetMutationRefusedError) return placementOwnerRefusalBody(error.refusal);
  return null;
}
