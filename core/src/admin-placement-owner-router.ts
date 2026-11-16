import type { Request, Response, Router } from "express";
import type { AdminFleetMutationRunner } from "./admin-fleet-router.js";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import { isPlacementAutomationOwner, type PlacementAutomationOwner } from "./placement-automation-owner.js";
import {
  placementAutomationState,
  readPlacementAutomationState,
  setPlacementAutomationOwnerInTransaction,
  type PlacementAutomationOwnerChange,
} from "./placement-automation-handoff.js";
import { FenceMismatchError } from "./platform-state/errors.js";
import type { PlatformStateStore } from "./platform-state/store.js";

export interface AdminPlacementOwnerRouterDeps {
  store: PlatformStateStore;
  journal: AdminFleetMutationRunner;
  log(message: string): void;
}

const OWNER_REQUIRED = "owner must be fleet-controller or client";

const NEXT_PASS: Record<PlacementAutomationOwner, string> = {
  client: "the fleet controller yields on its next pass",
  "fleet-controller": "the fleet controller resumes on its next pass",
};

function preconditionBody(error: unknown): Record<string, unknown> | null {
  if (error instanceof FleetMutationRefusedError) return preconditionBody(error.refusal);
  if (error instanceof FenceMismatchError) return { code: "precondition-failed", error: error.message };
  return null;
}

async function settle(res: Response, run: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await run());
  } catch (error) {
    const body = preconditionBody(error);
    if (body === null) throw error;
    res.status(409).json(body);
  }
}

function actorOf(req: Request): string {
  return (req as Request & { uid?: string }).uid ?? "unknown";
}

async function setOwner(req: Request, res: Response, deps: AdminPlacementOwnerRouterDeps): Promise<void> {
  const owner: unknown = (req.body as Record<string, unknown> | undefined)?.owner;
  if (!isPlacementAutomationOwner(owner)) {
    res.status(400).json({ error: OWNER_REQUIRED });
    return;
  }
  const before = await readPlacementAutomationState(deps.store);
  await settle(res, async () => {
    const change = await deps.journal<PlacementAutomationOwnerChange>({
      req,
      what: "set placement automation owner",
      why: owner === "client" ? "hand placement automation to the client" : "hand placement automation back to the fleet controller",
      target: { setting: "placementAutomationOwner" },
      preActionStatus: { ...before },
      mutation: { kind: "set-placement-automation-owner", owner },
      dryRunRefusal: async () => null,
      action: async () => {
        try {
          return await deps.store.transaction({ label: "admin.placement-automation.set-owner" }, (transaction) =>
            setPlacementAutomationOwnerInTransaction(transaction, owner));
        } catch (error) {
          if (error instanceof FenceMismatchError) throw new FleetMutationRefusedError(error);
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

export function addAdminPlacementOwnerRoutes(router: Router, deps: AdminPlacementOwnerRouterDeps): void {
  router.get("/placement-automation", async (_req, res, next) => {
    try {
      res.json(await readPlacementAutomationState(deps.store));
    } catch (error) {
      next(error);
    }
  });

  router.post("/placement-automation/owner", async (req, res, next) => {
    try {
      await setOwner(req, res, deps);
    } catch (error) {
      next(error);
    }
  });
}
