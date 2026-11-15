import type { Request, Response, Router } from "express";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import { GatewayRetirementConflictError } from "./gateway-retirement-claim.js";
import {
  IsolatedGatewayFenceError,
  PLACEMENT_RETIREMENT_REASONS,
  advanceActivationLease,
  completeActivationLease,
  failActivationLease,
  leaseOperationIdBelongs,
  requestSizingKeyTransition,
  unauditedLifecycleMutations,
  retireOwnedIsolatedGateway,
  type AdvanceActivationLeaseInput,
  type AuthoritativeLeaseStatus,
  type CompleteActivationLeaseInput,
  type FailActivationLeaseInput,
  type IsolatedLifecycleDeps,
  type PlacementOwnerFence,
  type PlacementRetirementReason,
  type RetireOwnedIsolatedGatewayInput,
  type SizingKeyTransitionInput,
} from "./isolated-gateway-lifecycle/index.js";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { assertClientOwnsPlacementAutomation, placementOwnerRefusalBody } from "./placement-automation-owner.js";
import { FenceMismatchError } from "./platform-state/errors.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { PlatformStateStore, Stored } from "./platform-state/store.js";
import { InitialGatewayReleaseConflictError } from "./gateway-live-release.js";
import { SizingKeyChangedError, accountSizingKeyReader } from "./sizing-key.js";
import type { UserAccountReader } from "./user-account.js";
import type { PodObservation } from "./isolated-gateway-lifecycle/index.js";

export interface AdminIsolatedCapabilities {
  namespace: string;
  ensureAuthSecret(input: { namespace: string; gatewayId: string }): Promise<unknown>;
  readGatewayPodDiagnostics(gatewayId: string): Promise<PodObservation>;
}

export interface AdminPlacementIsolatedRouterDeps {
  store: PlatformStateStore;
  journal: AdminFleetMutationRunner;
  accounts: Pick<UserAccountReader, "get">;
  capabilities: AdminIsolatedCapabilities;
  log(message: string): void;
  warn(message: string): void;
  now?: () => number;
}

class PreconditionFailed extends Error {}

class InvalidRequest extends Error {}

const requireClientOwner: PlacementOwnerFence = async (transaction) => {
  await assertClientOwnsPlacementAutomation(transaction);
};

function isPrecondition(error: unknown): error is Error {
  return error instanceof PreconditionFailed ||
    error instanceof IsolatedGatewayFenceError ||
    error instanceof GatewayRetirementConflictError ||
    error instanceof FenceMismatchError ||
    error instanceof SizingKeyChangedError ||
    error instanceof InitialGatewayReleaseConflictError;
}

export function isolatedVerbRefusalBody(error: unknown): Record<string, unknown> | null {
  const owner = placementOwnerRefusalBody(error);
  if (owner !== null) return owner;
  if (error instanceof FleetMutationRefusedError) return isolatedVerbRefusalBody(error.refusal);
  if (isPrecondition(error)) return { code: "precondition-failed", reason: error.message, error: error.message };
  return null;
}

function refusalsBelowError(journal: AdminFleetMutationRunner): AdminFleetMutationRunner {
  return (input) => journal({
    ...input,
    action: async (claim) => {
      try {
        return await input.action(claim);
      } catch (error) {
        if (error instanceof Error && isolatedVerbRefusalBody(error) !== null) throw new FleetMutationRefusedError(error);
        throw error;
      }
    },
  });
}

async function settle<T>(res: Response, run: () => Promise<T>): Promise<void> {
  try {
    res.json(await run());
  } catch (error) {
    const body = isolatedVerbRefusalBody(error);
    if (body === null) throw error;
    res.status(409).json(body);
  }
}

type Body = Record<string, unknown>;
type Parsed<T> = T | { invalid: string };

function bodyOf(req: Request): Body {
  const body = req.body;
  return body !== null && typeof body === "object" && !Array.isArray(body) ? body as Body : {};
}

function text(body: Body, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(body: Body, key: string): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function invalid<T>(parsed: Parsed<T>): parsed is { invalid: string } {
  return typeof parsed === "object" && parsed !== null && "invalid" in parsed;
}

function leaseIdentity(req: Request): Parsed<{ uid: string; leaseId: string; generation: number }> {
  const body = bodyOf(req);
  const leaseId = text(body, "leaseId");
  const generation = positiveInteger(body, "generation");
  if (!leaseId) return { invalid: "leaseId is required" };
  if (generation === null) return { invalid: "generation must be a positive integer" };
  return { uid: req.params.uid as string, leaseId, generation };
}

const ADVANCES: ReadonlyArray<[AdvanceActivationLeaseInput["fromStatus"], AdvanceActivationLeaseInput["toStatus"]]> = [
  ["provisioning", "activating"],
  ["provisioning", "active"],
  ["activating", "active"],
  ["active", "returning"],
];

function optionalOperationId(body: Body): Parsed<{ operationId?: string }> {
  if (body.operationId === undefined) return {};
  const operationId = text(body, "operationId");
  return operationId ? { operationId } : { invalid: "operationId must be a non-empty string when given" };
}

function parseAdvance(req: Request): Parsed<AdvanceActivationLeaseInput> {
  const identity = leaseIdentity(req);
  if (invalid(identity)) return identity;
  const body = bodyOf(req);
  const step = ADVANCES.find(([from, to]) => body.fromStatus === from && body.toStatus === to);
  if (!step) {
    return { invalid: "fromStatus and toStatus must be provisioning->activating, provisioning->active, activating->active or active->returning" };
  }
  const given = optionalOperationId(body);
  if (invalid(given)) return given;
  return { ...identity, fromStatus: step[0], toStatus: step[1], ...given };
}

function parseComplete(req: Request): Parsed<CompleteActivationLeaseInput> {
  const identity = leaseIdentity(req);
  if (invalid(identity)) return identity;
  const body = bodyOf(req);
  const targetGatewayId = text(body, "targetGatewayId");
  if (!targetGatewayId) return { invalid: "targetGatewayId is required" };
  if (body.parked !== undefined && body.parked !== true) return { invalid: "parked must be true when given" };
  return { ...identity, targetGatewayId, ...(body.parked === true ? { parked: true as const } : {}) };
}

function parseFail(req: Request): Parsed<FailActivationLeaseInput> {
  const identity = leaseIdentity(req);
  if (invalid(identity)) return identity;
  const body = bodyOf(req);
  const targetGatewayId = text(body, "targetGatewayId");
  const message = text(body, "message");
  if (!targetGatewayId) return { invalid: "targetGatewayId is required" };
  if (!message) return { invalid: "message is required" };
  const given = optionalOperationId(body);
  if (invalid(given)) return given;
  const operationId = given.operationId ?? builderActivateOperationId(targetGatewayId, identity.generation);
  return { ...identity, targetGatewayId, operationId, message };
}

function parseSizingTransition(req: Request): Parsed<SizingKeyTransitionInput> {
  const identity = leaseIdentity(req);
  if (invalid(identity)) return identity;
  const body = bodyOf(req);
  const targetGatewayId = text(body, "targetGatewayId");
  const sizingKey = text(body, "sizingKey");
  if (!targetGatewayId) return { invalid: "targetGatewayId is required" };
  if (!sizingKey) return { invalid: "sizingKey is required" };
  return { ...identity, targetGatewayId, sizingKey };
}

const AUTHORITATIVE_STATUSES: readonly AuthoritativeLeaseStatus[] = ["provisioning", "activating", "returning"];

type RetireRequest = Omit<RetireOwnedIsolatedGatewayInput, "builderSlug">;

function parseRetire(req: Request): Parsed<RetireRequest> {
  const body = bodyOf(req);
  const uid = text(body, "ownerUid");
  const generation = positiveInteger(body, "generation");
  const reason = body.reason;
  if (!uid) return { invalid: "ownerUid is required" };
  if (generation === null) return { invalid: "generation must be a positive integer" };
  if (!(PLACEMENT_RETIREMENT_REASONS as readonly unknown[]).includes(reason)) {
    return { invalid: `reason must be one of ${PLACEMENT_RETIREMENT_REASONS.join(", ")}` };
  }
  const optional: Record<string, unknown> = {};
  for (const key of ["leaseId", "telemetryFenceOperationId", "authoritativeGatewayId", "zeroWorkloadRecoveryOperationId"] as const) {
    if (body[key] === undefined) continue;
    const value = text(body, key);
    if (!value) return { invalid: `${key} must be a non-empty string when given` };
    optional[key] = value;
  }
  if (body.telemetryFenceStatus !== undefined) {
    if (body.telemetryFenceStatus !== "succeeded" && body.telemetryFenceStatus !== "terminal-failure") {
      return { invalid: "telemetryFenceStatus must be succeeded or terminal-failure" };
    }
    if (optional.telemetryFenceOperationId === undefined) return { invalid: "telemetryFenceStatus needs telemetryFenceOperationId" };
    optional.telemetryFenceStatus = body.telemetryFenceStatus;
  }
  if (body.authoritativeLeaseStatus !== undefined) {
    if (!(AUTHORITATIVE_STATUSES as readonly unknown[]).includes(body.authoritativeLeaseStatus)) {
      return { invalid: "authoritativeLeaseStatus must be provisioning, activating or returning" };
    }
    if (optional.authoritativeGatewayId === undefined) return { invalid: "authoritativeLeaseStatus needs authoritativeGatewayId" };
    optional.authoritativeLeaseStatus = body.authoritativeLeaseStatus;
  }
  return {
    uid,
    gatewayId: req.params.id as string,
    generation,
    reason: reason as PlacementRetirementReason,
    ...optional,
  } as RetireRequest;
}

async function readOwner(store: PlatformStateStore, uid: string): Promise<Stored<PlatformUserRecord>> {
  const user = await store.users.records.get(uid);
  if (!user) throw new PreconditionFailed(`user ${uid} is missing`);
  return user;
}

async function assertLeaseOperationId(
  store: PlatformStateStore,
  claim: { uid: string; gatewayId: string | null; generation: number; operationId: string },
): Promise<void> {
  const { gatewayId } = claim;
  if (gatewayId === null) throw new InvalidRequest(`operationId ${claim.operationId} needs the lease's target gateway`);
  if (await leaseOperationIdBelongs(store.journal.operations, { ...claim, gatewayId })) return;
  throw new InvalidRequest(`operationId ${claim.operationId} is not an operation of ${claim.uid} on ${gatewayId} generation ${claim.generation}`);
}

function leaseOf(user: Stored<PlatformUserRecord>) {
  if (!user.activationLease) throw new PreconditionFailed(`activation lease for ${user.uid} is missing`);
  return user.activationLease;
}

export function addAdminPlacementIsolatedRoutes(router: Router, deps: AdminPlacementIsolatedRouterDeps): void {
  const journal = refusalsBelowError(deps.journal);
  const now = deps.now ?? Date.now;
  const readSizingKey = accountSizingKeyReader(deps.accounts);
  const lifecycle: IsolatedLifecycleDeps = {
    store: deps.store,
    readSizingKey,
    requireOwner: requireClientOwner,
    mutations: unauditedLifecycleMutations,
    now,
    log: deps.log,
  };
  const ownerCheck = () => deps.store.transaction(
    { label: "admin.placement.isolated.owner", readOnly: true },
    async (transaction) => { await requireClientOwner(transaction); },
  );

  function verb<T>(path: string, parse: (req: Request) => Parsed<T>, run: (req: Request, input: T) => Promise<unknown>): void {
    router.post(path, async (req, res, next) => {
      try {
        const input = parse(req);
        if (invalid(input)) {
          res.status(400).json({ error: input.invalid });
          return;
        }
        try {
          await ownerCheck();
        } catch (error) {
          const refusal = placementOwnerRefusalBody(error);
          if (refusal === null) throw error;
          deps.warn(`[placement] ${req.method} ${req.path} refused before journaling: ${(error as Error).message}`);
          res.status(409).json(refusal);
          return;
        }
        await settle(res, () => run(req, input));
      } catch (error) {
        if (error instanceof InvalidRequest) {
          res.status(400).json({ error: error.message });
          return;
        }
        next(error);
      }
    });
  }

  verb("/users/:uid/activation-lease/advance", parseAdvance, async (req, input) => {
    if (input.operationId !== undefined) {
      const stored = await deps.store.users.records.get(input.uid);
      const gatewayId = stored?.activationLease?.targetGatewayId;
      await assertLeaseOperationId(deps.store, { ...input, operationId: input.operationId, gatewayId: typeof gatewayId === "string" ? gatewayId : null });
    }
    return journal({
      req,
      what: "advance user activation lease",
      why: "placement automation advanced the lease",
      target: { uid: input.uid },
      preActionStatus: { leaseId: input.leaseId, generation: input.generation, status: input.fromStatus },
      mutation: { kind: "advance-activation-lease", toStatus: input.toStatus, operationId: input.operationId ?? null },
      dryRunRefusal: async () => {
        await advanceActivationLease(lifecycle, input, "plan");
        return null;
      },
      action: async () => {
        await advanceActivationLease(lifecycle, input);
        return { uid: input.uid, leaseId: input.leaseId, generation: input.generation, status: input.toStatus };
      },
    });
  });

  verb("/users/:uid/activation-lease/complete", parseComplete, (req, input) => journal({
    req,
    what: "complete user activation lease",
    why: "the user returned from the isolated gateway",
    target: { uid: input.uid, gatewayId: input.targetGatewayId },
    preActionStatus: { leaseId: input.leaseId, generation: input.generation, status: "returning" },
    mutation: { kind: "complete-activation-lease", parked: input.parked === true },
    dryRunRefusal: async () => {
      await completeActivationLease(lifecycle, input, "plan");
      return null;
    },
    action: async () => {
      await completeActivationLease(lifecycle, input);
      const lease = leaseOf(await readOwner(deps.store, input.uid));
      return { uid: input.uid, lease: { leaseId: lease.leaseId, generation: lease.generation, status: lease.status } };
    },
  }));

  verb("/users/:uid/activation-lease/fail", parseFail, async (req, input) => {
    await assertLeaseOperationId(deps.store, { ...input, gatewayId: input.targetGatewayId });
    return journal({
      req,
      what: "fail user activation lease",
      why: "the activation migration failed",
      target: { uid: input.uid, gatewayId: input.targetGatewayId },
      preActionStatus: { leaseId: input.leaseId, generation: input.generation },
      mutation: { kind: "fail-activation-lease", operationId: input.operationId },
      dryRunRefusal: async () => {
        await failActivationLease(lifecycle, input, "plan");
        return null;
      },
      action: async () => {
        await failActivationLease(lifecycle, input);
        return { uid: input.uid, leaseId: input.leaseId, generation: input.generation, status: "failed" };
      },
    });
  });

  verb("/users/:uid/activation-lease/sizing-transition", parseSizingTransition, (req, input) => journal({
    req,
    what: "request user sizing transition",
    why: "the user's sizing profile changed while active",
    target: { uid: input.uid, gatewayId: input.targetGatewayId },
    preActionStatus: { leaseId: input.leaseId, generation: input.generation, status: "active" },
    mutation: { kind: "request-sizing-transition", sizingKey: input.sizingKey },
    dryRunRefusal: async () => {
      await requestSizingKeyTransition(lifecycle, input, "plan");
      return null;
    },
    action: async () => {
      await requestSizingKeyTransition(lifecycle, input);
      return { uid: input.uid, leaseId: input.leaseId, generation: input.generation, returnRequested: true };
    },
  }));

  verb("/isolated-gateways/:id/retire-owned", parseRetire, async (req, input) => {
    const root = projectGatewayDesiredRootForGateway(await deps.store.gateways.roots.get(input.gatewayId), input.gatewayId);
    if (root === null || root.ownerUid !== input.uid || !root.builderSlug) {
      throw new PreconditionFailed(`gateway ${input.gatewayId} is not owned by ${input.uid}`);
    }
    const request: RetireOwnedIsolatedGatewayInput = { ...input, builderSlug: root.builderSlug };
    return journal({
        req,
        what: "retire owned isolated gateway",
        why: `placement automation retires it: ${input.reason}`,
        target: { gatewayId: input.gatewayId, uid: input.uid },
        preActionStatus: { generation: input.generation, desiredStatus: root.desiredStatus },
        mutation: { kind: "retire-owned-isolated-gateway", reason: input.reason, leaseId: input.leaseId ?? null },
        dryRunRefusal: async () => {
          const plan = await retireOwnedIsolatedGateway(lifecycle, request, "plan");
          if (!plan.retired) throw new PreconditionFailed(plan.reason);
          return null;
        },
        action: async () => {
          const retirement = await retireOwnedIsolatedGateway(lifecycle, request);
          if (!retirement.retired) throw new PreconditionFailed(retirement.reason);
          return { gatewayId: input.gatewayId, operationId: retirement.operationId, retired: true };
        },
    });
  });
}
