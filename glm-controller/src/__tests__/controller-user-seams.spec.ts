import { noAdminUserDirectorySource } from "@octogee/core/admin-user-directory-router";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { describe, expect, it, vi } from "vitest";
import { controllerUserSeams } from "../index.js";
import { noUserPolicyInputs } from "../user-placement-document.js";

const ADA = { uid: "u-ada", name: "ada", email: "ada@example.test", createdAt: 1, revision: "1" };

function platformStore() {
  const transaction = { users: { records: { admit: vi.fn(async () => undefined) }, accounts: { create: vi.fn(async () => undefined) } } };
  const store = {
    transaction: vi.fn(async (_options: unknown, body: (tx: unknown) => Promise<unknown>) => body(transaction)),
    users: { accounts: { get: vi.fn(async (uid: string) => (uid === ADA.uid ? ADA : null)) } },
  };
  return { store: store as unknown as PlatformStateStore, transaction };
}

describe("controller user seams", () => {
  it("adds, admits and reads users from the platform state store when no product supplies them", async () => {
    const { store, transaction } = platformStore();

    const seams = controllerUserSeams({ userLifecycle: null }, store, vi.fn());

    await expect(seams.userAccounts.create({ userId: "u-ada", name: "ada", email: "ada@example.test" }))
      .resolves.toEqual({ kind: "created", userId: "u-ada" });
    expect(transaction.users.records.admit).toHaveBeenCalledWith("u-ada", expect.objectContaining({ slug: "ada", persona: null }));
    expect(transaction.users.accounts.create).toHaveBeenCalledWith(expect.objectContaining({ uid: "u-ada", name: "ada", email: "ada@example.test" }));
    await expect(seams.accounts.get("u-ada")).resolves.toMatchObject({ uid: "u-ada", username: "ada", email: "ada@example.test" });
    expect(seams.userDirectory).toBe(noAdminUserDirectorySource);
    expect(seams.adminUserDetail).toBeUndefined();
    expect(seams.policyInputs).toBe(noUserPolicyInputs);
  });

  it("builds each product seam from the platform state store in place of the platform default", () => {
    const { store } = platformStore();
    const log = vi.fn();
    const supplied = {
      userAccounts: { create: vi.fn() },
      accountReader: { get: vi.fn(), getMany: vi.fn(), list: vi.fn() },
      userDocuments: { account: vi.fn(), agent: vi.fn() },
      userDirectory: { ...noAdminUserDirectorySource },
      adminUserDetail: vi.fn(),
      userPolicyInputs: { current: vi.fn(), list: vi.fn(), subscribe: vi.fn() },
    };
    const product = {
      userLifecycle: null,
      userAccounts: vi.fn(() => supplied.userAccounts),
      accountReader: vi.fn(() => supplied.accountReader),
      userDocuments: vi.fn(() => supplied.userDocuments),
      userDirectory: vi.fn(() => supplied.userDirectory),
      adminUserDetail: vi.fn(() => supplied.adminUserDetail),
      userPolicyInputs: vi.fn(() => supplied.userPolicyInputs),
    };

    const seams = controllerUserSeams(product as never, store, log);

    expect(seams).toEqual({
      userAccounts: supplied.userAccounts,
      accounts: supplied.accountReader,
      documents: supplied.userDocuments,
      userDirectory: supplied.userDirectory,
      adminUserDetail: supplied.adminUserDetail,
      policyInputs: supplied.userPolicyInputs,
    });
    for (const factory of [product.userAccounts, product.accountReader, product.userDocuments, product.userDirectory, product.adminUserDetail]) {
      expect(factory).toHaveBeenCalledWith(store);
    }
    expect(product.userPolicyInputs).toHaveBeenCalledWith(store, log);
  });
});
