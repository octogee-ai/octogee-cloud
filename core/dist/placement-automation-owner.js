import { DEFAULT_PLACEMENT_AUTOMATION_OWNER, } from "./platform-state/config.js";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
export { DEFAULT_PLACEMENT_AUTOMATION_OWNER, PLACEMENT_AUTOMATION_OWNERS, isPlacementAutomationOwner, } from "./platform-state/config.js";
export const PLACEMENT_OWNER_REFUSAL_CODE = "placement-owner";
export class PlacementOwnerRefusedError extends Error {
    ownership;
    code = PLACEMENT_OWNER_REFUSAL_CODE;
    constructor(ownership) {
        super(ownership.owner !== "client"
            ? `placement automation is owned by ${ownership.owner}`
            : "the fleet controller has not yielded placement automation");
        this.ownership = ownership;
        this.name = "PlacementOwnerRefusedError";
    }
}
export function placementAutomationOwnership(config) {
    return {
        owner: config?.placementAutomationOwner ?? DEFAULT_PLACEMENT_AUTOMATION_OWNER,
        yieldedAt: config?.placementAutomationYieldedAt ?? null,
    };
}
export function clientOwnsPlacementAutomation(ownership) {
    return ownership.owner === "client" && ownership.yieldedAt !== null;
}
export async function readPlacementAutomationOwnership(transaction) {
    return placementAutomationOwnership(await transaction.config.orchestrator.get());
}
export async function assertClientOwnsPlacementAutomation(transaction) {
    const ownership = await readPlacementAutomationOwnership(transaction);
    if (!clientOwnsPlacementAutomation(ownership))
        throw new PlacementOwnerRefusedError(ownership);
    return ownership;
}
export function placementOwnerRefusalBody(error) {
    if (error instanceof PlacementOwnerRefusedError)
        return { code: PLACEMENT_OWNER_REFUSAL_CODE, error: error.message };
    if (error instanceof FleetMutationRefusedError)
        return placementOwnerRefusalBody(error.refusal);
    return null;
}
