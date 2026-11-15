import type { Request, Response, Router } from "express";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import type { GatewayKubernetesObservation, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import {
  FleetStatePreconditionError,
  commitRecoveredDisposableRuntimeResetInTransaction,
  commitUnavailableGatewayRecoveryInTransaction,
} from "./fleet-state.js";
import { isUserActivateOperationIdFor, isUserReturnOperationIdFor } from "./isolated-operation-ids.js";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { assertClientOwnsPlacementAutomation, placementOwnerRefusalBody } from "./placement-automation-owner.js";
import {
  CONTINUOUS_PLACEMENT_SOURCE,
  PLACEMENT_MIGRATION_KIND,
  PLACEMENT_MIGRATION_SOURCES,
  continuousPlacementMigrationOperationId,
  enqueuePlacementMigrationInTransaction,
  isPlacementMigrationRefusal,
  supersedePendingSharedDrainMoveInTransaction,
  type EnqueuePlacementMigrationRequest,
  type PlacementMigrationClassifier,
  type PlacementMigrationSource,
  type SupersedePendingSharedDrainMoveRequest,
} from "./placement-migrations.js";
import { FenceMismatchError } from "./platform-state/errors.js";
import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/store.js";
import { readSharedGatewayPoolConfigInStore } from "./shared-gateway-pool-read.js";
import { appendSharedRollRecoveryInTransaction, type SupersedeRollingSharedGatewayRollInput } from "./shared-gateway-roll-recovery.js";

export interface AdminPlacementSharedCapabilities extends PlacementMigrationClassifier {
  observeGatewayKubernetes(gatewayId: string): Promise<GatewayKubernetesObservation | null>;
  platformArtifact: ReleasePayload | null;
  operationJournalRetentionMs: number;
  kubernetesObservationMaxAgeMs: number;
}

export interface AdminPlacementSharedRouterDeps extends AdminPlacementSharedCapabilities {
  store: PlatformStateStore;
  journal: AdminFleetMutationRunner;
  now?: () => number;
}

class PreconditionFailed extends Error {}

class ObservationUnknown extends Error {}

class Rehearsed extends Error {}

function refusalBody(error: unknown): Record<string, unknown> | null {
  if (error instanceof FleetMutationRefusedError) return refusalBody(error.refusal);
  const owner = placementOwnerRefusalBody(error);
  if (owner !== null) return owner;
  if (error instanceof ObservationUnknown) return { code: "observation-unknown", error: error.message };
  if (
    error instanceof PreconditionFailed ||
    error instanceof FenceMismatchError ||
    error instanceof FleetStatePreconditionError ||
    isPlacementMigrationRefusal(error)
  ) {
    return { code: "precondition-failed", error: (error as Error).message };
  }
  return null;
}

function refusalsBelowError(journal: AdminFleetMutationRunner): AdminFleetMutationRunner {
  return (input) => journal({
    ...input,
    action: async (claim) => {
      try {
        return await input.action(claim);
      } catch (error) {
        if (error instanceof Error && refusalBody(error) !== null) throw new FleetMutationRefusedError(error);
        throw error;
      }
    },
  });
}

async function settle<T>(res: Response, run: () => Promise<T>): Promise<void> {
  try {
    res.json(await run());
  } catch (error) {
    const body = refusalBody(error);
    if (body === null) throw error;
    res.status(409).json(body);
  }
}

type Field = string | number | boolean | Record<string, unknown> | null | undefined;
type Body = Record<string, Field>;

function bodyOf(req: Request): Body {
  const body: unknown = req.body;
  return body !== null && typeof body === "object" && !Array.isArray(body) ? body as Body : {};
}

function text(body: Body, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") throw new BadRequest(`${field} is required`);
  return value;
}

function count(body: Body, field: string, minimum: number): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new BadRequest(`${field} must be an integer of at least ${minimum}`);
  }
  return value;
}

class BadRequest extends Error {}

async function targetUsersBlocker(
  transaction: PlatformStateTransaction,
  targetGatewayId: string,
  uid: string,
  atMost: number,
): Promise<string | null> {
  const [assignments, active] = await Promise.all([
    transaction.gateways.assignments.list(targetGatewayId),
    transaction.journal.operations.listByStatus(["pending", "running"]),
  ]);
  const users = new Set(assignments.map((assignment) => assignment.uid));
  for (const operation of active) {
    const inbound = operation.kind === PLACEMENT_MIGRATION_KIND && operation.input.toGatewayId === targetGatewayId;
    if (inbound && typeof operation.input.uid === "string") users.add(operation.input.uid);
  }
  users.delete(uid);
  return users.size > atMost
    ? `target ${targetGatewayId} has ${users.size} other users assigned or arriving, expected at most ${atMost}`
    : null;
}

async function assertTargetUsersAtMost(
  transaction: PlatformStateTransaction,
  targetGatewayId: string,
  uid: string,
  atMost: number,
): Promise<void> {
  const blocker = await targetUsersBlocker(transaction, targetGatewayId, uid, atMost);
  if (blocker !== null) throw new PreconditionFailed(blocker);
}

async function sharedGatewayIdsIn(transaction: PlatformStateTransaction): Promise<string[]> {
  const pool = await readSharedGatewayPoolConfigInStore(transaction);
  if (pool === null) throw new PreconditionFailed("the shared gateway pool is not configured");
  return [...pool.sharedGatewayIds];
}

const OBSERVED_STATUSES: readonly string[] = ["ready", "not-ready", "missing"];

function usableObservation(observation: GatewayKubernetesObservation, now: number, maxAgeMs: number): boolean {
  if (typeof observation !== "object") return false;
  if (!OBSERVED_STATUSES.includes(observation.status)) return false;
  if (!Number.isSafeInteger(observation.totalPods) || !Number.isSafeInteger(observation.readyPods)) return false;
  if (!Number.isSafeInteger(observation.observedAt)) return false;
  return observation.observedAt <= now && now - observation.observedAt <= maxAgeMs;
}

async function observeKnownKubernetes(
  deps: AdminPlacementSharedRouterDeps,
  gatewayId: string,
): Promise<GatewayKubernetesObservation> {
  const observation = await deps.observeGatewayKubernetes(gatewayId);
  const now = (deps.now ?? Date.now)();
  if (observation === null || !usableObservation(observation, now, deps.kubernetesObservationMaxAgeMs)) {
    throw new ObservationUnknown(`the Kubernetes status of ${gatewayId} is unknown`);
  }
  return observation;
}

interface Verb<T> {
  label: string;
  apply: (transaction: PlatformStateTransaction, now: number) => Promise<T>;
}

function ownedTransaction<T>(store: PlatformStateStore, verb: Verb<T>, now: number): Promise<T> {
  return store.transaction({ label: verb.label }, async (transaction) => {
    await assertClientOwnsPlacementAutomation(transaction);
    return verb.apply(transaction, now);
  });
}

async function rehearse<T>(store: PlatformStateStore, verb: Verb<T>, now: number): Promise<null> {
  try {
    await ownedTransaction(store, { label: `${verb.label}.dry-run`, apply: async (transaction, at) => {
      await verb.apply(transaction, at);
      throw new Rehearsed("dry run rolls back");
    } }, now);
  } catch (error) {
    if (error instanceof Rehearsed) return null;
    throw error;
  }
  throw new Error(`${verb.label} dry run committed`);
}

interface RouteIntent<T> {
  what: string;
  why: string;
  target: Record<string, unknown>;
  preActionStatus: Record<string, unknown>;
  mutation: Record<string, unknown>;
  verb: () => Promise<Verb<T>>;
}

function recoverSharedUserIntent(req: Request, deps: AdminPlacementSharedRouterDeps): RouteIntent<unknown> {
  const body = bodyOf(req);
  const fromGatewayId = req.params.id as string;
  const uid = req.params.uid as string;
  const slug = text(body, "slug");
  const toGatewayId = text(body, "toGatewayId");
  const expectedSourceEpoch = count(body, "expectedSourceEpoch", 0);
  const expectedTargetUsersAtMost = count(body, "expectedTargetUsersAtMost", 0);
  if (toGatewayId === fromGatewayId) throw new BadRequest("toGatewayId must differ from the source gateway");
  const operationId = `recover-shared-${uid}-${fromGatewayId}-${expectedSourceEpoch}`;
  return {
    what: "recover user from unavailable shared gateway",
    why: "the shared gateway is unavailable",
    target: { gatewayId: fromGatewayId, uid },
    preActionStatus: { expectedSourceEpoch, toGatewayId, expectedTargetUsersAtMost },
    mutation: { kind: "recover-shared-user", operationId, uid, fromGatewayId, toGatewayId, expectedSourceEpoch, expectedTargetUsersAtMost },
    verb: async () => {
      const sourceKubernetes = await observeKnownKubernetes(deps, fromGatewayId);
      if (sourceKubernetes.status === "ready") {
        throw new PreconditionFailed(`source ${fromGatewayId} is observed ready by Kubernetes`);
      }
      return {
        label: "admin.placement.recover-shared-user",
        apply: async (transaction, now) => {
          const sharedGatewayIds = await sharedGatewayIdsIn(transaction);
          await assertTargetUsersAtMost(transaction, toGatewayId, uid, expectedTargetUsersAtMost);
          const outcome = await commitUnavailableGatewayRecoveryInTransaction(transaction, {
            operationId,
            kind: "recover-shared-customer",
            uid,
            slug,
            fromGatewayId,
            toGatewayId,
            expectedSourceEpoch,
            sharedGatewayIds,
            targetHeartbeatMaxAgeMs: GATEWAY_UNREACHABLE_AFTER_MS,
            validateTarget: async ({ targetGatewayId }) => {
              if (!sharedGatewayIds.includes(targetGatewayId)) {
                throw new PreconditionFailed(`target ${targetGatewayId} is not in the shared gateway pool`);
              }
            },
          }, now);
          return { operationId, outcome, sourceKubernetesStatus: sourceKubernetes.status };
        },
      };
    },
  };
}

function resetRecoveredRuntimeIntent(req: Request): RouteIntent<unknown> {
  const body = bodyOf(req);
  const uid = req.params.uid as string;
  const slug = text(body, "slug");
  const targetGatewayId = text(body, "targetGatewayId");
  const previousRecoveryOperationId = text(body, "previousRecoveryOperationId");
  const expectedAssignmentEpoch = count(body, "expectedAssignmentEpoch", 1);
  const operationId = `recover-disposable-reset-${uid}-${targetGatewayId}-${expectedAssignmentEpoch}`;
  return {
    what: "reset recovered isolated runtime",
    why: "the user was recovered onto a shared gateway from an isolated gateway",
    target: { gatewayId: targetGatewayId, uid },
    preActionStatus: { expectedAssignmentEpoch, previousRecoveryOperationId },
    mutation: { kind: "reset-recovered-runtime", operationId, uid, targetGatewayId, expectedAssignmentEpoch, previousRecoveryOperationId },
    verb: async () => ({
      label: "admin.placement.reset-recovered-runtime",
      apply: async (transaction, now) => {
        const sharedGatewayIds = await sharedGatewayIdsIn(transaction);
        if (!sharedGatewayIds.includes(targetGatewayId)) {
          throw new PreconditionFailed(`target ${targetGatewayId} is not in the shared gateway pool`);
        }
        const outcome = await commitRecoveredDisposableRuntimeResetInTransaction(transaction, {
          operationId,
          previousRecoveryOperationId,
          uid,
          slug,
          targetGatewayId,
          expectedAssignmentEpoch,
          sharedGatewayIds,
          targetHeartbeatMaxAgeMs: GATEWAY_UNREACHABLE_AFTER_MS,
        }, now);
        return { operationId, outcome };
      },
    }),
  };
}

function supersedeRollingSharedGatewayIntent(req: Request, deps: AdminPlacementSharedRouterDeps): RouteIntent<unknown> {
  const body = bodyOf(req);
  const input: SupersedeRollingSharedGatewayRollInput = {
    sourceGatewayId: req.params.id as string,
    targetGatewayId: text(body, "targetGatewayId"),
    expectedLiveRelease: count(body, "expectedLiveRelease", 1),
    expectedDesiredRelease: count(body, "expectedDesiredRelease", 1),
  };
  if (input.targetGatewayId === input.sourceGatewayId) throw new BadRequest("targetGatewayId must differ from the source gateway");
  return {
    what: "supersede rolling shared gateway",
    why: "shared gateway recovery",
    target: { gatewayId: input.targetGatewayId },
    preActionStatus: {
      sourceGatewayId: input.sourceGatewayId,
      expectedLiveRelease: input.expectedLiveRelease,
      expectedDesiredRelease: input.expectedDesiredRelease,
    },
    mutation: { kind: "supersede-rolling-shared-gateway", ...input },
    verb: async () => {
      const sourceKubernetes = await observeKnownKubernetes(deps, input.sourceGatewayId);
      return {
        label: "admin.placement.supersede-rolling-shared-gateway",
        apply: async (transaction, now) => {
          const result = await appendSharedRollRecoveryInTransaction(transaction, input, { now, sourceKubernetes });
          if (result.kind === "not-eligible") throw new PreconditionFailed(result.reason);
          return { ...result, sourceKubernetesStatus: sourceKubernetes.status };
        },
      };
    },
  };
}

function enqueuePlacementMigrationIntent(req: Request, deps: AdminPlacementSharedRouterDeps): RouteIntent<unknown> {
  const body = bodyOf(req);
  const source = body.source;
  if (!(PLACEMENT_MIGRATION_SOURCES as readonly unknown[]).includes(source)) {
    throw new BadRequest(`source must be one of ${PLACEMENT_MIGRATION_SOURCES.join(", ")}`);
  }
  const request: EnqueuePlacementMigrationRequest = {
    uid: req.params.uid as string,
    builderSlug: text(body, "slug"),
    fromGatewayId: text(body, "fromGatewayId"),
    toGatewayId: text(body, "toGatewayId"),
    source: source as PlacementMigrationSource,
    operationId: text(body, "operationId"),
  };
  if (request.fromGatewayId === request.toGatewayId) throw new BadRequest("toGatewayId must differ from fromGatewayId");
  const drain = body.sharedDrain;
  if (drain !== undefined) {
    const paired = drain !== null && typeof drain === "object" ? drain.pairedTargetGatewayId : undefined;
    if (request.source !== CONTINUOUS_PLACEMENT_SOURCE || (paired !== null && (typeof paired !== "string" || paired === ""))) {
      throw new BadRequest("sharedDrain must be { pairedTargetGatewayId: string | null } on a continuous placement");
    }
    request.sharedDrain = { pairedTargetGatewayId: paired };
  }
  if (request.source !== CONTINUOUS_PLACEMENT_SOURCE &&
      !isUserActivateOperationIdFor(request.operationId, request.toGatewayId) &&
      !isUserReturnOperationIdFor(request.operationId, request.fromGatewayId)) {
    throw new BadRequest("an activation lease migration must use its activation or return operation id");
  }
  const expectedTargetUsersAtMost = count(body, "expectedTargetUsersAtMost", 0);
  return {
    what: "enqueue placement migration",
    why: request.sharedDrain ? "the source shared gateway is draining" : `placement automation (${request.source})`,
    target: { gatewayId: request.toGatewayId, uid: request.uid },
    preActionStatus: { fromGatewayId: request.fromGatewayId, expectedTargetUsersAtMost },
    mutation: { kind: "enqueue-placement-migration", ...request, expectedTargetUsersAtMost },
    verb: async () => ({
      label: "admin.placement.enqueue-migration",
      apply: async (transaction, now) => {
        await assertTargetUsersAtMost(transaction, request.toGatewayId, request.uid, expectedTargetUsersAtMost);
        if (request.source === CONTINUOUS_PLACEMENT_SOURCE && await transaction.journal.operations.get(request.operationId) === null) {
          const assignment = await transaction.gateways.assignments.get(request.fromGatewayId, request.uid);
          const expected = assignment === null ? null : continuousPlacementMigrationOperationId({ ...request, sourceAssignmentEpoch: assignment.epoch });
          if (expected !== request.operationId) {
            throw new PreconditionFailed(`operation ${request.operationId} does not match the user's current assignment on ${request.fromGatewayId}`);
          }
        }
        const outcome = await enqueuePlacementMigrationInTransaction(transaction, {
          now,
          platformArtifact: deps.platformArtifact,
          operationFailureIsTransient: deps.operationFailureIsTransient,
          gatewayStartupUnavailable: deps.gatewayStartupUnavailable,
          sourceRecoveryForwardRetryable: deps.sourceRecoveryForwardRetryable,
        }, request);
        return { operationId: request.operationId, outcome };
      },
    }),
  };
}

function supersedeSharedDrainMoveIntent(req: Request, deps: AdminPlacementSharedRouterDeps): RouteIntent<unknown> {
  const body = bodyOf(req);
  const request: SupersedePendingSharedDrainMoveRequest = {
    operationId: req.params.operationId as string,
    uid: text(body, "uid"),
    builderSlug: text(body, "slug"),
    fromGatewayId: text(body, "fromGatewayId"),
    toGatewayId: text(body, "toGatewayId"),
    leaseId: text(body, "leaseId"),
    generation: count(body, "generation", 1),
    targetGatewayId: text(body, "targetGatewayId"),
    activationOperationId: text(body, "activationOperationId"),
  };
  return {
    what: "supersede pending shared drain move",
    why: `activation lease ${request.leaseId} generation ${request.generation} moves the user to ${request.targetGatewayId}`,
    target: { gatewayId: request.fromGatewayId, uid: request.uid },
    preActionStatus: { status: "pending", leaseId: request.leaseId, generation: request.generation },
    mutation: { kind: "supersede-shared-drain-move", ...request },
    verb: async () => ({
      label: "admin.placement.supersede-shared-drain-move",
      apply: async (transaction, now) => {
        const outcome = await supersedePendingSharedDrainMoveInTransaction(transaction, {
          now,
          operationJournalRetentionMs: deps.operationJournalRetentionMs,
        }, request);
        if (outcome.kind === "refused") throw new PreconditionFailed(outcome.reason);
        return { operationId: request.operationId, outcome: outcome.kind };
      },
    }),
  };
}

function mountVerb(
  router: Router,
  deps: AdminPlacementSharedRouterDeps,
  path: string,
  intent: (req: Request, deps: AdminPlacementSharedRouterDeps) => RouteIntent<unknown>,
): void {
  const journal = refusalsBelowError(deps.journal);
  const clock = deps.now ?? Date.now;
  router.post(path, async (req, res, next) => {
    try {
      let parsed: RouteIntent<unknown>;
      try {
        parsed = intent(req, deps);
      } catch (error) {
        if (!(error instanceof BadRequest)) throw error;
        res.status(400).json({ error: error.message });
        return;
      }
      const prepared = async () => ({ verb: await parsed.verb(), now: clock() });
      await settle(res, () => journal({
        req,
        what: parsed.what,
        why: parsed.why,
        target: parsed.target,
        preActionStatus: parsed.preActionStatus,
        mutation: parsed.mutation,
        dryRunRefusal: async () => {
          const { verb, now } = await prepared();
          return rehearse(deps.store, verb, now);
        },
        action: async () => {
          const { verb, now } = await prepared();
          return ownedTransaction(deps.store, verb, now);
        },
      }));
    } catch (error) {
      next(error);
    }
  });
}

export function addAdminPlacementSharedRoutes(router: Router, deps: AdminPlacementSharedRouterDeps): void {
  mountVerb(router, deps, "/shared-gateways/:id/users/:uid/recover", recoverSharedUserIntent);
  mountVerb(router, deps, "/users/:uid/runtime-reset", resetRecoveredRuntimeIntent);
  mountVerb(router, deps, "/shared-gateways/:id/roll-recovery", supersedeRollingSharedGatewayIntent);
  mountVerb(router, deps, "/users/:uid/placement-migrations", enqueuePlacementMigrationIntent);
  mountVerb(router, deps, "/placement-migrations/:operationId/supersede", supersedeSharedDrainMoveIntent);
}
