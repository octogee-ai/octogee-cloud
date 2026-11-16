import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLACEMENT_REFUSAL_REASONS, SourceRecoveryPendingError } from "./placement-refusal.js";

const CONTRACT = new URL("../../docs/admin-api-automation.md", import.meta.url);

describe("placement refusal reasons", () => {
  it("are the stable values the automation contract lists", () => {
    expect(PLACEMENT_REFUSAL_REASONS).toEqual([
      "migration-terminal", "user-held", "shared-drain-superseded", "migration-authority", "target-capacity",
      "shared-pool-unconfigured", "target-not-shared", "source-not-proven-unavailable", "assignment-changed",
      "roll-not-eligible", "drain-move-not-supersedable", "fleet-state-changed", "fence-mismatch",
      "source-recovery-pending", "user-missing", "user-slug-missing", "lease-missing", "gateway-not-owned",
      "retirement-blocked", "isolated-fence", "retirement-conflict", "sizing-key-changed", "initial-release-conflict",
      "source-not-stranded", "migration-in-flight", "rollback-not-proven",
    ]);
  });

  it("are each documented in the reasonCode table", () => {
    const documented = [...readFileSync(CONTRACT, "utf8").matchAll(/^\| `([a-z-]+)` \| .+ \| .+ \|$/gm)].map((match) => match[1]);

    expect(documented.filter((value) => (PLACEMENT_REFUSAL_REASONS as readonly string[]).includes(value))).toEqual([...PLACEMENT_REFUSAL_REASONS]);
  });

  it("name the operation still recovering its source", () => {
    expect(new SourceRecoveryPendingError("builder-activate-gw-g1")).toMatchObject({
      reasonCode: "source-recovery-pending",
      operationId: "builder-activate-gw-g1",
      message: "operation builder-activate-gw-g1 is still recovering its source",
    });
  });
});
