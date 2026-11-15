import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPostgresAgentAnchor } from "@octogee/core/agent-postgres";
import {
  createAgentAnchorReporter,
  landAgentAnchors,
  landGatewayStateAnchor,
  readLocalAgentAnchors,
  verifyAgentAnchorInPostgres,
  verifyGatewayStateAnchorInPostgres,
} from "../lib/agent-anchor-record.js";

const sqliteFault = vi.hoisted(() => ({ failAnchorInsert: false }));
vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  class InterruptibleDatabaseSync extends actual.DatabaseSync {
    override prepare(sql: string) {
      if (sqliteFault.failAnchorInsert && sql.startsWith("INSERT INTO openclaw_engine_anchor")) {
        sqliteFault.failAnchorInsert = false;
        throw new Error("interrupted before the anchor row");
      }
      return super.prepare(sql);
    }
  }
  return { ...actual, DatabaseSync: InterruptibleDatabaseSync };
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function stateDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-anchor-")));
  roots.push(dir);
  return dir;
}

function storePath(dir: string, agentId: string): string {
  return path.join(dir, "agents", agentId, "agent", "openclaw-agent.sqlite");
}

async function seedAnchor(dir: string, anchor: { agentId: string; storeId: string; schema: string }): Promise<string> {
  const file = storePath(dir, anchor.agentId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(anchor.storeId, anchor.schema);
  db.close();
  return file;
}

const defaultAgent = { agentId: "octogee-alice-coach", storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_agent_92c817cc770f466d" };
const project = { agentId: "octogee-alice-proj-orbit-coach", storeId: "3313965d-1e56-4006-9d9c-1b0289fafcfa", schema: "octogee_agent_3313965d1e564006" };
const unmatched = { agentId: "octogee-unmatched-route", storeId: "635e605d-f247-4162-b9b8-fe306fbbce7f", schema: "octogee_agent_635e605df2474162" };

describe("landAgentAnchors", () => {
  it("lands recorded anchors for agents without a store and preserves an existing store", async () => {
    const dir = await stateDir();
    const existing = await seedAnchor(dir, { ...project, storeId: "11111111-2222-4333-8444-555555555555", schema: "octogee_agent_1111111122224333" });
    const before = await fs.readFile(existing);

    const result = await landAgentAnchors(dir, [defaultAgent, project, unmatched]);

    expect(result).toEqual({ landed: [defaultAgent.agentId, unmatched.agentId], preserved: [project.agentId] });
    expect(readPostgresAgentAnchor(storePath(dir, defaultAgent.agentId))).toEqual({ storeId: defaultAgent.storeId, schema: defaultAgent.schema });
    expect(readPostgresAgentAnchor(storePath(dir, unmatched.agentId))).toEqual({ storeId: unmatched.storeId, schema: unmatched.schema });
    expect(await fs.readFile(existing)).toEqual(before);
    expect((await fs.stat(storePath(dir, defaultAgent.agentId))).mode & 0o777).toBe(0o600);
  });

  it("leaves no store behind when landing is interrupted, so a retry lands a complete anchor", async () => {
    const dir = await stateDir();
    sqliteFault.failAnchorInsert = true;

    await expect(landAgentAnchors(dir, [defaultAgent])).rejects.toThrow("interrupted before the anchor row");

    expect(await fs.readdir(path.dirname(storePath(dir, defaultAgent.agentId)))).toEqual([]);
    expect(await landAgentAnchors(dir, [defaultAgent])).toEqual({ landed: [defaultAgent.agentId], preserved: [] });
    expect(readPostgresAgentAnchor(storePath(dir, defaultAgent.agentId))).toEqual({ storeId: defaultAgent.storeId, schema: defaultAgent.schema });
  });

  it("refuses an anchor that is not a PostgreSQL store identity and lands nothing", async () => {
    const dir = await stateDir();
    await expect(landAgentAnchors(dir, [{ ...defaultAgent, storeId: "not-a-uuid" }])).rejects.toThrow("agent anchor identity is invalid");
    await expect(landAgentAnchors(dir, [{ ...defaultAgent, schema: "Octogee-Agent" }])).rejects.toThrow("agent anchor identity is invalid");
    await expect(landAgentAnchors(dir, [{ ...defaultAgent, agentId: "../escape" }])).rejects.toThrow("agent anchor identity is invalid");
    await expect(fs.stat(storePath(dir, defaultAgent.agentId))).rejects.toThrow();
  });
});

describe("landAgentAnchors verification", () => {
  it("verifies only the anchors it lands and lands nothing when one fails", async () => {
    const dir = await stateDir();
    await seedAnchor(dir, project);
    const verify = vi.fn(async (anchor: { agentId: string }) => {
      if (anchor.agentId === unmatched.agentId) throw new Error("PostgreSQL schema octogee_agent_635e605df2474162 for octogee-unmatched-route is missing");
    });

    await expect(landAgentAnchors(dir, [defaultAgent, project, unmatched], verify)).rejects.toThrow("is missing");

    expect(verify.mock.calls.map(([anchor]) => anchor.agentId)).toEqual([defaultAgent.agentId, unmatched.agentId]);
    await expect(fs.stat(storePath(dir, defaultAgent.agentId))).rejects.toThrow();
    await expect(fs.stat(storePath(dir, unmatched.agentId))).rejects.toThrow();
  });
});

describe("verifyAgentAnchorInPostgres", () => {
  const meta = (storeId: string, agentId: string) => vi.fn(async (_anchor: unknown, query: string) =>
    query.includes("openclaw_schema_meta") ? [{ store_id: storeId }] : [{ agent_id: agentId }]);

  it("accepts a schema whose store identity and primary agent match the anchor", async () => {
    const query = meta(defaultAgent.storeId, defaultAgent.agentId);
    await expect(verifyAgentAnchorInPostgres(defaultAgent, query)).resolves.toBeUndefined();
    expect(query.mock.calls.map(([, sql]) => sql)).toEqual([
      "SELECT store_id FROM $schema.openclaw_schema_meta WHERE store = 'agent'",
      "SELECT agent_id FROM $schema.schema_meta WHERE meta_key = 'primary'",
    ]);
  });

  it("refuses a different store identity or a schema owned by another agent", async () => {
    await expect(verifyAgentAnchorInPostgres(defaultAgent, meta(project.storeId, defaultAgent.agentId))).rejects.toThrow("holds store 3313965d-1e56-4006-9d9c-1b0289fafcfa");
    await expect(verifyAgentAnchorInPostgres(defaultAgent, meta(defaultAgent.storeId, project.agentId))).rejects.toThrow(`belongs to ${project.agentId}`);
  });

  it("refuses a schema that no longer exists instead of letting OpenClaw bootstrap an empty one", async () => {
    const missing = vi.fn(async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); });
    await expect(verifyAgentAnchorInPostgres(defaultAgent, missing)).rejects.toThrow(`PostgreSQL schema ${defaultAgent.schema} for ${defaultAgent.agentId} is missing`);
    await expect(verifyAgentAnchorInPostgres(defaultAgent, vi.fn(async () => []))).rejects.toThrow("is missing");
    const unavailable = vi.fn(async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); });
    await expect(verifyAgentAnchorInPostgres(defaultAgent, unavailable)).rejects.toThrow("ECONNREFUSED");
  });
});

describe("gateway state anchors", () => {
  const state = { storeId: "c8feb4c9-41a7-4be1-b863-fa07ef6d1bdd", schema: "octogee_state_c8feb4c941a74be1" };

  it("verifies the state schema identity before trusting it", async () => {
    const query = vi.fn(async () => [{ store_id: state.storeId }]);
    await expect(verifyGatewayStateAnchorInPostgres(state, query)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledExactlyOnceWith(state, "SELECT store_id FROM $schema.openclaw_schema_meta WHERE store = 'state'");
    await expect(verifyGatewayStateAnchorInPostgres(state, vi.fn(async () => [{ store_id: defaultAgent.storeId }]))).rejects.toThrow(`holds state store ${defaultAgent.storeId}`);
    const missing = vi.fn(async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); });
    await expect(verifyGatewayStateAnchorInPostgres(state, missing)).rejects.toThrow(`PostgreSQL state schema ${state.schema} is missing`);
    await expect(verifyGatewayStateAnchorInPostgres(state, vi.fn(async () => []))).rejects.toThrow("is missing");
  });

  it("lands a verified state anchor and lands nothing when verification fails", async () => {
    const dir = await stateDir();
    await expect(landGatewayStateAnchor(dir, state, async () => { throw new Error("schema missing"); })).rejects.toThrow("schema missing");
    await expect(fs.stat(path.join(dir, "state", "openclaw.sqlite"))).rejects.toThrow();
    await expect(landGatewayStateAnchor(dir, state, async () => undefined)).resolves.toBe("landed");
    expect(readPostgresAgentAnchor(path.join(dir, "state", "openclaw.sqlite"))).toEqual(state);
    await expect(landGatewayStateAnchor(dir, state, async () => { throw new Error("not consulted"); })).resolves.toBe("preserved");
    await expect(landGatewayStateAnchor(dir, { ...state, schema: "../escape" }, async () => undefined)).rejects.toThrow("identity is invalid");
  });

  it("reports the local state anchor with the agent anchors", async () => {
    const dir = await stateDir();
    await seedAnchor(dir, defaultAgent);
    const reportAgentAnchors = vi.fn(async () => undefined);
    const report = createAgentAnchorReporter({ stateDir: dir, slug: "alice", broker: { reportAgentAnchors }, readAgentIds: () => [defaultAgent.agentId], log: () => {} });
    await report();
    expect(reportAgentAnchors).toHaveBeenLastCalledWith({ slug: "alice", anchors: [defaultAgent], configuredAgentIds: [defaultAgent.agentId] });

    await landGatewayStateAnchor(dir, state, async () => undefined);
    await report();
    expect(reportAgentAnchors).toHaveBeenCalledTimes(2);
    expect(reportAgentAnchors).toHaveBeenLastCalledWith({ slug: "alice", anchors: [defaultAgent], configuredAgentIds: [defaultAgent.agentId], state });
  });
});

describe("readLocalAgentAnchors", () => {
  it("reads only the configured agents that hold a PostgreSQL anchor", async () => {
    const dir = await stateDir();
    await seedAnchor(dir, defaultAgent);
    await fs.mkdir(path.dirname(storePath(dir, project.agentId)), { recursive: true });
    expect(await readLocalAgentAnchors(dir, [defaultAgent.agentId, project.agentId, "octogee-absent-coach"])).toEqual([defaultAgent]);
  });
});

describe("createAgentAnchorReporter", () => {
  function reporter(dir: string, broker: { reportAgentAnchors: ReturnType<typeof vi.fn> }, logs: string[], readAgentIds: () => readonly string[] = () => [defaultAgent.agentId, project.agentId]) {
    return createAgentAnchorReporter({ stateDir: dir, slug: "alice", broker, readAgentIds, log: (m) => logs.push(m) });
  }

  it("reports once per anchor set and again when the set changes", async () => {
    const dir = await stateDir();
    await seedAnchor(dir, defaultAgent);
    const reportAgentAnchors = vi.fn(async () => undefined);
    const logs: string[] = [];
    const report = reporter(dir, { reportAgentAnchors }, logs);

    await report();
    await report();
    expect(reportAgentAnchors).toHaveBeenCalledExactlyOnceWith({ slug: "alice", anchors: [defaultAgent], configuredAgentIds: [defaultAgent.agentId, project.agentId] });

    await seedAnchor(dir, project);
    await report();
    expect(reportAgentAnchors).toHaveBeenCalledTimes(2);
    expect(reportAgentAnchors).toHaveBeenLastCalledWith({ slug: "alice", anchors: [defaultAgent, project], configuredAgentIds: [defaultAgent.agentId, project.agentId] });
    expect(logs.some((m) => m.includes("recorded 2 agent anchor"))).toBe(true);
  });

  it("retries a failed report on the next pass and logs a repeated failure once", async () => {
    const dir = await stateDir();
    await seedAnchor(dir, defaultAgent);
    const reportAgentAnchors = vi.fn()
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValue(undefined);
    const logs: string[] = [];
    const report = reporter(dir, { reportAgentAnchors }, logs);
    await report();
    await report();
    await report();
    expect(reportAgentAnchors).toHaveBeenCalledTimes(3);
    expect(logs.filter((m) => m.includes("broker unavailable"))).toHaveLength(1);
    expect(logs.at(-1)).toContain("recorded 1 agent anchor");
  });

  it("logs instead of rejecting when a local anchor or the configured roster cannot be read", async () => {
    const dir = await stateDir();
    const file = storePath(dir, defaultAgent.agentId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)");
    db.prepare("INSERT INTO openclaw_engine_anchor VALUES ('not-a-uuid', 'postgres', 'octogee_agent_x')").run();
    db.close();
    const reportAgentAnchors = vi.fn(async () => undefined);
    const logs: string[] = [];

    await expect(reporter(dir, { reportAgentAnchors }, logs)()).resolves.toBeUndefined();
    await expect(reporter(dir, { reportAgentAnchors }, logs, () => { throw new Error("config unreadable"); })()).resolves.toBeUndefined();

    expect(reportAgentAnchors).not.toHaveBeenCalled();
    expect(logs.some((m) => m.includes("Invalid PostgreSQL agent anchor"))).toBe(true);
    expect(logs.some((m) => m.includes("config unreadable"))).toBe(true);
  });

  it("never reports an empty anchor set", async () => {
    const dir = await stateDir();
    const reportAgentAnchors = vi.fn(async () => undefined);
    const logs: string[] = [];
    await reporter(dir, { reportAgentAnchors }, logs)();
    expect(reportAgentAnchors).not.toHaveBeenCalled();
    expect(logs.some((m) => m.includes("nothing recorded"))).toBe(true);
  });
});
