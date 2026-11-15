export const PLACEMENT_AUTOMATION_OWNERS = ["fleet-controller", "client"];
export const DEFAULT_PLACEMENT_AUTOMATION_OWNER = "fleet-controller";
export function isPlacementAutomationOwner(value) {
    return PLACEMENT_AUTOMATION_OWNERS.includes(value);
}
