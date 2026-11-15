import { describe, it, expect } from "vitest";
import {
  apiFleetPaths,
  previewFleetPaths,
  mergeFleetRules,
  parseBaseRoutes,
  rulesEqual,
  syncEdgeIngress,
  type FleetGateway,
  type IngressRule,
  type KubectlSubprocess,
  type KubectlSubprocessResult,
} from "../fleet-ingress";

const API_HOST = "api-test.octogee.com";
const PREVIEW_HOST = "preview-test.octogee.com";
const GATEWAY_EDGE_PORT = 3001;
const PREVIEW_PORT = 9080;
const CONFIGMAP = "octogee-edge-routes";
const INGRESS = "octogee-edge-ingress";
const NS = "octogee-test";
const FIELD_MANAGER = "cowboy-fleet-ingress";

const BASE_RULES: IngressRule[] = [
  {
    host: API_HOST,
    http: {
      paths: [
        { path: "/api/admin/gateways/*", pathType: "ImplementationSpecific", backend: { service: { name: "glm-controller", port: { name: "http" } } } },
        { path: "/g/*", pathType: "ImplementationSpecific", backend: { service: { name: "gateway-router", port: { name: "http" } } } },
        { path: "/api/*", pathType: "ImplementationSpecific", backend: { service: { name: "octogee-api", port: { name: "http" } } } },
        { path: "/health", pathType: "ImplementationSpecific", backend: { service: { name: "gateway-router", port: { name: "http" } } } },
      ],
    },
  },
  {
    host: "git-test.octogee.com",
    http: {
      paths: [
        { path: "/*", pathType: "ImplementationSpecific", backend: { service: { name: "octogee-gitea-http", port: { number: 3000 } } } },
      ],
    },
  },
  {
    host: PREVIEW_HOST,
    http: {
      paths: [
        { path: "/p/*", pathType: "ImplementationSpecific", backend: { service: { name: "octogee-api", port: { name: "http" } } } },
        { path: "/g/*", pathType: "ImplementationSpecific", backend: { service: { name: "gateway-router", port: { name: "http" } } } },
        { path: "/health", pathType: "ImplementationSpecific", backend: { service: { name: "gateway-router", port: { name: "http" } } } },
      ],
    },
  },
];

const GATEWAYS: FleetGateway[] = [{ gatewayId: "default" }, { gatewayId: "walter" }];

function expectPathBefore(paths: string[], earlier: string, later: string): void {
  const earlierIdx = paths.indexOf(earlier);
  const laterIdx = paths.indexOf(later);
  expect(earlierIdx).toBeGreaterThanOrEqual(0);
  expect(laterIdx).toBeGreaterThanOrEqual(0);
  expect(earlierIdx).toBeLessThan(laterIdx);
}

function ok(stdout: string): KubectlSubprocessResult {
  return { stdout, stderr: "", code: 0 };
}
function notFound(): KubectlSubprocessResult {
  return { stdout: "", stderr: "Error from server (NotFound): not found", code: 1 };
}
function configMapStdout(rules: IngressRule[] = BASE_RULES): string {
  return JSON.stringify({ data: { "routes.json": JSON.stringify(rules) } });
}
function ingressStdout(rules: IngressRule[]): string {
  return JSON.stringify({ spec: { rules } });
}

interface FakeKubectl {
  run: KubectlSubprocess;
  calls: { args: string[]; stdin?: string }[];
}
function fakeKubectl(handlers: {
  configmap?: KubectlSubprocessResult;
  ingress?: KubectlSubprocessResult;
  apply?: KubectlSubprocessResult;
}): FakeKubectl {
  const calls: { args: string[]; stdin?: string }[] = [];
  const run: KubectlSubprocess = async (args, opts) => {
    calls.push({ args, stdin: opts?.stdin });
    if (args[0] === "get" && args[1] === "configmap") return handlers.configmap ?? ok(configMapStdout());
    if (args[0] === "get" && args[1] === "ingress") return handlers.ingress ?? ok(ingressStdout(BASE_RULES));
    if (args[0] === "apply") return handlers.apply ?? ok("ingress.networking.k8s.io/octogee-edge-ingress serverside-applied");
    throw new Error(`unexpected kubectl ${args.join(" ")}`);
  };
  return { run, calls };
}

function applyCall(k: FakeKubectl): { args: string[]; stdin?: string } | undefined {
  return k.calls.find((c) => c.args[0] === "apply");
}

function baseSyncOpts(k: FakeKubectl, gateways: FleetGateway[] = GATEWAYS) {
  return {
    runKubectl: k.run,
    ingressName: INGRESS,
    namespace: NS,
    baseRoutesConfigMap: CONFIGMAP,
    apiHost: API_HOST,
    previewHost: PREVIEW_HOST,
    gatewayEdgePort: GATEWAY_EDGE_PORT,
    previewPort: PREVIEW_PORT,
    desiredGateways: gateways,
    fieldManager: FIELD_MANAGER,
    log: () => {},
  };
}

describe("apiFleetPaths", () => {
  it("emits no per-gateway public paths because /g/* is owned by the shared router", () => {
    expect(apiFleetPaths(GATEWAYS, GATEWAY_EDGE_PORT)).toEqual([]);
  });

  it("is empty when there are no gateways", () => {
    expect(apiFleetPaths([], GATEWAY_EDGE_PORT)).toEqual([]);
  });

  it("does not mint new public paths for blue/green or canary instance ids", () => {
    expect(apiFleetPaths([{ gatewayId: "walter-blue" }, { gatewayId: "walter-green" }, { gatewayId: "walter-canary-2026" }], GATEWAY_EDGE_PORT)).toEqual([]);
  });
});

describe("previewFleetPaths", () => {
  it("emits no per-gateway preview paths because /g/* is owned by the shared router", () => {
    expect(previewFleetPaths(GATEWAYS, PREVIEW_PORT)).toEqual([]);
  });
});

describe("mergeFleetRules", () => {
  it("preserves the static /g/* router path before the /api/* catch-all", () => {
    const merged = mergeFleetRules(BASE_RULES, {
      apiHost: API_HOST,
      previewHost: PREVIEW_HOST,
      gateways: GATEWAYS,
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      previewPort: PREVIEW_PORT,
    });
    const apiRule = merged.find((r) => r.host === API_HOST)!;
    expect(apiRule.http.paths.map((p) => p.path)).toEqual([
      "/api/admin/gateways/*",
      "/g/*",
      "/api/*",
      "/health",
    ]);
  });

  it("preserves the static /g/* preview router path and leaves other hosts untouched", () => {
    const merged = mergeFleetRules(BASE_RULES, {
      apiHost: API_HOST,
      previewHost: PREVIEW_HOST,
      gateways: GATEWAYS,
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      previewPort: PREVIEW_PORT,
    });
    expect(merged.find((r) => r.host === PREVIEW_HOST)!.http.paths.map((p) => p.path)).toEqual([
      "/p/*",
      "/g/*",
      "/health",
    ]);
    expect(merged.find((r) => r.host === "git-test.octogee.com")!.http.paths.map((p) => p.path)).toEqual(["/*"]);
  });

  it("keeps the static /g/* router path before the preview /* catch-all when the base preview host has one", () => {
    const baseWithPreviewCatchAll: IngressRule[] = BASE_RULES.map((rule) =>
      rule.host === PREVIEW_HOST
        ? {
            ...rule,
            http: {
              paths: [
                ...rule.http.paths,
                { path: "/*", pathType: "ImplementationSpecific", backend: { service: { name: "preview-catch-all", port: { number: 9080 } } } },
              ],
            },
          }
        : rule,
    );
    const merged = mergeFleetRules(baseWithPreviewCatchAll, {
      apiHost: API_HOST,
      previewHost: PREVIEW_HOST,
      gateways: GATEWAYS,
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      previewPort: PREVIEW_PORT,
    });
    const paths = merged.find((r) => r.host === PREVIEW_HOST)!.http.paths.map((p) => p.path);
    expectPathBefore(paths, "/g/*", "/*");
  });

  it("is a no-op on the rules when there are no gateways (base routes pass through)", () => {
    const merged = mergeFleetRules(BASE_RULES, {
      apiHost: API_HOST,
      previewHost: PREVIEW_HOST,
      gateways: [],
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      previewPort: PREVIEW_PORT,
    });
    expect(rulesEqual(merged, BASE_RULES)).toBe(true);
  });
});

describe("rulesEqual", () => {
  it("is true for structurally identical rules", () => {
    expect(rulesEqual(BASE_RULES, JSON.parse(JSON.stringify(BASE_RULES)))).toBe(true);
  });
  it("is false when a path order differs (GCE URL-map order matters)", () => {
    const reordered = JSON.parse(JSON.stringify(BASE_RULES)) as IngressRule[];
    reordered[0].http.paths.reverse();
    expect(rulesEqual(BASE_RULES, reordered)).toBe(false);
  });
  it("is false when a backend differs", () => {
    const changed = JSON.parse(JSON.stringify(BASE_RULES)) as IngressRule[];
    changed[0].http.paths[1].backend.service.name = "gateway-edge";
    expect(rulesEqual(BASE_RULES, changed)).toBe(false);
  });
});

describe("parseBaseRoutes", () => {
  it("parses a valid routes.json payload", () => {
    expect(parseBaseRoutes(JSON.stringify(BASE_RULES))).toEqual(BASE_RULES);
  });
  it("throws on non-JSON", () => {
    expect(() => parseBaseRoutes("not json")).toThrow(/not parseable/);
  });
  it("throws when the payload is not an array of rules", () => {
    expect(() => parseBaseRoutes(JSON.stringify({ host: "x" }))).toThrow(/array of/);
    expect(() => parseBaseRoutes(JSON.stringify([{ host: "x" }]))).toThrow(/array of/);
  });
});

describe("syncEdgeIngress", () => {
  it("server-side-applies the static base router rules under the fleet controller field manager", async () => {
    const k = fakeKubectl({ ingress: ok(ingressStdout([])) });
    const result = await syncEdgeIngress(baseSyncOpts(k));

    const apply = applyCall(k)!;
    expect(apply.args).toEqual([
      "apply", "--server-side", "--field-manager", FIELD_MANAGER, "--force-conflicts", "-n", NS, "-f", "-",
    ]);
    const manifest = JSON.parse(apply.stdin!) as { spec: { rules: IngressRule[] } };
    const apiRule = manifest.spec.rules.find((r) => r.host === API_HOST)!;
    const apiPaths = apiRule.http.paths.map((p) => p.path);
    expectPathBefore(apiPaths, "/g/*", "/api/*");
    const previewRule = manifest.spec.rules.find((r) => r.host === PREVIEW_HOST)!;
    expect(previewRule.http.paths.find((p) => p.path === "/p/*")?.backend.service.name).toBe("octogee-api");
    expect(previewRule.http.paths.map((p) => p.path)).toContain("/g/*");
    expect(result.changed).toBe(true);
  });

  it("reports changed=false (and still applies) when the live rules already match", async () => {
    const desired = mergeFleetRules(BASE_RULES, {
      apiHost: API_HOST,
      previewHost: PREVIEW_HOST,
      gateways: GATEWAYS,
      gatewayEdgePort: GATEWAY_EDGE_PORT,
      previewPort: PREVIEW_PORT,
    });
    const k = fakeKubectl({ ingress: ok(ingressStdout(desired)) });
    const result = await syncEdgeIngress(baseSyncOpts(k));
    expect(result.changed).toBe(false);
    expect(applyCall(k)).toBeDefined();
  });

  it("defers (no apply) when the base-routes ConfigMap is absent", async () => {
    const k = fakeKubectl({ configmap: notFound() });
    const result = await syncEdgeIngress(baseSyncOpts(k));
    expect(result.changed).toBe(false);
    expect(applyCall(k)).toBeUndefined();
    expect(k.calls.some((c) => c.args[1] === "ingress")).toBe(false);
  });

  it("defers (no apply) when the Ingress object is absent", async () => {
    const k = fakeKubectl({ ingress: notFound() });
    const result = await syncEdgeIngress(baseSyncOpts(k));
    expect(result.changed).toBe(false);
    expect(applyCall(k)).toBeUndefined();
  });

  it("throws when a get fails for a non-NotFound reason", async () => {
    const k = fakeKubectl({ configmap: { stdout: "", stderr: "Forbidden", code: 1 } });
    await expect(syncEdgeIngress(baseSyncOpts(k))).rejects.toThrow(/configmap .* failed/);
  });

  it("throws when the apply fails", async () => {
    const k = fakeKubectl({ apply: { stdout: "", stderr: "conflict", code: 1 } });
    await expect(syncEdgeIngress(baseSyncOpts(k))).rejects.toThrow(/apply ingress .* failed/);
  });
});
