import { describe, expect, it } from "vitest";

import { projectOpenClawConfigStatus } from "../openclaw-config-status.js";

describe("projectOpenClawConfigStatus", () => {
  it("returns only the user-safe bounded status projection", () => {
    expect(projectOpenClawConfigStatus({
      configStatus: {
        state: "error",
        acceptedCommit: "abc123",
        lastSyncedAt: "2026-07-14T20:00:00.000Z",
        lastErrorCode: "secret-policy",
        configHash: "private-hash",
        rejectedPath: "/home/node/.openclaw/rejected/secret.json",
      },
    })).toEqual({
      state: "error",
      acceptedCommit: "abc123",
      lastSyncedAt: "2026-07-14T20:00:00.000Z",
      lastErrorCode: "secret-policy",
    });
  });

  it("omits absent, invalid, and oversized fields", () => {
    expect(projectOpenClawConfigStatus(null)).toBeUndefined();
    expect(projectOpenClawConfigStatus({ configStatus: { state: "future-state" } })).toBeUndefined();
    expect(projectOpenClawConfigStatus({
      configStatus: {
        state: "clean",
        acceptedCommit: "x".repeat(129),
        lastErrorCode: "x".repeat(81),
      },
    })).toEqual({ state: "clean" });
  });
});
