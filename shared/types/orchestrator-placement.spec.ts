import { beforeEach, describe, expect, it } from "vitest";

import {
  resolveContinuousUserPlacement,
  resolveDefaultPlacementEligibility,
} from "./orchestrator-placement.js";
import { installUserEntitlements, staticUserEntitlements } from "./user-entitlements.js";

beforeEach(() => installUserEntitlements(staticUserEntitlements));

describe("default placement eligibility", () => {
  it("accepts only a user the platform admitted, with a server-started provisioning state", () => {
    expect(resolveDefaultPlacementEligibility({
      username: "alice",
      admitted: true,
      provisioning: { status: "in_progress", openclaw: {} },
    })).toEqual({ eligible: true, slug: "alice" });
    expect(resolveDefaultPlacementEligibility({
      username: "alice",
      admitted: true,
      provisioning: { status: "complete", openclaw: { slug: "canonical" } },
    })).toEqual({ eligible: true, slug: "canonical" });
  });

  it("rejects a suspended account so no automatic placement can mount it", () => {
    expect(resolveDefaultPlacementEligibility({
      username: "alice",
      admitted: true,
      provisioning: { status: "complete", openclaw: { slug: "alice" } },
      accountLifecycle: { status: "deletion_scheduled", deletionId: "del-1" },
    })).toEqual({ eligible: false, reason: "account-not-interactive" });
    expect(resolveDefaultPlacementEligibility({
      username: "alice",
      admitted: true,
      provisioning: { status: "complete", openclaw: { slug: "alice" } },
      accountLifecycle: { status: "active" },
    })).toEqual({ eligible: true, slug: "alice" });
  });

  it("keeps an operator-parked user out of automatic placement until released", () => {
    const data = { username: "alice", admitted: true, provisioning: { status: "complete", openclaw: { slug: "alice", managedBy: "operator" } } };
    expect(resolveDefaultPlacementEligibility(data)).toEqual({ eligible: false, reason: "operator-managed" });
    expect(resolveDefaultPlacementEligibility({ ...data, provisioning: { ...data.provisioning, openclaw: { ...data.provisioning.openclaw, managedBy: "cowboy" } } })).toEqual({ eligible: true, slug: "alice" });
  });

  it.each([
    ["no admitted flag", { username: "alice" }],
    ["admitted false", { username: "alice", admitted: false }],
    ["a truthy value that is not true", { username: "alice", admitted: "true" }],
  ])("rejects a user with %s as not admitted", (_label, data) => {
    expect(resolveDefaultPlacementEligibility({ ...data, provisioning: { status: "complete", openclaw: { slug: "alice" } } }))
      .toEqual({ eligible: false, reason: "not-admitted" });
  });

  it("reads no onboarding step: a completed one admits nobody and a missing one holds nobody back", () => {
    const provisioning = { status: "complete", openclaw: { slug: "alice" } };

    expect(resolveDefaultPlacementEligibility({ username: "alice", onboardingStep: "complete", provisioning }))
      .toEqual({ eligible: false, reason: "not-admitted" });
    expect(resolveDefaultPlacementEligibility({ username: "alice", onboardingStep: "profile", admitted: true, provisioning }))
      .toEqual({ eligible: true, slug: "alice" });
  });

  it("rejects a missing canonical identity and arbitrary provisioning states", () => {
    expect(resolveDefaultPlacementEligibility({
      admitted: true,
      provisioning: { status: "in_progress" },
    })).toEqual({ eligible: false, reason: "builder-slug-missing" });
    expect(resolveDefaultPlacementEligibility({
      username: "alice",
      admitted: true,
      provisioning: { status: "queued" },
    })).toEqual({ eligible: false, reason: "provisioning-not-started" });
  });
});

const trialBuilder = {
  trialGrant: {
    schemaVersion: 3,
    offerId: "builder-signup",
    offerVersion: 1,
    personalTier: "personal",
    builderTier: "hobby",
    configHash: "grant-hash",
    claimedAt: 1_000,
    endsAt: 604_801_000,
  },
};

describe("resolveContinuousUserPlacement", () => {
  it("keeps an entitled inactive user parked on shared", () => {
    expect(resolveContinuousUserPlacement({
      uid: "uid-alice",
      userData: trialBuilder,
      currentGatewayId: "shared-blue",
      defaultGatewayId: "shared-blue",
      ownedGateway: {
        gatewayId: "builder-alice",
        gatewayClass: "isolated",
        ownerUid: "uid-alice",
        desiredStatus: "running",
        ready: true,
      },
      now: new Date(1_000),
    })).toEqual({ targetGatewayId: "shared-blue", ownedGatewayId: null });
  });

  it("returns expired and unentitled users to the configured default", () => {
    expect(resolveContinuousUserPlacement({
      uid: "uid-alice",
      userData: trialBuilder,
      currentGatewayId: "builder-alice",
      defaultGatewayId: "shared-blue",
      ownedGateway: null,
      now: new Date("2027-01-01T00:00:00.000Z"),
    })).toEqual({ targetGatewayId: "shared-blue", ownedGatewayId: null });
  });

  it("does not treat a paid entitlement as runtime demand", () => {
    expect(resolveContinuousUserPlacement({
      uid: "uid-paid",
      userData: { builderSubscription: { tier: "pro", status: "active" } },
      currentGatewayId: "shared-blue",
      defaultGatewayId: "shared-blue",
      ownedGateway: null,
      now: new Date(1_000),
    })).toEqual({ targetGatewayId: "shared-blue", ownedGatewayId: null });
  });

  it("keeps an active lease target stable during a heartbeat outage", () => {
    expect(resolveContinuousUserPlacement({
      uid: "uid-alice",
      userData: {
        ...trialBuilder,
        provisioning: {
          openclaw: {
            activationLease: {
              status: "active",
              targetGatewayId: "builder-alice",
            },
          },
        },
      },
      currentGatewayId: "builder-alice",
      defaultGatewayId: "shared-blue",
      ownedGateway: {
        gatewayId: "builder-alice",
        gatewayClass: "isolated",
        ownerUid: "uid-alice",
        disposable: true,
        desiredStatus: "running",
        ready: false,
      },
      now: new Date(1_000),
    })).toEqual({ targetGatewayId: "builder-alice", ownedGatewayId: "builder-alice" });
  });

  it("ignores an active lease for a user the installed entitlements give no sizing key", () => {
    installUserEntitlements({ ...staticUserEntitlements, sizingKey: () => null });
    expect(resolveContinuousUserPlacement({
      uid: "uid-alice",
      userData: {
        provisioning: {
          openclaw: {
            activationLease: { status: "active", targetGatewayId: "builder-alice" },
          },
        },
      },
      currentGatewayId: "builder-alice",
      defaultGatewayId: "shared-blue",
      ownedGateway: {
        gatewayId: "builder-alice",
        gatewayClass: "isolated",
        ownerUid: "uid-alice",
        disposable: true,
        desiredStatus: "running",
        ready: true,
      },
      now: new Date(1_000),
    })).toEqual({ targetGatewayId: "shared-blue", ownedGatewayId: null });
  });

  it("does not route an active lease to a non-disposable owner gateway", () => {
    expect(resolveContinuousUserPlacement({
      uid: "uid-alice",
      userData: {
        ...trialBuilder,
        provisioning: {
          openclaw: {
            activationLease: { status: "active", targetGatewayId: "builder-alice" },
          },
        },
      },
      currentGatewayId: "builder-alice",
      defaultGatewayId: "shared-blue",
      ownedGateway: {
        gatewayId: "builder-alice",
        gatewayClass: "isolated",
        ownerUid: "uid-alice",
        desiredStatus: "running",
        ready: true,
      },
      now: new Date(1_000),
    })).toEqual({ targetGatewayId: "shared-blue", ownedGatewayId: "builder-alice" });
  });
});
