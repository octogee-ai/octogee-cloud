import { PROVISIONING_CONDITION_REASONS, PROVISIONING_WORK_STATES, } from "@octogee/shared/types/provisioning-service";
import { respondToAdminFleetMutationError } from "./admin-fleet-router.js";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { isAddressableUid, ProvisioningServiceError } from "./provisioning-service-client.js";
const UNAVAILABLE = "this fleet controller has no provisioning service configured";
const SERVICE_FAILED = "the provisioning service did not answer; see the fleet controller log";
export const ADMIN_PROVISIONING_READ_DEADLINE_MS = 5_000;
function withDeadline(work, ms) {
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new ProvisioningServiceError(0, "unreachable", `no answer within ${ms} ms`));
            controller.abort();
        }, ms);
    });
    return Promise.race([work(controller.signal), expired]).finally(() => clearTimeout(timer));
}
function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
const LISTED_WORK_STATES = PROVISIONING_WORK_STATES.filter((state) => state !== "idle");
const LIST_QUERY_PARSERS = {
    ready: (value, into) => {
        if (value !== "true" && value !== "false")
            return "ready must be true or false";
        into.ready = value === "true";
        return null;
    },
    reason: (value, into) => {
        if (typeof value !== "string" || !PROVISIONING_CONDITION_REASONS.includes(value)) {
            return `reason must be one of ${PROVISIONING_CONDITION_REASONS.join(", ")}`;
        }
        into.reason = value;
        return null;
    },
    workState: (value, into) => {
        if (typeof value !== "string" || !LISTED_WORK_STATES.includes(value)) {
            return `workState must be one of ${LISTED_WORK_STATES.join(", ")}`;
        }
        into.workState = value;
        return null;
    },
    limit: (value, into) => {
        const limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
            return "limit must be an integer from 1 to 500";
        into.limit = limit;
        return null;
    },
    pageToken: (value, into) => {
        if (typeof value !== "string" || value === "")
            return "pageToken must be a non-empty string";
        into.pageToken = value;
        return null;
    },
};
function parseListQuery(query) {
    const parsed = {};
    for (const [name, parse] of Object.entries(LIST_QUERY_PARSERS)) {
        const value = query[name];
        if (value === undefined)
            continue;
        const error = parse(value, parsed);
        if (error !== null)
            return error;
    }
    return parsed;
}
export function addAdminProvisioningRoutes(router, deps) {
    const { journal } = deps;
    const deadline = deps.readDeadlineMs ?? ADMIN_PROVISIONING_READ_DEADLINE_MS;
    const respondToServiceError = (error, req, res, next) => {
        const serviceError = error instanceof FleetMutationRefusedError ? error.refusal : error;
        if (serviceError instanceof ProvisioningServiceError) {
            if (serviceError.status === 409 || serviceError.status === 404) {
                res.status(serviceError.status).json({ code: serviceError.code, error: serviceError.message });
                return;
            }
            deps.logger.warn("provisioning service request failed", { route: req.path, status: serviceError.status, code: serviceError.code, error: serviceError.message });
            res.status(503).json({ code: "unavailable", error: SERVICE_FAILED });
            return;
        }
        respondToAdminFleetMutationError(error, req, res, next);
    };
    const requireUid = (req, res) => {
        const uid = req.params.uid;
        if (isAddressableUid(uid))
            return uid;
        res.status(400).json({ code: "invalid-request", error: "an empty or dot-segment uid cannot name a URL path segment" });
        return null;
    };
    const requireClient = (res) => {
        if (deps.provisioning === null)
            res.status(501).json({ code: "unavailable", error: UNAVAILABLE });
        return deps.provisioning;
    };
    router.get("/users/:uid/provisioning", async (req, res, next) => {
        const client = requireClient(res);
        if (client === null)
            return;
        const uid = requireUid(req, res);
        if (uid === null)
            return;
        try {
            const [provisioning, events] = await withDeadline((signal) => Promise.all([client.getProvisioning(uid, { signal }), client.getProvisioningEvents(uid, { signal })]), deadline);
            if (provisioning === null) {
                res.status(404).json({ code: "not-found", error: "the provisioning service does not manage this user", uid });
                return;
            }
            res.json({ provisioning, events: events?.items ?? [] });
        }
        catch (error) {
            respondToServiceError(error, req, res, next);
        }
    });
    router.post("/users/:uid/provisioning/retry", async (req, res, next) => {
        const client = requireClient(res);
        if (client === null)
            return;
        const uid = requireUid(req, res);
        if (uid === null)
            return;
        const { expectedAttempts } = (req.body ?? {});
        if (expectedAttempts !== undefined && !isNonNegativeInteger(expectedAttempts)) {
            res.status(400).json({ code: "invalid-request", error: "expectedAttempts must be a non-negative integer" });
            return;
        }
        try {
            const answer = await journal({
                req,
                what: "retry user provisioning",
                why: "operator asked the provisioning service to retry now",
                target: { uid },
                preActionStatus: expectedAttempts === undefined ? {} : { attempts: expectedAttempts },
                mutation: { kind: "retry-user-provisioning", uid, ...(expectedAttempts === undefined ? {} : { expectedAttempts }) },
                action: async (claim) => {
                    try {
                        return await client.retryProvisioning(uid, expectedAttempts === undefined ? {} : { expectedAttempts }, claim.externalIdempotencyKey);
                    }
                    catch (error) {
                        if (error instanceof ProvisioningServiceError && (error.status === 409 || error.status === 404)) {
                            throw new FleetMutationRefusedError(error);
                        }
                        throw error;
                    }
                },
                dryRunRefusal: async () => {
                    const current = await withDeadline((signal) => client.getProvisioning(uid, { signal }), deadline);
                    if (current === null)
                        throw new ProvisioningServiceError(404, "not-found", "the provisioning service does not manage this user");
                    if (expectedAttempts !== undefined && current.status.work.attempts !== expectedAttempts) {
                        throw new ProvisioningServiceError(409, "precondition-failed", `attempts is ${current.status.work.attempts}, expected ${expectedAttempts}`);
                    }
                    return null;
                },
            });
            res.status(202).json(answer);
        }
        catch (error) {
            respondToServiceError(error, req, res, next);
        }
    });
    router.get("/provisioning", async (req, res, next) => {
        const client = requireClient(res);
        if (client === null)
            return;
        const query = parseListQuery(req.query);
        if (typeof query === "string") {
            res.status(400).json({ code: "invalid-request", error: query });
            return;
        }
        try {
            const listed = await withDeadline((signal) => client.listProvisionings(query, { signal }), deadline);
            res.json({ ...listed, specWriteFailures: deps.sync?.specFailures() ?? [], mirrorRefusals: deps.sync?.mirrorRefusals() ?? [] });
        }
        catch (error) {
            respondToServiceError(error, req, res, next);
        }
    });
}
