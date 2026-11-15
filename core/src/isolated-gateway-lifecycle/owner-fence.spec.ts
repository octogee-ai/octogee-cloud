import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import {
  advanceActivationLease,
  allocateIsolatedGateway,
  auditedLifecycleMutations,
  completeActivationLease,
  failActivationLease,
  recoverUnreachableIsolatedGateway,
  refreshRequestedAllocation,
  requestSizingKeyTransition,
  retireOwnedIsolatedGateway,
  requireStoredHomeReadiness,
} from "./index.js";

const TARGET = "alice-xs-12345678";

function harness(status: string, gatewayId: string) {
  const docs = new Map<string, Record<string, unknown>>([
    ["users/uid-alice", {
      username: "alice",
      provisioning: { status: "complete", openclaw: { gatewayId, slug: "alice", activationLease: {
        leaseId: "lease-one", generation: 1, status, targetGatewayId: TARGET, builderSlug: "alice", sourceGatewayId: "shared-blue",
        sourceAssignmentEpoch: 4, entitlementTier: "hobby", sizingTier: "s", requestedAt: 1, activationOperationId: `builder-activate-${TARGET}-g1`,
      } } },
    }],
    [`gateways/${TARGET}`, {
      gatewayId: TARGET, createdAt: 1, createdBy: "test", updatedAt: 5, updatedBy: "test", latestRelease: 1, desiredRelease: 1,
      liveRelease: 1, desiredStatus: "paused", configSchemaVersion: 1, profile: null, gatewayClass: "isolated", imageProfile: "isolated",
      sizingTier: "s", sizingProfile: "hobby", gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null,
      serviceAccount: null, builderAccess: null, ownerUid: "uid-alice", builderSlug: "alice", modelBrokerLimits: null,
      allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-one", generation: 1, claimedByUid: "uid-alice" },
    }],
  ]);
  const refusal = new Error("placement automation is owned by fleet-controller");
  const store = createDocumentFixtureStore(docs);
  const ensureAuthSecret = vi.fn(async () => undefined);
  const readGatewayPodDiagnostics = vi.fn(async () => ({ status: "missing", totalPods: 0 }));
  const deps = {
    store,
    readSizingKey: async () => "hobby",
    now: () => 5_000,
    log: vi.fn(),
    requireOwner: async () => { throw refusal; },
    mutations: auditedLifecycleMutations(store),
    requireHomeReady: requireStoredHomeReadiness,
    namespace: "octogee-test",
    ensureAuthSecret,
    readGatewayPodDiagnostics,
  };
  const before = new Map([...docs].map(([path, row]) => [path, structuredClone(row)]));
  return { docs, deps, refusal, before, ensureAuthSecret, readGatewayPodDiagnostics };
}

type Deps = ReturnType<typeof harness>["deps"];
const lease = { uid: "uid-alice", leaseId: "lease-one", generation: 1 };
const allocation = { ...lease, builderSlug: "alice", sourceGatewayId: "shared-blue", sourceAssignmentEpoch: 4, sizingKey: "hobby", sizingTier: "s" as const };

describe("isolated lifecycle owner fence", () => {
  it.each([
    ["advance", "activating", "shared-blue", (deps: Deps) =>
      advanceActivationLease(deps, { ...lease, fromStatus: "activating", toStatus: "active" })],
    ["complete", "returning", "shared-blue", (deps: Deps) =>
      completeActivationLease(deps, { ...lease, targetGatewayId: TARGET })],
    ["fail", "activating", "shared-blue", (deps: Deps) =>
      failActivationLease(deps, { ...lease, targetGatewayId: TARGET, operationId: "op", message: "failed" })],
    ["sizing transition", "active", TARGET, (deps: Deps) =>
      requestSizingKeyTransition(deps, { ...lease, targetGatewayId: TARGET, sizingKey: "hobby" })],
    ["allocation refresh", "requested", "shared-green", (deps: Deps) =>
      refreshRequestedAllocation(deps, allocation)],
    ["allocation", "requested", "shared-blue", (deps: Deps) =>
      allocateIsolatedGateway(deps, allocation)],
    ["retirement", "parked", "shared-blue", (deps: Deps) =>
      retireOwnedIsolatedGateway(deps, { uid: "uid-alice", builderSlug: "alice", gatewayId: TARGET, generation: 1, reason: "builder-returned" })],
    ["retirement behind an incomplete telemetry fence", "parked", "shared-blue", (deps: Deps) =>
      retireOwnedIsolatedGateway(deps, {
        uid: "uid-alice", builderSlug: "alice", gatewayId: TARGET, generation: 1, reason: "builder-returned",
        telemetryFenceOperationId: "missing-return", telemetryFenceStatus: "succeeded",
      })],
    ["unreachable recovery", "returning", "shared-blue", (deps: Deps) =>
      recoverUnreachableIsolatedGateway(deps, {
        uid: "uid-alice", builderSlug: "alice", gatewayId: TARGET, leaseId: "lease-one", generation: 1, authoritativeGatewayId: "shared-blue",
      })],
  ] as const)("refuses %s and writes nothing, audit rows included, while another owner holds placement automation", async (_name, status, gatewayId, run) => {
    const h = harness(status, gatewayId);

    await expect(run(h.deps)).rejects.toBe(h.refusal);

    expect(new Map(h.docs)).toEqual(h.before);
    expect(h.ensureAuthSecret).not.toHaveBeenCalled();
    expect(h.readGatewayPodDiagnostics).not.toHaveBeenCalled();
  });
});
