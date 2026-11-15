import { describe, expect, it, vi } from "vitest";

import { reconcileDefaultAgentProjectMembership } from "./project-agent-membership.js";

describe("reconcileDefaultAgentProjectMembership", () => {
  it("adds the scoped project agent alongside the workspace agent", async () => {
    const call = vi.fn(async (method: string, path: string) => {
      if (method === "GET" && path.endsWith("/members/project-agent-mm")) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      return null;
    });

    await reconcileDefaultAgentProjectMembership({
      defaultAgentMmUserId: "coach-mm",
      projects: [{
        projectId: "orbit",
        projectAgentConfigured: true,
        projectAgentMmUserId: "project-agent-mm",
        channelIds: ["project-2", "project-1", "project-1"],
      }],
    }, call);

    expect(call.mock.calls).toEqual([
      ["GET", "/channels/project-1/members/project-agent-mm"],
      ["POST", "/channels/project-1/members", { user_id: "project-agent-mm" }],
      ["GET", "/channels/project-1/members/coach-mm"],
      ["GET", "/channels/project-2/members/project-agent-mm"],
      ["POST", "/channels/project-2/members", { user_id: "project-agent-mm" }],
      ["GET", "/channels/project-2/members/coach-mm"],
    ]);
  });

  it("keeps existing scoped membership and keeps the agent in disabled-agent channels", async () => {
    const call = vi.fn(async () => null);

    await reconcileDefaultAgentProjectMembership({
      defaultAgentMmUserId: "coach-mm",
      projects: [
        {
          projectId: "app",
          projectAgentConfigured: false,
          projectAgentMmUserId: null,
          channelIds: ["disabled-project"],
        },
        {
          projectId: "orbit",
          projectAgentConfigured: true,
          projectAgentMmUserId: "project-agent-mm",
          channelIds: ["enabled-project"],
        },
      ],
    }, call);

    expect(call.mock.calls).toEqual([
      ["GET", "/channels/disabled-project/members/coach-mm"],
      ["GET", "/channels/enabled-project/members/project-agent-mm"],
      ["GET", "/channels/enabled-project/members/coach-mm"],
    ]);
  });

  it("mounts the agent in every channel and reports unminted project agents as pending", async () => {
    const call = vi.fn(async (method: string, path: string) => {
      if (method === "GET" && path.endsWith("/members/coach-mm")) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      return null;
    });

    const result = await reconcileDefaultAgentProjectMembership({
      defaultAgentMmUserId: "coach-mm",
      projects: [
        { projectId: "rvenue", projectAgentConfigured: true, projectAgentMmUserId: null, channelIds: ["ch-rvenue"] },
        { projectId: "gardyn", projectAgentConfigured: true, projectAgentMmUserId: null, channelIds: ["ch-gardyn"] },
        { projectId: "octogee", projectAgentConfigured: true, projectAgentMmUserId: "octogee-agent-mm", channelIds: ["ch-octogee"] },
      ],
    }, call);

    expect(result).toEqual({ pendingProjectIds: ["gardyn", "rvenue"] });
    expect(call.mock.calls).toEqual([
      ["GET", "/channels/ch-gardyn/members/coach-mm"],
      ["POST", "/channels/ch-gardyn/members", { user_id: "coach-mm" }],
      ["GET", "/channels/ch-octogee/members/octogee-agent-mm"],
      ["GET", "/channels/ch-octogee/members/coach-mm"],
      ["POST", "/channels/ch-octogee/members", { user_id: "coach-mm" }],
      ["GET", "/channels/ch-rvenue/members/coach-mm"],
      ["POST", "/channels/ch-rvenue/members", { user_id: "coach-mm" }],
    ]);
  });

  it("fails closed when a minted project agent cannot be added, after mounting the agent", async () => {
    const call = vi.fn(async (method: string, path: string) => {
      if (path.endsWith("/members/project-agent-mm")) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      if (method === "POST" && path === "/channels/project-1/members") {
        throw Object.assign(new Error("Mattermost POST failed: 500"), { status: 500 });
      }
      return null;
    });

    await expect(reconcileDefaultAgentProjectMembership({
      defaultAgentMmUserId: "coach-mm",
      projects: [{
        projectId: "orbit",
        projectAgentConfigured: true,
        projectAgentMmUserId: "project-agent-mm",
        channelIds: ["project-1"],
      }],
    }, call)).rejects.toThrow("Mattermost POST failed: 500");

    expect(call).toHaveBeenCalledWith("GET", "/channels/project-1/members/coach-mm");
  });

  it("adds missing agent membership and propagates upstream errors", async () => {
    const input = { defaultAgentMmUserId: "coach-mm", projects: [{ projectId: "orbit", projectAgentConfigured: false,
      projectAgentMmUserId: null, channelIds: ["project-1"] }] };
    const call = vi.fn(async (method: string) => {
      if (method === "GET") throw Object.assign(new Error("not found"), { status: 404 });
      return null;
    });
    await expect(reconcileDefaultAgentProjectMembership(input, call)).resolves.toEqual({ pendingProjectIds: [] });
    expect(call).toHaveBeenCalledWith("POST", "/channels/project-1/members", { user_id: "coach-mm" });
    await expect(reconcileDefaultAgentProjectMembership(input, vi.fn(async () => { throw new Error("Mattermost unavailable"); })))
      .rejects.toThrow("Mattermost unavailable");
  });
});
