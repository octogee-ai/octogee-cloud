import { describe, expect, it, vi } from "vitest";
import { parseWithPlatformStateArgs, withPlatformState } from "../ops/with-platform-state.mjs";

const POSTGRES = {
  host: "10.0.0.5",
  port: 5432,
  image: "fleet-controller@sha256:abc",
  database: "platform",
  user: "runtime",
  password: "runtime-password",
  sslmode: "require",
  tlsServerIdentity: "",
  caCertificate: "",
};

describe("parseWithPlatformStateArgs", () => {
  it("takes the environment before -- and the command after it", () => {
    expect(parseWithPlatformStateArgs(["--env=test", "--", "tsx", "ops/seed-orchestrator-config.ts", "--env=test"])).toEqual({
      kind: "ok",
      environment: "test",
      command: ["tsx", "ops/seed-orchestrator-config.ts", "--env=test"],
    });
  });

  it.each([
    [["--", "tsx", "x.ts"], /--env must be test or prod/],
    [["--env=staging", "--", "tsx", "x.ts"], /--env must be test or prod/],
    [["--env=test"], /a command to run is required after --/],
    [["--env=test", "--"], /a command to run is required after --/],
    [["--env=test", "--force", "--", "tsx", "x.ts"], /Unknown arg: --force/],
  ])("refuses %j", (argv, message) => {
    expect(parseWithPlatformStateArgs(argv)).toEqual({ kind: "error", message: expect.stringMatching(message) });
  });
});

describe("withPlatformState", () => {
  it("runs the command against the deployed PostgreSQL store through a tunnel it closes afterwards", async () => {
    const close = vi.fn(async () => {});
    const deps = { inspect: vi.fn(async () => POSTGRES), tunnel: vi.fn(async () => ({ port: 61234, close })) };
    const run = vi.fn(async () => 0);

    const code = await withPlatformState({
      environment: "test",
      command: ["tsx", "ops/sweep-orphaned-vms.ts"],
      deps,
      run,
      baseEnv: { PATH: "/usr/bin" },
    });

    expect(code).toBe(0);
    expect(run).toHaveBeenCalledWith(["tsx", "ops/sweep-orphaned-vms.ts"], expect.objectContaining({
      PATH: "/usr/bin",
      PLATFORM_DB_HOST: "127.0.0.1",
      PLATFORM_DB_PORT: "61234",
      PLATFORM_DB_USER: "runtime",
    }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("passes the command's failing exit code through and still closes the tunnel", async () => {
    const close = vi.fn(async () => {});
    const deps = { inspect: vi.fn(async () => POSTGRES), tunnel: vi.fn(async () => ({ port: 61234, close })) };

    const code = await withPlatformState({ environment: "prod", command: ["tsx", "x.ts"], deps, run: async () => 3, baseEnv: {} });

    expect(code).toBe(3);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the tunnel when the command cannot start", async () => {
    const close = vi.fn(async () => {});
    const deps = { inspect: vi.fn(async () => POSTGRES), tunnel: vi.fn(async () => ({ port: 61234, close })) };
    const failure = new Error("spawn tsx ENOENT");

    await expect(withPlatformState({
      environment: "test", command: ["tsx", "x.ts"], deps, run: async () => { throw failure; }, baseEnv: {},
    })).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
