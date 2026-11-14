import { afterEach, describe, expect, it, vi } from "vitest";
import { staticUserEntitlements } from "@octogee/shared/types/user-entitlements";
import type { ProductRuntime } from "../app.js";

vi.mock("../../../gateway-edge/src/lib/platform-state.js", async (importOriginal) => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return {
    ...(await importOriginal<typeof import("../../../gateway-edge/src/lib/platform-state.js")>()),
    platformStateStore: createDocumentFixtureStore(new Map()),
  };
});

const { createPlatformApp } = await import("../app.js");
const { FeaturePolicy, configuredFeatureFlagProvider } = await import("../lib/feature-policy.js");
const { NO_PROJECT_PRESENTATION, projectPresentation, installProjectPresentation } =
  await import("../../../gateway-edge/src/lib/project-presentation.js");

afterEach(() => installProjectPresentation(NO_PROJECT_PRESENTATION));

function productWith(runtime: Partial<ProductRuntime>) {
  return {
    entitlements: staticUserEntitlements,
    validateBoot: () => undefined,
    createRuntime: (): ProductRuntime => ({
      featurePolicy: new FeaturePolicy(configuredFeatureFlagProvider({})),
      clusterRoutes: () => [],
      apiRoutes: () => [],
      internalRoutes: () => [],
      onBudgetInterruption: () => undefined,
      onUserProvisioned: async () => undefined,
      shutdown: async () => undefined,
      ...runtime,
    }),
  };
}

describe("createPlatformApp product ports", () => {
  it("leaves project presentation unremembered without a product", () => {
    createPlatformApp();

    expect(projectPresentation()).toBe(NO_PROJECT_PRESENTATION);
  });

  it("installs the product's project presentation", () => {
    const presentation = { ...NO_PROJECT_PRESENTATION, remembersChannels: true };

    createPlatformApp({ product: productWith({ projectPresentation: presentation }) });

    expect(projectPresentation()).toBe(presentation);
  });
});
