import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore, FIXTURE_SIZING_PROFILES } from "@octogee/core-testing/journal-store";
import { createAdminFleetMutationRunner, respondToAdminFleetMutationError } from "@octogee/core/admin-fleet-router";
import { addAdminPlacementIsolatedRoutes } from "@octogee/core/admin-placement-isolated-router";
import { builderActivateOperationId } from "@octogee/shared/types/isolated-operation-ids";
import { adminPlacementCapabilities } from "../admin-placement-capabilities.js";

type Data = Record<string, unknown>;

const OWNER = "uid-alice";
const TARGET = "alice-xs-12345678";
const ACTIVATION = builderActivateOperationId(TARGET, 1);
const RETIREMENT = `placement-retire-${OWNER}-${TARGET}-g1`;

function failedActivation(fields: Data = {}): Data {
  return {
    kind: "migrate-user", status: "failed", createdBy: "glm-controller-placement-policy", createdAt: 1, startedAt: 2, completedAt: 3,
    error: "final-sync-state: target unreachable", attempts: 1, inputUid: OWNER, schedulerHandoffReleased: true,
    input: { uid: OWNER, userSlug: "alice", source: "builder-activation-lease", fromGatewayId: "shared-blue", toGatewayId: TARGET, recoverSourceOnly: true },
    schedulerHandoff: { migrationId: `mig-${ACTIVATION}:scheduler:1:claim:2`, uid: OWNER, slug: "alice", fromGatewayId: "shared-blue", toGatewayId: TARGET, stageAfterCutover: true },
    steps: [{ name: "quiesce-source", status: "done" }, { name: "final-sync-state", status: "failed", error: "target unreachable" }],
    ...fields,
  };
}

function harness(activation: Data) {
  const docs = new Map<string, Data>(Object.entries({
    "config/orchestrator": { placementAutomationOwner: "client", placementAutomationYieldedAt: 1_000,
      sizingProfiles: { ...FIXTURE_SIZING_PROFILES, default: FIXTURE_SIZING_PROFILES.hobby } },
    [`users/${OWNER}`]: { username: "alice", provisioning: { status: "complete", openclaw: { gatewayId: "shared-blue", slug: "alice", activationLease: {
      leaseId: "lease-one", generation: 1, status: "failed", cause: "run-start", builderSlug: "alice", sourceGatewayId: "shared-blue",
      sourceAssignmentEpoch: 4, entitlementTier: "default", sizingTier: "s", targetGatewayId: TARGET, requestedAt: 10_000, activationOperationId: ACTIVATION,
    } } } },
    [`gateways/${TARGET}`]: {
      gatewayId: TARGET, createdAt: 1, createdBy: "test", updatedAt: 5, updatedBy: "test", latestRelease: 1, desiredRelease: 1, liveRelease: 1,
      desiredStatus: "paused", configSchemaVersion: 1, profile: null, gatewayClass: "isolated", imageProfile: "isolated", sizingTier: "s",
      sizingProfile: "default", gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null,
      builderAccess: null, ownerUid: OWNER, builderSlug: "alice", modelBrokerLimits: null,
      allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-one", generation: 1, claimedByUid: OWNER },
    },
    [`glmOperations/${ACTIVATION}`]: activation,
  }));
  const store = createDocumentFixtureStore(docs, { serializeTransactions: true });
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = "automation@example.iam.gserviceaccount.com";
    next();
  });
  addAdminPlacementIsolatedRoutes(server, {
    store,
    journal: createAdminFleetMutationRunner(store),
    accounts: { get: async (uid: string) => ({ uid, username: "alice", email: null, displayName: null, lastActive: null, planInputs: {}, usage: {}, mattermostUsername: null }) as never },
    capabilities: {
      namespace: "octogee-test",
      sourceRecoveryPending: adminPlacementCapabilities.schedulerHandoffAwaitingRelease,
      ensureAuthSecret: vi.fn(async () => undefined),
      readGatewayPodDiagnostics: vi.fn(async () => ({ status: "missing", totalPods: 0 })),
    },
    log: vi.fn(),
    warn: vi.fn(),
    now: () => 50_000,
  });
  server.use(respondToAdminFleetMutationError);
  const retire = () => request(server).post(`/isolated-gateways/${TARGET}/retire-owned`)
    .send({ ownerUid: OWNER, leaseId: "lease-one", generation: 1, reason: "activation-failed" });
  return { docs, retire };
}

describe("activation-failed cleanup gated by the platform's own source recovery verdict", () => {
  it("refuses while the failed activation still recovers its source", async () => {
    const h = harness(failedActivation());

    const res = await h.retire().expect(409);

    expect(res.body).toMatchObject({ code: "precondition-failed", reasonCode: "source-recovery-pending",
      error: `operation ${ACTIVATION} is still recovering its source` });
    expect(h.docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("paused");
    expect(h.docs.has(`glmOperations/${RETIREMENT}`)).toBe(false);
  });

  it("retires once the activation is rolled back", async () => {
    const h = harness(failedActivation({ rolledBack: true }));

    await h.retire().expect(200);

    expect(h.docs.get(`gateways/${TARGET}`)?.desiredStatus).toBe("retired");
    expect(h.docs.get(`glmOperations/${RETIREMENT}`)).toMatchObject({ kind: "retire-gateway", input: { reason: "activation-failed" } });
  });
});
