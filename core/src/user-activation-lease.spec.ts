import { describe, expect, it } from "vitest";

import {
  builderActivateOperationId,
  isolatedRecoverOperationId,
  builderReturnOperationId,
  isUserActivateOperationIdFor,
  isUserReturnOperationIdFor,
  placementRetireOperationId,
  requestUserActivationLease,
} from "./user-activation-lease.js";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "./testing/journal-store.js";

describe("Isolated runtime operation ids", () => {
  it("qualify each runtime operation with the allocation generation", () => {
    expect(builderActivateOperationId("alice-m-1234abcd", 3)).toBe("builder-activate-alice-m-1234abcd-g3");
    expect(builderReturnOperationId("alice-m-1234abcd", 3)).toBe("builder-return-alice-m-1234abcd-g3");
    expect(isolatedRecoverOperationId("alice-m-1234abcd", 3)).toBe("builder-recover-alice-m-1234abcd-g3");
    expect(placementRetireOperationId("uid-alice", "alice-m-1234abcd", 3))
      .toBe("placement-retire-uid-alice-alice-m-1234abcd-g3");
  });

  it("give a reused gateway distinct operations per generation", () => {
    expect(builderReturnOperationId("alice-m-1234abcd", 1))
      .not.toBe(builderReturnOperationId("alice-m-1234abcd", 2));
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects generation %s", (generation) => {
    expect(() => builderActivateOperationId("alice-m-1234abcd", generation)).toThrow(/generation/);
  });

  it("rejects an empty gateway id", () => {
    expect(() => builderReturnOperationId("", 1)).toThrow(/gateway/);
  });
});

describe("Isolated runtime operation id recognition", () => {
  it("recognizes any generation of the exact gateway's operation", () => {
    expect(isUserReturnOperationIdFor("builder-return-alice-m-1234abcd-g7", "alice-m-1234abcd")).toBe(true);
    expect(isUserActivateOperationIdFor("builder-activate-alice-m-1234abcd-g1", "alice-m-1234abcd")).toBe(true);
  });

  it.each([
    ["builder-return-alice-m-1234abcd", "ungenerationed id"],
    ["builder-return-alice-m-1234abcd-g0", "zero generation"],
    ["builder-return-alice-m-1234abcd-g1-g2", "another gateway's suffix"],
    ["builder-activate-alice-m-1234abcd-g1", "another operation kind"],
    ["builder-return-bob-m-1234abcd-g1", "another gateway"],
  ])("rejects %s (%s)", (operationId) => {
    expect(isUserReturnOperationIdFor(operationId, "alice-m-1234abcd")).toBe(false);
  });

  it("rejects a missing gateway id", () => {
    expect(isUserReturnOperationIdFor("builder-return--g1", undefined)).toBe(false);
  });
});

describe("Isolated runtime demand refusal", () => {
  const refusal = { statusCode: 409, body: { code: "refused-by-product", error: "refused" } };

  function store() {
    const docs = new Map<string, Record<string, unknown>>([
      ["config/orchestrator", { sizingProfiles: {
        ...FIXTURE_SIZING_PROFILES,
        pod: { isolation: "isolated", sizingTier: "s", fallbackStorageGb: null, computer: { runtime: "cluster", homeSizeGiB: 10 } },
      } }],
      ["users/uid-alice", {
        accountLifecycle: { status: "active" },
        provisioning: { openclaw: { slug: "alice", gatewayId: "default" } },
      }],
      ["gateways/default/assignments/uid-alice", {
        uid: "uid-alice", slug: "alice", source: "onboarding", gatewayId: "default", state: "serving", epoch: 7,
      }],
    ]);
    return { docs, store: createDocumentFixtureStore(docs) };
  }

  const request = (state: ReturnType<typeof store>, refuse: (user: { uid: string }) => typeof refusal | null, sizingKey = "pro") =>
    requestUserActivationLease({
      store: state.store,
      readSizingKey: async () => sizingKey,
      uid: "uid-alice",
      reportingGatewayId: "default",
      assignmentEpoch: 7,
      eventKey: "manual:1",
      cause: "manual",
      observedAt: 1_000,
      createdBy: "spec",
      refuse,
    });

  it("returns the product's refusal from inside the transaction without writing a lease", async () => {
    const state = store();
    const seen: string[] = [];
    await expect(request(state, (user) => { seen.push(user.uid); return refusal; })).resolves.toBe(refusal);
    expect(seen).toEqual(["uid-alice"]);
    expect(state.docs.get("users/uid-alice")).not.toHaveProperty("provisioning.openclaw.activationLease");
  });

  it("refuses an entitlement whose isolated profile runs as a pod, which only an operator can give", async () => {
    const state = store();

    await expect(request(state, () => null, "pod")).resolves.toMatchObject({
      statusCode: 409,
      body: { code: "builder-runtime-not-vm", entitlementTier: "pod" },
    });
    expect(state.docs.get("users/uid-alice")).not.toHaveProperty("provisioning.openclaw.activationLease");
  });

  it("requests the lease when the product does not refuse", async () => {
    const state = store();
    await expect(request(state, () => null)).resolves.toMatchObject({ statusCode: 202, body: { status: "requested" } });
  });
});
