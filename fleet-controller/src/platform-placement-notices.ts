import type { GatewayAssignment, GatewayRoot, PlatformUserRecord } from "@octogee/core/platform-state";
import type { RepeatSquelch } from "@octogee/shared/server/repeat-squelch";
import { resolveDefaultPlacementEligibility } from "@octogee/shared/types/orchestrator-placement";
import { userPlacementDocument } from "./user-placement-document.js";

export const PLATFORM_PLACEMENT_NOTICE_REPEAT_MS = 10 * 60_000;

export interface PlatformPlacementNoticeInput {
  users: ReadonlyArray<PlatformUserRecord>;
  roots: ReadonlyArray<Pick<GatewayRoot, "gatewayId" | "gatewayClass" | "desiredStatus">>;
  assignments: ReadonlyArray<Pick<GatewayAssignment, "gatewayId" | "uid">>;
  squelch: RepeatSquelch;
  log(message: string): void;
}

export function logPlatformPlacementNotices(input: PlatformPlacementNoticeInput): void {
  const notice = (key: string, message: string | null): void => {
    if (message === null) {
      input.squelch.settle(key);
      return;
    }
    const admitted = input.squelch.admit(key, message);
    if (admitted) input.log(message + admitted.note);
  };
  const unplaced = input.users
    .filter((user) => user.gateway === null && resolveDefaultPlacementEligibility(userPlacementDocument(user, {})).eligible)
    .map((user) => user.uid)
    .sort();
  notice(
    "unplaced",
    unplaced.length === 0
      ? null
      : `[placement] ⚠ platform only: ${unplaced.length} user(s) have no gateway: ${unplaced.join(", ")}; ` +
          "place them with user assign",
  );
  const draining = input.roots
    .filter((root) => root.gatewayClass === "shared" && root.desiredStatus === "draining")
    .map((root) => root.gatewayId)
    .sort();
  for (const gatewayId of draining) {
    const kept = input.assignments.filter((assignment) => assignment.gatewayId === gatewayId).length;
    notice(
      `draining:${gatewayId}`,
      kept === 0
        ? null
        : `[placement] ⚠ platform only: draining shared gateway ${gatewayId} keeps ${kept} user(s); ` +
            "move them one at a time with user migrate, then retire it",
    );
  }
}
