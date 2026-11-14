import express, { Router } from "express";
import type { Firestore } from "firebase-admin/firestore";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { addAdminFleetRoutes } from "@octogee/core/admin-fleet-router";
import type { AgentStoreErasureCustody } from "@octogee/core/agent-store-credentials";
import type { OpaqueMap } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { firestoreUserAccountReader } from "@octogee/core/testing/firestore-user-accounts";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import type { UserCleanupContext } from "../handlers/deprovision-user.js";
import { createEraseUserHandler, type EraseUserDeps } from "../handlers/erase-user.js";
import { createSuspendUserHandler } from "../handlers/suspend-user.js";
import { createUserAgentStoreErasure } from "../lib/user-ops/agent-store-erasure.js";
import { markSuspendedAndReleaseErasure } from "../lib/user-ops/erasure-release.js";
import { buildOperationCompletionUpdate } from "../operation-retry.js";

type Records = Map<string, Record<string, unknown>>;

const UID = "uid-ada";
const COACH = "octogee-ada-coach";
const STORE_TARGET = {
  namespace: "octogee_agent_ada", namespaceOid: "123", owner: "shared", family: "agent" as const, role: "agent" as const,
  storeId: "d57c47b6-c455-4c58-a30e-30dc01d7d80a", agentId: COACH,
};
const CUSTODY = {
  [`users/${UID}/agentStores/${COACH}`]: {
    agentId: COACH, gatewayId: "shared-a", assignmentEpoch: 1, storeId: STORE_TARGET.storeId, schema: STORE_TARGET.namespace, recordedAt: 1,
  },
};

function provisionedUserOnSharedGateway(custody: Record<string, Record<string, unknown>>): Records {
  return new Map(Object.entries({
    "gateways/shared-a": {
      gatewayId: "shared-a", createdAt: 1, createdBy: "operator", updatedAt: 1, updatedBy: "operator",
      latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
      profile: "standard", gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
      gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
      ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null, coOwnerUids: [],
    },
    [`users/${UID}`]: {
      username: "ada",
      provisioning: { status: "complete", openclaw: { slug: "ada", gatewayId: "shared-a", status: "complete" } },
    },
    [`gateways/shared-a/assignments/${UID}`]: {
      uid: UID, slug: "ada", gatewayId: "shared-a", source: "onboarding", state: "serving", epoch: 1,
      createdAt: 1, updatedAt: 1, updatedByOperationId: null,
    },
    ...custody,
  }));
}

function adminApi(records: Records) {
  const account = { get: async () => ({ id: UID, exists: true, data: () => ({ email: "ada@example.com" }) }) };
  const db = { collection: () => ({ doc: () => account }), doc: () => account } as unknown as Firestore;
  const router = Router();
  addAdminFleetRoutes(router, {
    accounts: firestoreUserAccountReader(db),
    store: createDocumentFixtureStore(records),
    logger: { info: vi.fn(), warn: vi.fn() },
    provisionGatewayAuthSecret: vi.fn(async () => ({})),
    listGatewayBuilds: vi.fn(async () => []),
    suspendAuthUser: vi.fn(async () => undefined),
    revokeConnectorGrantsForUser: vi.fn(async () => undefined),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { uid: "operator", isAdmin: true });
    next();
  });
  return app.use(router);
}

function operation(records: Records, id: string): Operation {
  return { id, ...records.get(`glmOperations/${id}`) } as Operation;
}

async function suspend(records: Records, suspensionOperationId: string): Promise<void> {
  const store = createDocumentFixtureStore(records);
  const steps: OperationStep[] = [];
  const done = vi.fn(async () => undefined);
  const result = await createSuspendUserHandler({
    loadDeletionJob: async (id) => {
      const job = await store.jobs.deletions.get(id);
      return job === null ? null : {
        uid: job.uid ?? "", slug: job.slug ?? null, currentGatewayId: job.currentGatewayId ?? null,
        productContext: job.productContext ?? {},
        cleanupContext: (job.cleanupContext as UserCleanupContext | undefined) ?? null,
      };
    },
    loadCleanupContext: async (uid) => {
      const user = await store.users.records.get(uid);
      return user === null ? null : {
        uid, slug: user.slug ?? "", email: "ada@example.com", giteaOrg: user.slug ?? "", repoNames: [], projectSlugs: [],
        workspaceTeamId: null, mmUserId: null, mmCoachUserId: null, adminChannelId: null,
        currentGatewayId: user.gateway?.gatewayId ?? null, credentialSecretNames: [], projectAgentMmUserIds: [],
        projectAgentCredentialDocPaths: [], chatArtifactIds: [], agentImportIds: [],
      };
    },
    persistCleanupContext: (id, cleanup) =>
      store.jobs.deletions.patch(id, { cleanupContext: cleanup as unknown as OpaqueMap, status: "suspending", updatedAt: Date.now() }),
    markSuspended: (id) => markSuspendedAndReleaseErasure(store, id, Date.now()),
    assertRestoreNotInProgress: done,
    blockChatSignIn: done,
    blockGitSignIn: done,
    cancelUserMigrations: vi.fn(async () => false),
    deactivateUserVisibility: done,
    unmountFromGateway: vi.fn(async () => "unmounted" as const),
    releasePlacement: done,
    revokeConnectorGrants: done,
    revokeModelBrokerAccess: done,
    deleteCredentialSecrets: done,
    retireProjectAgentMattermostUsers: done,
    deleteProjectAgentCredentialDocs: done,
    ensureOwnedGatewaysRetired: vi.fn(async () => "not-owned" as const),
    now: Date.now,
  })(operation(records, suspensionOperationId), { reportStep: async (step: OperationStep) => { steps.push(step); } } as never);
  expect(result).toMatchObject({ success: true });
  records.set(`glmOperations/${suspensionOperationId}`, {
    ...records.get(`glmOperations/${suspensionOperationId}`), status: "succeeded", steps,
  });
}

async function erase(records: Records, erasureOperationId: string, cloudErase: EraseUserDeps["cloudErase"] = async () => []) {
  const store = createDocumentFixtureStore(records);
  records.set(`glmOperations/${erasureOperationId}`, {
    ...records.get(`glmOperations/${erasureOperationId}`), status: "running", startedAt: Date.now(),
  });
  const unmountSharedUser = vi.fn(async () => undefined);
  const finalizeVerifiedErasure = vi.fn(async () => undefined);
  const result = await createEraseUserHandler({
    loadDeletionJob: async (id) => {
      const job = await store.jobs.deletions.get(id);
      return job === null ? null : {
        uid: job.uid ?? "", status: job.status, eraseAfter: job.eraseAfter, productContext: job.productContext ?? {},
        archiveId: job.archiveId ?? null, cleanupContext: (job.cleanupContext as UserCleanupContext | undefined) ?? null,
      };
    },
    eraseAgentStores: createUserAgentStoreErasure({
      store,
      now: Date.now,
      eraseStores: async (_cleanup, custody: AgentStoreErasureCustody) => {
        await custody.assertWritersStopped([STORE_TARGET]);
        await custody.bindTargets([STORE_TARGET]);
        await custody.assertCurrent();
      },
      sharedGatewayRetired: async () => false,
      runtimeAbsent: async () => true,
      ownerHomeAbsent: async () => true,
      readSharedSource: async (gatewayId) => ({ gatewayId, podUid: "pod-a", startedAt: 1, status: "ready", customers: [], migratingIn: [] }),
      unmountSharedUser,
    }),
    ensureAnonymousArchive: vi.fn(async () => "archive-1"),
    retainProductVerificationContext: vi.fn(async () => undefined),
    ensureOwnedGatewayRetired: vi.fn(async () => "not-owned" as const),
    findUndrainedArtifactIds: vi.fn(async () => []),
    cloudErase,
    verifyErasure: vi.fn(async () => []),
    finalizeVerifiedErasure,
    now: Date.now,
  })(operation(records, erasureOperationId), {
    reportStep: async () => undefined, assertActiveClaim: async () => undefined,
  } as never);
  return { result, unmountSharedUser, finalizeVerifiedErasure };
}

async function unassignThenSuspendDeletion(records: Records) {
  const app = adminApi(records);
  await request(app).post(`/users/${UID}/unassign`).expect(200);
  const scheduled = await request(app).post(`/users/${UID}/delete`).send({ eraseNow: true }).expect(202);
  const { deletionId, suspensionOperationId, erasureOperationId } = scheduled.body as Record<string, string>;
  expect(records.get(`customerDeletionJobs/${deletionId}`)?.currentGatewayId ?? null).toBeNull();
  await suspend(records, suspensionOperationId);
  return { deletionId, erasureOperationId };
}

async function unassignThenDelete(records: Records) {
  const { deletionId, erasureOperationId } = await unassignThenSuspendDeletion(records);
  return { deletionId, ...await erase(records, erasureOperationId) };
}

describe("deleting a user who was unassigned first", () => {
  it("finishes erasure after stopping writers on the gateway that held the user's agent stores", async () => {
    const records = provisionedUserOnSharedGateway(CUSTODY);

    const { deletionId, result, unmountSharedUser, finalizeVerifiedErasure } = await unassignThenDelete(records);

    expect(result).toMatchObject({ success: true, output: { verifiedDeletion: { deletionId, archiveId: "archive-1" } } });
    expect(unmountSharedUser).toHaveBeenCalledExactlyOnceWith(
      "shared-a", expect.objectContaining({ uid: UID, currentGatewayId: null }), { podUid: "pod-a", agentIds: [COACH] }, expect.anything(),
    );
    expect(finalizeVerifiedErasure).toHaveBeenCalledOnce();
  });

  it("finishes on the retry after cloud cleanup removed the user and their custody records but failed a later step", async () => {
    const records = provisionedUserOnSharedGateway(CUSTODY);
    const { deletionId, erasureOperationId } = await unassignThenSuspendDeletion(records);

    const interrupted = await erase(records, erasureOperationId, async () => {
      records.delete(`users/${UID}`);
      records.delete(`users/${UID}/agentStores/${COACH}`);
      return [{ key: "mattermost", ok: false, error: "service unavailable" }];
    });
    const retried = await erase(records, erasureOperationId);

    expect(interrupted.result).toMatchObject({ success: false, output: { deletionCleanupRetry: { deletionId } } });
    expect(retried.result).toMatchObject({ success: true, output: { verifiedDeletion: { deletionId } } });
    expect(retried.unmountSharedUser).not.toHaveBeenCalled();
  });

  it("ends the erase operation as failed, not retried, when no gateway can be named for the user's agent stores", async () => {
    const records = provisionedUserOnSharedGateway({});

    const { deletionId, result, unmountSharedUser, finalizeVerifiedErasure } = await unassignThenDelete(records);

    expect(result).toMatchObject({ success: false, output: { deletionBlocked: { deletionId, step: "erase-agent-stores" } } });
    expect(result.error).toContain("unassigned before deletion");
    const completion = buildOperationCompletionUpdate({
      op: { kind: "erase-user", attempts: 0, attemptHistory: [] }, result, steps: [], now: Date.now(),
    });
    expect(completion.status).toBe("failed");
    expect(completion.attemptHistory).toEqual([expect.objectContaining({ classification: "terminal" })]);
    expect(unmountSharedUser).not.toHaveBeenCalled();
    expect(finalizeVerifiedErasure).not.toHaveBeenCalled();
  });
});
