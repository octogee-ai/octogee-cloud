import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "@octogee/core/testing/journal-store";

import {
  createFirestorePlacementPolicyReconcilerDeps,
  reconcilePlacementPolicyOnce,
  type PlacementPolicyGateway,
  type PlacementPolicyReconcilerDeps,
  type PlacementPolicySnapshot,
} from "../placement-policy-reconciler.js";

const SHARED = "shared-blue";
const GIVEN = "lin-s-0a1b2c3d";
const UID = "uid-lin";

const sharedGateway: PlacementPolicyGateway = {
  gatewayId: SHARED, gatewayClass: "shared", ownerUid: null, desiredStatus: "running", ready: true, disposable: false,
};

function givenGateway(overrides: Partial<PlacementPolicyGateway> = {}): PlacementPolicyGateway {
  return {
    gatewayId: GIVEN, gatewayClass: "isolated", ownerUid: UID, desiredStatus: "running", ready: true, disposable: true,
    allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "operator-issued", generation: 1, claimedByUid: UID },
    assignmentCount: 1, mountedCustomers: ["lin"], configuredBuilder: { state: "claimed", generation: 1 },
    ...overrides,
  };
}

function user(gatewayId: string, held: boolean) {
  return {
    uid: UID,
    data: {
      admitted: true,
      username: "lin",
      provisioning: {
        status: "complete",
        openclaw: { gatewayId, slug: "lin", status: "complete", ...(held ? { managedBy: "operator" } : {}) },
      },
    },
  };
}

function fleet(input: { on: string; held: boolean; given?: PlacementPolicyGateway }): PlacementPolicySnapshot {
  return {
    defaultGatewayId: SHARED,
    sharedGatewayIds: [SHARED],
    sizingProfiles: FIXTURE_SIZING_PROFILES,
    platformCurrentGatewayIds: [],
    sharedPoolReplacements: [],
    users: [user(input.on, input.held)],
    gateways: [sharedGateway, input.given ?? givenGateway()],
    assignments: [{ gatewayId: input.on, uid: UID, slug: "lin", state: "serving", epoch: 4, createdAt: 1 }],
    activeMigrations: [],
  };
}

function harness(state: PlacementPolicySnapshot) {
  const acts = {
    assignInitialPlacement: vi.fn(async () => undefined),
    recoverUnavailableGateway: vi.fn(async (request: { operationId: string }) => ({ operationId: request.operationId })),
    recoverDisposableRuntimeReset: vi.fn(async (request: { operationId: string }) => ({ operationId: request.operationId })),
    supersedeRollingSharedGateway: vi.fn(async () => ({ kind: "scheduled" as const, release: 2, operationId: "roll-1" })),
    enqueueMigration: vi.fn(async () => "op-placement-1"),
  };
  const deps: PlacementPolicyReconcilerDeps = {
    now: vi.fn(() => 10 * 60 * 60 * 1000),
    log: vi.fn(),
    debug: vi.fn(),
    readSnapshot: vi.fn(async () => state),
    decidePlacementAdmission: vi.fn(async () => ({ kind: "admitted" as const })),
    deleteRetiredDisposableGateway: vi.fn(async () => false),
    ...acts,
  };
  return { deps, acts };
}

describe("a user an operator gave an isolated gateway", () => {
  const empty = { assignmentCount: 0, mountedCustomers: [] };
  it.each([
    ["creating: the user is on shared while the VM boots", fleet({ on: SHARED, held: true, given: givenGateway({ ...empty, ready: false }) })],
    ["ready with nobody on it", fleet({ on: SHARED, held: true, given: givenGateway(empty) })],
    ["serving, long idle", fleet({ on: GIVEN, held: true })],
    ["parked with the user still on it", fleet({ on: GIVEN, held: true, given: givenGateway({ desiredStatus: "paused", ready: false, mountedCustomers: [] }) })],
    ["returned: the user is on shared and the VM is parked", fleet({ on: SHARED, held: true, given: givenGateway({ ...empty, desiredStatus: "paused", ready: false }) })],
    ["retired", fleet({ on: SHARED, held: true, given: givenGateway({ ...empty, desiredStatus: "retired", ready: false }) })],
  ])("is left alone by the placement pass: %s", async (_name, state) => {
    const { deps, acts } = harness(state);

    const result = await reconcilePlacementPolicyOnce(deps);

    for (const [name, act] of Object.entries(acts)) expect(act, name).not.toHaveBeenCalled();
    expect(result).toEqual({ assigned: 0, enqueued: 0, adopted: 0, retired: 0, swept: 0, blocked: 0 });
  });

  it("has the record of its retired gateway kept: the sweep asks, and the operator's retire is not the one it deletes for", async () => {
    const { deps } = harness(fleet({ on: SHARED, held: true, given: givenGateway({ ...empty, desiredStatus: "retired", ready: false }) }));

    await reconcilePlacementPolicyOnce(deps);

    expect(deps.deleteRetiredDisposableGateway).toHaveBeenCalledExactlyOnceWith({ gatewayId: GIVEN, ownerUid: UID, generation: 1 });

    const operatorRetire = "5d0a3c1e-9f6b-4a53-8a0e-2b7c1d4e6f90";
    const records = new Map<string, Record<string, unknown>>(Object.entries({
      [`gateways/${GIVEN}`]: {
        gatewayId: GIVEN, createdAt: 1, createdBy: "operator", updatedAt: 2, updatedBy: "operator",
        latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "retired", configSchemaVersion: 1,
        profile: null, gatewayClass: "isolated", imageProfile: "isolated", sizingTier: "s", gcpProject: null,
        gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
        ownerUid: UID, builderSlug: "lin", modelBrokerLimits: null, preemption: null, coOwnerUids: [],
        allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "operator-issued", generation: 1, claimedByUid: UID },
        retirementClaim: { operationId: operatorRetire }, retirementVersion: 1,
      },
      [`glmOperations/${operatorRetire}`]: {
        kind: "retire-gateway", status: "succeeded", createdBy: "operator", createdAt: 2, startedAt: 3, completedAt: 4,
        input: { gatewayId: GIVEN }, steps: [], gatewayId: GIVEN,
      },
      [`users/${UID}`]: { username: "lin", provisioning: { status: "complete", openclaw: { gatewayId: SHARED, slug: "lin", status: "complete", managedBy: "operator" } } },
    }));
    const real = createFirestorePlacementPolicyReconcilerDeps({
      store: createDocumentFixtureStore(records), now: () => 5_000, log: vi.fn(),
    } as unknown as Parameters<typeof createFirestorePlacementPolicyReconcilerDeps>[0]);

    await expect(real.deleteRetiredDisposableGateway({ gatewayId: GIVEN, ownerUid: UID, generation: 1 })).resolves.toBe(false);
    expect(records.get(`gateways/${GIVEN}`)).toMatchObject({ desiredStatus: "retired" });
  });

  function withAutomation(state: PlacementPolicySnapshot) {
    const { deps, acts } = harness(state);
    const reconcileUser = vi.fn(async () => false);
    deps.isolatedGateways = { readPass: async () => ({ operations: [], reconcileUser }) };
    return { deps, acts, reconcileUser };
  }

  it("is never handed to the product's isolated gateway automation", async () => {
    const { deps, reconcileUser } = withAutomation(fleet({ on: GIVEN, held: true }));

    await reconcilePlacementPolicyOnce(deps);

    expect(reconcileUser).not.toHaveBeenCalled();
  });

  it("is handed to that automation once the hold is gone", async () => {
    const { deps, reconcileUser } = withAutomation(fleet({ on: GIVEN, held: false }));

    await reconcilePlacementPolicyOnce(deps);

    expect(reconcileUser).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ user: expect.objectContaining({ uid: UID }), current: GIVEN }));
  });
});
