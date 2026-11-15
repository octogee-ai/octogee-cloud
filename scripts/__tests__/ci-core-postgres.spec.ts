import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: exec }));
import { runCorePostgresChecks } from "../ci/core-postgres.mjs";

let directory: string;
let drift = false;
let integrationFails = false;
let roleValid = true;
let preparationFails = false;
let startedConfiguration = "";
const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];

beforeEach(() => {
  vi.spyOn(process, "getuid").mockReturnValue(501);
  vi.stubEnv("OCTOGEE_TEST_POSTGRES_DSN", "postgresql://ambient-must-not-be-used/example");
  calls.length = 0;
  directory = "";
  drift = integrationFails = false;
  roleValid = true;
  preparationFails = false;
  exec.mockReset().mockImplementation((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command: basename(command), args, env: options.env });
    if (basename(command) === "postgres") return "postgres (PostgreSQL) 16.15\n";
    if (basename(command) === "initdb") {
      const data = args[args.indexOf("-D") + 1];
      directory = dirname(data);
      mkdirSync(data);
      writeFileSync(join(data, "postgresql.conf"), "");
    }
    if (basename(command) === "pg_ctl" && args.includes("start")) startedConfiguration = readFileSync(join(args[args.indexOf("-D") + 1], "postgresql.conf"), "utf8");
    if (basename(command) === "psql" && args.includes("-At")) return roleValid ? "t\n" : "f\n";
    if (basename(command) === "git" && args.includes("diff") && drift) throw new Error("catalog drift");
    if (command === "corepack" && preparationFails) throw new Error("frozen dependency preparation failed");
    if (command === "npm" && args[0] === "test" && integrationFails) throw new Error("integration failed");
    return "";
  });
});
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("required core PostgreSQL CI", () => {
  it("starts and cleans the root-owned fixture when PATH excludes system administration binaries", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    const execute = exec.getMockImplementation()!;
    exec.mockImplementation((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      if (command === "runuser") throw Object.assign(new Error("spawnSync runuser ENOENT"), { code: "ENOENT" });
      return command === "/usr/sbin/runuser" ? execute(args[3], args.slice(4), options) : execute(command, args, options);
    });

    runCorePostgresChecks();

    const launches = exec.mock.calls.filter(([command]) => command.endsWith("runuser"));
    expect(launches).toHaveLength(3);
    for (const [command, args] of launches) {
      expect(command).toBe("/usr/sbin/runuser");
      expect(args.slice(0, 3)).toEqual(["-u", "postgres", "--"]);
    }
    expect(launches.map(([, args]) => basename(args[3]))).toEqual(["initdb", "pg_ctl", "pg_ctl"]);
    expect(launches.at(-1)![1]).toContain("stop");
    expect(calls.some(call => call.command === "npm" && call.args[0] === "test")).toBe(true);
    expect(existsSync(directory)).toBe(false);
  });

  it("uses an isolated non-superuser owner and runs every required PG suite after pinned catalog qualification", () => {
    runCorePostgresChecks();
    const qualifier = calls.findIndex(call => call.args.some(arg => arg.endsWith("qualify-agent-store-routines.mjs")));
    const checkout = calls.findIndex(call => call.command === "git" && call.args.includes("checkout"));
    const dependencies = calls.findIndex(call => call.command === "corepack");
    expect(checkout).toBeGreaterThan(-1);
    const fetched = calls.find(call => call.command === "git" && call.args.includes("fetch"))!;
    expect(calls[checkout].args).toEqual(["-C", join(directory, "native"), "checkout", "--detach", fetched.args.at(-1)]);
    expect(calls[dependencies].args).toEqual(["pnpm", "--filter", ".", "install", "--frozen-lockfile", "--ignore-scripts"]);
    expect(dependencies).toBeGreaterThan(checkout);
    expect(qualifier).toBeGreaterThan(dependencies);
    const diff = calls.findIndex(call => call.command === "git" && call.args.includes("diff"));
    const integration = calls.findIndex(call => call.command === "npm" && call.args[0] === "test");
    expect(qualifier).toBeGreaterThan(-1);
    expect(diff).toBeGreaterThan(qualifier);
    expect(integration).toBeGreaterThan(diff);
    expect(calls[integration].args).toEqual(["test", "--", "src/agent-store-postgres.integration.spec.ts", "src/agent-store-recovery.integration.spec.ts", "src/agent-store-handoff.integration.spec.ts", "src/agent-store-credential-retirement.integration.spec.ts", "src/agent-store-reset.integration.spec.ts", "src/platform-state/postgres/__tests__/migrate.integration.spec.ts", "src/platform-state/postgres/__tests__/neutral-stored-names.integration.spec.ts", "src/platform-state/postgres/__tests__/transaction.integration.spec.ts", "src/platform-state/postgres/__tests__/records.integration.spec.ts", "src/platform-state/postgres/__tests__/journal.integration.spec.ts", "src/platform-state/postgres/__tests__/watch.integration.spec.ts", "src/platform-state/postgres/__tests__/expiry.integration.spec.ts", "src/platform-state/postgres/__tests__/users.integration.spec.ts", "src/platform-state/postgres/__tests__/user-fences.integration.spec.ts", "src/platform-state/postgres/__tests__/user-queries.integration.spec.ts", "src/platform-state/postgres/__tests__/user-subcollections.integration.spec.ts", "src/platform-state/postgres/__tests__/user-accounts.integration.spec.ts", "src/platform-state-user-accounts.integration.spec.ts", "src/platform-user-admin.integration.spec.ts", "src/platform-state/postgres/__tests__/users-watch.integration.spec.ts", "src/platform-state/postgres/__tests__/workspaces.integration.spec.ts", "src/platform-state/postgres/__tests__/secrets.integration.spec.ts", "src/platform-state/postgres/__tests__/runtime-secret-store.integration.spec.ts", "src/model-broker-usage-ledger.integration.spec.ts", "src/platform-state/postgres/__tests__/jobs.integration.spec.ts", "src/platform-state/postgres/__tests__/gateways.integration.spec.ts", "src/platform-state/postgres/__tests__/fleet-registry.integration.spec.ts", "src/platform-state/postgres/__tests__/controller-state.integration.spec.ts", "src/platform-state/postgres/__tests__/migration-tasks.integration.spec.ts", "src/platform-state/postgres/__tests__/config.integration.spec.ts", "src/admin-placement-shared-router.integration.spec.ts", "src/isolated-gateway-lifecycle/owner-fence.integration.spec.ts", "src/admin-placement-isolated-router.integration.spec.ts", "--maxWorkers=1", "--no-file-parallelism"]);
    const dsn = new URL(calls[integration].env!.OCTOGEE_TEST_POSTGRES_DSN!);
    expect(dsn.username).toBe("octogee_ci_admin");
    expect(dsn.searchParams.get("host")).toBe(join(directory, "socket"));
    expect(startedConfiguration).toMatch(/^max_locks_per_transaction = 10$/m);
    expect(calls[integration].env!.PATH!.split(":")[0]).toBe("/usr/lib/postgresql/16/bin");
    expect(calls.find(call => call.command === "psql" && call.args.some(arg => arg.includes("CREATE ROLE")))?.args.join(" ")).toContain("NOSUPERUSER NOCREATEDB CREATEROLE");
    expect(calls.at(-1)?.args).toContain("stop");
    expect(existsSync(directory)).toBe(false);
  });

  it("stops its database and refuses qualification when frozen Native preparation fails", () => {
    preparationFails = true;
    expect(() => runCorePostgresChecks()).toThrow("frozen dependency preparation failed");
    expect(calls.some(call => call.args.some(arg => arg.endsWith("qualify-agent-store-routines.mjs")))).toBe(false);
    expect(calls.some(call => call.command === "npm")).toBe(false);
    expect(calls.at(-1)?.args).toContain("stop");
    expect(existsSync(directory)).toBe(false);
  });

  it("fails a wrong-role preflight before qualification or tests and stops its private server", () => {
    roleValid = false;
    expect(() => runCorePostgresChecks()).toThrow(/non-superuser/);
    expect(calls.some(call => call.command === "npm")).toBe(false);
    expect(calls.some(call => call.args.some(arg => arg.endsWith("qualify-agent-store-routines.mjs")))).toBe(false);
    expect(calls.at(-1)?.args).toContain("stop");
    expect(existsSync(directory)).toBe(false);
  });

  it("preserves catalog drift as failure while still running integration, including its own failure", () => {
    drift = integrationFails = true;
    expect(() => runCorePostgresChecks()).toThrow(/catalog drift[\s\S]*integration failed/);
    expect(calls.some(call => call.command === "npm")).toBe(true);
    expect(calls.some(call => call.command === "git" && call.args.includes("restore"))).toBe(false);
    expect(calls.at(-1)?.args).toContain("stop");
    expect(existsSync(directory)).toBe(false);
  });
});
