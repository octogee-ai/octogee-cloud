import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { isPlacementAutomationOwner } from "./placement-automation-owner.js";
import { placementAutomationState, readPlacementAutomationState, setPlacementAutomationOwnerInTransaction, } from "./placement-automation-handoff.js";
import { FenceMismatchError } from "./platform-state/errors.js";
const OWNER_REQUIRED = "owner must be fleet-controller or client";
const NEXT_PASS = {
    client: "the fleet controller yields on its next pass",
    "fleet-controller": "the fleet controller resumes on its next pass",
};
function preconditionBody(error) {
    if (error instanceof FleetMutationRefusedError)
        return preconditionBody(error.refusal);
    if (error instanceof FenceMismatchError)
        return { code: "precondition-failed", error: error.message };
    return null;
}
async function settle(res, run) {
    try {
        res.json(await run());
    }
    catch (error) {
        const body = preconditionBody(error);
        if (body === null)
            throw error;
        res.status(409).json(body);
    }
}
function actorOf(req) {
    return req.uid ?? "unknown";
}
async function setOwner(req, res, deps) {
    const owner = req.body?.owner;
    if (!isPlacementAutomationOwner(owner)) {
        res.status(400).json({ error: OWNER_REQUIRED });
        return;
    }
    const before = await readPlacementAutomationState(deps.store);
    await settle(res, async () => {
        const change = await deps.journal({
            req,
            what: "set placement automation owner",
            why: owner === "client" ? "hand placement automation to the client" : "hand placement automation back to the fleet controller",
            target: { setting: "placementAutomationOwner" },
            preActionStatus: { ...before },
            mutation: { kind: "set-placement-automation-owner", owner },
            dryRunRefusal: async () => null,
            action: async () => {
                try {
                    return await deps.store.transaction({ label: "admin.placement-automation.set-owner" }, (transaction) => setPlacementAutomationOwnerInTransaction(transaction, owner));
                }
                catch (error) {
                    if (error instanceof FenceMismatchError)
                        throw new FleetMutationRefusedError(error);
                    throw error;
                }
            },
        });
        if (change.changed) {
            deps.log(`[placement-automation] owner set from ${change.previous.owner} to ${owner} by ${actorOf(req)}; ${NEXT_PASS[owner]}`);
        }
        return placementAutomationState(change.current);
    });
}
export function addAdminPlacementOwnerRoutes(router, deps) {
    router.get("/placement-automation", async (_req, res, next) => {
        try {
            res.json(await readPlacementAutomationState(deps.store));
        }
        catch (error) {
            next(error);
        }
    });
    router.post("/placement-automation/owner", async (req, res, next) => {
        try {
            await setOwner(req, res, deps);
        }
        catch (error) {
            next(error);
        }
    });
}
