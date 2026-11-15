import { describe, expect, it } from "vitest";
import { isRequestedRevisionAllowed } from "../fleet-broker.js";

// Simple-roll pod identity (GATEWAY-SIMPLE-ROLL-SPEC): a pod's self-reported
// instance id must be the bare gateway id; legacy pods report nothing.
describe("isRequestedRevisionAllowed", () => {
  it("legacy pod (empty revisionId) is allowed", () => {
    expect(isRequestedRevisionAllowed("default", "")).toBe(true);
  });

  it("allows the bare gateway id", () => {
    expect(isRequestedRevisionAllowed("default", "default")).toBe(true);
  });

  it("rejects a revision-suffixed or foreign identity", () => {
    expect(isRequestedRevisionAllowed("default", "default-r2")).toBe(false);
    expect(isRequestedRevisionAllowed("default", "walter")).toBe(false);
  });
});
