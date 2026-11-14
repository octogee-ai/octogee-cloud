import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import {
  deleteProjectAgentCredentialSecrets,
  ensureAnonymousDeletionArchive,
} from "../index.js";
import { persistDeletionProductContext } from "../lib/user-ops/deletion-job.js";

const userRoot = {
  gatewayId: "alice-gw", latestRelease: 1, desiredRelease: 1, desiredStatus: "running",
  gatewayClass: "isolated", profile: "isolated", imageProfile: "isolated",
};

function deletionJob(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, uid: "uid-alice", status: "hibernating", requestedAt: Date.UTC(2026, 9, 3),
    eraseAfter: Date.UTC(2026, 10, 3), currentGatewayId: "alice-gw", ...overrides,
  };
}

const ALICE_ACCOUNT = { username: "alice", email: "alice@users.invalid", createdAt: Date.UTC(2026, 3, 9) };

function accountDocuments(account: Record<string, unknown> | undefined) {
  return { account: async () => account };
}

describe("ensureAnonymousDeletionArchive", () => {
  it("archives a platform user once from platform state and links the archive to its deletion job", async () => {
    const documents = new Map<string, Record<string, unknown>>([
      ["customerDeletionJobs/del-1", deletionJob()],
      ["gateways/alice-gw", userRoot],
    ]);
    const store = createDocumentFixtureStore(documents);

    const archiveId = await ensureAnonymousDeletionArchive(accountDocuments(ALICE_ACCOUNT), store, "del-1", null);

    expect(documents.get("customerDeletionJobs/del-1")).toMatchObject({ archiveId, updatedAt: expect.any(Number) });
    expect(documents.get(`anonymousOperationalArchives/${archiveId}`)).toMatchObject({
      schemaVersion: 1, accountCreatedMonth: "2026-04", gatewayClass: "isolated", archivedAt: expect.any(Number),
      totals: { costUsd: 0, totalTokens: 0, requestCount: 0 },
    });
    await expect(ensureAnonymousDeletionArchive(accountDocuments(ALICE_ACCOUNT), store, "del-1", null)).resolves.toBe(archiveId);
    expect([...documents.keys()].filter((path) => path.startsWith("anonymousOperationalArchives/"))).toHaveLength(1);
  });

  it("adds the product's archive fields and usage rollup", async () => {
    const documents = new Map<string, Record<string, unknown>>([
      ["customerDeletionJobs/del-1", deletionJob()],
      ["gateways/alice-gw", userRoot],
    ]);
    const product = {
      archive: async (uid: string, account: Record<string, unknown> | undefined) => ({
        fields: { planTier: `${uid}:${String(account?.username)}` },
        usageRollup: { costUsd: 2.5, totalTokens: 900, requestCount: 3 },
      }),
    };

    const archiveId = await ensureAnonymousDeletionArchive(accountDocuments(ALICE_ACCOUNT), createDocumentFixtureStore(documents), "del-1", product);

    expect(documents.get(`anonymousOperationalArchives/${archiveId}`)).toMatchObject({
      planTier: "uid-alice:alice",
      totals: { costUsd: 2.5, totalTokens: 900, requestCount: 3 },
    });
  });

  it("refuses a vanished deletion job instead of archiving an unknown user", async () => {
    await expect(ensureAnonymousDeletionArchive(accountDocuments(undefined), createDocumentFixtureStore({}), "del-1", null))
      .rejects.toThrow("deletion job missing: del-1");
  });
});

describe("persistDeletionProductContext", () => {
  it("records Stripe references without dropping the PostHog erasure state already on the job", async () => {
    const posthogErasure = { status: "requested", personIds: ["person-1"] };
    const documents = new Map<string, Record<string, unknown>>([
      ["customerDeletionJobs/del-1", deletionJob({ posthogErasure, stripeCustomerIds: ["cus_old"] })],
    ]);

    await persistDeletionProductContext(createDocumentFixtureStore(documents), "del-1", { stripeCustomerIds: ["cus_1"], stripeSubscriptionIds: ["sub_1"] });

    expect(documents.get("customerDeletionJobs/del-1")).toMatchObject({
      posthogErasure, stripeCustomerIds: ["cus_1"], stripeSubscriptionIds: ["sub_1"], updatedAt: expect.any(Number),
    });
  });

  it("refuses a vanished deletion job instead of creating one", async () => {
    const documents = new Map<string, Record<string, unknown>>();
    await expect(persistDeletionProductContext(createDocumentFixtureStore(documents), "del-1", { stripeCustomerIds: [] }))
      .rejects.toThrow("deletion job missing: del-1");
    expect(documents.size).toBe(0);
  });
});

describe("deleteProjectAgentCredentialSecrets", () => {
  it("deletes each project-agent Mattermost credential of the suspended user", async () => {
    const documents = new Map<string, Record<string, unknown>>([
      ["users/uid-alice/secrets/projectAgentMattermost-p1", { personalToken: "t1" }],
      ["users/uid-alice/secrets/projectAgentMattermost-p2", { personalToken: "t2" }],
      ["users/uid-alice/secrets/coachMattermost", { personalToken: "coach" }],
    ]);

    await deleteProjectAgentCredentialSecrets(createDocumentFixtureStore(documents), [
      "users/uid-alice/secrets/projectAgentMattermost-p1",
      "users/uid-alice/secrets/projectAgentMattermost-p2",
    ]);

    expect([...documents.keys()]).toEqual(["users/uid-alice/secrets/coachMattermost"]);
  });

  it("refuses a credential path outside a user's secrets before deleting any", async () => {
    const documents = new Map<string, Record<string, unknown>>([
      ["users/uid-alice/secrets/projectAgentMattermost-p1", { personalToken: "t1" }],
    ]);

    await expect(deleteProjectAgentCredentialSecrets(createDocumentFixtureStore(documents), [
      "users/uid-alice/secrets/projectAgentMattermost-p1",
      "workspaces/alice/projects/p1",
    ])).rejects.toThrow("project-agent credential is not a user secret: workspaces/alice/projects/p1");
    expect(documents.has("users/uid-alice/secrets/projectAgentMattermost-p1")).toBe(true);
  });
});
