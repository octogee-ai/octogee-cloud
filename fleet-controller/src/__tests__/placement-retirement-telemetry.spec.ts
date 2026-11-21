import type { PlatformUserRecord, Revision, Stored, WatchCursor, WatchEvent, WatchRecords } from "@octogee/core/platform-state";
import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { expect, it, vi } from "vitest";
import { createPlacementRetirementTelemetry } from "../placement-retirement-telemetry.js";

const cursor = "fixture-cursor" as WatchCursor;
const revision = "test-revision" as Revision;

function builder(uid: string, targetGatewayId: string, generation: number, settled = false): Stored<PlatformUserRecord> {
  return {
    uid, slug: null, mattermostUserId: null, admitted: false, persona: null, workspaceId: null, role: null,
    createdAt: 1, updatedAt: 1, provisioning: {}, gateway: null, openclaw: {},
    agents: { agentIds: [], activatedAgents: [] }, accountLifecycle: null, fences: {}, home: {}, revision,
    activationLease: { leaseId: `lease-${generation}`, generation, status: settled ? "failed" : "activating", targetGatewayId },
  };
}

function heartbeat(gatewayId: string, observedAt: number): WatchEvent<"fleetRegistry"> {
  const runtime: Stored<WatchRecords["fleetRegistry"]> = {
    gatewayId, revision, release: 1, lifecycle: "serving", createdAt: 1, createdByOperationId: null,
    helm: {
      releaseName: gatewayId, deploymentName: gatewayId, gatewayServiceName: gatewayId, gatewayEdgeServiceName: gatewayId,
      serviceAccountName: gatewayId, imageRepository: null, imageTag: null, replicas: 1, availableReplicas: 1, lastAppliedAt: 1,
    },
    heartbeat: {
      lastHeartbeatAt: observedAt, mountedCustomers: [], migratingIn: [], status: "ready", version: null,
      openclawVersion: null, internalUrl: null, startedAt: null,
    },
    lastError: { message: null, at: null },
  };
  return { kind: "changes", cursor, changes: [{ type: "modified", key: gatewayId, record: runtime }] };
}

function rollback(id: string, uid: string, completedAt: number): Stored<WatchRecords["operations"]> {
  return {
    id, kind: "migrate-user", status: "rolled-back", input: { uid }, createdBy: "test",
    createdAt: completedAt - 100, startedAt: completedAt - 50, completedAt, steps: [], revision,
  };
}

it("forgets retired leases and wakes only once for each eligible fence on a long-lived stream", async () => {
  const now = Date.now();
  const journal = new Map<string, Stored<WatchRecords["operations"]>>();
  const get = vi.fn(async (id: string) => journal.get(id) ?? null);
  const wake = vi.fn();
  const tracker = createPlacementRetirementTelemetry({ get }, wake, vi.fn());
  const changeBuilder = (record: Stored<PlatformUserRecord>) => tracker.builders({
    kind: "changes", cursor, changes: [{ type: "modified", key: record.uid, record }],
  });
  for (let index = 0; index < 50; index++) {
    const uid = `user-${index}`;
    const gatewayId = `gateway-${index}`;
    const operationId = builderActivateOperationId(gatewayId, 1);
    journal.set(operationId, rollback(operationId, uid, now - 20));
    changeBuilder(builder(uid, gatewayId, 1));
    await Promise.resolve();
    expect(tracker.runtime(heartbeat(gatewayId, now - 10))).toBe(true);
    expect(tracker.runtime(heartbeat(gatewayId, now - 9))).toBe(false);
    changeBuilder(builder(uid, gatewayId, 1, true));
    expect(tracker.runtime(heartbeat(gatewayId, now - 8))).toBe(false);
  }
  changeBuilder(builder("user-0", "gateway-0", 2));
  await Promise.resolve();
  expect(tracker.runtime(heartbeat("gateway-0", now - 10))).toBe(false);
  const operationId = builderActivateOperationId("gateway-0", 2);
  const record = rollback(operationId, "user-0", now - 5);
  tracker.operations({ kind: "changes", cursor, changes: [{ type: "modified", key: operationId, record }] });
  expect(tracker.runtime(heartbeat("gateway-0", now - 5))).toBe(false);
  expect(tracker.runtime(heartbeat("gateway-0", now - 4))).toBe(true);
  tracker.clear();
  expect(tracker.runtime(heartbeat("gateway-0", now - 3))).toBe(false);
  expect(get).toHaveBeenCalledTimes(51);
  expect(wake).not.toHaveBeenCalled();
});
