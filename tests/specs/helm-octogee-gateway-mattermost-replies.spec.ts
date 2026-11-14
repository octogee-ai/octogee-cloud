import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";

const CHART_PATH = path.resolve(__dirname, "../../helm/octogee-gateway");

const REQUIRED_VALUES: Record<string, string> = {
  gatewayId: "replies",
  imageTag: "abc1234",
  "image.repository": "registry.example/octogee-gateway",
  "gatewayEdge.image.repository": "registry.example/gateway-edge",
  "env.mmSiteUrl": "https://mm.example.com",
  "env.mmInternalUrl": "http://mattermost.octogee.svc.cluster.local:8065",
  "gatewayEdge.publicAppOrigins[0]": "https://app.example.com",
};

const ISOLATED_VALUES: Record<string, string> = {
  gatewayClass: "isolated",
  imageProfile: "isolated",
  profile: "isolated",
  sizingTier: "s",
  runtimeKind: "gce-vm",
};

interface Container {
  name: string;
  env?: Array<{ name: string; value?: string }>;
}

function helmTemplate(values: Record<string, string>) {
  const args = ["template", "octogee-gw-replies", CHART_PATH, "--namespace=octogee"];
  for (const [key, value] of Object.entries({ ...REQUIRED_VALUES, ...values })) args.push("--set", `${key}=${value}`);
  return spawnSync("helm", args, { encoding: "utf-8" });
}

function gatewayEnv(values: Record<string, string>): Record<string, string | undefined> {
  const result = helmTemplate(values);
  if (result.status !== 0) throw new Error(`helm template failed:\n${result.stderr}`);
  for (const doc of parseAllDocuments(result.stdout)) {
    const value = doc.toJS() as { kind?: string; spec?: { template?: { spec: { containers: Container[] } } } } | null;
    const gateway = value?.kind === "Deployment" ? value.spec?.template?.spec.containers.find(({ name }) => name === "gateway") : undefined;
    if (gateway) return Object.fromEntries((gateway.env ?? []).map(({ name, value }) => [name, value]));
  }
  throw new Error("no gateway container rendered");
}

describe("helm/octogee-gateway/ — Mattermost reply and streaming modes", () => {
  it.each([
    ["shared", {}],
    ["isolated", ISOLATED_VALUES],
  ])("replies in the channel with a live preview by default on a %s gateway", (_label, values) => {
    expect(gatewayEnv(values)).toMatchObject({ MM_REPLY_TO_MODE: "off", MM_STREAMING_MODE: "partial" });
  });

  it("passes an installation's own modes to the gateway", () => {
    expect(gatewayEnv({ "env.mmReplyToMode": "all", "env.mmStreamingMode": "progress" }))
      .toMatchObject({ MM_REPLY_TO_MODE: "all", MM_STREAMING_MODE: "progress" });
  });

  it.each([
    ["env.mmReplyToMode", "thread"],
    ["env.mmStreamingMode", "live"],
  ])("refuses %s=%s, which the Mattermost channel does not support", (key, value) => {
    const result = helmTemplate({ [key]: value });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(key.replace("env.", ""));
  });
});
