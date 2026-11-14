import type { GatewayAssignment, GatewayRoot, PlatformUserRecord } from "@octogee/core/platform-state";
import { resolveDefaultPlacementEligibility } from "@octogee/shared/types/orchestrator-placement";
import { userPlacementDocument } from "./user-placement-document.js";

export interface PlatformPlacementNoticeInput {
  users: ReadonlyArray<PlatformUserRecord>;
  roots: ReadonlyArray<Pick<GatewayRoot, "gatewayId" | "gatewayClass" | "desiredStatus">>;
  assignments: ReadonlyArray<Pick<GatewayAssignment, "gatewayId" | "uid">>;
  log(message: string): void;
}

export function logPlatformPlacementNotices(input: PlatformPlacementNoticeInput): void {
  const unplaced = input.users
    .filter((user) => user.gateway === null && resolveDefaultPlacementEligibility(userPlacementDocument(user, {})).eligible)
    .map((user) => user.uid)
    .sort();
  if (unplaced.length > 0) {
    input.log(
      `[placement] ⚠ platform only: ${unplaced.length} user(s) have no gateway: ${unplaced.join(", ")}; ` +
        "place them with user assign",
    );
  }
  const draining = input.roots
    .filter((root) => root.gatewayClass === "shared" && root.desiredStatus === "draining")
    .map((root) => root.gatewayId)
    .sort();
  for (const gatewayId of draining) {
    const kept = input.assignments.filter((assignment) => assignment.gatewayId === gatewayId).length;
    if (kept === 0) continue;
    input.log(
      `[placement] ⚠ platform only: draining shared gateway ${gatewayId} keeps ${kept} user(s); ` +
        "move them one at a time with user migrate, then retire it",
    );
  }
}
