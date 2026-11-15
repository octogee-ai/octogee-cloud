import { platformStateStoreFromEnvironment } from "@octogee/core/platform-state";
import { installUserEntitlements, staticUserEntitlements, userEntitlements } from "@octogee/shared/types/user-entitlements";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../index.js";

vi.mock("@octogee/core/platform-state", async (original) => ({
  ...await original<typeof import("@octogee/core/platform-state")>(),
  platformStateStoreFromEnvironment: vi.fn(),
}));

const previous = userEntitlements();
afterEach(() => {
  installUserEntitlements(previous);
  vi.resetAllMocks();
});

async function startUntilPlatformState() {
  vi.mocked(platformStateStoreFromEnvironment).mockImplementation(() => { throw new Error("bootstrap boundary"); });
  await expect(main({ userLifecycle: null })).rejects.toThrow("bootstrap boundary");
}

it("initializes bare platform entitlements before starting the fleet controller", async () => {
  Reflect.deleteProperty(globalThis, Symbol.for("octogee.userEntitlements"));
  await startUntilPlatformState();
  expect(userEntitlements()).toBe(staticUserEntitlements);
});

it("keeps the product resolver when starting the fleet controller", async () => {
  const product = { ...staticUserEntitlements, sizingKey: () => "product-size" };
  installUserEntitlements(product);
  await startUntilPlatformState();
  expect(userEntitlements()).toBe(product);
});
