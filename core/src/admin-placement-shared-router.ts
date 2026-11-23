import type { Request, Response, Router } from "express";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { resolveGatewayRuntime } from "@octogee/shared/types/glm";
import type { GatewayKubernetesObservation, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import {
  FleetStatePreconditionError,
  commitRecoveredDisposableRuntimeResetInTransaction,
  commitUnavailableGatewayRecoveryInTransaction,
  type UnavailableGatewayRecoverySourceValidationContext,
} from "./fleet-state.js";
import { isUserActivateOperationIdFor, isUserReturnOperationIdFor } from "@octogee/shared/types/isolated-operation-ids";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { assertClientOwnsPlacementAutomation, placementOwnerRefusalBody, requireClientPlacementOwner } from "./placement-automation-owner.js";
import {
  CONTINUOUS_PLACEMENT_SOURCE,
  HeldUserPlacementError,
  PLACEMENT_MIGRATION_KIND,
  PLACEMENT_MIGRATION_SOURCES,
  PlacementMigrationAuthorityError,
  SharedDrainSupersededError,
  TerminalPlacementMigrationConflictError,
  continuousPlacementMigrationOperationId,
  enqueuePlacementMigrationInTransaction,
  supersedePendingSharedDrainMoveInTransaction,
  type EnqueuePlacementMigrationRequest,
  type PlacementMigrationClassifier,
  type PlacementMigrationSource,
  type SupersedePendingSharedDrainMoveRequest,
} from "./placement-migrations.js";
import { PlacementPreconditionFailed, type PlacementRefusalReason } from "./placement-refusal.js";
import { FenceMismatchError } from "./platform-state/errors.js";
import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/store.js";
import { readSharedGatewayPoolConfigInStore } from "./shared-gateway-pool-read.js";
import { appendSharedRollRecoveryInTransaction, type SupersedeRollingSharedGatewayRollInput } from "./shared-gateway-roll-recovery.js";

export interface AdminPlacementSharedCapabilities extends PlacementMigrationClassifier {
  observeGatewayKubernetes(gatewayId: string): Promise<GatewayKubernetesObservation | null>;
  platformArtifact: ReleasePayload | null;
  operationJournalRetentionMs: number;
}

export interface AdminPlacementSharedRouterDeps extends AdminPlacementSharedCapabilities {
  store: PlatformStateStore;
  journal: AdminFleetMutationRunner;
  now?: () => number;
}

class ObservationUnknown extends Error {}

class Rehearsed extends Error {}

const REFUSAL_REASONS: ReadonlyArray<[new (...args: never[]) => Error, PlacementRefusalReason]> = [
  [TerminalPlacementMigrationConflictError, "migration-terminal"],
  [HeldUserPlacementError, "user-held"],
  [SharedDrainSupersededError, "shared-drain-superseded"],
  [PlacementMigrationAuthorityError, "migration-authority"],
  [FleetStatePreconditionError, "fleet-state-changed"],
  [FenceMismatchError, "fence-mismatch"],
];

function refusalReason(error: unknown): PlacementRefusalReason | null {
  if (error instanceof PlacementPreconditionFailed) return error.reasonCode;
  return REFUSAL_REASONS.find(([type]) => error instanceof type)?.[1] ?? null;
}

function refusalBody(error: unknown): Record<string, unknown> | null {
  if (error instanceof FleetMutationRefusedError) return refusalBody(error.refusal);
  const owner = placementOwnerRefusalBody(error);
  if (owner !== null) return owner;
  if (error instanceof ObservationUnknown) return { code: "observation-unknown", error: error.message };
  const reasonCode = refusalReason(error);
  return reasonCode === null ? null : { code: "precondition-failed", error: (error as Error).message, reasonCode };
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
  if (blocker !== null) throw new PlacementPreconditionFailed("target-capacity", blocker);
}

async function sharedGatewayIdsIn(transaction: PlatformStateTransaction): Promise<string[]> {
  const pool = await readSharedGatewayPoolConfigInStore(transaction);
  if (pool === null) throw new PlacementPreconditionFailed("shared-pool-unconfigured", "the shared gateway pool is not configured");
  return [...pool.sharedGatewayIds];
}

const OBSERVED_STATUSES: readonly string[] = ["ready", "not-ready", "missing"];

type SourceObservation =
  | { known: true; observation: GatewayKubernetesObservation }
  | { known: false; reason: string };

function usableObservation(observation: GatewayKubernetesObservation | null): observation is GatewayKubernetesObservation {
  return observation !== null &&
    typeof observation === "object" &&
    OBSERVED_STATUSES.includes(observation.status) &&
    Number.isSafeInteger(observation.totalPods) &&
    Number.isSafeInteger(observation.readyPods);
}

async function observeSource(deps: AdminPlacementSharedRouterDeps, gatewayId: string): Promise<SourceObservation> {
  const unknown = `the Kubernetes status of ${gatewayId} is unknown`;
  try {
    const observation = await deps.observeGatewayKubernetes(gatewayId);
    return usableObservation(observation) ? { known: true, observation } : { known: false, reason: unknown };
  } catch (error) {
    return { known: false, reason: `${unknown}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function knownObservation(source: SourceObservation): GatewayKubernetesObservation {
  if (!source.known) throw new ObservationUnknown(source.reason);
  return source.observation;
}

function unavailableSourceBlocker(
  context: UnavailableGatewayRecoverySourceValidationContext,
  observation: GatewayKubernetesObservation,
  now: number,
  unchangedForAtLeastMs: number | null,
): string | null {
  const gatewayId = context.sourceGatewayId;
  if (context.sourceRuntime !== "cluster") {
    throw new ObservationUnknown(`${gatewayId} runs as ${context.sourceRuntime}, not as pods; its Kubernetes status is unknown`);
  }
  if (observation.status === "ready") return `source ${gatewayId} is observed ready by Kubernetes`;
  const heartbeatAt = context.sourceHeartbeatAt;
  if (heartbeatAt !== null && now - heartbeatAt <= GATEWAY_UNREACHABLE_AFTER_MS) {
    return `source ${gatewayId} still has a fresh runtime heartbeat while Kubernetes reports ${observation.status}`;
  }
  if (observation.status === "not-ready") {
    return `shared source ${gatewayId} still has Kubernetes pods; retaining assignments until it is missing`;
  }
  if (context.sourceDesiredRelease !== context.sourceLiveRelease) return `shared source ${gatewayId} is in an active roll`;
  return unchangedForAtLeastMs === null ? null : recentChangeBlocker(context, now, unchangedForAtLeastMs);
}

function recentChangeBlocker(
  context: UnavailableGatewayRecoverySourceValidationContext,
  now: number,
  unchangedForAtLeastMs: number,
): string | null {
  const gatewayId = context.sourceGatewayId;
  if (context.sourceUpdatedAt === null) return `shared source ${gatewayId} has no recorded change time`;
  const unchangedFor = now - context.sourceUpdatedAt;
  return unchangedFor < unchangedForAtLeastMs
    ? `shared source ${gatewayId} changed ${unchangedFor} ms ago, less than ${unchangedForAtLeastMs} ms`
    : null;
}

interface Verb<T> {
  label: string;
  apply: (transaction: PlatformStateTransaction, now: number) => Promise<T>;
}

async function assertClientOwnsBeforeReading(store: PlatformStateStore, label: string): Promise<void> {
  await store.transaction({ label: `${label}.owner`, readOnly: true }, assertClientOwnsPlacementAutomation);
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
  label: string;
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
  const sourceUnchangedForAtLeastMs = body.sourceUnchangedForAtLeastMs === undefined ? null : count(body, "sourceUnchangedForAtLeastMs", 0);
  if (toGatewayId === fromGatewayId) throw new BadRequest("toGatewayId must differ from the source gateway");
  const operationId = `recover-shared-${uid}-${fromGatewayId}-${expectedSourceEpoch}`;
  return {
    what: "recover user from unavailable shared gateway",
    why: "the shared gateway is unavailable",
    target: { gatewayId: fromGatewayId, uid },
    preActionStatus: { expectedSourceEpoch, toGatewayId, expectedTargetUsersAtMost, sourceUnchangedForAtLeastMs },
    mutation: {
      kind: "recover-shared-user", operationId, uid, fromGatewayId, toGatewayId, expectedSourceEpoch, expectedTargetUsersAtMost,
      sourceUnchangedForAtLeastMs,
    },
    label: "admin.placement.recover-shared-user",
    verb: async () => {
      const source = await observeSource(deps, fromGatewayId);
      return {
        label: "admin.placement.recover-shared-user",
        apply: async (transaction, now) => {
          const sharedGatewayIds = await sharedGatewayIdsIn(transaction);
          let sourceKubernetesStatus: string | null = null;
          const outcome = await commitUnavailableGatewayRecoveryInTransaction(transaction, {
            requireOwner: requireClientPlacementOwner,
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
                throw new PlacementPreconditionFailed("target-not-shared", `target ${targetGatewayId} is not in the shared gateway pool`);
              }
              await assertTargetUsersAtMost(transaction, targetGatewayId, uid, expectedTargetUsersAtMost);
            },
            validateSource: async (context) => {
              const observation = knownObservation(source);
              const blocker = unavailableSourceBlocker(context, observation, now, sourceUnchangedForAtLeastMs);
              if (blocker !== null) throw new PlacementPreconditionFailed("source-not-proven-unavailable", blocker);
              sourceKubernetesStatus = observation.status;
            },
          }, now);
          return { operationId, outcome, ...(sourceKubernetesStatus === null ? {} : { sourceKubernetesStatus }) };
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
    label: "admin.placement.reset-recovered-runtime",
    verb: async () => ({
      label: "admin.placement.reset-recovered-runtime",
      apply: async (transaction, now) => {
        const sharedGatewayIds = await sharedGatewayIdsIn(transaction);
        if (!sharedGatewayIds.includes(targetGatewayId)) {
          throw new PlacementPreconditionFailed("target-not-shared", `target ${targetGatewayId} is not in the shared gateway pool`);
        }
        const outcome = await commitRecoveredDisposableRuntimeResetInTransaction(transaction, {
          requireOwner: requireClientPlacementOwner,
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
    label: "admin.placement.supersede-rolling-shared-gateway",
    verb: async () => {
      const source = await observeSource(deps, input.sourceGatewayId);
      return {
        label: "admin.placement.supersede-rolling-shared-gateway",
        apply: async (transaction, now) => {
          const sourceRuntime = resolveGatewayRuntime((await transaction.fleetRegistry.get(input.sourceGatewayId))?.runtime);
          const unusable = unusableRollSource(source, input.sourceGatewayId, sourceRuntime);
          if (unusable !== null) {
            const unknown: GatewayKubernetesObservation = { status: "unknown", totalPods: 0, readyPods: 0, observedAt: now };
            const repeat = await appendSharedRollRecoveryInTransaction(transaction, input, { now, requireOwner: requireClientPlacementOwner, sourceKubernetes: unknown });
            if (repeat.kind === "already-scheduled") return { ...repeat, sourceKubernetesStatus: unknown.status };
            throw new ObservationUnknown(unusable);
          }
          const sourceKubernetes = knownObservation(source);
          const result = await appendSharedRollRecoveryInTransaction(transaction, input, { now, requireOwner: requireClientPlacementOwner, sourceKubernetes });
          if (result.kind === "not-eligible") throw new PlacementPreconditionFailed("roll-not-eligible", result.reason);
          return { ...result, sourceKubernetesStatus: sourceKubernetes.status };
        },
      };
    },
  };
}

function unusableRollSource(source: SourceObservation, gatewayId: string, runtime: string): string | null {
  if (!source.known) return source.reason;
  if (runtime !== "cluster") return `${gatewayId} runs as ${runtime}, not as pods; its Kubernetes status is unknown`;
  return null;
}

function parseDisklessRecoveryIntent(body: Record<string, unknown>, source: PlacementMigrationSource): true | undefined {
  if (body.durableRecovery === undefined) return undefined;
  if (body.durableRecovery !== true || source === CONTINUOUS_PLACEMENT_SOURCE || body.sharedDrain !== undefined) {
    throw new BadRequest("durableRecovery requires a diskless builder return");
  }
  return true;
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
  const durableRecovery = parseDisklessRecoveryIntent(body, request.source);
  if (durableRecovery) request.durableRecovery = durableRecovery;
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
    label: "admin.placement.enqueue-migration",
    verb: async () => ({
      label: "admin.placement.enqueue-migration",
      apply: async (transaction, now) => {
        if (request.source === CONTINUOUS_PLACEMENT_SOURCE && await transaction.journal.operations.get(request.operationId) === null) {
          const assignment = await transaction.gateways.assignments.get(request.fromGatewayId, request.uid);
          const expected = assignment === null ? null : continuousPlacementMigrationOperationId({ ...request, sourceAssignmentEpoch: assignment.epoch });
          if (expected !== request.operationId) {
            throw new PlacementPreconditionFailed("assignment-changed", `operation ${request.operationId} does not match the user's current assignment on ${request.fromGatewayId}`);
          }
        }
        const outcome = await enqueuePlacementMigrationInTransaction(transaction, {
          requireOwner: requireClientPlacementOwner,
          now,
          platformArtifact: deps.platformArtifact,
          operationFailureIsTransient: deps.operationFailureIsTransient,
          gatewayStartupUnavailable: deps.gatewayStartupUnavailable,
          sourceRecoveryForwardRetryable: deps.sourceRecoveryForwardRetryable,
        }, request, () => assertTargetUsersAtMost(transaction, request.toGatewayId, request.uid, expectedTargetUsersAtMost));
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
    label: "admin.placement.supersede-shared-drain-move",
    verb: async () => ({
      label: "admin.placement.supersede-shared-drain-move",
      apply: async (transaction, now) => {
        const outcome = await supersedePendingSharedDrainMoveInTransaction(transaction, {
          requireOwner: requireClientPlacementOwner,
          now,
          operationJournalRetentionMs: deps.operationJournalRetentionMs,
        }, request);
        if (outcome.kind === "refused") throw new PlacementPreconditionFailed("drain-move-not-supersedable", outcome.reason);
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
      const prepared = async () => {
        await assertClientOwnsBeforeReading(deps.store, parsed.label);
        return { verb: await parsed.verb(), now: clock() };
      };
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
