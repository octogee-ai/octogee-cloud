import type { OpenClawCommand, OpenClawCommandResult } from "./openclaw-cli.js";

const HOLDER = /(?:^|: )holder (?:\d+|unknown) at ([^\s,/]+)(?:\/pid-ns (\d+))?, last renewed /u;
const MAX_HOSTNAME_LENGTH = 63;
const REPLICA_SET_POD_SUFFIX = /^[a-z0-9]{1,10}-[a-z0-9]{5}$/u;

export interface GatewayLockHolder {
  host: string;
  pidNamespace: string | null;
}

export interface GatewayLockInspection {
  present: boolean;
  holders: string[];
  confirmation: string;
}

export function parseGatewayLockHolder(holder: string): GatewayLockHolder | null {
  const match = HOLDER.exec(holder);
  return match ? { host: match[1], pidNamespace: match[2] ?? null } : null;
}

function jsonDocument(stdout: string, what: string): Record<string, unknown> {
  const text = stdout.trim();
  const start = text.startsWith("{") ? 0 : text.indexOf("\n{") + 1;
  if (start === 0 && !text.startsWith("{")) throw new Error(`${what} printed no JSON document`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch (error) {
    throw new Error(`${what} printed unreadable JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${what} printed no JSON object`);
  return parsed as Record<string, unknown>;
}

function succeeded(result: OpenClawCommandResult, what: string): string {
  if (result.code === 0) return result.stdout;
  const diagnostic = (result.stderr?.trim() || result.stdout.trim()).slice(0, 2000);
  const detail = diagnostic ? ": " + diagnostic : "";
  throw new Error(`${what} failed (exit ${result.code})${detail}`);
}

export async function inspectGatewayLocks(run: OpenClawCommand, env: NodeJS.ProcessEnv): Promise<GatewayLockInspection> {
  const what = "Gateway lock inspection";
  const document = jsonDocument(succeeded(await run(["gateway", "recover-lock", "--json"], { env }), what), what);
  const { present, holders, confirmation } = document;
  if (typeof present !== "boolean" || !Array.isArray(holders) || !holders.every((holder) => typeof holder === "string") ||
      (present && (typeof confirmation !== "string" || !/^[0-9a-f]{64}$/u.test(confirmation)))) {
    throw new Error(`${what} has an unexpected shape`);
  }
  return { present, holders, confirmation: String(confirmation) };
}

export interface StoppedGatewayLockHolders {
  hostname: string;
  earlierContainerNamespaces: string[];
  singlePodHomeGatewayId: string | null;
}

function isDeploymentPodOf(gatewayId: string, hostname: string): boolean {
  const prefix = `octogee-gateway-${gatewayId}-`;
  return hostname.length <= MAX_HOSTNAME_LENGTH && hostname.startsWith(prefix) &&
    REPLICA_SET_POD_SUFFIX.test(hostname.slice(prefix.length));
}

function holderStopped(holder: GatewayLockHolder | null, stopped: StoppedGatewayLockHolders): boolean {
  if (!holder) return false;
  if (holder.host === stopped.hostname) {
    return holder.pidNamespace !== null && stopped.earlierContainerNamespaces.includes(holder.pidNamespace);
  }
  return stopped.singlePodHomeGatewayId !== null && isDeploymentPodOf(stopped.singlePodHomeGatewayId, holder.host);
}

export async function recoverStoppedGatewayLocks(input: {
  env: NodeJS.ProcessEnv;
  run: OpenClawCommand;
  log: (message: string) => void;
  stopped: StoppedGatewayLockHolders;
}): Promise<"absent" | "held" | "recovered"> {
  const inspection = await inspectGatewayLocks(input.run, input.env);
  if (!inspection.present) return "absent";
  const pod = input.stopped.hostname;
  const unproven = inspection.holders.filter((holder) => !holderStopped(parseGatewayLockHolder(holder), input.stopped));
  if (unproven.length) {
    input.log(`[gateway-locks] pod ${pod}: leaving Gateway lock records to OpenClaw; holder not proven stopped: ${unproven.join(" | ")}`);
    return "held";
  }
  const removed = await recoverInspectedGatewayLocks(input.run, input.env, inspection.confirmation);
  input.log(`[gateway-locks] pod ${pod}: recovered ${removed} Gateway lock record(s) whose holders stopped`);
  return "recovered";
}

export async function recoverInspectedGatewayLocks(run: OpenClawCommand, env: NodeJS.ProcessEnv, confirmation: string): Promise<number> {
  const what = "Gateway lock recovery";
  const outcome = jsonDocument(succeeded(await run(["gateway", "recover-lock", "--confirm", confirmation, "--json"], { env }), what), what);
  if (outcome.recovered !== true) throw new Error(`${what} did not report a recovery`);
  if (typeof outcome.removed !== "number") throw new Error(`${what} did not report how many records it removed`);
  return outcome.removed;
}
