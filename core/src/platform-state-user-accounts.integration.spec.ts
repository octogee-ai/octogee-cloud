import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, dsn, type PlatformStateHarness } from "./platform-state/postgres/__tests__/fixtures/harness.js";
import {
  platformStateUserAccountReader,
  platformStateUserAccounts,
  userAccountDocument,
} from "./platform-state-user-accounts.js";

describe.skipIf(!dsn)("platform state user accounts", () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("creates the account and admits the user under the account name in one step", async () => {
    const accounts = platformStateUserAccounts(harness.store);

    await expect(accounts.create({ userId: "u-ada", name: "ada", email: "ada@example.test" }))
      .resolves.toEqual({ kind: "created", userId: "u-ada" });

    expect(await harness.store.users.records.get("u-ada")).toMatchObject({
      uid: "u-ada",
      slug: "ada",
      admitted: true,
      persona: null,
      provisioning: { status: "in_progress" },
      createdAt: expect.any(Number),
    });
    expect(await harness.store.users.accounts.get("u-ada")).toMatchObject({ uid: "u-ada", name: "ada", email: "ada@example.test" });
  });

  it("reports a taken email and leaves no user record behind", async () => {
    const accounts = platformStateUserAccounts(harness.store);
    await accounts.create({ userId: "u-ada", name: "ada", email: "ada@example.test" });

    await expect(accounts.create({ userId: "u-bob", name: "bob", email: "ada@example.test" }))
      .resolves.toEqual({ kind: "taken", field: "email" });

    expect(await harness.store.users.records.get("u-bob")).toBeNull();
  });

  it("reports a taken name when another user already holds it as a slug", async () => {
    await harness.store.users.records.admit("u-old", { slug: "ada", persona: null, createdAt: 1, provisioningStartedAt: 1 });
    const accounts = platformStateUserAccounts(harness.store);

    await expect(accounts.create({ userId: "u-ada", name: "ada", email: "ada@example.test" }))
      .resolves.toEqual({ kind: "taken", field: "name" });

    expect(await harness.store.users.records.get("u-ada")).toBeNull();
  });

  it("reads accounts as user accounts with the name as the username", async () => {
    const accounts = platformStateUserAccounts(harness.store);
    await accounts.create({ userId: "u-ada", name: "ada", email: "ada@example.test" });
    await accounts.create({ userId: "u-bob", name: "bob", email: "bob@example.test" });
    const reader = platformStateUserAccountReader(harness.store);

    expect(await reader.get("u-ada")).toMatchObject({ uid: "u-ada", username: "ada", email: "ada@example.test" });
    expect(await reader.get("u-nobody")).toBeNull();
    expect([...(await reader.getMany(["u-bob", "u-nobody"])).keys()]).toEqual(["u-bob"]);
    expect([...(await reader.list()).values()].map((account) => account.username)).toEqual(["ada", "bob"]);
  });

  it("renders the account document the provisioning steps read", () => {
    expect(userAccountDocument({ uid: "u-ada", name: "ada", email: "ada@example.test", createdAt: 5 }))
      .toEqual({ username: "ada", email: "ada@example.test", createdAt: 5 });
  });
});
