import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.users) };
});

const { resolveUserGateway, rosteredAgentIdsForSlug } = await import("../lib/user-gateway.js");

describe("resolveUserGateway", () => {
  beforeEach(() => {
    h.users.clear();
  });

  it("returns null for missing users or users without an assigned gateway", async () => {
    h.users.set("users/no-gateway", { username: "mira", provisioning: { openclaw: {} } });

    await expect(resolveUserGateway("missing")).resolves.toBeNull();
    await expect(resolveUserGateway("no-gateway")).resolves.toBeNull();
  });

  it("returns the primary workspace slug and assigned gateway id", async () => {
    h.users.set("users/u-1", {
      username: "fallback",
      provisioning: { openclaw: { slug: "mira", gatewayId: "gw-1" } },
    });

    await expect(resolveUserGateway("u-1")).resolves.toEqual({
      slug: "mira",
      gatewayId: "gw-1",
      agentIds: ["octogee-mira-coach"],
    });
  });

  it("rosters the agent first plus this workspace's own safe agent ids", async () => {
    h.users.set("users/u-2", {
      provisioning: {
        openclaw: {
          slug: "mira",
          gatewayId: "gw-1",
          agentIds: [
            "octogee-mira-proj-golf-coach",
            "octogee-mira-coach",
            "octogee-other-coach",
            "octogee-mira-../etc",
          ],
        },
      },
    });

    await expect(resolveUserGateway("u-2")).resolves.toMatchObject({
      agentIds: ["octogee-mira-coach", "octogee-mira-proj-golf-coach"],
    });
  });

  it("drops non-string roster entries from product user data", () => {
    expect(
      rosteredAgentIdsForSlug({ provisioning: { openclaw: { agentIds: [42, "octogee-mira-proj-golf-coach"] } } }, "mira"),
    ).toEqual(["octogee-mira-coach", "octogee-mira-proj-golf-coach"]);
  });
});
