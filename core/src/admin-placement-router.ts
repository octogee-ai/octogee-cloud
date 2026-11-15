import type { Request, Response, Router } from "express";
import { projectGatewayDesiredRootForGateway } from "@octogee/shared/types/gateway-releases";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import { clearRetiredUserActivationPreparation } from "./fleet-state.js";
import {
  builderActivateOperationId,
  builderReturnOperationId,
  isolatedRecoverOperationId,
  placementRetireOperationId,
} from "@octogee/shared/types/isolated-operation-ids";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { FenceMismatchError } from "./platform-state/errors.js";
import type { GatewayRoot } from "./platform-state/gateways.js";
import type { OperationPatch, OperationRecord } from "./platform-state/operations.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
import type { PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";

const ISOLATED_ALLOCATION_KIND = "disposable-builder";
const RETIRE_GATEWAY_KIND = "retire-gateway";
const LIVE_ACTIVATION_LEASE_STATUSES: ReadonlySet<string> = new Set(["requested", "provisioning", "activating", "active", "returning"]);

export interface AdminPlacementCapabilities {
  retirementFailedRetryably(operation: Stored<OperationRecord>, gatewayId: string): boolean;
  schedulerHandoffAwaitingRelease(operation: Stored<OperationRecord>): boolean;
  rearmedRetirementPatch: OperationPatch;
}

export interface AdminPlacementRouterDeps extends AdminPlacementCapabilities {
  store: PlatformStateStore;
  journal: AdminFleetMutationRunner;
}

class PreconditionFailed extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function preconditionBody(error: unknown): Record<string, unknown> | null {
  if (error instanceof FleetMutationRefusedError) return preconditionBody(error.refusal);
  if (error instanceof PreconditionFailed || error instanceof FenceMismatchError) {
    return { code: "precondition-failed", error: error.message };
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
        if (error instanceof Error && preconditionBody(error) !== null) throw new FleetMutationRefusedError(error);
        throw error;
      }
    },
  });
}

async function settle<T>(res: Response, run: () => Promise<T>): Promise<void> {
  try {
    res.json(await run());
  } catch (error) {
    const body = preconditionBody(error);
    if (body === null) throw error;
    res.status(409).json(body);
  }
}

interface RetiredIsolatedGatewayTarget {
  gatewayId: string;
  ownerUid: string;
  allocationGeneration: number;
}

function parseTarget(req: Request): RetiredIsolatedGatewayTarget | string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { ownerUid, allocationGeneration } = body;
  if (typeof ownerUid !== "string" || ownerUid === "") return "ownerUid is required";
  if (typeof allocationGeneration !== "number" || !Number.isSafeInteger(allocationGeneration) || allocationGeneration < 1) {
    return "allocationGeneration must be a positive integer";
  }
  return { gatewayId: req.params.id as string, ownerUid, allocationGeneration };
}

function handoffOperationIds(target: RetiredIsolatedGatewayTarget): string[] {
  return [
    builderActivateOperationId(target.gatewayId, target.allocationGeneration),
    builderReturnOperationId(target.gatewayId, target.allocationGeneration),
  ];
}

function claimOperationId(stored: Stored<GatewayRoot> | null): string | null {
  const claim = stored === null ? undefined : (stored as unknown as Record<string, unknown>).retirementClaim;
  return isRecord(claim) && typeof claim.operationId === "string" ? claim.operationId : null;
}

function retirementFenceBlocker(input: {
  target: RetiredIsolatedGatewayTarget;
  stored: Stored<GatewayRoot> | null;
  operation: Stored<OperationRecord> | null;
  owner: Stored<PlatformUserRecord> | null;
}): string | null {
  const { target, stored, operation, owner } = input;
  const root = projectGatewayDesiredRootForGateway(stored, target.gatewayId);
  const operationId = placementRetireOperationId(target.ownerUid, target.gatewayId, target.allocationGeneration);
  const checks: Array<[string, boolean]> = [
    [`gateway ${target.gatewayId} has no readable root`, root === null],
    [`gateway ${target.gatewayId} is not retired`, root?.desiredStatus !== "retired"],
    [`gateway ${target.gatewayId} is not owned by ${target.ownerUid}`, root?.ownerUid !== target.ownerUid],
    [`gateway ${target.gatewayId} is not an isolated allocation`, root?.allocation?.kind !== ISOLATED_ALLOCATION_KIND],
    [`gateway ${target.gatewayId} carries another allocation generation`, root?.allocation?.generation !== target.allocationGeneration],
    [`gateway ${target.gatewayId} retirement is not claimed by ${operationId}`, claimOperationId(stored) !== operationId],
    [`retirement operation ${operationId} is missing`, operation === null],
    [`operation ${operationId} is not a gateway retirement`, operation !== null && operation.kind !== RETIRE_GATEWAY_KIND],
    [`user ${target.ownerUid} still runs on ${target.gatewayId}`, owner?.gateway?.gatewayId === target.gatewayId],
  ];
  return checks.find(([, failed]) => failed)?.[0] ?? null;
}

async function readRetirement(transaction: PlatformStateTransaction, target: RetiredIsolatedGatewayTarget) {
  const operationId = placementRetireOperationId(target.ownerUid, target.gatewayId, target.allocationGeneration);
  const [stored, operation, owner] = await Promise.all([
    transaction.gateways.roots.get(target.gatewayId),
    transaction.journal.operations.get(operationId),
    transaction.users.records.get(target.ownerUid),
  ]);
  const blocker = retirementFenceBlocker({ target, stored, operation, owner });
  if (blocker !== null || operation === null) throw new PreconditionFailed(blocker ?? `retirement operation ${operationId} is missing`);
  return { operationId, operation, retirementVersion: stored?.retirementVersion ?? null };
}

function unreleasedHandoff(
  deps: Pick<AdminPlacementCapabilities, "schedulerHandoffAwaitingRelease">,
  target: RetiredIsolatedGatewayTarget,
  operations: ReadonlyMap<string, Stored<OperationRecord>>,
): string | null {
  return handoffOperationIds(target).find((id) => {
    const handoff = operations.get(id);
    return handoff !== undefined && deps.schedulerHandoffAwaitingRelease(handoff);
  }) ?? null;
}

async function rearmRetirement(deps: AdminPlacementRouterDeps, target: RetiredIsolatedGatewayTarget) {
  return deps.store.transaction({ label: "admin.placement.rearm-retirement" }, async (transaction) => {
    const { operationId, operation } = await readRetirement(transaction, target);
    if (!deps.retirementFailedRetryably(operation, target.gatewayId)) {
      throw new PreconditionFailed(`retirement operation ${operationId} is ${operation.status} and has not failed retryably`);
    }
    await transaction.journal.operations.patch(operationId, deps.rearmedRetirementPatch, { status: ["failed"] });
    return { gatewayId: target.gatewayId, operationId };
  });
}

async function assertNoLiveActivationLease(transaction: PlatformStateTransaction, gatewayId: string): Promise<void> {
  const leaseHolder = (await transaction.users.records.listAll()).find((user) =>
    user.activationLease?.targetGatewayId === gatewayId && LIVE_ACTIVATION_LEASE_STATUSES.has(user.activationLease.status));
  if (leaseHolder !== undefined) {
    throw new PreconditionFailed(`user ${leaseHolder.uid} holds a ${leaseHolder.activationLease?.status} activation lease on ${gatewayId}`);
  }
}

async function deleteRetiredRoot(deps: AdminPlacementRouterDeps, target: RetiredIsolatedGatewayTarget) {
  const { store } = deps;
  const verdict = await store.transaction({ label: "admin.placement.delete-retired-verdict", readOnly: true }, async (transaction) => {
    const retirement = await readRetirement(transaction, target);
    if (retirement.operation.status !== "succeeded") {
      throw new PreconditionFailed(`retirement operation ${retirement.operationId} is ${retirement.operation.status}, not succeeded`);
    }
    const unreleased = unreleasedHandoff(deps, target, await transaction.journal.operations.getMany(handoffOperationIds(target)));
    if (unreleased !== null) throw new PreconditionFailed(`${unreleased} has an unreleased scheduler handoff`);
    await assertNoLiveActivationLease(transaction, target.gatewayId);
    return retirement;
  });
  const preparationCleared = await clearRetiredUserActivationPreparation({ store }, {
    uid: target.ownerUid,
    targetGatewayId: target.gatewayId,
    generation: target.allocationGeneration,
    retirementOperationId: verdict.operationId,
  });
  const recoverOperationId = isolatedRecoverOperationId(target.gatewayId, target.allocationGeneration);
  await Promise.all([
    store.journal.operations.delete(recoverOperationId),
    store.journal.recoveryReceipts.delete(recoverOperationId),
  ]);
  await store.transaction({ label: "admin.placement.delete-retired-root" }, async (transaction) => {
    await assertNoLiveActivationLease(transaction, target.gatewayId);
    await transaction.gateways.roots.delete(target.gatewayId, {
      retirementVersion: verdict.retirementVersion,
      desiredStatus: ["retired"],
    });
  });
  return { gatewayId: target.gatewayId, deleted: true, preparationCleared };
}

export interface RetiredIsolatedGateway {
  gatewayId: string;
  ownerUid: string;
  allocationGeneration: number;
  retirementOperation: {
    id: string;
    kind: string;
    status: string;
    placementRetirement: boolean;
    failedRetryably: boolean;
  } | null;
  unreleasedHandoffOperationId: string | null;
  ownerGatewayId: string | null;
  activationLeases: Array<{ uid: string; status: string }>;
}

export async function readRetiredIsolatedGateways(
  deps: Pick<AdminPlacementRouterDeps, "store" | "retirementFailedRetryably" | "schedulerHandoffAwaitingRelease">,
): Promise<{ gateways: RetiredIsolatedGateway[] }> {
  return deps.store.transaction({ label: "admin.placement.retired-isolated-gateways", readOnly: true }, async (transaction) => {
    const roots = await transaction.gateways.roots.list();
    const retired = roots.flatMap((stored) => {
      const root = projectGatewayDesiredRootForGateway(stored, stored.gatewayId);
      const generation = root?.allocation?.generation;
      if (root?.desiredStatus !== "retired" || !root.ownerUid || root.allocation?.kind !== ISOLATED_ALLOCATION_KIND ||
          generation === undefined) return [];
      return [{ gatewayId: stored.gatewayId, ownerUid: root.ownerUid, allocationGeneration: generation, claimOperationId: claimOperationId(stored) }];
    });
    if (retired.length === 0) return { gateways: [] };
    const [users, operations] = await Promise.all([
      transaction.users.records.listAll(),
      transaction.journal.operations.getMany(retired.flatMap((gateway) => [
        ...(gateway.claimOperationId === null ? [] : [gateway.claimOperationId]),
        ...handoffOperationIds(gateway),
      ])),
    ]);
    const usersByUid = new Map(users.map((user) => [user.uid, user]));
    return {
      gateways: retired.map((gateway) => {
        const claimed = gateway.claimOperationId === null ? undefined : operations.get(gateway.claimOperationId);
        return {
          gatewayId: gateway.gatewayId,
          ownerUid: gateway.ownerUid,
          allocationGeneration: gateway.allocationGeneration,
          retirementOperation: claimed === undefined ? null : {
            id: claimed.id,
            kind: claimed.kind,
            status: claimed.status,
            placementRetirement: claimed.id === placementRetireOperationId(gateway.ownerUid, gateway.gatewayId, gateway.allocationGeneration),
            failedRetryably: deps.retirementFailedRetryably(claimed, gateway.gatewayId),
          },
          unreleasedHandoffOperationId: unreleasedHandoff(deps, gateway, operations),
          ownerGatewayId: usersByUid.get(gateway.ownerUid)?.gateway?.gatewayId ?? null,
          activationLeases: users.flatMap((user) =>
            user.activationLease?.targetGatewayId === gateway.gatewayId
              ? [{ uid: user.uid, status: user.activationLease.status }]
              : []),
        };
      }),
    };
  });
}

export function addAdminPlacementRoutes(router: Router, deps: AdminPlacementRouterDeps): void {
  const journal = refusalsBelowError(deps.journal);

  router.get("/isolated-gateways/retired", async (_req, res, next) => {
    try {
      res.json(await readRetiredIsolatedGateways(deps));
    } catch (error) {
      next(error);
    }
  });

  router.post("/isolated-gateways/:id/retirement/rearm", async (req, res, next) => {
    try {
      const target = parseTarget(req);
      if (typeof target === "string") {
        res.status(400).json({ error: target });
        return;
      }
      await settle(res, () => journal({
        req,
        what: "re-arm isolated gateway retirement",
        why: "the retirement failed retryably",
        target: { gatewayId: target.gatewayId, uid: target.ownerUid },
        preActionStatus: { allocationGeneration: target.allocationGeneration, status: "failed" },
        mutation: { kind: "rearm-gateway-retirement", gatewayId: target.gatewayId, allocationGeneration: target.allocationGeneration },
        action: () => rearmRetirement(deps, target),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/isolated-gateways/:id/delete-retired", async (req, res, next) => {
    try {
      const target = parseTarget(req);
      if (typeof target === "string") {
        res.status(400).json({ error: target });
        return;
      }
      await settle(res, () => journal({
        req,
        what: "delete retired isolated gateway",
        why: "its retirement succeeded",
        target: { gatewayId: target.gatewayId, uid: target.ownerUid },
        preActionStatus: { allocationGeneration: target.allocationGeneration, desiredStatus: "retired" },
        mutation: { kind: "delete-retired-gateway", gatewayId: target.gatewayId, allocationGeneration: target.allocationGeneration },
        action: () => deleteRetiredRoot(deps, target),
      }));
    } catch (error) {
      next(error);
    }
  });
}
