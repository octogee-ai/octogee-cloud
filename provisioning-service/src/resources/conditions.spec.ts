import { describe, expect, it } from "vitest";
import { applyConditions, pendingConditions } from "./conditions.js";

const T0 = new Date("2026-11-15T18:00:00Z");
const T1 = new Date("2026-11-15T18:05:00Z");

describe("conditions", () => {
  it("changes lastTransitionTime only when the status changes", () => {
    const pending = pendingConditions(["ChatReady", "Ready"], T0);
    const failed = applyConditions(pending, [{ type: "ChatReady", status: "False", reason: "ChatUserFailed", message: "503" }], 1, T1);
    expect(failed[0]).toEqual({ type: "ChatReady", status: "False", reason: "ChatUserFailed", message: "503", lastTransitionTime: T1.toISOString(), observedGeneration: 1 });

    const later = new Date("2026-11-15T18:09:00Z");
    const stillFailed = applyConditions(failed, [{ type: "ChatReady", status: "False", reason: "ChatTeamFailed" }], 2, later);
    expect(stillFailed[0]).toMatchObject({ reason: "ChatTeamFailed", lastTransitionTime: T1.toISOString(), observedGeneration: 2 });
    expect(stillFailed[1]).toEqual(pending[1]);
  });
});
