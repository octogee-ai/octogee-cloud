import { describe, expect, it } from "vitest";
import { GLM_OPERATIONS_COLLECTION } from "@octogee/shared/types/glm";

import {
  assertWorkspaceMigrationRecoveryAuthority,
  assertWorkspaceMigrationSourcePreparationAuthority,
  clearWorkspaceMigrationPreparation,
  completeWorkspaceMigrationRecovery,
  markAssignmentState,
  setWorkspaceMigrationPhase,
} from "./fleet-state.js";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "./testing/journal-store.js";

type Row = Record<string, unknown>;
const UID = "uid-lin", SLUG = "lin", SHARED = "shared-a", TARGET = "lin-s-0a1b2c3d", OP = "op-give-1", STARTED = 1_000;
const REFUSED = "workspace migration recovery target authority changed";

function root(gatewayId: string, extra: Row = {}): Row {
  return {
    gatewayId, createdAt: 1, createdBy: "operator", updatedAt: 1, updatedBy: "operator",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
    profile: "standard", gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null, coOwnerUids: [], ...extra,
  };
}

function isolated(extra: Row = {}, allocation: Row | null = {}): Row {
  return root(TARGET, {
    gatewayClass: "isolated", imageProfile: "isolated", profile: null, sizingTier: "s", ownerUid: UID, builderSlug: SLUG,
    ...(allocation === null ? {} : { allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "operator-x", generation: 1, claimedByUid: UID, ...allocation } }),
    ...extra,
  });
}

function seed(input: { source?: string; target?: Row; sourceState?: string; openclaw?: Row } = {}): Map<string, Row> {
  const source = "source" in input ? input.source : "operator-isolated-gateway";
  return new Map<string, Row>(Object.entries({
    "config/orchestrator": { defaultGatewayId: SHARED, sharedGatewayIds: [SHARED], sizingProfiles: FIXTURE_SIZING_PROFILES },
    [`gateways/${SHARED}`]: root(SHARED),
    [`gateways/${TARGET}`]: input.target ?? isolated(),
    [`gateways/${SHARED}/assignments/${UID}`]: {
      uid: UID, slug: SLUG, gatewayId: SHARED, source: "onboarding", state: input.sourceState ?? "serving", epoch: 3,
      createdAt: 1, updatedAt: 1, updatedByOperationId: input.sourceState === "quiescing" ? OP : null,
    },
    [`users/${UID}`]: {
      username: SLUG,
      provisioning: { status: "complete", openclaw: {
        slug: SLUG, status: "complete", gatewayId: SHARED,
        migration: { state: "preparing", phase: "preparing", operationId: OP, startedAt: STARTED },
        ...input.openclaw,
      } },
    },
    [`${GLM_OPERATIONS_COLLECTION}/${OP}`]: {
      kind: "migrate-user", status: "running", createdBy: "operator", createdAt: 1, startedAt: STARTED, completedAt: null,
      input: { uid: UID, userSlug: SLUG, fromGatewayId: SHARED, toGatewayId: TARGET, ...(source ? { source } : {}) },
      steps: [], gatewayId: TARGET, inputUid: UID,
    },
  }));
}

const params = { uid: UID, slug: SLUG, sourceGatewayId: SHARED, targetGatewayId: TARGET, operationId: OP, sourceEpoch: 3, claimStartedAt: STARTED };
const prepare = (records: Map<string, Row>) =>
  assertWorkspaceMigrationSourcePreparationAuthority({ store: createDocumentFixtureStore(records) }, params);

describe("a move onto an isolated gateway, checked against the gateway's own record", () => {
  it.each([
    ["the move a give starts", "operator-isolated-gateway"],
    ["a move by hand with no source", undefined],
  ])("prepares the shared source for %s when the gateway belongs to that user", async (_name, source) => {
    await expect(prepare(seed({ source }))).resolves.toBeUndefined();
  });

  it("prepares the source whether or not the operator holds the user and whatever lease the user has", async () => {
    const lease = { leaseId: "lease-9", generation: 9, status: "parked", targetGatewayId: "another-gateway" };

    await expect(prepare(seed({ openclaw: { managedBy: "operator" } }))).resolves.toBeUndefined();
    await expect(prepare(seed({ openclaw: { activationLease: lease } }))).resolves.toBeUndefined();
  });

  it.each([
    ["owned by another user", isolated({ ownerUid: "uid-else", builderSlug: "else" }, { claimedByUid: "uid-else" })],
    ["with no allocation tag", isolated({}, null)],
  ])("refuses an isolated gateway %s", async (_name, target) => {
    await expect(prepare(seed({ target }))).rejects.toThrow(REFUSED);
  });

  it("still holds a move the product tagged with its lease source to the lease", async () => {
    await expect(prepare(seed({ source: "builder-activation-lease" }))).rejects.toThrow(REFUSED);
  });

  it("puts the user back to serving on the shared gateway when a give's move is rolled back after quiesce", async () => {
    const records = seed({ sourceState: "quiescing" });
    const deps = { store: createDocumentFixtureStore(records), now: () => new Date(2_000) };
    const recovery = { uid: UID, sourceGatewayId: SHARED, operationId: OP, sourceEpoch: 3, claimStartedAt: STARTED };

    await expect(assertWorkspaceMigrationRecoveryAuthority(deps, recovery)).resolves.toBeUndefined();
    await completeWorkspaceMigrationRecovery(deps, recovery);

    expect(records.get(`gateways/${SHARED}/assignments/${UID}`)).toMatchObject({ state: "serving", epoch: 3 });
    const openclaw = (records.get(`users/${UID}`)!.provisioning as { openclaw: Row }).openclaw;
    expect(openclaw.migration).toBeUndefined();
    expect(openclaw.gatewayId).toBe(SHARED);
  });
});

describe("workspace migration progress", () => {
  const readMarker = (records: Map<string, Row>) => (records.get(`users/${UID}`)!.provisioning as { openclaw: Row }).openclaw.migration;

  it("keeps the same move's transfer phase and start time when its source is quiesced", async () => {
    const records = seed();
    const deps = { store: createDocumentFixtureStore(records), now: () => new Date(2_000) };
    await setWorkspaceMigrationPhase(deps, { uid: UID, sourceGatewayId: SHARED, operationId: OP, phase: "transferring" });
    await markAssignmentState(deps, { gatewayId: SHARED, uid: UID, state: "quiescing", updatedByOperationId: OP });
    expect(readMarker(records)).toEqual({ state: "moving", phase: "transferring", operationId: OP, startedAt: STARTED });
  });

  it("records the checkpoint as display activity while retaining the transfer fence and clears it when the source serves again", async () => {
    const records = seed();
    const deps = { store: createDocumentFixtureStore(records), now: () => new Date(2_000) };
    await setWorkspaceMigrationPhase(deps, { uid: UID, sourceGatewayId: SHARED, operationId: OP, phase: "checkpointing" });
    expect(readMarker(records)).toEqual({ state: "moving", phase: "transferring", activity: "checkpointing", operationId: OP, startedAt: STARTED });
    await setWorkspaceMigrationPhase(deps, { uid: UID, sourceGatewayId: SHARED, operationId: OP, phase: "transferring" });
    expect(readMarker(records)).toEqual({ state: "moving", phase: "transferring", operationId: OP, startedAt: STARTED });
    await markAssignmentState(deps, { gatewayId: SHARED, uid: UID, state: "serving", updatedByOperationId: OP });
    expect(readMarker(records)).toBeUndefined();
  });

  it("does not revive source display activity after the assignment moved to the target", async () => {
    const records = seed({ openclaw: { gatewayId: TARGET, migration: undefined } });
    const operation = records.get(`${GLM_OPERATIONS_COLLECTION}/${OP}`)!;
    records.set(`${GLM_OPERATIONS_COLLECTION}/${OP}`, { ...operation, cutoverCommittedAt: 2_000 });
    const deps = { store: createDocumentFixtureStore(records), now: () => new Date(2_100) };
    await expect(setWorkspaceMigrationPhase(deps, { uid: UID, sourceGatewayId: SHARED, operationId: OP, phase: "checkpointing" })).rejects.toThrow("workspace migration phase authority changed");
    expect(readMarker(records)).toBeUndefined();
  });
});

describe("the preparation fence of a give that failed", () => {
  const SECOND = "op-give-2";
  const secondGive = (records: Map<string, Row>) => {
    records.set(`${GLM_OPERATIONS_COLLECTION}/${OP}`, { ...records.get(`${GLM_OPERATIONS_COLLECTION}/${OP}`)!, status: "failed", completedAt: 1_500 });
    records.set(`${GLM_OPERATIONS_COLLECTION}/${SECOND}`, {
      kind: "migrate-user", status: "running", createdBy: "operator", createdAt: 1_600, startedAt: 1_700, completedAt: null,
      input: { uid: UID, userSlug: SLUG, fromGatewayId: SHARED, toGatewayId: TARGET, source: "operator-isolated-gateway" },
      steps: [], gatewayId: TARGET, inputUid: UID,
    });
    return setWorkspaceMigrationPhase({ store: createDocumentFixtureStore(records), now: () => new Date(1_800) }, {
      uid: UID, sourceGatewayId: SHARED, operationId: SECOND, phase: "preparing",
    });
  };
  const fence = (records: Map<string, Row>) => (records.get(`users/${UID}`)!.provisioning as { openclaw: Row }).openclaw.migration;

  it("blocks the next move when it is left behind", async () => {
    const records = seed();

    await expect(secondGive(records)).rejects.toThrow();
    expect(fence(records)).toMatchObject({ operationId: OP });
  });

  it("is gone after the cleanup the handler now runs, and the next move takes the fence", async () => {
    const records = seed();
    await clearWorkspaceMigrationPreparation({ store: createDocumentFixtureStore(records), now: () => new Date(1_400) }, {
      uid: UID, sourceGatewayId: SHARED, operationId: OP, sourceAssignmentMode: "assigned", sourceRelease: 1, sourceEpoch: 3,
    });
    expect(fence(records)).toBeUndefined();

    await secondGive(records);

    expect(fence(records)).toMatchObject({ operationId: SECOND, phase: "preparing" });
  });
});
