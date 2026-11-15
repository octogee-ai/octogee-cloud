import { describe, expect, it, vi } from "vitest";
import { projectAgentsRuntimeReady, reportProjectAgentReadiness } from "../lib/project-agent-readiness.js";

const agent = { projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "pat-orbit", activationId: "activation-1", status: "provisioning" as const };
const binding = { agentId: "octogee-alice-proj-orbit-coach", match: { channel: "mattermost", accountId: "alice-proj-orbit", peer: { kind: "group", id: "channel-orbit" } } };
function fixture() {
  const config = {
    agents: { entries: { [binding.agentId]: { id: binding.agentId } } },
    channels: { mattermost: { accounts: { "alice-proj-orbit": {} } } },
    bindings: [binding, { agentId: binding.agentId, match: { channel: "mattermost", accountId: "alice-proj-orbit" } }],
  };
  const rpc = {
    configGet: vi.fn(async () => ({ config, configRevisionHash: "revision-1", appliedConfigHash: "revision-1" })),
    channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: true, connected: true, lastStartAt: 2 }] } })),
  };
  const report = vi.fn(async () => undefined);
  const run = (projectAgents: Array<Omit<typeof agent, "status"> & { status: "provisioning" | "ready"; deliveryPending?: boolean }> = [agent]) => reportProjectAgentReadiness({
    rpc, report, uid: "uid-alice", slug: "alice", projectAgents, baseline: { "alice-proj-orbit": 1 },
    channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "channel-orbit" }],
  });
  return { rpc, config, report, run };
}

describe("project agent runtime readiness", () => {
  it.each([false, true])("verifies list-shaped project rosters without overriding keyed entries (keyed present: %s)", async (keyedPresent) => {
    const f = fixture();
    const config = {
      ...f.config,
      agents: { list: [{ id: binding.agentId }], ...(keyedPresent ? { entries: {} } : {}) },
    };
    expect(await projectAgentsRuntimeReady({
      rpc: { ...f.rpc, configGet: async () => ({ config, configRevisionHash: "revision-1", appliedConfigHash: "revision-1" }) },
      slug: "alice", projectAgents: [{ ...agent, status: "ready" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "channel-orbit" }],
    })).toBe(!keyedPresent);
  });

  it.each(["missing-agent", "missing-account", "wrong-binding", "disconnected", "applying", "ready"])("verifies an already-ready project during migration: %s", async (state) => {
    const f = fixture();
    if (state === "missing-agent") f.config.agents.entries = {};
    if (state === "missing-account") f.config.channels.mattermost.accounts = {};
    if (state === "wrong-binding") f.config.bindings[0] = { ...binding, agentId: "octogee-alice-coach" };
    if (state === "disconnected") f.rpc.channelsStatus.mockResolvedValue({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: true, connected: false, lastStartAt: 2 }] } });
    if (state === "applying") f.rpc.configGet.mockResolvedValue({ config: f.config, configRevisionHash: "revision-2", appliedConfigHash: "revision-1" });
    expect(await projectAgentsRuntimeReady({
      rpc: f.rpc, slug: "alice", projectAgents: [{ ...agent, status: "ready" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "channel-orbit" }],
    })).toBe(state === "ready");
    expect(f.report).not.toHaveBeenCalled();
  });
  it("does not require retired project agents during migration", async () => {
    const f = fixture();
    expect(await projectAgentsRuntimeReady({
      rpc: f.rpc, slug: "alice", projectAgents: [{ ...agent, enabled: false }], channels: [],
    })).toBe(true);
    expect(f.rpc.configGet).not.toHaveBeenCalled();
  });
  it("reports the minted activation only after the project account is bound, running and connected", async () => {
    const f = fixture();
    await f.run();
    expect(f.report).toHaveBeenCalledWith("uid-alice", [{
      projectId: "orbit", activationId: "activation-1", tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      channelIds: ["channel-orbit"],
    }]);
  });
  it.each(["missing", "stopped", "disconnected", "wrong-binding", "missing-agent"])("does not report %s project runtime as ready", async (state) => {
    const f = fixture();
    if (state === "missing") f.rpc.channelsStatus.mockResolvedValue({ channelAccounts: { mattermost: [] } });
    if (state === "stopped") f.rpc.channelsStatus.mockResolvedValue({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: false, connected: true, lastStartAt: 2 }] } });
    if (state === "disconnected") f.rpc.channelsStatus.mockResolvedValue({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: true, connected: false, lastStartAt: 2 }] } });
    if (state === "wrong-binding") f.config.bindings[0] = { ...binding, agentId: "octogee-alice-coach" };
    if (state === "missing-agent") f.config.agents.entries = {};
    await expect(f.run()).rejects.toThrow("Project Agent orbit is not connected to its configured channels");
    expect(f.report).not.toHaveBeenCalled();
  });
  it("does not accept a connected account from before this credential activation", async () => {
    const f = fixture();
    f.rpc.channelsStatus.mockResolvedValue({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: true, connected: true, lastStartAt: 1 }] } });
    await expect(f.run()).rejects.toThrow("orbit is not connected");
    expect(f.report).not.toHaveBeenCalled();
  });
  it("does not accept old connectivity while the desired configuration is still applying", async () => {
    const f = fixture();
    f.rpc.configGet.mockResolvedValue({ config: f.config, configRevisionHash: "revision-2", appliedConfigHash: "revision-1" });
    await expect(f.run()).rejects.toThrow("configuration has not been applied");
    expect(f.report).not.toHaveBeenCalled();
  });
  it("does not let an already-ready project block a new activation", async () => {
    const f = fixture();
    await f.run([agent, { ...agent, projectId: "older", status: "ready" }]);
    expect(f.report).toHaveBeenCalledTimes(1);
  });
  it("reports a connected pending project even when another pending project is unavailable", async () => {
    const f = fixture();
    await expect(f.run([agent, { ...agent, projectId: "offline" }])).rejects.toThrow("offline is not connected");
    expect(f.report).toHaveBeenCalledTimes(1);
    expect(f.report.mock.calls[0]?.[1][0].projectId).toBe("orbit");
  });
  it("does not claim readiness while bot minting has no activation generation", async () => {
    const f = fixture();
    await f.run([{ ...agent, activationId: "" }]);
    expect(f.report).not.toHaveBeenCalled();
    expect(f.rpc.channelsStatus).not.toHaveBeenCalled();
  });
});

it('retries pending handoff delivery without requiring another account restart', async () => {
  const f = fixture();
  f.rpc.channelsStatus.mockResolvedValue({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: true, connected: true, lastStartAt: 1 }] } });
  await f.run([{ ...agent, status: 'ready', deliveryPending: true }]);
  expect(f.report).toHaveBeenCalledTimes(1);
});
