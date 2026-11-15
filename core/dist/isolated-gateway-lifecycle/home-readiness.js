import { IsolatedGatewayFenceError } from "./inputs.js";
export function sizingProfileNeedsVmHome(profile) {
    return profile?.isolation === "isolated" && profile.computer.runtime === "gce-vm";
}
function storedPreparation(user) {
    const migration = user.home.homeMigration;
    if (migration?.phase !== "complete")
        return null;
    const preparedFor = migration.preparedFor;
    return preparedFor !== null && typeof preparedFor === "object" ? preparedFor : null;
}
export function homePreparedForAllocation(input) {
    if (!sizingProfileNeedsVmHome(input.sizingProfile))
        return true;
    const prepared = storedPreparation(input.user);
    return prepared?.leaseId === input.request.leaseId &&
        prepared.generation === input.request.generation &&
        prepared.sizingKey === input.request.sizingKey;
}
export const requireStoredHomeReadiness = (input) => {
    if (homePreparedForAllocation(input))
        return;
    const { uid, leaseId, generation, sizingKey } = input.request;
    throw new IsolatedGatewayFenceError(`home for ${uid} is not prepared for lease ${leaseId} generation ${generation} sizing key ${sizingKey}`);
};
export const homePreparedBeforeAllocation = () => undefined;
