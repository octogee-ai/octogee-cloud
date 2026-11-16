import { placementAutomationOwnership, readPlacementAutomationOwnership, requireFleetControllerPlacementOwner, } from "./placement-automation-owner.js";
function placementAutomationPhase(ownership) {
    if (ownership.owner === "fleet-controller")
        return "fleet-controller";
    return ownership.yieldedAt === null ? "handoff-pending" : "client";
}
export function placementAutomationState(ownership) {
    return { owner: ownership.owner, yieldedAt: ownership.yieldedAt, phase: placementAutomationPhase(ownership) };
}
export async function readPlacementAutomationState(store) {
    const ownership = await store.transaction({ label: "placement-automation.read", readOnly: true }, readPlacementAutomationOwnership);
    return placementAutomationState(ownership);
}
export async function setPlacementAutomationOwnerInTransaction(transaction, owner) {
    const stored = await transaction.config.orchestrator.get();
    const previous = placementAutomationOwnership(stored);
    if (previous.owner === owner)
        return { previous, current: previous, changed: false };
    await transaction.config.orchestrator.patch({ placementAutomationOwner: owner, placementAutomationYieldedAt: { clear: true } }, stored === null ? undefined : { revision: stored.revision });
    return { previous, current: { owner, yieldedAt: null }, changed: true };
}
export async function yieldPlacementAutomationInTransaction(transaction, now) {
    const stored = await transaction.config.orchestrator.get();
    const ownership = placementAutomationOwnership(stored);
    if (stored === null || ownership.owner !== "client")
        return { kind: "not-requested", ownership };
    if (ownership.yieldedAt !== null)
        return { kind: "already-yielded", ownership };
    await transaction.config.orchestrator.patch({ placementAutomationYieldedAt: now }, { revision: stored.revision });
    return { kind: "yielded", ownership: { owner: "client", yieldedAt: now } };
}
function passCount(count) {
    return count === 1 ? "1 running pass" : `${count} running passes`;
}
export function createPlacementAutomationGate(deps) {
    let inFlight = 0;
    let lastStartedAt = null;
    async function yieldToClient(ownership) {
        let outcome;
        try {
            outcome = await deps.store.transaction({ label: "placement-automation.yield" }, (transaction) => yieldPlacementAutomationInTransaction(transaction, deps.now()));
        }
        catch (error) {
            deps.warn(`[placement-automation] the fleet controller could not record its yield: ${error instanceof Error ? error.message : String(error)}`);
            return { decides: false, ownership };
        }
        if (outcome.kind === "yielded") {
            deps.log(`[placement-automation] the fleet controller yielded placement automation to the client at ${outcome.ownership.yieldedAt}`);
        }
        return { decides: outcome.ownership.owner === "fleet-controller", ownership: outcome.ownership };
    }
    async function begin() {
        const ownership = await deps.store.transaction({ label: "placement-automation.pass-start", readOnly: true }, readPlacementAutomationOwnership);
        if (ownership.owner === "fleet-controller")
            return { decides: true, ownership };
        if (ownership.yieldedAt !== null)
            return { decides: false, ownership };
        const others = inFlight - 1;
        if (others > 0) {
            deps.log(`[placement-automation] the owner is the client; waiting for ${passCount(others)} to finish before yielding`);
            return { decides: false, ownership };
        }
        return yieldToClient(ownership);
    }
    return {
        async pass(run) {
            inFlight += 1;
            lastStartedAt = deps.now();
            try {
                return await run(await begin());
            }
            finally {
                inFlight -= 1;
            }
        },
        requireOwner: requireFleetControllerPlacementOwner,
        passesInFlight: () => inFlight,
        lastPassStartedAt: () => lastStartedAt,
    };
}
