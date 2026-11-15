import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import { firestoreUserAccountReader } from "@octogee/core-testing/firestore-user-accounts";
import { noUserAccounts, userAccountFromData } from "./user-account.js";

describe("userAccountFromData", () => {
  it.each([
    [1_700, 1_700],
    [new Date(2_000), 2_000],
    [Timestamp.fromMillis(3_000), 3_000],
    ["yesterday", null],
  ])("reads lastActive %s as millis %s", (lastActive, expected) => {
    expect(userAccountFromData("u1", { lastActive }).lastActive).toBe(expected);
  });

  it("projects the admin profile fields and drops non-string Mattermost usernames", () => {
    expect(userAccountFromData("u1", {
      displayName: "User",
      usage: { totalTokensUsed: 5 },
      mattermost: { username: "user-mm" },
    })).toMatchObject({
      displayName: "User",
      usage: { totalTokensUsed: 5 },
      mattermostUsername: "user-mm",
    });
    expect(userAccountFromData("u1", { mattermost: { username: 456 } })).toMatchObject({
      mattermostUsername: null,
      usage: {},
    });
  });

  it("carries no onboarding state from the account document", () => {
    const account = userAccountFromData("u1", { onboardingStep: "complete", onboardingComplete: true });

    expect(account).not.toHaveProperty("onboardingStep");
    expect(account).not.toHaveProperty("onboardingComplete");
  });
});

describe("firestoreUserAccountReader.getMany", () => {
  function reader(existing: Record<string, Record<string, unknown>>) {
    const getAll = vi.fn(async (...refs: Array<{ id: string }>) => refs.map((ref) => ({
      id: ref.id,
      exists: ref.id in existing,
      data: () => existing[ref.id],
    })));
    const db = { collection: () => ({ doc: (id: string) => ({ id }) }), getAll } as unknown as Firestore;
    return { accounts: firestoreUserAccountReader(db), getAll };
  }

  it("reads each distinct uid once and omits missing accounts", async () => {
    const { accounts, getAll } = reader({ u1: { username: "one" }, u2: { username: "two" } });

    const found = await accounts.getMany(["u1", "u2", "u1", "missing"]);

    expect([...found.keys()]).toEqual(["u1", "u2"]);
    expect(found.get("u2")?.username).toBe("two");
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll.mock.calls[0]).toHaveLength(3);
  });

  it("skips the read for an empty uid list", async () => {
    const { accounts, getAll } = reader({});

    await expect(accounts.getMany([])).resolves.toEqual(new Map());
    expect(getAll).not.toHaveBeenCalled();
  });
});

describe("noUserAccounts", () => {
  it("knows no account", async () => {
    await expect(noUserAccounts.get("u1")).resolves.toBeNull();
    await expect(noUserAccounts.getMany(["u1"])).resolves.toEqual(new Map());
    await expect(noUserAccounts.list()).resolves.toEqual(new Map());
  });
});
