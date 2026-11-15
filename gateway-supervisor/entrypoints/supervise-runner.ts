#!/usr/bin/env tsx

import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

import { superviseRunner, type SupervisedChild } from "../lib/runner-supervisor.js";

// Usage: supervise-runner <name> [--restart-delay-ms=N] <command> [args...]
// Replaces the bare `while true; <cmd> || true; sleep N` loops in
// entrypoint.sh — same respawn behavior, plus a heartbeat the metrics
// exporter reads. The runner's stdout/stderr pass through (stdio: inherit).
export const SUPERVISE_RUNNER_USAGE =
  "usage: supervise-runner <name> [--restart-delay-ms=N] <command> [args...]";

export interface SuperviseRunnerCliArgs {
  name: string;
  command: string;
  args: string[];
  restartDelayMs?: number;
}

export function parseSuperviseRunnerArgs(argv: string[]): SuperviseRunnerCliArgs | null {
  const [name, maybeOption, ...rest] = argv;
  let command = maybeOption;
  let args = rest;
  let restartDelayMs: number | undefined;

  if (maybeOption?.startsWith("--restart-delay-ms=")) {
    restartDelayMs = Number(maybeOption.slice("--restart-delay-ms=".length));
    [command, ...args] = rest;
  }

  if (
    restartDelayMs !== undefined &&
    (!Number.isFinite(restartDelayMs) || restartDelayMs < 0)
  ) {
    return null;
  }

  if (!name || !command) return null;
  return { name, command, args, restartDelayMs };
}

interface ActiveChildRef {
  current: ChildProcess | null;
}

function finishChild(
  activeChild: ActiveChildRef,
  child: ChildProcess,
  resolve: (code: number) => void,
  code: number,
): void {
  if (activeChild.current === child) activeChild.current = null;
  resolve(code);
}

function waitForChildExit(activeChild: ActiveChildRef, child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve) => {
    child.once("exit", (code, signal) =>
      finishChild(activeChild, child, resolve, code ?? (signal ? 1 : 0)),
    );
    // posix_spawnp / ENOENT etc: record failure and retry.
    child.once("error", () => finishChild(activeChild, child, resolve, 1));
  });
}

function spawnSupervisedChild(parsed: SuperviseRunnerCliArgs, activeChild: ActiveChildRef): SupervisedChild {
  const child = spawn(parsed.command, parsed.args, { stdio: "inherit" });
  activeChild.current = child;
  return {
    waitForExit: () => waitForChildExit(activeChild, child),
  };
}

export async function runSuperviseRunner(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseSuperviseRunnerArgs(argv);
  if (!parsed) {
    console.error(SUPERVISE_RUNNER_USAGE);
    process.exit(2);
  }

  let stopping = false;
  let lastExitCode = 0;
  const activeChild: ActiveChildRef = { current: null };
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    activeChild.current?.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("exit", () => activeChild.current?.kill("SIGTERM"));

  await superviseRunner({
    name: parsed.name,
    restartDelayMs: parsed.restartDelayMs,
    shouldStop: () => stopping,
    spawn: () => {
      const child = spawnSupervisedChild(parsed, activeChild);
      return { waitForExit: async () => {
        lastExitCode = await child.waitForExit();
        return lastExitCode;
      } };
    },
  });
  if (stopping) process.exitCode = lastExitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSuperviseRunner();
}
