import { describe, expect, it, vi } from "vitest";
import { MalformedRecordError, type UserActivationLease } from "../platform-state/index.js";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "@octogee/core-testing/journal-store";

import {
  activationLeaseAdvanceAlreadyApplied,
  allocateIsolatedGateway,
  advanceActivationLease,
  buildIsolatedGatewayConfig,
  completeActivationLease,
  sharedSourceRelease,
  bootRepairedParkedGateway,
  finishParkedGatewayPrewarm,
  startParkedGatewayPrewarm,
  isolatedAllocationFenceAllows,
  failActivationLease,
  nextActivationLease,
  nextCompletedActivationLease,
  nextFailedActivationLease,
  homePreparedBeforeAllocation,
  unauditedLifecycleMutations,
} from "./index.js";
import { releasePayloadHash, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { isolatedBootMode } from "../isolated-prelaunch.js";
import { SourceRecoveryPendingError } from "../placement-refusal.js";


const request = {
  uid: "uid-alice",
  builderSlug: "alice",
  leaseId: "lease-one",
  generation: 1,
  sourceGatewayId: "shared-blue",
  sourceAssignmentEpoch: 4,
  sizingKey: "hobby" as const,
  sizingTier: "s" as const,
};

function userData() {
  return {
    onboardingStep: "complete",
    username: "alice",
    provisioning: {
      status: "complete",
      openclaw: {
        gatewayId: "shared-blue",
        slug: "alice",
        activationLease: {
          leaseId: "lease-one",
          generation: 1,
          status: "requested",
          sourceGatewayId: "shared-blue",
          sourceAssignmentEpoch: 4,
          entitlementTier: "hobby",
          sizingTier: "s",
        },
      },
    },
    trialGrant: {
      schemaVersion: 3,
      offerId: "builder-signup",
      offerVersion: 1,
      personalTier: "personal",
      builderTier: "hobby",
      configHash: "trial-hash",
      claimedAt: 1_000,
      endsAt: 7 * 24 * 60 * 60 * 1000,
    },
  };
}

async function userOf(data: Record<string, unknown>) {
  return (await createDocumentFixtureStore({ "users/uid-alice": data }).users.records.get("uid-alice"))!;
}

function assignmentDoc(epoch: number) {
  return { uid: "uid-alice", slug: "alice", gatewayId: "shared-blue", source: "onboarding", state: "serving", epoch, createdAt: 1, updatedAt: 1 };
}

async function assignmentOf(epoch: number) {
  return createDocumentFixtureStore({
    "gateways/shared-blue/assignments/uid-alice": assignmentDoc(epoch),
  }).gateways.assignments.get("shared-blue", "uid-alice");
}

const requireOwner = async () => undefined;
const hobbyTier = async () => "hobby" as const;
const noTier = async () => null;

function sharedSourceRoot() {
  return {
    gatewayId: "shared-blue",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 3,
    desiredRelease: 3,
    liveRelease: 3,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "standard",
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
    allocation: null,
  };
}

describe("isolated gateway lifecycle persistence", () => {
  it("copies only the configured shared gateway's converged live release", () => {
    const root = sharedSourceRoot();
    expect(sharedSourceRelease(root, "shared-blue")).toBe(3);
    expect(sharedSourceRelease({
      ...root,
      latestRelease: 4,
      desiredRelease: 4,
    }, "shared-blue")).toBeNull();
  });

  it("builds an explicitly sized owner-bound isolated gateway", () => {
    expect(buildIsolatedGatewayConfig("run-alice-12345678", request)).toEqual({
      configSchemaVersion: 1,
      profile: null,
      gatewayClass: "isolated",
      imageProfile: "isolated",
      sizingTier: "s",
      sizingProfile: "hobby",
      gcpProject: null,
      gatewayContainerSecurityContext: null,
      serviceAccountName: "octogee-gw-run-alice-12345678",
      serviceAccount: {
        create: true,
      },
      builderAccess: {
        controlUiEnabled: true,
        controlIdentity: "per-user",
        kubeApiServerEgressCidrs: [],
        reason: "disposable-builder-runtime",
      },
      ownerUid: "uid-alice",
      builderSlug: "alice",
      modelBrokerLimits: null,
      allocation: {
        kind: "disposable-builder",
        schemaVersion: 1,
        leaseId: "lease-one",
        generation: 1,
        claimedByUid: "uid-alice",
      },
    });
  });

  it("allows allocation only while the exact demand source still serves the user", async () => {
    expect(isolatedAllocationFenceAllows({
      request,
      configuredSharedGatewayIds: ["shared-primary", "shared-blue"],
      user: await userOf(userData()),
      sizingKey: "hobby",
      sizingProfile: FIXTURE_SIZING_PROFILES["hobby"],
      assignment: await assignmentOf(4),
    })).toBe(true);

    expect(isolatedAllocationFenceAllows({
      request,
      configuredSharedGatewayIds: ["shared-primary", "shared-blue"],
      user: await userOf(userData()),
      sizingKey: "hobby",
      sizingProfile: FIXTURE_SIZING_PROFILES["hobby"],
      assignment: await assignmentOf(5),
    })).toBe(false);
  });

  it("rejects a stale lease generation or an entitlement-derived size mismatch", async () => {
    expect(isolatedAllocationFenceAllows({
      request: { ...request, generation: 2 },
      configuredSharedGatewayIds: ["shared-primary", "shared-blue"],
      user: await userOf(userData()),
      sizingKey: "hobby",
      sizingProfile: FIXTURE_SIZING_PROFILES["hobby"],
      assignment: await assignmentOf(4),
    })).toBe(false);
    expect(isolatedAllocationFenceAllows({
      request: { ...request, sizingTier: "m" },
      configuredSharedGatewayIds: ["shared-primary", "shared-blue"],
      user: await userOf(userData()),
      sizingKey: "hobby",
      sizingProfile: FIXTURE_SIZING_PROFILES["hobby"],
      assignment: await assignmentOf(4),
    })).toBe(false);
    expect(isolatedAllocationFenceAllows({
      request,
      configuredSharedGatewayIds: ["shared-primary", "shared-green"],
      user: await userOf(userData()),
      sizingKey: "hobby",
      sizingProfile: FIXTURE_SIZING_PROFILES["hobby"],
      assignment: await assignmentOf(4),
    })).toBe(false);
  });

  it("matches the allocation source on the user's stored slug, not a differing username", async () => {
    const renamed = userData();
    renamed.provisioning.openclaw.slug = "alice-renamed";
    expect(isolatedAllocationFenceAllows({
      request,
      configuredSharedGatewayIds: ["shared-primary", "shared-blue"],
      user: await userOf(renamed),
      sizingKey: "hobby",
      sizingProfile: FIXTURE_SIZING_PROFILES["hobby"],
      assignment: await assignmentOf(4),
    })).toBe(false);
  });

  it("rejects an unknown persisted entitlement tier through the allocation fence", async () => {
    const malformedRequest = {
      ...request,
      sizingKey: "legacy",
    } as unknown as typeof request;
    expect(isolatedAllocationFenceAllows({
      request: malformedRequest,
      configuredSharedGatewayIds: ["shared-primary", "shared-blue"],
      user: await userOf(userData()),
      sizingKey: "hobby",
      sizingProfile: FIXTURE_SIZING_PROFILES["hobby"],
      assignment: await assignmentOf(4),
    })).toBe(false);
  });

  it("advances only the exact lease generation and records its migration", () => {
    const lease: UserActivationLease = {
      leaseId: "lease-one",
      generation: 1,
      status: "provisioning",
      targetGatewayId: "run-alice-12345678",
    };
    expect(nextActivationLease(lease, {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      fromStatus: "provisioning",
      toStatus: "activating",
      operationId: "op-move-in",
    }, 3_000)).toEqual({
      ...lease,
      status: "activating",
      activationOperationId: "op-move-in",
      activatingAt: 3_000,
    });
    expect(nextActivationLease(lease, {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 2,
      fromStatus: "provisioning",
      toStatus: "activating",
      operationId: "op-wrong-generation",
    }, 3_000)).toBeNull();
    expect(nextActivationLease({
      ...lease,
      status: "active",
    }, {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      fromStatus: "active",
      toStatus: "returning",
      operationId: "op-return",
    }, 4_000)).toEqual({
      ...lease,
      status: "returning",
      returnOperationId: "op-return",
      returningAt: 4_000,
    });
    expect(activationLeaseAdvanceAlreadyApplied({
      ...lease,
      status: "activating",
      activationOperationId: "op-move-in",
    }, {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      fromStatus: "provisioning",
      toStatus: "activating",
      operationId: "op-move-in",
    })).toBe(true);
    expect(activationLeaseAdvanceAlreadyApplied({
      ...lease,
      status: "activating",
      activationOperationId: "op-other",
    }, {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      fromStatus: "provisioning",
      toStatus: "activating",
      operationId: "op-move-in",
    })).toBe(false);
  });

  it("consumes pending demand into one fresh generation after parking", async () => {
    const lease: UserActivationLease = {
      leaseId: "lease-one",
      generation: 1,
      status: "returning",
      targetGatewayId: "run-alice-12345678",
      pendingDemand: {
        eventKey: "mattermost-post-2",
        cause: "run-start",
        observedAt: 4_500,
      },
    };
    expect(nextCompletedActivationLease({
      lease,
      user: await userOf(userData()),
      sizingKey: "hobby",
      sizingProfile: FIXTURE_SIZING_PROFILES["hobby"],
      sourceGatewayId: "shared-blue",
      sourceAssignmentEpoch: 7,
      nextLeaseId: "lease-two",
      now: 5_000,
    })).toEqual({
      leaseId: "lease-two",
      generation: 2,
      status: "requested",
      cause: "run-start",
      eventKey: "mattermost-post-2",
      requestedAt: 5_000,
      lastActiveAt: 4_500,
      requestedBy: "pending-return-demand",
      builderSlug: "alice",
      sourceGatewayId: "shared-blue",
      sourceAssignmentEpoch: 7,
      entitlementTier: "hobby",
      sizingTier: "s",
    });
  });

  it("parks with a terminal diagnostic when entitlement lapses during return", async () => {
    const lease: UserActivationLease = {
      leaseId: "lease-one",
      generation: 1,
      status: "returning",
      targetGatewayId: "run-alice-12345678",
      pendingDemand: {
        eventKey: "mattermost-post-2",
        cause: "run-start",
        observedAt: 4_500,
      },
    };
    expect(nextCompletedActivationLease({
      lease,
      user: await userOf(userData()),
      sizingKey: null,
      sizingProfile: null,
      sourceGatewayId: "shared-blue",
      sourceAssignmentEpoch: 7,
      nextLeaseId: "lease-two",
      now: 5_000,
    })).toEqual({
      ...lease,
      status: "parked",
      parkedAt: 5_000,
      lastError: {
        at: 5_000,
        code: "pending-demand-not-entitled",
        message: "pending demand was parked because user entitlement ended",
      },
    });
  });

  it("parks Enterprise pending demand as manual-size-required", async () => {
    const lease: UserActivationLease = {
      leaseId: "lease-one",
      generation: 1,
      status: "returning",
      targetGatewayId: "run-alice-12345678",
      pendingDemand: {
        eventKey: "mattermost-post-2",
        cause: "run-start",
        observedAt: 4_500,
      },
    };
    expect(nextCompletedActivationLease({
      lease,
      user: await userOf(userData()),
      sizingKey: "enterprise",
      sizingProfile: FIXTURE_SIZING_PROFILES["enterprise"],
      sourceGatewayId: "shared-blue",
      sourceAssignmentEpoch: 7,
      nextLeaseId: "lease-two",
      now: 5_000,
    })).toMatchObject({
      status: "parked",
      lastError: {
        code: "pending-demand-manual-size-required",
        message: "pending demand requires an operator-selected instance size",
      },
    });
  });

  it("parks malformed pending demand with a terminal diagnostic", async () => {
    const lease: UserActivationLease = {
      leaseId: "lease-one",
      generation: 1,
      status: "returning",
      targetGatewayId: "run-alice-12345678",
      pendingDemand: {
        cause: "run-start",
        observedAt: 4_500,
      },
    };

    expect(nextCompletedActivationLease({
      lease,
      user: await userOf(userData()),
      sizingKey: "hobby",
      sizingProfile: FIXTURE_SIZING_PROFILES["hobby"],
      sourceGatewayId: "shared-blue",
      sourceAssignmentEpoch: 7,
      nextLeaseId: "lease-two",
      now: 5_000,
    })).toEqual({
      ...lease,
      status: "parked",
      parkedAt: 5_000,
      lastError: {
        at: 5_000,
        code: "pending-demand-invalid",
        message: "pending return demand was malformed",
      },
    });
  });

  it("records a visible terminal move-in failure on the exact lease", () => {
    expect(nextFailedActivationLease({
      leaseId: "lease-one",
      generation: 1,
      status: "activating",
      targetGatewayId: "run-alice-12345678",
    }, {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      targetGatewayId: "run-alice-12345678",
      operationId: "builder-activate-run-alice-12345678-g1",
      message: "target prepare failed",
    }, 6_000)).toEqual({
      leaseId: "lease-one",
      generation: 1,
      status: "failed",
      targetGatewayId: "run-alice-12345678",
      failedAt: 6_000,
      lastError: {
        at: 6_000,
        code: "activation-migration-failed",
        message: "target prepare failed",
        operationId: "builder-activate-run-alice-12345678-g1",
      },
    });
  });
});

function fixtureFirestore(seed: Record<string, Record<string, unknown>>) {
  const docs = new Map(Object.entries(seed));
  return { state: createDocumentFixtureStore(docs), docs };
}

function runtimeDoc(gatewayId: string, runtime: string) {
  return { docKind: "runtime", gatewayId, release: 1, lifecycle: "serving", runtime };
}

function leaseUserDoc(lease: Record<string, unknown>): Record<string, unknown> {
  return {
    username: "alice",
    provisioning: {
      status: "complete",
      openclaw: {
        gatewayId: "shared-blue",
        slug: "alice",
        activationLease: lease,
      },
    },
  };
}

const activatingLease = {
  leaseId: "lease-one",
  generation: 1,
  status: "activating",
  cause: "run-start",
  builderSlug: "alice",
  sourceGatewayId: "shared-blue",
  sourceAssignmentEpoch: 4,
  entitlementTier: "hobby",
  sizingTier: "s",
  targetGatewayId: "alice-xs-12345678",
  requestedAt: 10_000,
  activationOperationId: "builder-activate-alice-xs-12345678-g1",
};

describe("placement receipts", () => {
  it("records an activation receipt exactly once when the user lands on the runtime", async () => {
    const { state, docs } = fixtureFirestore({
      "users/uid-alice": leaseUserDoc({ ...activatingLease }),
    });
    const input = { store: state, now: () => 25_000, requireOwner, sourceRecoveryPending: () => false };
    const advance = {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      fromStatus: "activating",
      toStatus: "active",
    } as const;

    await advanceActivationLease(input, advance);

    expect(docs.get("users/uid-alice/placement_receipts/lease-one-1-activated")).toEqual({
      schemaVersion: 1,
      kind: "activated",
      at: 25_000,
      builderSlug: "alice",
      leaseId: "lease-one",
      generation: 1,
      cause: "run-start",
      sizingTier: "s",
      entitlementTier: "hobby",
      gatewayId: "alice-xs-12345678",
      sharedGatewayId: "shared-blue",
      requestedAt: 10_000,
      wakeDurationMs: 15_000,
      activeDurationMs: null,
      operationId: "builder-activate-alice-xs-12345678-g1",
      retirementOperationId: null,
      operatorTerminated: false,
      error: null,
    });

    await advanceActivationLease(input, advance);
    expect(
      docs.get("users/uid-alice/placement_receipts/lease-one-1-activated"),
    ).toMatchObject({ at: 25_000 });
  });

  it("does not record a receipt for intermediate lease advances", async () => {
    const { state, docs } = fixtureFirestore({
      "users/uid-alice": leaseUserDoc({
        ...activatingLease,
        status: "provisioning",
        activationOperationId: undefined,
      }),
    });

    await advanceActivationLease({ store: state, now: () => 25_000, requireOwner }, {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      fromStatus: "provisioning",
      toStatus: "activating",
      operationId: "builder-activate-alice-xs-12345678-g1",
    });

    expect(
      [...docs.keys()].filter((key) => key.includes("placement_receipts")),
    ).toEqual([]);
  });

  it("records a return receipt with runtime dwell time when the lease parks", async () => {
    const { state, docs } = fixtureFirestore({
      "users/uid-alice": leaseUserDoc({
        ...activatingLease,
        status: "returning",
        activeAt: 30_000,
        returnOperationId: "builder-return-alice-xs-12345678-g1",
      }),
    });

    await completeActivationLease({ store: state, readSizingKey: noTier, now: () => 90_000, requireOwner }, {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      targetGatewayId: "alice-xs-12345678",
    });

    expect(docs.get("users/uid-alice/placement_receipts/lease-one-1-returned")).toEqual({
      schemaVersion: 1,
      kind: "returned",
      at: 90_000,
      builderSlug: "alice",
      leaseId: "lease-one",
      generation: 1,
      cause: "run-start",
      sizingTier: "s",
      entitlementTier: "hobby",
      gatewayId: "alice-xs-12345678",
      sharedGatewayId: "shared-blue",
      requestedAt: 10_000,
      wakeDurationMs: null,
      activeDurationMs: 60_000,
      operationId: "builder-return-alice-xs-12345678-g1",
      retirementOperationId: "placement-retire-uid-alice-alice-xs-12345678-g1",
      operatorTerminated: false,
      error: null,
    });
    const user = docs.get("users/uid-alice") as {
      provisioning: { openclaw: { activationLease: { status: string } } };
    };
    expect(user.provisioning.openclaw.activationLease.status).toBe("parked");
  });

  it("records no retirement on the return receipt when the VM stays parked", async () => {
    const { state, docs } = fixtureFirestore({
      "users/uid-alice": leaseUserDoc({
        ...activatingLease,
        status: "returning",
        activeAt: 30_000,
        returnOperationId: "builder-return-alice-xs-12345678-g1",
      }),
    });

    await completeActivationLease({ store: state, readSizingKey: noTier, now: () => 90_000, requireOwner }, {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      targetGatewayId: "alice-xs-12345678",
      parked: true,
    });

    expect(docs.get("users/uid-alice/placement_receipts/lease-one-1-returned")).toMatchObject({
      kind: "returned",
      operationId: "builder-return-alice-xs-12345678-g1",
      retirementOperationId: null,
    });
  });

  it("marks operator-driven termination on the return receipt", async () => {
    const { state, docs } = fixtureFirestore({
      "users/uid-alice": leaseUserDoc({
        ...activatingLease,
        status: "returning",
        activeAt: 30_000,
        returnOperationId: "builder-return-alice-xs-12345678-g1",
        operatorTerminateRequestedAt: 40_000,
      }),
    });

    await completeActivationLease({ store: state, readSizingKey: noTier, now: () => 90_000, requireOwner }, {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      targetGatewayId: "alice-xs-12345678",
    });

    expect(
      docs.get("users/uid-alice/placement_receipts/lease-one-1-returned"),
    ).toMatchObject({ kind: "returned", operatorTerminated: true });
  });

  it("fails closed instead of parking pending demand when the source assignment is malformed", async () => {
    const { state, docs } = fixtureFirestore({
      "users/uid-alice": leaseUserDoc({
        ...activatingLease,
        status: "returning",
        activeAt: 30_000,
        returnOperationId: "builder-return-alice-xs-12345678-g1",
        pendingDemand: { eventKey: "mattermost-post-2", cause: "run-start", observedAt: 40_000 },
      }),
      "gateways/shared-blue/assignments/uid-alice": { ...assignmentDoc(4), source: "unknown-source" },
    });

    await expect(completeActivationLease({ store: state, readSizingKey: hobbyTier, now: () => 90_000, requireOwner }, {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      targetGatewayId: "alice-xs-12345678",
    })).rejects.toBeInstanceOf(MalformedRecordError);

    expect([...docs.keys()].filter((key) => key.includes("placement_receipts"))).toEqual([]);
    expect(docs.get("users/uid-alice")).toMatchObject({ provisioning: { openclaw: { activationLease: { status: "returning" } } } });
  });

  it("records a failure receipt exactly once when activation fails", async () => {
    const { state, docs } = fixtureFirestore({
      "users/uid-alice": leaseUserDoc({ ...activatingLease }),
    });
    const input = { store: state, now: () => 25_000, requireOwner, sourceRecoveryPending: () => false };
    const failure = {
      uid: "uid-alice",
      leaseId: "lease-one",
      generation: 1,
      targetGatewayId: "alice-xs-12345678",
      operationId: "builder-activate-alice-xs-12345678-g1",
      message: "target prepare failed",
    };

    await failActivationLease(input, failure);

    expect(docs.get("users/uid-alice/placement_receipts/lease-one-1-activation-failed")).toEqual({
      schemaVersion: 1,
      kind: "activation-failed",
      at: 25_000,
      builderSlug: "alice",
      leaseId: "lease-one",
      generation: 1,
      cause: "run-start",
      sizingTier: "s",
      entitlementTier: "hobby",
      gatewayId: "alice-xs-12345678",
      sharedGatewayId: "shared-blue",
      requestedAt: 10_000,
      wakeDurationMs: 15_000,
      activeDurationMs: null,
      operationId: "builder-activate-alice-xs-12345678-g1",
      retirementOperationId: "placement-retire-uid-alice-alice-xs-12345678-g1",
      operatorTerminated: false,
      error: "target prepare failed",
    });

    await failActivationLease(input, failure);
    expect(
      docs.get("users/uid-alice/placement_receipts/lease-one-1-activation-failed"),
    ).toMatchObject({ at: 25_000 });
  });

  describe("while the activation is still recovering its source", () => {
    const ACTIVATION = "builder-activate-alice-xs-12345678-g1";
    const failure = { uid: "uid-alice", leaseId: "lease-one", generation: 1, targetGatewayId: "alice-xs-12345678", operationId: ACTIVATION, message: "failed" };
    const seed = (released: boolean, status = "failed", recoverSourceOnly = false) => fixtureFirestore({
      "users/uid-alice": leaseUserDoc({ ...activatingLease }),
      [`glmOperations/${ACTIVATION}`]: { kind: "migrate-user", status, createdAt: 1, createdBy: "test", steps: [], schedulerHandoffReleased: released,
        input: { uid: "uid-alice", userSlug: "alice", fromGatewayId: "shared-blue", toGatewayId: "alice-xs-12345678", source: "builder-activation-lease",
          ...(recoverSourceOnly ? { recoverSourceOnly } : {}) } },
    });
    const otherCause = { ...failure, operationId: "builder-authorization-ended-alice-xs-12345678", message: "authorization ended" };
    const sourceRecoveryPending = (operation: { id: string; schedulerHandoffReleased?: unknown }) =>
      operation.id === ACTIVATION && operation.schedulerHandoffReleased === false;

    it.each(["apply", "plan"] as const)("refuses to %s and leaves the lease activating", async (mode) => {
      const { state, docs } = seed(false);

      await expect(failActivationLease({ store: state, now: () => 25_000, requireOwner, sourceRecoveryPending }, failure, mode))
        .rejects.toEqual(new SourceRecoveryPendingError(ACTIVATION));
      expect(docs.get("users/uid-alice")).toMatchObject({ provisioning: { openclaw: { activationLease: { status: "activating" } } } });
      expect(docs.has("users/uid-alice/placement_receipts/lease-one-1-activation-failed")).toBe(false);
    });

    it("fails the lease once the source recovery is released", async () => {
      const { state, docs } = seed(true);

      await failActivationLease({ store: state, now: () => 25_000, requireOwner, sourceRecoveryPending }, failure);
      expect(docs.get("users/uid-alice")).toMatchObject({ provisioning: { openclaw: { activationLease: { status: "failed" } } } });
    });

    it("refuses a failure for another cause too while the failed activation recovers its source", async () => {
      const { state, docs } = seed(false);

      await expect(failActivationLease({ store: state, now: () => 25_000, requireOwner, sourceRecoveryPending }, otherCause))
        .rejects.toEqual(new SourceRecoveryPendingError(ACTIVATION));
      expect(docs.get("users/uid-alice")).toMatchObject({ provisioning: { openclaw: { activationLease: { status: "activating" } } } });
    });

    it("admits a failure for another cause while the activation is still running", async () => {
      const { state, docs } = seed(false, "running");

      await failActivationLease({ store: state, now: () => 25_000, requireOwner, sourceRecoveryPending }, otherCause);
      expect(docs.get("users/uid-alice")).toMatchObject({ provisioning: { openclaw: { activationLease: { status: "failed" } } } });
    });

    it.each(["pending", "running"])("refuses a failure for another cause while a re-armed source-only recovery is %s", async (status) => {
      const { state, docs } = seed(false, status, true);

      await expect(failActivationLease({ store: state, now: () => 25_000, requireOwner, sourceRecoveryPending }, otherCause))
        .rejects.toEqual(new SourceRecoveryPendingError(ACTIVATION));
      expect(docs.get("users/uid-alice")).toMatchObject({ provisioning: { openclaw: { activationLease: { status: "activating" } } } });
    });

    it("refuses the activation's own failure cleanup while it is still running", async () => {
      const { state } = seed(false, "running");

      await expect(failActivationLease({ store: state, now: () => 25_000, requireOwner, sourceRecoveryPending }, failure))
        .rejects.toEqual(new SourceRecoveryPendingError(ACTIVATION));
    });
  });
});

function allocationHarness(readSizingKey: () => Promise<"hobby" | "pro" | null> = hobbyTier) {
  const payload = { imageRepository: "registry/images/octogee-gateway", imageTag: `abc1234@sha256:${"a".repeat(64)}`,
    profileImages: { builder: { imageRepository: "registry/images/octogee-gateway-builder", imageTag: `abc1234@sha256:${"b".repeat(64)}` } },
    gatewayEdgeImage: { imageRepository: "registry/images/gateway-edge", imageTag: `abc1234@sha256:${"c".repeat(64)}` },
  };
  const h = fixtureFirestore({
    "gateways/shared-blue": { ...sharedSourceRoot(), desiredStatus: "draining" },
    "gateways/shared-blue/releases/3": { gatewayId: "shared-blue", release: 3, payload },
    "gateways/shared-blue/assignments/uid-alice": assignmentDoc(4),
    "users/uid-alice": userData(),
  });
  const ensureAuthSecret = vi.fn(async (_input: unknown) => undefined);
  const allocate = () => allocateIsolatedGateway({ store: h.state, readSizingKey, requireOwner, mutations: unauditedLifecycleMutations, requireHomeReady: homePreparedBeforeAllocation, namespace: "test", log: vi.fn(), now: () => 2_000, ensureAuthSecret, sourceRecoveryPending: () => false }, request);
  return { ...h, ensureAuthSecret, allocate, run: async () => (await allocate()).gatewayId };
}

describe("activation from a draining Shared source", () => {
  it("allocates for the exact requested lease while its converged source drains", async () => {
    const h = allocationHarness();
    const gatewayId = await h.run();
    expect(h.docs.get(`gateways/${gatewayId}`)).toMatchObject({ gatewayClass: "isolated", ownerUid: request.uid, desiredStatus: "running", allocation: { leaseId: request.leaseId } });
    expect(h.docs.get("users/uid-alice")).toMatchObject({ provisioning: { openclaw: { activationLease: { status: "provisioning", targetGatewayId: gatewayId } } } });
    expect(h.docs.get("gateways/shared-blue")?.desiredStatus).toBe("draining");
  });

  it("refuses allocation when the tier reader reports another entitlement than the lease", async () => {
    const h = allocationHarness(async () => "pro" as const);
    await expect(h.run()).rejects.toThrow(`isolated gateway demand fence changed for ${request.uid}`);
    expect([...h.docs.keys()].filter(key => key.startsWith("gateways/alice-"))).toEqual([]);
    expect(h.docs.get("users/uid-alice")).toMatchObject({ provisioning: { openclaw: { activationLease: { status: "requested" } } } });
  });

  it("allows replacement to switch a source from running to draining before allocation commits", async () => {
    const h = allocationHarness();
    h.docs.get("gateways/shared-blue")!.desiredStatus = "running";
    h.ensureAuthSecret.mockImplementation(async () => { h.docs.get("gateways/shared-blue")!.desiredStatus = "draining"; });
    await expect(h.run()).resolves.toEqual(expect.any(String));
  });

  it.each(["paused", "retired"])("rejects a %s source before provisioning", async (status) => {
    const h = allocationHarness();
    h.docs.get("gateways/shared-blue")!.desiredStatus = status;
    await expect(h.run()).rejects.toThrow();
    expect(h.ensureAuthSecret).not.toHaveBeenCalled();
  });

  it.each(["retired", "release", "roster", "lease", "mirror"])("rechecks %s changes before committing allocation", async (change) => {
    const h = allocationHarness();
    h.ensureAuthSecret.mockImplementation(async () => {
      if (change === "retired") h.docs.get("gateways/shared-blue")!.desiredStatus = "retired";
      if (change === "release") h.docs.get("gateways/shared-blue")!.desiredRelease = 4;
      if (change === "roster") h.docs.get("gateways/shared-blue/assignments/uid-alice")!.epoch = 5;
      if (change === "lease" || change === "mirror") {
        const user = userData();
        if (change === "lease") user.provisioning.openclaw.activationLease.generation = 2;
        else user.provisioning.openclaw.gatewayId = "shared-other";
        h.docs.set("users/uid-alice", user);
      }
    });
    await expect(h.run()).rejects.toThrow("changed");
    expect([...h.docs.keys()].filter(key => key.startsWith("gateways/alice-"))).toEqual([]);
  });
});
describe("parked isolated gateway reuse", () => {
  const nextRequest = { ...request, leaseId: "lease-two", generation: 2 };

  async function parkedHarness(sourceRecoveryPending: (operation: { id: string }) => boolean = () => false) {
    const h = allocationHarness();
    const parkedGatewayId = await h.run();
    const root = h.docs.get(`gateways/${parkedGatewayId}`)!;
    Object.assign(root, { desiredStatus: "paused", liveRelease: 1 });
    h.docs.set(`glmGateways/${parkedGatewayId}`, { ...runtimeDoc(parkedGatewayId, "gce-vm"), vm: { instanceId: "123", status: "SUSPENDED" } });
    const user = userData();
    Object.assign(user.provisioning.openclaw.activationLease, { leaseId: "lease-two", generation: 2 });
    h.docs.set("users/uid-alice", user);
    h.ensureAuthSecret.mockClear();
    const allocate = (parkedGateway: { gatewayId: string; generation: number } | null = { gatewayId: parkedGatewayId, generation: 1 }) => allocateIsolatedGateway(
      { store: h.state, readSizingKey: hobbyTier, requireOwner, mutations: unauditedLifecycleMutations, requireHomeReady: homePreparedBeforeAllocation, namespace: "test", log: vi.fn(), now: () => 3_000, ensureAuthSecret: h.ensureAuthSecret, sourceRecoveryPending },
      { ...nextRequest, ...(parkedGateway ? { parkedGateway } : {}) },
    );
    const run = async (parkedGateway?: { gatewayId: string; generation: number }) => (await allocate(parkedGateway)).gatewayId;
    const retirementOf = () => h.docs.get(`glmOperations/placement-retire-uid-alice-${parkedGatewayId}-g1`);
    const blockRetirement = () => { root.retirementClaim = { operationId: "another-retirement", version: 1, claimedAt: 1, phase: "claimed" }; };
    return { ...h, parkedGatewayId, root, allocate, run, retirementOf, blockRetirement };
  }

  function userRoots(docs: Map<string, Record<string, unknown>>): string[] {
    return [...docs.keys()].filter((key) => /^gateways\/alice-[^/]+$/.test(key));
  }

  it("re-stamps the parked gateway for the new lease and resumes it", async () => {
    const h = await parkedHarness();

    await expect(h.run()).resolves.toBe(h.parkedGatewayId);

    expect(h.docs.get(`gateways/${h.parkedGatewayId}`)).toMatchObject({
      desiredStatus: "running",
      allocation: { kind: "disposable-builder", leaseId: "lease-two", generation: 2, claimedByUid: "uid-alice" },
      updatedAt: 3_000,
    });
    expect(h.docs.get("users/uid-alice")).toMatchObject({ provisioning: { openclaw: { activationLease: {
      leaseId: "lease-two", generation: 2, status: "provisioning", targetGatewayId: h.parkedGatewayId, provisionedAt: 3_000,
    } } } });
    expect(userRoots(h.docs)).toEqual([`gateways/${h.parkedGatewayId}`]);
    expect(h.ensureAuthSecret).not.toHaveBeenCalled();
    expect(h.retirementOf()).toBeUndefined();
    await expect(h.allocate()).rejects.toThrow(/parked gateway/);
  });

  it("waits for recorded physical suspension before claiming a reparked computer", async () => {
    const h = await parkedHarness();
    const runtime = h.docs.get(`glmGateways/${h.parkedGatewayId}`)!;
    runtime.vm = { instanceId: "123", status: "RUNNING" };
    await expect(h.allocate()).rejects.toThrow("waiting for VM suspension");
    expect(h.root.allocation).toMatchObject({ generation: 1 });
    expect(h.ensureAuthSecret).not.toHaveBeenCalled();
    runtime.vm = { instanceId: "123", status: "SUSPENDED" };
    await expect(h.run()).resolves.toBe(h.parkedGatewayId);
  });

  async function prewarmHarness() {
    const h = await parkedHarness();
    h.docs.get(`glmGateways/${h.parkedGatewayId}`)!.vm = { instanceId: "old-instance", status: "SUSPENDED" };
    const payload = h.docs.get("gateways/shared-blue/releases/3")!.payload as ReleasePayload;
    const operation = {
      id: "prewarm-one", kind: "prewarm-gateway", status: "running", createdBy: "ship-test",
      createdAt: 2000, startedAt: 2001, completedAt: null, steps: [],
      inputUid: request.uid, gatewayId: h.parkedGatewayId,
      input: { uid: request.uid, gatewayId: h.parkedGatewayId, generation: 1, sourceSha: "a".repeat(40), bootImageId: "123", payload },
    } as const;
    await h.state.journal.operations.create({ ...operation, steps: [] });
    const setParked = () => {
      const user = userData();
      Object.assign(user.provisioning.openclaw.activationLease, { status: "parked" });
      h.docs.set("users/uid-alice", user);
    };
    const requestDemand = () => {
      const user = userData();
      Object.assign(user.provisioning.openclaw.activationLease, { leaseId: "lease-two", generation: 2, status: "requested" });
      h.docs.set("users/uid-alice", user);
    };
    return { ...h, operation: { ...operation, steps: [] }, setParked, requestDemand };
  }

  it("leaves a parked computer alone when demand is already requested before prewarm claims it", async () => {
    const h = await prewarmHarness();
    await expect(startParkedGatewayPrewarm(h.state, h.operation, 2100)).resolves.toEqual({ state: "demand-won" });
    expect(h.root.desiredStatus).toBe("paused");
    await expect(h.run()).resolves.toBe(h.parkedGatewayId);
  });

  it("retries until the registry confirms the observed VM has suspended", async () => {
    const h = await prewarmHarness();
    h.setParked();
    const runtime = h.docs.get(`glmGateways/${h.parkedGatewayId}`)!;
    const source = { instanceId: "old-instance", bootImageId: "111", needsRepair: false };
    runtime.vm = { instanceId: source.instanceId, status: "RUNNING" };
    await expect(startParkedGatewayPrewarm(h.state, h.operation, 2100, source)).rejects.toThrow("waiting for VM suspension to be recorded");
    expect((await h.state.gateways.roots.get(h.parkedGatewayId))?.desiredStatus).toBe("paused");
    runtime.vm = { instanceId: source.instanceId, status: "SUSPENDED" };
    await expect(startParkedGatewayPrewarm(h.state, h.operation, 2200, source)).resolves.toMatchObject({ state: "booting" });
  });

  it("refuses to start a queued prewarm after archive custody is recorded", async () => {
    const h = await prewarmHarness();
    h.setParked();
    await h.state.users.records.patch(request.uid, { home: { homeArchive: {
      phase: "preparing", operationId: "archive-1", gatewayId: h.parkedGatewayId, instanceId: "123",
    } } });

    await expect(startParkedGatewayPrewarm(h.state, h.operation, 2100)).resolves.toEqual({ state: "ineligible" });
    expect(h.root.desiredStatus).toBe("paused");
  });

  it("hands a freshly prewarmed running computer directly to matching demand without suspending it", async () => {
    const h = await prewarmHarness();
    h.setParked();
    const started = await startParkedGatewayPrewarm(h.state, h.operation, 2100);
    expect(started.state).toBe("booting");
    h.requestDemand();
    await expect(h.allocate()).rejects.toThrow(/prewarm has not released/);
    expect(h.ensureAuthSecret).not.toHaveBeenCalled();
    const root = await h.state.gateways.roots.get(h.parkedGatewayId);
    await h.state.gateways.roots.patch(h.parkedGatewayId, { liveRelease: root!.desiredRelease });
    await expect(finishParkedGatewayPrewarm(h.state, h.operation, 2200, "ready")).resolves.toBe("handoff");
    expect((await h.state.gateways.roots.get(h.parkedGatewayId))?.desiredStatus).toBe("running");
    await expect(h.run()).resolves.toBe(h.parkedGatewayId);
    await expect(finishParkedGatewayPrewarm(h.state, h.operation, 2300, "rollback")).resolves.toBe("demand-won");
    expect(await h.state.gateways.roots.get(h.parkedGatewayId)).toMatchObject({
      desiredStatus: "running", allocation: { generation: 2, leaseId: "lease-two" },
    });
  });

  it("authorizes native prelaunch only while the operation holds the exact owner and serving Shared roster epoch", async () => {
    const h = await prewarmHarness();
    h.setParked();
    await startParkedGatewayPrewarm(h.state, h.operation, 2100);
    const bootMode = async () => {
      const gateway = await h.state.gateways.roots.get(h.parkedGatewayId);
      return isolatedBootMode({ reader: h.state, gateway: gateway! });
    };
    await expect(bootMode()).resolves.toEqual({ mode: "prelaunch" });
    h.requestDemand();
    await expect(bootMode()).resolves.toEqual({ mode: "prelaunch" });
    h.docs.get("gateways/shared-blue/assignments/uid-alice")!.epoch = 5;
    await expect(bootMode()).rejects.toThrow("User activation authority is inconsistent");
  });

  it("requires a fresh original instance report before switching the parked computer to the candidate release", async () => {
    const h = await prewarmHarness();
    h.setParked();
    const oldReleaseRow = h.docs.get(`gateways/${h.parkedGatewayId}/releases/1`)!;
    const oldPayload = oldReleaseRow.payload as ReleasePayload;
    const changedPayload = { ...oldPayload, imageTag: `abc1234@sha256:${"e".repeat(64)}` };
    oldReleaseRow.payload = changedPayload;
    oldReleaseRow.payloadHash = releasePayloadHash(changedPayload);
    await expect(startParkedGatewayPrewarm(h.state, h.operation, 2100, {
      instanceId: "old-instance", bootImageId: "111", needsRepair: true,
    })).resolves.toMatchObject({ state: "repairing", claim: { previousRelease: 1, release: 2 } });
    expect(await h.state.gateways.roots.get(h.parkedGatewayId)).toMatchObject({ desiredStatus: "running", desiredRelease: 1 });
    const runtimeDoc = h.docs.get(`glmGateways/${h.parkedGatewayId}`)!;
    runtimeDoc.vm = { instanceId: "old-instance", status: "RUNNING" };
    const report = { currentPointId: null, retainedPoints: 0, ready: true, bundleVersion: "v1",
      freeBytes: 3 * 1024 ** 3, instanceId: "old-instance", observedAt: 2099 };
    runtimeDoc.vmBootRecovery = report;
    await expect(finishParkedGatewayPrewarm(h.state, h.operation, 2250, "repaired")).rejects.toThrow(/fresh healthy/);
    runtimeDoc.vmBootRecovery = { ...report, observedAt: 2150, instanceId: "other-instance" };
    await expect(finishParkedGatewayPrewarm(h.state, h.operation, 2250, "repaired")).rejects.toThrow(/fresh healthy/);
    runtimeDoc.vmBootRecovery = { ...report, observedAt: 2150 };
    await expect(finishParkedGatewayPrewarm(h.state, h.operation, 2250, "repaired")).resolves.toBe("repair-parking");
    expect(await h.state.gateways.roots.get(h.parkedGatewayId)).toMatchObject({ desiredStatus: "paused", desiredRelease: 1 });
    await expect(bootRepairedParkedGateway(h.state, h.operation, 2300)).rejects.toThrow(/not safely parked/);
    runtimeDoc.vm = { instanceId: "old-instance", status: "SUSPENDED" };
    await expect(bootRepairedParkedGateway(h.state, h.operation, 2300)).resolves.toBe("booting");
    expect(await h.state.gateways.roots.get(h.parkedGatewayId)).toMatchObject({ desiredStatus: "running", desiredRelease: 2 });
    expect((await h.state.journal.operations.get(h.operation.id))?.output).toMatchObject({
      repairedBootRecovery: { observedAt: 2150, instanceId: "old-instance" },
    });
  });

  it.each([false, true])("atomically rolls back a rejected exact prewarm and preserves new demand: %s", async demand => {
    const h = await prewarmHarness();
    h.setParked();
    await expect(startParkedGatewayPrewarm(h.state, h.operation, 2100)).resolves.toMatchObject({ state: "booting" });
    const rejection = { instanceId: "old-instance", bootImageId: "123", reason: "cannot prove scheduler lineage" };
    await expect(finishParkedGatewayPrewarm(h.state, { ...h.operation, startedAt: 2002 }, 2200, "rollback", rejection)).rejects.toThrow("worker claim changed");
    await expect(finishParkedGatewayPrewarm(h.state, h.operation, 2200, "rollback", { ...rejection, bootImageId: "124" })).rejects.toThrow("rejection authority changed");
    expect(await h.state.gateways.roots.get(h.parkedGatewayId)).toMatchObject({ desiredStatus: "running", desiredRelease: 1 });
    if (demand) h.requestDemand();
    const phase = demand ? "demand-won" : "parked";
    await expect(finishParkedGatewayPrewarm(h.state, h.operation, 2200, "rollback", rejection)).resolves.toBe(phase);
    expect(await h.state.gateways.roots.get(h.parkedGatewayId)).toMatchObject({ desiredStatus: "paused", desiredRelease: 1, liveRelease: 1 });
    expect(await h.state.journal.operations.get(h.operation.id)).toMatchObject({
      output: { prewarmState: phase, prewarmBootRejection: rejection.reason, previousInstanceId: rejection.instanceId },
    });
    expect(await h.state.fleetRegistry.get(h.parkedGatewayId)).toMatchObject({ vm: { instanceId: rejection.instanceId } });
    if (demand) await expect(h.run()).resolves.toBe(h.parkedGatewayId);
  });

  it("reparks a verified release when no demand arrived, allowing a later generation to claim it normally", async () => {
    const h = await prewarmHarness();
    h.setParked();
    const started = await startParkedGatewayPrewarm(h.state, h.operation, 2100);
    expect(started.state).toBe("booting");
    const root = await h.state.gateways.roots.get(h.parkedGatewayId);
    await h.state.gateways.roots.patch(h.parkedGatewayId, { liveRelease: root!.desiredRelease });
    await expect(finishParkedGatewayPrewarm(h.state, h.operation, 2200, "ready")).resolves.toBe("parked");
    expect((await h.state.gateways.roots.get(h.parkedGatewayId))?.desiredStatus).toBe("paused");
    h.requestDemand();
    await expect(h.allocate(null)).resolves.toEqual({ gatewayId: h.parkedGatewayId, outcome: "resumed" });
    expect((await h.state.gateways.roots.get(h.parkedGatewayId))?.desiredStatus).toBe("running");
  });

  it("retires a parked gateway on another release and mints a fresh one", async () => {
    const h = await parkedHarness();
    const release = h.docs.get(`gateways/${h.parkedGatewayId}/releases/1`)!;
    h.docs.set(`gateways/${h.parkedGatewayId}/releases/1`, {
      ...release,
      payload: { ...(release.payload as Record<string, unknown>), imageTag: `abc1234@sha256:${"d".repeat(64)}` },
    });

    const gatewayId = await h.run();

    expect(gatewayId).not.toBe(h.parkedGatewayId);
    expect(h.retirementOf()).toMatchObject({
      kind: "retire-gateway",
      createdBy: "glm-controller-placement-policy",
      input: { gatewayId: h.parkedGatewayId, uid: "uid-alice", userSlug: "alice", reason: "parked-computer-replaced" },
    });
    expect(h.docs.get(`gateways/${gatewayId}`)).toMatchObject({ desiredStatus: "running", allocation: { generation: 2 } });
    expect(h.docs.get(`gateways/${h.parkedGatewayId}`)?.desiredStatus).toBe("retired");
  });

  it("refuses to retire and replace a parked gateway while its activation still recovers its source", async () => {
    let activation = "";
    const h = await parkedHarness((operation) => operation.id === activation);
    activation = builderActivateOperationId(h.parkedGatewayId, 1);
    h.docs.set(`glmOperations/${activation}`, { kind: "migrate-user", status: "failed", createdAt: 1, createdBy: "test", steps: [],
      input: { uid: "uid-alice", userSlug: "alice", fromGatewayId: "shared-blue", toGatewayId: h.parkedGatewayId, source: "builder-activation-lease" } });
    h.root.sizingProfile = "pro";

    await expect(h.allocate()).rejects.toEqual(new SourceRecoveryPendingError(activation));
    expect(h.retirementOf()).toBeUndefined();
    expect(h.docs.get(`gateways/${h.parkedGatewayId}`)?.desiredStatus).toBe("paused");
    expect(userRoots(h.docs)).toEqual([`gateways/${h.parkedGatewayId}`]);
  });

  it.each([
    ["created from another sizing profile", (root: Record<string, unknown>) => { root.sizingProfile = "pro"; }],
    ["that names no sizing profile", (root: Record<string, unknown>) => { delete root.sizingProfile; }],
  ])("retires a parked gateway %s and mints a fresh one from the user's profile", async (_name, change) => {
    const h = await parkedHarness();
    change(h.root);

    const gatewayId = await h.run();

    expect(gatewayId).not.toBe(h.parkedGatewayId);
    expect(h.retirementOf()).toMatchObject({ input: { gatewayId: h.parkedGatewayId, reason: "parked-computer-replaced" } });
    expect(h.docs.get(`gateways/${gatewayId}`)).toMatchObject({ desiredStatus: "running", sizingProfile: "hobby", allocation: { generation: 2 } });
  });

  it("refuses to mint while a parked gateway from another sizing profile cannot be retired", async () => {
    const h = await parkedHarness();
    h.root.sizingProfile = "pro";
    h.blockRetirement();

    await expect(h.run()).rejects.toThrow(`parked gateway ${h.parkedGatewayId} was not created from sizing profile hobby and could not be retired`);
    expect(userRoots(h.docs)).toEqual([`gateways/${h.parkedGatewayId}`]);
  });

  it("refuses to mint while a parked gateway on another release cannot be retired", async () => {
    const h = await parkedHarness();
    h.docs.get(`gateways/${h.parkedGatewayId}`)!.desiredRelease = 2;
    h.blockRetirement();

    await expect(h.run()).rejects.toThrow(/could not be retired/);
    expect(userRoots(h.docs)).toEqual([`gateways/${h.parkedGatewayId}`]);
  });

  it.each([
    ["is no longer paused", (h: Awaited<ReturnType<typeof parkedHarness>>) => { h.root.desiredStatus = "running"; }],
    ["has another size", (h: Awaited<ReturnType<typeof parkedHarness>>) => { h.root.sizingTier = "m"; }],
    ["has another allocation generation", (h: Awaited<ReturnType<typeof parkedHarness>>) => {
      h.root.allocation = { ...(h.root.allocation as Record<string, unknown>), generation: 3 };
    }],
    ["is not a VM", (h: Awaited<ReturnType<typeof parkedHarness>>) => {
      h.docs.set(`glmGateways/${h.parkedGatewayId}`, runtimeDoc(h.parkedGatewayId, "cluster"));
    }],
    ["belongs to the new lease's generation", (h: Awaited<ReturnType<typeof parkedHarness>>) => {
      h.root.allocation = { ...(h.root.allocation as Record<string, unknown>), generation: 2 };
    }],
  ])("refuses a parked gateway that %s", async (_name, change) => {
    const h = await parkedHarness();
    change(h);
    const generation = (h.root.allocation as { generation: number }).generation;

    await expect(h.run({ gatewayId: h.parkedGatewayId, generation })).rejects.toThrow(/parked gateway/);
    expect(h.docs.get("users/uid-alice")).toMatchObject({ provisioning: { openclaw: { activationLease: { status: "requested" } } } });
    expect(h.retirementOf()).toBeUndefined();
  });
});
it("starts the home rollback grace only after the copied home reaches an active assignment",async()=>{
  const {state,docs}=fixtureFirestore({"users/uid-alice":{provisioning:{
    openclaw:{gatewayId:activatingLease.targetGatewayId,activationLease:{...activatingLease}},
    homeStorage:{disk:{id:"200"},retained:[{disk:{id:"100"}}]},
    homeMigration:{phase:"complete",target:{id:"200"},proof:{status:"ready"}},
  }}});
  const advance={uid:"uid-alice",leaseId:"lease-one",generation:1,fromStatus:"activating",toStatus:"active"} as const;
  await advanceActivationLease({store:state,now:()=>25_000,requireOwner},advance);
  expect((docs.get("users/uid-alice")!.provisioning as any).homeStorage.admittedAt).toBe(25_000);
  await advanceActivationLease({store:state,now:()=>50_000,requireOwner},advance);
  expect((docs.get("users/uid-alice")!.provisioning as any).homeStorage.admittedAt).toBe(25_000);
});
