import { describe, expect, it } from "vitest";
import { DuplicateRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { resolveActiveArtifactWorkspaceSlug } from "./chat-artifact-workspace.js";

function storeFor(input: { lifecycle?: string; duplicateTeam?: boolean; owner?: boolean }) {
  return createDocumentFixtureStore({
    "workspaces/channel-workspace": { id: "channel-workspace", ownerUid: "owner-1", mattermost: { teamId: "team-1" } },
    ...(input.duplicateTeam
      ? { "workspaces/duplicate-workspace": { id: "duplicate-workspace", ownerUid: "owner-2", mattermost: { teamId: "team-1" } } }
      : {}),
    ...(input.owner === false
      ? {}
      : { "users/owner-1": { username: "owner-1", accountLifecycle: { status: input.lifecycle ?? "active" } } }),
  });
}

describe("resolveActiveArtifactWorkspaceSlug", () => {
  it("binds a Mattermost team to its active owning workspace", async () => {
    await expect(resolveActiveArtifactWorkspaceSlug(storeFor({}), "team-1")).resolves.toEqual({
      workspaceSlug: "channel-workspace",
      workspaceOwnerUid: "owner-1",
    });
  });

  it("does not bind an unmapped Mattermost team or a workspace whose owner record is gone", async () => {
    await expect(resolveActiveArtifactWorkspaceSlug(storeFor({}), "team-2")).resolves.toBeNull();
    await expect(resolveActiveArtifactWorkspaceSlug(storeFor({ owner: false }), "team-1")).resolves.toBeNull();
  });

  it.each(["deletion_scheduled", "erasing", "suspended"])(
    "rejects artifact creation when the workspace owner is %s",
    async (lifecycle) => {
      await expect(resolveActiveArtifactWorkspaceSlug(storeFor({ lifecycle }), "team-1")).resolves.toBeNull();
    },
  );

  it("fails when a Mattermost team is ambiguously mapped", async () => {
    await expect(resolveActiveArtifactWorkspaceSlug(storeFor({ duplicateTeam: true }), "team-1"))
      .rejects.toBeInstanceOf(DuplicateRecordError);
  });
});
