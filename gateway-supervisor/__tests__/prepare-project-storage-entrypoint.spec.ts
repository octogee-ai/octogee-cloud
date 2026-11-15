import { describe, expect, it } from "vitest";
import { projectStorageSlug } from "../entrypoints/prepare-project-storage.js";
import { withUserClaim } from "./helpers/user-claim.js";

describe("prepare-project-storage entrypoint", () => {
  it("prepares project storage for the user named by the claim the VM agent wrote before init", () => {
    expect(projectStorageSlug(withUserClaim({}, "alice"))).toBe("alice");
  });

  it("refuses to run before a user claim exists instead of preparing an unnamed owner", () => {
    const unclaimed = { OPENCLAW_DIR: `${withUserClaim({}, "alice").OPENCLAW_DIR}-unclaimed`, GATEWAY_ID: "gw-test" };
    expect(() => projectStorageSlug(unclaimed)).toThrow(/user claim/);
  });
});
