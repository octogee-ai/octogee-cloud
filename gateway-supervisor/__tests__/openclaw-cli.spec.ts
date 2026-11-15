import { describe, expect, it, vi } from "vitest";
import { execFile, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { inspect } from "node:util";
import { OpenClawCommandError, runOpenClaw } from "../lib/openclaw-cli.js";

vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const fixture = `
    const mode = process.argv[1];
    if (mode === "eof" || mode === "configuredTimeout") {
      process.stdin.resume();
      process.stdin.on("end", () => process.stdout.write("received EOF"));
    } else if (mode === "exit141") {
      process.stdout.write("ordinary output");
      process.stderr.write("ordinary error");
      process.exitCode = 141;
    } else if (mode === "timeout141") {
      process.stdout.write("private-output-é");
      process.stderr.write("private-error-é");
      process.on("SIGTERM", () => process.exit(141));
      setInterval(() => {}, 1000);
    } else if (mode === "signalBytes") {
      process.stdout.write(Buffer.from([255, 0, 195, 40]), () =>
        process.stderr.write(Buffer.from([254, 0]), () => process.kill(process.pid, "SIGTERM")));
    } else if (mode === "signal") {
      process.kill(process.pid, "SIGTERM");
    } else if (mode === "closedStdinSuccess" || mode === "closedStdinFailure") {
      require("node:fs").closeSync(0);
      process.stdout.write("closed stdin successfully");
    }
  `;
  return {
    ...real,
    execFile: vi.fn((file: string, args: string[], options: ExecFileOptions,
      callback: (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => void) => {
      expect(file).toBe("/usr/local/bin/openclaw");
      expect(options.timeout).toBe(args[0] === "configuredTimeout" ? 300_000 : 180_000);
      expect(options).not.toHaveProperty("timeoutMs");
      const child = real.execFile(process.execPath, ["-e", fixture, args[0]], { ...options, timeout: 2500, encoding: "buffer" }, (error, stdout, stderr) => {
        if (args[0] === "closedStdinSuccess" || args[0] === "closedStdinFailure") {
          child.stdin?.emit("error", Object.assign(new Error("private pipe detail"), { code: args[0] === "closedStdinSuccess" ? "EPIPE" : "ECONNRESET" }));
        }
        callback(error, stdout, stderr);
      });
      return child;
    }),
  };
});

describe("noninteractive OpenClaw command", () => {
  it("delivers EOF to a real child that cannot complete while stdin stays open", async () => {
    await expect(runOpenClaw(["eof"], { env: process.env })).resolves.toEqual({ code: 0, stdout: "received EOF", stderr: "" });
  });

  it("passes an explicit bounded five-minute allowance without leaking its internal option", async () => {
    await expect(runOpenClaw(["configuredTimeout"], { env: process.env, timeoutMs: 300_000 })).resolves.toEqual({ code: 0, stdout: "received EOF", stderr: "" });
  });

  it.each([0, -1, 300_001, Infinity, NaN, 1.5])("refuses invalid timeout %s before child spawn", async timeoutMs => {
    const calls = vi.mocked(execFile).mock.calls.length;
    await expect(runOpenClaw(["eof"], { env: process.env, timeoutMs })).rejects.toThrow("timeout must be a positive safe integer no greater than 300000ms");
    expect(vi.mocked(execFile).mock.calls).toHaveLength(calls);
  });

  it("preserves an ordinary numeric exit141 and its output", async () => {
    await expect(runOpenClaw(["exit141"], { env: process.env })).resolves.toEqual({ code: 141, stdout: "ordinary output", stderr: "ordinary error" });
  });

  it("preserves real success when a fast child closes stdin and its no-input pipe reports EPIPE", async () => {
    await expect(runOpenClaw(["closedStdinSuccess"], { env: process.env })).resolves.toEqual({ code: 0, stdout: "closed stdin successfully", stderr: "" });
  });

  it("still refuses a non-EPIPE stdin error after a successful child exit", async () => {
    await expect(runOpenClaw(["closedStdinFailure"], { env: process.env })).rejects.toThrow("stdinCode=ECONNRESET");
  });

  it("distinguishes timeout termination even when the SIGTERM handler exits141", async () => {
    const error = await runOpenClaw(["timeout141"], { env: process.env }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("code=141");
    expect(message).toContain("killed=true");
    expect(message).toContain("signal=none");
    expect(message).toMatch(/elapsedMs=\d+/);
    expect(Number(message.match(/elapsedMs=(\d+)/)?.[1])).toBeGreaterThanOrEqual(2400);
    expect(message).toContain(`stdoutBytes=${Buffer.byteLength("private-output-é")}`);
    expect(message).toContain(`stderrBytes=${Buffer.byteLength("private-error-é")}`);
    expect(message).not.toContain("private-output");
    expect(message).not.toContain("private-error");
    const failure = error as OpenClawCommandError;
    expect(typeof failure.readOutput).toBe("function");
    expect(failure.readOutput()).toEqual({ stdout: Buffer.from("private-output-é"), stderr: Buffer.from("private-error-é") });
    expect(inspect(error, { showHidden: true })).not.toContain("private-output");
    expect(JSON.stringify(error)).not.toContain("private-output");
    expect(JSON.stringify(error)).not.toContain("private-error");
  });

  it("retains exact non-UTF8 terminal bytes privately", async () => {
    const error = await runOpenClaw(["signalBytes"], { env: process.env }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(OpenClawCommandError);
    expect((error as OpenClawCommandError).readOutput()).toEqual({ stdout: Buffer.from([255, 0, 195, 40]), stderr: Buffer.from([254, 0]) });
  });

  it("reports actual signal termination separately from a timeout kill", async () => {
    await expect(runOpenClaw(["signal"], { env: process.env })).rejects.toThrow(/code=none, killed=false, signal=SIGTERM, elapsedMs=\d+/);
  });
});
