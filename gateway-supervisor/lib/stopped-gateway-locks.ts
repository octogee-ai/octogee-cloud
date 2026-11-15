import { promises as fs } from "node:fs";
import path from "node:path";

import { dualReadGatewayClassValue } from "@octogee/shared/types/glm";
import { recoverStoppedGatewayLocks } from "./gateway-lock-recovery.js";
import type { OpenClawCommand } from "./openclaw-cli.js";
import { clusterIsolatedGateway, openclawStateRoot } from "./openclaw-state-store.js";

const RECORD_FILE = ".gateway-container-pid-namespaces.json";
const PID_NAMESPACE = /^\d+$/u;

interface GatewayContainerNamespaces {
  host: string;
  pidNamespaces: string[];
}

interface GatewayContainerStart {
  env: NodeJS.ProcessEnv;
  hostname: string;
  pidNamespace: string;
  run: OpenClawCommand;
  log: (message: string) => void;
}

export async function currentGatewayContainerPidNamespace(): Promise<string> {
  const link = await fs.readlink("/proc/self/ns/pid");
  const inode = /^pid:\[(\d+)\]$/u.exec(link)?.[1];
  if (!inode) throw new Error(`/proc/self/ns/pid names no PID namespace inode: ${link}`);
  return inode;
}

function gatewayRunsInPod(env: NodeJS.ProcessEnv): boolean {
  return dualReadGatewayClassValue(env.GATEWAY_CLASS) === "shared" || clusterIsolatedGateway(env);
}

function singlePodHomeGatewayId(env: NodeJS.ProcessEnv): string | null {
  if (!clusterIsolatedGateway(env)) return null;
  const gatewayId = env.GATEWAY_ID?.trim();
  if (!gatewayId) throw new Error("GATEWAY_ID is required for an isolated pod gateway");
  return gatewayId;
}

function recordFile(env: NodeJS.ProcessEnv): string {
  return path.join(openclawStateRoot(env), RECORD_FILE);
}

async function readNamespaces(file: string): Promise<GatewayContainerNamespaces | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const unreadable = (reason: string, cause?: unknown) =>
    new Error(`Gateway container PID namespace record ${file} is unreadable: ${reason}`, cause === undefined ? undefined : { cause });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw unreadable(error instanceof Error ? error.message : String(error), error);
  }
  const { host, pidNamespaces } = (parsed ?? {}) as Partial<GatewayContainerNamespaces>;
  if (typeof host !== "string" || !Array.isArray(pidNamespaces) ||
      !pidNamespaces.every((namespace) => typeof namespace === "string" && PID_NAMESPACE.test(namespace))) {
    throw unreadable("unexpected shape");
  }
  return { host, pidNamespaces };
}

async function writeNamespaces(file: string, record: GatewayContainerNamespaces): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function earlierContainerNamespaces(file: string, start: GatewayContainerStart): Promise<string[]> {
  if (!PID_NAMESPACE.test(start.pidNamespace)) throw new Error(`Gateway container PID namespace ${start.pidNamespace} is not an inode number`);
  const record = await readNamespaces(file);
  return record?.host === start.hostname
    ? record.pidNamespaces.filter((namespace) => namespace !== start.pidNamespace)
    : [];
}

export async function recoverRestartedGatewayContainerLocks(
  start: GatewayContainerStart,
): Promise<"not-a-pod" | "first-start" | "absent" | "held" | "recovered"> {
  if (!gatewayRunsInPod(start.env)) return "not-a-pod";
  const gatewayId = singlePodHomeGatewayId(start.env);
  const file = recordFile(start.env);
  const earlier = await earlierContainerNamespaces(file, start);
  await writeNamespaces(file, { host: start.hostname, pidNamespaces: [...earlier, start.pidNamespace] });
  if (!earlier.length) {
    start.log(`[gateway-locks] pod ${start.hostname}: recorded gateway container PID namespace ${start.pidNamespace}`);
    return "first-start";
  }
  return recoverStoppedGatewayLocks({
    env: start.env,
    run: start.run,
    log: start.log,
    stopped: { hostname: start.hostname, earlierContainerNamespaces: earlier, singlePodHomeGatewayId: gatewayId },
  });
}

export async function recoverIsolatedPodGatewayLocks(
  start: GatewayContainerStart,
): Promise<"not-an-isolated-pod" | "absent" | "held" | "recovered"> {
  const gatewayId = singlePodHomeGatewayId(start.env);
  if (!gatewayId) return "not-an-isolated-pod";
  return recoverStoppedGatewayLocks({
    env: start.env,
    run: start.run,
    log: start.log,
    stopped: {
      hostname: start.hostname,
      earlierContainerNamespaces: await earlierContainerNamespaces(recordFile(start.env), start),
      singlePodHomeGatewayId: gatewayId,
    },
  });
}
