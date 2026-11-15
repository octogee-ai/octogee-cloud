import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  ISOLATED_TOOLCHAIN_COMMANDS,
  ISOLATED_TOOLCHAIN_COMMAND_PATHS,
  readToolchainDetail,
  readToolchainStatus,
  type IsolatedToolchainCommand,
  type InstalledIsolatedToolchainLock,
} from "./isolated-toolchain-hydrator.js";

export interface ResolvedToolchainCommand {
  kind: "ready" | "loading" | "unavailable";
  exitCode: number;
  message?: string;
  executable?: string;
}

async function assertActiveToolchainPath(root: string, activePath: string, preinstalledRoot?: string): Promise<void> {
    if (preinstalledRoot) {
      if (activePath !== await fs.realpath(preinstalledRoot)) throw new Error("active object differs from image");
    } else {
      const objectsPath = await fs.realpath(path.join(root, "objects"));
      if (!activePath.startsWith(`${objectsPath}${path.sep}`)) throw new Error("active object escaped root");
    }
}

async function resolveReadyToolchainCommand(
  root: string,
  command: IsolatedToolchainCommand,
  preinstalledRoot?: string,
): Promise<ResolvedToolchainCommand> {
  try {
    const activePath = await fs.realpath(path.join(root, "active"));
    await assertActiveToolchainPath(root, activePath, preinstalledRoot);
    const installed = JSON.parse(
      await fs.readFile(path.join(activePath, ".toolchain-lock.json"), "utf8"),
    ) as InstalledIsolatedToolchainLock;
    const detail = await readToolchainDetail(root);
    if (
      installed.schemaVersion !== 1 || installed.lockSha256 !== detail?.lockSha256 ||
      (preinstalledRoot && (installed.groupsSha256 !== detail?.groupsSha256 || installed.bundleSha256 !== detail?.bundleSha256)) ||
      !ISOLATED_TOOLCHAIN_COMMANDS.every((name) =>
        installed.commands?.[name] === ISOLATED_TOOLCHAIN_COMMAND_PATHS[name])
    ) throw new Error("active lock differs");
    const executable = path.join(activePath, installed.commands[command]);
    const stat = await fs.lstat(executable);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("command is not executable");
    const realExecutable = await fs.realpath(executable);
    if (!realExecutable.startsWith(`${activePath}${path.sep}`)) throw new Error("command escaped object");
    return { kind: "ready", exitCode: 0, executable };
  } catch {
    return {
      kind: "unavailable",
      exitCode: 69,
      message: `${command} is unavailable on this user (invalid-active-toolchain).`,
    };
  }
}

export async function resolveToolchainCommand(input: {
  root: string;
  command: string;
  preinstalledRoot?: string;
}): Promise<ResolvedToolchainCommand> {
  if (!ISOLATED_TOOLCHAIN_COMMANDS.includes(input.command as IsolatedToolchainCommand)) {
    return {
      kind: "unavailable",
      exitCode: 69,
      message: `Optional user tool '${input.command}' is unavailable (unsupported-command).`,
    };
  }
  const command = input.command as IsolatedToolchainCommand;
  const status = await readToolchainStatus(input.root);
  if (!status) {
    return {
      kind: "unavailable",
      exitCode: 69,
      message: `${command} is unavailable on this user (toolchain-not-configured).`,
    };
  }
  if (["pending", "downloading", "verifying"].includes(status.status)) {
    return {
      kind: "loading",
      exitCode: 75,
      message: `${command} is loading; the core Agent and chat remain available. Try again shortly.`,
    };
  }
  if (status.status === "failed") {
    const detail = await readToolchainDetail(input.root);
    return {
      kind: "unavailable",
      exitCode: 69,
      message: `${command} is unavailable on this user (${detail?.reasonCode ?? "hydration-failed"}).`,
    };
  }
  return resolveReadyToolchainCommand(input.root, command, input.preinstalledRoot);
}
