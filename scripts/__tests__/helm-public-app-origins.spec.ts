import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  deploymentEnvironmentSettings,
  publicAppOriginsForTarget,
} from "@octogee/core/deployment-environment";

const repoRoot = resolve(import.meta.dirname, "../..");

function values(path: string): Record<string, unknown> {
  return parse(readFileSync(resolve(repoRoot, path), "utf8")) as Record<string, unknown>;
}

function platformOrigins(path: string): unknown {
  return (values(path).global as { publicAppOrigins?: unknown } | undefined)?.publicAppOrigins;
}

function gatewayOrigins(path: string): unknown {
  return (values(path).gatewayEdge as { publicAppOrigins?: unknown } | undefined)?.publicAppOrigins;
}

function provisionPlaceholders(): Map<string, string> {
  const script = readFileSync(resolve(repoRoot, "scripts/provision-namespace.sh"), "utf8");
  return new Map([...script.matchAll(/-e "s\|(__[A-Z_]+__)\|\$([A-Z_]+)\|g"/g)].map((match) => [match[1], match[2]]));
}

function renderCustomValues(variables: Record<string, string>): Record<string, unknown> {
  let rendered = readFileSync(resolve(repoRoot, "charts/octogee/values.custom.yaml.tpl"), "utf8");
  for (const [placeholder, variable] of provisionPlaceholders()) {
    rendered = rendered.replaceAll(placeholder, variables[variable] ?? "fixture");
  }
  return parse(rendered) as Record<string, unknown>;
}

describe("browser origins reach runtime pods from the environment values", () => {
  it("provision-namespace renders every custom values placeholder", () => {
    const template = readFileSync(resolve(repoRoot, "charts/octogee/values.custom.yaml.tpl"), "utf8");
    const used = new Set(template.match(/__[A-Z][A-Z_]*__/g));
    expect([...used].filter((placeholder) => !provisionPlaceholders().has(placeholder))).toEqual([]);
  });

  it("custom namespaces take their origins from the selected TEST target", () => {
    const target = {
      ...deploymentEnvironmentSettings("test"),
      siteOrigin: "https://site.example.test",
      appOrigin: "https://app.example.test",
      hostingProjectId: "hosting-fixture",
      firebaseProjectId: "firebase-fixture",
    };
    const rendered = renderCustomValues({
      TARGET_SITE_ORIGIN: target.siteOrigin,
      TARGET_APP_ORIGIN: target.appOrigin,
      TARGET_HOSTING_PROJECT: target.hostingProjectId,
      TARGET_FIREBASE_PROJECT: target.firebaseProjectId,
    });

    expect((rendered.global as { publicAppOrigins?: unknown }).publicAppOrigins)
      .toEqual(publicAppOriginsForTarget(target));
    expect((rendered["gateway-edge"] as { env: Record<string, string> }).env).toMatchObject({
      APP_URL: target.appOrigin,
      SITE_URL: target.siteOrigin,
    });
    expect((rendered["octogee-api"] as { env: Record<string, string> }).env.API_PUBLIC_URL).toBe(target.siteOrigin);
    expect((rendered.opsAgent as { appUrl?: string }).appUrl).toBe(target.appOrigin);
  });

  it("shared chart defaults carry no origins", () => {
    expect(platformOrigins("charts/octogee/values.yaml")).toBeUndefined();
    expect(gatewayOrigins("charts/octogee-gateway/values.yaml")).toBeUndefined();
  });
});
