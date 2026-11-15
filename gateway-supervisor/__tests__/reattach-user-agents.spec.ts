import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { reattachUserAgents } from "../lib/reattach-user-agents.js";
import { captureCarriedAgentRosterFailure, CARRIED_AGENT_DIAGNOSTICS_DIRECTORY } from "../lib/carried-agent-diagnostics.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reattach-user-"));
  roots.push(root);
  const agentId = "octogee-chris-coach";
  const agentDir = path.join(root, "agents", agentId, "agent");
  const destinationPath = path.join(agentDir, "openclaw-agent.sqlite");
  await fs.mkdir(agentDir, { recursive: true });
  const database = new DatabaseSync(destinationPath);
  database.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
  database.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
    .run("1514f000-4540-4f4e-92a1-831adeac3d5b", "octogee_agent_fixture");
  database.close();
  return { root, agentId, agentDir, destinationPath, workspace: path.join(root, "customers", "chris") };
}

it.each(["already-configured", "refused", "wrong-receipt", "wrong-roster", "anchor-changed", "gate-lost", "invalid-json"])(
  "keeps Native restoration admission and carried identity intact for %s",
  async (mode) => {
    const f = await fixture();
    let held = true;
    const log = vi.fn();
    const run = vi.fn(async (args: string[]) => {
      if (args[1] === "list") {
        if (mode === "gate-lost") held = false;
        return { code: 0, stdout: mode === "invalid-json" ? "not JSON" : JSON.stringify([
          { id: f.agentId, workspace: f.workspace, agentDir: mode === "wrong-roster" ? path.join(f.root, "other") : f.agentDir },
        ]) };
      }
      if (mode === "anchor-changed") {
        const database = new DatabaseSync(f.destinationPath);
        database.prepare("UPDATE openclaw_engine_anchor SET store_id = ?")
          .run("2514f000-4540-4f4e-92a1-831adeac3d5b");
        database.close();
      }
      return mode === "already-configured" || mode === "refused"
        ? { code: 1, stdout: JSON.stringify({ ok: false, error: { type: "cli_error",
          message: mode === "already-configured" ? `agent "${f.agentId}" already exists` : "deletion cleanup is still pending" } }) }
        : { code: 0, stdout: JSON.stringify({ agentId: mode === "wrong-receipt" ? "other-agent" : f.agentId,
          workspace: f.workspace, agentDir: f.agentDir }) };
    });
    const result = reattachUserAgents({ stores: [f], env: { OPENCLAW_STATE_DIR: f.root }, run, log,
      assertHeld: async () => { if (!held) throw new Error("target is no longer held"); } });

    if (mode === "already-configured") {
      await expect(result).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("startup admission remains required"), { durationMs: expect.any(Number) });
    } else {
      await expect(result).rejects.toThrow(mode === "gate-lost" ? "no longer held" : /Native/);
      expect(log).not.toHaveBeenCalled();
    }
    expect(run).toHaveBeenCalledTimes(["wrong-roster", "gate-lost", "invalid-json"].includes(mode) ? 1 : 2);
  },
);

it.each([
  ["successful exit", 0, false, "cli_error", "exact"],
  ["different exit", 2, false, "cli_error", "exact"],
  ["successful envelope", 1, true, "cli_error", "exact"],
  ["different error type", 1, false, "rpc_error", "exact"],
  ["foreign agent", 1, false, "cli_error", "foreign"],
  ["additional refusal", 1, false, "cli_error", "additional"],
  ["obsolete duplicate message", 1, false, "cli_error", "obsolete"],
  ["missing error", 1, false, "cli_error", "missing"],
  ["invalid JSON", 1, false, "cli_error", "invalid"],
] as const)("refuses an unproven Native duplicate receipt: %s", async (_name, code, ok, type, mode) => {
  const f = await fixture();
  const before = await fs.readFile(f.destinationPath);
  const duplicate = `agent "${f.agentId}" already exists`;
  const message = mode === "foreign" ? 'agent "octogee-other-coach" already exists'
    : mode === "additional" ? `${duplicate}; restoration is blocked`
      : mode === "obsolete" ? `Agent "${f.agentId}" already exists.` : duplicate;
  const run = vi.fn(async (args: string[]) => args[1] === "list"
    ? { code: 0, stdout: JSON.stringify([{ id: f.agentId, workspace: f.workspace, agentDir: f.agentDir }]) }
    : { code, stdout: mode === "invalid" ? "not JSON" : JSON.stringify({ ok,
      ...(mode === "missing" ? {} : { error: { type, message } }),
    }) });
  const log = vi.fn();

  await expect(reattachUserAgents({ stores: [f], env: { OPENCLAW_STATE_DIR: f.root }, run, log,
    assertHeld: async () => {},
  })).rejects.toThrow(/Native/);
  expect(run).toHaveBeenCalledTimes(2);
  expect(log).not.toHaveBeenCalled();
  expect(await fs.readFile(f.destinationPath)).toEqual(before);
});

it("refuses a missing carried anchor before invoking Native", async () => {
  const f = await fixture();
  await fs.unlink(f.destinationPath);
  const run = vi.fn();
  await expect(reattachUserAgents({ stores: [f], env: {}, run, log: vi.fn(), assertHeld: async () => {} }))
    .rejects.toThrow("Carried user anchor is missing");
  expect(run).not.toHaveBeenCalled();
  await expect(fs.access(f.destinationPath)).rejects.toThrow();
});

it("restores a carried project absent from the fresh user roster through Native", async () => {
  const defaultAgent = await fixture();
  const agentId = "octogee-chris-proj-demo-coach";
  const agentDir = path.join(defaultAgent.root, "agents", agentId, "agent");
  const project = { agentId, agentDir, destinationPath: path.join(agentDir, "openclaw-agent.sqlite"),
    workspace: path.join(defaultAgent.workspace, "projects", "demo") };
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(defaultAgent.destinationPath, project.destinationPath);
  const database = new DatabaseSync(project.destinationPath);
  database.prepare("UPDATE openclaw_engine_anchor SET store_id = ?").run("2514f000-4540-4f4e-92a1-831adeac3d5b");
  database.close();
  const before = await fs.readFile(project.destinationPath);
  const resolveCarriedWorkspace = vi.fn(async (id: string) => id === agentId ? project.workspace : null);
  vi.useFakeTimers({ toFake: ["Date"] });
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === "list") {
      vi.setSystemTime(Date.now() + 19_000);
      return { code: 0, stdout: JSON.stringify([{ id: defaultAgent.agentId, workspace: defaultAgent.workspace, agentDir: defaultAgent.agentDir }]) };
    }
    vi.setSystemTime(Date.now() + (args[2] === agentId ? 27_000 : 23_000));
    return { code: 0, stdout: JSON.stringify({ agentId: args[2], workspace: args[args.indexOf("--workspace") + 1], agentDir: args[args.indexOf("--agent-dir") + 1] }) };
  });
  const log = vi.fn();

  await expect(reattachUserAgents({ stores: [defaultAgent, project], env: { OPENCLAW_STATE_DIR: defaultAgent.root }, run, log,
    assertHeld: async () => {}, resolveCarriedWorkspace })).resolves.toBeUndefined();

  expect(log.mock.calls).toEqual([
    [expect.stringContaining(`restored carried user agent ${defaultAgent.agentId}`), { durationMs: 23_000 }],
    [expect.stringContaining(`restored carried user agent ${agentId}`), { durationMs: 27_000 }],
  ]);

  expect(resolveCarriedWorkspace).toHaveBeenCalledTimes(3);
  expect(resolveCarriedWorkspace.mock.calls.every(([id]) => id === agentId)).toBe(true);
  expect(run.mock.calls.map(([args]) => args)).toContainEqual([
    "agents", "add", agentId, "--workspace", project.workspace, "--agent-dir", agentDir, "--non-interactive", "--json",
  ]);
  expect(await fs.readFile(project.destinationPath)).toEqual(before);
});

it.each(["noncanonical-agent-dir", "missing-workspace", "duplicate-roster", "roster-changed", "hold-lost"] as const)(
  "keeps an unconfigured carried project closed when %s",
  async mode => {
    const f = await fixture();
    const projectId = "octogee-chris-proj-demo-coach";
    const agentDir = path.join(f.root, "agents", projectId, mode === "noncanonical-agent-dir" ? "other" : "agent");
    const destinationPath = path.join(agentDir, "openclaw-agent.sqlite");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.copyFile(f.destinationPath, destinationPath);
    let held = true;
    const workspace = path.join(f.workspace, "projects", "demo");
    const run = vi.fn(async (args: string[]) => args[1] === "list"
      ? { code: 0, stdout: JSON.stringify(mode === "duplicate-roster" ? [
        { id: projectId, workspace, agentDir }, { id: projectId, workspace, agentDir },
      ] : []) }
      : { code: 1, stdout: JSON.stringify({ ok: false, error: { type: "cli_error", message: `agent "${projectId}" already exists` } }) });
    const before = await fs.readFile(destinationPath);
    await expect(reattachUserAgents({ stores: [{ agentId: projectId, destinationPath }], env: { OPENCLAW_STATE_DIR: f.root }, run,
      log: vi.fn(), assertHeld: async () => { if (!held) throw new Error("target hold lost"); },
      resolveCarriedWorkspace: async () => {
        if (mode === "hold-lost") held = false;
        return mode === "missing-workspace" ? null : workspace;
      },
    })).rejects.toThrow(/Native|hold lost/);
    expect(run).toHaveBeenCalledTimes(mode === "roster-changed" ? 2 : 1);
    expect(await fs.readFile(destinationPath)).toEqual(before);
  },
);

it.each(["earlier-agent-add", "project-add"] as const)("rechecks carried project authority across %s", async mode => {
  const defaultAgent = await fixture();
  const agentId = "octogee-chris-proj-demo-coach";
  const agentDir = path.join(defaultAgent.root, "agents", agentId, "agent");
  const destinationPath = path.join(agentDir, "openclaw-agent.sqlite");
  const workspace = path.join(defaultAgent.workspace, "projects", "demo");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(defaultAgent.destinationPath, destinationPath);
  const before = await fs.readFile(destinationPath);
  let enabled = true;
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify([
      { id: defaultAgent.agentId, workspace: defaultAgent.workspace, agentDir: defaultAgent.agentDir },
    ]) };
    await Promise.resolve();
    if (args[2] === (mode === "earlier-agent-add" ? defaultAgent.agentId : agentId)) enabled = false;
    return { code: 0, stdout: JSON.stringify({ agentId: args[2], workspace: args[args.indexOf("--workspace") + 1],
      agentDir: args[args.indexOf("--agent-dir") + 1] }) };
  });

  await expect(reattachUserAgents({ stores: [defaultAgent, { agentId, destinationPath }], env: { OPENCLAW_STATE_DIR: defaultAgent.root }, run,
    log: vi.fn(), assertHeld: async () => {}, resolveCarriedWorkspace: async () => enabled ? workspace : null,
  })).rejects.toThrow("Carried user workspace authority changed");

  expect(run.mock.calls.some(([args]) => args[1] === "add" && args[2] === agentId)).toBe(mode === "project-add");
  expect(await fs.readFile(destinationPath)).toEqual(before);
});

it.each(["disabled", "workspace-changed"] as const)("rechecks current project authority on a partially registered retry: %s", async mode => {
  const f = await fixture();
  const agentId = "octogee-chris-proj-demo-coach";
  const agentDir = path.join(f.root, "agents", agentId, "agent");
  const destinationPath = path.join(agentDir, "openclaw-agent.sqlite");
  const workspace = path.join(f.workspace, "projects", "demo");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(f.destinationPath, destinationPath);
  const before = await fs.readFile(destinationPath);
  let registered = false, enabled = true, currentWorkspace = workspace;
  const resolveCarriedWorkspace = vi.fn(async () => enabled ? currentWorkspace : null);
  const run = vi.fn(async (args: string[]) => {
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify(registered ? [{ id: agentId, workspace, agentDir }] : []) };
    if (registered) return { code: 1, stdout: JSON.stringify({ ok: false,
      error: { type: "cli_error", message: `agent "${agentId}" already exists` } }) };
    registered = true;
    enabled = false;
    return { code: 0, stdout: JSON.stringify({ agentId, workspace, agentDir }) };
  });
  const input = { stores: [{ agentId, destinationPath }], env: { OPENCLAW_STATE_DIR: f.root }, run,
    log: vi.fn(), assertHeld: async () => {}, resolveCarriedWorkspace };
  await expect(reattachUserAgents(input)).rejects.toThrow("Carried user workspace authority changed");
  expect(registered).toBe(true);
  const checksAfterFirst = resolveCarriedWorkspace.mock.calls.length;
  if (mode === "workspace-changed") { enabled = true; currentWorkspace = path.join(f.workspace, "other"); }

  await expect(reattachUserAgents(input)).rejects.toThrow("Carried user workspace authority changed");

  expect(resolveCarriedWorkspace.mock.calls.length).toBeGreaterThan(checksAfterFirst);
  expect(run.mock.calls.filter(([args]) => args[1] === "add")).toHaveLength(1);
  enabled = true;
  currentWorkspace = workspace;
  await expect(reattachUserAgents(input)).resolves.toBeUndefined();
  expect(run.mock.calls.filter(([args]) => args[1] === "add")).toHaveLength(2);
  expect(await fs.readFile(destinationPath)).toEqual(before);
});

it.each(["missing-authority", "wrong-workspace", "noncanonical-agent-dir"] as const)("refuses a configured carried project before restoring any agent: %s", async mode => {
  const f = await fixture();
  const agentId = "octogee-chris-proj-demo-coach";
  const agentDir = path.join(f.root, "agents", agentId, mode === "noncanonical-agent-dir" ? "other" : "agent");
  const destinationPath = path.join(agentDir, "openclaw-agent.sqlite");
  const workspace = path.join(f.workspace, "projects", "demo");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.copyFile(f.destinationPath, destinationPath);
  const before = await fs.readFile(destinationPath);
  const run = vi.fn(async (args: string[]) => args[1] === "list" ? { code: 0, stdout: JSON.stringify([
    { id: f.agentId, workspace: f.workspace, agentDir: f.agentDir },
    { id: agentId, workspace: mode === "wrong-workspace" ? path.join(f.workspace, "other") : workspace, agentDir },
  ]) } : { code: 1, stdout: JSON.stringify({ ok: false,
    error: { type: "cli_error", message: `agent "${args[2]}" already exists` } }) });
  await expect(reattachUserAgents({ stores: [f, { agentId, destinationPath }], env: { OPENCLAW_STATE_DIR: f.root }, run,
    log: vi.fn(), assertHeld: async () => {},
    resolveCarriedWorkspace: mode === "missing-authority" ? undefined : async () => workspace,
  })).rejects.toThrow(/authority changed|agentDir is not canonical/);
  expect(run).toHaveBeenCalledOnce();
  expect(await fs.readFile(destinationPath)).toEqual(before);
});

it("preserves configured custom-agent restoration without project authority", async () => {
  const f = await fixture();
  const agentId = "custom-retained-agent";
  const resolveCarriedWorkspace = vi.fn(async () => null);
  const run = vi.fn(async (args: string[]) => args[1] === "list"
    ? { code: 0, stdout: JSON.stringify([{ id: agentId, workspace: f.workspace, agentDir: f.agentDir }]) }
    : { code: 1, stdout: JSON.stringify({ ok: false, error: { type: "cli_error", message: `agent "${agentId}" already exists` } }) });
  await expect(reattachUserAgents({ stores: [{ agentId, destinationPath: f.destinationPath }], env: { OPENCLAW_STATE_DIR: f.root },
    run, log: vi.fn(), assertHeld: async () => {}, resolveCarriedWorkspace })).resolves.toBeUndefined();
  expect(resolveCarriedWorkspace).not.toHaveBeenCalled();
});


it("privately retains the failed held-roster command output without restoring agents or exposing output", async () => {
  const f = await fixture(), home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "roster-home-")));
  roots.push(home);
  const before = await fs.readFile(f.destinationPath), log = vi.fn();
  const run = vi.fn(async () => ({ code: 1, stdout: "private stdout synthetic-token", stderr: "private stderr synthetic-secret" }));
  const identity = { migrationId: "surge-synthetic-target", slug: "chris", targetPodUid: "synthetic-target" };
  await expect(reattachUserAgents({ stores: [f], env: { HOME: home, OPENCLAW_STATE_DIR: f.root },
    diagnosticIdentity: identity, run, log, assertHeld: async () => {} })).rejects.toThrow("Native carried-agent roster inspection failed (exit 1)");
  expect(run).toHaveBeenCalledTimes(1);
  const directory = path.join(home, ".octogee-carried-agent-diagnostics", "slot-0");
  expect(await fs.readFile(path.join(directory, "stdout.bin"), "utf8")).toBe("private stdout synthetic-token");
  expect(await fs.readFile(path.join(directory, "stderr.bin"), "utf8")).toBe("private stderr synthetic-secret");
  expect((await fs.stat(path.dirname(directory))).mode & 0o777).toBe(0o700);
  expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  for (const name of ["stdout.bin", "stderr.bin", "metadata.json"]) expect((await fs.stat(path.join(directory, name))).mode & 0o777).toBe(0o600);
  const metadata = JSON.parse(await fs.readFile(path.join(directory, "metadata.json"), "utf8"));
  expect(metadata).toMatchObject({ version: 1, exitCode: 1, stdout: { bytes: 30 }, stderr: { bytes: 31 } });
  expect(JSON.stringify(metadata)).not.toMatch(/synthetic-token|synthetic-secret|surge-synthetic-target|synthetic-target/);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/synthetic-token|synthetic-secret|private stdout|private stderr/);
  expect(await fs.readFile(f.destinationPath)).toEqual(before);
});

async function diagnosticFixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "carried-diagnostics-"))); roots.push(home);
  const state = path.join(home, ".openclaw"); await fs.mkdir(state, { mode: 0o700 });
  const root = path.join(home, CARRIED_AGENT_DIAGNOSTICS_DIRECTORY);
  return { home, state, root, input: { env: { HOME: home, OPENCLAW_STATE_DIR: state },
    identity: { migrationId: "synthetic-migration", slug: "chris", targetPodUid: "synthetic-pod" },
    result: { code: 1, stdout: "original", stderr: "private failure" } } };
}

it("bounds retained failure output to four exclusive slots without overwriting earlier evidence", async () => {
  const f = await diagnosticFixture();
  for (let i = 0; i < 4; i++) await captureCarriedAgentRosterFailure({ ...f.input, result: { ...f.input.result, stdout: String(i) } });
  await expect(captureCarriedAgentRosterFailure(f.input)).rejects.toThrow("full");
  expect(await fs.readFile(path.join(f.root, "slot-0/stdout.bin"), "utf8")).toBe("0");
  expect(await fs.readdir(f.root)).toHaveLength(4);
});

it.each(["root-link", "home-link", "root-mode", "slot-link", "file-link", "hardlink", "unknown", "oversize-input", "oversize-retained", "overlap"])(
  "refuses unsafe private roster evidence storage: %s", async change => {
    const f = await diagnosticFixture();
    if (change === "home-link") {
      const link = f.home + "-link"; roots.push(link); await fs.symlink(f.home, link); f.input.env.HOME = link;
    } else if (change === "overlap") {
      await fs.mkdir(f.root, { mode: 0o700 }); f.input.env.OPENCLAW_STATE_DIR = f.home;
    } else if (change === "oversize-input") {
      f.input.result.stderr = "x".repeat(2 * 1024 * 1024 + 1);
    } else {
      await fs.mkdir(f.root, { mode: 0o700 });
      if (change === "root-link") {
        await fs.rmdir(f.root); await fs.symlink(f.state, f.root);
      } else if (change === "root-mode") await fs.chmod(f.root, 0o755);
      else if (change === "unknown") await fs.writeFile(path.join(f.root, "unknown"), "private", { mode: 0o600 });
      else {
        const slot = path.join(f.root, "slot-0");
        if (change === "slot-link") await fs.symlink(f.state, slot);
        else {
          await fs.mkdir(slot, { mode: 0o700 });
          const file = path.join(slot, "stdout.bin"), outside = path.join(f.home, "private-outside");
          await fs.writeFile(outside, "untouched", { mode: 0o600 });
          if (change === "file-link") await fs.symlink(outside, file);
          else if (change === "hardlink") await fs.link(outside, file);
          else await fs.writeFile(file, "x".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
        }
      }
    }
    await expect(captureCarriedAgentRosterFailure(f.input)).rejects.toThrow(/carried-agent diagnostics/);
    if (await fs.access(path.join(f.home, "private-outside")).then(() => true, () => false)) {
      expect(await fs.readFile(path.join(f.home, "private-outside"), "utf8")).toBe("untouched");
    }
  },
);

it("keeps the import refusal and raw output private when evidence storage is unavailable", async () => {
  const f = await fixture(), log = vi.fn(), run = vi.fn(async () => ({ code: 1, stdout: "private-secret", stderr: "private-token" }));
  await expect(reattachUserAgents({ stores: [f], env: { OPENCLAW_STATE_DIR: f.root }, run, log,
    assertHeld: async () => {} })).rejects.toThrow("Native carried-agent roster inspection failed (exit 1)");
  expect(run).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledExactlyOnceWith("[migration-rsync] carried-agent roster diagnostics unavailable");
});
