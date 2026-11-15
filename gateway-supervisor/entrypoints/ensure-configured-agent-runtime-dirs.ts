import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertConfiguredUserPortableStatePlanOnDisk,
  configuredUserPortableStatePlanFromConfig,
  isPortableConfiguredAgentId,
  type OpenclawConfig,
} from "@octogee/core/local-default-agent-wired";
import { agentIdsFromConfig } from "../lib/byosub-restore.js";

export interface EnsureConfiguredAgentRuntimeDirsOptions {
  configPath: string;
  agentsDir: string;
  stateDir?: string;
}

export function configuredSafeAgentIds(config: unknown): string[] {
  return [...new Set(agentIdsFromConfig(config).filter(isPortableConfiguredAgentId))]
    .sort((left, right) => left.localeCompare(right));
}

export function ensureConfiguredAgentRuntimeDirs(
  options: EnsureConfiguredAgentRuntimeDirsOptions,
): string[] {
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(options.configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `[agent-runtime] ${options.configPath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stateDir = options.stateDir ?? path.dirname(path.resolve(options.agentsDir));
  const plan = configuredUserPortableStatePlanFromConfig(config as OpenclawConfig, stateDir);
  assertConfiguredUserPortableStatePlanOnDisk(stateDir, plan);
  for (const relativeAgentDir of plan.agentDirs) {
    const agentDir = path.join(stateDir, ...relativeAgentDir.split("/"));
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(agentDir, 0o700);
  }
  assertConfiguredUserPortableStatePlanOnDisk(stateDir, plan);
  return plan.agentIds;
}

function main(): void {
  const openclawDir = process.env.OPENCLAW_DIR || "/home/node/.openclaw";
  const configPath =
    process.env.OPENCLAW_CONFIG_PATH || path.join(openclawDir, "openclaw.json");
  const agentsDir =
    process.env.OPENCLAW_AGENTS_DIR || path.join(openclawDir, "agents");
  const stateDir = process.env.OPENCLAW_STATE_DIR || openclawDir;
  const agentIds = ensureConfiguredAgentRuntimeDirs({ configPath, agentsDir, stateDir });
  process.stderr.write(
    `[agent-runtime] ensured ${agentIds.length} configured agent runtime dir(s)\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main();
}
