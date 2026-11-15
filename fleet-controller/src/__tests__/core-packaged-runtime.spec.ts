import { describe, expect, it, vi } from "vitest";
import { commitCutoverAtomic, type CutoverDeps } from "@octogee/core/fleet-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
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

function cutover(documents: Record<string, Record<string, unknown>>, now: number) {
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
    assignment: {
      source: "migrate-user",
      updatedByOperationId: "op-1",
    },
  });
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
