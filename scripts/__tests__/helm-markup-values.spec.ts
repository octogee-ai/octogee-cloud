import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dirname, "../..");

type PlatformValues = {
  llmBroker?: { prepaidCreditMarkupMultiplier?: unknown };
  "octogee-api"?: { env?: Record<string, unknown> };
};

function values(path: string): PlatformValues {
  return parse(readFileSync(resolve(repoRoot, path), "utf8")) as PlatformValues;
}

function apiEnv(path: string): Record<string, unknown> {
  return (parse(readFileSync(resolve(repoRoot, path), "utf8")) as { env?: Record<string, unknown> }).env ?? {};
}

const MARKUP_ENV_NAMES = ["PLATFORM_CREDIT_MARKUP_MULTIPLIER", "PLATFORM_WEB_MARKUP_MULTIPLIER"];

function expectMarkup(value: unknown): void {
  expect(typeof value).toBe("string");
  const multiplier = Number(value);
  expect(Number.isFinite(multiplier)).toBe(true);
  expect(multiplier).toBeGreaterThanOrEqual(1);
}

describe("markup multipliers live in environment values, not shared chart defaults", () => {
  it("keeps every markup out of the shared chart defaults", () => {
    expect(values("charts/octogee/values.yaml").llmBroker?.prepaidCreditMarkupMultiplier).toBeUndefined();
    const sharedApiEnv = apiEnv("charts/octogee/charts/octogee-api/values.yaml");
    for (const name of MARKUP_ENV_NAMES) expect(sharedApiEnv).not.toHaveProperty(name);
  });

  it.each(["charts/octogee/values.custom.yaml.tpl"])(
    "%s sets the API and llm-broker markups",
    (path) => {
      const environment = values(path);
      expectMarkup(environment.llmBroker?.prepaidCreditMarkupMultiplier);
      for (const name of MARKUP_ENV_NAMES) expectMarkup(environment["octogee-api"]?.env?.[name]);
    },
  );
});
