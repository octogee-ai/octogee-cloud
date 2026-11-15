import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createRepeatSquelch } from "@octogee/shared/server/repeat-squelch";
import { logPlatformPlacementNotices, PLATFORM_PLACEMENT_NOTICE_REPEAT_MS } from "../platform-placement-notices.js";

function user(slug: string, gatewayId: string | null): Record<string, unknown> {
  return {
    username: slug,
    onboardingStep: "complete",
    provisioning: { status: "complete", openclaw: { slug, status: "complete", ...(gatewayId ? { gatewayId } : {}) } },
  };
}

async function noticesFor(records: Record<string, Record<string, unknown>>) {
  const store = createDocumentFixtureStore(new Map(Object.entries(records)));
  const [users, roots, assignments] = await Promise.all([
    store.users.records.listAll(),
    store.gateways.roots.list(),
    store.gateways.assignments.listAll(),
  ]);
  return { users, roots, assignments };
}

describe("platform placement notices", () => {
  it("repeats an unchanged notice only after the repeat window, and reports a change at once", async () => {
    let now = 0;
    const logs: string[] = [];
    const squelch = createRepeatSquelch({ windowMs: PLATFORM_PLACEMENT_NOTICE_REPEAT_MS, now: () => now });
    const observe = async (records: Record<string, Record<string, unknown>>) =>
      logPlatformPlacementNotices({ ...await noticesFor(records), squelch, log: (message) => logs.push(message) });
    const one = { "users/uid-cy": user("cy", null) };
    const two = { ...one, "users/uid-dee": user("dee", null) };

    await observe(one);
    now += 15_000;
    await observe(one);
    expect(logs).toEqual(["[placement] ⚠ platform only: 1 user(s) have no gateway: uid-cy; place them with user assign"]);

    now += 15_000;
    await observe(two);
    expect(logs).toHaveLength(2);
    expect(logs.at(-1)).toMatch(/^\[placement\] ⚠ platform only: 2 user\(s\) have no gateway: uid-cy, uid-dee; place them with user assign/);

    now += PLATFORM_PLACEMENT_NOTICE_REPEAT_MS;
    await observe(two);
    expect(logs).toHaveLength(3);
    expect(logs.at(-1)).toMatch(/2 user\(s\) have no gateway: uid-cy, uid-dee; place them with user assign/);
  });

  it("reports a condition again as soon as it returns after clearing", async () => {
    let now = 0;
    const logs: string[] = [];
    const squelch = createRepeatSquelch({ windowMs: PLATFORM_PLACEMENT_NOTICE_REPEAT_MS, now: () => now });
    const observe = async (records: Record<string, Record<string, unknown>>) =>
      logPlatformPlacementNotices({ ...await noticesFor(records), squelch, log: (message) => logs.push(message) });

    await observe({ "users/uid-cy": user("cy", null) });
    now += 15_000;
    await observe({});
    now += 15_000;
    await observe({ "users/uid-cy": user("cy", null) });

    expect(logs).toHaveLength(2);
  });
});
