import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import { runAgentAnchorRestore } from "../entrypoints/agent-anchor-restore.js";
import { withUserClaim } from "./helpers/user-claim.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const defaultAgent = { agentId: "octogee-alice-coach", storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_agent_92c817cc770f466d" };

describe("agent-anchor-restore entrypoint", () => {
  it.each(['cluster', 'gce-vm'])("initializes a claimed %s host before its first migration records any anchors", async runtime => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-anchor-first-import-')));
    roots.push(dir);
    const initializeHost = vi.fn(async () => undefined);
    const result = await runAgentAnchorRestore({
      env: withUserClaim({ GATEWAY_CLASS: 'isolated', GATEWAY_RUNTIME_KIND: runtime, GATEWAY_ID: 'alice-s-first', OPENCLAW_STATE_DIR: dir }, 'alice'),
      broker: { readAgentAnchors: async () => ({ anchors: [] }) },
      readConfig: () => ({ agents: { entries: { [defaultAgent.agentId]: {} } } }),
      initializeHost,
      log: () => {},
    });
    expect(result).toEqual({ landed: [], preserved: [], skipped: false });
    expect(initializeHost).toHaveBeenCalledExactlyOnceWith(dir);
  });
  it('refuses first-import startup if Native initialization fails before any anchors are recorded', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-anchor-first-import-')));
    roots.push(dir);
    await expect(runAgentAnchorRestore({
      env: withUserClaim({ GATEWAY_CLASS: 'isolated', GATEWAY_ID: 'alice-s-first', OPENCLAW_STATE_DIR: dir }, 'alice'),
      broker: { readAgentAnchors: async () => ({ anchors: [] }) }, readConfig: () => ({}),
      initializeHost: async () => { throw new Error('Native first-use failed'); }, log: () => {},
    })).rejects.toThrow('Native first-use failed');
  });
  it("lands the user's recorded anchors for configured agents before OpenClaw opens them", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-anchor-restore-")));
    roots.push(dir);
    const readAgentAnchors = vi.fn(async () => ({ anchors: [defaultAgent, { agentId: "octogee-alice-proj-gone-coach", storeId: "3313965d-1e56-4006-9d9c-1b0289fafcfa", schema: "octogee_agent_3313965d1e564006" }] }));
    const logs: string[] = [];

    const verify = vi.fn(async () => undefined);
    const initializeHost = vi.fn(async (stateDir: string) => {
      await expect(fs.stat(path.join(stateDir, "agents", defaultAgent.agentId))).rejects.toThrow();
    });
    const result = await runAgentAnchorRestore({
      env: withUserClaim({ GATEWAY_CLASS: "isolated", GATEWAY_ID: "alice-s-abc", OPENCLAW_STATE_DIR: dir }, "alice"),
      broker: { readAgentAnchors },
      readConfig: () => ({ agents: { entries: { [defaultAgent.agentId]: {}, "octogee-unmatched-route": {} } } }),
      verify,
      initializeHost,
      log: (m) => logs.push(m),
    });

    expect(result).toEqual({ landed: [defaultAgent.agentId], preserved: [], skipped: false });
    expect(verify).toHaveBeenCalledExactlyOnceWith(defaultAgent);
    expect(initializeHost).toHaveBeenCalledExactlyOnceWith(dir);
    expect(initializeHost.mock.invocationCallOrder[0]).toBeLessThan(verify.mock.invocationCallOrder[0]);
    expect(readAgentAnchors).toHaveBeenCalledExactlyOnceWith({ slug: "alice" });
    expect(readPostgresAgentAnchor(path.join(dir, "agents", defaultAgent.agentId, "agent", "openclaw-agent.sqlite"))).toEqual({ storeId: defaultAgent.storeId, schema: defaultAgent.schema });
    await expect(fs.stat(path.join(dir, "agents", "octogee-alice-proj-gone-coach"))).rejects.toThrow();
    expect(logs.some((m) => m.includes("landed 1 agent anchor"))).toBe(true);
  });

  it("does not land existing identity when native host initialization fails", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-anchor-restore-")));
    roots.push(dir);
    const verify = vi.fn();
    await expect(runAgentAnchorRestore({
      env: withUserClaim({ GATEWAY_CLASS: "isolated", GATEWAY_ID: "alice-s-abc", OPENCLAW_STATE_DIR: dir }, "alice"),
      broker: { readAgentAnchors: async () => ({ anchors: [defaultAgent] }) },
      readConfig: () => ({ agents: { entries: { [defaultAgent.agentId]: {} } } }),
      initializeHost: async () => { throw new Error("native boot refused existing history"); },
      verify,
      log: () => {},
    })).rejects.toThrow("native boot refused existing history");
    expect(verify).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(dir, "agents", defaultAgent.agentId))).rejects.toThrow();
  });

  it("lands the recorded gateway state anchor on a cluster user only", async () => {
    const state = { storeId: "c8feb4c9-41a7-4be1-b863-fa07ef6d1bdd", schema: "octogee_state_c8feb4c941a74be1" };
    const readAgentAnchors = vi.fn(async () => ({ anchors: [defaultAgent], state }));
    const restore = async (runtimeKind: string, verifyState = vi.fn(async () => undefined)) => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-anchor-restore-")));
      roots.push(dir);
      const initializeHost = vi.fn(async (root: string) => {
        expect(readPostgresAgentAnchor(path.join(root, "state", "openclaw.sqlite")))
          .toEqual(runtimeKind === "cluster" ? state : null);
        await expect(fs.stat(path.join(root, "agents", defaultAgent.agentId))).rejects.toThrow();
      });
      const result = await runAgentAnchorRestore({
        env: withUserClaim({ GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: runtimeKind, GATEWAY_ID: "alice-s-abc", OPENCLAW_STATE_DIR: dir }, "alice"),
        broker: { readAgentAnchors },
        readConfig: () => ({ agents: { entries: { [defaultAgent.agentId]: {} } } }),
        verify: async () => undefined,
        verifyState,
        initializeHost,
        log: () => {},
      });
      return { dir, result, verifyState, initializeHost };
    };

    const cluster = await restore("cluster");
    expect(cluster.result.state).toBe("landed");
    expect(cluster.verifyState).toHaveBeenCalledExactlyOnceWith(state);
    expect(cluster.verifyState.mock.invocationCallOrder[0]).toBeLessThan(cluster.initializeHost.mock.invocationCallOrder[0]);
    expect(readPostgresAgentAnchor(path.join(cluster.dir, "state", "openclaw.sqlite"))).toEqual(state);

    const vm = await restore("gce-vm");
    expect(vm.result.state).toBeUndefined();
    expect(vm.verifyState).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(vm.dir, "state", "openclaw.sqlite"))).rejects.toThrow();
  });

  it("keeps a state store that is already on local disk", async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-anchor-restore-")));
    roots.push(dir);
    await fs.mkdir(path.join(dir, "state"));
    await fs.writeFile(path.join(dir, "state", "openclaw.sqlite"), "local");
    const verifyState = vi.fn();
    const result = await runAgentAnchorRestore({
      env: withUserClaim({ GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "cluster", GATEWAY_ID: "alice-s-abc", OPENCLAW_STATE_DIR: dir }, "alice"),
      broker: { readAgentAnchors: async () => ({ anchors: [], state: { storeId: "c8feb4c9-41a7-4be1-b863-fa07ef6d1bdd", schema: "octogee_state_c8feb4c941a74be1" } }) },
      readConfig: () => ({ agents: { entries: {} } }),
      verifyState,
      log: () => {},
    });
    expect(result.state).toBe("preserved");
    expect(verifyState).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(dir, "state", "openclaw.sqlite"), "utf8")).toBe("local");

  });

  it("skips a Shared gateway and a user without a claim", async () => {
    const readAgentAnchors = vi.fn();
    expect(await runAgentAnchorRestore({ env: { GATEWAY_CLASS: "shared", GATEWAY_ID: "shared-a" }, broker: { readAgentAnchors }, readConfig: () => ({}), log: () => {} }))
      .toEqual({ landed: [], preserved: [], skipped: true });
    expect(await runAgentAnchorRestore({ env: { GATEWAY_CLASS: "isolated", GATEWAY_ID: "alice-s-abc" }, broker: { readAgentAnchors }, readConfig: () => ({}), log: () => {} }))
      .toEqual({ landed: [], preserved: [], skipped: true });
    expect(readAgentAnchors).not.toHaveBeenCalled();
  });
});
