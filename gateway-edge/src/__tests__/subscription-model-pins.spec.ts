import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import { pinSubscriptionModelAround, retargetSubscriptionModelPicks } from "../lib/subscription-model-pins.js";

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

describe("pinSubscriptionModelAround", () => {
  it("pins every agent to the subscription model before the commit runs", async () => {
    const fixture = storeWith({ [COACH]: { primary: "openai/gpt-5", fallbacks: ["openai/gpt-5-mini"] } });
    await fixture.seed();
    const seenAtCommit = vi.fn(async () => fixture.picks());

    await pinSubscriptionModelAround(fixture.users, { uid: UID, agentIds: [COACH, WRITER], model: SUBSCRIPTION }, seenAtCommit);

    const pinned = { [COACH]: { primary: SUBSCRIPTION, fallbacks: [] }, [WRITER]: { primary: SUBSCRIPTION, fallbacks: [] } };
    await expect(seenAtCommit.mock.results[0]!.value).resolves.toEqual(pinned);
    expect(await fixture.picks()).toEqual(pinned);
  });

  it("restores the previous picks when the commit fails", async () => {
    const fixture = storeWith({ [COACH]: { primary: "openai/gpt-5", fallbacks: ["openai/gpt-5-mini"] } });
    await fixture.seed();
    const failure = new Error("commit refused");

    await expect(pinSubscriptionModelAround(
      fixture.users,
      { uid: UID, agentIds: [COACH, WRITER], model: SUBSCRIPTION },
      async () => { throw failure; },
    )).rejects.toBe(failure);

    expect(await fixture.picks()).toEqual({ [COACH]: { primary: "openai/gpt-5", fallbacks: ["openai/gpt-5-mini"] } });
  });

  it("never commits when a pin fails, and undoes the pins that landed", async () => {
    const fixture = storeWith();
    const put = fixture.users.agentModels.put.bind(fixture.users.agentModels);
    vi.spyOn(fixture.users.agentModels, "put").mockImplementation(async (selection) => {
      if (selection.agentId === WRITER) throw new Error("store unavailable");
      await put(selection);
    });
    const commit = vi.fn(async () => undefined);

    await expect(pinSubscriptionModelAround(
      fixture.users,
      { uid: UID, agentIds: [COACH, WRITER], model: SUBSCRIPTION },
      commit,
    )).rejects.toThrow("store unavailable");

    expect(commit).not.toHaveBeenCalled();
    expect(await fixture.picks()).toEqual({});
  });

  it("reports both failures when the restore after a failed commit also fails", async () => {
    const fixture = storeWith();
    vi.spyOn(fixture.users.agentModels, "delete").mockRejectedValue(new Error("store unavailable"));

    const attempt = pinSubscriptionModelAround(
      fixture.users,
      { uid: UID, agentIds: [COACH], model: SUBSCRIPTION },
      async () => { throw new Error("commit refused"); },
    );

    await expect(attempt).rejects.toBeInstanceOf(AggregateError);
    await expect(attempt).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "commit refused" }), expect.objectContaining({ message: "store unavailable" })] });
  });

  it("commits without touching picks when the provider has no subscription model", async () => {
    const fixture = storeWith({ [COACH]: { primary: "openai/gpt-5" } });
    await fixture.seed();

    await expect(pinSubscriptionModelAround(fixture.users, { uid: UID, agentIds: [COACH], model: null }, async () => "done"))
      .resolves.toBe("done");

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
