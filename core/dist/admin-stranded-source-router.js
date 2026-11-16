import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { PlacementPreconditionFailed } from "./placement-refusal.js";
import { StrandedSourceResumeFailed, readStrandedSource, restoreStrandedSourceServing, } from "./stranded-source-restore.js";
const GATEWAY_ANSWERED_WITH_ERROR = 502;
const GATEWAY_UNREACHABLE = 503;
function refusalOf(error) {
    if (error instanceof FleetMutationRefusedError)
        return refusalOf(error.refusal);
    return error instanceof PlacementPreconditionFailed ? error : null;
}
export function addAdminStrandedSourceRoutes(router, deps) {
    const { store, journal } = deps;
    const clock = deps.now;
    const restoreDeps = {
        store,
        resumeSourceIngress: deps.resumeSourceIngress,
        log: deps.log,
        ...(clock ? { now: () => new Date(clock()) } : {}),
    };
    router.post("/users/:uid/restore-serving", async (req, res, next) => {
        const uid = req.params.uid;
        try {
            if (await store.users.records.get(uid) === null) {
                res.status(404).json({ error: "user not found", uid });
                return;
            }
            const source = await readStrandedSource(store, uid);
            const { gatewayId, operationId: failedMoveId } = source;
            const restored = await journal({
                req,
                what: "restore stranded source to serving",
                why: "a failed move left the source closed",
                target: { uid, gatewayId },
                preActionStatus: { gatewayId, assignmentState: "quiescing", failedMoveId },
                mutation: { kind: "restore-source-serving", uid, gatewayId, failedMoveId },
                action: async (claim) => {
                    try {
                        const { operationId: restoredFrom, ...serving } = await restoreStrandedSourceServing(restoreDeps, { uid });
                        return { ...serving, failedMoveId: restoredFrom, operationId: claim.auditId };
                    }
                    catch (error) {
                        if (error instanceof PlacementPreconditionFailed)
                            throw new FleetMutationRefusedError(error);
                        throw error;
                    }
                },
            });
            res.json(restored);
        }
        catch (error) {
            const refusal = refusalOf(error);
            if (refusal !== null) {
                res.status(409).json({ code: "precondition-failed", error: refusal.message, reasonCode: refusal.reasonCode, uid });
                return;
            }
            if (error instanceof StrandedSourceResumeFailed) {
                res.status(error.gatewayAnswered ? GATEWAY_ANSWERED_WITH_ERROR : GATEWAY_UNREACHABLE).json({
                    code: "source-resume-failed", error: error.message, uid, gatewayId: error.gatewayId, failedMoveId: error.operationId,
                });
                return;
            }
            next(error);
        }
    });
}
