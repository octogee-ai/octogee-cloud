import fs from "node:fs/promises";
import path from "node:path";

export const PLATFORM_OPENCLAW_BINARY = "/usr/local/bin/openclaw";

export async function readInstalledOpenClawBuild(binary: string): Promise<string> {
  const packageRoot = path.dirname(await fs.realpath(binary));
  const buildInfo: unknown = JSON.parse(await fs.readFile(path.join(packageRoot, "dist", "build-info.json"), "utf8"));
  const commit = buildInfo && typeof buildInfo === "object" ? (buildInfo as { commit?: unknown }).commit : undefined;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`installed OpenClaw at ${packageRoot} has no source commit in dist/build-info.json`);
  }
  return commit;
}
