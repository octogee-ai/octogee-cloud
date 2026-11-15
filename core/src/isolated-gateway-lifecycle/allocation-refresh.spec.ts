import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "@octogee/core-testing/journal-store";
import { refreshRequestedAllocation, type LifecycleMutationRunner } from "./index.js";

function fixture() {
  const request = { uid: "alice-id", builderSlug: "alice", leaseId: "lease-1", generation: 2,
    sourceGatewayId: "shared-old", sourceAssignmentEpoch: 4, sizingKey: "hobby" as const, sizingTier: "s" as const };
  const user = { username: "alice", provisioning: {
    homeMigration: { id: "verified-copy", phase: "copying" },
    openclaw: { slug: "alice", gatewayId: "shared-new", activationLease: { ...request, entitlementTier: request.sizingKey, status: "requested" } } as Record<string, unknown> & {
      gatewayId: string; activationLease: Record<string, unknown> & { generation: number; sourceGatewayId: string };
    },
  } };
  const source = { createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test", latestRelease: 1,
    configSchemaVersion: 1, profile: "standard", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, allocation: null, gatewayId: "shared-new", gatewayClass: "shared", desiredStatus: "running", liveRelease: 1, desiredRelease: 1 };
  const assignment = { uid: request.uid, slug: "alice", gatewayId: "shared-new", source: "onboarding", state: "serving", epoch: 5, createdAt: 1, updatedAt: 1 };
  const docs = new Map<string, Record<string, unknown>>([["users/alice-id", user], ["gateways/shared-new", source], ["gateways/shared-new/assignments/alice-id", assignment]]);
  const store = createDocumentFixtureStore(docs);
  let tier = "hobby";
  let tierReads = 0;
  let race = () => {};
  const readSizingKey = vi.fn(async () => {
    tierReads += 1;
    if (tierReads === 2) race();
    return tier;
  });
  const writes = vi.spyOn(docs, "set");
  const audited: string[] = [];
  const mutations: LifecycleMutationRunner = (mutation) => {
    audited.push(mutation.what);
    return mutation.action();
  };
  const lease = () => ((docs.get("users/alice-id")!.provisioning as typeof user.provisioning).openclaw.activationLease);
  return { user, source, assignment, request, writes, lease, docs, audited,
    setRace: (fn: () => void) => { race = fn; },
    setTier: (next: string) => { tier = next; },
    run: () => refreshRequestedAllocation({ store, readSizingKey, requireOwner: async () => undefined, mutations, now: () => 1000, log: vi.fn() }, request) };
}

describe("requested isolated allocation refresh", () => {
  it("follows a completed Shared move while preserving the home copy and lease", async () => {
    const h = fixture();
    await expect(h.run()).resolves.toBe(true);
    expect(h.lease()).toMatchObject({ leaseId: "lease-1", generation: 2, sourceGatewayId: "shared-new", sourceAssignmentEpoch: 5, status: "requested" });
    expect((h.docs.get("users/alice-id")!.provisioning as typeof h.user.provisioning).homeMigration).toEqual({ id: "verified-copy", phase: "copying" });
    expect(h.audited).toEqual(["refresh-builder-allocation"]);
  });
  it("refreshes an assignment epoch on the same Shared gateway", async () => {
    const h = fixture(); h.request.sourceGatewayId = "shared-new"; h.user.provisioning.openclaw.activationLease.sourceGatewayId = "shared-new";
    await expect(h.run()).resolves.toBe(true);
    expect(h.lease().sourceAssignmentEpoch).toBe(5);
  });
  it("leaves a current allocation unchanged", async () => {
    const h = fixture(); h.request.sourceGatewayId = "shared-new"; h.request.sourceAssignmentEpoch = 5;
    Object.assign(h.user.provisioning.openclaw.activationLease, h.request);
    await expect(h.run()).resolves.toBe(false); expect(h.writes).not.toHaveBeenCalled();
  });
  it("repairs a requested lease when its stored profile changes size", async () => {
    const h = fixture(); h.request.sourceGatewayId = "shared-new"; h.request.sourceAssignmentEpoch = 5;
    Object.assign(h.user.provisioning.openclaw.activationLease, h.request);
    h.docs.set("config/orchestrator", { sizingProfiles: { ...FIXTURE_SIZING_PROFILES, hobby: { ...FIXTURE_SIZING_PROFILES.hobby, sizingTier: "m" } } });
    await expect(h.run()).resolves.toBe(true);
    expect(h.lease().sizingTier).toBe("m");
  });
  it.each(["owner", "slug", "quiescing", "retired", "isolated", "lease", "target", "migration", "tier", "source"])("rejects a %s race before refreshing", async (change) => {
    const h = fixture(); h.setRace(() => {
      if (change === "owner") h.assignment.uid = "other";
      if (change === "slug") h.assignment.slug = "other";
      if (change === "quiescing") h.assignment.state = "quiescing";
      if (change === "retired") h.source.desiredStatus = "retired";
      if (change === "isolated") h.source.gatewayClass = "isolated";
      if (change === "lease") h.user.provisioning.openclaw.activationLease.generation++;
      if (change === "target") Object.assign(h.user.provisioning.openclaw.activationLease, { targetGatewayId: "alice-run" });
      if (change === "migration") Object.assign(h.user.provisioning.openclaw, { migration: { toGatewayId: "shared-third" } });
      if (change === "tier") h.setTier("pro");
      if (change === "source") h.user.provisioning.openclaw.gatewayId = "shared-third";
    });
    await expect(h.run()).rejects.toThrow(change === "owner" ? /malformed: stores uid "other"/u : "Isolated allocation changed before refreshing its source or tier");
    expect(h.writes).not.toHaveBeenCalled();
  });
});
