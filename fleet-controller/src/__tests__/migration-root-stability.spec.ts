import { describe, expect, it } from "vitest";

import {
  migrationSourceRootIsStable,
  migrationTargetRootIsStable,
} from "../migration-root-stability.js";

function root(overrides: Record<string, unknown> = {}) {
  return {
    desiredStatus: "running" as const,
    desiredRelease: 12,
    liveRelease: 12,
    ...overrides,
  };
}

describe("migration root stability", () => {
  it("allows a converged draining gateway only as a migration source", () => {
    const draining = root({ desiredStatus: "draining" });

    expect(migrationSourceRootIsStable(draining)).toBe(true);
    expect(migrationTargetRootIsStable(draining)).toBe(false);
  });

  it("rejects source and target roots with an unconverged release", () => {
    const rolling = root({ desiredRelease: 13 });

    expect(migrationSourceRootIsStable(rolling)).toBe(false);
    expect(migrationTargetRootIsStable(rolling)).toBe(false);
  });

  it("rejects a paused migration source", () => {
    expect(migrationSourceRootIsStable(root({ desiredStatus: "paused" }))).toBe(false);
  });
});
