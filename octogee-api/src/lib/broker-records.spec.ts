import type { PlatformStateStore } from "@octogee/core/platform-state";
import { describe, expect, it, vi } from "vitest";
import { platformStateBrokerRecords } from "./broker-records.js";

const ADA = { uid: "u-ada", name: "ada", email: "ada@example.test", createdAt: 7, revision: "1" };

function store(): PlatformStateStore {
  return {
    users: {
      accounts: {
        get: vi.fn(async (uid: string) => (uid === ADA.uid ? ADA : null)),
        getMany: vi.fn(async (uids: readonly string[]) => new Map(uids.includes(ADA.uid) ? [[ADA.uid, ADA]] : [])),
        listAll: vi.fn(async () => [ADA]),
      },
    },
  } as unknown as PlatformStateStore;
}

describe("platform state broker records", () => {
  it("serves a platform user's account document from the platform state store", async () => {
    const records = platformStateBrokerRecords(store());

    await expect(records.userDocuments.account("u-ada")).resolves.toEqual({ username: "ada", email: "ada@example.test", createdAt: 7 });
    await expect(records.userDocuments.account("u-nobody")).resolves.toBeUndefined();
    expect(await records.userDocuments.accounts(["u-ada", "u-nobody"])).toEqual(
      new Map([["u-ada", { username: "ada", email: "ada@example.test", createdAt: 7 }]]),
    );
  });

  it("reads platform user accounts and leaves the product records unconfigured", async () => {
    const records = platformStateBrokerRecords(store());

    await expect(records.accounts.get("u-ada")).resolves.toMatchObject({ uid: "u-ada", username: "ada", email: "ada@example.test" });
    await expect(records.userDocuments.agent("u-ada")).resolves.toBeUndefined();
  });
});
