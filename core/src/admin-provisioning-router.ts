import type { NextFunction, Request, Response, Router } from "express";
import {
  PROVISIONING_CONDITION_REASONS,
  PROVISIONING_WORK_STATES,
  type ProvisioningConditionReason,
  type UserProvisioningListQuery,
} from "@octogee/shared/types/provisioning-service";
import { respondToAdminFleetMutationError, type AdminFleetMutationRunner } from "./admin-fleet-router.js";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { ProvisioningServiceError, type ProvisioningServiceClient } from "./provisioning-service-client.js";

export type AdminProvisioningClient = Pick<
  ProvisioningServiceClient,
  "getProvisioning" | "getProvisioningEvents" | "listProvisionings" | "retryProvisioning"
>;

export interface AdminProvisioningRouterDeps {
  readonly provisioning: AdminProvisioningClient | null;
  readonly journal: AdminFleetMutationRunner;
}

const UNAVAILABLE = "this fleet controller has no provisioning service configured";

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

type ListQuery = { -readonly [K in keyof UserProvisioningListQuery]: UserProvisioningListQuery[K] };
type QueryValue = Request["query"][string];
const LISTED_WORK_STATES = PROVISIONING_WORK_STATES.filter((state) => state !== "idle");

const LIST_QUERY_PARSERS: Record<keyof ListQuery, (value: QueryValue, into: ListQuery) => string | null> = {
  ready: (value, into) => {
    if (value !== "true" && value !== "false") return "ready must be true or false";
    into.ready = value === "true";
    return null;
  },
  reason: (value, into) => {
    if (typeof value !== "string" || !(PROVISIONING_CONDITION_REASONS as readonly string[]).includes(value)) {
      return `reason must be one of ${PROVISIONING_CONDITION_REASONS.join(", ")}`;
    }
    into.reason = value as ProvisioningConditionReason;
    return null;
  },
  workState: (value, into) => {
    if (typeof value !== "string" || !(LISTED_WORK_STATES as readonly string[]).includes(value)) {
      return `workState must be one of ${LISTED_WORK_STATES.join(", ")}`;
    }
    into.workState = value as NonNullable<UserProvisioningListQuery["workState"]>;
    return null;
  },
  limit: (value, into) => {
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return "limit must be an integer from 1 to 500";
    into.limit = limit;
    return null;
  },
  pageToken: (value, into) => {
    if (typeof value !== "string" || value === "") return "pageToken must be a non-empty string";
    into.pageToken = value;
    return null;
  },
};

function parseListQuery(query: Request["query"]): UserProvisioningListQuery | string {
  const parsed: ListQuery = {};
  for (const [name, parse] of Object.entries(LIST_QUERY_PARSERS)) {
    const value = query[name];
    if (value === undefined) continue;
    const error = parse(value, parsed);
    if (error !== null) return error;
  }
  return parsed;
}

function respondToServiceError(error: unknown, req: Request, res: Response, next: NextFunction): void {
  const serviceError = error instanceof FleetMutationRefusedError ? error.refusal : error;
  if (serviceError instanceof ProvisioningServiceError) {
    if (serviceError.status === 409 || serviceError.status === 404) {
      res.status(serviceError.status).json({ code: serviceError.code, error: serviceError.message });
      return;
    }
    res.status(503).json({ code: "unavailable", error: `provisioning service: ${serviceError.message}` });
    return;
  }
  respondToAdminFleetMutationError(error, req, res, next);
}

export function addAdminProvisioningRoutes(router: Router, deps: AdminProvisioningRouterDeps): void {
  const { journal } = deps;

  const requireClient = (res: Response): AdminProvisioningClient | null => {
    if (deps.provisioning === null) res.status(501).json({ code: "unavailable", error: UNAVAILABLE });
    return deps.provisioning;
  };

  router.get("/users/:uid/provisioning", async (req, res, next) => {
    const client = requireClient(res);
    if (client === null) return;
    try {
      const uid = req.params.uid as string;
      const [provisioning, events] = await Promise.all([client.getProvisioning(uid), client.getProvisioningEvents(uid)]);
      if (provisioning === null) {
        res.status(404).json({ code: "not-found", error: "the provisioning service does not manage this user", uid });
        return;
      }
      res.json({ provisioning, events: events?.items ?? [] });
    } catch (error) {
      respondToServiceError(error, req, res, next);
    }
  });

  router.post("/users/:uid/provisioning/retry", async (req, res, next) => {
    const client = requireClient(res);
    if (client === null) return;
    const uid = req.params.uid as string;
    const { expectedAttempts } = (req.body ?? {}) as { expectedAttempts?: unknown };
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
            return await client.retryProvisioning(
              uid,
              expectedAttempts === undefined ? {} : { expectedAttempts },
              claim.externalIdempotencyKey,
            );
          } catch (error) {
            if (error instanceof ProvisioningServiceError && (error.status === 409 || error.status === 404)) {
              throw new FleetMutationRefusedError(error);
            }
            throw error;
          }
        },
        dryRunRefusal: async () => {
          const current = await client.getProvisioning(uid);
          if (current === null) throw new ProvisioningServiceError(404, "not-found", "the provisioning service does not manage this user");
          if (expectedAttempts !== undefined && current.status.work.attempts !== expectedAttempts) {
            throw new ProvisioningServiceError(409, "precondition-failed", `attempts is ${current.status.work.attempts}, expected ${expectedAttempts}`);
          }
          return null;
        },
      });
      res.status(202).json(answer);
    } catch (error) {
      respondToServiceError(error, req, res, next);
    }
  });

  router.get("/provisioning", async (req, res, next) => {
    const client = requireClient(res);
    if (client === null) return;
    const query = parseListQuery(req.query);
    if (typeof query === "string") {
      res.status(400).json({ code: "invalid-request", error: query });
      return;
    }
    try {
      res.json(await client.listProvisionings(query));
    } catch (error) {
      respondToServiceError(error, req, res, next);
    }
  });
}
