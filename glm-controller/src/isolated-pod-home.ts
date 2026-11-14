import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import type { SizingTier } from "@octogee/shared/types/sizing";

import type { KubectlSubprocess } from "./fleet-ingress.js";
import { findGatewayVmPolicy } from "./vm-gateway-runtime.js";

export const ISOLATED_POD_HOME_PENDING_LIMIT_MS = 5 * 60_000;
export const ISOLATED_POD_BLOCKER_OBSERVE_MS = 60_000;

const NO_AMD64_NODE = "the isolated gateway image is linux/amd64 only, and this cluster has no amd64 node";
const SINGLE_POD_ACCESS_MODE = "ReadWriteOncePod";

export function isolatedPodHomeClaimName(gatewayId: string): string {
  return `octogee-gateway-${gatewayId}-data`;
}

export async function isolatedPodHomeSizeGiB(
  store: Pick<PlatformStateRepositories, "config">,
  gateway: { gatewayId: string; sizingTier: SizingTier | null },
): Promise<number> {
  const tier = gateway.sizingTier ?? "s";
  const computer = await findGatewayVmPolicy(store, tier);
  if (computer === null) {
    throw new Error(`isolated gateway ${gateway.gatewayId} runs as a pod, and no isolated sizing profile at tier ${tier} describes one`);
  }
  if (computer.runtime !== "cluster") {
    throw new Error(
      `isolated gateway ${gateway.gatewayId} runs as a pod, but the isolated sizing profile at tier ${tier} describes a ${computer.runtime} computer`,
    );
  }
  return computer.homeSizeGiB;
}

interface KubectlDeps {
  runKubectl: KubectlSubprocess;
  namespace: string;
}

interface KubeEvent {
  type?: string;
  reason?: string;
  message?: string;
  lastTimestamp?: string | null;
  eventTime?: string | null;
  metadata?: { creationTimestamp?: string };
}

interface KubeCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

function kubectlFailure(args: readonly string[], result: { code: number; stderr: string; stdout: string }): Error {
  return new Error(`kubectl ${args.join(" ")} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
}

async function kubectlJson<T>(deps: KubectlDeps, args: string[]): Promise<T | null> {
  const result = await deps.runKubectl([...args, "-o", "json"]);
  if (result.code === 0) return JSON.parse(result.stdout) as T;
  if (/\(NotFound\)/u.test(result.stderr)) return null;
  throw kubectlFailure(args, result);
}

async function kubectlItems<T>(deps: KubectlDeps, args: string[]): Promise<T[]> {
  const list = await kubectlJson<{ items?: T[] }>(deps, args);
  if (list === null) throw new Error(`kubectl ${args.join(" ")} found no list`);
  return list.items ?? [];
}

export async function ensureIsolatedPodHome(
  deps: KubectlDeps & { log: (message: string) => void },
  input: { gatewayId: string; homeSizeGiB: number; served: boolean },
): Promise<void> {
  const name = isolatedPodHomeClaimName(input.gatewayId);
  const existing = await kubectlJson<{ spec?: { accessModes?: string[] } }>(deps, ["get", "pvc", name, "-n", deps.namespace]);
  if (existing !== null) {
    const accessModes = existing.spec?.accessModes ?? [];
    if (accessModes.length !== 1 || accessModes[0] !== SINGLE_POD_ACCESS_MODE) {
      throw new Error(
        `isolated gateway ${input.gatewayId} home claim ${name} is not ${SINGLE_POD_ACCESS_MODE} ` +
          `(${accessModes.join(", ") || "no access mode"}); an isolated pod's lock recovery needs a home only one pod can mount`,
      );
    }
    return;
  }
  if (input.served) {
    throw new Error(
      `isolated gateway ${input.gatewayId} has served from home claim ${name}, which is missing; ` +
        "creating an empty one would replace the user's files",
    );
  }
  const manifest = JSON.stringify({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name,
      namespace: deps.namespace,
      labels: { "app.kubernetes.io/managed-by": "glm-controller", "octogee.ai/gateway-id": input.gatewayId },
    },
    spec: { accessModes: [SINGLE_POD_ACCESS_MODE], resources: { requests: { storage: `${input.homeSizeGiB}Gi` } } },
  });
  const args = ["create", "-n", deps.namespace, "-f", "-"];
  const result = await deps.runKubectl(args, { stdin: manifest });
  if (result.code !== 0) throw kubectlFailure(args, result);
  deps.log(`[isolated-pod] ${input.gatewayId}: created home claim ${name} (${input.homeSizeGiB}Gi)`);
}

function eventTime(event: KubeEvent): number {
  return Date.parse(event.lastTimestamp ?? event.eventTime ?? event.metadata?.creationTimestamp ?? "") || 0;
}

function newest(events: readonly KubeEvent[]): KubeEvent | undefined {
  return [...events].sort((a, b) => eventTime(b) - eventTime(a))[0];
}

async function unschedulableReason(deps: KubectlDeps, gatewayId: string): Promise<string | null> {
  const pods = await kubectlItems<{ status?: { conditions?: KubeCondition[] } }>(
    deps, ["get", "pods", "-n", deps.namespace, "-l", `gateway-instance=${gatewayId}`],
  );
  const condition = pods
    .flatMap((pod) => pod.status?.conditions ?? [])
    .find((entry) => entry.type === "PodScheduled" && entry.status === "False" && entry.reason === "Unschedulable");
  if (!condition) return null;
  const amd64Nodes = await kubectlItems(deps, ["get", "nodes", "-l", "kubernetes.io/arch=amd64"]);
  return amd64Nodes.length === 0 ? NO_AMD64_NODE : `the gateway pod cannot be scheduled: ${condition.message ?? condition.reason}`;
}

export async function readIsolatedPodBlocker(
  deps: KubectlDeps,
  input: { gatewayId: string; now: number },
): Promise<string | null> {
  const name = isolatedPodHomeClaimName(input.gatewayId);
  const claim = await kubectlJson<{ metadata?: { creationTimestamp?: string }; status?: { phase?: string } }>(
    deps, ["get", "pvc", name, "-n", deps.namespace],
  );
  if (claim === null) return `home claim ${name} is missing`;
  const pending = claim.status?.phase === "Pending";
  const claimEvents = pending
    ? await kubectlItems<KubeEvent>(deps, [
      "get", "events", "-n", deps.namespace,
      "--field-selector", `involvedObject.kind=PersistentVolumeClaim,involvedObject.name=${name}`,
    ])
    : [];
  const warning = newest(claimEvents.filter((event) => event.type === "Warning"));
  if (warning) return `home claim ${name} cannot bind: ${warning.reason}: ${warning.message}`;
  const unschedulable = await unschedulableReason(deps, input.gatewayId);
  if (unschedulable) return unschedulable;
  const pendingMs = input.now - (Date.parse(claim.metadata?.creationTimestamp ?? "") || input.now);
  if (!pending || pendingMs < ISOLATED_POD_HOME_PENDING_LIMIT_MS) return null;
  const pendingFor = `home claim ${name} has been pending for ${Math.floor(pendingMs / 60_000)} minutes`;
  const last = newest(claimEvents);
  return last ? `${pendingFor}: ${last.message}` : pendingFor;
}

export interface IsolatedPodBlockerObserverDeps {
  store: Pick<PlatformStateRepositories, "gateways" | "fleetRegistry">;
  readBlocker: (gatewayId: string) => Promise<string | null>;
  now: () => number;
  log: (message: string) => void;
}

function oneLine(blocker: string | null): string | null {
  return blocker === null ? null : blocker.replace(/\s+/gu, " ").trim();
}

export async function observeIsolatedPodBlockers(deps: IsolatedPodBlockerObserverDeps): Promise<void> {
  const runtimes = await deps.store.fleetRegistry.list({ runtime: "cluster" });
  const roots = await deps.store.gateways.roots.getMany(runtimes.map((runtime) => runtime.gatewayId));
  for (const runtime of runtimes) {
    const root = roots.get(runtime.gatewayId);
    if (root?.gatewayClass !== "isolated" || root.desiredStatus !== "running") continue;
    let blocker: string | null;
    try {
      blocker = oneLine(await deps.readBlocker(runtime.gatewayId));
    } catch (error) {
      deps.log(`[isolated-pod] ⚠ ${runtime.gatewayId}: blocker unreadable: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (blocker === (runtime.lastError?.message ?? null)) continue;
    await deps.store.fleetRegistry.patch(runtime.gatewayId, {
      lastError: blocker === null ? { message: null, at: null } : { message: blocker, at: deps.now() },
    });
    deps.log(blocker === null
      ? `[isolated-pod] ${runtime.gatewayId} is no longer blocked`
      : `[isolated-pod] ${runtime.gatewayId} is not running: ${blocker}`);
  }
}

export function startIsolatedPodBlockerObserver(deps: IsolatedPodBlockerObserverDeps & { intervalMs: number }): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    observeIsolatedPodBlockers(deps)
      .catch((error: unknown) => {
        deps.log(`[isolated-pod] ⚠ blocker pass failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, deps.intervalMs);
  return () => clearInterval(timer);
}
