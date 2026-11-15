import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface ChromiumModule {
  executablePath: () => Promise<string>;
}

function isExportContainer(value: unknown): value is { executablePath?: unknown } {
  return Boolean(value) && (typeof value === "object" || typeof value === "function");
}

export function chromiumModuleFromNamespace(value: unknown): ChromiumModule | null {
  if (!isExportContainer(value)) return null;
  const candidate = value as { default?: unknown; executablePath?: unknown };
  const exported = isExportContainer(candidate.default) ? candidate.default : candidate;
  return typeof exported.executablePath === "function"
    ? exported as ChromiumModule
    : null;
}

export async function resolveUserChromiumExecutable(modulePath: string): Promise<string> {
  const imported = await import(pathToFileURL(modulePath).href) as unknown;
  const chromium = chromiumModuleFromNamespace(imported);
  if (!chromium) throw new Error("invalid Chromium module");
  const executable = await chromium.executablePath();
  if (typeof executable !== "string" || !path.isAbsolute(executable)) {
    throw new Error("invalid Chromium executable path");
  }
  const realExecutable = await fs.realpath(executable);
  const stat = await fs.lstat(realExecutable);
  if (!stat.isFile()) throw new Error("Chromium executable is not a file");
  await fs.access(realExecutable, fsConstants.X_OK);
  return realExecutable;
}
