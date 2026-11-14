import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { parseAllDocuments } from "yaml";
import { TIER_PRESETS, SIZING_TIERS } from "../../shared/types/sizing.js";

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
  }
  if (setValues.profile === "isolated" && !setValues.runtimeKind) merged.runtimeKind = "gce-vm";
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

function gatewayContainer(rendered: string): {
  resources: { requests: { cpu?: string; memory?: string }; limits: { cpu?: string; memory?: string } };
  env: Array<{ name: string; value?: string }>;
  podLabels: Record<string, string>;
} {
  const docs = parseAllDocuments(rendered);
  for (const doc of docs) {
    const d = doc.toJS() as
      | { kind?: string; metadata?: { name?: string }; spec?: { template?: { metadata?: { labels?: Record<string, string> }; spec?: { containers?: Array<{ name?: string; env?: Array<{ name: string; value?: string }>; resources?: any }> } } } }
      | undefined;
    if (d?.kind !== "Deployment" || d?.metadata?.name !== "octogee-gateway-default") continue;
    const c = d.spec?.template?.spec?.containers?.find((c) => c.name === "gateway");
    if (!c) throw new Error("gateway container not found");
    return {
      resources: c.resources ?? { requests: {}, limits: {} },
      env: c.env ?? [],
      podLabels: d.spec?.template?.metadata?.labels ?? {},
    };
  }
  throw new Error("Deployment octogee-gateway-default not found");
}

function expectResourcesMatchTier(rendered: string, tier: keyof typeof TIER_PRESETS) {
  const preset = TIER_PRESETS[tier];
  const c = gatewayContainer(rendered);
  expect(c.resources.requests.cpu, `requests.cpu for ${tier}`).toBe(preset.resources.requests.cpu);
  expect(c.resources.requests.memory, `requests.memory for ${tier}`).toBe(preset.resources.requests.memory);
  expect(c.resources.limits.cpu, `limits.cpu for ${tier}`).toBe(preset.resources.limits.cpu);
  expect(c.resources.limits.memory, `limits.memory for ${tier}`).toBe(preset.resources.limits.memory);
}

function expectNodejsMatchTier(rendered: string, tier: keyof typeof TIER_PRESETS) {
  const preset = TIER_PRESETS[tier];
  const c = gatewayContainer(rendered);
  const uv = c.env.find((e) => e.name === "UV_THREADPOOL_SIZE");
  expect(uv?.value, `UV_THREADPOOL_SIZE for ${tier}`).toBe(preset.nodejs.uvThreadpoolSize);
  const nodeOpts = c.env.find((e) => e.name === "NODE_OPTIONS");
  expect(nodeOpts?.value, `NODE_OPTIONS for ${tier}`).toContain(`--max-old-space-size=${preset.nodejs.maxOldSpaceSizeMb}`);
}

describe("helm/octogee-gateway/ — sizing tier explicit override", () => {
  for (const tier of SIZING_TIERS) {
    it(`renders gateway container resources matching the ${tier} preset`, () => {
      const out = helmTemplate({ sizingTier: tier });
      expectResourcesMatchTier(out, tier);
    });

    it(`renders Node.js UV/V8 env tuned for the ${tier} preset`, () => {
      const out = helmTemplate({ sizingTier: tier });
      expectNodejsMatchTier(out, tier);
    });

    it(`labels the pod template with tier=${tier} (Phase D billing hand-off)`, () => {
      const out = helmTemplate({ sizingTier: tier });
      const c = gatewayContainer(out);
      expect(c.podLabels.tier).toBe(tier);
    });
  }

  it("explicit sizingTier beats profile-default", () => {
    // both profiles default to small; force medium to prove explicit wins.
    const out = helmTemplate({ profile: "isolated", sizingTier: "m" });
    expectResourcesMatchTier(out, "m");
  });
});

describe("helm/octogee-gateway/ — sizing tier profile-default fallback", () => {
  it("User profile without sizingTier renders small (class default)", () => {
    const out = helmTemplate({ profile: "isolated" });
    expectResourcesMatchTier(out, "s");
  });

  it("standard profile without sizingTier renders the shared class default", () => {
    const out = helmTemplate({ profile: "standard" });
    expectResourcesMatchTier(out, "m");
  });

  it("empty profile without sizingTier falls back to the shared class default", () => {
    const out = helmTemplate({});
    expectResourcesMatchTier(out, "m");
  });

  it("Builder-profile pod label is the resolved tier, not the bare profile string", () => {
    const out = helmTemplate({ profile: "isolated" });
    const c = gatewayContainer(out);
    expect(c.podLabels.tier).toBe("s");
  });

  it("standard-profile pod label resolves to the shared class default", () => {
    const out = helmTemplate({ profile: "standard" });
    const c = gatewayContainer(out);
    expect(c.podLabels.tier).toBe("m");
  });
});

describe("helm/octogee-gateway/ — replicas knob (paused mode)", () => {
  it("defaults to replicas: 1 when not set (running gateway)", () => {
    const out = helmTemplate();
    const docs = parseAllDocuments(out);
    const deployment = docs
      .map((d) => d.toJS() as { kind?: string; metadata?: { name?: string }; spec?: { replicas?: number } })
      .find((d) => d.kind === "Deployment" && d.metadata?.name === "octogee-gateway-default");
    expect(deployment?.spec?.replicas).toBe(1);
  });

  it("renders replicas: 0 when explicitly set (paused gateway)", () => {
    const out = helmTemplate({ replicas: "0" });
    const docs = parseAllDocuments(out);
    const deployment = docs
      .map((d) => d.toJS() as { kind?: string; metadata?: { name?: string }; spec?: { replicas?: number } })
      .find((d) => d.kind === "Deployment" && d.metadata?.name === "octogee-gateway-default");
    expect(deployment?.spec?.replicas).toBe(0);
  });

  it("rejects replicas > 1 via schema (HPA / multi-replica is out of scope)", () => {
    const args = [
      "template",
      "octogee-gw-default",
      CHART_PATH,
      "--namespace=octogee-test",
    ];
    for (const [k, v] of Object.entries(REQUIRED_VALUES)) args.push("--set", `${k}=${v}`);
    args.push("--set", "replicas=2");
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/replicas|schema/i);
  });
});

describe("helm/octogee-gateway/ — invalid sizingTier rejected by schema", () => {
  it("fails to render when sizingTier is not in the SIZING_TIERS enum", () => {
    const args = [
      "template",
      "octogee-gw-default",
      CHART_PATH,
      "--namespace=octogee-test",
    ];
    for (const [k, v] of Object.entries(REQUIRED_VALUES)) {
      args.push("--set", `${k}=${v}`);
    }
    args.push("--set", "sizingTier=bogus-tier");
    const result = spawnSync("helm", args, { encoding: "utf-8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/schema|sizingTier|enum/i);
  });
});


describe("User ephemeral storage admission", () => {
  it.each(["x11", "omarchy"])("keeps the %s working-set budget intact under Autopilot admission", (computerDesktop) => {
    const deployment = parseAllDocuments(helmTemplate({ profile: "isolated", computerDesktop }))
      .map((document) => document.toJS())
      .find((document) => document?.kind === "Deployment");
    const pod = deployment.spec.template.spec;
    const gateway = pod.containers.find((container: any) => container.name === "gateway");
    const request = gateway.resources.requests["ephemeral-storage"];
    expect(request).toBe(gateway.resources.limits["ephemeral-storage"]);
    expect(request).toBe("9Gi");
    const boundedWorkingSets = pod.volumes.filter((volume: any) => volume.emptyDir?.sizeLimit && !volume.emptyDir.medium);
    const workingSetGiB = boundedWorkingSets.reduce((total: number, volume: any) => total + Number(volume.emptyDir.sizeLimit.replace("Gi", "")), 0);
    expect(Number(request.replace("Gi", ""))).toBeGreaterThanOrEqual(workingSetGiB);
    const sidecars = pod.containers.filter((container: any) => container.name !== "gateway");
    const totalWithAutopilotDefaults = Number(request.replace("Gi", "")) + sidecars.reduce((total: number, container: any) => total + Number((container.resources.requests["ephemeral-storage"] ?? "1Gi").replace("Gi", "")), 0);
    expect(totalWithAutopilotDefaults).toBeLessThanOrEqual(10);
  });
});

describe("User working-set partition", () => {
  it.each(["x11", "omarchy"])("bounds every disk-backed %s emptyDir and spends exactly the gateway's ephemeral limit", (computerDesktop) => {
    const deployment = parseAllDocuments(helmTemplate({ profile: "isolated", computerDesktop }))
      .map((document) => document.toJS())
      .find((document) => document?.kind === "Deployment");
    const pod = deployment.spec.template.spec;
    const diskBacked = pod.volumes.filter((volume: any) => volume.emptyDir && volume.emptyDir.medium !== "Memory");
    expect(pod.volumes.filter((volume: any) => volume.emptyDir?.medium === "Memory" && !volume.emptyDir.sizeLimit)).toEqual([]);
    expect(diskBacked.filter((volume: any) => !volume.emptyDir.sizeLimit).map((volume: any) => volume.name)).toEqual([]);
    expect(pod.volumes.find((volume: any) => volume.name === "data").emptyDir).toEqual({ sizeLimit: "4Gi" });
    const gateway = pod.containers.find((container: any) => container.name === "gateway");
    const boundedGiB = diskBacked.reduce((total: number, volume: any) => total + Number(volume.emptyDir.sizeLimit.replace("Gi", "")), 0);
    expect(`${boundedGiB}Gi`).toBe(gateway.resources.limits["ephemeral-storage"]);
  });

  it("leaves a shared gateway's data volume unbounded", () => {
    const deployment = parseAllDocuments(helmTemplate())
      .map((document) => document.toJS())
      .find((document) => document?.kind === "Deployment");
    expect(deployment.spec.template.spec.volumes.find((volume: any) => volume.name === "data")).toEqual({ name: "data", emptyDir: {} });
  });
});
