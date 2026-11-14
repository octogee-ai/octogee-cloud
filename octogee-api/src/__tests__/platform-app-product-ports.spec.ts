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
const { NO_BROKER_RECORDS } = await import("../lib/broker-records.js");
const { NO_WORKSPACE_STORAGE_ACCOUNTING, installWorkspaceStorageAccounting, workspaceStorageAccounting } =
  await import("../../../gateway-edge/src/lib/workspace-storage-quota.js");
const { NO_PROJECT_AGENT_DELIVERY_INTENTS, installProjectAgentDeliveryIntents, projectAgentDeliveryIntents } =
  await import("../../../gateway-edge/src/lib/project-agent-delivery-intents.js");
const { userAccounts } = await import("../../../gateway-edge/src/lib/user-accounts.js");
const { noUserAccounts } = await import("@octogee/core/user-account");

afterEach(() => {
  installProjectPresentation(NO_PROJECT_PRESENTATION);
  installWorkspaceStorageAccounting(NO_WORKSPACE_STORAGE_ACCOUNTING);
  installProjectAgentDeliveryIntents(NO_PROJECT_AGENT_DELIVERY_INTENTS);
});

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

  it("reads user accounts from platform state without a product", async () => {
    createPlatformApp();

    expect(userAccounts()).not.toBe(noUserAccounts);
    await expect(userAccounts().get("nobody")).resolves.toBeNull();
  });

  it("refuses to start when the product's broker records have no user account reader", () => {
    expect(() => createPlatformApp({ product: productWith({ brokerRecords: NO_BROKER_RECORDS }) }))
      .toThrow("The product's broker records must supply a user account reader");
  });

  it("leaves workspace storage unaccounted without a product", () => {
    installWorkspaceStorageAccounting({ ...NO_WORKSPACE_STORAGE_ACCOUNTING });

    createPlatformApp();

    expect(workspaceStorageAccounting()).toBe(NO_WORKSPACE_STORAGE_ACCOUNTING);
  });

  it("installs the product's workspace storage accounting", () => {
    const accounting = { ...NO_WORKSPACE_STORAGE_ACCOUNTING };

    createPlatformApp({ product: productWith({ workspaceStorageAccounting: accounting }) });

    expect(workspaceStorageAccounting()).toBe(accounting);
  });

  it("records no project agent delivery intents without a product", () => {
    installProjectAgentDeliveryIntents({ ...NO_PROJECT_AGENT_DELIVERY_INTENTS });

    createPlatformApp();

    expect(projectAgentDeliveryIntents()).toBe(NO_PROJECT_AGENT_DELIVERY_INTENTS);
  });

  it("installs the product's project agent delivery intents", () => {
    const intents = { ...NO_PROJECT_AGENT_DELIVERY_INTENTS, recordsIntents: true };

    createPlatformApp({ product: productWith({ projectAgentDeliveryIntents: intents }) });

    expect(projectAgentDeliveryIntents()).toBe(intents);
  });
});
