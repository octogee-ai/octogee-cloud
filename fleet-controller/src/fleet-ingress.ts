import { spawn } from "node:child_process";

export interface FleetGateway {
  gatewayId: string;
}

// Ingress spec.rules[].http.paths[] shape. The fleet controller is the sole writer of the
// octogee-edge-ingress .spec.rules (an atomic server-side-apply field): it
// reads the static base routes the umbrella chart publishes via the
// octogee-edge-routes ConfigMap and applies them under its own field manager.
// Helm owns the Ingress object + metadata but never .spec.rules, so the
// umbrella deploy and the fleet controller no longer fight over ownership.
export interface IngressBackendPort {
  number?: number;
  name?: string;
}

export interface IngressPath {
  path: string;
  pathType: string;
  backend: { service: { name: string; port: IngressBackendPort } };
}

export interface IngressRule {
  host: string;
  http: { paths: IngressPath[] };
}

export function apiFleetPaths(
  _gateways: ReadonlyArray<FleetGateway>,
  _gatewayEdgePort: number,
): IngressPath[] {
  return [];
}

export function previewFleetPaths(
  _gateways: ReadonlyArray<FleetGateway>,
  _previewPort: number,
): IngressPath[] {
  return [];
}

export interface MergeFleetRulesOpts {
  apiHost?: string;
  previewHost?: string;
  gateways: ReadonlyArray<FleetGateway>;
  gatewayEdgePort: number;
  previewPort: number;
}

function insertBeforePath(
  basePaths: ReadonlyArray<IngressPath>,
  inserted: ReadonlyArray<IngressPath>,
  targetPath: string,
): IngressPath[] {
  const idx = basePaths.findIndex((p) => p.path === targetPath);
  if (idx === -1) return [...basePaths, ...inserted];
  return [
    ...basePaths.slice(0, idx),
    ...inserted,
    ...basePaths.slice(idx),
  ];
}

export function mergeFleetRules(
  baseRules: ReadonlyArray<IngressRule>,
  opts: MergeFleetRulesOpts,
): IngressRule[] {
  const apiPaths = apiFleetPaths(opts.gateways, opts.gatewayEdgePort);
  const previewPaths = previewFleetPaths(opts.gateways, opts.previewPort);
  return baseRules.map((rule) => {
    if (opts.apiHost && rule.host === opts.apiHost) {
      return {
        host: rule.host,
        http: { paths: insertBeforePath(rule.http.paths, apiPaths, "/api/*") },
      };
    }
    if (opts.previewHost && rule.host === opts.previewHost) {
      return {
        host: rule.host,
        http: { paths: insertBeforePath(rule.http.paths, previewPaths, "/*") },
      };
    }
    return rule;
  });
}

function normalizeRule(rule: IngressRule): unknown {
  return {
    host: rule.host,
    paths: (rule.http?.paths ?? []).map((p) => ({
      path: p.path,
      pathType: p.pathType,
      name: p.backend?.service?.name,
      port: p.backend?.service?.port,
    })),
  };
}

export function rulesEqual(
  a: ReadonlyArray<IngressRule>,
  b: ReadonlyArray<IngressRule>,
): boolean {
  return JSON.stringify(a.map(normalizeRule)) === JSON.stringify(b.map(normalizeRule));
}

function isIngressRule(value: unknown): value is IngressRule {
  if (typeof value !== "object" || value === null) return false;
  const rule = value as { host?: unknown; http?: { paths?: unknown } };
  return typeof rule.host === "string" && Array.isArray(rule.http?.paths);
}

// Parse the base routes the chart published into octogee-edge-routes/data.routes.json.
// Throws on a malformed payload rather than silently applying empty rules — a
// missing/garbled base table would otherwise wipe the platform's static routing.
export function parseBaseRoutes(routesJson: string): IngressRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(routesJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`base routes JSON is not parseable: ${message}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isIngressRule)) {
    throw new Error("base routes JSON is not an array of {host, http.paths} rules");
  }
  return parsed as IngressRule[];
}

interface RawConfigMap {
  data?: { "routes.json"?: unknown };
}

function extractConfigMapRoutes(stdout: string, configMapName: string): string {
  const cm = JSON.parse(stdout) as RawConfigMap;
  const routes = cm?.data?.["routes.json"];
  if (typeof routes !== "string") {
    throw new Error(`ConfigMap ${configMapName} is missing data."routes.json"`);
  }
  return routes;
}

interface RawIngress {
  spec?: { rules?: IngressRule[] };
}

function extractIngressRules(stdout: string): IngressRule[] {
  const ingress = JSON.parse(stdout) as RawIngress;
  return ingress?.spec?.rules ?? [];
}

export interface KubectlSubprocessResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type KubectlSubprocess = (
  args: string[],
  opts?: { stdin?: string; timeoutMs?:number },
) => Promise<KubectlSubprocessResult>;

export interface SyncEdgeIngressResult {
  changed: boolean;
}

const NOT_FOUND_PATTERNS = [
  /Error from server \(NotFound\)/i,
  /\bnot found\b/i,
];

function isNotFound(stderr: string): boolean {
  return NOT_FOUND_PATTERNS.some((p) => p.test(stderr));
}

export interface SyncEdgeIngressOpts {
  runKubectl: KubectlSubprocess;
  ingressName: string;
  namespace: string;
  baseRoutesConfigMap: string;
  apiHost?: string;
  previewHost?: string;
  gatewayEdgePort: number;
  previewPort: number;
  desiredGateways: ReadonlyArray<FleetGateway>;
  fieldManager: string;
  log: (msg: string) => void;
}

// Reconcile the edge ingress's static gateway-router rule set and claim sole
// ownership of .spec.rules via server-side apply. Idempotent: SSA is
// a server-side no-op when nothing changed, so this is safe to run every tick.
// Defers (does not apply) when the base-routes ConfigMap or the Ingress object
// isn't present yet — Helm owns both, and applying a rules-only object before
// the Ingress exists would create a metadata-less one.
export async function syncEdgeIngress(
  opts: SyncEdgeIngressOpts,
): Promise<SyncEdgeIngressResult> {
  const cmResult = await opts.runKubectl([
    "get", "configmap", opts.baseRoutesConfigMap, "-n", opts.namespace, "-o", "json",
  ]);
  if (cmResult.code !== 0) {
    if (isNotFound(cmResult.stderr)) {
      opts.log(
        `[fleet-ingress] base-routes ConfigMap ${opts.baseRoutesConfigMap} not present in ${opts.namespace} — deferring`,
      );
      return { changed: false };
    }
    throw new Error(
      `kubectl get configmap ${opts.baseRoutesConfigMap} failed (code=${cmResult.code}): ${cmResult.stderr.trim() || cmResult.stdout.trim()}`,
    );
  }
  const baseRules = parseBaseRoutes(extractConfigMapRoutes(cmResult.stdout, opts.baseRoutesConfigMap));

  const ingResult = await opts.runKubectl([
    "get", "ingress", opts.ingressName, "-n", opts.namespace, "-o", "json",
  ]);
  if (ingResult.code !== 0) {
    if (isNotFound(ingResult.stderr)) {
      opts.log(
        `[fleet-ingress] ingress ${opts.ingressName} not yet present in ${opts.namespace} — deferring`,
      );
      return { changed: false };
    }
    throw new Error(
      `kubectl get ingress ${opts.ingressName} failed (code=${ingResult.code}): ${ingResult.stderr.trim() || ingResult.stdout.trim()}`,
    );
  }
  const liveRules = extractIngressRules(ingResult.stdout);

  const desired = mergeFleetRules(baseRules, {
    apiHost: opts.apiHost,
    previewHost: opts.previewHost,
    gateways: opts.desiredGateways,
    gatewayEdgePort: opts.gatewayEdgePort,
    previewPort: opts.previewPort,
  });
  const inSync = rulesEqual(liveRules, desired);

  const manifest = {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name: opts.ingressName, namespace: opts.namespace },
    spec: { rules: desired },
  };
  const applyResult = await opts.runKubectl(
    [
      "apply",
      "--server-side",
      "--field-manager",
      opts.fieldManager,
      "--force-conflicts",
      "-n",
      opts.namespace,
      "-f",
      "-",
    ],
    { stdin: JSON.stringify(manifest) },
  );
  if (applyResult.code !== 0) {
    throw new Error(
      `kubectl apply ingress ${opts.ingressName} failed (code=${applyResult.code}): ${applyResult.stderr.trim() || applyResult.stdout.trim()}`,
    );
  }

  if (!inSync) {
    const pathCount = desired.reduce((n, r) => n + r.http.paths.length, 0);
    opts.log(
      `[fleet-ingress] applied ${pathCount} edge route(s) across ${desired.length} host(s) onto ${opts.ingressName} (${opts.namespace})`,
    );
  }
  return { changed: !inSync };
}

const DEFAULT_KUBECTL_BIN = "/usr/local/bin/kubectl";

export function spawnKubectl(
  args: string[],
  opts: { stdin?: string; timeoutMs?:number } = {},
): Promise<KubectlSubprocessResult> {
  const bin = process.env.KUBECTL_BIN ?? DEFAULT_KUBECTL_BIN;
  return new Promise<KubectlSubprocessResult>((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const timer=opts.timeoutMs?setTimeout(()=>{proc.kill("SIGKILL");reject(new Error("kubectl request timed out"));},opts.timeoutMs):undefined;
    let stdout = "";
    let stderr = "";
    proc.stdout!.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", error=>{clearTimeout(timer);reject(error);});
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal !== null) {
        resolve({
          stdout,
          stderr: stderr + `\nkubectl terminated by signal ${signal}`,
          code: 128,
        });
        return;
      }
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    if (opts.stdin) {
      proc.stdin!.on("error",error=>{proc.kill("SIGKILL");clearTimeout(timer);reject(error);});
      proc.stdin!.write(opts.stdin);
      proc.stdin!.end();
    }
  });
}
