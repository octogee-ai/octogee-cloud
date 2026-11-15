import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { upgradeImportedAgentStores } from "../lib/openclaw-import-upgrade.js";
import type { OpenClawCommand } from "../lib/openclaw-cli.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "import-doctor-test-"))); roots.push(root);
  const agentId = "octogee-alice-coach", storeId = "14d620f0-129f-4a72-b1cd-55ad563db8dc", schema = "octogee_agent_14d620f0129f4a72";
  const anchorPath = path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
  await fs.mkdir(path.dirname(anchorPath), { recursive: true });
  const db = new DatabaseSync(anchorPath); db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(storeId, schema); db.close();
  const stores = [{ agentId, anchorPath, storeId, schema }];
  const assertCurrent = vi.fn(async () => {});
  let version = 37;
  const query = vi.fn(async () => [{ store_id: storeId, version, role: "agent", agent_id: agentId, schema_version: version }]);
  const run = vi.fn<OpenClawCommand>(async (args, { env }) => {
    if (args[0] === "database") return { code: 1, stdout: JSON.stringify({ schema: "openclaw.agent-schema-preflight.v1", agentId,
      databasePath: args[2], status: "indeterminate", foundVersion: null, requiresWrite: false, targetVersion: 38 }) };
    expect(env.OPENCLAW_STATE_DIR).not.toBe(root);
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    const config = JSON.parse(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8"));
    if (config.database.families?.agent?.engine === "postgres") {
      expect(Object.keys(config.agents.entries)).toEqual([agentId]);
      expect(await fs.readFile(path.join(env.OPENCLAW_STATE_DIR!, "agents", agentId, "agent", "openclaw-agent.sqlite"))).toEqual(await fs.readFile(anchorPath));
      expect(config.database.families.state).toBeUndefined();
      version = 38;
    }
    return { code: 0, stdout: "" };
  });
  return { root, stores, assertCurrent, run, log: vi.fn(), query: query as unknown as typeof import("@octogee/core/agent-postgres").queryAgentStore, env: { OPENCLAW_AGENT_STORE_DSN: "postgresql://synthetic", OPENCLAW_GATEWAY_TOKEN: "secret" } };
}

it("runs Native Doctor against only the carried PostgreSQL agent in private state and preserves the original anchor", async () => {
  const f = await fixture(); const before = await fs.readFile(f.stores[0]!.anchorPath);
  await upgradeImportedAgentStores(f);
  expect(f.run).toHaveBeenCalledTimes(3);
  expect(f.run.mock.calls.map(([args]) => args)).toEqual([
    expect.arrayContaining(["database", "preflight-agent"]),
    ["setup", "--baseline", "--skip-bootstrap", "--json"],
    ["doctor", "--fix", "--non-interactive", "--skip-recovery-backups"],
  ]);
  expect(f.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/phase=descriptor .*durationMs=/));
  expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/phase=pre-metadata .*durationMs=/));
  expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/phase=bootstrap .*durationMs=/));
  expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/phase=doctor .*durationMs=/));
  expect(f.log).toHaveBeenCalledWith(expect.stringMatching(/phase=post-metadata .*durationMs=/));
  expect(await fs.readFile(f.stores[0]!.anchorPath)).toEqual(before);
  for (const [, options] of f.run.mock.calls) await expect(fs.stat(options.env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("leaves the user's HEARTBEAT.md for a later Doctor because every workspace the private Doctor sees is its own", async () => {
  const f = await fixture();
  const heartbeat = path.join(f.root, "customers", "alice", "HEARTBEAT.md");
  await fs.mkdir(path.dirname(heartbeat), { recursive: true });
  await fs.writeFile(heartbeat, "- check the inbox\n");
  const seen: Array<{ stateDir: string; workspaces: string[] }> = [];
  const run = f.run;
  f.run = vi.fn<OpenClawCommand>(async (args, options) => {
    if (args[0] === "doctor") {
      const config = JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8"));
      seen.push({ stateDir: options.env.OPENCLAW_STATE_DIR!,
        workspaces: Object.values<{ workspace: string }>(config.agents.entries).map(entry => entry.workspace) });
    }
    return run(args, options);
  });

  await upgradeImportedAgentStores(f);

  expect(seen).toHaveLength(1);
  for (const { stateDir, workspaces } of seen) {
    for (const workspace of workspaces) expect(workspace.startsWith(stateDir + path.sep)).toBe(true);
  }
  expect(await fs.readFile(heartbeat, "utf8")).toBe("- check the inbox\n");
});

it("refuses an anchor that differs from the authorized roster before running Doctor", async () => {
  const f = await fixture(); f.stores[0]!.schema = "octogee_agent_foreign";
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(/anchor/i);
  expect(f.run).not.toHaveBeenCalled();
});

it("fails closed if custody changes during Native Doctor", async () => {
  const f = await fixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (args[0] === "doctor" && JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8")).database.families?.agent) {
      f.assertCurrent.mockRejectedValue(new Error("custody lost")); return { code: 0, stdout: "" };
    }
    return original(args, options);
  });
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow("custody lost");
});

it("rejects duplicate stores and a live anchor sidecar", async () => {
  const f = await fixture();
  await expect(upgradeImportedAgentStores({ ...f, stores: [...f.stores, { ...f.stores[0]!, agentId: "octogee-bob-coach" }] })).rejects.toThrow(/unique/);
  await fs.writeFile(`${f.stores[0]!.anchorPath}-wal`, "writer active");
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(/not closed/);
  expect(f.run).not.toHaveBeenCalled();
});

it("reports a failing Native Doctor without publishing a successful upgrade", async () => {
  const f = await fixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => args[0] === "doctor" && JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8")).database.families?.agent
    ? { code: 1, stdout: "" } : original(args, options));
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(/full PostgreSQL repair failed/);
  for (const [, options] of f.run.mock.calls) await expect(fs.stat(options.env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("detects replacement of a carried anchor while Native Doctor runs", async () => {
  const f = await fixture();
  const original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (args[0] === "doctor" && JSON.parse(await fs.readFile(options.env.OPENCLAW_CONFIG_PATH!, "utf8")).database.families?.agent) {
      await fs.writeFile(f.stores[0]!.anchorPath, "replaced"); return { code: 0, stdout: "" };
    }
    return original(args, options);
  });
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(/anchor changed/);
});

it("rejects an anchor replaced with an identical file during custody verification", async () => {
  const f = await fixture();
  const file = f.stores[0]!.anchorPath;
  f.assertCurrent.mockImplementationOnce(async () => {
    await fs.copyFile(file, `${file}.replacement`);
    await fs.rename(`${file}.replacement`, file);
  });
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(/anchor changed/);
  expect(f.run).not.toHaveBeenCalled();
});

it("skips Doctor when all authorized PostgreSQL agents already match the installed Native schema", async () => {
  const f = await fixture();
  const query = vi.fn(async () => [{ store_id: f.stores[0]!.storeId, version: 38, role: "agent", agent_id: f.stores[0]!.agentId, schema_version: 38 }]);
  f.run.mockImplementation(async (args) => {
    expect(args.slice(0, 2)).toEqual(["database", "preflight-agent"]);
    return { code: 1, stdout: JSON.stringify({ schema: "openclaw.agent-schema-preflight.v1", agentId: f.stores[0]!.agentId,
      databasePath: args[2], status: "indeterminate", foundVersion: null, requiresWrite: false, targetVersion: 38 }) };
  });
  await upgradeImportedAgentStores({ ...f, query: query as unknown as typeof import("@octogee/core/agent-postgres").queryAgentStore });
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("upgrade=skipped"));
});

it.each(["newer", "wrong-owner", "partial-upgrade"] as const)("refuses agent adoption when PostgreSQL metadata is %s", async problem => {
  const f = await fixture();
  const version = problem === "newer" ? 39 : 37;
  const query = vi.fn(async () => [{ store_id: f.stores[0]!.storeId, version, role: "agent",
    agent_id: problem === "wrong-owner" ? "octogee-foreign-coach" : f.stores[0]!.agentId, schema_version: version }]);
  await expect(upgradeImportedAgentStores({ ...f, query: query as unknown as typeof import("@octogee/core/agent-postgres").queryAgentStore })).rejects.toThrow(/metadata mismatch/);
  expect(f.run.mock.calls.filter(([args]) => args[0] === "doctor")).toHaveLength(problem === "partial-upgrade" ? 1 : 0);
});


it.each(["refused", "timeout", "custody"])("does not upgrade PostgreSQL after private setup %s", async failure => {
  const f = await fixture(), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (args[0] !== "setup") return original(args, options);
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.env.HOME).toBe(options.env.OPENCLAW_STATE_DIR);
    if (failure === "timeout") throw new Error("setup timeout");
    if (failure === "custody") f.assertCurrent.mockRejectedValue(new Error("setup custody lost"));
    return { code: failure === "refused" ? 2 : 0, stdout: "" };
  });
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(failure === "refused" ? /bootstrap setup failed/ : /setup (timeout|custody lost)/);
  expect(f.run.mock.calls.some(([args]) => args[0] === "doctor")).toBe(false);
});

it("retries full Doctor after a fast refusal while custody remains current", async () => {
  const f = await fixture(), original = f.run.getMockImplementation()!, log = vi.fn();
  f.run.mockImplementation(async (args, options) => {
    if (args.includes("--skip-recovery-backups")) return { code: 2, stdout: "", stderr: "fast refused" };
    return original(args, options);
  });
  await upgradeImportedAgentStores({ ...f, log });
  expect(f.run.mock.calls.filter(([args]) => args[0] === "doctor").map(([args]) => args)).toEqual([
    ["doctor", "--fix", "--non-interactive", "--skip-recovery-backups"],
    ["doctor", "--fix", "--non-interactive"],
  ]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("fast"));
  expect(log).toHaveBeenCalledWith(expect.stringContaining("full"));
});

it("does not retry full Doctor when custody is lost during the fast attempt", async () => {
  const f = await fixture(), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => {
    if (args.includes("--skip-recovery-backups")) { f.assertCurrent.mockRejectedValue(new Error("custody lost")); return { code: 2, stdout: "" }; }
    return original(args, options);
  });
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow("custody lost");
  expect(f.run.mock.calls.filter(([args]) => args[0] === "doctor")).toHaveLength(1);
});

it("does not retry full Doctor after cancellation during the fast attempt", async () => {
  const f = await fixture(), original = f.run.getMockImplementation()!, controller = new AbortController();
  f.run.mockImplementation(async (args, options) => {
    if (args.includes("--skip-recovery-backups")) { controller.abort(new Error("cancelled")); return { code: 2, stdout: "" }; }
    return original(args, options);
  });
  await expect(upgradeImportedAgentStores({ ...f, signal: controller.signal })).rejects.toThrow("cancelled");
  expect(f.run.mock.calls.filter(([args]) => args[0] === "doctor")).toHaveLength(1);
});

it("logs and propagates an unsuccessful full Doctor repair", async () => {
  const f = await fixture(), original = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (args, options) => args[0] === "doctor" ? { code: 2, stdout: "" } : original(args, options));
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow(/full PostgreSQL repair failed/);
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("fast Doctor failed"));
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("full Doctor repair failed"));
});

it("caches a successful immutable descriptor and retries a rejected probe", async () => {
  const f = await fixture(), original = f.run.getMockImplementation()!;
  let fail = true;
  f.run.mockImplementation(async (args, options) => {
    if (args[1] === "preflight-agent" && fail) { fail = false; throw new Error("probe failed"); }
    return original(args, options);
  });
  await expect(upgradeImportedAgentStores(f)).rejects.toThrow("probe failed");
  await upgradeImportedAgentStores(f);
  await upgradeImportedAgentStores(f);
  expect(f.run.mock.calls.filter(([args]) => args[1] === "preflight-agent")).toHaveLength(2);
});


it("leaves an older source schema unchanged when preparing a user activation", async () => {
  const f = await fixture();
  await expect(upgradeImportedAgentStores({ ...f, allowUpgrade: false })).rejects.toThrow("source retained");
  expect(f.run.mock.calls.map(([args]) => args[0])).toEqual(["database"]);
});
