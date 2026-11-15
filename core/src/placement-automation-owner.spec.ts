import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { FleetMutationRefusedError } from "./normal-fleet-mutation.js";
import {
  PlacementOwnerRefusedError,
  assertClientOwnsPlacementAutomation,
  placementOwnerRefusalBody,
} from "./placement-automation-owner.js";

function storeWith(orchestrator: Record<string, unknown> | null) {
  const documents = new Map<string, Record<string, unknown>>(orchestrator === null ? [] : [["config/orchestrator", orchestrator]]);
  return createDocumentFixtureStore(documents, { serializeTransactions: true });
}

function assertIn(orchestrator: Record<string, unknown> | null) {
  return storeWith(orchestrator).transaction({ label: "test.placement-owner" }, (transaction) =>
    assertClientOwnsPlacementAutomation(transaction));
}

async function refusal(orchestrator: Record<string, unknown> | null): Promise<unknown> {
  return assertIn(orchestrator).then(() => undefined, (error: unknown) => error);
}

describe("assertClientOwnsPlacementAutomation", () => {
  it("refuses when no orchestrator config exists, because the fleet controller owns placement by default", async () => {
    const error = await refusal(null);

    expect(error).toBeInstanceOf(PlacementOwnerRefusedError);
    expect((error as PlacementOwnerRefusedError).ownership).toEqual({ owner: "fleet-controller", yieldedAt: null });
    expect(placementOwnerRefusalBody(error)).toEqual({ code: "placement-owner", error: "placement automation is owned by fleet-controller" });
  });

  it("refuses when the config never set an owner", async () => {
    expect(await refusal({ defaultGatewayId: "shared-a" })).toBeInstanceOf(PlacementOwnerRefusedError);
  });

  it("refuses when the owner is the client but the fleet controller has not yielded", async () => {
    const error = await refusal({ placementAutomationOwner: "client" });

    expect((error as PlacementOwnerRefusedError).ownership).toEqual({ owner: "client", yieldedAt: null });
    expect(placementOwnerRefusalBody(error)?.error).toBe("the fleet controller has not yielded placement automation");
  });

  it("refuses a yield recorded while the fleet controller is the owner", async () => {
    expect(await refusal({ placementAutomationOwner: "fleet-controller", placementAutomationYieldedAt: 1_000 }))
      .toBeInstanceOf(PlacementOwnerRefusedError);
  });

  it("admits the verb once the owner is the client and the yield is written", async () => {
    await expect(assertIn({ placementAutomationOwner: "client", placementAutomationYieldedAt: 1_000 }))
      .resolves.toEqual({ owner: "client", yieldedAt: 1_000 });
  });
});

describe("placementOwnerRefusalBody", () => {
  it("reads a refusal wrapped by the fleet mutation journal", () => {
    const wrapped = new FleetMutationRefusedError(new PlacementOwnerRefusedError({ owner: "fleet-controller", yieldedAt: null }));

    expect(placementOwnerRefusalBody(wrapped)?.code).toBe("placement-owner");
  });

  it("does not claim other refusals", () => {
    expect(placementOwnerRefusalBody(new FleetMutationRefusedError(new Error("precondition")))).toBeNull();
    expect(placementOwnerRefusalBody(new Error("boom"))).toBeNull();
  });
});
