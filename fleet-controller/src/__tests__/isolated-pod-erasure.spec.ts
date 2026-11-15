import { describe, expect, it, vi } from "vitest";
import { verifyGatewayRetirementClaimAtomic } from "@octogee/core/gateway-retirement-claim";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";

import { createRetireGatewayHandler } from "../handlers/retire-gateway.js";
import { readMountedUsers } from "../heartbeat-relocation.js";
import { pausedIsolatedRetirementSourceFencedOff } from "../lib/native-retirement-telemetry.js";
import { ensureOwnedGatewaysRetired } from "../lib/user-ops/user-gateway-retirement.js";

const GATEWAY_ID = "alice-s-0a1b2c3d";
const UID = "uid-alice";
const DELETION_ID = "delete-1";
const NOW = 1_000_000;

function parkedPodGateway() {
  return createDocumentFixtureStore({
    [`gateways/${GATEWAY_ID}`]: {
      gatewayId: GATEWAY_ID, createdAt: 1, createdBy: "operator", updatedAt: 1, updatedBy: "operator",
      latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "paused", configSchemaVersion: 1,
      profile: null, gatewayClass: "isolated", imageProfile: "isolated", sizingTier: "s", gcpProject: null,
      gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
      ownerUid: UID, builderSlug: "alice", modelBrokerLimits: null, preemption: null, coOwnerUids: [],
      allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "operator-issued", generation: 1, claimedByUid: UID },
    },
    [`glmGateways/${GATEWAY_ID}`]: {
      docKind: "runtime", gatewayId: GATEWAY_ID, runtime: "cluster", release: 1, lifecycle: "serving",
      createdAt: 1, createdByOperationId: null, helm: {}, lastError: { message: null, at: null },
      heartbeat: { status: "ready", lastHeartbeatAt: 1, version: "abc1234", startedAt: 1, mountedCustomers: ["alice"] },
    },
  });
}

async function eraseUserGateway(store: ReturnType<typeof parkedPodGateway>, podsAbsent: () => Promise<boolean>) {
  expect(await ensureOwnedGatewaysRetired({ store, uid: UID, deletionId: DELETION_ID, now: NOW })).toBe("retirement-pending");
  const root = await store.gateways.roots.get(GATEWAY_ID);
  const claim = root?.retirementClaim as { operationId: string; version: number };
  const operation = await store.journal.operations.get(claim.operationId) as Operation;
  const deletePvc = vi.fn(async (_gatewayId: string) => {});
  const helmUninstall = vi.fn(async (_gatewayId: string) => {});
  const steps: OperationStep[] = [];
  const result = await createRetireGatewayHandler({
    verifyRetirementClaim: (input) => verifyGatewayRetirementClaimAtomic({ store, ...input, now: NOW, updatedBy: "test" }),
    isPausedIsolatedSourceFencedOff: (input) => pausedIsolatedRetirementSourceFencedOff({
      store, podsAbsent, describe: async () => { throw new Error("a pod gateway has no Compute instance"); },
    }, input),
    readMountedUsers: async (gatewayId) => {
      const runtime = await store.fleetRegistry.get(gatewayId);
      return runtime === null ? [] : readMountedUsers(runtime as unknown as Record<string, unknown>);
    },
    readAssignmentsForGateway: async () => [],
    helmUninstallGateway: helmUninstall,
    revokeAgentStoreCredentials: async (_gatewayId, assertCurrent) => { await assertCurrent(); },
    deleteGlmGateway: async () => {},
    deleteGatewayPersistentVolumeClaim: deletePvc,
    deleteGatewayKubeSecret: async () => {},
    deleteAuthTokenSecret: async () => {},
    deleteGatewayServiceAccount: async () => {},
    deleteGatewayModelKeyKubeSecret: async () => {},
    deleteGatewayModelKeySource: async () => {},
    syncFleetIngress: async () => {},
    pollIntervalMs: 1,
    now: () => NOW,
    wait: async () => {},
    log: () => {},
  })(operation, { reportStep: async (step) => { steps.push(step); } });
  return { result, deletePvc, helmUninstall, root };
}

describe("erasing a user whose isolated gateway is a parked pod", () => {
  it("retires the gateway and deletes its home claim, ignoring the user its last heartbeat still lists", async () => {
    const store = parkedPodGateway();

    const { result, deletePvc, helmUninstall, root } = await eraseUserGateway(store, async () => true);

    expect(root).toMatchObject({ desiredStatus: "retired", retirementClaim: { previousDesiredStatus: "paused", phase: "claimed" } });
    expect(result).toMatchObject({ success: true });
    expect(helmUninstall).toHaveBeenCalledWith(GATEWAY_ID);
    expect(deletePvc).toHaveBeenCalledWith(GATEWAY_ID);
  });

  it("keeps the home claim and fails the retirement for a retry while a pod of the gateway remains", async () => {
    const store = parkedPodGateway();

    const { result, deletePvc, helmUninstall } = await eraseUserGateway(store, async () => false);

    expect(result).toMatchObject({ success: false, error: expect.stringContaining("still has 1 mounted user(s): alice") });
    expect(helmUninstall).not.toHaveBeenCalled();
    expect(deletePvc).not.toHaveBeenCalled();
  });
});
