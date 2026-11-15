import { describe, expect, it } from "vitest";
import { FIXTURE_SIZING_PROFILES } from "@octogee/core-testing/journal-store";
import type { GatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import type { PlatformUserRecord } from "../platform-state/users.js";
import {
  IsolatedGatewayFenceError,
  homePreparedBeforeAllocation,
  homePreparedForAllocation,
  requireStoredHomeReadiness,
  type AllocateIsolatedGatewayInput,
} from "./index.js";

const request = { uid: "uid-alice", leaseId: "lease-one", generation: 1, sizingKey: "hobby" } as AllocateIsolatedGatewayInput;
const podProfile: GatewaySizingProfile = {
  isolation: "isolated",
  sizingTier: "s",
  computer: { runtime: "cluster", homeSizeGiB: 10 } as never,
  fallbackStorageGb: null,
};

function user(homeMigration?: Record<string, unknown>): PlatformUserRecord {
  return { uid: "uid-alice", home: homeMigration ? { homeMigration } : {} } as unknown as PlatformUserRecord;
}

describe("home readiness for allocation", () => {
  it("needs no stored preparation for a profile without a VM home", () => {
    expect(homePreparedForAllocation({ user: user(), request, sizingProfile: podProfile })).toBe(true);
    expect(homePreparedForAllocation({ user: user(), request, sizingProfile: FIXTURE_SIZING_PROFILES.enterprise! })).toBe(true);
  });

  it("accepts a VM home only when a completed preparation names this lease, generation and sizing key", () => {
    const preparedFor = { leaseId: "lease-one", generation: 1, sizingKey: "hobby" };
    const profile = FIXTURE_SIZING_PROFILES.hobby!;

    expect(homePreparedForAllocation({ user: user({ phase: "complete", preparedFor }), request, sizingProfile: profile })).toBe(true);
    expect(homePreparedForAllocation({ user: user({ phase: "adopting", preparedFor }), request, sizingProfile: profile })).toBe(false);
    expect(homePreparedForAllocation({ user: user(), request, sizingProfile: profile })).toBe(false);
  });

  it("refuses through the stored fence and lets the in-process caller's ordering stand", () => {
    const input = { user: user(), request, sizingProfile: FIXTURE_SIZING_PROFILES.hobby! };

    expect(() => requireStoredHomeReadiness(input)).toThrow(IsolatedGatewayFenceError);
    expect(() => homePreparedBeforeAllocation(input)).not.toThrow();
  });
});
