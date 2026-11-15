import { afterEach, describe, expect, it, vi } from "vitest";
import { MalformedRecordError, type PlatformStateStore } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { buildUserCloudCleanupDeps } from "../index.js";
import type { ProductUserLifecycle, UserDataScope } from "../lib/user-ops/user-lifecycle-product.js";
import { remainingPlatformUserState } from "../lib/user-ops/user-platform-state-erasure.js";

const SCOPE: UserDataScope = {
  uid: "uid-ada", slug: "ada", email: "ada@users.invalid", chatArtifactIds: [], agentImportIds: [], currentOperationId: "erase-1",
};

function adaRecords(): Map<string, Record<string, unknown>> {
  return new Map(Object.entries({
    "users/uid-ada": { username: "ada", provisioning: { openclaw: { slug: "ada", gatewayId: "shared-a" } } },
    "agents/uid-ada": { mattermost: { userId: "mm-coach" } },
    "workspaces/ada": { id: "ada", slug: "ada", ownerUid: "uid-ada" },
    "gateways/shared-a/assignments/uid-ada": {
      uid: "uid-ada", slug: "ada", gatewayId: "shared-a", source: "onboarding", state: "serving", epoch: 1,
    },
    "users/uid-bo": { username: "bo" },
  }));
}

function productData(): ProductUserLifecycle["data"] {
  return {
    eraseStorage: vi.fn(async () => undefined),
    eraseVmHome: vi.fn(async () => ({ deleted: 0 })),
    eraseRecords: vi.fn(async () => undefined),
    deleteSignIn: vi.fn(async () => undefined),
    remaining: vi.fn(async () => []),
    undrainedArtifactIds: vi.fn(async () => []),
  };
}

function withProductData(data: ProductUserLifecycle["data"]): ProductUserLifecycle {
  return { data } as unknown as ProductUserLifecycle;
}

function stubCleanupEnvironment(blobStoreBackend: string) {
  vi.stubEnv("GIT_API_URL", "http://gitea.invalid/api/v1");
  vi.stubEnv("GIT_API_TOKEN", "test-token");
  vi.stubEnv("MM_URL", "http://mattermost.invalid");
  vi.stubEnv("MM_ADMIN_TOKEN", "test-token");
  vi.stubEnv("BLOB_STORE_BACKEND", blobStoreBackend);
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("user erasure cleanup without a product", () => {
  it("erases the user's platform state and leaves other users alone", async () => {
    stubCleanupEnvironment("gcs");
    const records = adaRecords();
    const store = createDocumentFixtureStore(records);

    await buildUserCloudCleanupDeps(store, vi.fn(), undefined, null).eraseUserRecords(SCOPE);

    await expect(remainingPlatformUserState(store, "uid-ada", "ada", "erase-1")).resolves.toEqual([]);
    expect([...records.keys()]).toEqual(["users/uid-bo"]);
  });

  it("has no sign-in or computer home to delete", () => {
    stubCleanupEnvironment("gcs");

    const deps = buildUserCloudCleanupDeps(createDocumentFixtureStore({}), vi.fn(), undefined, null);

    expect(deps.deleteSignIn).toBeUndefined();
    expect(deps.deleteVmHome).toBeUndefined();
  });

  it("refuses to report storage erased when no blob store can erase it", async () => {
    stubCleanupEnvironment("gcs");

    const deps = buildUserCloudCleanupDeps(createDocumentFixtureStore({}), vi.fn(), undefined, null);

    await expect(deps.deleteUserStorage(SCOPE)).rejects.toThrow("user blob erasure is not available for BLOB_STORE_BACKEND=gcs");
  });
});

describe("user erasure cleanup with a product", () => {
  it("erases the product's records before the platform state they reference", async () => {
    stubCleanupEnvironment("gcs");
    const store = createDocumentFixtureStore(adaRecords());
    const data = productData();
    vi.mocked(data.eraseRecords).mockImplementation(async () => {
      expect(await remainingPlatformUserState(store, "uid-ada", "ada", "erase-1")).toContain("users/uid-ada");
    });

    await buildUserCloudCleanupDeps(store, vi.fn(), undefined, withProductData(data)).eraseUserRecords(SCOPE);

    expect(data.eraseRecords).toHaveBeenCalledWith(SCOPE);
    await expect(remainingPlatformUserState(store, "uid-ada", "ada", "erase-1")).resolves.toEqual([]);
  });

  it("erases no product records while a platform reference record is malformed", async () => {
    stubCleanupEnvironment("gcs");
    const records = adaRecords();
    records.set("modelBrokerTokens/legacy", {
      capped: false, gatewayId: "shared-a", ownerUid: "uid-ada", provider: "anthropic", secretName: "broker-secret",
      createdAt: 1, expiresAt: null, limits: { spendWindowUsd: null, spendWeekUsd: null, requestsPerMinute: null },
    });
    const data = productData();

    await expect(buildUserCloudCleanupDeps(createDocumentFixtureStore(records), vi.fn(), undefined, withProductData(data)).eraseUserRecords(SCOPE))
      .rejects.toBeInstanceOf(MalformedRecordError);

    expect(data.eraseRecords).not.toHaveBeenCalled();
    expect(records.has("users/uid-ada")).toBe(true);
  });

  it("hands storage, computer home and sign-in erasure to the product", async () => {
    stubCleanupEnvironment("gcs");
    const data = productData();

    const deps = buildUserCloudCleanupDeps(createDocumentFixtureStore({}), vi.fn(), undefined, withProductData(data));
    await deps.deleteUserStorage(SCOPE);
    await deps.deleteVmHome?.("ada");
    await deps.deleteSignIn?.("uid-ada");

    expect(data.eraseStorage).toHaveBeenCalledWith(SCOPE);
    expect(data.eraseVmHome).toHaveBeenCalledWith("ada");
    expect(data.deleteSignIn).toHaveBeenCalledWith("uid-ada");
  });
});

describe("user erasure and the provisioning service", () => {
  const chatSecret = (personalToken: string) => ({
    kind: "builder-mattermost" as const, secretId: "mattermost", projectId: null, personalToken, mattermostUserId: "mm-ada", createdAt: 1, rotatedAt: null,
  });

  function racingStore(records: Map<string, Record<string, unknown>>, race: { before?: boolean; after?: boolean }): PlatformStateStore {
    const store = createDocumentFixtureStore(records);
    const users = new Proxy(store.users.records, {
      get(target, property, receiver) {
        if (property !== "delete") return Reflect.get(target, property, receiver);
        return async (uid: string) => {
          if (race.before) await store.secrets.put(uid, chatSecret("written-before-the-record-delete"));
          await target.delete(uid);
          if (race.after) await store.secrets.put(uid, chatSecret("written-after-the-record-delete"));
        };
      },
    });
    return new Proxy(store, {
      get(target, property, receiver) {
        if (property === "users") return { ...target.users, records: users };
        return Reflect.get(target, property, receiver);
      },
    });
  }

  it("hands erasure the provisioning delete and leaves it out of the record erasure", async () => {
    stubCleanupEnvironment("gcs");
    const records = adaRecords();
    const provisioning = { deleteProvisioning: vi.fn(async () => "deleted" as const) };
    const deps = buildUserCloudCleanupDeps(createDocumentFixtureStore(records), vi.fn(), undefined, null, provisioning);

    await expect(deps.deleteProvisioning?.("uid-ada")).resolves.toBe("deleted");
    await deps.eraseUserRecords(SCOPE);

    expect(provisioning.deleteProvisioning).toHaveBeenCalledTimes(1);
    expect(records.has("users/uid-ada")).toBe(false);
  });

  it("has no provisioning delete when no provisioning service is configured", () => {
    stubCleanupEnvironment("gcs");

    expect(buildUserCloudCleanupDeps(createDocumentFixtureStore({}), vi.fn(), undefined, null).deleteProvisioning).toBeUndefined();
  });

  it("leaves no chat secret row when a mirror write lands between the secret deletion and the record deletion", async () => {
    stubCleanupEnvironment("gcs");
    const records = adaRecords();
    const store = racingStore(records, { before: true });

    await buildUserCloudCleanupDeps(store, vi.fn(), undefined, null).eraseUserRecords(SCOPE);

    await expect(store.secrets.list("uid-ada")).resolves.toEqual([]);
    expect([...records.keys()].filter((path) => path.startsWith("users/uid-ada"))).toEqual([]);
  });

  it("deletes a chat secret row written after the record deletion as its last step", async () => {
    stubCleanupEnvironment("gcs");
    const records = adaRecords();
    const store = racingStore(records, { after: true });

    await buildUserCloudCleanupDeps(store, vi.fn(), undefined, null).eraseUserRecords(SCOPE);

    await expect(store.secrets.list("uid-ada")).resolves.toEqual([]);
    expect([...records.keys()].filter((path) => path.startsWith("users/uid-ada"))).toEqual([]);
  });
});

