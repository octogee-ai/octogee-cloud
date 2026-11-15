import express, { type NextFunction, type Request, type Response } from "express";
import {
  PROVISIONING_CONDITION_REASONS,
  PROVISIONING_CREDENTIAL_NAMES,
  type ProvisioningConditionReason,
  type ProvisioningCredentialName,
  type ProvisioningEventsResponse,
  type UserProvisioning,
  type UserProvisioningListQuery,
  type UserProvisioningWatchResponse,
} from "@octogee/shared/types/provisioning-service";
import { authenticate, requireRole } from "../auth/authenticate.js";
import type { Reviewer } from "../auth/token-review.js";
import type { CredentialStore } from "../hosts/credential-store.js";
import type { Logger } from "../logger.js";
import type { Metrics } from "../metrics.js";
import { parseGitKeySpec, parseUserProvisioningSpec, validIdentifier } from "../resources/validate.js";
import type { ChangeNotifier } from "../store/change-notifier.js";
import type { ProvisioningStore } from "../store/provisioning-store.js";
import type { WorkQueue } from "../worker/queue.js";
import { callerRequestLimit, callerWaitLimit, type CallerLimits } from "./caller-limits.js";
import { ApiError, sendError } from "./errors.js";
import type { ProbeState } from "./probes.js";

export interface AppDependencies {
  store: ProvisioningStore;
  queue: WorkQueue;
  credentials: CredentialStore;
  notifier: ChangeNotifier;
  reviewer: Reviewer;
  callerNamespace: string;
  roleTable: Parameters<typeof authenticate>[0]["roleTable"];
  metrics: Metrics;
  log: Logger;
  limits: CallerLimits;
  probes: ProbeState;
}

const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 300;
const MAX_PAGE = 500;
const WRITE_STATUS = { created: 201, changed: 202, unchanged: 200 } as const;
const INVALID = "invalid-request";
const WORK_STATE_FILTERS = new Set(["queued", "running", "retrying", "parked"]);

function single(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ApiError(400, INVALID, `${name} must be given once`);
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number | undefined {
  const text = single(value, name);
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) throw new ApiError(400, INVALID, `${name} must be a whole number`);
  const parsed = Number(text);
  if (parsed < min || parsed > max) throw new ApiError(400, INVALID, `${name} must be between ${min} and ${max}`);
  return parsed;
}

function boolean(value: unknown, name: string): boolean | undefined {
  const text = single(value, name);
  if (text === undefined) return undefined;
  if (text !== "true" && text !== "false") throw new ApiError(400, INVALID, `${name} must be true or false`);
  return text === "true";
}

function deadline(request: Request): number {
  return Date.now() + (integer(request.query.timeoutSeconds, "timeoutSeconds", 0, MAX_WAIT_SECONDS) ?? DEFAULT_WAIT_SECONDS) * 1_000;
}

function closedSignal(request: Request, response: Response): AbortSignal {
  const controller = new AbortController();
  response.on("close", () => controller.abort());
  request.on("aborted", () => controller.abort());
  return controller.signal;
}

export function createApp(deps: AppDependencies): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "extended");

  app.get("/healthz", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/readyz", (_request, response) => {
    response.status(deps.probes.ready ? 200 : 503).json({ ok: deps.probes.ready });
  });

  app.get("/metrics", (_request, response) => {
    const { snapshot } = deps.probes;
    if (!snapshot) {
      response.status(503).type("text/plain").send("# no work snapshot yet\n");
      return;
    }
    response.type("text/plain; version=0.0.4").send(deps.metrics.render(snapshot));
  });

  const v1 = express.Router();
  v1.use(authenticate({ reviewer: deps.reviewer, namespace: deps.callerNamespace, roleTable: deps.roleTable, log: deps.log }));
  v1.use(callerRequestLimit({ requestsPerMinute: deps.limits.requestsPerMinute, log: deps.log }));
  v1.use(express.json({ limit: "64kb" }));
  const waitLimit = callerWaitLimit({
    concurrentWaits: deps.limits.concurrentWaits,
    log: deps.log,
    holds: (request) => request.query.waitForGeneration !== undefined || request.query.watch === "true",
  });

  const uidOf = (request: Request) => validIdentifier(String(request.params.uid), "uid");

  v1.put("/users/:uid/provisioning", requireRole("writer"), async (request, response) => {
    const uid = uidOf(request);
    const body = (request.body ?? {}) as { spec?: unknown; expectedResourceVersion?: unknown };
    const spec = parseUserProvisioningSpec(body.spec);
    const expected = body.expectedResourceVersion;
    if (expected !== undefined && (typeof expected !== "string" || !/^\d+$/.test(expected))) {
      throw new ApiError(400, INVALID, "expectedResourceVersion must be a resource version string");
    }
    const { outcome, resource } = await deps.store.put(uid, spec, expected);
    deps.notifier.wakeAll();
    response.status(WRITE_STATUS[outcome]).json(resource);
  });

  v1.get("/users/:uid/provisioning", requireRole("writer", "reader"), waitLimit, async (request, response) => {
    const uid = uidOf(request);
    const waitFor = integer(request.query.waitForGeneration, "waitForGeneration", 1, Number.MAX_SAFE_INTEGER);
    const until = waitFor === undefined ? 0 : deadline(request);
    const signal = closedSignal(request, response);
    for (;;) {
      const resource = await deps.store.get(uid);
      if (!resource) throw new ApiError(404, "not-found", "no provisioning for this user");
      const settled = waitFor === undefined
        || resource.status.observedGeneration >= waitFor
        || resource.status.work.state === "parked"
        || Date.now() >= until
        || signal.aborted;
      if (settled) {
        response.json(resource);
        return;
      }
      await deps.notifier.wait(until - Date.now(), signal);
    }
  });

  v1.delete("/users/:uid/provisioning", requireRole("writer"), async (request, response) => {
    await deps.store.delete(uidOf(request));
    deps.notifier.wakeAll();
    response.status(204).end();
  });

  v1.post("/users/:uid/provisioning/retry", requireRole("writer"), async (request, response) => {
    const uid = uidOf(request);
    const body = (request.body ?? {}) as { expectedAttempts?: unknown };
    const expected = body.expectedAttempts;
    if (expected !== undefined && (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0)) {
      throw new ApiError(400, INVALID, "expectedAttempts must be a whole number");
    }
    const key = request.header("idempotency-key");
    if (key !== undefined && (key.length === 0 || key.length > 200)) throw new ApiError(400, INVALID, "Idempotency-Key must be 1 to 200 characters");
    const outcome = await deps.store.retry(uid, expected, key);
    deps.notifier.wakeAll();
    if (outcome.kind === "replayed") response.status(outcome.status).json(outcome.body);
    else response.status(202).json(outcome.resource);
  });

  v1.get("/users/:uid/provisioning/events", requireRole("writer", "reader"), async (request, response) => {
    const items = await deps.store.events(uidOf(request));
    if (!items) throw new ApiError(404, "not-found", "no provisioning for this user");
    response.json({ items } satisfies ProvisioningEventsResponse);
  });

  const watch = async (request: Request, response: Response): Promise<void> => {
    const from = single(request.query.resourceVersion, "resourceVersion");
    if (from === undefined || !/^\d+$/.test(from)) throw new ApiError(400, INVALID, "watch needs resourceVersion");
    const limit = integer(request.query.limit, "limit", 1, MAX_PAGE) ?? MAX_PAGE;
    const until = deadline(request);
    const signal = closedSignal(request, response);
    for (;;) {
      const changes = await deps.store.changesSince(BigInt(from), limit);
      if (changes.kind === "expired") throw new ApiError(410, "resource-version-expired", "resourceVersion is outside the retained change window; list again");
      const changed = changes.items.length > 0 || changes.deleted.length > 0;
      if (changed || Date.now() >= until || signal.aborted) {
        response.json({
          items: changes.items,
          ...(changes.deleted.length > 0 ? { deleted: changes.deleted } : {}),
          resourceVersion: changes.resourceVersion,
        } satisfies UserProvisioningWatchResponse);
        return;
      }
      await deps.notifier.wait(until - Date.now(), signal);
    }
  };

  v1.get("/provisionings", requireRole("writer", "reader"), waitLimit, async (request, response) => {
    if (boolean(request.query.watch, "watch")) return watch(request, response);
    const reason = single(request.query.reason, "reason");
    if (reason !== undefined && !PROVISIONING_CONDITION_REASONS.includes(reason as ProvisioningConditionReason)) {
      throw new ApiError(400, INVALID, "reason is not a known reason");
    }
    const workState = single(request.query.workState, "workState");
    if (workState !== undefined && !WORK_STATE_FILTERS.has(workState)) throw new ApiError(400, INVALID, "workState is not a filterable state");
    const query: UserProvisioningListQuery = {
      ready: boolean(request.query.ready, "ready"),
      reason: reason as ProvisioningConditionReason | undefined,
      workState: workState as UserProvisioningListQuery["workState"],
      limit: integer(request.query.limit, "limit", 1, MAX_PAGE),
      pageToken: single(request.query.pageToken, "pageToken"),
    };
    response.json(await deps.store.list(query));
  });

  v1.put("/users/:uid/git-keys/:gatewayId", requireRole("key-writer"), async (request, response) => {
    const uid = uidOf(request);
    const gatewayId = validIdentifier(String(request.params.gatewayId), "gatewayId");
    const spec = parseGitKeySpec(((request.body ?? {}) as { spec?: unknown }).spec);
    const { outcome, key } = await deps.store.putGitKey(uid, gatewayId, spec);
    deps.notifier.wakeAll();
    response.status(WRITE_STATUS[outcome]).json(key);
  });

  v1.delete("/users/:uid/git-keys/:gatewayId", requireRole("key-writer"), async (request, response) => {
    await deps.store.deleteGitKey(uidOf(request), validIdentifier(String(request.params.gatewayId), "gatewayId"));
    deps.notifier.wakeAll();
    response.status(202).end();
  });

  v1.get("/users/:uid/credentials/:name", requireRole("credential-reader"), async (request, response) => {
    const uid = uidOf(request);
    const name = String(request.params.name);
    response.setHeader("Cache-Control", "no-store");
    if (!PROVISIONING_CREDENTIAL_NAMES.includes(name as ProvisioningCredentialName)) throw new ApiError(404, "not-found", "unknown credential name");
    const credential = await deps.credentials.read(uid, name as ProvisioningCredentialName);
    if (credential) {
      response.json(credential);
      return;
    }
    if (!(await deps.store.get(uid))) throw new ApiError(404, "not-found", "no provisioning for this user");
    throw new ApiError(409, "not-issued", "this credential has not been issued yet");
  });

  v1.use((_request, _response) => {
    throw new ApiError(404, "not-found", "no such route");
  });

  app.use("/v1", v1);
  app.use((_request, response) => sendError(response, 404, "not-found", "no such route"));

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) {
      deps.log.error("request failed after the response started", { path: request.path, error: error instanceof Error ? error.message : String(error) });
      response.end();
      return;
    }
    if (error instanceof ApiError) return sendError(response, error.status, error.code, error.message);
    const status = (error as { status?: unknown; type?: unknown }).status;
    if (status === 400 || status === 413 || (error as { type?: unknown }).type === "entity.parse.failed") {
      return sendError(response, 400, "invalid-request", "the request body is not valid JSON or is too large");
    }
    deps.log.error("request failed", { method: request.method, path: request.path, error: error instanceof Error ? error.message : String(error) });
    response.setHeader("Retry-After", "5");
    sendError(response, 503, "unavailable", "the service could not complete the request; retry later");
  });

  return app;
}

export type { UserProvisioning };
