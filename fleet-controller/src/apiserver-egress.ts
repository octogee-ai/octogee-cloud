import type { KubectlSubprocessResult } from "./fleet-ingress.js";

export type KubectlRunner = (args: string[]) => Promise<KubectlSubprocessResult>;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function toCidrs(raw: string, sink: Set<string>): void {
  for (const ip of raw.split(/\s+/).map((s) => s.trim()).filter(Boolean)) {
    if (IPV4.test(ip)) sink.add(`${ip}/32`);
  }
}

export async function resolveApiServerEgressCidrs(
  kubectl: KubectlRunner,
  log: (msg: string) => void,
): Promise<string[]> {
  const cidrs = new Set<string>();
  try {
    const endpoints = await kubectl([
      "get",
      "endpoints",
      "kubernetes",
      "-n",
      "default",
      "-o",
      "jsonpath={.subsets[*].addresses[*].ip}",
    ]);
    if (endpoints.code === 0) toCidrs(endpoints.stdout, cidrs);
    else log(`[apiserver-egress] get endpoints failed (code=${endpoints.code}): ${endpoints.stderr.trim()}`);

    const service = await kubectl([
      "get",
      "service",
      "kubernetes",
      "-n",
      "default",
      "-o",
      "jsonpath={.spec.clusterIP}",
    ]);
    if (service.code === 0) toCidrs(service.stdout, cidrs);
    else log(`[apiserver-egress] get service failed (code=${service.code}): ${service.stderr.trim()}`);
  } catch (err) {
    log(`[apiserver-egress] resolve threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (cidrs.size === 0) {
    log("[apiserver-egress] ⚠ resolved no apiserver CIDRs — gateway API-server egress unchanged until this succeeds");
  }
  return [...cidrs].sort();
}

export function createCachedApiServerEgressResolver(
  kubectl: KubectlRunner,
  log: (msg: string) => void,
  ttlMs = 5 * 60 * 1000,
  now: () => number = () => Date.now(),
): () => Promise<string[]> {
  let cache: { value: string[]; expires: number } | null = null;
  let inFlight: Promise<string[]> | null = null;
  return async () => {
    const t = now();
    if (cache && cache.expires > t) return cache.value;
    if (!inFlight) {
      inFlight = resolveApiServerEgressCidrs(kubectl, log).then(value => {
        if (value.length > 0) cache = { value, expires: t + ttlMs };
        return value;
      }).finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}
