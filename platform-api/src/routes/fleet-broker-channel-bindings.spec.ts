import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { describe, expect, it } from "vitest";

import { collectChannelBindings } from "./fleet-broker.js";

describe("collectChannelBindings", () => {
  it("uses each project channel once for fleet membership", async () => {
    const store = createDocumentFixtureStore({
      "workspaces/alice/channels/general": { kind: "general", mattermost: { channelId: "workspace-primary" } },
      "workspaces/alice/channels/unbound": { kind: "general" },
      "workspaces/alice/projects/orbit": { ownerUid: "uid-alice" },
      "workspaces/alice/projects/orbit/channels/general": { kind: "general", mattermost: { channelId: "project-primary" } },
      "workspaces/alice/projects/quiet": { ownerUid: "uid-alice" },
    });

    await expect(collectChannelBindings(store, "alice")).resolves.toEqual({
      bindings: [
        { scope: "workspace", kind: "general", channelId: "workspace-primary" },
        { scope: "project", projectId: "orbit", kind: "general", channelId: "project-primary" },
      ],
      projectMemberships: [{ projectId: "orbit", channelIds: ["project-primary"] }],
    });
  });

  it("fails closed on a project without an owner", async () => {
    const store = createDocumentFixtureStore({
      "workspaces/alice/projects/orbit": {},
      "workspaces/alice/projects/orbit/channels/general": { kind: "general", mattermost: { channelId: "project-primary" } },
    });

    await expect(collectChannelBindings(store, "alice")).rejects.toMatchObject({ name: "MalformedRecordError" });
  });
});
