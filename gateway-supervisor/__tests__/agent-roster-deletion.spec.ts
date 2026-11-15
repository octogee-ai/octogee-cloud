import { describe, expect, it, vi } from "vitest";
import { deleteRosterAgents } from "../lib/agent-roster-deletion.js";
import { OpenclawWireError, type GatewayRpcClient } from "../lib/gateway-rpc.js";

vi.mock("../lib/config.js", async () => {
  const actual: object = await vi.importActual("../lib/config.js");
  return { ...actual, log: vi.fn() };
});

function notFound(agentId: string): OpenclawWireError {
  return new OpenclawWireError("rpc-error", `agent "${agentId}" not found`, {
    serverCode: "INVALID_REQUEST",
  });
}

function mkRpc(
  impl: (params: { agentId: string; deleteFiles?: boolean }) => Promise<unknown>,
): Pick<GatewayRpcClient, "agentsDelete"> {
  return { agentsDelete: vi.fn(impl) } as unknown as Pick<GatewayRpcClient, "agentsDelete">;
}

describe("deleteRosterAgents", () => {
  it("deletes each departing agent exactly once, in order", async () => {
    const seen: string[] = [];
    const rpc = mkRpc(async ({ agentId }) => {
      seen.push(agentId);
      return { ok: true, agentId, removedBindings: 1 };
    });

    const results = await deleteRosterAgents(
      ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"],
      { rpc, log: vi.fn(), logPrefix: "[remove:alice]" },
    );

    expect(seen).toEqual(["octogee-alice-coach", "octogee-alice-proj-orbit-coach"]);
    expect(rpc.agentsDelete).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { agentId: "octogee-alice-coach", status: "deleted" },
      { agentId: "octogee-alice-proj-orbit-coach", status: "deleted" },
    ]);
  });

  it("emits progress while a roster delete is still running", async () => {
    vi.useFakeTimers();
    try {
      let finishDelete: (() => void) | undefined;
      const deleteFinished = new Promise<void>((resolve) => {
        finishDelete = resolve;
      });
      const log = vi.fn();
      const rpc = mkRpc(async () => {
        await deleteFinished;
        return { ok: true };
      });

      const deleting = deleteRosterAgents(["octogee-alice-coach"], { rpc, log });

      await vi.advanceTimersByTimeAsync(15_000);

      expect(log).toHaveBeenCalledWith(
        "agents.delete pending agentId=octogee-alice-coach elapsedMs=15000",
      );
      finishDelete?.();
      await deleting;
      expect(log).toHaveBeenCalledWith(
        "agents.delete completed agentId=octogee-alice-coach elapsedMs=15000",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // A agent's openclaw workspace IS the user directory. Letting openclaw
  // trash it would destroy a retained user's checkout during a cancelled
  // eviction and would override a cleanup job's `deleteWorkspace: false`.
  it("never lets openclaw delete the departing agent's files", async () => {
    const rpc = mkRpc(async ({ agentId }) => ({ ok: true, agentId, removedBindings: 0 }));

    await deleteRosterAgents(["octogee-alice-coach"], { rpc, log: vi.fn() });

    expect(rpc.agentsDelete).toHaveBeenCalledWith({
      agentId: "octogee-alice-coach",
      deleteFiles: false,
    });
  });

  it("tolerates a not-found agent so a retried eviction still completes", async () => {
    const log = vi.fn();
    const rpc = mkRpc(async ({ agentId }) => {
      if (agentId === "octogee-alice-proj-orbit-coach") throw notFound(agentId);
      return { ok: true, agentId, removedBindings: 0 };
    });

    const results = await deleteRosterAgents(
      ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"],
      { rpc, log, logPrefix: "[remove:alice]" },
    );

    expect(results).toEqual([
      { agentId: "octogee-alice-coach", status: "deleted" },
      { agentId: "octogee-alice-proj-orbit-coach", status: "not-found" },
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("octogee-alice-proj-orbit-coach"),
    );
  });

  it("attempts every agent before throwing, and names each failure", async () => {
    const rpc = mkRpc(async ({ agentId }) => {
      if (agentId === "octogee-alice-coach") {
        throw new OpenclawWireError("rpc-error", "config mutation lock timed out");
      }
      return { ok: true, agentId, removedBindings: 0 };
    });

    await expect(
      deleteRosterAgents(
        ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"],
        { rpc, log: vi.fn(), logPrefix: "[remove:alice]" },
      ),
    ).rejects.toThrow(/octogee-alice-coach.*config mutation lock timed out/s);

    expect(rpc.agentsDelete).toHaveBeenCalledTimes(2);
  });

  it.each([
    { purgeFailed: true, failed: [] },
    { failed: [{ path: "/state/agents/alice", error: "database is held" }] },
  ])("rejects incomplete native cleanup and still attempts the other agents: %j", async (partial) => {
    const log = vi.fn();
    const rpc = mkRpc(async ({ agentId }) => ({
      ok: true,
      agentId,
      ...(agentId === "octogee-alice-coach" ? partial : { failed: [] }),
    }));

    await expect(deleteRosterAgents(
      ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"],
      { rpc, log },
    )).rejects.toThrow(/octogee-alice-coach.*cleanup incomplete/);

    expect(rpc.agentsDelete).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("completed agentId=octogee-alice-coach "));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("completed agentId=octogee-alice-proj-orbit-coach "));
  });

  it("fails the eviction when a delete is refused for a non-not-found reason", async () => {
    const rpc = mkRpc(async ({ agentId }) => {
      throw new OpenclawWireError(
        "rpc-error",
        `Agent "${agentId}" is the default and cannot be deleted. Reassign default first.`,
      );
    });

    await expect(
      deleteRosterAgents(["octogee-alice-coach"], { rpc, log: vi.fn() }),
    ).rejects.toThrow(/octogee-alice-coach/);
  });

  it("does no RPC work for an empty departing set", async () => {
    const rpc = mkRpc(async () => ({ ok: true }));

    await expect(deleteRosterAgents([], { rpc, log: vi.fn() })).resolves.toEqual([]);
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
  });
});

describe("userAgentIdsInRoster", () => {
  it("reads the keyed roster 2026.7.2 migrates to and keeps only the slug's agents", async () => {
    const { userAgentIdsInRoster } = await import("../lib/agent-roster-deletion.js");

    expect(
      userAgentIdsInRoster(
        {
          agents: {
            entries: {
              main: {},
              "octogee-ops-eggman": {},
              "octogee-alice-coach": {},
              "octogee-alice-proj-orbit-coach": {},
              "octogee-alicia-coach": {},
            },
          },
        },
        "alice",
      ),
    ).toEqual(["octogee-alice-coach", "octogee-alice-proj-orbit-coach"]);
  });

  it("still reads the legacy list roster", async () => {
    const { userAgentIdsInRoster } = await import("../lib/agent-roster-deletion.js");

    expect(
      userAgentIdsInRoster(
        { agents: { list: [{ id: "octogee-bob-coach" }, { id: "octogee-alice-coach" }] } },
        "alice",
      ),
    ).toEqual(["octogee-alice-coach"]);
  });
});

it("uses detach for a PostgreSQL handoff and never falls back to delete", async () => {
  const agentsDelete = vi.fn(async () => { throw new Error("must not delete"); });
  const agentsDetach = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId }));
  await expect(deleteRosterAgents(["octogee-alice-coach"], { rpc: { agentsDelete, agentsDetach }, preserveStore: true, log: vi.fn() })).resolves.toHaveLength(1);
  expect(agentsDetach).toHaveBeenCalledExactlyOnceWith({ agentId: "octogee-alice-coach" });
  await expect(deleteRosterAgents(["octogee-alice-coach"], { rpc: { agentsDelete }, preserveStore: true, log: vi.fn() })).rejects.toThrow("does not support agents.detach");
  expect(agentsDelete).not.toHaveBeenCalled();
});
