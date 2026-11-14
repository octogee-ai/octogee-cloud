import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import { pinSubscriptionModel, retargetSubscriptionModelPicks, SubscriptionModelPinError } from "../lib/subscription-model-pins.js";

const UID = "ada";
const COACH = "octogee-ada-coach";
const WRITER = "octogee-ada-writer";
const SUBSCRIPTION = "claude-cli/claude-opus-5";

function storeWith(picks: Record<string, { primary: string; fallbacks?: string[] }> = {}) {
  const store = createDocumentFixtureStore(new Map());
  return {
    users: store.users,
    seed: () => Promise.all(Object.entries(picks).map(([agentId, pick]) => store.users.agentModels.put({
      uid: UID,
      agentId,
      primary: pick.primary,
      fallbacks: pick.fallbacks ?? [],
      updatedAt: 1_000,
    }))),
    picks: async () => Object.fromEntries((await store.users.agentModels.list(UID))
      .map((selection) => [selection.agentId, { primary: selection.primary, fallbacks: selection.fallbacks }])),
  };
}

describe("pinSubscriptionModel", () => {
  it("pins every agent to the subscription model and clears its fallbacks", async () => {
    const fixture = storeWith({ [COACH]: { primary: "openai/gpt-5", fallbacks: ["openai/gpt-5-mini"] } });
    await fixture.seed();

    await pinSubscriptionModel(fixture.users, { uid: UID, agentIds: [COACH, WRITER], model: SUBSCRIPTION });

    expect(await fixture.picks()).toEqual({
      [COACH]: { primary: SUBSCRIPTION, fallbacks: [] },
      [WRITER]: { primary: SUBSCRIPTION, fallbacks: [] },
    });
  });

  it("names the agents left without a pick when the store refuses a pin", async () => {
    const fixture = storeWith();
    const cause = new Error("store unavailable");
    vi.spyOn(fixture.users.agentModels, "put").mockRejectedValue(cause);

    const attempt = pinSubscriptionModel(fixture.users, { uid: UID, agentIds: [COACH, WRITER], model: SUBSCRIPTION });

    await expect(attempt).rejects.toBeInstanceOf(SubscriptionModelPinError);
    await expect(attempt).rejects.toMatchObject({ uid: UID, agentIds: [COACH, WRITER], cause });
  });

  it("leaves picks alone when the provider has no subscription model", async () => {
    const fixture = storeWith({ [COACH]: { primary: "openai/gpt-5" } });
    await fixture.seed();

    await pinSubscriptionModel(fixture.users, { uid: UID, agentIds: [COACH], model: null });

    expect(await fixture.picks()).toEqual({ [COACH]: { primary: "openai/gpt-5", fallbacks: [] } });
  });
});

describe("retargetSubscriptionModelPicks", () => {
  it("moves only the picks on the old subscription model to the new one", async () => {
    const fixture = storeWith({ [COACH]: { primary: SUBSCRIPTION }, [WRITER]: { primary: "openai/gpt-5" } });
    await fixture.seed();

    await retargetSubscriptionModelPicks(fixture.users, { uid: UID, fromModel: SUBSCRIPTION, toModel: "openai-codex/gpt-5" });

    expect(await fixture.picks()).toEqual({
      [COACH]: { primary: "openai-codex/gpt-5", fallbacks: [] },
      [WRITER]: { primary: "openai/gpt-5", fallbacks: [] },
    });
  });

  it("drops the old subscription's picks when no subscription remains", async () => {
    const fixture = storeWith({ [COACH]: { primary: SUBSCRIPTION }, [WRITER]: { primary: "openai/gpt-5" } });
    await fixture.seed();

    await retargetSubscriptionModelPicks(fixture.users, { uid: UID, fromModel: SUBSCRIPTION, toModel: null });

    expect(await fixture.picks()).toEqual({ [WRITER]: { primary: "openai/gpt-5", fallbacks: [] } });
  });
});
