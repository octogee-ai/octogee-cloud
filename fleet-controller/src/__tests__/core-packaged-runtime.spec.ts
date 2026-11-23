import { describe, expect, it, vi } from "vitest";
import { commitCutoverAtomic, type CutoverDeps } from "@octogee/core/fleet-state";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import {
  GatewayRetirementConflictError,
  claimGatewayRetirementInStore,
} from "@octogee/core/gateway-retirement-claim";

function durableRoot(gatewayId: string, release: number): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: release,
    desiredRelease: release,
    liveRelease: release,
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
    preemption: null,
  };
}

function migrationCutoverSeed(): Record<string, Record<string, unknown>> {
  return {
    "users/uid-a": { username: "alice", provisioning: { openclaw: { gatewayId: "source" } } },
    "gateways/target": durableRoot("target", 2),
    "gateways/source/assignments/uid-a": {
      uid: "uid-a",
      slug: "alice",
      gatewayId: "source",
      source: "onboarding",
      state: "quiescing",
      epoch: 4,
    },
  };
}

function cutover(documents: Record<string, Record<string, unknown>>, now: number, automatic = false) {
  const deps: CutoverDeps = {
    store: createDocumentFixtureStore(documents),
    readSizingKey: async () => {
      throw new Error("a cutover without a V2 fence never reads the user tier");
    },
    now: () => new Date(now),
    log: vi.fn(),
  };
  return commitCutoverAtomic(deps, {
    uid: "uid-a",
    slug: "alice",
    toGatewayId: "target",
    fromGatewayId: "source",
    flipMirror: true,
    automatic,
    assignment: {
      source: "migrate-user",
      updatedByOperationId: "op-1",
    },
  });
}

function activationCutoverSeed(sourceClass: "shared" | "isolated" = "isolated") {
  const docs = migrationCutoverSeed();
  docs["gateways/source"] = { ...durableRoot("source", 3), gatewayClass: sourceClass, ownerUid: "uid-a", builderSlug: "alice" };
  docs["users/uid-a"] = { username: "alice", provisioning: { openclaw: {
    gatewayId: "source", migration: { state: "moving", operationId: "op-1", startedAt: 10_000 },
    activationLease: { leaseId: "lease-1", generation: 1, status: "requested", sourceGatewayId: "source", sourceAssignmentEpoch: 4 },
  } } };
  docs["gateways/source/assignments/uid-a"].updatedByOperationId = "op-1";
  docs["glmGateways/source"] = { docKind: "runtime", gatewayId: "source", createdAt: 1, release: 3,
    runtime: "cluster", lifecycle: "serving", kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: 90_000 }, heartbeat: { status: "ready", mountedCustomers: ["alice"] } };
  docs["glmOperations/op-1"] = { id: "op-1", kind: "migrate-user", status: "running", origin: "automatic",
    createdBy: "glm-controller-placement-policy", createdAt: 1, startedAt: 10_000, completedAt: null, gatewayId: "target",
    input: { uid: "uid-a", userSlug: "alice", fromGatewayId: "source", toGatewayId: "target", source: "continuous-placement-policy" },
    steps: [{ name: "verify-target", status: "done" }],
    schedulerHandoff: { migrationId: "mig-op-1:scheduler:1:claim:10000", uid: "uid-a", slug: "alice", fromGatewayId: "source", toGatewayId: "target",
      forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 4 } } };
  return docs;
}

function expectRequestedActivationCutover(docs: ReturnType<typeof activationCutoverSeed>) {
  expect(docs["users/uid-a"]).toMatchObject({ provisioning: { openclaw: {
    gatewayId: "target",
    activationLease: { leaseId: "lease-1", generation: 1, status: "requested", sourceGatewayId: "target", sourceAssignmentEpoch: 5 },
  } } });
  expect(docs["gateways/source/assignments/uid-a"]).toBeUndefined();
  expect(docs["gateways/target/assignments/uid-a"]).toMatchObject({ state: "serving", epoch: 5 });
}

describe("installed @octogee/core runtime", () => {
  it("ships the lean atomic cutover: assignment move + epoch bump, no roll fence", async () => {
    const documents = migrationCutoverSeed();

    await cutover(documents, 100_000);

    expect(documents["gateways/target/assignments/uid-a"]).toMatchObject({
      gatewayId: "target",
      state: "serving",
      epoch: 5,
      updatedByOperationId: "op-1",
    });
    expect(documents["gateways/target/assignments/uid-a"]).not.toHaveProperty("revisionId");
    expect(documents["gateways/source/assignments/uid-a"]).toBeUndefined();
    expect(documents["users/uid-a"]).toMatchObject({
      provisioning: { openclaw: { gatewayId: "target" } },
    });
  });

  it("carries an unallocated isolated onboarding owner's requested activation into its verified Shared cutover", async () => {
    const docs = activationCutoverSeed();
    await cutover(docs, 100_000, true);
    expectRequestedActivationCutover(docs);
    const after = structuredClone(docs);
    await expect(cutover(docs, 100_001, true)).rejects.toThrow("User activation source changed");
    expect(docs).toEqual(after);
  });

  it("continues moving a requested activation across ordinary Shared cutover", async () => {
    const docs = activationCutoverSeed("shared");
    await cutover(docs, 100_000);
    expectRequestedActivationCutover(docs);
  });

  it.each([
    ["operator isolated assignment", "gateways/source/assignments/uid-a", { source: "repair" }],
    ["allocated isolated root", "gateways/source", { allocation: {
      kind: "disposable-builder", schemaVersion: 1, leaseId: "another", generation: 1, claimedByUid: "uid-a",
    } }],
    ["disk-backed VM", "glmGateways/source", { runtime: "vm" }],
    ["inactive journal claim", "glmOperations/op-1", { status: "pending", startedAt: null }],
    ["stale assignment author", "gateways/source/assignments/uid-a", { updatedByOperationId: "another-move" }],
  ] as const)("preserves placement and lease when the source is %s", async (_reason, path, patch) => {
    const docs = activationCutoverSeed();
    Object.assign(docs[path], patch);
    const before = structuredClone(docs);
    await expect(cutover(docs, 100_000, true)).rejects.toThrow("User activation source changed");
    expect(docs).toEqual(before);
  });

  it("refuses to reparent a provisioned activation from an isolated onboarding source", async () => {
    const docs = activationCutoverSeed();
    const openclaw = (docs["users/uid-a"].provisioning as { openclaw: { activationLease: Record<string, unknown> } }).openclaw;
    Object.assign(openclaw.activationLease, { status: "provisioning", targetGatewayId: "allocated-target" });
    const before = structuredClone(docs);
    await expect(cutover(docs, 100_000, true)).rejects.toThrow("User activation source changed");
    expect(docs).toEqual(before);
  });

  it("refuses a cutover onto a retirement-claimed target at the transaction boundary", async () => {
    const documents = migrationCutoverSeed();
    documents["gateways/target"] = {
      ...documents["gateways/target"],
      retirementClaim: { operationId: "retire-1" },
    };

    await expect(cutover(documents, 100_000)).rejects.toThrow(/retirement claim/i);
    expect(documents["gateways/source/assignments/uid-a"]).toMatchObject({ epoch: 4 });
  });

  it("ships the atomic retirement fence against candidate config obligations", async () => {
    const documents: Record<string, Record<string, unknown>> = {
      "gateways/walter": {
        ...durableRoot("walter", 1),
        liveRevisionId: "walter-r1",
        trafficRevisionId: "walter-r1",
        roll: null,
      },
      "glmGateways/walter-r1": {
        docKind: "revision",
        revisionId: "walter-r1",
        gateway: "walter",
        release: 1,
        lifecycle: "serving",
        heartbeat: {
          mountedCustomers: [],
          configStatus: { candidateCommit: "a".repeat(40) },
        },
      },
    };
    const before = structuredClone(documents["gateways/walter"]);

    await expect(
      claimGatewayRetirementInStore({
        store: createDocumentFixtureStore(documents),
        gatewayId: "walter",
        operationId: "retire-1",
        operation: {
          kind: "retire-gateway",
          status: "pending",
          createdBy: "operator",
          createdAt: 100,
          startedAt: null,
          completedAt: null,
          input: { gatewayId: "walter" },
          steps: [],
          gatewayId: "walter",
        },
        now: 100,
        updatedBy: "operator",
      }),
    ).rejects.toBeInstanceOf(GatewayRetirementConflictError);
    expect(documents["gateways/walter"]).toEqual(before);
    expect(documents["glmOperations/retire-1"]).toBeUndefined();
  });
});
