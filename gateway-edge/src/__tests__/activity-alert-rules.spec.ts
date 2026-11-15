import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Activity sink alert rules", () => {
  const rules = readFileSync(
    path.resolve(__dirname, "../../../charts/monitoring/files/gmp-rules.yaml"),
    "utf8",
  );

  it.each([
    ["ActivityFinalMissing", "octogee_activity_missing_final_total"],
    ["ActivityRoutineDeliveredNormally", "octogee_activity_routine_normal_delivery_total"],
    ["ActivityOrphansSustained", "octogee_activity_orphan_total"],
    ["ActivityAttachmentResultUnknown", "octogee_activity_attachment_unknown_total"],
  ])("alerts on %s using %s", (alert, metric) => {
    expect(rules).toContain(`alert: ${alert}`);
    expect(rules).toContain(metric);
  });
});
