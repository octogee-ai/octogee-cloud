import { afterEach, describe, expect, it, vi } from "vitest";
import { installUserEntitlements, staticUserEntitlements } from "@octogee/shared/types/user-entitlements";
import { accountSizingKeyReader } from "./sizing-key.js";
import type { UserAccount } from "./user-account.js";

const account = (planInputs: Record<string, unknown>): UserAccount => ({
  uid: "uid-A",
  username: "mira",
  email: null,
  displayName: null,
  lastActive: null,
  planInputs,
  usage: {},
  mattermostUsername: null,
});

afterEach(() => installUserEntitlements(staticUserEntitlements));

describe("accountSizingKeyReader", () => {
  it("resolves the sizing key from the account's plan inputs at the given time", async () => {
    const sizingKey = vi.fn(() => "builder-m");
    installUserEntitlements({ ...staticUserEntitlements, sizingKey });
    const read = accountSizingKeyReader({ get: async () => account({ selectedTier: "builder" }) });

    await expect(read("uid-A", Date.parse("2026-11-14T00:00:00Z"))).resolves.toBe("builder-m");
    expect(sizingKey).toHaveBeenCalledWith({ selectedTier: "builder" }, new Date("2026-11-14T00:00:00Z"));
  });

  it("has no sizing key for an unknown user", async () => {
    const sizingKey = vi.fn(() => "builder-m");
    installUserEntitlements({ ...staticUserEntitlements, sizingKey });

    await expect(accountSizingKeyReader({ get: async () => null })("nobody", 0)).resolves.toBeNull();
    expect(sizingKey).not.toHaveBeenCalled();
  });
});
