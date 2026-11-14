import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLASSES,
  modelCredentialEntryById,
  OPENCLAW_PROTOCOL_VERSION,
  OpenclawWireError,
  resolveGatewayClass,
  resolveSizingTier,
  type Agent,
  type Project,
} from "./index.js";

describe("shared type barrel", () => {
  it("re-exports public runtime helpers from the root shared entrypoint", () => {
    expect(GATEWAY_CLASSES).toEqual(["shared", "isolated"]);
    expect(resolveGatewayClass({ gatewayClass: "isolated" })).toBe("isolated");
    expect(resolveSizingTier({ sizingTier: "m" }).tier).toBe("m");
    expect(modelCredentialEntryById("openai").displayName).toBe("OpenAI API key");
    expect(OPENCLAW_PROTOCOL_VERSION).toBe(4);
    expect(new OpenclawWireError("timeout", "late").code).toBe("timeout");
  });

  it("keeps consumer-facing document types reachable from the root barrel", () => {
    const agent: Agent = {
      id: "agent-1",
      name: "Scout",
      persona: "calm user agent",
      avatar: {
        path: "Scout-avatar.png",
        gcsPath: "workspaces/scout/Scout-avatar.png",
        updatedAt: "server-time",
      },
      mattermost: { userId: "mm-agent-1" },
      createdAt: "server-time",
      updatedAt: "server-time",
    };
    const project: Project = {
      id: "project-1",
      ownerUid: "uid-1",
      workspaceId: "workspace-1",
      slug: "first-build",
      name: "First Build",
      tagline: "Make it real",
      description: "A first project",
      category: "tools",
      projectType: "other",
      status: "building",
      visibility: "private",
      provisioningState: "active",
      giteaRepoName: "workspace-first-build",
      canvasFile: "README.md",
      publishedUrl: null,
      starCount: 0,
      memberCount: 1,
      createdAt: "server-time",
      updatedAt: "server-time",
    };

    expect(agent.avatar?.path).toBe("Scout-avatar.png");
    expect(project.visibility).toBe("private");
  });
});
