import { describe, expect, it } from "vitest";
import type { OperationRecord, Stored } from "@octogee/core/platform-state";
import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { adminIsolatedCapabilities } from "../admin-isolated-capabilities.js";
import { adminPlacementCapabilities } from "../admin-placement-capabilities.js";
import { schedulerHandoffAwaitingRelease } from "../scheduler-handoff-release.js";

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

describe("source recovery verdict served to the placement client", () => {
  const activationId = builderActivateOperationId(GATEWAY, 1);
  const failedActivation = (fields: Record<string, unknown> = {}) => operation({
    id: activationId, kind: "migrate-user", status: "failed", schedulerHandoffReleased: true,
    input: { uid: "uid-alice", userSlug: "alice", source: "builder-activation-lease", fromGatewayId: "shared-a", toGatewayId: GATEWAY, recoverSourceOnly: true },
    schedulerHandoff: { migrationId: "m", fromGatewayId: "shared-a", toGatewayId: GATEWAY, uid: "uid-alice", slug: "alice", stageAfterCutover: true },
    ...fields,
  });
  const isolated = adminIsolatedCapabilities({ namespace: "octogee-test", log: () => undefined, readGatewayPodDiagnostics: async () => ({}) as never })!;

  it("reports a failed activation still recovering its source, as the in-process path reads it", () => {
    const recovering = failedActivation();

    expect(schedulerHandoffAwaitingRelease(recovering as unknown as Record<string, unknown>)).toBe(true);
    expect(adminPlacementCapabilities.schedulerHandoffAwaitingRelease(recovering)).toBe(true);
    expect(isolated.sourceRecoveryPending(recovering)).toBe(true);
  });

  it("clears once the activation rolled back", () => {
    const settled = failedActivation({ rolledBack: true });

    expect(schedulerHandoffAwaitingRelease(settled as unknown as Record<string, unknown>)).toBe(false);
    expect(adminPlacementCapabilities.schedulerHandoffAwaitingRelease(settled)).toBe(false);
    expect(isolated.sourceRecoveryPending(settled)).toBe(false);
  });

  it("hands the Admin API one reader for both the reads and the verbs", () => {
    expect(isolated.sourceRecoveryPending).toBe(adminPlacementCapabilities.schedulerHandoffAwaitingRelease);
  });
});

describe("adminPlacementCapabilities.rearmedRetirementPatch", () => {
  it("returns the retirement to pending with its attempt cleared", () => {
    expect(adminPlacementCapabilities.rearmedRetirementPatch).toMatchObject({ status: "pending", startedAt: null, completedAt: null, steps: [] });
  });
});
