import { describe, expect, it } from "vitest";
import type { PlatformStateStore, UserAccountRecord } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { controllerUserSeams, readMigrationUserSnapshot } from "../index.js";
import { platformStateUserDocuments, userDocumentsSizingKeyReader, type UserDocuments } from "../user-documents.js";

const LIN: UserAccountRecord = { uid: "uid-lin", name: "lin", email: "lin@users.invalid", createdAt: 1_700_000_000_000 };

function platformStore(accounts: readonly UserAccountRecord[], extra: Record<string, Record<string, unknown>> = {}): PlatformStateStore {
  const fixture = createDocumentFixtureStore({
    ...extra,
    "users/uid-lin": {
      username: "lin",
      mattermost: { userId: "mm-lin" },
      provisioning: {
        status: "complete",
        git: { repoUrl: "http://gitea.invalid/lin/workspace.git" },
        openclaw: { slug: "lin", gatewayId: "shared-b", status: "complete", agentIds: ["lin-main"] },
      },
    },
  });
  const byUid = new Map(accounts.map((account) => [account.uid, account]));
  return {
    ...fixture,
    users: { ...fixture.users, accounts: { get: async (uid: string) => byUid.get(uid) ?? null } },
  } as unknown as PlatformStateStore;
}

describe("move snapshot from platform state", () => {
  it("builds the snapshot of a user the platform created, with no product documents", async () => {
    const store = platformStore([LIN]);

    const snapshot = await readMigrationUserSnapshot(platformStateUserDocuments(store), store, "uid-lin", "shared-a");

    expect(snapshot).toMatchObject({
      uid: "uid-lin",
      slug: "lin",
      gatewayId: "shared-b",
      status: "complete",
      agentIds: ["lin-main"],
      repoUrl: "http://gitea.invalid/lin/workspace.git",
      mattermostUserId: "mm-lin",
      email: "lin@users.invalid",
      ownerName: "lin",
      byotActive: false,
      projectCheckoutScope: "workspace-only",
    });
    expect(snapshot).not.toHaveProperty("coachIdentity");
    expect(snapshot).not.toHaveProperty("systemConfig");
  });

  it("reads the agent identity a product supplies and the owner's stored model credential", async () => {
    const store = platformStore([LIN], {
      "modelCredentials/uid-lin": {
        uid: "uid-lin", active: true, provider: "openrouter", mode: "api_key", status: "active", reasonCode: "ok",
        secretName: "byok-lin-openrouter", fingerprint: null, keyHash: null, baseUrl: null, model: "openrouter/auto",
        addedAt: 1, lastUsedAt: null,
      },
    });
    const documents: UserDocuments = {
      account: async () => ({ username: "lin", displayName: "Lin", email: "lin@users.invalid" }),
      agent: async () => ({ name: "Ada", avatarEmoji: "🐙" }),
    };

    const snapshot = await readMigrationUserSnapshot(documents, store, "uid-lin", "shared-a");

    expect(snapshot).toMatchObject({
      ownerName: "Lin",
      byotActive: true,
      systemConfig: { byot: { provider: "openrouter", model: "openrouter/auto" } },
      coachIdentity: { name: "Ada", emoji: "🐙" },
    });
  });

  it("has no snapshot for a user without an account", async () => {
    const store = platformStore([]);

    await expect(readMigrationUserSnapshot(platformStateUserDocuments(store), store, "uid-lin", "shared-a")).resolves.toBeNull();
  });

  it("reads the cutover sizing key from the platform account", async () => {
    const store = platformStore([LIN]);
    const readSizingKey = userDocumentsSizingKeyReader(platformStateUserDocuments(store));

    await expect(readSizingKey("uid-lin", 1)).resolves.toEqual(expect.any(String));
    await expect(readSizingKey("uid-nobody", 1)).resolves.toBeNull();
  });

  it("uses platform documents unless the product supplies its own", async () => {
    const store = platformStore([LIN]);
    const productDocuments: UserDocuments = {
      account: async () => ({ username: "from-product" }),
      agent: async () => undefined,
    };

    const platform = controllerUserSeams({ userLifecycle: null }, store, () => undefined).documents;
    const product = controllerUserSeams({ userLifecycle: null, userDocuments: () => productDocuments }, store, () => undefined).documents;

    await expect(platform.account("uid-lin")).resolves.toEqual({ username: "lin", email: "lin@users.invalid", createdAt: LIN.createdAt });
    expect(product).toBe(productDocuments);
  });
});
