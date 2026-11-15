import { describe, expect, it } from "vitest";
import type { OperationRecord, Stored } from "@octogee/core/platform-state";
import { adminPlacementCapabilities } from "../admin-placement-capabilities.js";

const GATEWAY = "alice-xs-12345678";

function operation(fields: Record<string, unknown>): Stored<OperationRecord> {
  return { id: "op", kind: "retire-gateway", createdBy: "test", createdAt: 1, input: {}, steps: [], ...fields } as unknown as Stored<OperationRecord>;
}

describe("adminPlacementCapabilities.retirementFailedRetryably", () => {
  it.each([
    ["a reaped failure", { status: "failed", error: "reaped: op exceeded 15m running budget" }, true],
    ["a failure on this gateway's draining database sessions", {
      status: "failed",
      error: `agent-store credential retirement failed (records preserved for retry): Agent-store Gateway ${GATEWAY} still has database sessions`,
    }, true],
    ["a failure on another gateway's draining database sessions", {
      status: "failed",
      error: "agent-store credential retirement failed (records preserved for retry): Agent-store Gateway shared-foreign still has database sessions",
    }, false],
    ["a failure on its own merits", { status: "failed", error: "helm uninstall failed: release is stuck" }, false],
    ["a running retirement carrying a reaped error", { status: "running", error: "reaped: earlier attempt" }, false],
  ])("classifies %s", (_name, fields, expected) => {
    expect(adminPlacementCapabilities.retirementFailedRetryably(operation(fields), GATEWAY)).toBe(expected);
  });
});

describe("adminPlacementCapabilities.schedulerHandoffAwaitingRelease", () => {
  const handoff = { migrationId: "m", fromGatewayId: "shared-a", toGatewayId: GATEWAY, uid: "uid-alice", slug: "alice" };

  it("reports an unsettled operation whose handoff is not released", () => {
    expect(adminPlacementCapabilities.schedulerHandoffAwaitingRelease(operation({
      kind: "migrate-user", status: "failed", schedulerHandoffReleased: false, schedulerHandoff: handoff,
    }))).toBe(true);
  });

  it("does not report a released handoff", () => {
    expect(adminPlacementCapabilities.schedulerHandoffAwaitingRelease(operation({
      kind: "migrate-user", status: "failed", schedulerHandoffReleased: true, schedulerHandoff: handoff,
    }))).toBe(false);
  });
});

describe("adminPlacementCapabilities.rearmedRetirementPatch", () => {
  it("returns the retirement to pending with its attempt cleared", () => {
    expect(adminPlacementCapabilities.rearmedRetirementPatch).toMatchObject({ status: "pending", startedAt: null, completedAt: null, steps: [] });
  });
});
