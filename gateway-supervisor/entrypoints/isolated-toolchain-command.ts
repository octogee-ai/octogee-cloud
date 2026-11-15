import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { isolatedToolchainRoot } from "../lib/user-storage.js";
import { pathToFileURL } from "node:url";

import { resolveUserChromiumExecutable } from "../lib/isolated-toolchain-chromium.js";
import { resolveToolchainCommand } from "../lib/isolated-toolchain-wrapper.js";

function waitForChild(child: ChildProcess, command: string): Promise<number> {
  return new Promise((resolve) => {
    child.once("error", () => {
      console.error(`${command} is unavailable on this user (toolchain-command-start-failed).`);
      resolve(69);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function runIsolatedToolchainCommand(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [command, ...args] = argv;
  const resolved = await resolveToolchainCommand({
    root: isolatedToolchainRoot(env),
    preinstalledRoot: env.OCTOGEE_BUILDER_PREINSTALLED_TOOLCHAIN,
    command: command ?? "",
  });
  if (resolved.kind !== "ready" || !resolved.executable) {
    console.error(resolved.message);
    return resolved.exitCode;
  }
  let executable = resolved.executable;
  if (command === "chromium") {
    try {
      executable = await resolveUserChromiumExecutable(executable);
    } catch {
      console.error("chromium is unavailable on this user (browser-start-failed).");
      return 69;
    }
  } else if (command === "claude") {
    const stamper = env.OCTOGEE_CLAUDE_FIRST_RUN_STAMPER
      ?? "/octogee/gateway/stamp-claude-first-run.mjs";
    spawnSync(process.execPath, [stamper], {
      stdio: "ignore",
      env: { ...env, CLAUDE_BIN: executable },
    });
  }
  const child = spawn(executable, args, { stdio: "inherit", env });
  const forwardTerm = (): void => { child.kill("SIGTERM"); };
  const forwardInt = (): void => { child.kill("SIGINT"); };
  process.once("SIGTERM", forwardTerm);
  process.once("SIGINT", forwardInt);
  const code = await waitForChild(child, command ?? "tool");
  process.removeListener("SIGTERM", forwardTerm);
  process.removeListener("SIGINT", forwardInt);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runIsolatedToolchainCommand();
}
