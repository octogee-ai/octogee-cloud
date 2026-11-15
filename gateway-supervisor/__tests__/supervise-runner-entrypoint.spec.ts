import { describe, expect, it } from "vitest";
import { parseSuperviseRunnerArgs, SUPERVISE_RUNNER_USAGE } from "../entrypoints/supervise-runner.js";

describe("supervise-runner entrypoint", () => {
  it("parses the default runner command shape", () => {
    expect(parseSuperviseRunnerArgs(["provisioner", "tsx", "entrypoints/provisioner.ts"])).toEqual({
      name: "provisioner",
      command: "tsx",
      args: ["entrypoints/provisioner.ts"],
      restartDelayMs: undefined,
    });
  });

  it("parses the optional restart delay before the command", () => {
    expect(parseSuperviseRunnerArgs(["site-build", "--restart-delay-ms=250", "node", "server.js"])).toEqual({
      name: "site-build",
      command: "node",
      args: ["server.js"],
      restartDelayMs: 250,
    });
  });

  it("rejects missing commands and invalid restart delays", () => {
    expect(parseSuperviseRunnerArgs(["site-build"])).toBeNull();
    expect(parseSuperviseRunnerArgs(["site-build", "--restart-delay-ms=-1", "node"])).toBeNull();
    expect(parseSuperviseRunnerArgs(["site-build", "--restart-delay-ms=nan", "node"])).toBeNull();
    expect(SUPERVISE_RUNNER_USAGE).toContain("supervise-runner");
  });
});
