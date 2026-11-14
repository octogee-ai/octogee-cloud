import { describe, expect, it } from "vitest";
import {
  installUserEntitlements,
  staticUserEntitlements,
  userEntitlements,
} from "@octogee/shared/types/user-entitlements";
import {
  buildProvisioningContext,
  buildRemoveUserConfig,
  buildProvisionedUserPatch,
  buildUserProductFields,
} from "./provisionSteps.js";

describe("provisioned user state", () => {
  const ctx = buildProvisioningContext("uid-1", { username: "octogeedemo", tier: "trial" });

  it("binds the provisioned user to the workspace used by agent tools", () => {
    expect(buildProvisionedUserPatch(ctx, { "mattermost.userId": "mm-1", "mattermost.teamId": "team-1" })).toEqual({
      workspaceId: "octogeedemo",
      slug: "octogeedemo",
      mattermostUserId: "mm-1",
      openclaw: { version: "v1", customerDir: ctx.customerDir, provisionedAt: { serverNow: true } },
    });
  });

  it("leaves the Mattermost user id out when provisioning did not produce one", () => {
    expect(buildProvisionedUserPatch(ctx, {})).not.toHaveProperty("mattermostUserId");
  });

  it("leaves the Mattermost user id out when provisioning produced an empty one", () => {
    expect(buildProvisionedUserPatch(ctx, { "mattermost.userId": "" })).not.toHaveProperty("mattermostUserId");
  });

  it("names no plan and stamps no product field when no product is installed", () => {
    const product = userEntitlements();
    installUserEntitlements(staticUserEntitlements);
    try {
      const bare = buildProvisioningContext("uid-3", { username: "bareuser", tier: "pro", subscription: { tier: "pro" } });

      expect(bare.contextTemplateKey).toBe("default");
      expect(buildUserProductFields(bare, { "mattermost.teamId": "team-1" })).toEqual({ "mattermost.teamId": "team-1" });
      expect(Object.keys(bare.templateVars).sort()).toEqual(["createdAt", "ownerName", "slug", "timeZone", "uid", "username"]);
    } finally {
      installUserEntitlements(product);
    }
  });
});

describe("buildRemoveUserConfig", () => {
  const current = {
    agents: {
      list: [
        { id: "octogee-alice-coach" },
        { id: "octogee-alice-proj-orbit-coach" },
        { id: "octogee-bob-coach" },
      ],
    },
    bindings: [
      { agentId: "octogee-alice-coach" },
      { agentId: "octogee-alice-proj-orbit-coach" },
      { agentId: "octogee-bob-coach" },
    ],
    channels: {
      mattermost: {
        accounts: {
          "alice-coach": { botToken: "x" },
          "alice-proj-orbit": { botToken: "y" },
          "bob-coach": { botToken: "z" },
          default: { botToken: "d" },
        },
      },
    },
  };

  it("removes the user's complete footprint from an unredacted full config without shifting sibling secrets", () => {
    const raw = {
      ...current,
      agents: {
        list: [
          {
            id: "octogee-alice-coach",
            memorySearch: { embedding: { apiKey: { source: "env", id: "ALICE_KEY" } } },
          },
          { id: "octogee-alice-proj-orbit-coach" },
          {
            id: "octogee-bob-coach",
            memorySearch: { embedding: { apiKey: { source: "env", id: "BOB_KEY" } } },
          },
        ],
      },
      untouched: { nested: ["keep", "all", "of", "this"] },
    };

    const config = buildRemoveUserConfig(raw, "alice", "octogee-alice-coach");

    expect(config.agents?.list).toEqual([
      {
        id: "octogee-bob-coach",
        memorySearch: { embedding: { apiKey: { source: "env", id: "BOB_KEY" } } },
      },
    ]);
    expect(config.bindings?.map((binding) => binding.agentId)).toEqual(["octogee-bob-coach"]);
    expect(config.channels?.mattermost?.accounts).toEqual({
      "bob-coach": { botToken: "z" },
      default: { botToken: "d" },
    });
    expect(config).toHaveProperty("untouched.nested", ["keep", "all", "of", "this"]);
    expect(raw.agents.list).toHaveLength(3);
    expect(raw.channels.mattermost.accounts).toHaveProperty("alice-coach");
  });

  it("does not remove a hyphenated sibling's project accounts", () => {
    const config = buildRemoveUserConfig(
      {
        bindings: [],
        channels: {
          mattermost: {
            accounts: { "alice-b-proj-x": { botToken: "s" }, "alice-proj-y": { botToken: "t" } },
          },
        },
      },
      "alice",
      "octogee-alice-coach",
    );
    expect(config.channels?.mattermost?.accounts).toEqual({
      "alice-b-proj-x": { botToken: "s" },
    });
  });
});
