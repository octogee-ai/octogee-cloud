import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseAllDocuments } from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CHART_PATH = path.join(REPO_ROOT, "helm/octogee-gateway");

beforeAll(() => {
  if (!fs.existsSync(CHART_PATH)) {
    throw new Error(`octogee-gateway chart not found at ${CHART_PATH}`);
  }
});

const REQUIRED_VALUES: Record<string, string> = {
  gatewayId: "default",
  imageTag: "abc1234",
  "image.repository": "registry.example/octogee-gateway",
  "gatewayEdge.image.repository": "registry.example/gateway-edge",
  "env.mmSiteUrl": "https://mm-test.example.com",
  "env.mmInternalUrl": "http://mattermost.octogee-test.svc.cluster.local:8065",
  "gatewayEdge.publicAppOrigins[0]": "https://app-test.octogee.com",
};

function helmTemplate(setValues: Record<string, string> = {}): string {
  const args = [
    "template",
    "octogee-gw-default",
    CHART_PATH,
    "--namespace=octogee-test",
  ];
  const merged = { ...REQUIRED_VALUES, ...setValues };
  if (setValues.profile === "isolated") {
    merged.gatewayClass = "isolated";
    merged.imageProfile = "isolated";
    merged.runtimeKind = "gce-vm";
  }
  for (const [k, v] of Object.entries(merged)) {
    args.push("--set", `${k}=${v}`);
  }
  const result = spawnSync("helm", args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `helm template failed (status=${result.status}):\n--- stderr ---\n${result.stderr}\n--- stdout ---\n${result.stdout}`,
    );
  }
  return result.stdout;
}

interface Doc {
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: {
    selector?: Record<string, unknown> | { matchLabels?: Record<string, string> };
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: {
        containers?: Array<{ name?: string; env?: Array<{ name: string; value?: string }> }>;
        serviceAccountName?: string;
        volumes?: Array<Record<string, unknown>>;
      };
    };
  };
}

function docs(rendered: string): Doc[] {
  return parseAllDocuments(rendered).map((d) => d.toJS() as Doc);
}

function byKind(rendered: string, kind: string): Doc[] {
  return docs(rendered).filter((d) => d.kind === kind);
}

function gatewayContainerEnv(rendered: string): Array<{ name: string; value?: string }> {
  const dep = byKind(rendered, "Deployment")[0];
  const c = dep?.spec?.template?.spec?.containers?.find((x) => x.name === "gateway");
  if (!c) throw new Error("gateway container not found");
  return c.env ?? [];
}

describe("helm/octogee-gateway/ — revision-aware render (revisionId defaults to gatewayId)", () => {
  it("names Deployment/Services by revisionId when revisionId is unset (== gatewayId)", () => {
    const out = helmTemplate();
    const dep = byKind(out, "Deployment")[0];
    expect(dep?.metadata?.name).toBe("octogee-gateway-default");
    const svcNames = byKind(out, "Service").map((s) => s.metadata?.name);
    expect(svcNames).toContain("octogee-gateway-default");
    expect(svcNames).toContain("gateway-edge-default");
  });

  it("sets GATEWAY_ID (bare gateway) and GATEWAY_REVISION_ID (== gatewayId when unset)", () => {
    const env = gatewayContainerEnv(helmTemplate());
    expect(env.find((e) => e.name === "GATEWAY_ID")?.value).toBe("default");
    expect(env.find((e) => e.name === "GATEWAY_REVISION_ID")?.value).toBe("default");
  });
});

describe("helm/octogee-gateway/ — revision-aware render (revisionId != gatewayId)", () => {
  const REVISION = { gatewayId: "default", revisionId: "default-r7" };

  it("names Deployment by revisionId", () => {
    const dep = byKind(helmTemplate(REVISION), "Deployment")[0];
    expect(dep?.metadata?.name).toBe("octogee-gateway-default-r7");
  });

  it("names both Services by revisionId", () => {
    const svcNames = byKind(helmTemplate(REVISION), "Service").map((s) => s.metadata?.name);
    expect(svcNames).toContain("octogee-gateway-default-r7");
    expect(svcNames).toContain("gateway-edge-default-r7");
  });

  it("selects pods by gateway-instance = revisionId", () => {
    const out = helmTemplate(REVISION);
    const dep = byKind(out, "Deployment")[0];
    const sel = (dep?.spec?.selector as { matchLabels?: Record<string, string> })?.matchLabels;
    expect(sel?.["gateway-instance"]).toBe("default-r7");
    expect(dep?.spec?.template?.metadata?.labels?.["gateway-instance"]).toBe("default-r7");
    for (const svc of byKind(out, "Service")) {
      expect((svc.spec?.selector as Record<string, string>)?.["gateway-instance"]).toBe("default-r7");
    }
  });

  it("keeps GATEWAY_ID bare and GATEWAY_REVISION_ID = revisionId", () => {
    const env = gatewayContainerEnv(helmTemplate(REVISION));
    expect(env.find((e) => e.name === "GATEWAY_ID")?.value).toBe("default");
    expect(env.find((e) => e.name === "GATEWAY_REVISION_ID")?.value).toBe("default-r7");
  });

  it("references the gateway-scoped KSA octogee-gw-{gatewayId} (NOT revision-scoped)", () => {
    const out = helmTemplate(REVISION);
    const dep = byKind(out, "Deployment")[0];
    expect(dep?.spec?.template?.spec?.serviceAccountName).toBe("octogee-gw-default");
  });

  it("references the gateway-scoped auth-token secret gateway-auth-token-{gatewayId}", () => {
    const out = helmTemplate(REVISION);
    expect(out).toContain("gateway-auth-token-default");
    expect(out).not.toContain("gateway-auth-token-default-r7");
  });

  it("names an isolated gateway PodDisruptionBudget by revisionId", () => {
    const pdb = byKind(helmTemplate({ ...REVISION, profile: "isolated" }), "PodDisruptionBudget")[0];
    expect(pdb?.metadata?.name).toBe("octogee-gateway-default-r7");
  });
});

describe("helm/octogee-gateway/ — KSA is out of the chart (the fleet controller owns it)", () => {
  it("never renders a ServiceAccount object (gateway-scoped KSA created by the fleet controller)", () => {
    expect(byKind(helmTemplate(), "ServiceAccount")).toHaveLength(0);
    expect(byKind(helmTemplate({ gatewayId: "default", revisionId: "default-r2" }), "ServiceAccount")).toHaveLength(0);
    expect(byKind(helmTemplate({ profile: "isolated" }), "ServiceAccount")).toHaveLength(0);
  });
});

describe("helm/octogee-gateway/ — roll strategy (GATEWAY-SIMPLE-ROLL-SPEC)", () => {
  interface StrategyDoc extends Doc {
    spec?: Doc["spec"] & {
      strategy?: {
        type?: string;
        rollingUpdate?: { maxSurge?: number | string; maxUnavailable?: number | string };
      };
    };
  }

  function deploymentStrategy(setValues: Record<string, string> = {}) {
    const dep = byKind(helmTemplate(setValues), "Deployment")[0] as StrategyDoc;
    return dep?.spec?.strategy;
  }

  it("defaults to Recreate (no behavior change for the revision-model fleet)", () => {
    expect(deploymentStrategy()).toEqual({ type: "Recreate" });
  });

  it("renders surge replacement when rollStrategy=surge (maxSurge=1, maxUnavailable=0)", () => {
    expect(deploymentStrategy({ rollStrategy: "surge" })).toEqual({
      type: "RollingUpdate",
      rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
    });
  });

  it("rejects unknown rollStrategy values instead of rendering silently", () => {
    expect(() => helmTemplate({ rollStrategy: "bluegreen" })).toThrow(/rollStrategy/);
  });
});

describe("helm/octogee-gateway/ — persistence is deleted (Spot + emptyDir only)", () => {
  it("never renders a PersistentVolumeClaim", () => {
    expect(byKind(helmTemplate(), "PersistentVolumeClaim")).toHaveLength(0);
    expect(byKind(helmTemplate({ "persistence.enabled": "true" }), "PersistentVolumeClaim")).toHaveLength(0);
  });

  it("mounts the data volume as emptyDir on the pod even if a stale persistence value is passed", () => {
    // A stale --set persistence.enabled=true must have NO effect: the chart no
    // longer references .Values.persistence, so data stays emptyDir and no PVC
    // renders. Proves the persistence path is deleted, not merely defaulted off.
    const dep = byKind(helmTemplate({ "persistence.enabled": "true" }), "Deployment")[0];
    const dataVol = dep?.spec?.template?.spec?.volumes?.find((v) => v.name === "data");
    expect(dataVol).toBeDefined();
    expect(dataVol).toHaveProperty("emptyDir");
    expect(dataVol).not.toHaveProperty("persistentVolumeClaim");
  });
});
