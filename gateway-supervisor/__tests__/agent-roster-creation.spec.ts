import { describe, expect, it, vi } from "vitest";
import {
  createRosterAgents,
  rosterAgentSpecsFromEntries,
} from "../lib/agent-roster-creation.js";
import { OpenclawWireError } from "../lib/gateway-rpc.js";

function mkRpc(
  agentsCreate = vi.fn(async ({ name }: { name: string }) => ({
    ok: true as const,
    agentId: name,
    name,
    workspace: "/w",
  })),
  agentsDelete = vi.fn(async ({ agentId }: { agentId: string }) => ({
    ok: true as const,
    agentId,
    complete: true,
    removed: [],
    failed: [],
  })),
  cronJobCount = vi.fn(async () => 0),
) {
  return { rpc: { agentsCreate, agentsDelete, cronJobCount }, agentsCreate, agentsDelete, cronJobCount };
}

const deletionPending = (agentId: string) =>
  new OpenclawWireError("rpc-error", `agent "${agentId}" deletion cleanup is still pending`);

describe("rosterAgentSpecsFromEntries", () => {
  it("projects id and workspace out of built agent entries", () => {
    expect(
      rosterAgentSpecsFromEntries([
        { id: "octogee-alice-coach", workspace: "/c/alice", model: "house" },
        { id: "octogee-alice-proj-orbit-coach", workspace: "/c/alice/projects/orbit" },
      ]),
    ).toEqual([
      { agentId: "octogee-alice-coach", workspace: "/c/alice" },
      { agentId: "octogee-alice-proj-orbit-coach", workspace: "/c/alice/projects/orbit" },
    ]);
  });

  it("refuses an entry with no workspace — agents.create cannot invent one", () => {
    expect(() => rosterAgentSpecsFromEntries([{ id: "octogee-alice-coach" }])).toThrow(
      /octogee-alice-coach/,
    );
  });
});

describe("createRosterAgents", () => {
  it("creates each agent by passing the exact agent id as the name", async () => {
    const { rpc, agentsCreate } = mkRpc();

    const results = await createRosterAgents(
      [
        { agentId: "octogee-alice-coach", workspace: "/c/alice" },
        { agentId: "octogee-alice-proj-orbit-coach", workspace: "/c/alice/projects/orbit" },
      ],
      { rpc, log: vi.fn() },
    );

    expect(agentsCreate).toHaveBeenCalledTimes(2);
    expect(agentsCreate).toHaveBeenNthCalledWith(1, {
      name: "octogee-alice-coach",
      workspace: "/c/alice",
    });
    expect(results).toEqual([
      { agentId: "octogee-alice-coach", status: "created" },
      { agentId: "octogee-alice-proj-orbit-coach", status: "created" },
    ]);
  });

  it("fails loudly when the gateway hands back a different agent id than the name asked for", async () => {
    const agentsCreate = vi.fn(async () => ({
      ok: true as const,
      agentId: "octogee-alice-coach-2",
      name: "octogee-alice-coach",
      workspace: "/c/alice",
    }));

    await expect(
      createRosterAgents([{ agentId: "octogee-alice-coach", workspace: "/c/alice" }], {
        rpc: mkRpc(agentsCreate).rpc,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/octogee-alice-coach-2/);
  });

  it("treats an already-exists refusal as already-done", async () => {
    const agentsCreate = vi.fn(async () => {
      throw new OpenclawWireError("rpc-error", 'agent "octogee-alice-coach" already exists');
    });

    await expect(
      createRosterAgents([{ agentId: "octogee-alice-coach", workspace: "/c/alice" }], {
        rpc: mkRpc(agentsCreate).rpc,
        log: vi.fn(),
      }),
    ).resolves.toEqual([{ agentId: "octogee-alice-coach", status: "already-exists" }]);
  });

  it("throws with every failed agent named when a create is refused for any other reason", async () => {
    const agentsCreate = vi.fn(async ({ name }: { name: string }) => {
      if (name === "octogee-alice-coach") {
        throw new OpenclawWireError("rpc-error", "workspace path is outside the state dir");
      }
      return { ok: true as const, agentId: name, name, workspace: "/w" };
    });

    await expect(
      createRosterAgents(
        [
          { agentId: "octogee-alice-coach", workspace: "/etc" },
          { agentId: "octogee-alice-proj-orbit-coach", workspace: "/c/alice/projects/orbit" },
        ],
        { rpc: mkRpc(agentsCreate).rpc, log: vi.fn(), logPrefix: "[add:alice]" },
      ),
    ).rejects.toThrow(/octogee-alice-coach \(workspace path is outside the state dir\)/);

    expect(agentsCreate).toHaveBeenCalledTimes(2);
  });

  it("resumes a journaled deletion with agents.delete, then retries the create", async () => {
    const agentId = "octogee-alice-proj-orbit-coach";
    const calls: string[] = [];
    const agentsCreate = vi.fn(async ({ name }: { name: string }) => {
      calls.push("create");
      if (calls.filter((c) => c === "create").length === 1) throw deletionPending(name);
      return { ok: true as const, agentId: name, name, workspace: "/w" };
    });
    const agentsDelete = vi.fn(async () => {
      calls.push("delete");
      return { ok: true as const, agentId, complete: true, removed: [], failed: [] };
    });

    await expect(
      createRosterAgents([{ agentId, workspace: "/c/alice/projects/orbit" }], {
        rpc: mkRpc(agentsCreate, agentsDelete).rpc,
        log: vi.fn(),
        logPrefix: "[import:alice]",
      }),
    ).resolves.toEqual([{ agentId, status: "created" }]);

    expect(calls).toEqual(["create", "delete", "create"]);
    expect(agentsDelete).toHaveBeenCalledWith({ agentId, deleteFiles: false });
  });

  it("fails the create when the resumed deletion still cannot finish its cleanup", async () => {
    const agentId = "octogee-alice-proj-orbit-coach";
    const agentsCreate = vi.fn(async ({ name }: { name: string }) => {
      throw deletionPending(name);
    });
    const agentsDelete = vi.fn(async () => ({
      ok: true as const,
      agentId,
      complete: false,
      removed: [],
      failed: [],
      purgeFailed: true as const,
    }));

    await expect(
      createRosterAgents([{ agentId, workspace: "/c/alice/projects/orbit" }], {
        rpc: mkRpc(agentsCreate, agentsDelete).rpc,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/octogee-alice-proj-orbit-coach \(.*purgeFailed=true/);
    expect(agentsCreate).toHaveBeenCalledTimes(1);
  });

  it("retries the create exactly once after a resumed deletion", async () => {
    const agentId = "octogee-alice-proj-orbit-coach";
    const agentsCreate = vi.fn(async ({ name }: { name: string }) => {
      throw deletionPending(name);
    });
    const { rpc, agentsDelete } = mkRpc(agentsCreate);

    await expect(
      createRosterAgents([{ agentId, workspace: "/c/alice/projects/orbit" }], {
        rpc,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/octogee-alice-proj-orbit-coach \(agent "[^"]+" deletion cleanup is still pending\)/);
    expect(agentsDelete).toHaveBeenCalledTimes(1);
    expect(agentsCreate).toHaveBeenCalledTimes(2);
  });

  it("does not resume a deletion while the agent already has cron jobs on this gateway", async () => {
    const agentId = "octogee-alice-proj-orbit-coach";
    const agentsCreate = vi.fn(async ({ name }: { name: string }) => {
      throw deletionPending(name);
    });
    const { rpc, agentsDelete, cronJobCount } = mkRpc(agentsCreate, undefined, vi.fn(async () => 2));

    await expect(
      createRosterAgents([{ agentId, workspace: "/c/alice/projects/orbit" }], {
        rpc,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/deletion cleanup is still pending; not resuming the deletion because 2 cron job\(s\)/);
    expect(cronJobCount).toHaveBeenCalledWith(agentId, { includeDisabled: true });
    expect(agentsDelete).not.toHaveBeenCalled();
    expect(agentsCreate).toHaveBeenCalledTimes(1);
  });

  it("does not resume a deletion when the refusal names a different agent", async () => {
    const agentId = "octogee-alice-proj-orbit-coach";
    const agentsCreate = vi.fn(async () => {
      throw deletionPending("octogee-alice-coach");
    });
    const { rpc, agentsDelete } = mkRpc(agentsCreate);

    await expect(
      createRosterAgents([{ agentId, workspace: "/c/alice/projects/orbit" }], {
        rpc,
        log: vi.fn(),
      }),
    ).rejects.toThrow(/octogee-alice-proj-orbit-coach \(agent "octogee-alice-coach" deletion cleanup is still pending\)/);
    expect(agentsDelete).not.toHaveBeenCalled();
    expect(agentsCreate).toHaveBeenCalledTimes(1);
  });

  it("does not call the gateway for an empty spec list", async () => {
    const { rpc, agentsCreate } = mkRpc();

    await expect(createRosterAgents([], { rpc, log: vi.fn() })).resolves.toEqual([]);
    expect(agentsCreate).not.toHaveBeenCalled();
  });
});
