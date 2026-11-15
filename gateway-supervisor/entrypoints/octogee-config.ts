import { pathToFileURL } from "node:url";

import { openClawDir } from "../lib/openclaw-config-path.js";
import { adoptSystemConfig } from "../lib/system-config-adoption.js";
import {
  readSystemConfigStatus,
  type SystemConfigObservedStatus,
} from "../lib/system-config-status.js";
import { userClaimSlug } from "@octogee/shared/server/user-claim";

type ParsedArgs =
  | { command: "status" }
  | { command: "adopt"; sourcePath: string; approveHash?: string }
  | { command: "help" };

interface OctogeeConfigDependencies {
  env?: NodeJS.ProcessEnv;
  readStatus?: (openclawDir: string) => SystemConfigObservedStatus;
  adopt?: typeof adoptSystemConfig;
  write?: (line: string) => void;
}

export const OCTOGEE_CONFIG_USAGE = [
  "Usage:",
  "  octogee config status",
  "  octogee config adopt --from PATH [--approve-hash sha256:HASH]",
].join("\n");

function flagValue(args: string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseOctogeeConfigArgs(args: string[]): ParsedArgs {
  if (args.includes("--help") || args.includes("-h")) return { command: "help" };
  if (args[0] !== "config") throw new Error(OCTOGEE_CONFIG_USAGE);
  if (args[1] === "status" && args.length === 2) return { command: "status" };
  if (args[1] !== "adopt") throw new Error(OCTOGEE_CONFIG_USAGE);
  const sourcePath = flagValue(args.slice(2), "--from");
  if (!sourcePath) throw new Error("config adopt requires --from PATH");
  const approveHash = flagValue(args.slice(2), "--approve-hash");
  return {
    command: "adopt",
    sourcePath,
    ...(approveHash ? { approveHash } : {}),
  };
}

function renderStatus(status: SystemConfigObservedStatus): string[] {
  return [
    `state: ${status.state}`,
    `accepted head: ${status.acceptedCommit ?? "unavailable"}`,
    `last sync: ${status.lastSyncedAt ?? "never"}`,
    `last error: ${status.lastErrorCode ?? "none"}`,
  ];
}

function writeStatus(
  dir: string,
  dependencies: OctogeeConfigDependencies,
  write: (line: string) => void,
): void {
  const status = (dependencies.readStatus ?? readSystemConfigStatus)(dir);
  for (const line of renderStatus(status)) write(line);
}

async function adoptConfig(
  parsed: Extract<ParsedArgs, { command: "adopt" }>,
  dir: string,
  env: NodeJS.ProcessEnv,
  dependencies: OctogeeConfigDependencies,
  write: (line: string) => void,
): Promise<void> {
  const slug = userClaimSlug(env);
  if (!slug) throw new Error("a user claim is required for config adoption");
  const result = await (dependencies.adopt ?? adoptSystemConfig)({
    slug,
    sourcePath: parsed.sourcePath,
    openclawDir: dir,
    env,
    ...(parsed.approveHash ? { approveHash: parsed.approveHash } : {}),
  });
  write(`adoption: ${result.applied ? "applied" : "preview"}`);
  write(`approval hash: ${result.approvalHash}`);
  write("changed paths:");
  for (const changedPath of result.changedPaths) write(`- ${changedPath}`);
  if (result.changedPaths.length === 0) write("- none");
  if (result.acceptedCommit) write(`accepted head: ${result.acceptedCommit}`);
}

export async function runOctogeeConfig(
  args: string[],
  dependencies: OctogeeConfigDependencies = {},
): Promise<void> {
  const parsed = parseOctogeeConfigArgs(args);
  const write = dependencies.write ?? console.log;
  if (parsed.command === "help") {
    write(OCTOGEE_CONFIG_USAGE);
    return;
  }
  const env = dependencies.env ?? process.env;
  const dir = openClawDir(env);
  if (parsed.command === "status") {
    writeStatus(dir, dependencies, write);
    return;
  }
  await adoptConfig(parsed, dir, env, dependencies, write);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOctogeeConfig(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
